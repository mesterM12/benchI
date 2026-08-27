import { randomUUID } from "node:crypto";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { DeterministicFakeAgent, InMemoryRetainedContent, RunOrchestration, migrate } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const protocol = describe.runIf(databaseUrl);

protocol("Freeze Eval Run Protocol Transaction", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  let root: string;

  beforeAll(async () => {
    await migrate(pool);
    await pool.query("TRUNCATE benchi_trial_attempts, benchi_phase_jobs, benchi_eval_trials, benchi_eval_run_snapshots CASCADE");
    root = await mkdtemp(join(tmpdir(), "benchi-freeze-"));
    await mkdir(join(root, "tasks"));
    await writeFile(join(root, "tasks", "prompt.md"), "Fix checkout.\n");
  });
  afterAll(() => pool.end());

  it("retains verified local sources before atomically publishing frozen matrix and provenance", async () => {
    const content = new InMemoryRetainedContent();
    const runs = new RunOrchestration(pool, content);
    const snapshot = await runs.freeze({
      id: "run-1",
      suiteRevisionId: "suite-revision-7",
      suiteRoot: root,
      suite: { kind: "EvalSuite", schemaVersion: "1", id: "checkout" },
      resolvedDefinitions: { agents: [{ id: "codex", adapter: "sandcastle@1" }] },
      trials: [
        { id: "trial-z", agentId: "codex", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 1 },
        { id: "trial-a", agentId: "codex", taskId: "checkout", scenarioVariantId: "baseline", repetitionIndex: 1 }
      ],
      effectivePolicies: { "trial-1": { maxAttempts: 1 } },
      localSources: [{ id: "task-prompt", path: "tasks/prompt.md" }],
      frozenAt: "2026-08-27T12:00:00.000Z",
      benchiVersion: "0.0.0"
    });

    expect(snapshot.state).toBe("Ready");
    expect(snapshot.sources).toEqual([{
      id: "task-prompt",
      kind: "suite-relative",
      requestedPath: "tasks/prompt.md",
      contentIdentity: "sha256:ce0747902731c705d8b0418f7e3b3e2cc05a07e89566ae6a1d455d2926ad312a",
      size: 14
    }]);
    expect(await content.get(snapshot.sources[0]!.contentIdentity)).toEqual(Buffer.from("Fix checkout.\n"));
    expect(snapshot).toMatchObject({ suiteRevisionId: "suite-revision-7", resolvedDefinitions: { agents: [{ id: "codex" }] }, effectivePolicies: { "trial-1": { maxAttempts: 1 } } });
    expect((await runs.get("run-1"))?.trials.map(({ id }) => id)).toEqual(["trial-z", "trial-a"]);
  });

  it("publishes neither snapshot nor trials when source retention fails", async () => {
    const content = new InMemoryRetainedContent();
    content.failNextPut = true;
    const runs = new RunOrchestration(pool, content);

    await expect(runs.freeze({
      id: "run-failed",
      suiteRevisionId: "suite-revision-7",
      suiteRoot: root,
      suite: {}, resolvedDefinitions: {}, effectivePolicies: {}, trials: [],
      localSources: [{ id: "task-prompt", path: "tasks/prompt.md" }],
      frozenAt: "2026-08-27T12:00:00.000Z", benchiVersion: "0.0.0"
    })).rejects.toThrow("retention failed");

    expect(await runs.get("run-failed")).toBeUndefined();
    expect((await pool.query("SELECT count(*)::int AS count FROM benchi_eval_trials WHERE run_id = $1", ["run-failed"])).rows[0].count).toBe(0);
  });

  it("rolls back snapshot and trials when publishing fails", async () => {
    const runs = new RunOrchestration(pool, new InMemoryRetainedContent());
    const duplicateTrial = { id: "duplicate", agentId: "codex", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 1 };

    await expect(runs.freeze({
      id: "run-rollback",
      suiteRevisionId: "suite-revision-7",
      suiteRoot: root,
      suite: {}, resolvedDefinitions: {}, effectivePolicies: {}, trials: [duplicateTrial, duplicateTrial],
      localSources: [],
      frozenAt: "2026-08-27T12:00:00.000Z", benchiVersion: "0.0.0"
    })).rejects.toThrow();

    expect(await runs.get("run-rollback")).toBeUndefined();
    expect((await pool.query("SELECT count(*)::int AS count FROM benchi_eval_trials WHERE run_id = $1", ["run-rollback"])).rows[0].count).toBe(0);
  });

  it("starts only through separate command without changing snapshot", async () => {
    const runs = new RunOrchestration(pool, new InMemoryRetainedContent());
    const before = await runs.get("run-1");
    await runs.start("run-1");
    const after = await runs.get("run-1");
    expect(after?.state).toBe("Started");
    expect(after?.sources).toEqual(before?.sources);
    expect(after?.trials).toEqual(before?.trials);
  });
});

protocol("Eval Trial worker protocol", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const content = new InMemoryRetainedContent();
  const runs = new RunOrchestration(pool, content);

  beforeAll(async () => {
    await migrate(pool);
  });
  beforeEach(() => pool.query("TRUNCATE benchi_trial_attempts, benchi_phase_jobs, benchi_eval_trials, benchi_eval_run_snapshots CASCADE"));
  afterAll(() => pool.end());

  async function startTrial() {
    const suffix = randomUUID();
    const runId = `worker-run-${suffix}`;
    const trialId = `worker-trial-${suffix}`;
    await runs.freeze({
      id: runId, suiteRevisionId: "suite-1", suiteRoot: process.cwd(), suite: {}, resolvedDefinitions: {}, effectivePolicies: {},
      trials: [{ id: trialId, agentId: "fake", taskId: "task", scenarioVariantId: "baseline", repetitionIndex: 1 }],
      localSources: [], frozenAt: "2026-08-27T12:00:00.000Z", benchiVersion: "0.0.0"
    });
    await runs.start(runId);
    return trialId;
  }

  it("survives restart and renews a generation-bound lease", async () => {
    const trialId = await startTrial();
    const restarted = new RunOrchestration(pool, content);
    const lease = await restarted.leaseNext("worker-a", "2026-08-27T12:01:00.000Z", "2026-08-27T12:02:00.000Z");
    expect(lease).toMatchObject({ trialId, state: "leased", generation: 1 });

    const renewed = await restarted.renewLease(lease!.jobId, "worker-a", 1, "2026-08-27T12:01:30.000Z", "2026-08-27T12:03:00.000Z");
    expect(renewed.expiresAt).toBe("2026-08-27T12:03:00.000Z");
  });

  it("rejects stale mutations after expiry and re-lease", async () => {
    await startTrial();
    const firstLease = (await runs.leaseNext("worker-a", "2026-08-27T12:01:00.000Z", "2026-08-27T12:02:00.000Z"))!;
    await runs.recoverExpiredLeases("2026-08-27T12:04:00.000Z");
    const lease = await runs.leaseNext("worker-b", "2026-08-27T12:04:00.000Z", "2026-08-27T12:05:00.000Z");
    expect(lease?.generation).toBe(2);
    await expect(runs.markStarting(firstLease.jobId, "worker-a", 1, "2026-08-27T12:04:01.000Z")).rejects.toThrow("stale worker lease");
  });

  it("restarts after staging and commits first valid candidate as immutable attempt", async () => {
    const trialId = await startTrial();
    const lease = (await runs.leaseNext("worker-a", "2026-08-27T12:01:00.000Z", "2026-08-27T12:05:00.000Z"))!;
    await runs.markStarting(lease.jobId, "worker-a", 1, "2026-08-27T12:01:01.000Z");
    expect((await runs.getJobForTrial(trialId))?.state).toBe("starting");
    await runs.markRunning(lease.jobId, "worker-a", 1, "2026-08-27T12:01:02.000Z");
    const candidate = await new DeterministicFakeAgent().execute({ trialId, prompt: "make deterministic change" });
    await runs.stageCandidate(lease.jobId, "worker-a", 1, candidate, "2026-08-27T12:01:03.000Z");

    const restarted = new RunOrchestration(pool, content);
    expect((await restarted.getJobForTrial(trialId))?.state).toBe("committing");
    const attempt = await restarted.commitCandidate(lease.jobId, "worker-a", 1, "2026-08-27T12:01:04.000Z");

    expect(attempt).toMatchObject({
      trialId, classification: "EvaluationOutcome",
      artifactManifest: { schemaVersion: "1", artifacts: [{ path: "agent-result.json" }] },
      runtimeEnvironment: { schemaVersion: "1", adapter: "deterministic-fake/v1" }
    });
    expect((await restarted.getJobForTrial(trialId))?.state).toBe("completed");
    await expect(restarted.commitCandidate(lease.jobId, "worker-a", 1, "2026-08-27T12:01:05.000Z")).rejects.toThrow("stale worker lease");
    expect(await restarted.listAttempts(trialId)).toEqual([attempt]);
    await expect(pool.query("UPDATE benchi_trial_attempts SET attempt = '{}' WHERE id = $1", [attempt.id])).rejects.toThrow("Trial Attempts are immutable");
    await expect(pool.query("DELETE FROM benchi_trial_attempts WHERE id = $1", [attempt.id])).rejects.toThrow("Trial Attempts are immutable");
  });

  it("keeps agent and infrastructure failures distinct", async () => {
    expect(RunOrchestration.classifyFailure({ kind: "agent", reason: "agent exited" })).toBe("EvaluationOutcome");
    expect(RunOrchestration.classifyFailure({ kind: "infrastructure", reason: "worker lost" })).toBe("InfrastructureFailure");
    expect(RunOrchestration.classifyFailure({ kind: "unknown", reason: "unclassified" })).toBe("InfrastructureFailure");
  });
});

describe("retained-content provider conformance", () => {
  it("verifies identities and rejects digest mismatches", async () => {
    const store = new InMemoryRetainedContent();
    const bytes = Buffer.from("source");
    const identity = "sha256:41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d";
    await store.putVerified(identity, bytes);
    expect(await store.get(identity)).toEqual(bytes);
    await expect(store.putVerified(identity, Buffer.from("changed"))).rejects.toThrow("digest mismatch");
  });
});
