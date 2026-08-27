export type ScoringInputManifest = {
  kind: "ScoringInputManifest";
  schemaVersion: "1";
  trialId: string;
  scorer: { id: string; version: string };
  trialOutput: { contentIdentity: string };
};

export type ScorerResult = {
  kind: "ScorerResult";
  schemaVersion: "1";
  acceptanceJudgment: "accepted" | "rejected";
  normalizedScore: string;
};

export type ScoringAttempt =
  | { attempt: number; status: "completed"; result: ScorerResult }
  | { attempt: number; status: "infrastructure-failure"; message: string }
  | { attempt: number; status: "evaluation-outcome"; code: string };

const decimalPattern = /^(?:0|1|0\.\d{0,11}[1-9])$/;
const contentIdentityPattern = /^sha256:[0-9a-f]{64}$/;

export function validateScoringInputManifest(value: unknown):
  | { ok: true; value: ScoringInputManifest }
  | { ok: false; code: "INVALID_SCORING_INPUT_MANIFEST" } {
  if (!record(value) || !keys(value, ["kind", "schemaVersion", "trialId", "scorer", "trialOutput"]) ||
      value.kind !== "ScoringInputManifest" || value.schemaVersion !== "1" || typeof value.trialId !== "string" || !value.trialId ||
      !record(value.scorer) || !keys(value.scorer, ["id", "version"]) || typeof value.scorer.id !== "string" || !value.scorer.id ||
      typeof value.scorer.version !== "string" || !contentIdentityPattern.test(value.scorer.version) ||
      !record(value.trialOutput) || !keys(value.trialOutput, ["contentIdentity"]) ||
      typeof value.trialOutput.contentIdentity !== "string" || !contentIdentityPattern.test(value.trialOutput.contentIdentity)) {
    return { ok: false, code: "INVALID_SCORING_INPUT_MANIFEST" };
  }
  return { ok: true, value: value as ScoringInputManifest };
}

export function validateScorerResult(value: unknown):
  | { ok: true; value: ScorerResult }
  | { ok: false; code: string } {
  if (!record(value) || !keys(value, ["kind", "schemaVersion", "acceptanceJudgment", "normalizedScore"]) ||
      value.kind !== "ScorerResult" || value.schemaVersion !== "1" ||
      (value.acceptanceJudgment !== "accepted" && value.acceptanceJudgment !== "rejected")) {
    return { ok: false, code: "INVALID_SCORER_RESULT" };
  }
  if (typeof value.normalizedScore !== "string" || !decimalPattern.test(value.normalizedScore)) {
    return { ok: false, code: "INVALID_NORMALIZED_SCORE" };
  }
  return { ok: true, value: value as ScorerResult };
}

export async function runScorer(
  manifest: ScoringInputManifest,
  execute: (manifest: ScoringInputManifest, attempt: number) => Promise<unknown>,
  maxAttempts = 1
): Promise<{ attempts: readonly ScoringAttempt[] }> {
  deepFreeze(manifest);
  const attempts: ScoringAttempt[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const result = validateScorerResult(await execute(manifest, attempt));
      if (!result.ok) {
        attempts.push({ attempt, status: "evaluation-outcome", code: result.code });
        break;
      }
      attempts.push({ attempt, status: "completed", result: result.value });
      break;
    } catch (error) {
      attempts.push({ attempt, status: "infrastructure-failure", message: error instanceof Error ? error.message : String(error) });
    }
  }
  return { attempts: deepFreeze(attempts) };
}

type AggregateInput =
  | { status: "scored"; normalizedScore: string; weight: string }
  | { status: "evaluation-outcome" | "infrastructure-failure"; weight: string };

export function aggregateScores(inputs: readonly AggregateInput[]) {
  let weightedScore = 0n;
  let includedWeight = 0n;
  let completed = 0;
  for (const input of inputs) {
    const weight = scaled(input.weight);
    if (input.status === "infrastructure-failure") continue;
    completed++;
    includedWeight += weight;
    if (input.status === "scored") weightedScore += scaled(input.normalizedScore) * weight;
  }
  return {
    policy: "weighted-mean/v1" as const,
    aggregateScore: includedWeight > 0n ? divide(weightedScore, includedWeight * 1_000_000_000_000n) : null,
    completeness: { completed, required: inputs.length },
    finality: completed === inputs.length && includedWeight > 0n ? "final" as const : "provisional" as const
  };
}

function scaled(value: string): bigint {
  if (!decimalPattern.test(value) && !/^[1-9]\d*(?:\.\d{0,11}[1-9])?$/.test(value)) throw new Error("INVALID_DECIMAL");
  const [whole, fraction = ""] = value.split(".");
  return BigInt(whole) * 1_000_000_000_000n + BigInt(fraction.padEnd(12, "0") || "0");
}

function divide(numerator: bigint, denominator: bigint): string {
  const scale = 1_000_000_000_000n;
  const rounded = (numerator * scale * 2n / denominator + 1n) / 2n;
  const whole = rounded / scale;
  const fraction = (rounded % scale).toString().padStart(12, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => key in value);
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) for (const child of value) deepFreeze(child);
  else if (record(value)) for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}
