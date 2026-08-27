import { describe, expect, it } from "vitest";
import { applyAuthoritativeState, createFollowUp, initialRuns } from "./model";

describe("Member workflow", () => {
  it("reconciles live events with authoritative Eval Trial state", () => {
    const run = applyAuthoritativeState(initialRuns[0], {
      state: "Running",
      trials: [{ id: "auth-login", state: "Scored" }, { id: "auth-refresh", state: "Running" }, { id: "auth-expiry", state: "Queued" }]
    });

    expect(run.trials.map(({ state }) => state)).toEqual(["Scored", "Running", "Queued"]);
  });

  it("cancels only selected active Eval Trials", () => {
    const run = applyAuthoritativeState(initialRuns[0], {
      state: "Running",
      trials: [{ id: "auth-refresh", state: "Cancelled" }]
    });

    expect(run.trials.find(({ id }) => id === "auth-refresh")?.state).toBe("Cancelled");
    expect(run.trials.find(({ id }) => id === "auth-expiry")?.state).toBe("Queued");
  });

  it.each(["rerun", "rescore"] as const)("creates lineage-linked %s Eval Runs without replacing evidence", (action) => {
    const source = initialRuns[1];
    const followUp = createFollowUp(source, action);

    expect(followUp.id).not.toBe(source.id);
    expect(followUp.lineage).toEqual({ parentRunId: source.id, action });
    expect(source.state).toBe("Complete");
  });
});
