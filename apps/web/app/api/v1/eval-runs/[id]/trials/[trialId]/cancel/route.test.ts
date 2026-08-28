import { describe, expect, it, vi } from "vitest";
import { createEvalTrialCancelPost } from "./route.js";

describe("POST /api/v1/eval-runs/:id/trials/:trialId/cancel", () => {
  it("cancels only a trial in requested Eval Run", async () => {
    const cancelTrial = vi.fn().mockResolvedValue(undefined);
    const post = createEvalTrialCancelPost({ member: async () => "member-1", runs: { inspect: vi.fn().mockResolvedValue({ trials: [{ id: "trial-1" }] }), cancelTrial } as never, now: () => new Date("2026-08-28T00:00:00.000Z") });

    const response = await post(new Request("http://test"), { params: Promise.resolve({ id: "run-1", trialId: "trial-1" }) });

    expect(response.status).toBe(202);
    expect(cancelTrial).toHaveBeenCalledWith("trial-1", "2026-08-28T00:00:00.000Z");
  });
});
