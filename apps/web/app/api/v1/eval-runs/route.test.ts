import { beforeEach, describe, expect, it, vi } from "vitest";

const definitions = { get: vi.fn() };
const runs = { freeze: vi.fn(), list: vi.fn() };
vi.mock("../../../../lib/server", () => ({ definitions, runs, member: vi.fn().mockResolvedValue("member-1") }));

describe("/api/v1/eval-runs", () => {
  beforeEach(() => vi.clearAllMocks());

  it("freezes a stored Git-backed suite revision", async () => {
    definitions.get.mockResolvedValue({
      id: "checkout", revision: 2,
      canonicalJson: JSON.stringify({
        kind: "EvalSuite", schemaVersion: "1", id: "checkout", sources: [{ id: "app", git: { remote: "https://example.test/app.git", ref: "main" } }],
        agents: [{ id: "opencode", adapter: "opencode", model: "openai/gpt-5" }],
        tasks: [{ id: "cart", source: "app", prompt: "Fix checkout.", acceptance: { command: "pnpm test" } }],
        execution: { timeoutSeconds: 900 }, matrix: { repetitions: 1 }
      })
    });
    runs.freeze.mockImplementation(async (command) => ({ ...command, state: "Ready", sources: [{ kind: "git", commit: "abc" }] }));
    const { POST } = await import("./route");

    const response = await POST(new Request("http://localhost/api/v1/eval-runs", {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "freeze-1" }, body: JSON.stringify({ suiteId: "checkout", revision: 2 })
    }));

    expect(response.status).toBe(201);
    expect(runs.freeze).toHaveBeenCalledWith(expect.objectContaining({
      suiteRevisionId: "checkout@2",
      gitSources: [{ id: "app", remote: "https://example.test/app.git", ref: "main" }],
      trials: [{ id: "opencode__cart__baseline__1", agentId: "opencode", taskId: "cart", scenarioVariantId: "baseline", repetitionIndex: 1 }]
    }), { actorId: "member-1", idempotencyKey: "freeze-1" });
  });

  it("requires caller idempotency", async () => {
    const { POST } = await import("./route");
    const response = await POST(new Request("http://localhost/api/v1/eval-runs", { method: "POST", body: "{}" }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ code: "IDEMPOTENCY_KEY_REQUIRED" });
  });

  it("lists authoritative Eval Runs", async () => {
    runs.list.mockResolvedValue([{ id: "run-1", state: "Started" }]);
    const { GET } = await import("./route");

    const response = await GET(new Request("http://localhost/api/v1/eval-runs"));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ items: [{ id: "run-1", state: "Started" }] });
  });
});
