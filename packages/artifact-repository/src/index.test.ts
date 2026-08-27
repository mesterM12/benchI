import { createHash } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ArtifactRepository, InMemoryBlobStore, migrate, validateBundleEntries } from "./index.js";

const databaseUrl = process.env.DATABASE_URL;
const protocol = describe.runIf(databaseUrl);
const digest = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

protocol("Artifact Repository application contract", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const blobs = new InMemoryBlobStore();
  let now = new Date("2026-08-27T10:00:00.000Z");
  const repository = new ArtifactRepository(pool, blobs, () => now);

  beforeAll(async () => migrate(pool));
  beforeEach(async () => {
    await pool.query("TRUNCATE benchi_artifact_audit_events, benchi_artifact_tombstones, benchi_download_capabilities, benchi_retained_artifacts");
    blobs.clear();
    now = new Date("2026-08-27T10:00:00.000Z");
  });
  afterAll(() => pool.end());

  async function retain(id: string, bytes: Buffer, visibility: "Organization-visible" | "Admin-restricted" | "Quarantined" = "Organization-visible") {
    await repository.retain({ id, bytes, visibility, createdBy: "admin-1", capabilities: ["Rerunnable", "Rescorable", "Inspectable"] });
  }

  it("authorizes logical artifacts, not shared blob bytes, without enumeration", async () => {
    const bytes = Buffer.from("shared");
    await retain("visible", bytes);
    await retain("restricted", bytes, "Admin-restricted");

    expect(await repository.inspect("visible", { role: "Member" })).toMatchObject({ id: "visible" });
    await expect(repository.inspect("restricted", { role: "Member" })).rejects.toThrow("ARTIFACT_NOT_FOUND");
    await expect(repository.inspect("missing", { role: "Member" })).rejects.toThrow("ARTIFACT_NOT_FOUND");
  });

  it("issues short-lived download-only capabilities invalidated by state changes", async () => {
    await retain("artifact-1", Buffer.from("evidence"));
    const token = await repository.issueDownloadCapability("artifact-1", { role: "Member" }, 60);
    await expect(repository.download(token)).resolves.toEqual(Buffer.from("evidence"));

    now = new Date("2026-08-27T10:01:01.000Z");
    await expect(repository.download(token)).rejects.toThrow("DOWNLOAD_CAPABILITY_INVALID");
    now = new Date("2026-08-27T10:00:00.000Z");
    const stale = await repository.issueDownloadCapability("artifact-1", { role: "Member" }, 60);
    await repository.setVisibility("artifact-1", "Admin-restricted", { role: "Admin", actorId: "admin-1" });
    await expect(repository.download(stale)).rejects.toThrow("DOWNLOAD_CAPABILITY_INVALID");
  });

  it("exports profiles with explicit omissions and capability consequences", async () => {
    await retain("artifact-1", Buffer.from("results"));
    await retain("artifact-2", Buffer.from("source"), "Admin-restricted");

    const bundle = await repository.export(["artifact-1", "artifact-2"], "results", { role: "Member" });
    expect(bundle.manifest).toMatchObject({
      profile: "results",
      artifacts: [{ id: "artifact-1", contentIdentity: digest(Buffer.from("results")) }],
      omissions: [
        { artifactId: "artifact-2", reason: "Unauthorized", capabilityConsequences: ["Rerunnable", "Rescorable", "Inspectable"] }
      ]
    });
    expect(bundle.payloads.size).toBe(1);
    expect((await repository.export(["artifact-1"], "metadata", { role: "Member" })).manifest.omissions).toEqual([
      { artifactId: "artifact-1", reason: "ProfileExcluded", capabilityConsequences: ["Rerunnable", "Rescorable", "Inspectable"] }
    ]);
    await expect(repository.export(["artifact-1", "artifact-2"], "full", { role: "Member" })).rejects.toThrow("EXPORT_INCOMPLETE");
  });

  it("deletes logical authority atomically while preserving shared bytes and tombstone", async () => {
    const bytes = Buffer.from("shared");
    await retain("artifact-1", bytes);
    await retain("artifact-2", bytes);
    expect(await repository.previewDeletion("artifact-1", { role: "Admin" })).toMatchObject({
      lostCapabilities: ["Rerunnable", "Rescorable", "Inspectable"],
      physicalBytesReclaimableNow: false
    });

    await repository.deleteArtifact("artifact-1", { role: "Admin", actorId: "admin-1" }, "artifact-1");
    await expect(repository.inspect("artifact-1", { role: "Admin" })).rejects.toThrow("ARTIFACT_NOT_FOUND");
    expect(await repository.tombstone("artifact-1")).toMatchObject({ artifactId: "artifact-1", deletedBy: "admin-1" });
    expect(await blobs.get(digest(bytes))).toEqual(bytes);
    await expect(retain("artifact-1", Buffer.from("replacement"))).rejects.toThrow("ARTIFACT_TOMBSTONED");
  });
});

describe("artifact bundle safety", () => {
  const valid = { path: "payloads/abc", bytes: Buffer.from("ok"), digest: digest(Buffer.from("ok")) };

  it.each([
    [{ ...valid, path: "../secret" }, "BUNDLE_PATH_INVALID"],
    [{ ...valid, path: "/absolute" }, "BUNDLE_PATH_INVALID"],
    [{ ...valid, type: "symlink" as const }, "BUNDLE_SYMLINK_FORBIDDEN"],
    [{ ...valid, digest: "0".repeat(64) }, "BUNDLE_DIGEST_MISMATCH"]
  ])("rejects unsafe or forged entries", (entry, error) => {
    expect(() => validateBundleEntries([entry], { maxEntries: 10, maxExpandedBytes: 100 })).toThrow(error);
  });

  it("rejects archive bombs before extraction", () => {
    expect(() => validateBundleEntries([valid, { ...valid, path: "payloads/def" }], { maxEntries: 1, maxExpandedBytes: 100 })).toThrow("BUNDLE_LIMIT_EXCEEDED");
    expect(() => validateBundleEntries([{ ...valid, bytes: Buffer.alloc(101), digest: digest(Buffer.alloc(101)) }], { maxEntries: 10, maxExpandedBytes: 100 })).toThrow("BUNDLE_LIMIT_EXCEEDED");
  });
});
