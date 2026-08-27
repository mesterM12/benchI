import { createHash, randomBytes } from "node:crypto";
import path from "node:path";
import type { Pool, PoolClient } from "pg";

export type ArtifactVisibility = "Organization-visible" | "Admin-restricted" | "Quarantined";
export type ArtifactCapability = "Rerunnable" | "Rescorable" | "Inspectable";
export type ExportProfile = "full" | "results" | "metadata";
export type Principal = { role: "Member" | "Admin"; actorId?: string };

export interface BlobStore {
  put(contentIdentity: string, bytes: Buffer): Promise<void>;
  get(contentIdentity: string): Promise<Buffer | undefined>;
}

export class InMemoryBlobStore implements BlobStore {
  private readonly blobs = new Map<string, Buffer>();

  async put(contentIdentity: string, bytes: Buffer): Promise<void> {
    if (!this.blobs.has(contentIdentity)) this.blobs.set(contentIdentity, Buffer.from(bytes));
  }

  async get(contentIdentity: string): Promise<Buffer | undefined> {
    const bytes = this.blobs.get(contentIdentity);
    return bytes && Buffer.from(bytes);
  }

  clear(): void {
    this.blobs.clear();
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS benchi_retained_artifacts (
      id text PRIMARY KEY, content_identity text NOT NULL, byte_length bigint NOT NULL,
      visibility text NOT NULL CHECK (visibility IN ('Organization-visible', 'Admin-restricted', 'Quarantined')),
      revision integer NOT NULL DEFAULT 1, capabilities jsonb NOT NULL,
      created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE IF NOT EXISTS benchi_download_capabilities (
      token_hash text PRIMARY KEY, artifact_id text NOT NULL REFERENCES benchi_retained_artifacts(id) ON DELETE CASCADE,
      artifact_revision integer NOT NULL, action text NOT NULL CHECK (action = 'download'),
      requester_id text NOT NULL, expires_at timestamptz NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_artifact_tombstones (
      artifact_id text PRIMARY KEY, content_identity text NOT NULL, deleted_by text NOT NULL,
      deleted_at timestamptz NOT NULL, lost_capabilities jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_artifact_audit_events (
      id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, artifact_id text NOT NULL,
      action text NOT NULL, actor text NOT NULL, detail jsonb NOT NULL,
      occurred_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

type ArtifactRow = {
  id: string;
  content_identity: string;
  byte_length: string;
  visibility: ArtifactVisibility;
  revision: number;
  capabilities: ArtifactCapability[];
};

export class ArtifactRepository {
  constructor(
    private readonly pool: Pool,
    private readonly blobs: BlobStore,
    private readonly clock: () => Date = () => new Date()
  ) {}

  async retain(command: { id: string; bytes: Buffer; visibility: ArtifactVisibility; createdBy: string; capabilities: ArtifactCapability[] }): Promise<void> {
    const contentIdentity = sha256(command.bytes);
    await this.blobs.put(contentIdentity, command.bytes);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockArtifactId(client, command.id);
      if ((await client.query("SELECT 1 FROM benchi_artifact_tombstones WHERE artifact_id = $1", [command.id])).rowCount) {
        throw new Error("ARTIFACT_TOMBSTONED");
      }
      await client.query(
        "INSERT INTO benchi_retained_artifacts (id, content_identity, byte_length, visibility, capabilities, created_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [command.id, contentIdentity, command.bytes.length, command.visibility, JSON.stringify(command.capabilities), command.createdBy]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async inspect(id: string, principal: Principal): Promise<{ id: string; contentIdentity: string; byteLength: number; visibility: ArtifactVisibility; capabilities: ArtifactCapability[] }> {
    const row = await this.authorizedArtifact(id, principal);
    return { id: row.id, contentIdentity: row.content_identity, byteLength: Number(row.byte_length), visibility: row.visibility, capabilities: row.capabilities };
  }

  async setVisibility(id: string, visibility: ArtifactVisibility, principal: Principal): Promise<void> {
    requireAdmin(principal);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<Pick<ArtifactRow, "visibility">>(
        "UPDATE benchi_retained_artifacts SET visibility = $2, revision = revision + 1 WHERE id = $1 RETURNING visibility",
        [id, visibility]
      );
      if (result.rowCount !== 1) throw notFound();
      await client.query(
        "INSERT INTO benchi_artifact_audit_events (artifact_id, action, actor, detail) VALUES ($1, 'artifact-visibility-changed', $2, $3)",
        [id, principal.actorId, { visibility }]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async issueDownloadCapability(id: string, principal: Principal, lifetimeSeconds = 60): Promise<string> {
    if (!principal.actorId) throw new Error("ARTIFACT_AUTHENTICATION_REQUIRED");
    if (!Number.isInteger(lifetimeSeconds) || lifetimeSeconds < 1 || lifetimeSeconds > 300) throw new Error("DOWNLOAD_CAPABILITY_LIFETIME_INVALID");
    const row = await this.authorizedArtifact(id, principal);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(this.clock().getTime() + lifetimeSeconds * 1000);
    await this.pool.query(
      "INSERT INTO benchi_download_capabilities (token_hash, artifact_id, artifact_revision, action, requester_id, expires_at) VALUES ($1, $2, $3, 'download', $4, $5)",
      [sha256(Buffer.from(token)), id, row.revision, principal.actorId, expiresAt]
    );
    return token;
  }

  async download(token: string, principal: Principal): Promise<Buffer> {
    if (!principal.actorId) throw new Error("DOWNLOAD_CAPABILITY_INVALID");
    const result = await this.pool.query<ArtifactRow>(`
      SELECT a.* FROM benchi_download_capabilities c
      JOIN benchi_retained_artifacts a ON a.id = c.artifact_id
      WHERE c.token_hash = $1 AND c.action = 'download' AND c.expires_at > $2 AND c.requester_id = $3
        AND c.artifact_revision = a.revision
    `, [sha256(Buffer.from(token)), this.clock(), principal.actorId]);
    const row = result.rows[0];
    if (!row) throw new Error("DOWNLOAD_CAPABILITY_INVALID");
    const bytes = await this.blobs.get(row.content_identity);
    if (!bytes || sha256(bytes) !== row.content_identity) throw new Error("ARTIFACT_CONTENT_UNAVAILABLE");
    return bytes;
  }

  async export(ids: string[], profile: ExportProfile, principal: Principal): Promise<{
    manifest: { profile: ExportProfile; artifacts: { id: string; contentIdentity: string }[]; omissions: { artifactId: string; reason: string; capabilityConsequences: ArtifactCapability[] }[] };
    payloads: Map<string, Buffer>;
  }> {
    const artifacts: { id: string; contentIdentity: string }[] = [];
    const omissions: { artifactId: string; reason: string; capabilityConsequences: ArtifactCapability[] }[] = [];
    const payloads = new Map<string, Buffer>();
    for (const id of ids) {
      let row: ArtifactRow;
      try {
        row = await this.authorizedArtifact(id, principal);
      } catch (error) {
        if (!(error instanceof Error) || error.message !== "ARTIFACT_NOT_FOUND") throw error;
        omissions.push({ artifactId: id, reason: "Unauthorized", capabilityConsequences: ["Rerunnable", "Rescorable", "Inspectable"] });
        continue;
      }
      artifacts.push({ id, contentIdentity: row.content_identity });
      if (profile === "metadata") {
        omissions.push({ artifactId: id, reason: "ProfileExcluded", capabilityConsequences: row.capabilities });
      } else {
        const bytes = await this.blobs.get(row.content_identity);
        if (!bytes || sha256(bytes) !== row.content_identity) {
          omissions.push({ artifactId: id, reason: "ContentUnavailable", capabilityConsequences: row.capabilities });
        } else {
          payloads.set(row.content_identity, bytes);
        }
      }
    }
    if (profile === "full" && omissions.length) throw new Error("EXPORT_INCOMPLETE");
    return { manifest: { profile, artifacts, omissions }, payloads };
  }

  async previewDeletion(id: string, principal: Principal): Promise<{ lostCapabilities: ArtifactCapability[]; physicalBytesReclaimableNow: boolean }> {
    if (principal.role !== "Admin") throw new Error("ARTIFACT_ADMIN_REQUIRED");
    const row = await this.rawArtifact(id);
    return { lostCapabilities: row.capabilities, physicalBytesReclaimableNow: false };
  }

  async deleteArtifact(id: string, principal: Principal, exactScopeConfirmation: string): Promise<void> {
    requireAdmin(principal);
    if (exactScopeConfirmation !== id) throw new Error("ARTIFACT_DELETE_CONFIRMATION_MISMATCH");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await lockArtifactId(client, id);
      const result = await client.query<ArtifactRow>("DELETE FROM benchi_retained_artifacts WHERE id = $1 RETURNING *", [id]);
      const row = result.rows[0];
      if (!row) throw notFound();
      await client.query(
        "INSERT INTO benchi_artifact_tombstones (artifact_id, content_identity, deleted_by, deleted_at, lost_capabilities) VALUES ($1, $2, $3, $4, $5)",
        [id, row.content_identity, principal.actorId, this.clock(), JSON.stringify(row.capabilities)]
      );
      await client.query(
        "INSERT INTO benchi_artifact_audit_events (artifact_id, action, actor, detail) VALUES ($1, 'artifact-deleted', $2, $3)",
        [id, principal.actorId, { contentIdentity: row.content_identity, lostCapabilities: row.capabilities }]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async tombstone(id: string, principal: Principal): Promise<{ artifactId: string; contentIdentity: string; deletedBy: string; deletedAt: string } | undefined> {
    if (principal.role !== "Admin") throw new Error("ARTIFACT_ADMIN_REQUIRED");
    const result = await this.pool.query<{ artifact_id: string; content_identity: string; deleted_by: string; deleted_at: Date }>(
      "SELECT artifact_id, content_identity, deleted_by, deleted_at FROM benchi_artifact_tombstones WHERE artifact_id = $1",
      [id]
    );
    const row = result.rows[0];
    return row && { artifactId: row.artifact_id, contentIdentity: row.content_identity, deletedBy: row.deleted_by, deletedAt: row.deleted_at.toISOString() };
  }

  async auditEvents(principal: Principal): Promise<unknown[]> {
    if (principal.role !== "Admin") throw new Error("ARTIFACT_ADMIN_REQUIRED");
    return (await this.pool.query("SELECT artifact_id, action, actor, detail FROM benchi_artifact_audit_events ORDER BY id")).rows;
  }

  private async authorizedArtifact(id: string, principal: Principal): Promise<ArtifactRow> {
    const row = await this.rawArtifact(id);
    if (row.visibility === "Quarantined" || (principal.role !== "Admin" && row.visibility !== "Organization-visible")) throw notFound();
    return row;
  }

  private async rawArtifact(id: string): Promise<ArtifactRow> {
    const row = (await this.pool.query<ArtifactRow>("SELECT * FROM benchi_retained_artifacts WHERE id = $1", [id])).rows[0];
    if (!row) throw notFound();
    return row;
  }
}

export type BundleEntry = { path: string; bytes: Buffer; digest: string; type?: "file" | "symlink" };

export function validateBundleEntries(entries: BundleEntry[], limits: { maxEntries: number; maxExpandedBytes: number }): void {
  if (entries.length > limits.maxEntries) throw new Error("BUNDLE_LIMIT_EXCEEDED");
  let expandedBytes = 0;
  for (const entry of entries) {
    if (entry.type === "symlink") throw new Error("BUNDLE_SYMLINK_FORBIDDEN");
    if (path.posix.isAbsolute(entry.path) || entry.path.includes("\\") || entry.path.split("/").includes("..") || path.posix.normalize(entry.path) !== entry.path) {
      throw new Error("BUNDLE_PATH_INVALID");
    }
    expandedBytes += entry.bytes.length;
    if (expandedBytes > limits.maxExpandedBytes) throw new Error("BUNDLE_LIMIT_EXCEEDED");
    if (!/^[0-9a-f]{64}$/.test(entry.digest) || sha256(entry.bytes) !== entry.digest) throw new Error("BUNDLE_DIGEST_MISMATCH");
  }
}

function requireAdmin(principal: Principal): void {
  if (principal.role !== "Admin" || !principal.actorId) throw new Error("ARTIFACT_ADMIN_REQUIRED");
}

function notFound(): Error {
  return new Error("ARTIFACT_NOT_FOUND");
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function lockArtifactId(client: PoolClient, id: string): Promise<void> {
  await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [id]);
}
