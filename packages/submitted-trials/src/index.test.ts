import { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { SubmittedTrials, SubmissionError, migrate, type SubmissionBundle } from "./index.js";

const digest = (letter: string) => `sha256:${letter.repeat(64)}`;
const bundle: SubmissionBundle = {
  schemaVersion: "1",
  id: "submitted-1",
  trialId: "external__task__baseline__1",
  submissionSlotId: "external",
  output: { contentIdentity: digest("a") },
  assertedProvenance: { producer: "outside-system", revision: "abc123" },
  scorers: [{ id: "acceptance", version: digest("b"), weight: "1" }]
};

describe("Submitted Trial bundle", () => {
  it("rejects invalid bundles before content verification", async () => {
    let verified = false;
    const trials = new SubmittedTrials({} as Pool, { verify: async () => { verified = true; } });
    await expect(trials.publish({ ...bundle, output: { contentIdentity: "bad" } }, "member-1", "key-1", "2026-08-27T12:00:00.000Z"))
      .rejects.toEqual(expect.objectContaining({ code: "INVALID_SUBMISSION_BUNDLE" }));
    expect(verified).toBe(false);
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
describe.runIf(databaseUrl)("Publish Submitted Trial Protocol Transaction", () => {
  const pool = new Pool({ connectionString: databaseUrl });
  const verified: string[] = [];
  const trials = new SubmittedTrials(pool, { verify: async (identity) => { verified.push(identity); } });

  beforeAll(() => migrate(pool));
  beforeEach(async () => {
    await pool.query("TRUNCATE benchi_submitted_scoring_attempts, benchi_submitted_trials, benchi_submitted_trial_receipts");
    verified.length = 0;
  });
  afterAll(() => pool.end());

  it("verifies content and publishes atomically with asserted and trusted provenance separated", async () => {
    const first = await trials.publish(bundle, "member-1", "key-1", "2026-08-27T12:00:00.000Z");
    const replay = await trials.publish(bundle, "member-1", "key-1", "2026-08-27T12:00:00.000Z");

    expect(verified).toEqual([digest("a")]);
    expect(first).toMatchObject({ trialAttempt: null, assertedProvenance: bundle.assertedProvenance, trustedProvenance: { submittedBy: "member-1", submittedAt: "2026-08-27T12:00:00.000Z", outputContentIdentity: digest("a") }, receipt: { replayed: false } });
    expect(replay).toMatchObject({ id: first.id, receipt: { id: first.receipt.id, replayed: true } });
  });

  it("hands immutable output to ordinary scoring attempts and comparison result", async () => {
    await trials.publish(bundle, "member-1", "key-1", "2026-08-27T12:00:00.000Z");
    const result = await trials.score(bundle.id, async (manifest) => {
      expect(manifest).toMatchObject({ trialId: bundle.trialId, trialOutput: bundle.output });
      return { kind: "ScorerResult", schemaVersion: "1", acceptanceJudgment: "accepted", normalizedScore: "0.75" };
    });

    expect(result.attempts).toHaveLength(1);
    expect(result.comparison).toMatchObject({ aggregateScore: "0.75", finality: "final" });
  });
});
