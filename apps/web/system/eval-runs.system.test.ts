import { execFile, spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvaluationDefinition } from "@benchi/evaluation-definition";
import { RunOrchestration, createS3RetainedContent, migrate as migrateRuns } from "@benchi/run-orchestration";
import { runCli } from "../../cli/src/main.js";
import { createEvalSuitePost } from "../app/api/v1/eval-suites/route.js";
import { createEvalRunPost } from "../app/api/v1/eval-runs/route.js";
import { createEvalRunGet } from "../app/api/v1/eval-runs/[id]/route.js";
import { createEvalRunStartPost } from "../app/api/v1/eval-runs/[id]/start/route.js";

const exec = promisify(execFile);
const databaseUrl = required("TEST_DATABASE_URL");
const bucket = `benchi-system-${randomUUID()}`;
const content = createS3RetainedContent({
  endpoint: required("TEST_OBJECT_STORAGE_ENDPOINT"),
  accessKeyId: required("TEST_OBJECT_STORAGE_ACCESS_KEY"),
  secretAccessKey: required("TEST_OBJECT_STORAGE_SECRET_KEY"),
  bucket
});
const pool = new Pool({ connectionString: databaseUrl });
const definitions = new EvaluationDefinition(pool);
const runs = new RunOrchestration(pool, content);
const member = async (headers: Headers) => headers.get("cookie") === "session=system" ? "member-system" : undefined;
const ids = ["run-connected", "run-replay-unused", "run-failed"];
const suitePost = createEvalSuitePost({ member, definitions });
const runPost = createEvalRunPost({ member, definitions, runs, id: () => ids.shift()!, now: () => new Date("2026-08-27T12:00:00.000Z") });
const runGet = createEvalRunGet({ member, runs });
const runStart = createEvalRunStartPost({ member, runs });

describe("connected Git-backed Eval Run", () => {
  beforeAll(async () => {
    await definitions.migrate();
    await migrateRuns(pool);
    await pool.query("TRUNCATE benchi_eval_run_receipts, benchi_eval_run_start_receipts, benchi_trial_attempts, benchi_phase_jobs, benchi_eval_trials, benchi_eval_run_snapshots, command_receipts, eval_suite_revisions CASCADE");
  });
  afterAll(() => pool.end());

  it("creates a suite, freezes once, inspects retained provenance, and rolls back failure through CLI and API", async () => {
    const remote = await mkdtemp(join(tmpdir(), "benchi-connected-git-"));
    await exec("git", ["init", "--initial-branch=main", remote]);
    await exec("git", ["-C", remote, "config", "user.email", "test@example.test"]);
    await exec("git", ["-C", remote, "config", "user.name", "Test"]);
    await writeFile(join(remote, "add.js"), "export const add = (left, right) => left - right;\n");
    await writeFile(join(remote, "add.test.js"), "import assert from 'node:assert/strict'; import test from 'node:test'; import { add } from './add.js'; test('adds', () => assert.equal(add(2, 3), 5));\n");
    await writeFile(join(remote, "package.json"), "{\"type\":\"module\",\"scripts\":{\"test\":\"node --test\"}}\n");
    await exec("git", ["-C", remote, "add", "."]);
    await exec("git", ["-C", remote, "commit", "-m", "first"]);
    const firstCommit = (await exec("git", ["-C", remote, "rev-parse", "HEAD"])).stdout.trim();
    const suiteFile = join(remote, "suite.yaml");
    await writeFile(suiteFile, suite("connected", remote));
    const output: string[] = [];

    expect(await runCli(["suite", "create", suiteFile, "--idempotency-key", "suite-create"], output.push.bind(output), request, config)).toBe(0);
    const created = JSON.parse(output.pop()!);
    expect(await runCli(["run", "freeze", created.id, "--revision", String(created.revision), "--idempotency-key", "freeze-once"], output.push.bind(output), request, config)).toBe(0);
    const frozen = JSON.parse(output.pop()!);

    await writeFile(join(remote, "README.md"), "second\n");
    await exec("git", ["-C", remote, "add", "."]);
    await exec("git", ["-C", remote, "commit", "-m", "second"]);
    expect(await runCli(["run", "freeze", created.id, "--revision", "1", "--idempotency-key", "freeze-once"], output.push.bind(output), request, config)).toBe(0);
    expect(JSON.parse(output.pop()!).id).toBe(frozen.id);

    expect(await runCli(["run", "inspect", frozen.id], output.push.bind(output), request, config)).toBe(0);
    const inspected = JSON.parse(output.pop()!);
    expect(inspected.trials).toEqual([expect.objectContaining({ id: "opencode__task__baseline__1" })]);
    expect(inspected.sources).toEqual([expect.objectContaining({ kind: "git", commit: firstCommit, requestedRef: "main" })]);
    const expectedArchive = (await exec("git", ["-C", remote, "archive", "--format=tar", firstCommit], { encoding: "buffer" })).stdout;
    expect(await content.get(inspected.sources[0].contentIdentity)).toEqual(expectedArchive);

    expect(await runCli(["run", "start", frozen.id, "--idempotency-key", "start-once"], output.push.bind(output), request, config)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ idempotencyKey: "start-once", replayed: false });
    const staleNow = new Date(Date.now() - 2_000);
    expect(await runs.leaseNext("dead-worker", staleNow.toISOString(), new Date(staleNow.getTime() + 1_000).toISOString())).toMatchObject({ generation: 1 });
    const processes = [startRole("orchestrator", 31038), startRole("worker", 31039)];
    try {
      await Promise.all([waitForHealth(31038), waitForHealth(31039)]);
      const completed = await waitForCompletion(frozen.id, output, processes);
      expect(completed).not.toHaveProperty("jobs");
      expect(completed.trialStates).toEqual([expect.objectContaining({ state: "completed", attemptCount: 1 })]);
      expect(completed.trialAttempts).toEqual([expect.objectContaining({
        classification: "EvaluationOutcome",
        result: expect.objectContaining({ outcome: "passed", execution: expect.objectContaining({ status: "completed", commits: [expect.any(String)], acceptance: expect.objectContaining({ command: "npm test", exitCode: 0 }) }) })
      })]);
      const artifacts = completed.trialAttempts[0].artifactManifest.artifacts as Array<{ path: string; contentIdentity: string; size: number }>;
      expect(artifacts.map(({ path }) => path)).toEqual(expect.arrayContaining(["sandcastle-result.json", "mutated-repository.tar", "sandcastle.log"]));
      for (const artifact of artifacts) expect((await content.get(artifact.contentIdentity))?.length).toBe(artifact.size);
      const archive = await content.get(artifacts.find(({ path }) => path === "mutated-repository.tar")!.contentIdentity);
      const checkout = await mkdtemp(join(tmpdir(), "benchi-accepted-"));
      await writeFile(join(checkout, "repository.tar"), archive!);
      await exec("tar", ["-xf", "repository.tar"], { cwd: checkout });
      await expect(exec("npm", ["test"], { cwd: checkout })).resolves.toMatchObject({ stderr: "" });
    } finally {
      await Promise.all(processes.map(stopRole));
    }
    expect(await runCli(["run", "start", frozen.id, "--idempotency-key", "start-once"], output.push.bind(output), request, config)).toBe(0);
    expect(JSON.parse(output.pop()!)).toMatchObject({ idempotencyKey: "start-once", replayed: true });

    const failedSuite = join(remote, "failed.yaml");
    await writeFile(failedSuite, suite("failed", join(remote, "missing.git")));
    expect(await runCli(["suite", "create", failedSuite, "--idempotency-key", "suite-failed"], output.push.bind(output), request, config)).toBe(0);
    expect(await runCli(["run", "freeze", "failed", "--revision", "1", "--idempotency-key", "freeze-failed"], output.push.bind(output), request, config)).toBe(1);
    expect((await pool.query("SELECT count(*)::int count FROM benchi_eval_run_snapshots WHERE id = 'run-failed'")).rows[0].count).toBe(0);
    expect((await pool.query("SELECT count(*)::int count FROM benchi_eval_trials WHERE run_id = 'run-failed'")).rows[0].count).toBe(0);
  }, 10 * 60_000);
});

const config = { server: "http://system.test", session: "session=system" };
async function request(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const url = new URL(request.url);
  if (request.method === "POST" && url.pathname === "/api/v1/eval-suites") return suitePost(request);
  if (request.method === "POST" && url.pathname === "/api/v1/eval-runs") return runPost(request);
  const start = url.pathname.match(/^\/api\/v1\/eval-runs\/([^/]+)\/start$/);
  if (request.method === "POST" && start) return runStart(request, { params: Promise.resolve({ id: decodeURIComponent(start[1]!) }) });
  const match = url.pathname.match(/^\/api\/v1\/eval-runs\/([^/]+)$/);
  if (request.method === "GET" && match) return runGet(request, { params: Promise.resolve({ id: decodeURIComponent(match[1]!) }) });
  return new Response("not found", { status: 404 });
}
function suite(id: string, remote: string): string {
  return `kind: EvalSuite\nschemaVersion: "1"\nid: ${id}\nsources: [{id: source, git: {remote: ${JSON.stringify(remote)}, ref: main}}]\nagents: [{id: opencode, adapter: opencode, model: opencode/big-pickle}]\ntasks: [{id: task, source: source, prompt: Fix the broken add function., acceptance: {command: npm test}}]\nexecution: {timeoutSeconds: 600}\nmatrix: {repetitions: 1}\n`;
}
function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function startRole(role: "orchestrator" | "worker", port: number): { process: ChildProcess; logs: string[] } {
  const logs: string[] = [];
  const child = spawn(process.execPath, [join(process.cwd(), "../ops-runtime/dist/main.js")], {
    env: {
      ...process.env,
      BENCHI_ROLE: role,
      PORT: String(port),
      DATABASE_URL: databaseUrl,
      OBJECT_STORAGE_ENDPOINT: required("TEST_OBJECT_STORAGE_ENDPOINT"),
      OBJECT_STORAGE_ACCESS_KEY: required("TEST_OBJECT_STORAGE_ACCESS_KEY"),
      OBJECT_STORAGE_SECRET_KEY: required("TEST_OBJECT_STORAGE_SECRET_KEY"),
      OBJECT_STORAGE_BUCKET: bucket,
      BENCHI_POLL_MS: "100",
      BENCHI_LEASE_MS: "3000",
      BENCHI_HEARTBEAT_MS: "500"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  child.stdout?.on("data", (value) => logs.push(String(value)));
  child.stderr?.on("data", (value) => logs.push(String(value)));
  return { process: child, logs };
}

async function waitForHealth(port: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`role on ${port} did not become healthy`);
}

async function waitForCompletion(runId: string, output: string[], processes: Array<{ process: ChildProcess; logs: string[] }>): Promise<any> {
  for (let attempt = 0; attempt < 1200; attempt++) {
    expect(await runCli(["run", "inspect", runId], output.push.bind(output), request, config)).toBe(0);
    const inspected = JSON.parse(output.pop()!);
    if (inspected.trialStates[0]?.state === "completed") return inspected;
    if (processes.some(({ process }) => process.exitCode !== null)) throw new Error(processes.flatMap(({ logs }) => logs).join("\n"));
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Eval Run did not complete:\n${processes.flatMap(({ logs }) => logs).join("\n")}`);
}

async function stopRole({ process: child }: { process: ChildProcess }): Promise<void> {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise<void>((resolve) => child.once("exit", () => resolve()));
}
