export type TrialState = "queued" | "running" | "completed" | "failed" | "cancelled";
export type EvalRun = {
  id: string;
  suiteRevisionId: string;
  frozenAt: string;
  state: "Ready" | "Started" | "Cancelled";
  trials: Array<{ id: string; state: TrialState; attemptCount: number }>;
};

export function scoringCompleteness(run: EvalRun) {
  return { completed: run.trials.filter(({ state }) => state === "completed" || state === "failed" || state === "cancelled").length, required: run.trials.length };
}
