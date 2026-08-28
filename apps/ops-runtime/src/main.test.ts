import { describe, expect, it, vi } from "vitest";
import type { RunOrchestration } from "@benchi/run-orchestration";
import { workerIteration } from "./main.js";

describe("worker process iteration", () => {
  it("leases, heartbeats, retains, stages, and fenced-commits", async () => {
    const calls: string[] = [];
    const runs = {
      leaseNext: async () => ({ jobId: "job-1", trialId: "trial-1", state: "leased", generation: 2, infrastructureFailures: 0 }),
      markStarting: async () => { calls.push("starting"); },
      executionFor: async () => ({ attemptId: "attempt", remote: "/repo", commit: "abc", prompt: "fix", acceptanceCommand: "npm test", model: "model" }),
      markRunning: async () => { calls.push("running"); },
      renewLease: async () => { calls.push("renew"); return { expiresAt: "later" }; },
      retainEvidence: async () => { calls.push("retain"); return { schemaVersion: "1", artifacts: [] }; },
      stageCandidate: async () => { calls.push("stage"); },
      commitCandidate: async () => { calls.push("commit"); },
      recordInfrastructureFailure: async () => "failed"
    } as unknown as RunOrchestration;

    await workerIteration(runs, {
      workerId: "worker-1", leaseMs: 100, heartbeatMs: 1,
      execute: async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { classification: "EvaluationOutcome", result: { outcome: "passed", execution: {} as never, diagnostics: [] }, runtimeEnvironment: { schemaVersion: "1", adapter: "sandcastle/opencode", observedAt: "now" }, evidence: [] };
      }
    });

    expect(calls.slice(0, 2)).toEqual(["starting", "running"]);
    expect(calls).toContain("renew");
    expect(calls.slice(-3)).toEqual(["retain", "stage", "commit"]);
  });

  it("durably records every post-lease failure", async () => {
    const failure = vi.fn().mockResolvedValue("failed");
    const runs = {
      leaseNext: async () => ({ jobId: "job-1", trialId: "trial-1", state: "leased", generation: 1, infrastructureFailures: 0 }),
      markStarting: async () => { throw new Error("broken"); },
      recordInfrastructureFailure: failure
    } as unknown as RunOrchestration;

    expect(await workerIteration(runs, { workerId: "worker-1", leaseMs: 100, heartbeatMs: 50 })).toBe(true);
    expect(failure).toHaveBeenCalledWith("job-1", "worker-1", 1, expect.any(String));
  });
});
