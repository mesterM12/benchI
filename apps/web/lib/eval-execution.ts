import { executeFrozenOpenCodeTrial } from "@benchi/worker-runtime";
import type { RunOrchestration } from "@benchi/run-orchestration";
import { runs } from "./server";

export const executeEvalRun = createEvalRunExecutor(runs);

export function createEvalRunExecutor(orchestration: RunOrchestration) {
 return async function execute(runId: string): Promise<void> {
  const run = await orchestration.get(runId);
  if (!run) throw new Error("Eval Run not found");
  const suite = run.suite as { agents: Array<{ id: string; model: string }>; tasks: Array<{ id: string; source: string; prompt: string; acceptance: { command: string } }> };
  for (;;) {
    const now = new Date();
    const lease = await orchestration.leaseNext("integrated-worker", now.toISOString(), new Date(now.getTime() + 3_600_000).toISOString(), runId);
    if (!lease) return;
    const trial = run.trials.find(({ id }) => id === lease.trialId)!;
    const task = suite.tasks.find(({ id }) => id === trial.taskId)!;
    const agent = suite.agents.find(({ id }) => id === trial.agentId)!;
    const source = run.sources.find((candidate) => candidate.id === task.source);
    if (!source || source.kind !== "git" || trial.agentId === undefined) throw new Error("Eval Trial is not executable");
    await orchestration.markStarting(lease.jobId, "integrated-worker", lease.generation, new Date().toISOString());
    await orchestration.markRunning(lease.jobId, "integrated-worker", lease.generation, new Date().toISOString());
    await orchestration.renewLease(lease.jobId, "integrated-worker", lease.generation, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString());
    try {
      const candidate = await executeFrozenOpenCodeTrial({ attemptId: `${runId}-${trial.id}`.replaceAll(/[^A-Za-z0-9._-]/g, "-"), remote: source.remote, commit: source.commit, prompt: task.prompt, acceptanceCommand: task.acceptance.command, model: agent.model });
      await orchestration.stageCandidate(lease.jobId, "integrated-worker", lease.generation, candidate, new Date().toISOString());
      await orchestration.commitCandidate(lease.jobId, "integrated-worker", lease.generation, new Date().toISOString());
    } catch {
      await orchestration.recordInfrastructureFailure(lease.jobId, "integrated-worker", lease.generation, new Date().toISOString());
    }
  }
 };
}
