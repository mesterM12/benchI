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
    await writeFile(file, `kind: EvalSuite\nschemaVersion: "1"\nid: smoke\nagents: [{id: agent}]\ntasks: [{id: task}]\nmatrix: {repetitions: 1}\n`);

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
    [["run", "inspect", "run-1"], "/api/v1/eval-runs/run-1", undefined],
    [["run", "start", "run-1"], "/api/v1/eval-runs/run-1:start", {}]
  ])("exposes separate freeze, inspect, and start API commands", async (args, path, body) => {
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
});
