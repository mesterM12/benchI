import { describe, expect, it, vi } from "vitest";
import { createPost } from "./route";

vi.mock("../../../../lib/server", () => ({ member: vi.fn(), submittedTrials: {} }));

describe("POST /api/v1/submitted-trials", () => {
  it("publishes through application seam with caller idempotency", async () => {
    const publish = vi.fn().mockResolvedValue({ id: "submitted-1", receipt: { id: "receipt-1", replayed: false } });
    const post = createPost(async () => "member-1", { publish } as never);
    const request = new Request("http://localhost/api/v1/submitted-trials", {
      method: "POST", headers: { "idempotency-key": "key-1" }, body: JSON.stringify({ id: "submitted-1" })
    });

    const response = await post(request);
    expect(response.status).toBe(201);
    expect(publish).toHaveBeenCalledWith({ id: "submitted-1" }, "member-1", "key-1", expect.any(String));
    expect(response.headers.get("location")).toBe("/api/v1/submitted-trials/submitted-1");
  });
});
