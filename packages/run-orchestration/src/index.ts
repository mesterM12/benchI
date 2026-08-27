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
    const result = await this.pool.query("UPDATE benchi_eval_run_snapshots SET state = 'Started' WHERE id = $1 AND state = 'Ready'", [id]);
    if (result.rowCount !== 1) throw new Error("Eval Run is not Ready");
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
