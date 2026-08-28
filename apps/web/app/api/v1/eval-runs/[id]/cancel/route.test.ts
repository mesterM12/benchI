import { describe, expect, it, vi } from "vitest";
import { createEvalRunCancelPost } from "./route.js";

describe("POST /api/v1/eval-runs/:id/cancel", () => {
  it("durably cancels run before workers can commit", async () => {
    const cancelRun = vi.fn().mockResolvedValue(undefined);
    const post = createEvalRunCancelPost({ member: async () => "member-1", runs: { cancelRun } as never, now: () => new Date("2026-08-28T00:00:00.000Z") });

    const response = await post(new Request("http://test/api/v1/eval-runs/run-1/cancel", { method: "POST" }), { params: Promise.resolve({ id: "run-1" }) });

    expect(response.status).toBe(202);
    expect(cancelRun).toHaveBeenCalledWith("run-1", "2026-08-28T00:00:00.000Z");
  });
});
