import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";
import { RunOrchestration, createS3RetainedContent, migrate, type WorkerLease } from "@benchi/run-orchestration";
import { executeFrozenOpenCodeTrial } from "@benchi/worker-runtime";

export async function orchestratorIteration(runs: RunOrchestration, now = new Date()): Promise<void> {
  await runs.recoverExpiredLeases(now.toISOString());
}

export async function workerIteration(runs: RunOrchestration, options: { workerId: string; leaseMs: number; heartbeatMs: number; execute?: typeof executeFrozenOpenCodeTrial }): Promise<boolean> {
  const leasedAt = new Date();
  const lease = await runs.leaseNext(options.workerId, leasedAt.toISOString(), new Date(leasedAt.getTime() + options.leaseMs).toISOString());
  if (!lease) return false;
  let heartbeatError: unknown;
  const heartbeat = setInterval(() => {
    const now = new Date();
    void runs.renewLease(lease.jobId, options.workerId, lease.generation, now.toISOString(), new Date(now.getTime() + options.leaseMs).toISOString()).catch((error) => { heartbeatError = error; });
  }, options.heartbeatMs);
  try {
    await runs.markStarting(lease.jobId, options.workerId, lease.generation, new Date().toISOString());
    const execution = await runs.executionFor(lease);
    await runs.markRunning(lease.jobId, options.workerId, lease.generation, new Date().toISOString());
    const completed = await (options.execute ?? executeFrozenOpenCodeTrial)(execution);
    if (heartbeatError) throw heartbeatError;
    const artifactManifest = await runs.retainEvidence(completed.evidence);
    if (heartbeatError) throw heartbeatError;
    await runs.stageCandidate(lease.jobId, options.workerId, lease.generation, {
      classification: completed.classification,
      result: completed.result,
      artifactManifest,
      runtimeEnvironment: completed.runtimeEnvironment
    }, new Date().toISOString());
    await runs.commitCandidate(lease.jobId, options.workerId, lease.generation, new Date().toISOString());
  } catch (error) {
    await persistPostLeaseFailure(runs, lease, options.workerId, error);
  } finally {
    clearInterval(heartbeat);
  }
  return true;
}

async function persistPostLeaseFailure(runs: RunOrchestration, lease: WorkerLease, workerId: string, error: unknown): Promise<void> {
  try {
    await runs.recordInfrastructureFailure(lease.jobId, workerId, lease.generation, new Date().toISOString());
  } catch (persistenceError) {
    console.error("worker failure could not be persisted", error, persistenceError);
  }
}

export async function runRole(role: "orchestrator" | "worker"): Promise<void> {
  const pool = new Pool({ connectionString: required("DATABASE_URL") });
  const runs = new RunOrchestration(pool, createS3RetainedContent({
    endpoint: required("OBJECT_STORAGE_ENDPOINT"),
    accessKeyId: required("OBJECT_STORAGE_ACCESS_KEY"),
    secretAccessKey: required("OBJECT_STORAGE_SECRET_KEY"),
    bucket: process.env.OBJECT_STORAGE_BUCKET
  }));
  await migrate(pool);
  const pollMs = Number(process.env.BENCHI_POLL_MS ?? 1000);
  const worker = {
    workerId: process.env.BENCHI_WORKER_ID ?? `worker-${process.pid}`,
    leaseMs: Number(process.env.BENCHI_LEASE_MS ?? 30_000),
    heartbeatMs: Number(process.env.BENCHI_HEARTBEAT_MS ?? 10_000)
  };
  let stopping = false;
  process.once("SIGTERM", () => { stopping = true; });
  process.once("SIGINT", () => { stopping = true; });
  const port = Number(process.env.PORT ?? (role === "orchestrator" ? 3001 : 3002));
  const server = createServer((request, response) => {
    if (request.url !== "/health") return void response.writeHead(404).end();
    response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ role, status: "ready" }));
  }).listen(port, "127.0.0.1");
  try {
    while (!stopping) {
      if (role === "orchestrator") await orchestratorIteration(runs);
      else await workerIteration(runs, worker);
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  } finally {
    server.close();
    await pool.end();
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const role = process.env.BENCHI_ROLE;
  if (role !== "orchestrator" && role !== "worker") throw new Error("BENCHI_ROLE must be orchestrator or worker");
  await runRole(role);
}
