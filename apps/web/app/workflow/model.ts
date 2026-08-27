export type TrialState = "Queued" | "Running" | "Scored" | "Failed" | "Cancelled";
export type EvalRun = {
  id: string;
  name: string;
  variant: string;
  state: "Ready" | "Running" | "Complete" | "Cancelled";
  aggregateScore: string | null;
  completeness: { completed: number; required: number };
  reliability: "High" | "Medium" | "Low";
  trials: Array<{ id: string; label: string; state: TrialState }>;
  lineage?: { parentRunId: string; action: "rerun" | "rescore" };
};

export const initialRuns: EvalRun[] = [
  {
    id: "eval-run-42", name: "Authentication matrix", variant: "OAuth refresh enabled", state: "Running",
    aggregateScore: "0.84", completeness: { completed: 2, required: 3 }, reliability: "Medium",
    trials: [
      { id: "auth-login", label: "Login flow", state: "Scored" },
      { id: "auth-refresh", label: "Token refresh", state: "Running" },
      { id: "auth-expiry", label: "Expired session", state: "Queued" }
    ]
  },
  {
    id: "submitted-17", name: "Submitted Trial comparison", variant: "External agent output", state: "Complete",
    aggregateScore: "0.79", completeness: { completed: 3, required: 3 }, reliability: "High",
    trials: [
      { id: "submitted-login", label: "Login flow", state: "Scored" },
      { id: "submitted-refresh", label: "Token refresh", state: "Scored" },
      { id: "submitted-expiry", label: "Expired session", state: "Scored" }
    ]
  }
];

export function applyAuthoritativeState(run: EvalRun, snapshot: Pick<EvalRun, "state"> & { trials: Array<Pick<EvalRun["trials"][number], "id" | "state">> }): EvalRun {
  const states = new Map(snapshot.trials.map((trial) => [trial.id, trial.state]));
  return { ...run, state: snapshot.state, trials: run.trials.map((trial) => ({ ...trial, state: states.get(trial.id) ?? trial.state })) };
}

export function createFollowUp(source: EvalRun, action: "rerun" | "rescore"): EvalRun {
  return {
    ...source,
    id: `${source.id}-${action}-${Date.now()}`,
    name: `${source.name} ${action === "rerun" ? "rerun" : "rescore"}`,
    state: "Ready",
    aggregateScore: null,
    completeness: { completed: 0, required: source.completeness.required },
    reliability: "Low",
    trials: source.trials.map((trial) => ({ ...trial, state: "Queued" })),
    lineage: { parentRunId: source.id, action }
  };
}
