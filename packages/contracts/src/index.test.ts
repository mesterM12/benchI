import { describe, expect, it } from "vitest";
import { previewEvalSuite } from "./index.js";

const validSuite = `
kind: EvalSuite
schemaVersion: "1"
id: checkout
agents:
  - id: codex
  - id: claude
tasks:
  - id: cart
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
  it("produces canonical identity and deterministic Trial Matrix", () => {
    const result = previewEvalSuite(validSuite);

    expect(result).toEqual({
      ok: true,
      canonicalJson: '{"agents":[{"id":"codex"},{"id":"claude"}],"id":"checkout","kind":"EvalSuite","matrix":{"exclude":[{"agent":"claude","repetitionIndex":2,"scenarioVariant":"baseline","task":"cart"}],"include":[{"agent":"claude","repetitionIndex":2,"scenarioVariant":"baseline","task":"cart"}],"repetitions":2},"scenarioVariants":[{"id":"baseline"},{"id":"skills"}],"schemaVersion":"1","tasks":[{"id":"cart"}]}',
      contentIdentity: "sha256:6baa2332ad8e43758e72902c29cf67e5ba696c49d5db4c2056fb1feded9ff3c0",
      trials: [
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
  });

  it("applies implicit Baseline Variant", () => {
    const result = previewEvalSuite(`kind: EvalSuite\nschemaVersion: "1"\nid: one\nagents: [{id: a}]\ntasks: [{id: t}]\nmatrix: {repetitions: 1}\n`);
    expect(result.ok && result.trials[0]).toMatchObject({ scenarioVariantId: "baseline", repetitionIndex: 1 });
  });

  it.each([
    ["unknown field", validSuite + "surprise: true\n", [{ path: "/surprise", code: "UNKNOWN_FIELD" }]],
    ["duplicate cell", validSuite.replace("repetitionIndex: 2\n", "repetitionIndex: 1\n"), [{ path: "/matrix/include/0", code: "DUPLICATE_CELL" }]],
    ["invalid exclusion", validSuite.replace("agent: claude\n      task: cart", "agent: missing\n      task: cart"), [{ path: "/matrix/exclude/0/agent", code: "UNKNOWN_AGENT" }]],
    ["invalid inclusion", validSuite.replace(/(include:[\s\S]*repetitionIndex:) 2/, "$1 0"), [{ path: "/matrix/include/0/repetitionIndex", code: "INVALID_REPETITION_INDEX" }]],
    ["invalid selector list", `kind: EvalSuite\nschemaVersion: "1"\nid: bad\nagents: [{id: a}]\ntasks: [{id: t}]\nmatrix: {repetitions: 1, include: nope}\n`, [{ path: "/matrix/include", code: "INVALID_INCLUSIONS" }]],
    ["empty matrix", `kind: EvalSuite\nschemaVersion: "1"\nid: empty\nagents: [{id: a}]\ntasks: []\nmatrix: {repetitions: 1}\n`, [{ path: "/matrix", code: "EMPTY_MATRIX" }]]
  ])("reports stable diagnostics for %s", (_, yaml, diagnostics) => {
    const result = previewEvalSuite(yaml);
    expect(result).toMatchObject({ ok: false, diagnostics });
  });
});
