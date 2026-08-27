import { describe, expect, it, vi } from "vitest";
import { createEvalRunStartPost } from "./route.js";

describe("POST /api/v1/eval-runs/:id/start", () => {
  it("returns durable command receipt then executes scheduled work", async () => {
    const start = vi.fn().mockResolvedValue({ id: "receipt-1", idempotencyKey: "start-1", replayed: false });
    const execute = vi.fn().mockResolvedValue(undefined);
    const post = createEvalRunStartPost({ member: async () => "member-1", runs: { start } as never, execute });
    const request = new Request("http://test/api/v1/eval-runs/run-1/start", { method: "POST", headers: { "Idempotency-Key": "start-1" }, body: "{}" });

    const response = await post(request, { params: Promise.resolve({ id: "run-1" }) });

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ id: "receipt-1", idempotencyKey: "start-1", replayed: false });
    expect(start).toHaveBeenCalledWith("run-1", { actorId: "member-1", idempotencyKey: "start-1" });
    expect(execute).toHaveBeenCalledWith("run-1");
  });
});
