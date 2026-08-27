"use client";

import { useState, useTransition } from "react";

const initial = `kind: EvalSuite
schemaVersion: "1"
id: first-suite
agents:
  - id: coding-agent
tasks:
  - id: task
matrix:
  repetitions: 1
`;

export default function DefinePage() {
  const [source, setSource] = useState(initial);
  const [message, setMessage] = useState("Ready to validate.");
  const [suiteId, setSuiteId] = useState<string>();
  const [revision, setRevision] = useState<number>();
  const [pending, startTransition] = useTransition();

  function submit(action: "validate" | "save") {
    startTransition(async () => {
      const endpoint = action === "validate" ? "/api/v1/eval-suites/validate" : suiteId ? `/api/v1/eval-suites/${encodeURIComponent(suiteId)}` : "/api/v1/eval-suites";
      const response = await fetch(endpoint, { method: action === "save" && suiteId ? "PUT" : "POST", headers: { "Content-Type": "application/json", ...(action === "save" ? { "Idempotency-Key": crypto.randomUUID(), ...(revision ? { "If-Match": `\"${revision}\"` } : {}) } : {}) }, body: JSON.stringify({ source }) });
      const result = await response.json();
      if (!response.ok) return setMessage(result.code === "UNAUTHENTICATED" ? "Sign in with a local Member or Admin account, then retry." : result.diagnostics?.map((item: { path: string; code: string }) => `${item.path} ${item.code}`).join(" · ") ?? result.code);
      if (action === "validate") setMessage(result.ok ? `${result.trials.length} Eval Trial(s). Suite is valid.` : result.diagnostics.map((item: { path: string; code: string }) => `${item.path} ${item.code}`).join(" · "));
      else { setSuiteId(result.id); setRevision(result.revision); setMessage(`Saved immutable revision ${result.revision}.`); }
    });
  }

  return <main>
    <nav><strong>benchI</strong><span>Define</span><a href="/login">Account</a></nav>
    <section className="intro"><h1>Shape an evaluation before it runs.</h1><p>Author canonical YAML, inspect exact validation decisions, then preserve each revision.</p></section>
    <section className="workspace">
      <div className="editor-head"><div><h2>Eval Suite</h2><p>{revision ? `Current revision ${revision}` : "Unsaved draft"}</p></div><div className="actions"><button className="secondary" disabled={pending} onClick={() => submit("validate")}>Validate</button><button disabled={pending} onClick={() => submit("save")}>{pending ? "Working…" : "Save revision"}</button></div></div>
      <label htmlFor="source">Canonical YAML</label>
      <textarea id="source" spellCheck={false} value={source} onChange={(event) => setSource(event.target.value)} />
      <output aria-live="polite">{message}</output>
    </section>
  </main>;
}
