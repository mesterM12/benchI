import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { previewEvalSuite, type Diagnostic } from "@benchi/contracts";

export type SuiteRevision = { id: string; revision: number; source: string; canonicalJson: string; createdAt: string };
export type CommandReceipt = { id: string; idempotencyKey: string; replayed: boolean };
export type MutationResult = SuiteRevision & { receipt: CommandReceipt };
export type Mutation = { source: string; idempotencyKey: string; actorId: string };
export type RevisionMutation = Mutation & { expectedRevision: number };

export class ApplicationError extends Error {
  constructor(public code: string, message = code, public diagnostics?: Diagnostic[]) { super(message); }
}

export class EvaluationDefinition {
  constructor(private readonly pool: Pool) {}

  async migrate(): Promise<void> {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS eval_suite_revisions (
        suite_id text NOT NULL,
        revision integer NOT NULL CHECK (revision > 0),
        source text NOT NULL,
        canonical_json jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        created_by text NOT NULL,
        PRIMARY KEY (suite_id, revision)
      );
      CREATE TABLE IF NOT EXISTS command_receipts (
        id uuid PRIMARY KEY,
        actor_id text NOT NULL,
        idempotency_key text NOT NULL,
        payload_hash text NOT NULL,
        result jsonb NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (actor_id, idempotency_key)
      );
      CREATE OR REPLACE FUNCTION reject_eval_suite_revision_change() RETURNS trigger AS $$
        BEGIN RAISE EXCEPTION 'Eval Suite revisions are immutable'; END;
      $$ LANGUAGE plpgsql;
      DROP TRIGGER IF EXISTS eval_suite_revisions_are_immutable ON eval_suite_revisions;
      CREATE TRIGGER eval_suite_revisions_are_immutable BEFORE UPDATE OR DELETE ON eval_suite_revisions
        FOR EACH ROW EXECUTE FUNCTION reject_eval_suite_revision_change();
    `);
  }

  validate(source: string) { return previewEvalSuite(source); }

  async create(command: Mutation): Promise<MutationResult> {
    return this.mutate(command, "create", async (client, canonicalJson) => {
      const id = JSON.parse(canonicalJson).id as string;
      const inserted = await client.query<SuiteRow>(`INSERT INTO eval_suite_revisions (suite_id, revision, source, canonical_json, created_by) VALUES ($1, 1, $2, $3, $4) RETURNING *`, [id, command.source, canonicalJson, command.actorId]);
      return row(inserted.rows[0]!);
    });
  }

  async revise(id: string, command: RevisionMutation): Promise<MutationResult> {
    return this.mutate(command, `revise:${id}:${command.expectedRevision}`, async (client, canonicalJson) => {
      if (JSON.parse(canonicalJson).id !== id) throw new ApplicationError("SUITE_ID_MISMATCH");
      const latest = await client.query<{ revision: number }>(`SELECT revision FROM eval_suite_revisions WHERE suite_id = $1 ORDER BY revision DESC LIMIT 1 FOR UPDATE`, [id]);
      if (!latest.rows[0]) throw new ApplicationError("NOT_FOUND");
      if (latest.rows[0].revision !== command.expectedRevision) throw new ApplicationError("REVISION_CONFLICT");
      const inserted = await client.query<SuiteRow>(`INSERT INTO eval_suite_revisions (suite_id, revision, source, canonical_json, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING *`, [id, command.expectedRevision + 1, command.source, canonicalJson, command.actorId]);
      return row(inserted.rows[0]!);
    });
  }

  async get(id: string, revision?: number): Promise<SuiteRevision | undefined> {
    const result = revision
      ? await this.pool.query<SuiteRow>(`SELECT * FROM eval_suite_revisions WHERE suite_id = $1 AND revision = $2`, [id, revision])
      : await this.pool.query<SuiteRow>(`SELECT * FROM eval_suite_revisions WHERE suite_id = $1 ORDER BY revision DESC LIMIT 1`, [id]);
    return result.rows[0] && row(result.rows[0]);
  }

  async list(): Promise<SuiteRevision[]> {
    const result = await this.pool.query<SuiteRow>(`SELECT DISTINCT ON (suite_id) * FROM eval_suite_revisions ORDER BY suite_id, revision DESC`);
    return result.rows.map(row);
  }

  private async mutate(command: Mutation, identity: string, change: (client: PoolClient, canonicalJson: string) => Promise<SuiteRevision>): Promise<MutationResult> {
    const validation = this.validate(command.source);
    if (!validation.ok) throw new ApplicationError("VALIDATION_FAILED", "Eval Suite is invalid", validation.diagnostics);
    const payloadHash = createHash("sha256").update(identity).update("\0").update(command.source).digest("hex");
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))`, [command.actorId, command.idempotencyKey]);
      const existing = await client.query<{ payload_hash: string; result: MutationResult }>(`SELECT payload_hash, result FROM command_receipts WHERE actor_id = $1 AND idempotency_key = $2`, [command.actorId, command.idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== payloadHash) throw new ApplicationError("IDEMPOTENCY_MISMATCH");
        await client.query("COMMIT");
        return { ...existing.rows[0].result, receipt: { ...existing.rows[0].result.receipt, replayed: true } };
      }
      const changed = await change(client, validation.canonicalJson);
      const receipt: CommandReceipt = { id: randomUUID(), idempotencyKey: command.idempotencyKey, replayed: false };
      const result = { ...changed, receipt };
      await client.query(`INSERT INTO command_receipts (id, actor_id, idempotency_key, payload_hash, result) VALUES ($1, $2, $3, $4, $5)`, [receipt.id, command.actorId, command.idempotencyKey, payloadHash, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new ApplicationError("ALREADY_EXISTS");
      throw error;
    } finally { client.release(); }
  }
}

type SuiteRow = { suite_id: string; revision: number; source: string; canonical_json: unknown; created_at: Date; created_by: string };
function row(value: SuiteRow): SuiteRevision {
  return { id: value.suite_id, revision: value.revision, source: value.source, canonicalJson: JSON.stringify(value.canonical_json), createdAt: value.created_at.toISOString() };
}
