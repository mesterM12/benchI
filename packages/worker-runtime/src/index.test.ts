import { describe, expect, it } from "vitest";
import {
  WorkerRuntime,
  runNativeLinuxConformance,
  type CapabilityProfile,
  type ExecutionEnvironmentSpecification
} from "./index.js";

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
