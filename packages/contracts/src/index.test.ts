import { describe, expect, it } from "vitest";
import { previewEvalSuite } from "./index.js";

const validSuite = `
kind: EvalSuite
schemaVersion: "1"
id: checkout
sources: [{id: app, git: {remote: x, ref: main}}]
agents:
  - {id: codex, adapter: opencode, model: openai/gpt-5}
  - {id: claude, adapter: opencode, model: anthropic/claude}
tasks:
  - {id: cart, source: app, prompt: Fix., acceptance: {command: test}}
execution: {timeoutSeconds: 60}
scenarioVariants:
  - id: baseline
  - id: skills
matrix:
  repetitions: 2
  exclude:
    - agent: claude
      task: cart
      scenarioVariant: baseline
      repetitionIndex: 2
  include:
    - agent: claude
      task: cart
      scenarioVariant: baseline
      repetitionIndex: 2
`;

describe("previewEvalSuite", () => {
  it("accepts a strict Git-backed OpenCode Eval Suite", () => {
    const result = previewEvalSuite(`kind: EvalSuite
schemaVersion: "1"
id: checkout
sources:
  - id: app
    git: {remote: https://example.test/app.git, ref: main}
agents:
  - id: opencode
    adapter: opencode
    model: openai/gpt-5
    options: {reasoningEffort: high}
tasks:
  - id: cart
    source: app
    prompt: Fix checkout.
    acceptance: {command: pnpm test}
execution: {timeoutSeconds: 900}
matrix: {repetitions: 1}
`);

    expect(result).toMatchObject({ ok: true, trials: [{ id: "opencode__cart__baseline__1" }] });
  });

  it("produces canonical identity and deterministic Trial Matrix", () => {
    const result = previewEvalSuite(validSuite);

    expect(result).toMatchObject({
      ok: true, trials: [
        { id: "codex__cart__baseline__1", agentId: "codex", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 1 },
        { id: "codex__cart__baseline__2", agentId: "codex", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 2 },
        { id: "codex__cart__skills__1", agentId: "codex", taskId: "cart", scenarioVariantId: "skills", repetitionIndex: 1 },
        { id: "codex__cart__skills__2", agentId: "codex", taskId: "cart", scenarioVariantId: "skills", repetitionIndex: 2 },
        { id: "claude__cart__baseline__1", agentId: "claude", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 1 },
        { id: "claude__cart__skills__1", agentId: "claude", taskId: "cart", scenarioVariantId: "skills", repetitionIndex: 1 },
        { id: "claude__cart__skills__2", agentId: "claude", taskId: "cart", scenarioVariantId: "skills", repetitionIndex: 2 },
        { id: "claude__cart__baseline__2", agentId: "claude", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 2 }
      ]
    });
    expect(result.ok && result.contentIdentity).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(previewEvalSuite(validSuite)).toEqual(result);
  });

  it("applies implicit Baseline Variant", () => {
    const result = previewEvalSuite(`kind: EvalSuite\nschemaVersion: "1"\nid: one\nsources: [{id: s, git: {remote: x, ref: main}}]\nagents: [{id: a, adapter: opencode, model: m}]\ntasks: [{id: t, source: s, prompt: p, acceptance: {command: c}}]\nexecution: {timeoutSeconds: 1}\nmatrix: {repetitions: 1}\n`);
    expect(result.ok && result.trials[0]).toMatchObject({ scenarioVariantId: "baseline", repetitionIndex: 1 });
  });

  it("expands Submission Slots as deterministic Trial Matrix participants", () => {
    const result = previewEvalSuite(`kind: EvalSuite
schemaVersion: "1"
id: submitted
sources: [{id: source, git: {remote: x, ref: main}}]
agents: [{id: agent, adapter: opencode, model: m}]
submissionSlots: [{id: external}]
tasks: [{id: task, source: source, prompt: p, acceptance: {command: c}}]
execution: {timeoutSeconds: 1}
matrix:
  repetitions: 2
  exclude: [{submissionSlot: external, task: task, scenarioVariant: baseline, repetitionIndex: 2}]
`);

    expect(result.ok && result.trials).toEqual([
      { id: "agent__task__baseline__1", agentId: "agent", taskId: "task", scenarioVariantId: "baseline", repetitionIndex: 1 },
      { id: "agent__task__baseline__2", agentId: "agent", taskId: "task", scenarioVariantId: "baseline", repetitionIndex: 2 },
      { id: "external__task__baseline__1", submissionSlotId: "external", taskId: "task", scenarioVariantId: "baseline", repetitionIndex: 1 }
    ]);
  });

  it.each([
    ["unknown field", validSuite + "surprise: true\n", [{ path: "/surprise", code: "UNKNOWN_FIELD" }]],
    ["duplicate cell", validSuite.replace("repetitionIndex: 2\n", "repetitionIndex: 1\n"), [{ path: "/matrix/include/0", code: "DUPLICATE_CELL" }]],
    ["invalid exclusion", validSuite.replace("agent: claude\n      task: cart", "agent: missing\n      task: cart"), [{ path: "/matrix/exclude/0/agent", code: "UNKNOWN_AGENT" }]],
    ["invalid inclusion", validSuite.replace(/(include:[\s\S]*repetitionIndex:) 2/, "$1 0"), [{ path: "/matrix/include/0/repetitionIndex", code: "INVALID_REPETITION_INDEX" }]],
    ["invalid selector list", `kind: EvalSuite\nschemaVersion: "1"\nid: bad\nsources: [{id: s, git: {remote: x, ref: main}}]\nagents: [{id: a, adapter: opencode, model: m}]\ntasks: [{id: t, source: s, prompt: p, acceptance: {command: c}}]\nexecution: {timeoutSeconds: 1}\nmatrix: {repetitions: 1, include: nope}\n`, [{ path: "/matrix/include", code: "INVALID_INCLUSIONS" }]],
    ["empty matrix", `kind: EvalSuite\nschemaVersion: "1"\nid: empty\nsources: [{id: s, git: {remote: x, ref: main}}]\nagents: [{id: a, adapter: opencode, model: m}]\ntasks: []\nexecution: {timeoutSeconds: 1}\nmatrix: {repetitions: 1}\n`, [{ path: "/matrix", code: "EMPTY_MATRIX" }]]
  ])("reports stable diagnostics for %s", (_, yaml, diagnostics) => {
    const result = previewEvalSuite(yaml);
    expect(result).toMatchObject({ ok: false, diagnostics });
  });

  it.each([
    ["unknown Git field", "/sources/0/git/tag", "UNKNOWN_FIELD", "sources: [{id: app, git: {remote: x, ref: main, tag: nope}}]"],
    ["missing Git ref", "/sources/0/git/ref", "INVALID_GIT_REF", "sources: [{id: app, git: {remote: x}}]"],
    ["unknown task source", "/tasks/0/source", "UNKNOWN_SOURCE", "tasks: [{id: task, source: missing, prompt: 'Fix.', acceptance: {command: test}}]"],
    ["missing acceptance command", "/tasks/0/acceptance/command", "INVALID_ACCEPTANCE_COMMAND", "tasks: [{id: task, source: app, prompt: 'Fix.', acceptance: {}}]"],
    ["missing OpenCode model", "/agents/0/model", "INVALID_MODEL", "agents: [{id: agent, adapter: opencode}]"],
    ["invalid timeout", "/execution/timeoutSeconds", "INVALID_TIMEOUT_SECONDS", "execution: {timeoutSeconds: 0}"],
    ["unsupported OpenCode option", "/agents/0/options/surprise", "UNKNOWN_FIELD", "agents: [{id: agent, adapter: opencode, model: openai/gpt-5, options: {surprise: true}}]"],
    ["unsupported reasoning effort", "/agents/0/options/reasoningEffort", "INVALID_REASONING_EFFORT", "agents: [{id: agent, adapter: opencode, model: openai/gpt-5, options: {reasoningEffort: huge}}]"],
  ])("reports stable diagnostics for %s", (_, path, code, replacement) => {
    const source = `kind: EvalSuite\nschemaVersion: "1"\nid: strict\nagents: [{id: agent, adapter: opencode, model: openai/gpt-5}]\nsources: [{id: app, git: {remote: x, ref: main}}]\ntasks: [{id: task, source: app, prompt: Fix., acceptance: {command: test}}]\nexecution: {timeoutSeconds: 60}\nmatrix: {repetitions: 1}\n`;
    const keys = replacement.startsWith("agents:") ? ["agents"] : replacement.startsWith("tasks:") ? ["tasks"] : replacement.startsWith("execution:") ? ["execution"] : ["sources"];
    const changed = source.split("\n").filter((line) => !keys.some((key) => line.startsWith(`${key}:`))).join("\n") + `\n${replacement}\n`;
    expect(previewEvalSuite(changed)).toEqual({ ok: false, diagnostics: [{ path, code }] });
  });

  it.each([
    ["sources", "/sources", "REQUIRED_SOURCES"],
    ["agents", "/agents", "REQUIRED_AGENTS"],
    ["tasks", "/tasks", "REQUIRED_TASKS"],
    ["execution", "/execution", "REQUIRED_EXECUTION"],
  ])("requires %s", (_, field, code) => {
    const source = `kind: EvalSuite\nschemaVersion: "1"\nid: strict\nsources: [{id: app, git: {remote: x, ref: main}}]\nagents: [{id: agent, adapter: opencode, model: openai/gpt-5}]\ntasks: [{id: task, source: app, prompt: Fix., acceptance: {command: test}}]\nexecution: {timeoutSeconds: 60}\nmatrix: {repetitions: 1}\n`;
    expect(previewEvalSuite(source.split("\n").filter((line) => !line.startsWith(`${field.slice(1)}:`)).join("\n"))).toEqual({ ok: false, diagnostics: [{ path: field, code }] });
  });
});
