import { member, runs } from "../../../../../../../../lib/server";

type Context = { params: Promise<{ id: string; trialId: string }> };

export function createEvalTrialCancelPost(services: { member: typeof member; runs: typeof runs; now?: () => Date }) {
  return async function POST(request: Request, context: Context) {
    if (!await services.member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const { id, trialId } = await context.params;
    const run = await services.runs.inspect(id);
    if (!run || !run.trials.some((trial) => trial.id === trialId)) return Response.json({ code: "NOT_FOUND" }, { status: 404 });
    await services.runs.cancelTrial(trialId, (services.now?.() ?? new Date()).toISOString());
    return Response.json({ ok: true }, { status: 202 });
  };
}

export const POST = createEvalTrialCancelPost({ member, runs });
