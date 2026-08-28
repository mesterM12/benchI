"use client";

import { useEffect, useState } from "react";
import { scoringCompleteness, type EvalRun } from "./model";

type RunSummary = Omit<EvalRun, "trials">;

export default function WorkflowPage() {
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [selected, setSelected] = useState<EvalRun>();
  const [message, setMessage] = useState("Loading authoritative Eval Runs.");

  async function loadRuns() {
    const response = await fetch("/api/v1/eval-runs");
    if (!response.ok) throw new Error("Could not load Eval Runs.");
    const { items } = await response.json() as { items: RunSummary[] };
    setRuns(items);
    if (!selected && items[0]) await loadRun(items[0].id);
  }

  async function loadRun(id: string) {
    const response = await fetch(`/api/v1/eval-runs/${encodeURIComponent(id)}`);
    if (!response.ok) throw new Error("Could not load Eval Run.");
    setSelected(await response.json() as EvalRun);
    setMessage("Authoritative state checked moments ago.");
  }

  useEffect(() => {
    void loadRuns().catch((error: Error) => setMessage(error.message));
  }, []);

  useEffect(() => {
    if (!selected || selected.state !== "Started") return;
    const timer = window.setInterval(() => void fetch(`/api/v1/eval-runs/${encodeURIComponent(selected.id)}/events?after=0`).then(() => loadRun(selected.id)).catch((error: Error) => setMessage(error.message)), 5_000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.state]);

  async function cancelTrial(trialId: string) {
    if (!selected) return;
    const response = await fetch(`/api/v1/eval-runs/${encodeURIComponent(selected.id)}/trials/${encodeURIComponent(trialId)}/cancel`, { method: "POST" });
    if (!response.ok) return setMessage("Could not cancel Eval Trial.");
    await loadRun(selected.id);
    setMessage(`Cancellation requested for Eval Trial ${trialId}. Other Eval Trials continue.`);
  }

  async function startRun() {
    if (!selected) return;
    const response = await fetch(`/api/v1/eval-runs/${encodeURIComponent(selected.id)}/start`, { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
    if (!response.ok) return setMessage("Could not start Eval Run.");
    await loadRun(selected.id);
  }

  const completeness = selected && scoringCompleteness(selected);
  return <main>
    <nav><strong>benchI</strong><a href="/">Define</a><span>Observe & compare</span><a href="/login">Account</a></nav>
    <div className="flow-shell">
      <header className="flow-title"><div><h1>Know what is true now.</h1><p>Monitor authoritative Eval Trial state and preserve evidence through execution.</p></div><button onClick={() => { if (selected) void loadRun(selected.id); }}>Refresh state</button></header>
      <ol className="steps" aria-label="Evaluation workflow"><li className="done">Define</li><li className="done">Validate</li><li className="active">Observe</li><li>Score</li><li>Compare</li></ol>
      <section className="run-layout">
        <aside className="run-list" aria-label="Eval Runs"><h2>Eval Runs</h2>{runs.map((run) => <button className={run.id === selected?.id ? "run-choice selected" : "run-choice"} key={run.id} onClick={() => void loadRun(run.id)}><span>{run.suiteRevisionId}</span><small>{run.id} · {run.state}</small></button>)}</aside>
        <div className="run-detail">{selected ? <><div className="detail-head"><div><h2>{selected.suiteRevisionId}</h2><p>{selected.id} · <span className={`status ${selected.state.toLowerCase()}`}>{selected.state}</span></p></div>{selected.state === "Ready" && <button onClick={() => void startRun()}>Start Eval Run</button>}</div>
          <output aria-live="polite">{message}</output>
          <div className="comparison" aria-label="Scoring comparison"><dl><div><dt>Scoring Completeness</dt><dd>{completeness!.completed} of {completeness!.required}</dd></div><div><dt>Result status</dt><dd className={completeness!.completed < completeness!.required ? "provisional" : "final"}>{completeness!.completed < completeness!.required ? "Provisional" : "Final"}</dd></div></dl>{completeness!.completed < completeness!.required && <p className="provisional-note"><strong>Provisional result.</strong> Required Eval Trials have not all completed.</p>}</div>
          <div className="trial-table"><h3>Eval Trial state</h3><div role="table" aria-label="Eval Trials">{selected.trials.map((trial) => <div className="trial-row" role="row" key={trial.id}><div role="cell"><strong>{trial.id}</strong><small>{trial.attemptCount} attempt(s)</small></div><span role="cell" className={`status ${trial.state}`}>{trial.state}</span><div role="cell">{(trial.state === "running" || trial.state === "queued") && <button className="text-button" onClick={() => void cancelTrial(trial.id)}>Cancel this trial</button>}</div></div>)}</div></div>
        </> : <output aria-live="polite">{message}</output>}</div>
      </section>
    </div>
  </main>;
}
