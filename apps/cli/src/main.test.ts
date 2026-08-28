import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCli } from "./main.js";

describe("benchi", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("previews suite through shared application contract as JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchi-"));
    const file = join(directory, "suite.yaml");
    await writeFile(file, `kind: EvalSuite\nschemaVersion: "1"\nid: smoke\nsources: [{id: source, git: {remote: x, ref: main}}]\nagents: [{id: agent, adapter: opencode, model: m}]\ntasks: [{id: task, source: source, prompt: p, acceptance: {command: c}}]\nexecution: {timeoutSeconds: 1}\nmatrix: {repetitions: 1}\n`);

    const output: string[] = [];
    const exitCode = await runCli(["preview", file, "--json"], (line) => output.push(line));

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, trials: [{ id: "agent__task__baseline__1" }] });
  });

  it("prints API validation diagnostics unchanged", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: false, diagnostics: [{ path: "/kind", code: "INVALID_KIND" }] }), { status: 200 })));
    const directory = await mkdtemp(join(tmpdir(), "benchi-"));
    const file = join(directory, "suite.yaml");
    await writeFile(file, "kind: Nope");
    const output: string[] = [];

    expect(await runCli(["suite", "validate", file], (line) => output.push(line))).toBe(1);
    expect(JSON.parse(output[0]!)).toEqual({ ok: false, diagnostics: [{ path: "/kind", code: "INVALID_KIND" }] });
  });

  it.each([
    [["run", "freeze", "checkout", "--revision", "7"], "/api/v1/eval-runs", { suiteId: "checkout", revision: 7 }],
    [["run", "start", "run-1"], "/api/v1/eval-runs/run-1/start", {}],
    [["run", "inspect", "run-1"], "/api/v1/eval-runs/run-1", undefined]
  ])("exposes separate freeze and inspect API commands", async (args, path, body) => {
    const requests: Array<{ url: string; method: string | undefined; body: unknown }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), method: init?.method, body: init?.body && JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ data: { id: "run-1" } }), { status: 200 });
    };
    const output: string[] = [];

    expect(await runCli(args, (line) => output.push(line), request)).toBe(0);
    expect(requests).toEqual([{ url: `http://localhost:3000${path}`, method: body === undefined ? "GET" : "POST", body }]);
    expect(JSON.parse(output[0]!)).toEqual({ data: { id: "run-1" } });
  });

  it("uses one server, session, and durable idempotency configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchi-"));
    const file = join(directory, "suite.yaml");
    await writeFile(file, "suite");
    const request = vi.fn().mockImplementation(async () => new Response("{}", { status: 201 }));

    expect(await runCli(["suite", "create", file, "--server", "http://example.test", "--idempotency-key", "suite-key"], () => {}, request, { session: "session=x" })).toBe(0);
    expect(await runCli(["run", "freeze", "suite", "--revision", "1", "--server", "http://example.test", "--idempotency-key", "freeze-key"], () => {}, request, { session: "session=x" })).toBe(0);

    expect(request.mock.calls.map(([url, init]) => ({ url, cookie: init.headers.Cookie, key: init.headers["Idempotency-Key"] }))).toEqual([
      { url: "http://example.test/api/v1/eval-suites", cookie: "session=x", key: "suite-key" },
      { url: "http://example.test/api/v1/eval-runs", cookie: "session=x", key: "freeze-key" }
    ]);
  });

  it("follows resumable events then reconciles terminal state", async () => {
    const requests: string[] = [];
    const request = async (url: string | URL | Request) => {
      requests.push(String(url));
      if (String(url).includes("/events")) return Response.json({ events: [{ sequence: 7, type: "output" }], jobs: [] });
      return Response.json({ trialStates: [{ state: "completed" }] });
    };
    const output: string[] = [];

    expect(await runCli(["run", "follow", "run-1"], (line) => output.push(line), request)).toBe(0);
    expect(requests).toEqual([
      "http://localhost:3000/api/v1/eval-runs/run-1/events?after=0",
      "http://localhost:3000/api/v1/eval-runs/run-1"
    ]);
    expect(output).toEqual([JSON.stringify({ sequence: 7, type: "output" }), JSON.stringify({ trialStates: [{ state: "completed" }] })]);
  });

  it("publishes Submitted Trials through API", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchi-"));
    const file = join(directory, "submission.json");
    await writeFile(file, JSON.stringify({ id: "submitted-1" }));
    const requests: Array<{ url: string; body: string | null | undefined }> = [];
    const request = async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(url), body: init?.body?.toString() });
      return new Response("{}", { status: 201 });
    };

    expect(await runCli(["trial", "submit", file], () => {}, request)).toBe(0);
    expect(requests).toEqual([{ url: "http://localhost:3000/api/v1/submitted-trials", body: JSON.stringify({ id: "submitted-1" }) }]);
  });

  it.each([
    [["artifact", "inspect", "attempt-1-log"], "/api/v1/artifacts/attempt-1-log"],
    [["artifact", "download", "attempt-1-log"], "/api/v1/artifacts/attempt-1-log?download=1"]
  ])("inspects and downloads retained artifacts through authorized API", async (args, path) => {
    const requests: string[] = [];
    const request = async (url: string | URL | Request) => {
      requests.push(String(url));
      return new Response("evidence", { status: 200 });
    };

    expect(await runCli(args, () => {}, request)).toBe(0);
    expect(requests).toEqual([`http://localhost:3000${path}`]);
  });
});
