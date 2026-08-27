import { createHash } from "node:crypto";
import { parse } from "yaml";

export type Diagnostic = { path: string; code: string };
export type Trial = {
  id: string;
  agentId: string;
  taskId: string;
  scenarioVariantId: string;
  repetitionIndex: number;
};
export type PreviewResult =
  | { ok: true; canonicalJson: string; contentIdentity: string; trials: Trial[] }
  | { ok: false; diagnostics: Diagnostic[] };

type Item = { id: string };
type Selector = { agent: string; task: string; scenarioVariant: string; repetitionIndex: number };
type Suite = {
  kind: "EvalSuite";
  schemaVersion: "1";
  id: string;
  agents: Item[];
  tasks: Item[];
  scenarioVariants?: Item[];
  matrix: { repetitions: number; include?: Selector[]; exclude?: Selector[] };
};

const fields = {
  root: new Set(["kind", "schemaVersion", "id", "agents", "tasks", "scenarioVariants", "matrix"]),
  item: new Set(["id"]),
  matrix: new Set(["repetitions", "include", "exclude"]),
  selector: new Set(["agent", "task", "scenarioVariant", "repetitionIndex"])
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
  for (const [name, allowed] of [["agents", fields.item], ["tasks", fields.item], ["scenarioVariants", fields.item]] as const) {
    if (Array.isArray(value[name])) value[name].forEach((item, index) => unknownFields(item, allowed, `/${name}/${index}`, diagnostics));
  }
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
  if (!items(value.tasks)) return invalid("/tasks", "INVALID_TASKS");
  if (value.scenarioVariants !== undefined && !items(value.scenarioVariants)) return invalid("/scenarioVariants", "INVALID_SCENARIO_VARIANTS");
  if (!record(value.matrix) || !Number.isInteger(value.matrix.repetitions) || Number(value.matrix.repetitions) < 1) return invalid("/matrix/repetitions", "INVALID_REPETITIONS");
  if (value.matrix.include !== undefined && !Array.isArray(value.matrix.include)) return invalid("/matrix/include", "INVALID_INCLUSIONS");
  if (value.matrix.exclude !== undefined && !Array.isArray(value.matrix.exclude)) return invalid("/matrix/exclude", "INVALID_EXCLUSIONS");

  const suite = value as Suite;
  const variants = suite.scenarioVariants ?? [{ id: "baseline" }];
  const selectors = [...(suite.matrix.exclude ?? []).map((selector, index) => ["exclude", index, selector] as const), ...(suite.matrix.include ?? []).map((selector, index) => ["include", index, selector] as const)];
  for (const [group, index, selector] of selectors) {
    const path = `/matrix/${group}/${index}`;
    if (!record(selector)) return invalid(path, "INVALID_SELECTOR");
    if (!suite.agents.some(({ id }) => id === selector.agent)) return invalid(`${path}/agent`, "UNKNOWN_AGENT");
    if (!suite.tasks.some(({ id }) => id === selector.task)) return invalid(`${path}/task`, "UNKNOWN_TASK");
    if (!variants.some(({ id }) => id === selector.scenarioVariant)) return invalid(`${path}/scenarioVariant`, "UNKNOWN_SCENARIO_VARIANT");
    if (!Number.isInteger(selector.repetitionIndex) || selector.repetitionIndex < 1 || selector.repetitionIndex > suite.matrix.repetitions) return invalid(`${path}/repetitionIndex`, "INVALID_REPETITION_INDEX");
  }

  let trials = suite.agents.flatMap((agent) => suite.tasks.flatMap((task) => variants.flatMap((variant) =>
    Array.from({ length: suite.matrix.repetitions }, (_, index) => trial(agent.id, task.id, variant.id, index + 1)))));
  const excluded = new Set((suite.matrix.exclude ?? []).map(selectorKey));
  trials = trials.filter((entry) => !excluded.has(trialKey(entry)));
  for (const [index, selector] of (suite.matrix.include ?? []).entries()) {
    if (trials.some((entry) => trialKey(entry) === selectorKey(selector))) return invalid(`/matrix/include/${index}`, "DUPLICATE_CELL");
    trials.push(trial(selector.agent, selector.task, selector.scenarioVariant, selector.repetitionIndex));
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
function trial(agentId: string, taskId: string, scenarioVariantId: string, repetitionIndex: number): Trial {
  return { id: `${agentId}__${taskId}__${scenarioVariantId}__${repetitionIndex}`, agentId, taskId, scenarioVariantId, repetitionIndex };
}
function selectorKey(value: Selector) { return `${value.agent}\0${value.task}\0${value.scenarioVariant}\0${value.repetitionIndex}`; }
function trialKey(value: Trial) { return `${value.agentId}\0${value.taskId}\0${value.scenarioVariantId}\0${value.repetitionIndex}`; }
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (record(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
