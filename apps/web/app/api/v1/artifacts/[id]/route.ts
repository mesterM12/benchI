import { member, runs } from "../../../../../lib/server";

type Context = { params: Promise<{ id: string }> };

export function createArtifactGet(services: { member: typeof member; runs: typeof runs }) {
  return async function GET(request: Request, context: Context) {
    const actorId = await services.member(request.headers);
    if (!actorId) return Response.json({ code: "UNAUTHENTICATED" }, { status: 401 });
    const principal = { role: "Member" as const, actorId };
    const id = (await context.params).id;
    try {
      if (new URL(request.url).searchParams.has("download")) {
        const token = await services.runs.issueArtifactDownload(id, principal);
        const bytes = await services.runs.downloadArtifact(token, principal);
        return new Response(new Uint8Array(bytes), { headers: { "Content-Type": "application/octet-stream" } });
      }
      return Response.json(await services.runs.inspectArtifact(id, principal));
    } catch (error) {
      if (error instanceof Error && error.message === "ARTIFACT_NOT_FOUND") return Response.json({ code: "NOT_FOUND" }, { status: 404 });
      throw error;
    }
  };
}

export const GET = createArtifactGet({ member, runs });
