import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
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
  acceptance: { command: string; exitCode: number; stdout: string; stderr: string } | null;
  branch: string;
  preservedWorktreePath: string | null;
  workspaceDiff: string | null;
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
  secretEnvironment?: Record<string, string>;
  signal?: AbortSignal;
  acceptanceCommand?: string;
  now?: () => Date;
};

export async function runOpenCodeTrial(input: OpenCodeTrialInput): Promise<OpenCodeTrialResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(input.attemptId)) throw new Error("INVALID_ATTEMPT_ID");
  const now = input.now ?? (() => new Date());
  const started = now();
  const events: OpenCodeTrialEvent[] = [];
  const options: OpenCodeOptions = { variant: input.variant, agent: input.agent, env: { ...input.env, ...input.secretEnvironment } };
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
      acceptance: null,
      branch,
      preservedWorktreePath: null,
      workspaceDiff: null,
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
  let baseline: string | null = null;
  try {
    baseline = await revision(worktree.worktreePath);
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
    let acceptance: OpenCodeTrialResult["acceptance"] = null;
    if (input.acceptanceCommand) {
      const sandbox = await worktree.createSandbox({ sandbox: input.sandbox });
      try {
        const executed = await sandbox.exec(input.acceptanceCommand);
        acceptance = { command: input.acceptanceCommand, exitCode: executed.exitCode, stdout: executed.stdout, stderr: executed.stderr };
      } finally {
        await sandbox.close();
      }
    }
    const workspaceDiff = await captureWorkspaceDiff(worktree.worktreePath, baseline);
    const close = await worktree.close();
    return redactTrialResult(evidence(input, started, now(), events, worktree, {
      status: "completed",
      error: null,
      completionSignal: result.completionSignal ?? null,
      stdout: result.stdout,
      commits: result.commits.map(({ sha }) => sha),
      acceptance,
      iterations: result.iterations.length,
      logFilePath: result.logFilePath ?? null,
      preservedWorktreePath: close.preservedWorktreePath ?? null,
      workspaceDiff
    }), input.secretEnvironment);
  } catch (error) {
    const workspaceDiff = await captureWorkspaceDiff(worktree.worktreePath, baseline);
    let preservedWorktreePath: string | null;
    try {
      preservedWorktreePath = (await worktree.close()).preservedWorktreePath ?? null;
    } catch {
      preservedWorktreePath = worktree.worktreePath;
    }
    return redactTrialResult(evidence(input, started, now(), events, worktree, {
      status: input.signal?.aborted ? "cancelled" : "failed",
      error: errorDetails(error),
      completionSignal: null,
      stdout: null,
      commits: [],
      acceptance: null,
      iterations: 0,
      logFilePath: null,
      preservedWorktreePath,
      workspaceDiff
    }), input.secretEnvironment);
  }
}

export type ExecutionEvidence = { path: string; bytes: Buffer };
export type FrozenOpenCodeExecution = {
  classification: "EvaluationOutcome" | "InfrastructureFailure";
  result: { outcome: "passed" | "failed"; execution: OpenCodeTrialResult; diagnostics: string[] };
  runtimeEnvironment: { schemaVersion: "1"; adapter: string; observedAt: string };
  evidence: ExecutionEvidence[];
};

export async function executeFrozenOpenCodeTrial(input: { attemptId: string; remote: string; commit: string; sourceArchive: Buffer; prompt: string; acceptanceCommand: string; model: string; secretEnvironment?: Record<string, string> }): Promise<FrozenOpenCodeExecution> {
  const repositoryPath = await mkdtemp(join(tmpdir(), "benchi-trial-"));
  try {
    const archivePath = join(repositoryPath, "source.tar");
    await writeFile(archivePath, input.sourceArchive);
    await promisify(execFile)("tar", ["-xf", archivePath], { cwd: repositoryPath });
    await rm(archivePath);
    await promisify(execFile)("git", ["-C", repositoryPath, "init"]);
    await promisify(execFile)("git", ["-C", repositoryPath, "config", "user.email", "benchi@localhost"]);
    await promisify(execFile)("git", ["-C", repositoryPath, "config", "user.name", "benchI"]);
    await promisify(execFile)("git", ["-C", repositoryPath, "add", "."]);
    await promisify(execFile)("git", ["-C", repositoryPath, "commit", "-m", "Frozen source"]);
    const result = await runOpenCodeTrial({
      attemptId: input.attemptId,
      repositoryPath,
      prompt: `${input.prompt}\nRun ${input.acceptanceCommand}, fix failures, rerun it, and commit the completed work.`,
      model: input.model,
      sandbox: noSandbox(),
      acceptanceCommand: input.acceptanceCommand,
      secretEnvironment: input.secretEnvironment
    });
    const evidence: ExecutionEvidence[] = [{ path: "sandcastle-result.json", bytes: Buffer.from(JSON.stringify(result)) }];
    if (result.workspaceDiff !== null) evidence.push({ path: "workspace.patch", bytes: Buffer.from(result.workspaceDiff) });
    const finalCommit = result.commits.at(-1);
    if (finalCommit) {
      const archive = await promisify(execFile)("git", ["-C", repositoryPath, "archive", "--format=tar", finalCommit], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
      evidence.push({ path: "mutated-repository.tar", bytes: archive.stdout });
    }
    if (result.runtime.logFilePath) {
      try { evidence.push({ path: "sandcastle.log", bytes: await readFile(result.runtime.logFilePath) }); } catch {}
    }
    if (result.preservedWorktreePath) {
      try {
        const diff = await promisify(execFile)("git", ["-C", result.preservedWorktreePath, "diff", "--binary"], { encoding: "buffer", maxBuffer: 1024 * 1024 * 1024 });
        evidence.push({ path: "failed-worktree.patch", bytes: diff.stdout });
      } catch {}
    }
    const passed = result.status === "completed" && result.acceptance?.exitCode === 0;
    const diagnostics = result.status !== "completed"
      ? [result.error?.message ?? `Sandcastle execution ${result.status}`]
      : result.acceptance ? (passed ? [] : [`Acceptance exited ${result.acceptance.exitCode}`]) : ["Acceptance was not executed"];
    return {
      classification: result.status === "completed" ? "EvaluationOutcome" : "InfrastructureFailure",
      result: { outcome: passed ? "passed" : "failed", execution: result, diagnostics },
      runtimeEnvironment: { schemaVersion: "1", adapter: result.runtime.adapter, observedAt: result.runtime.finishedAt },
      evidence: redactEvidence(evidence, input.secretEnvironment)
    };
  } finally {
    await rm(repositoryPath, { recursive: true, force: true });
  }
}

type Evidence = {
  status: OpenCodeTrialResult["status"];
  error: OpenCodeTrialResult["error"];
  completionSignal: string | null;
  stdout: string | null;
  commits: string[];
  acceptance: OpenCodeTrialResult["acceptance"];
  iterations: number;
  logFilePath: string | null;
  preservedWorktreePath: string | null;
  workspaceDiff: string | null;
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
    acceptance: value.acceptance,
    branch: worktree.branch,
    preservedWorktreePath: value.preservedWorktreePath,
    workspaceDiff: value.workspaceDiff,
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

async function revision(repositoryPath: string): Promise<string | null> {
  try {
    return (await promisify(execFile)("git", ["-C", repositoryPath, "rev-parse", "HEAD"])).stdout.trim();
  } catch {
    return null;
  }
}

async function captureWorkspaceDiff(repositoryPath: string, baseline: string | null): Promise<string | null> {
  try {
    return (await promisify(execFile)("git", ["-C", repositoryPath, "diff", "--binary", baseline ?? "HEAD"], { maxBuffer: 1024 * 1024 * 1024 })).stdout;
  } catch {
    return null;
  }
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

function redactTrialResult(result: OpenCodeTrialResult, environment: Record<string, string> | undefined): OpenCodeTrialResult {
  const secrets = Object.values(environment ?? {}).filter(Boolean);
  if (secrets.length === 0) return result;
  const redact = (value: string | null) => value === null ? null : secrets.reduce((text, secret) => text.replaceAll(secret, "[REDACTED]"), value);
  return {
    ...result,
    events: result.events.map((event) => event.type === "text" ? { ...event, message: redact(event.message)! } : event.type === "toolCall" ? { ...event, formattedArgs: redact(event.formattedArgs)! } : { ...event, line: redact(event.line)! }),
    output: { ...result.output, stdout: { ...result.output.stdout, text: redact(result.output.stdout.text) } },
    acceptance: result.acceptance && { ...result.acceptance, stdout: redact(result.acceptance.stdout)!, stderr: redact(result.acceptance.stderr)! },
    workspaceDiff: redact(result.workspaceDiff)
  };
}

function redactEvidence(evidence: ExecutionEvidence[], environment: Record<string, string> | undefined): ExecutionEvidence[] {
  const secrets = Object.values(environment ?? {}).filter(Boolean).map((value) => Buffer.from(value));
  if (secrets.length === 0) return evidence;
  return evidence.flatMap(({ path, bytes }) => {
    if (!secrets.some((secret) => bytes.includes(secret))) return [{ path, bytes }];
    // Binary repository evidence cannot be safely rewritten; do not retain a disclosure.
    if (path.endsWith(".tar")) return [];
    let redacted = bytes;
    for (const secret of secrets) redacted = Buffer.from(redacted.toString().replaceAll(secret.toString(), "[REDACTED]"));
    return [{ path, bytes: redacted }];
  });
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

export const networkEscapeTargets = [
  "dns", "ipv4", "ipv6", "host-gateway", "local-network", "metadata", "peer-service",
  "mount", "daemon-credential", "secret", "process", "capability"
] as const;
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
