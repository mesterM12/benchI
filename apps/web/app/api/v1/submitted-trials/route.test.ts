import { describe, expect, it, vi } from "vitest";
import { createPost } from "./route";

vi.mock("../../../../lib/server", () => ({ member: vi.fn(), runs: {}, submittedTrials: {} }));

describe("POST /api/v1/submitted-trials", () => {
  it("publishes through application seam with caller idempotency", async () => {
    const publish = vi.fn().mockResolvedValue({ id: "submitted-1", receipt: { id: "receipt-1", replayed: false } });
    const post = createPost(async () => "member-1", { publish } as never, { submissionSlotForTrial: async () => "external" } as never);
    const request = new Request("http://localhost/api/v1/submitted-trials", {
      method: "POST", headers: { "idempotency-key": "key-1" }, body: JSON.stringify({ id: "submitted-1", trialId: "external__task__baseline__1", submissionSlotId: "external" })
    });

    const response = await post(request);
    expect(response.status).toBe(201);
    expect(publish).toHaveBeenCalledWith({ id: "submitted-1", trialId: "external__task__baseline__1", submissionSlotId: "external" }, "member-1", "key-1", expect.any(String));
    expect(response.headers.get("location")).toBe("/api/v1/submitted-trials/submitted-1");
  });

  it("rejects submission for a non-frozen Submission Slot", async () => {
    const publish = vi.fn();
    const post = createPost(async () => "member-1", { publish } as never, { submissionSlotForTrial: async () => undefined } as never);

    const response = await post(new Request("http://localhost/api/v1/submitted-trials", {
      method: "POST", headers: { "idempotency-key": "key-1" }, body: JSON.stringify({ trialId: "unknown", submissionSlotId: "external" })
    }));

    expect(response).toMatchObject({ status: 422 });
    expect(publish).not.toHaveBeenCalled();
  });
});
