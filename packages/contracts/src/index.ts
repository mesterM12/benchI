import { createHash } from "node:crypto";
import { parse } from "yaml";

export type Diagnostic = { path: string; code: string };
type TrialCell = {
  id: string;
  taskId: string;
  scenarioVariantId: string;
  repetitionIndex: number;
};
export type Trial = TrialCell & ({ agentId: string; submissionSlotId?: never } | { agentId?: never; submissionSlotId: string });
export type PreviewResult =
  | { ok: true; canonicalJson: string; contentIdentity: string; trials: Trial[] }
  | { ok: false; diagnostics: Diagnostic[] };

type Item = { id: string; [key: string]: unknown };
type Selector = { agent?: string; submissionSlot?: string; task: string; scenarioVariant: string; repetitionIndex: number };
type Suite = {
  kind: "EvalSuite";
  schemaVersion: "1";
  id: string;
  sources?: Array<{ id: string; git: { remote: string; ref: string } }>;
  agents: Item[];
  submissionSlots?: Item[];
  tasks: Array<Item & { source?: string; prompt?: string; acceptance?: { command?: string } }>;
  execution?: { timeoutSeconds: number };
  scenarioVariants?: Item[];
  matrix: { repetitions: number; include?: Selector[]; exclude?: Selector[] };
};

const fields = {
  root: new Set(["kind", "schemaVersion", "id", "sources", "agents", "submissionSlots", "tasks", "scenarioVariants", "execution", "matrix"]),
  item: new Set(["id"]),
  source: new Set(["id", "git"]),
  git: new Set(["remote", "ref"]),
  agent: new Set(["id", "adapter", "model", "options"]),
  task: new Set(["id", "source", "prompt", "acceptance"]),
  acceptance: new Set(["command"]),
  execution: new Set(["timeoutSeconds"]),
  matrix: new Set(["repetitions", "include", "exclude"]),
  selector: new Set(["agent", "submissionSlot", "task", "scenarioVariant", "repetitionIndex"])
};

export function previewEvalSuite(source: string): PreviewResult {
  let value: unknown;
  try {
    value = parse(source, { uniqueKeys: true });
  } catch {
    return invalid("/", "INVALID_YAML");
  }
  if (!record(value)) return invalid("/", "INVALID_DOCUMENT");

  const diagnostics: Diagnostic[] = [];
  unknownFields(value, fields.root, "", diagnostics);
  for (const [name, allowed] of [["agents", fields.agent], ["submissionSlots", fields.item], ["tasks", fields.task], ["scenarioVariants", fields.item], ["sources", fields.source]] as const) {
    if (Array.isArray(value[name])) value[name].forEach((item, index) => unknownFields(item, allowed, `/${name}/${index}`, diagnostics));
  }
  if (Array.isArray(value.sources)) value.sources.forEach((source, index) => {
    if (record(source)) unknownFields(source.git, fields.git, `/sources/${index}/git`, diagnostics);
  });
  if (Array.isArray(value.tasks)) value.tasks.forEach((task, index) => {
    if (record(task)) unknownFields(task.acceptance, fields.acceptance, `/tasks/${index}/acceptance`, diagnostics);
  });
  unknownFields(value.execution, fields.execution, "/execution", diagnostics);
  if (record(value.matrix)) {
    unknownFields(value.matrix, fields.matrix, "/matrix", diagnostics);
    for (const name of ["include", "exclude"] as const) {
      if (Array.isArray(value.matrix[name])) value.matrix[name].forEach((item, index) => unknownFields(item, fields.selector, `/matrix/${name}/${index}`, diagnostics));
    }
  }
  if (diagnostics.length) return { ok: false, diagnostics };
  if (value.kind !== "EvalSuite") return invalid("/kind", "INVALID_KIND");
  if (value.schemaVersion !== "1") return invalid("/schemaVersion", "UNSUPPORTED_SCHEMA_VERSION");
  if (typeof value.id !== "string" || !value.id) return invalid("/id", "INVALID_ID");
  if (!items(value.agents)) return invalid("/agents", "INVALID_AGENTS");
  if (value.submissionSlots !== undefined && !items(value.submissionSlots)) return invalid("/submissionSlots", "INVALID_SUBMISSION_SLOTS");
  if (!items(value.tasks)) return invalid("/tasks", "INVALID_TASKS");
  if (value.scenarioVariants !== undefined && !items(value.scenarioVariants)) return invalid("/scenarioVariants", "INVALID_SCENARIO_VARIANTS");
  if (!record(value.matrix) || !Number.isInteger(value.matrix.repetitions) || Number(value.matrix.repetitions) < 1) return invalid("/matrix/repetitions", "INVALID_REPETITIONS");
  if (value.matrix.include !== undefined && !Array.isArray(value.matrix.include)) return invalid("/matrix/include", "INVALID_INCLUSIONS");
  if (value.matrix.exclude !== undefined && !Array.isArray(value.matrix.exclude)) return invalid("/matrix/exclude", "INVALID_EXCLUSIONS");

  const suite = value as Suite;
  if (suite.sources !== undefined) {
    if (!items(suite.sources)) return invalid("/sources", "INVALID_SOURCES");
    for (const [index, source] of suite.sources.entries()) {
      if (!record(source.git)) return invalid(`/sources/${index}/git`, "INVALID_GIT_SOURCE");
      if (typeof source.git.remote !== "string" || !source.git.remote) return invalid(`/sources/${index}/git/remote`, "INVALID_GIT_REMOTE");
      if (typeof source.git.ref !== "string" || !source.git.ref) return invalid(`/sources/${index}/git/ref`, "INVALID_GIT_REF");
    }
    for (const [index, agent] of suite.agents.entries()) {
      if (agent.adapter !== "opencode") return invalid(`/agents/${index}/adapter`, "INVALID_ADAPTER");
      if (typeof agent.model !== "string" || !agent.model) return invalid(`/agents/${index}/model`, "INVALID_MODEL");
      if (agent.options !== undefined && !record(agent.options)) return invalid(`/agents/${index}/options`, "INVALID_OPTIONS");
    }
    for (const [index, task] of suite.tasks.entries()) {
      if (typeof task.source !== "string" || !suite.sources.some(({ id }) => id === task.source)) return invalid(`/tasks/${index}/source`, "UNKNOWN_SOURCE");
      if (typeof task.prompt !== "string" || !task.prompt) return invalid(`/tasks/${index}/prompt`, "INVALID_PROMPT");
      if (!record(task.acceptance) || typeof task.acceptance.command !== "string" || !task.acceptance.command) return invalid(`/tasks/${index}/acceptance/command`, "INVALID_ACCEPTANCE_COMMAND");
    }
    if (!record(suite.execution) || !Number.isInteger(suite.execution.timeoutSeconds) || suite.execution.timeoutSeconds < 1) return invalid("/execution/timeoutSeconds", "INVALID_TIMEOUT_SECONDS");
  }
  const variants = suite.scenarioVariants ?? [{ id: "baseline" }];
  const selectors = [...(suite.matrix.exclude ?? []).map((selector, index) => ["exclude", index, selector] as const), ...(suite.matrix.include ?? []).map((selector, index) => ["include", index, selector] as const)];
  for (const [group, index, selector] of selectors) {
    const path = `/matrix/${group}/${index}`;
    if (!record(selector)) return invalid(path, "INVALID_SELECTOR");
    if ((selector.agent === undefined) === (selector.submissionSlot === undefined)) return invalid(path, "INVALID_PARTICIPANT");
    if (selector.agent !== undefined && !suite.agents.some(({ id }) => id === selector.agent)) return invalid(`${path}/agent`, "UNKNOWN_AGENT");
    if (selector.submissionSlot !== undefined && !(suite.submissionSlots ?? []).some(({ id }) => id === selector.submissionSlot)) return invalid(`${path}/submissionSlot`, "UNKNOWN_SUBMISSION_SLOT");
    if (!suite.tasks.some(({ id }) => id === selector.task)) return invalid(`${path}/task`, "UNKNOWN_TASK");
    if (!variants.some(({ id }) => id === selector.scenarioVariant)) return invalid(`${path}/scenarioVariant`, "UNKNOWN_SCENARIO_VARIANT");
    if (!Number.isInteger(selector.repetitionIndex) || selector.repetitionIndex < 1 || selector.repetitionIndex > suite.matrix.repetitions) return invalid(`${path}/repetitionIndex`, "INVALID_REPETITION_INDEX");
  }

  let trials = [
    ...suite.agents.map((item) => ({ kind: "agent" as const, item })),
    ...(suite.submissionSlots ?? []).map((item) => ({ kind: "submission" as const, item }))
  ].flatMap((participant) => suite.tasks.flatMap((task) => variants.flatMap((variant) =>
    Array.from({ length: suite.matrix.repetitions }, (_, index) => trial(participant.item.id, task.id, variant.id, index + 1, participant.kind)))));
  const excluded = new Set((suite.matrix.exclude ?? []).map(selectorKey));
  trials = trials.filter((entry) => !excluded.has(trialKey(entry)));
  for (const [index, selector] of (suite.matrix.include ?? []).entries()) {
    if (trials.some((entry) => trialKey(entry) === selectorKey(selector))) return invalid(`/matrix/include/${index}`, "DUPLICATE_CELL");
    trials.push(trial(participant(selector), selector.task, selector.scenarioVariant, selector.repetitionIndex, selector.submissionSlot ? "submission" : "agent"));
  }
  if (!trials.length) return invalid("/matrix", "EMPTY_MATRIX");

  const canonicalJson = canonical(value);
  return { ok: true, canonicalJson, contentIdentity: `sha256:${createHash("sha256").update(canonicalJson).digest("hex")}`, trials };
}

function record(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function items(value: unknown): value is Item[] {
  return Array.isArray(value) && value.every((item) => record(item) && typeof item.id === "string" && item.id.length > 0) && new Set(value.map((item) => item.id)).size === value.length;
}
function unknownFields(value: unknown, allowed: Set<string>, path: string, diagnostics: Diagnostic[]) {
  if (!record(value)) return;
  for (const key of Object.keys(value)) if (!allowed.has(key) && !key.startsWith("x-")) diagnostics.push({ path: `${path}/${key}`, code: "UNKNOWN_FIELD" });
}
function invalid(path: string, code: string): PreviewResult {
  return { ok: false, diagnostics: [{ path, code }] };
}
function trial(participantId: string, taskId: string, scenarioVariantId: string, repetitionIndex: number, kind: "agent" | "submission" = "agent"): Trial {
  const cell = { id: `${participantId}__${taskId}__${scenarioVariantId}__${repetitionIndex}`, taskId, scenarioVariantId, repetitionIndex };
  return kind === "agent" ? { ...cell, agentId: participantId } : { ...cell, submissionSlotId: participantId };
}
function participant(value: Selector) { return value.agent ?? value.submissionSlot!; }
function selectorKey(value: Selector) { return `${participant(value)}\0${value.task}\0${value.scenarioVariant}\0${value.repetitionIndex}`; }
function trialKey(value: Trial) { return `${value.agentId ?? value.submissionSlotId}\0${value.taskId}\0${value.scenarioVariantId}\0${value.repetitionIndex}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
