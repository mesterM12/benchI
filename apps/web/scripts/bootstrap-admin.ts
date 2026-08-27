import { auth, pool } from "../lib/server";

const [email, password, name = "Admin"] = process.argv.slice(2);
if (!email || !password) throw new Error("usage: pnpm --filter @benchi/web bootstrap-admin <email> <password> [name]");
const existingAdmin = await pool.query(`SELECT 1 FROM "user" WHERE role = 'admin' LIMIT 1`);
if (existingAdmin.rowCount === 0) await auth.api.createUser({ body: { email, password, name, role: "admin" } });
await pool.end();
