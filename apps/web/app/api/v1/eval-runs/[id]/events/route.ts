import { member, runs } from "../../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export function createEvalRunEventsGet(services: { member: typeof member; runs: typeof runs }) {
  return async function GET(request: Request, context: Context) {
    if (!await services.member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const after = Number(new URL(request.url).searchParams.get("after") ?? "0");
    if (!Number.isSafeInteger(after) || after < 0) return Response.json({ code: "INVALID_CURSOR" }, { status: 400 });
    return Response.json(await services.runs.resumeEvents((await context.params).id, after));
  };
}

export const GET = createEvalRunEventsGet({ member, runs });
