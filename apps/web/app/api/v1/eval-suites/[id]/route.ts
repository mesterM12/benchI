import { definitions, member } from "../../../../../lib/server";
import { applicationError } from "../route";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: Request, context: Context) {
  if (!await member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const { id } = await context.params;
  const revision = new URL(request.url).searchParams.get("revision");
  const result = await definitions.get(id, revision ? Number(revision) : undefined);
  return result ? Response.json(result) : Response.json({ code: "NOT_FOUND" }, { status: 404 });
}

export async function PUT(request: Request, context: Context) {
  const actorId = await member(request.headers);
  if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const idempotencyKey = request.headers.get("idempotency-key");
  const expected = request.headers.get("if-match");
  if (!idempotencyKey) return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  if (!expected) return Response.json({ code: "IF_MATCH_REQUIRED" }, { status: 428 });
  const expectedRevision = Number(expected.replaceAll('"', ""));
  if (!Number.isInteger(expectedRevision) || expectedRevision < 1) return Response.json({ code: "INVALID_IF_MATCH" }, { status: 400 });
  try {
    const { id } = await context.params;
    const { source } = await request.json() as { source: string };
    const result = await definitions.revise(id, { source, actorId, idempotencyKey, expectedRevision });
    return Response.json(result, { headers: { ETag: `"${result.revision}"`, "Command-Receipt": result.receipt.id } });
  } catch (error) { return applicationError(error); }
}
