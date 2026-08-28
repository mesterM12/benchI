import { randomUUID } from "node:crypto";
import { previewEvalSuite } from "@benchi/contracts";
import { definitions, member, runs } from "../../../../lib/server";

type FrozenSuite = {
  sources: Array<{ id: string; git: { remote: string; ref: string } }>;
  agents: unknown[];
  tasks: unknown[];
  execution: unknown;
};

export function createEvalRunPost(services: { member: typeof member; definitions: typeof definitions; runs: typeof runs; id?: () => string; now?: () => Date }) {
 return async function POST(request: Request) {
  const actorId = await services.member(request.headers);
  if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  const { suiteId, revision } = await request.json() as { suiteId?: string; revision?: number };
  if (!suiteId || !Number.isInteger(revision) || revision! < 1) return Response.json({ code: "INVALID_SUITE_REVISION" }, { status: 400 });
  const stored = await services.definitions.get(suiteId, revision);
  if (!stored) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const preview = previewEvalSuite(stored.canonicalJson);
  if (!preview.ok) return Response.json({ code: "INVALID_STORED_SUITE", diagnostics: preview.diagnostics }, { status: 500 });
  const suite = JSON.parse(stored.canonicalJson) as FrozenSuite;
  try {
    const snapshot = await services.runs.freeze({
      id: (services.id ?? randomUUID)(),
      suiteRevisionId: `${stored.id}@${stored.revision}`,
      suiteRoot: process.cwd(),
      suite,
      resolvedDefinitions: { agents: suite.agents, tasks: suite.tasks },
      trials: preview.trials,
      effectivePolicies: suite.execution,
      localSources: [],
      gitSources: suite.sources.map(({ id, git }) => ({ id, remote: git.remote, ref: git.ref })),
      frozenAt: (services.now?.() ?? new Date()).toISOString(),
      benchiVersion: process.env.npm_package_version ?? "0.0.0"
    }, { actorId, idempotencyKey });
    return Response.json(snapshot, { status: 201, headers: { Location: `/api/v1/eval-runs/${snapshot.id}` } });
  } catch (error) {
    const code = error instanceof Error && error.message === "IDEMPOTENCY_MISMATCH" ? error.message : "FREEZE_FAILED";
    return Response.json({ code }, { status: code === "IDEMPOTENCY_MISMATCH" ? 409 : 422 });
  }
 };
}

export function createEvalRunListGet(services: { member: typeof member; runs: Pick<typeof runs, "list"> }) {
 return async function GET(request: Request) {
   if (!await services.member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
   return Response.json({ items: await services.runs.list() });
 };
}

export const POST = createEvalRunPost({ member, definitions, runs });
export const GET = createEvalRunListGet({ member, runs });
