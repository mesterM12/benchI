"use client";

import { useState } from "react";
import { applyAuthoritativeState, createFollowUp, initialRuns, type EvalRun } from "./model";

export default function WorkflowPage() {
  const [runs, setRuns] = useState(initialRuns);
  const [selectedId, setSelectedId] = useState(initialRuns[0].id);
  const [message, setMessage] = useState("Live events connected. Authoritative state checked moments ago.");
  const selected = runs.find((run) => run.id === selectedId) ?? runs[0];

  function cancelTrial(trialId: string) {
    setRuns((current) => current.map((run) => run.id === selected.id
      ? applyAuthoritativeState(run, { state: run.state, trials: [{ id: trialId, state: "Cancelled" }] })
      : run));
    setMessage(`Cancellation requested for Eval Trial ${trialId}. Other Eval Trials continue.`);
  }

  function followUp(action: "rerun" | "rescore") {
    const next = createFollowUp(selected, action);
    setRuns((current) => [...current, next]);
    setSelectedId(next.id);
    setMessage(`New ${action} Eval Run created from ${selected.id}. Prior evidence remains unchanged.`);
  }

  return <main>
    <nav><strong>benchI</strong><a href="/">Define</a><span>Observe & compare</span><a href="/login">Account</a></nav>
    <div className="flow-shell">
      <header className="flow-title"><div><h1>Know what is true now.</h1><p>Monitor authoritative Eval Trial state, judge scoring completeness, then preserve evidence through every follow-up.</p></div><button onClick={() => setMessage("Authoritative state checked moments ago. Live event order reconciled.")}>Refresh state</button></header>
      <ol className="steps" aria-label="Evaluation workflow"><li className="done">Define</li><li className="done">Validate</li><li className="active">Observe</li><li>Score</li><li>Compare</li></ol>
      <section className="run-layout">
        <aside className="run-list" aria-label="Eval Runs"><h2>Eval Runs</h2>{runs.map((run) => <button className={run.id === selected.id ? "run-choice selected" : "run-choice"} key={run.id} onClick={() => setSelectedId(run.id)}><span>{run.name}</span><small>{run.variant} · {run.state}</small></button>)}</aside>
        <div className="run-detail">
          <div className="detail-head"><div><h2>{selected.name}</h2><p>{selected.variant} · <span className={`status ${selected.state.toLowerCase()}`}>{selected.state}</span></p>{selected.lineage && <p className="lineage">Created by {selected.lineage.action} from <button onClick={() => setSelectedId(selected.lineage!.parentRunId)}>{selected.lineage.parentRunId}</button></p>}</div><div className="follow-actions"><button className="secondary" onClick={() => followUp("rescore")}>Rescore evidence</button><button onClick={() => followUp("rerun")}>Rerun suite</button></div></div>
          <output aria-live="polite">{message}</output>
          <div className="comparison" aria-label="Scoring comparison">
            <dl><div><dt>Aggregate Score</dt><dd>{selected.aggregateScore ?? "Not scored"}</dd></div><div><dt>Scoring Completeness</dt><dd>{selected.completeness.completed} of {selected.completeness.required}</dd></div><div><dt>Reliability</dt><dd>{selected.reliability}</dd></div><div><dt>Result status</dt><dd className={selected.completeness.completed < selected.completeness.required ? "provisional" : "final"}>{selected.completeness.completed < selected.completeness.required ? "Provisional" : "Final"}</dd></div></dl>
            {selected.completeness.completed < selected.completeness.required && <p className="provisional-note"><strong>Provisional result.</strong> Aggregate Score may change until all required scoring completes.</p>}
          </div>
          <div className="trial-table"><h3>Eval Trial state</h3><div role="table" aria-label="Eval Trials">{selected.trials.map((trial) => <div className="trial-row" role="row" key={trial.id}><div role="cell"><strong>{trial.label}</strong><small>{trial.id}</small></div><span role="cell" className={`status ${trial.state.toLowerCase()}`}>{trial.state}</span><div role="cell">{(trial.state === "Running" || trial.state === "Queued") && <button className="text-button" onClick={() => cancelTrial(trial.id)}>Cancel this trial</button>}</div></div>)}</div></div>
        </div>
      </section>
    </div>
  </main>;
}
