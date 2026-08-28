import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { EvaluationDefinition } from "@benchi/evaluation-definition";
import { SubmittedTrials } from "@benchi/submitted-trials";
import { RunOrchestration, createS3RetainedContent } from "@benchi/run-orchestration";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const definitions = new EvaluationDefinition(pool);
const objectStorageEndpoint = process.env.OBJECT_STORAGE_ENDPOINT;
const objectStorageAccessKey = process.env.OBJECT_STORAGE_ACCESS_KEY;
const objectStorageSecretKey = process.env.OBJECT_STORAGE_SECRET_KEY;
export const runs = new RunOrchestration(pool, objectStorageEndpoint && objectStorageAccessKey && objectStorageSecretKey
  ? createS3RetainedContent({ endpoint: objectStorageEndpoint, accessKeyId: objectStorageAccessKey, secretAccessKey: objectStorageSecretKey })
  : { async putVerified() { throw new Error("object storage configuration is required"); }, async get() { throw new Error("object storage configuration is required"); } });
export const submittedTrials = new SubmittedTrials(pool, {
  async verify(contentIdentity) {
    const endpoint = process.env.RETAINED_CONTENT_VERIFIER_URL;
    if (!endpoint) throw new Error("RETAINED_CONTENT_VERIFIER_URL is required");
    const response = await fetch(`${endpoint}/${encodeURIComponent(contentIdentity)}`, { method: "HEAD" });
    if (!response.ok) throw new Error("submitted content verification failed");
  }
});
export const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true, disableSignUp: true, revokeSessionsOnPasswordReset: true },
  plugins: [admin({ defaultRole: "member", adminRoles: ["admin"] })]
});

export async function member(headers: Headers): Promise<string | undefined> {
  const session = await auth.api.getSession({ headers });
  return session?.user.id;
}
