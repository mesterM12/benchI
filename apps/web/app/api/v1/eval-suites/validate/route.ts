import { definitions, member } from "../../../../../lib/server";

export async function POST(request: Request) {
  if (!await member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const { source } = await request.json() as { source: string };
  return Response.json(definitions.validate(source));
}
