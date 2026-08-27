import { member, runs } from "../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  if (!await member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const result = await runs.get((await context.params).id);
  return result ? Response.json(result) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
}
