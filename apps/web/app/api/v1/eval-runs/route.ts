import { randomUUID } from "node:crypto";
import { previewEvalSuite } from "@benchi/contracts";
import { definitions, member, runs } from "../../../../lib/server";

type FrozenSuite = {
  sources: Array<{ id: string; git: { remote: string; ref: string } }>;
  agents: unknown[];
  tasks: unknown[];
  execution: unknown;
};

export async function POST(request: Request) {
  if (!await member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const { suiteId, revision } = await request.json() as { suiteId?: string; revision?: number };
  if (!suiteId || !Number.isInteger(revision) || revision! < 1) return Response.json({ code: "INVALID_SUITE_REVISION" }, { status: 400 });
  const stored = await definitions.get(suiteId, revision);
  if (!stored) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
  const preview = previewEvalSuite(stored.canonicalJson);
  if (!preview.ok) return Response.json({ code: "INVALID_STORED_SUITE", diagnostics: preview.diagnostics }, { status: 500 });
  const suite = JSON.parse(stored.canonicalJson) as FrozenSuite;
  try {
    const snapshot = await runs.freeze({
      id: randomUUID(),
      suiteRevisionId: `${stored.id}@${stored.revision}`,
      suiteRoot: process.cwd(),
      suite,
      resolvedDefinitions: { agents: suite.agents, tasks: suite.tasks },
      trials: preview.trials,
      effectivePolicies: suite.execution,
      localSources: [],
      gitSources: suite.sources.map(({ id, git }) => ({ id, remote: git.remote, ref: git.ref })),
      frozenAt: new Date().toISOString(),
      benchiVersion: process.env.npm_package_version ?? "0.0.0"
    });
    return Response.json(snapshot, { status: 201, headers: { Location: `/api/v1/eval-runs/${snapshot.id}` } });
  } catch {
    return Response.json({ code: "FREEZE_FAILED" }, { status: 422 });
  }
}
