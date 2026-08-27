import type { SubmittedTrials, SubmissionBundle } from "@benchi/submitted-trials";
import { member, submittedTrials } from "../../../../lib/server";

export function createPost(authenticate: typeof member, trials: SubmittedTrials) {
  return async (request: Request) => {
    const actorId = await authenticate(request.headers);
    if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const idempotencyKey = request.headers.get("idempotency-key");
    if (!idempotencyKey) return Response.json({ code: "IDEMPOTENCY_KEY_REQUIRED" }, { status: 400 });
    try {
      const result = await trials.publish(await request.json() as SubmissionBundle, actorId, idempotencyKey, new Date().toISOString());
      return Response.json(result, { status: result.receipt.replayed ? 200 : 201, headers: { Location: `/api/v1/submitted-trials/${result.id}`, "Command-Receipt": result.receipt.id } });
    } catch (error) {
      const code = error instanceof Error && "code" in error ? String(error.code) : "INVALID_SUBMISSION";
      return Response.json({ code }, { status: code === "ALREADY_PUBLISHED" ? 409 : 422 });
    }
  };
}

export const POST = createPost(member, submittedTrials);
