import { member, runs } from "../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export function createEvalRunGet(services: { member: typeof member; runs: typeof runs }) {
 return async function GET(request: Request, context: Context) {
  if (!await services.member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const result = await services.runs.inspect((await context.params).id);
  return result ? Response.json(result) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
 };
}

export const GET = createEvalRunGet({ member, runs });
