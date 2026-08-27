import { randomUUID } from "node:crypto";
import { ApplicationError } from "@benchi/evaluation-definition";
import { definitions, member } from "../../../../lib/server";

export async function GET(request: Request) {
  if (!await member(request.headers)) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  return Response.json({ items: await definitions.list() });
}

export function createEvalSuitePost(services: { member: typeof member; definitions: typeof definitions }) {
 return async function POST(request: Request) {
  const actorId = await services.member(request.headers);
  if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
  const idempotencyKey = request.headers.get("idempotency-key");
  if (!idempotencyKey) return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
  try {
    const { source } = await request.json() as { source: string };
    const result = await services.definitions.create({ source, actorId, idempotencyKey });
    return Response.json(result, { status: 201, headers: { Location: `/api/v1/eval-suites/${result.id}`, "Command-Receipt": result.receipt.id } });
  } catch (error) { return applicationError(error); }
 };
}

export const POST = createEvalSuitePost({ member, definitions });

export function applicationError(error: unknown) {
  if (!(error instanceof ApplicationError)) return Response.json({ code: "INTERNAL_ERROR", traceId: randomUUID() }, { status: 500 });
  const status = error.code === "NOT_FOUND" ? 404 : error.code === "REVISION_CONFLICT" ? 412 : error.code === "ALREADY_EXISTS" ? 409 : 422;
  return Response.json({ code: error.code, diagnostics: error.diagnostics }, { status });
}
