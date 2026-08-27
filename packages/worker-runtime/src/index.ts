import { join } from "node:path";
import {
  createWorktree,
  opencode,
  type AgentStreamEvent,
  type OpenCodeOptions,
  type SandboxProvider,
  type Worktree
} from "@ai-hero/sandcastle";

export type Platform = "native-linux";
export type Isolation = "linux-container" | "virtual-machine";
export type NetworkMode = "offline" | "closed-local" | "controlled-online";
export type RetainedCapabilities = { rerunnable: boolean; rescorable: boolean; inspectable: boolean };
export type CapabilityProfile = {
  platform: Platform;
  isolation: Isolation;
  networkModes: NetworkMode[];
  adapters: string[];
  retainedCapabilities: RetainedCapabilities;
};
export type ExecutionEnvironmentSpecification = {
  platform: Platform;
  isolation: Isolation;
  network: NetworkMode;
  adapter: string;
};
export type WorkerRegistration = {
  workerId: string;
  authenticatedWorkerId: string;
  profile: CapabilityProfile;
  validFrom: string;
  validUntil: string;
};
export type WorkerState = "active" | "draining" | "quarantined" | "revoked";
export type WorkerRecord = WorkerRegistration & {
  state: WorkerState;
  conformance: "conformant";
  fence: number;
};
export type RuntimeCapabilities = RetainedCapabilities & {
  runtimeEligible: boolean;
  reasons: string[];
};

export type OpenCodeTrialEvent =
  | { type: "text"; message: string; iteration: number; occurredAt: string }
  | { type: "toolCall"; name: string; formattedArgs: string; iteration: number; occurredAt: string }
  | { type: "raw"; line: string; iteration: number; occurredAt: string };
export type OpenCodeTrialResult = {
  status: "completed" | "failed" | "cancelled";
  error: { name: string; message: string } | null;
  completionSignal: string | null;
  events: OpenCodeTrialEvent[];
  output: {
    stdout: { availability: "complete" | "stream-events-only"; text: string | null };
    stderr: { availability: "unavailable"; text: null; reason: "Sandcastle public agent-run API does not expose stderr" };
  };
  commits: string[];
  branch: string;
  preservedWorktreePath: string | null;
  runtime: {
    adapter: "sandcastle/opencode";
    model: string;
    startedAt: string;
    finishedAt: string;
    durationMs: number;
    iterations: number;
    logFilePath: string | null;
    worktreePath: string | null;
    worktreeDisposition: "not-created" | "cleaned" | "preserved";
  };
};
export type OpenCodeTrialInput = {
  attemptId: string;
  repositoryPath: string;
  prompt: string;
  model: string;
  sandbox: SandboxProvider;
  variant?: string;
  agent?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  now?: () => Date;
};

export async function runOpenCodeTrial(input: OpenCodeTrialInput): Promise<OpenCodeTrialResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.attemptId)) throw new Error("INVALID_ATTEMPT_ID");
  const now = input.now ?? (() => new Date());
  const started = now();
  const events: OpenCodeTrialEvent[] = [];
  const options: OpenCodeOptions = { variant: input.variant, agent: input.agent, env: input.env };
  const branch = `benchi/${input.attemptId}`;
  let worktree: Worktree;
  try {
    worktree = await createWorktree({ cwd: input.repositoryPath, branchStrategy: { type: "branch", branch } });
  } catch (error) {
    const finished = now();
    return {
      status: input.signal?.aborted ? "cancelled" : "failed",
      error: errorDetails(error),
      completionSignal: null,
      events,
      output: unavailableOutput(),
      commits: [],
      branch,
      preservedWorktreePath: null,
      runtime: {
        adapter: "sandcastle/opencode",
        model: input.model,
        startedAt: started.toISOString(),
        finishedAt: finished.toISOString(),
        durationMs: finished.getTime() - started.getTime(),
        iterations: 0,
        logFilePath: null,
        worktreePath: null,
        worktreeDisposition: "not-created"
      }
    };
  }
  try {
    const result = await worktree.run({
      agent: opencode(input.model, options),
      sandbox: input.sandbox,
      prompt: input.prompt,
      maxIterations: 1,
      logging: {
        type: "file",
        path: join(input.repositoryPath, ".sandcastle", "logs", `${input.attemptId}.log`),
        verbose: false,
        onAgentStreamEvent: (event) => events.push(normalizeAgentEvent(event))
      },
      signal: input.signal
    });
    const close = await worktree.close();
    return evidence(input, started, now(), events, worktree, {
      status: "completed",
      error: null,
      completionSignal: result.completionSignal ?? null,
      stdout: result.stdout,
      commits: result.commits.map(({ sha }) => sha),
      iterations: result.iterations.length,
      logFilePath: result.logFilePath ?? null,
      preservedWorktreePath: close.preservedWorktreePath ?? null
    });
  } catch (error) {
    let preservedWorktreePath: string | null;
    try {
      preservedWorktreePath = (await worktree.close()).preservedWorktreePath ?? null;
    } catch {
      preservedWorktreePath = worktree.worktreePath;
    }
    return evidence(input, started, now(), events, worktree, {
      status: input.signal?.aborted ? "cancelled" : "failed",
      error: errorDetails(error),
      completionSignal: null,
      stdout: null,
      commits: [],
      iterations: 0,
      logFilePath: null,
      preservedWorktreePath
    });
  }
}

type Evidence = {
  status: OpenCodeTrialResult["status"];
  error: OpenCodeTrialResult["error"];
  completionSignal: string | null;
  stdout: string | null;
  commits: string[];
  iterations: number;
  logFilePath: string | null;
  preservedWorktreePath: string | null;
};

function evidence(input: OpenCodeTrialInput, started: Date, finished: Date, events: OpenCodeTrialEvent[], worktree: Worktree, value: Evidence): OpenCodeTrialResult {
  const preserved = value.preservedWorktreePath !== null;
  return {
    status: value.status,
    error: value.error,
    completionSignal: value.completionSignal,
    events,
    output: value.stdout === null ? unavailableOutput() : {
      stdout: { availability: "complete", text: value.stdout },
      stderr: unavailableOutput().stderr
    },
    commits: value.commits,
    branch: worktree.branch,
    preservedWorktreePath: value.preservedWorktreePath,
    runtime: {
      adapter: "sandcastle/opencode",
      model: input.model,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      iterations: value.iterations,
      logFilePath: value.logFilePath,
      worktreePath: worktree.worktreePath,
      worktreeDisposition: preserved ? "preserved" : "cleaned"
    }
  };
}

function unavailableOutput(): OpenCodeTrialResult["output"] {
  return {
    stdout: { availability: "stream-events-only", text: null },
    stderr: { availability: "unavailable", text: null, reason: "Sandcastle public agent-run API does not expose stderr" }
  };
}

function errorDetails(error: unknown): { name: string; message: string } {
  return error instanceof Error ? { name: error.name, message: error.message } : { name: "Error", message: String(error) };
}

function normalizeAgentEvent(event: AgentStreamEvent): OpenCodeTrialEvent {
  const common = { iteration: event.iteration, occurredAt: event.timestamp.toISOString() };
  if (event.type === "text") return { type: event.type, message: event.message, ...common };
  if (event.type === "toolCall") return { type: event.type, name: event.name, formattedArgs: event.formattedArgs, ...common };
  return { type: event.type, line: event.line, ...common };
}

export class WorkerRuntime {
  private readonly workers = new Map<string, WorkerRecord>();

  register(registration: WorkerRegistration): WorkerRecord {
    if (registration.authenticatedWorkerId !== registration.workerId) throw new Error("WORKER_AUTHENTICATION_MISMATCH");
    validity(registration);
    if (this.workers.has(registration.workerId)) throw new Error("WORKER_ALREADY_REGISTERED");
    const worker = { ...registration, profile: copyProfile(registration.profile), state: "active" as const, conformance: "conformant" as const, fence: 1 };
    this.workers.set(worker.workerId, worker);
    return copy(worker);
  }

  reconform(registration: WorkerRegistration): WorkerRecord {
    const current = this.require(registration.workerId);
    if (current.state === "revoked") throw new Error("WORKER_REVOKED");
    if (registration.authenticatedWorkerId !== registration.workerId) throw new Error("WORKER_AUTHENTICATION_MISMATCH");
    validity(registration);
    const worker = { ...registration, profile: copyProfile(registration.profile), state: "active" as const, conformance: "conformant" as const, fence: current.fence + 1 };
    this.workers.set(worker.workerId, worker);
    return copy(worker);
  }

  drain(workerId: string): WorkerRecord { return this.transition(workerId, "draining"); }
  quarantine(workerId: string): WorkerRecord { return this.transition(workerId, "quarantined"); }
  revoke(workerId: string): WorkerRecord { return this.transition(workerId, "revoked"); }

  canCommit(workerId: string, fence: number): boolean {
    const worker = this.workers.get(workerId);
    return worker !== undefined && worker.state !== "quarantined" && worker.state !== "revoked" && worker.fence === fence;
  }

  capabilities(workerId: string, specification: ExecutionEnvironmentSpecification, now: string): RuntimeCapabilities {
    const worker = this.require(workerId);
    const reasons: string[] = [];
    const time = timestamp(now);
    if (worker.state !== "active") reasons.push(`WORKER_${worker.state.toUpperCase()}`);
    if (time < timestamp(worker.validFrom) || time >= timestamp(worker.validUntil)) reasons.push("CONFORMANCE_EXPIRED");
    if (worker.profile.platform !== specification.platform) reasons.push("UNSUPPORTED_PLATFORM");
    if (worker.profile.isolation !== specification.isolation) reasons.push("UNSUPPORTED_ISOLATION");
    if (!worker.profile.networkModes.includes(specification.network)) reasons.push("UNSUPPORTED_NETWORK");
    if (!worker.profile.adapters.includes(specification.adapter)) reasons.push("UNSUPPORTED_ADAPTER");
    return { runtimeEligible: reasons.length === 0, ...worker.profile.retainedCapabilities, reasons };
  }

  private transition(workerId: string, state: WorkerState): WorkerRecord {
    const current = this.require(workerId);
    if (current.state === "revoked") throw new Error("WORKER_REVOKED");
    const worker = { ...current, state, fence: current.fence + 1 };
    this.workers.set(workerId, worker);
    return copy(worker);
  }

  private require(workerId: string): WorkerRecord {
    const worker = this.workers.get(workerId);
    if (!worker) throw new Error("WORKER_NOT_FOUND");
    return worker;
  }
}

export const networkEscapeTargets = ["dns", "ipv4", "ipv6", "host-gateway", "local-network", "metadata", "peer-service"] as const;
export type NetworkEscapeTarget = typeof networkEscapeTargets[number];
export type NativeLinuxConformanceProbe = {
  inspectIsolation(): Promise<boolean>;
  attemptNetwork(target: NetworkEscapeTarget): Promise<boolean>;
};

export async function runNativeLinuxConformance(probe: NativeLinuxConformanceProbe): Promise<{ conformant: boolean; failures: string[] }> {
  const failures: string[] = [];
  try {
    if (!await probe.inspectIsolation()) failures.push("ISOLATION_PROFILE_INVALID");
  } catch {
    failures.push("ISOLATION_PROFILE_INVALID");
  }
  for (const target of networkEscapeTargets) {
    try {
      if (await probe.attemptNetwork(target)) failures.push(`NETWORK_ESCAPE:${target}`);
    } catch {
      failures.push(`NETWORK_PROBE_FAILED:${target}`);
    }
  }
  return { conformant: failures.length === 0, failures };
}

function validity(registration: WorkerRegistration): void {
  if (timestamp(registration.validFrom) >= timestamp(registration.validUntil)) throw new Error("INVALID_VALIDITY_WINDOW");
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("INVALID_TIMESTAMP");
  return parsed;
}

function copy(worker: WorkerRecord): WorkerRecord {
  return { ...worker, profile: copyProfile(worker.profile) };
}

function copyProfile(profile: CapabilityProfile): CapabilityProfile {
  return { ...profile, networkModes: [...profile.networkModes], adapters: [...profile.adapters], retainedCapabilities: { ...profile.retainedCapabilities } };
}
