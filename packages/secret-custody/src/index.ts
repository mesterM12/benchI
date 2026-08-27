import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";

export type SecretDeliveryRequest = {
  deliveryId: string;
  secretVersionId: string;
  executionResourceRevisionId: string;
  workerLeaseId: string;
  leaseGeneration: number;
  trialAttemptId: string;
  phase: string;
  consumer: string;
  operation: string;
};

export interface DeliveryAuthorization {
  authorize(request: SecretDeliveryRequest): Promise<boolean>;
}

export interface MasterKeys {
  wrap(version: string, dataKey: Buffer): Promise<Buffer>;
  unwrap(version: string, wrappedDataKey: Buffer): Promise<Buffer>;
}

export class InMemoryMasterKeys implements MasterKeys {
  constructor(private readonly keys: Record<string, Buffer>) {}

  async wrap(version: string, dataKey: Buffer): Promise<Buffer> {
    return encrypt(this.key(version), dataKey);
  }

  async unwrap(version: string, wrappedDataKey: Buffer): Promise<Buffer> {
    return decrypt(this.key(version), wrappedDataKey);
  }

  private key(version: string): Buffer {
    const key = this.keys[version];
    if (!key || key.length !== 32) throw new Error("MASTER_KEY_UNAVAILABLE");
    return key;
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS benchi_execution_resource_revisions (
      id text PRIMARY KEY, resource_id text NOT NULL, digest text NOT NULL,
      approved_by text NOT NULL, approved_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_installation_secrets (
      id text PRIMARY KEY, alias text NOT NULL UNIQUE, created_by text NOT NULL,
      active_version_id text
    );
    CREATE TABLE IF NOT EXISTS benchi_secret_versions (
      id text PRIMARY KEY, secret_id text NOT NULL REFERENCES benchi_installation_secrets(id),
      ciphertext bytea NOT NULL, wrapped_data_key bytea NOT NULL, master_key_version text NOT NULL,
      state text NOT NULL CHECK (state IN ('Active', 'Revoked', 'Quarantined')),
      created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS benchi_secret_grants (
      id text PRIMARY KEY, secret_version_id text NOT NULL REFERENCES benchi_secret_versions(id),
      execution_resource_revision_id text NOT NULL REFERENCES benchi_execution_resource_revisions(id),
      phase text NOT NULL, consumer text NOT NULL, operation text NOT NULL,
      granted_by text NOT NULL, revoked_at timestamptz,
      UNIQUE (secret_version_id, execution_resource_revision_id, phase, consumer, operation)
    );
    CREATE TABLE IF NOT EXISTS benchi_secret_deliveries (
      id text PRIMARY KEY, secret_version_id text NOT NULL,
      execution_resource_revision_id text NOT NULL, worker_lease_id text NOT NULL,
      lease_generation integer NOT NULL, trial_attempt_id text NOT NULL,
      phase text NOT NULL, consumer text NOT NULL, operation text NOT NULL,
      delivered_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (secret_version_id, worker_lease_id, lease_generation, trial_attempt_id, phase, consumer, operation)
    );
    CREATE TABLE IF NOT EXISTS benchi_secret_audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, action text NOT NULL,
      secret_version_id text NOT NULL, actor text NOT NULL, detail jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

type AuditWriter = (client: PoolClient, event: { action: string; secretVersionId: string; actor: string; detail: Record<string, unknown> }) => Promise<void>;

export class SecretCustody {
  constructor(
    private readonly pool: Pool,
    private readonly masterKeys: MasterKeys,
    private readonly deliveryAuthorization: DeliveryAuthorization,
    private readonly writeAudit: AuditWriter = defaultAudit
  ) {}

  async approveExecutionResource(command: { id: string; resourceId: string; digest: string; approvedBy: string; approvedAt: string }): Promise<void> {
    await this.pool.query("INSERT INTO benchi_execution_resource_revisions (id, resource_id, digest, approved_by, approved_at) VALUES ($1, $2, $3, $4, $5)", [command.id, command.resourceId, command.digest, command.approvedBy, command.approvedAt]);
  }

  async createSecret(command: { id: string; alias: string; createdBy: string }): Promise<void> {
    await this.pool.query("INSERT INTO benchi_installation_secrets (id, alias, created_by) VALUES ($1, $2, $3)", [command.id, command.alias, command.createdBy]);
  }

  async addSecretVersion(command: { id: string; secretId: string; plaintext: Buffer; masterKeyVersion: string; createdBy: string }): Promise<void> {
    const dataKey = randomBytes(32);
    let ciphertext: Buffer;
    let wrappedDataKey: Buffer;
    try {
      ciphertext = encrypt(dataKey, command.plaintext);
      wrappedDataKey = await this.masterKeys.wrap(command.masterKeyVersion, dataKey);
    } finally {
      dataKey.fill(0);
    }
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO benchi_secret_versions (id, secret_id, ciphertext, wrapped_data_key, master_key_version, state, created_by) VALUES ($1, $2, $3, $4, $5, 'Active', $6)", [command.id, command.secretId, ciphertext, wrappedDataKey, command.masterKeyVersion, command.createdBy]);
      await client.query("UPDATE benchi_installation_secrets SET active_version_id = $1 WHERE id = $2", [command.id, command.secretId]);
      await this.writeAudit(client, { action: "secret-version-created", secretVersionId: command.id, actor: command.createdBy, detail: { masterKeyVersion: command.masterKeyVersion } });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async getSecret(id: string): Promise<{ id: string; alias: string; activeVersionId: string | null } | undefined> {
    const result = await this.pool.query<{ id: string; alias: string; active_version_id: string | null }>("SELECT id, alias, active_version_id FROM benchi_installation_secrets WHERE id = $1", [id]);
    const row = result.rows[0];
    return row && { id: row.id, alias: row.alias, activeVersionId: row.active_version_id };
  }

  async grant(command: { id: string; secretVersionId: string; executionResourceRevisionId: string; phase: string; consumer: string; operation: string; grantedBy: string }): Promise<void> {
    await this.pool.query("INSERT INTO benchi_secret_grants (id, secret_version_id, execution_resource_revision_id, phase, consumer, operation, granted_by) VALUES ($1, $2, $3, $4, $5, $6, $7)", [command.id, command.secretVersionId, command.executionResourceRevisionId, command.phase, command.consumer, command.operation, command.grantedBy]);
  }

  async revokeGrant(id: string): Promise<void> {
    const result = await this.pool.query("UPDATE benchi_secret_grants SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL", [id]);
    if (result.rowCount !== 1) throw new Error("SECRET_GRANT_NOT_ACTIVE");
  }

  async revokeSecretVersion(id: string, actor: string): Promise<void> {
    await this.changeState(id, "Revoked", actor, "secret-version-revoked", {});
  }

  async quarantineLeakage(id: string, artifactId: string, actor: string): Promise<void> {
    await this.changeState(id, "Quarantined", actor, "secret-leakage-quarantined", { artifactId });
  }

  async deliver(request: SecretDeliveryRequest): Promise<Buffer> {
    if (!(await this.deliveryAuthorization.authorize(request))) throw new Error("SECRET_DELIVERY_UNAUTHORIZED");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const version = await client.query<{ ciphertext: Buffer; wrapped_data_key: Buffer; master_key_version: string; state: string }>("SELECT ciphertext, wrapped_data_key, master_key_version, state FROM benchi_secret_versions WHERE id = $1 FOR UPDATE", [request.secretVersionId]);
      const row = version.rows[0];
      if (!row) throw new Error("SECRET_VERSION_NOT_FOUND");
      if (row.state !== "Active") throw new Error(`SECRET_VERSION_${row.state.toUpperCase()}`);
      const grant = await client.query("SELECT 1 FROM benchi_secret_grants WHERE secret_version_id = $1 AND execution_resource_revision_id = $2 AND phase = $3 AND consumer = $4 AND operation = $5 AND revoked_at IS NULL", [request.secretVersionId, request.executionResourceRevisionId, request.phase, request.consumer, request.operation]);
      if (!grant.rowCount) throw new Error("SECRET_GRANT_MISMATCH");
      try {
        await client.query("INSERT INTO benchi_secret_deliveries (id, secret_version_id, execution_resource_revision_id, worker_lease_id, lease_generation, trial_attempt_id, phase, consumer, operation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)", [request.deliveryId, request.secretVersionId, request.executionResourceRevisionId, request.workerLeaseId, request.leaseGeneration, request.trialAttemptId, request.phase, request.consumer, request.operation]);
      } catch (error) {
        if (isUniqueViolation(error)) throw new Error("SECRET_DELIVERY_REPLAY");
        throw error;
      }
      await this.writeAudit(client, { action: "secret-delivered", secretVersionId: request.secretVersionId, actor: request.workerLeaseId, detail: { ...request, secretVersionId: undefined } });
      const dataKey = await this.masterKeys.unwrap(row.master_key_version, row.wrapped_data_key);
      let plaintext: Buffer;
      try {
        plaintext = decrypt(dataKey, row.ciphertext);
      } finally {
        dataKey.fill(0);
      }
      await client.query("COMMIT");
      return plaintext;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }

  async auditEvents(): Promise<unknown[]> {
    return (await this.pool.query("SELECT action, secret_version_id, actor, detail FROM benchi_secret_audit_events ORDER BY id")).rows;
  }

  private async changeState(id: string, state: "Revoked" | "Quarantined", actor: string, action: string, detail: Record<string, unknown>): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE benchi_secret_versions SET state = $2 WHERE id = $1 AND state = 'Active'", [id, state]);
      if (result.rowCount !== 1) throw new Error("SECRET_VERSION_NOT_ACTIVE");
      await this.writeAudit(client, { action, secretVersionId: id, actor, detail });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  }
}

async function defaultAudit(client: PoolClient, event: { action: string; secretVersionId: string; actor: string; detail: Record<string, unknown> }): Promise<void> {
  await client.query("INSERT INTO benchi_secret_audit_events (action, secret_version_id, actor, detail) VALUES ($1, $2, $3, $4)", [event.action, event.secretVersionId, event.actor, event.detail]);
}

function encrypt(key: Buffer, plaintext: Buffer): Buffer {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]);
}

function decrypt(key: Buffer, envelope: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, envelope.subarray(0, 12));
  decipher.setAuthTag(envelope.subarray(12, 28));
  return Buffer.concat([decipher.update(envelope.subarray(28)), decipher.final()]);
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}
