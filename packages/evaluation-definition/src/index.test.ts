import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EvaluationDefinition } from "./index.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = (id: string, repetitions = 1) => `kind: EvalSuite\nschemaVersion: "1"\nid: ${id}\nsources: [{id: source, git: {remote: x, ref: main}}]\nagents: [{id: agent, adapter: opencode, model: m}]\ntasks: [{id: task, source: source, prompt: p, acceptance: {command: c}}]\nexecution: {timeoutSeconds: 1}\nmatrix: {repetitions: ${repetitions}}\n`;

describe.skipIf(!databaseUrl)("Evaluation Definition application seam", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const app = new EvaluationDefinition(pool);

  beforeAll(() => app.migrate());
  afterAll(() => pool.end());

  it("creates, replays, and revises an Eval Suite without changing superseded revisions", async () => {
    const id = `suite-${randomUUID()}`;
    const created = await app.create({ source: suite(id), idempotencyKey: randomUUID(), actorId: "member-1" });
    expect(created).toMatchObject({ revision: 1, receipt: { replayed: false } });

    const replayed = await app.create({ source: suite(id), idempotencyKey: created.receipt.idempotencyKey, actorId: "member-1" });
    expect(replayed).toMatchObject({ revision: 1, receipt: { replayed: true } });

    const revised = await app.revise(id, { source: suite(id, 2), expectedRevision: 1, idempotencyKey: randomUUID(), actorId: "member-1" });
    expect(revised.revision).toBe(2);
    expect((await app.get(id, 1))?.source).toBe(suite(id));
    expect((await app.get(id))?.source).toBe(suite(id, 2));
    expect((await app.list()).some((entry) => entry.id === id && entry.revision === 2)).toBe(true);
  });

  it("returns shared diagnostics and rejects stale revisions and changed idempotent commands", async () => {
    const invalid = await app.validate("kind: Nope");
    expect(invalid).toEqual({ ok: false, diagnostics: [{ path: "/kind", code: "INVALID_KIND" }] });

    const id = `suite-${randomUUID()}`;
    const key = randomUUID();
    await app.create({ source: suite(id), idempotencyKey: key, actorId: "member-1" });
    await expect(app.create({ source: suite(`${id}-changed`), idempotencyKey: key, actorId: "member-1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(app.revise(id, { source: suite(id), expectedRevision: 1, idempotencyKey: key, actorId: "member-1" })).rejects.toMatchObject({ code: "IDEMPOTENCY_MISMATCH" });
    await expect(app.revise(id, { source: suite(id, 2), expectedRevision: 0, idempotencyKey: randomUUID(), actorId: "member-1" })).rejects.toMatchObject({ code: "REVISION_CONFLICT" });
  });

  it("enforces immutable revisions in PostgreSQL", async () => {
    const id = `suite-${randomUUID()}`;
    await app.create({ source: suite(id), idempotencyKey: randomUUID(), actorId: "member-1" });

    await expect(pool.query(`UPDATE eval_suite_revisions SET source = 'changed' WHERE suite_id = $1`, [id])).rejects.toMatchObject({ code: "P0001" });
    await expect(pool.query(`DELETE FROM eval_suite_revisions WHERE suite_id = $1`, [id])).rejects.toMatchObject({ code: "P0001" });
  });
});
