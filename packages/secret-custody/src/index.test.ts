import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  InMemoryMasterKeys,
  SecretCustody,
  migrate,
  type DeliveryAuthorization,
  type SecretDeliveryRequest
} from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const protocol = describe.runIf(databaseUrl);

protocol("Secret Custody application contract", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const masterKeys = new InMemoryMasterKeys({ "master-key-1": Buffer.alloc(32, 7) });
  let leaseValid = true;
  const authorization: DeliveryAuthorization = {
    authorize: async () => leaseValid
  };
  const request: SecretDeliveryRequest = {
    deliveryId: "delivery-1",
    secretVersionId: "secret-version-1",
    executionResourceRevisionId: "resource-revision-1",
    workerLeaseId: "lease-1",
    leaseGeneration: 3,
    trialAttemptId: "attempt-1",
    phase: "agent",
    consumer: "agent-main",
    operation: "model-inference"
  };

  beforeAll(async () => migrate(pool));
  beforeEach(async () => {
    await pool.query("TRUNCATE benchi_secret_audit_events, benchi_secret_deliveries, benchi_secret_grants, benchi_secret_versions, benchi_installation_secrets, benchi_execution_resource_revisions RESTART IDENTITY");
    leaseValid = true;
  });
  afterAll(() => pool.end());

  async function setup(custody = new SecretCustody(pool, masterKeys, authorization)) {
    await custody.approveExecutionResource({ id: "resource-revision-1", resourceId: "adapter", digest: "sha256:abc", approvedBy: "admin-1", approvedAt: "2026-08-27T10:00:00.000Z" });
    await custody.createSecret({ id: "secret-1", alias: "model-token", createdBy: "admin-1" });
    await custody.addSecretVersion({ id: "secret-version-1", secretId: "secret-1", plaintext: Buffer.from("super-secret-token"), masterKeyVersion: "master-key-1", createdBy: "admin-1" });
    await custody.grant({ id: "grant-1", secretVersionId: "secret-version-1", executionResourceRevisionId: "resource-revision-1", phase: "agent", consumer: "agent-main", operation: "model-inference", grantedBy: "admin-1" });
    return custody;
  }

  it("approves immutable resource revisions and keeps secret values write-only", async () => {
    const custody = await setup();

    await expect(custody.approveExecutionResource({ id: "resource-revision-1", resourceId: "adapter", digest: "sha256:changed", approvedBy: "admin-1", approvedAt: "2026-08-27T10:01:00.000Z" })).rejects.toThrow();
    expect(await custody.getSecret("secret-1")).toEqual({ id: "secret-1", alias: "model-token", activeVersionId: "secret-version-1" });
  });

  it("delivers one exact pinned secret once when grant and live lease match", async () => {
    const custody = await setup();

    await expect(custody.deliver(request)).resolves.toEqual(Buffer.from("super-secret-token"));
    await expect(custody.deliver(request)).rejects.toThrow("SECRET_DELIVERY_REPLAY");
  });

  it("fails closed for mismatched scope, lease loss, revocation, and audit failure", async () => {
    const custody = await setup();
    await expect(custody.deliver({ ...request, deliveryId: "wrong-phase", phase: "scoring" })).rejects.toThrow("SECRET_GRANT_MISMATCH");
    leaseValid = false;
    await expect(custody.deliver({ ...request, deliveryId: "lost-lease" })).rejects.toThrow("SECRET_DELIVERY_UNAUTHORIZED");
    leaseValid = true;

    const auditFailure = new SecretCustody(pool, masterKeys, authorization, async () => { throw new Error("audit unavailable"); });
    await expect(auditFailure.deliver({ ...request, deliveryId: "audit-failed" })).rejects.toThrow("audit unavailable");
    await expect(custody.deliver({ ...request, deliveryId: "audit-failed" })).resolves.toEqual(Buffer.from("super-secret-token"));

    await custody.revokeGrant("grant-1");
    await expect(custody.deliver({ ...request, deliveryId: "revoked-grant" })).rejects.toThrow("SECRET_GRANT_MISMATCH");
    await custody.revokeSecretVersion("secret-version-1", "admin-1");
    await expect(custody.deliver({ ...request, deliveryId: "revoked" })).rejects.toThrow("SECRET_VERSION_REVOKED");
  });

  it("quarantines suspected leakage without exposing plaintext", async () => {
    const custody = await setup();
    await custody.quarantineLeakage("secret-version-1", "artifact-9", "admin-1");

    await expect(custody.deliver({ ...request, deliveryId: "quarantined" })).rejects.toThrow("SECRET_VERSION_QUARANTINED");
    expect(JSON.stringify(await custody.auditEvents())).not.toContain("super-secret-token");
  });
});
