import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { aggregateScores, runScorer, type ScoringAttempt, type ScoringInputManifest } from "@benchi/scoring";

export type SubmissionBundle = {
  schemaVersion: "1";
  id: string;
  trialId: string;
  submissionSlotId: string;
  output: { contentIdentity: string };
  assertedProvenance: Record<string, unknown>;
  scorers: Array<{ id: string; version: string; weight: string }>;
};
export type SubmittedTrial = SubmissionBundle & {
  trialAttempt: null;
  trustedProvenance: { submittedBy: string; submittedAt: string; outputContentIdentity: string };
  receipt: { id: string; idempotencyKey: string; replayed: boolean };
};
export interface ContentVerifier { verify(contentIdentity: string): Promise<void>; }

export class SubmissionError extends Error {
  constructor(public code: string) { super(code); }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS benchi_submitted_trial_receipts (
      id uuid PRIMARY KEY, actor_id text NOT NULL, idempotency_key text NOT NULL,
      payload_hash text NOT NULL, result jsonb NOT NULL, UNIQUE (actor_id, idempotency_key)
    );
    CREATE TABLE IF NOT EXISTS benchi_submitted_trials (
      id text PRIMARY KEY, trial_id text NOT NULL UNIQUE, submitted_trial jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_submitted_scoring_attempts (
      submitted_trial_id text NOT NULL REFERENCES benchi_submitted_trials(id),
      scorer_id text NOT NULL, attempt integer NOT NULL, scoring_attempt jsonb NOT NULL,
      PRIMARY KEY (submitted_trial_id, scorer_id, attempt)
    );
  `);
}

export class SubmittedTrials {
  constructor(private readonly pool: Pool, private readonly content: ContentVerifier) {}

  async publish(bundle: SubmissionBundle, actorId: string, idempotencyKey: string, submittedAt: string): Promise<SubmittedTrial> {
    if (!validBundle(bundle)) throw new SubmissionError("INVALID_SUBMISSION_BUNDLE");
    const payloadHash = createHash("sha256").update(JSON.stringify(bundle)).digest("hex");
    const replay = await this.pool.query<{ payload_hash: string; result: SubmittedTrial }>("SELECT payload_hash, result FROM benchi_submitted_trial_receipts WHERE actor_id = $1 AND idempotency_key = $2", [actorId, idempotencyKey]);
    if (replay.rows[0]) {
      if (replay.rows[0].payload_hash !== payloadHash) throw new SubmissionError("IDEMPOTENCY_MISMATCH");
      return { ...replay.rows[0].result, receipt: { ...replay.rows[0].result.receipt, replayed: true } };
    }
    await this.content.verify(bundle.output.contentIdentity);
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))", [actorId, idempotencyKey]);
      const existing = await client.query<{ payload_hash: string; result: SubmittedTrial }>("SELECT payload_hash, result FROM benchi_submitted_trial_receipts WHERE actor_id = $1 AND idempotency_key = $2", [actorId, idempotencyKey]);
      if (existing.rows[0]) {
        if (existing.rows[0].payload_hash !== payloadHash) throw new SubmissionError("IDEMPOTENCY_MISMATCH");
        await client.query("COMMIT");
        return { ...existing.rows[0].result, receipt: { ...existing.rows[0].result.receipt, replayed: true } };
      }
      const receipt = { id: randomUUID(), idempotencyKey, replayed: false };
      const result: SubmittedTrial = { ...bundle, trialAttempt: null, trustedProvenance: { submittedBy: actorId, submittedAt, outputContentIdentity: bundle.output.contentIdentity }, receipt };
      await client.query("INSERT INTO benchi_submitted_trials (id, trial_id, submitted_trial) VALUES ($1, $2, $3)", [bundle.id, bundle.trialId, result]);
      await client.query("INSERT INTO benchi_submitted_trial_receipts (id, actor_id, idempotency_key, payload_hash, result) VALUES ($1, $2, $3, $4, $5)", [receipt.id, actorId, idempotencyKey, payloadHash, result]);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK");
      if ((error as { code?: string }).code === "23505") throw new SubmissionError("ALREADY_PUBLISHED");
      throw error;
    } finally { client.release(); }
  }

  async get(id: string): Promise<SubmittedTrial | undefined> {
    const result = await this.pool.query<{ submitted_trial: SubmittedTrial }>("SELECT submitted_trial FROM benchi_submitted_trials WHERE id = $1", [id]);
    return result.rows[0]?.submitted_trial;
  }

  async score(id: string, execute: (manifest: ScoringInputManifest, attempt: number) => Promise<unknown>) {
    const submitted = await this.get(id);
    if (!submitted) throw new SubmissionError("NOT_FOUND");
    const attempts: Array<{ scorerId: string; attempt: ScoringAttempt }> = [];
    const aggregates: Array<{ status: "scored"; normalizedScore: string; weight: string } | { status: "infrastructure-failure"; weight: string }> = [];
    for (const scorer of submitted.scorers) {
      const manifest: ScoringInputManifest = { kind: "ScoringInputManifest", schemaVersion: "1", trialId: submitted.trialId, scorer: { id: scorer.id, version: scorer.version }, trialOutput: submitted.output };
      const outcome = await runScorer(manifest, execute);
      for (const attempt of outcome.attempts) {
        attempts.push({ scorerId: scorer.id, attempt });
        await this.pool.query("INSERT INTO benchi_submitted_scoring_attempts (submitted_trial_id, scorer_id, attempt, scoring_attempt) VALUES ($1, $2, $3, $4)", [id, scorer.id, attempt.attempt, attempt]);
      }
      const completed = outcome.attempts.find((attempt) => attempt.status === "completed");
      aggregates.push(completed?.status === "completed" ? { status: "scored", normalizedScore: completed.result.normalizedScore, weight: scorer.weight } : { status: "infrastructure-failure", weight: scorer.weight });
    }
    return { attempts, comparison: aggregateScores(aggregates) };
  }
}

const identity = /^sha256:[0-9a-f]{64}$/;
function validBundle(value: SubmissionBundle): boolean {
  return record(value) && keys(value, ["schemaVersion", "id", "trialId", "submissionSlotId", "output", "assertedProvenance", "scorers"]) && value.schemaVersion === "1" && nonempty(value.id) && nonempty(value.trialId) && nonempty(value.submissionSlotId) &&
    record(value.output) && keys(value.output, ["contentIdentity"]) && identity.test(value.output.contentIdentity) && record(value.assertedProvenance) && Array.isArray(value.scorers) && value.scorers.length > 0 &&
    value.scorers.every((scorer) => record(scorer) && keys(scorer, ["id", "version", "weight"]) && nonempty(scorer.id) && identity.test(scorer.version) && /^(?:0|[1-9]\d*)(?:\.\d+)?$/.test(scorer.weight));
}
function record(value: unknown): value is Record<string, any> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function nonempty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }
function keys(value: Record<string, unknown>, expected: string[]) { return Object.keys(value).length === expected.length && expected.every((key) => key in value); }
