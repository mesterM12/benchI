import { describe, expect, it } from "vitest";
import { scoringCompleteness, type EvalRun } from "./model";

describe("Member workflow", () => {
  it("marks results provisional until every Eval Trial reaches a terminal state", () => {
    const run: EvalRun = { id: "run-1", suiteRevisionId: "suite@1", frozenAt: "2026-08-28", state: "Started", trials: [
      { id: "done", state: "completed", attemptCount: 1 }, { id: "active", state: "running", attemptCount: 0 }
    ] };

    expect(scoringCompleteness(run)).toEqual({ completed: 1, required: 2 });
  });
});
