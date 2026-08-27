import { executeEvalRun } from "../../../../../../lib/eval-execution";
import { member, runs } from "../../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export function createEvalRunStartPost(services: { member: typeof member; runs: typeof runs; execute: (runId: string) => Promise<void> }) {
  return async function POST(request: Request, context: Context) {
    const actorId = await services.member(request.headers);
    if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
    const runId = (await context.params).id;
    try {
      const receipt = await services.runs.start(runId, { actorId, idempotencyKey });
      if (!receipt.replayed) await services.execute(runId);
      return Response.json(receipt, { status: 202 });
    } catch (error) {
      const code = error instanceof Error && error.message === "IDEMPOTENCY_MISMATCH" ? error.message : "START_FAILED";
      return Response.json({ code }, { status: code === "IDEMPOTENCY_MISMATCH" ? 409 : 422 });
    }
  };
}

export const POST = createEvalRunStartPost({ member, runs, execute: executeEvalRun });
