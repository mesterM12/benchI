import { member, runs } from "../../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export function createEvalRunCancelPost(services: { member: typeof member; runs: typeof runs; now?: () => Date }) {
  return async function POST(request: Request, context: Context) {
    if (!await services.member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    try {
      await services.runs.cancelRun((await context.params).id, (services.now?.() ?? new Date()).toISOString());
      return Response.json({ ok: true }, { status: 202 });
    } catch {
      return Response.json({ code: "CANCEL_FAILED" }, { status: 422 });
    }
  };
}

export const POST = createEvalRunCancelPost({ member, runs });
