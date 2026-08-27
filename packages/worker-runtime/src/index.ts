import { join } from "node:path";
import {
  opencode,
  run as runSandcastle,
  type AgentStreamEvent,
  type OpenCodeOptions,
  type SandboxProvider
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
  status: "completed";
  completionSignal: string | null;
  events: OpenCodeTrialEvent[];
  stdout: string;
  stderr: null;
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
    stderrCapture: "not-exposed-by-sandcastle";
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
  const result = await runSandcastle({
    agent: opencode(input.model, options),
    sandbox: input.sandbox,
    cwd: input.repositoryPath,
    prompt: input.prompt,
    maxIterations: 1,
    branchStrategy: { type: "branch", branch: `benchi/${input.attemptId}` },
    logging: {
      type: "file",
      path: join(input.repositoryPath, ".sandcastle", "logs", `${input.attemptId}.log`),
      verbose: false,
      onAgentStreamEvent: (event) => events.push(normalizeAgentEvent(event))
    },
    signal: input.signal
  });
  const finished = now();
  return {
    status: "completed",
    completionSignal: result.completionSignal ?? null,
    events,
    stdout: result.stdout,
    stderr: null,
    commits: result.commits.map(({ sha }) => sha),
    branch: result.branch,
    preservedWorktreePath: result.preservedWorktreePath ?? null,
    runtime: {
      adapter: "sandcastle/opencode",
      model: input.model,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      iterations: result.iterations.length,
      logFilePath: result.logFilePath ?? null,
      stderrCapture: "not-exposed-by-sandcastle"
    }
  };
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
