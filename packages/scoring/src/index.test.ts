import { describe, expect, it } from "vitest";
import { aggregateScores, runScorer, validateScorerResult, validateScoringInputManifest, type ScoringInputManifest } from "./index.js";

const manifest: ScoringInputManifest = {
  kind: "ScoringInputManifest",
  schemaVersion: "1",
  trialId: "trial-1",
  scorer: { id: "acceptance", version: `sha256:${"a".repeat(64)}` },
  trialOutput: { contentIdentity: `sha256:${"d".repeat(64)}` }
};

describe("scorer protocol", () => {
  it("validates Golden Vector manifests", () => {
    expect(validateScoringInputManifest(manifest)).toEqual({ ok: true, value: manifest });
    expect(validateScoringInputManifest({ ...manifest, trialOutput: { contentIdentity: "sha256:ABC" } }))
      .toEqual({ ok: false, code: "INVALID_SCORING_INPUT_MANIFEST" });
  });

  it("accepts Golden Vector results with independent judgment and exact score", () => {
    expect(validateScorerResult({
      kind: "ScorerResult",
      schemaVersion: "1",
      acceptanceJudgment: "rejected",
      normalizedScore: "0.750000000001"
    })).toEqual({ ok: true, value: {
      kind: "ScorerResult",
      schemaVersion: "1",
      acceptanceJudgment: "rejected",
      normalizedScore: "0.750000000001"
    }});
  });

  it.each(["-0.1", "1.1", "0.1234567890123", "0.50", "1.0", "NaN"])("rejects invalid normalized score %s", (normalizedScore) => {
    expect(validateScorerResult({
      kind: "ScorerResult", schemaVersion: "1", acceptanceJudgment: "accepted", normalizedScore
    })).toEqual({ ok: false, code: "INVALID_NORMALIZED_SCORE" });
  });

  it("rejects non-contract result fields", () => {
    expect(validateScorerResult({
      kind: "ScorerResult", schemaVersion: "1", acceptanceJudgment: "accepted", normalizedScore: "1", extra: true
    })).toEqual({ ok: false, code: "INVALID_SCORER_RESULT" });
  });

  it("retries deterministically against immutable output and preserves attempts", async () => {
    const seen: ScoringInputManifest[] = [];
    const outcome = await runScorer(manifest, async (input, attempt) => {
      seen.push(input);
      if (attempt === 1) throw new Error("worker lost");
      return { kind: "ScorerResult", schemaVersion: "1", acceptanceJudgment: "accepted", normalizedScore: "1" };
    }, 2);

    expect(seen).toEqual([manifest, manifest]);
    expect(seen[0]).toBe(seen[1]);
    expect(outcome.attempts).toEqual([
      { attempt: 1, status: "infrastructure-failure", message: "worker lost" },
      { attempt: 2, status: "completed", result: { kind: "ScorerResult", schemaVersion: "1", acceptanceJudgment: "accepted", normalizedScore: "1" } }
    ]);
    expect(outcome.attempts.every(Object.isFrozen)).toBe(true);
  });
});

describe("weighted-mean/v1", () => {
  it("counts evaluation outcomes as zero and excludes infrastructure failures", () => {
    expect(aggregateScores([
      { status: "scored", normalizedScore: "1", weight: "2" },
      { status: "evaluation-outcome", weight: "1" },
      { status: "infrastructure-failure", weight: "5" }
    ])).toEqual({
      policy: "weighted-mean/v1",
      aggregateScore: "0.666666666667",
      completeness: { completed: 2, required: 3 },
      finality: "provisional"
    });
  });

  it("reports final only when every required result is complete", () => {
    expect(aggregateScores([{ status: "scored", normalizedScore: "0.25", weight: "1" }])).toEqual({
      policy: "weighted-mean/v1",
      aggregateScore: "0.25",
      completeness: { completed: 1, required: 1 },
      finality: "final"
    });
  });

  it("stays provisional without a positive-weight result", () => {
    expect(aggregateScores([{ status: "evaluation-outcome", weight: "0" }])).toMatchObject({
      aggregateScore: null,
      finality: "provisional"
    });
  });
});
