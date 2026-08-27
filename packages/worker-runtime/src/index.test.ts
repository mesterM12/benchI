import { describe, expect, it, vi } from "vitest";
import { run as runSandcastle, type RunOptions, type RunResult, type SandboxProvider } from "@ai-hero/sandcastle";
import {
  WorkerRuntime,
  runOpenCodeTrial,
  runNativeLinuxConformance,
  type CapabilityProfile,
  type ExecutionEnvironmentSpecification
} from "./index.js";

vi.mock("@ai-hero/sandcastle", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-hero/sandcastle")>(),
  run: vi.fn()
}));

const profile: CapabilityProfile = {
  platform: "native-linux",
  isolation: "linux-container",
  networkModes: ["offline", "controlled-online"],
  adapters: ["sandcastle/v1"],
  retainedCapabilities: { rerunnable: false, rescorable: false, inspectable: true }
};
const offline: ExecutionEnvironmentSpecification = {
  platform: "native-linux",
  isolation: "linux-container",
  network: "offline",
  adapter: "sandcastle/v1"
};

describe("WorkerRuntime", () => {
  it("registers only authenticated, validity-bounded capability profiles", () => {
    const runtime = new WorkerRuntime();
    expect(() => runtime.register({ workerId: "worker-1", profile, authenticatedWorkerId: "worker-2", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" })).toThrow("WORKER_AUTHENTICATION_MISMATCH");
    expect(() => runtime.register({ workerId: "worker-1", profile, authenticatedWorkerId: "worker-1", validFrom: "2027-01-01T00:00:00Z", validUntil: "2026-01-01T00:00:00Z" })).toThrow("INVALID_VALIDITY_WINDOW");

    const worker = runtime.register({ workerId: "worker-1", profile, authenticatedWorkerId: "worker-1", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" });
    expect(worker.conformance).toBe("conformant");
  });

  it("reports runtime eligibility separately and never degrades policy", () => {
    const runtime = new WorkerRuntime();
    runtime.register({ workerId: "worker-1", profile: { ...profile, networkModes: ["offline"] }, authenticatedWorkerId: "worker-1", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" });

    expect(runtime.capabilities("worker-1", offline, "2026-06-01T00:00:00Z")).toEqual({ runtimeEligible: true, rerunnable: false, rescorable: false, inspectable: true, reasons: [] });
    expect(runtime.capabilities("worker-1", { ...offline, network: "controlled-online" }, "2026-06-01T00:00:00Z")).toMatchObject({ runtimeEligible: false, reasons: ["UNSUPPORTED_NETWORK"] });
    expect(runtime.capabilities("worker-1", { ...offline, isolation: "virtual-machine" }, "2026-06-01T00:00:00Z")).toMatchObject({ runtimeEligible: false, reasons: ["UNSUPPORTED_ISOLATION"] });
  });

  it("snapshots the authenticated profile", () => {
    const runtime = new WorkerRuntime();
    const submitted = structuredClone(profile);
    runtime.register({ workerId: "worker-1", profile: submitted, authenticatedWorkerId: "worker-1", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" });
    submitted.networkModes.push("closed-local");
    expect(runtime.capabilities("worker-1", { ...offline, network: "closed-local" }, "2026-06-01T00:00:00Z")).toMatchObject({ runtimeEligible: false, reasons: ["UNSUPPORTED_NETWORK"] });
  });

  it("drains, quarantines, reconforms, and revokes with new fences", () => {
    const runtime = new WorkerRuntime();
    const registered = runtime.register({ workerId: "worker-1", profile, authenticatedWorkerId: "worker-1", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" });
    const drained = runtime.drain("worker-1");
    expect(runtime.canCommit("worker-1", registered.fence)).toBe(false);
    expect(runtime.canCommit("worker-1", drained.fence)).toBe(true);
    runtime.quarantine("worker-1");
    expect(runtime.capabilities("worker-1", offline, "2026-06-01T00:00:00Z").runtimeEligible).toBe(false);
    const reconformed = runtime.reconform({ workerId: "worker-1", profile, authenticatedWorkerId: "worker-1", validFrom: "2026-01-01T00:00:00Z", validUntil: "2027-01-01T00:00:00Z" });
    expect(runtime.canCommit("worker-1", drained.fence)).toBe(false);
    runtime.revoke("worker-1");
    expect(runtime.canCommit("worker-1", reconformed.fence)).toBe(false);
  });
});

describe("native Linux conformance", () => {
  it("accepts isolation only when every escape attempt is blocked", async () => {
    const attempts: string[] = [];
    const result = await runNativeLinuxConformance({
      inspectIsolation: async () => true,
      attemptNetwork: async (target) => { attempts.push(target); return false; }
    });
    expect(result).toEqual({ conformant: true, failures: [] });
    expect(attempts).toEqual(["dns", "ipv4", "ipv6", "host-gateway", "local-network", "metadata", "peer-service"]);
  });

  it("fails closed on weak isolation or any network escape", async () => {
    const result = await runNativeLinuxConformance({
      inspectIsolation: async () => false,
      attemptNetwork: async (target) => target === "metadata"
    });
    expect(result).toEqual({ conformant: false, failures: ["ISOLATION_PROFILE_INVALID", "NETWORK_ESCAPE:metadata"] });
  });
});

describe("OpenCode trial execution", () => {
  it("returns normalized Sandcastle evidence from an isolated branch", async () => {
    let received: RunOptions | undefined;
    const sandbox = {} as SandboxProvider;
    const execute = async (options: RunOptions): Promise<RunResult> => {
      received = options;
      options.logging?.type === "file" && options.logging.onAgentStreamEvent?.({
        type: "toolCall",
        name: "edit",
        formattedArgs: "src/add.ts",
        iteration: 1,
        timestamp: new Date("2026-08-27T12:00:01.000Z")
      });
      return {
        iterations: [{}],
        completionSignal: "<promise>COMPLETE</promise>",
        stdout: "fixed\n<promise>COMPLETE</promise>",
        commits: [{ sha: "abc123" }],
        branch: "benchi/trial-attempt-7",
        logFilePath: "/repo/.sandcastle/logs/trial-attempt-7.log"
      };
    };
    vi.mocked(runSandcastle).mockImplementation(execute);

    const result = await runOpenCodeTrial({
      attemptId: "trial-attempt-7",
      repositoryPath: "/repo",
      prompt: "Fix the failing test and commit the change.",
      model: "openai/gpt-5.6",
      sandbox,
      now: (() => {
        const times = [new Date("2026-08-27T12:00:00.000Z"), new Date("2026-08-27T12:00:02.000Z")];
        return () => times.shift()!;
      })()
    });

    expect(received).toMatchObject({
      cwd: "/repo",
      prompt: "Fix the failing test and commit the change.",
      maxIterations: 1,
      branchStrategy: { type: "branch", branch: "benchi/trial-attempt-7" },
      logging: { type: "file", verbose: false }
    });
    expect(received?.agent.name).toBe("opencode");
    expect(received?.sandbox).toBe(sandbox);
    expect(result).toEqual({
      status: "completed",
      completionSignal: "<promise>COMPLETE</promise>",
      events: [{ type: "toolCall", name: "edit", formattedArgs: "src/add.ts", iteration: 1, occurredAt: "2026-08-27T12:00:01.000Z" }],
      stdout: "fixed\n<promise>COMPLETE</promise>",
      stderr: null,
      commits: ["abc123"],
      branch: "benchi/trial-attempt-7",
      preservedWorktreePath: null,
      runtime: {
        adapter: "sandcastle/opencode",
        model: "openai/gpt-5.6",
        startedAt: "2026-08-27T12:00:00.000Z",
        finishedAt: "2026-08-27T12:00:02.000Z",
        durationMs: 2000,
        iterations: 1,
        logFilePath: "/repo/.sandcastle/logs/trial-attempt-7.log",
        stderrCapture: "not-exposed-by-sandcastle"
      }
    });
  });
});
