import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { EvaluationDefinition } from "@benchi/evaluation-definition";
import { SubmittedTrials } from "@benchi/submitted-trials";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const definitions = new EvaluationDefinition(pool);
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
