import { Pool } from "pg";
import { betterAuth } from "better-auth";
import { admin } from "better-auth/plugins";
import { EvaluationDefinition } from "@benchi/evaluation-definition";

export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
export const definitions = new EvaluationDefinition(pool);
export const auth = betterAuth({
  database: pool,
  emailAndPassword: { enabled: true, disableSignUp: true, revokeSessionsOnPasswordReset: true },
  plugins: [admin({ defaultRole: "member", adminRoles: ["admin"] })]
});

export async function member(headers: Headers): Promise<string | undefined> {
  const session = await auth.api.getSession({ headers });
  return session?.user.id;
}
