import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { Pool } from "pg";
import type { Trial } from "@benchi/contracts";

export type LocalSource = { id: string; path: string };
export type SourceProvenance = {
  id: string;
  kind: "suite-relative";
  requestedPath: string;
  contentIdentity: string;
  size: number;
};
export type FreezeEvalRun = {
  id: string;
  suiteRevisionId: string;
  suiteRoot: string;
  suite: unknown;
  resolvedDefinitions: unknown;
  trials: Trial[];
  effectivePolicies: unknown;
  localSources: LocalSource[];
  frozenAt: string;
  benchiVersion: string;
};
export type EvalRunSnapshot = {
  id: string;
  suiteRevisionId: string;
  suite: unknown;
  resolvedDefinitions: unknown;
  trials: Trial[];
  effectivePolicies: unknown;
  sources: SourceProvenance[];
  frozenAt: string;
  benchiVersion: string;
  state: "Ready" | "Started";
};
export type AttemptArtifactManifest = { schemaVersion: "1"; artifacts: Array<{ path: string; contentIdentity: string; size: number }> };
export type RuntimeEnvironmentRecord = { schemaVersion: "1"; adapter: string; observedAt: string };
export type CandidateResult = {
  classification: "EvaluationOutcome" | "InfrastructureFailure";
  result: unknown;
  artifactManifest: AttemptArtifactManifest;
  runtimeEnvironment: RuntimeEnvironmentRecord;
};
export type TrialAttempt = CandidateResult & { id: string; trialId: string; committedAt: string };
export type WorkerLease = { jobId: string; trialId: string; state: string; generation: number; expiresAt: string };

export class DeterministicFakeAgent {
  async execute(invocation: { trialId: string; prompt: string }): Promise<CandidateResult> {
    const bytes = Buffer.from(JSON.stringify(invocation));
    return {
      classification: "EvaluationOutcome",
      result: { status: "completed", digest: identity(bytes) },
      artifactManifest: { schemaVersion: "1", artifacts: [{ path: "agent-result.json", contentIdentity: identity(bytes), size: bytes.length }] },
      runtimeEnvironment: { schemaVersion: "1", adapter: "deterministic-fake/v1", observedAt: "1970-01-01T00:00:00.000Z" }
    };
  }
}

export interface RetainedContent {
  putVerified(contentIdentity: string, bytes: Buffer): Promise<void>;
}

export class InMemoryRetainedContent implements RetainedContent {
  readonly objects = new Map<string, Buffer>();
  failNextPut = false;

  async putVerified(contentIdentity: string, bytes: Buffer): Promise<void> {
    if (this.failNextPut) {
      this.failNextPut = false;
      throw new Error("retention failed");
    }
    if (identity(bytes) !== contentIdentity) throw new Error("digest mismatch");
    this.objects.set(contentIdentity, Buffer.from(bytes));
  }

  async get(contentIdentity: string): Promise<Buffer | undefined> {
    const bytes = this.objects.get(contentIdentity);
    return bytes && Buffer.from(bytes);
  }
}

export async function migrate(pool: Pool): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS benchi_eval_run_snapshots (
      id text PRIMARY KEY,
      state text NOT NULL CHECK (state IN ('Ready', 'Started')),
      snapshot jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_eval_trials (
      id text PRIMARY KEY,
      run_id text NOT NULL REFERENCES benchi_eval_run_snapshots(id),
      position integer NOT NULL,
      trial jsonb NOT NULL
    );
    CREATE TABLE IF NOT EXISTS benchi_phase_jobs (
      id text PRIMARY KEY,
      trial_id text NOT NULL UNIQUE REFERENCES benchi_eval_trials(id),
      state text NOT NULL CHECK (state IN ('queued', 'leased', 'starting', 'running', 'committing', 'completed', 'failed')),
      generation integer NOT NULL DEFAULT 0,
      worker_id text,
      lease_expires_at timestamptz,
      candidate jsonb
    );
    CREATE TABLE IF NOT EXISTS benchi_trial_attempts (
      id text PRIMARY KEY,
      job_id text NOT NULL UNIQUE REFERENCES benchi_phase_jobs(id),
      trial_id text NOT NULL REFERENCES benchi_eval_trials(id),
      attempt jsonb NOT NULL
    );
    CREATE OR REPLACE FUNCTION reject_trial_attempt_change() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'Trial Attempts are immutable'; END;
    $$ LANGUAGE plpgsql;
    DROP TRIGGER IF EXISTS benchi_trial_attempts_are_immutable ON benchi_trial_attempts;
    CREATE TRIGGER benchi_trial_attempts_are_immutable BEFORE UPDATE OR DELETE ON benchi_trial_attempts
      FOR EACH ROW EXECUTE FUNCTION reject_trial_attempt_change();
  `);
}

export class RunOrchestration {
  constructor(private readonly pool: Pool, private readonly retainedContent: RetainedContent) {}

  async freeze(command: FreezeEvalRun): Promise<EvalRunSnapshot> {
    const sources = await Promise.all(command.localSources.map(async (source) => {
      const bytes = await readSuiteFile(command.suiteRoot, source.path);
      const contentIdentity = identity(bytes);
      await this.retainedContent.putVerified(contentIdentity, bytes);
      return { id: source.id, kind: "suite-relative" as const, requestedPath: source.path, contentIdentity, size: bytes.length };
    }));
    const snapshot: EvalRunSnapshot = {
      id: command.id,
      suiteRevisionId: command.suiteRevisionId,
      suite: command.suite,
      resolvedDefinitions: command.resolvedDefinitions,
      trials: command.trials,
      effectivePolicies: command.effectivePolicies,
      sources,
      frozenAt: command.frozenAt,
      benchiVersion: command.benchiVersion,
      state: "Ready"
    };

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO benchi_eval_run_snapshots (id, state, snapshot) VALUES ($1, 'Ready', $2)", [command.id, snapshot]);
      for (const [position, trial] of command.trials.entries()) {
        await client.query("INSERT INTO benchi_eval_trials (id, run_id, position, trial) VALUES ($1, $2, $3, $4)", [trial.id, command.id, position, trial]);
      }
      await client.query("COMMIT");
      return snapshot;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async start(id: string): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query("UPDATE benchi_eval_run_snapshots SET state = 'Started' WHERE id = $1 AND state = 'Ready'", [id]);
      if (result.rowCount !== 1) throw new Error("Eval Run is not Ready");
      await client.query("INSERT INTO benchi_phase_jobs (id, trial_id, state) SELECT 'phase:' || id, id, 'queued' FROM benchi_eval_trials WHERE run_id = $1", [id]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async leaseNext(workerId: string, now: string, expiresAt: string): Promise<WorkerLease | undefined> {
    const result = await this.pool.query<{ id: string; trial_id: string; state: string; generation: number }>(`
      UPDATE benchi_phase_jobs SET state = 'leased', worker_id = $1, generation = generation + 1, lease_expires_at = $3
      WHERE id = (SELECT id FROM benchi_phase_jobs WHERE state = 'queued' AND $2::timestamptz < $3::timestamptz ORDER BY id FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, trial_id, state, generation
    `, [workerId, now, expiresAt]);
    const job = result.rows[0];
    return job && { jobId: job.id, trialId: job.trial_id, state: job.state, generation: job.generation, expiresAt };
  }

  async renewLease(jobId: string, workerId: string, generation: number, now: string, expiresAt: string): Promise<{ expiresAt: string }> {
    const result = await this.pool.query("UPDATE benchi_phase_jobs SET lease_expires_at = $5 WHERE id = $1 AND worker_id = $2 AND generation = $3 AND lease_expires_at > $4 AND state NOT IN ('completed', 'failed')", [jobId, workerId, generation, now, expiresAt]);
    if (result.rowCount !== 1) throw new Error("stale worker lease");
    return { expiresAt };
  }

  async recoverExpiredLeases(now: string): Promise<number> {
    const result = await this.pool.query("UPDATE benchi_phase_jobs SET state = 'queued', worker_id = NULL, lease_expires_at = NULL, candidate = NULL WHERE state IN ('leased', 'starting', 'running', 'committing') AND lease_expires_at <= $1", [now]);
    return result.rowCount ?? 0;
  }

  async markStarting(jobId: string, workerId: string, generation: number, now: string): Promise<void> {
    await this.transition(jobId, workerId, generation, now, "leased", "starting");
  }

  async markRunning(jobId: string, workerId: string, generation: number, now: string): Promise<void> {
    await this.transition(jobId, workerId, generation, now, "starting", "running");
  }

  async stageCandidate(jobId: string, workerId: string, generation: number, candidate: CandidateResult, now: string): Promise<void> {
    const result = await this.pool.query("UPDATE benchi_phase_jobs SET state = 'committing', candidate = $5 WHERE id = $1 AND worker_id = $2 AND generation = $3 AND lease_expires_at > $4 AND state = 'running'", [jobId, workerId, generation, now, candidate]);
    if (result.rowCount !== 1) throw new Error("stale worker lease");
  }

  async commitCandidate(jobId: string, workerId: string, generation: number, now: string): Promise<TrialAttempt> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const result = await client.query<{ trial_id: string; candidate: CandidateResult }>("SELECT trial_id, candidate FROM benchi_phase_jobs WHERE id = $1 AND worker_id = $2 AND generation = $3 AND lease_expires_at > $4 AND state = 'committing' FOR UPDATE", [jobId, workerId, generation, now]);
      const job = result.rows[0];
      if (!job?.candidate) throw new Error("stale worker lease");
      const attempt: TrialAttempt = { id: `${jobId}:attempt:${generation}`, trialId: job.trial_id, ...job.candidate, committedAt: now };
      await client.query("INSERT INTO benchi_trial_attempts (id, job_id, trial_id, attempt) VALUES ($1, $2, $3, $4)", [attempt.id, jobId, job.trial_id, attempt]);
      await client.query("UPDATE benchi_phase_jobs SET state = 'completed', worker_id = NULL, lease_expires_at = NULL, candidate = NULL WHERE id = $1", [jobId]);
      await client.query("COMMIT");
      return attempt;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async getJobForTrial(trialId: string): Promise<WorkerLease | undefined> {
    const result = await this.pool.query<{ id: string; trial_id: string; state: string; generation: number; lease_expires_at: Date }>("SELECT id, trial_id, state, generation, lease_expires_at FROM benchi_phase_jobs WHERE trial_id = $1", [trialId]);
    const job = result.rows[0];
    return job && { jobId: job.id, trialId: job.trial_id, state: job.state, generation: job.generation, expiresAt: job.lease_expires_at?.toISOString() };
  }

  async listAttempts(trialId: string): Promise<TrialAttempt[]> {
    const result = await this.pool.query<{ attempt: TrialAttempt }>("SELECT attempt FROM benchi_trial_attempts WHERE trial_id = $1 ORDER BY id", [trialId]);
    return result.rows.map(({ attempt }) => attempt);
  }

  static classifyFailure(failure: { kind: "agent" | "infrastructure" | "unknown"; reason: string }): "EvaluationOutcome" | "InfrastructureFailure" {
    return failure.kind === "agent" ? "EvaluationOutcome" : "InfrastructureFailure";
  }

  private async transition(jobId: string, workerId: string, generation: number, now: string, from: string, to: string): Promise<void> {
    const result = await this.pool.query("UPDATE benchi_phase_jobs SET state = $6 WHERE id = $1 AND worker_id = $2 AND generation = $3 AND lease_expires_at > $4 AND state = $5", [jobId, workerId, generation, now, from, to]);
    if (result.rowCount !== 1) throw new Error("stale worker lease");
  }

  async get(id: string): Promise<EvalRunSnapshot | undefined> {
    const run = await this.pool.query<{ state: "Ready" | "Started"; snapshot: EvalRunSnapshot }>("SELECT state, snapshot FROM benchi_eval_run_snapshots WHERE id = $1", [id]);
    if (!run.rows[0]) return undefined;
    const trials = await this.pool.query<{ trial: Trial }>("SELECT trial FROM benchi_eval_trials WHERE run_id = $1 ORDER BY position", [id]);
    return { ...run.rows[0].snapshot, state: run.rows[0].state, trials: trials.rows.map(({ trial }) => trial) };
  }
}

async function readSuiteFile(root: string, path: string): Promise<Buffer> {
  if (isAbsolute(path)) throw new Error("source path escapes suite root");
  const canonicalRoot = await realpath(root);
  const candidate = await realpath(resolve(canonicalRoot, path));
  const fromRoot = relative(canonicalRoot, candidate);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`)) throw new Error("source path escapes suite root");
  if (!(await stat(candidate)).isFile()) throw new Error("source must be a file");
  return readFile(candidate);
}

function identity(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
