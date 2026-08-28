import { describe, expect, it, vi } from "vitest";
import { createEvalRunEventsGet } from "./route.js";

describe("GET /api/v1/eval-runs/:id/events", () => {
  it("returns resumable events with current worker state", async () => {
    const resumeEvents = vi.fn().mockResolvedValue({ events: [{ sequence: 3 }], jobs: [{ state: "running" }] });
    const get = createEvalRunEventsGet({ member: async () => "member-1", runs: { resumeEvents } as never });

    const response = await get(new Request("http://test/api/v1/eval-runs/run-1/events?after=2"), { params: Promise.resolve({ id: "run-1" }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ events: [{ sequence: 3 }], jobs: [{ state: "running" }] });
    expect(resumeEvents).toHaveBeenCalledWith("run-1", 2);
  });
});
