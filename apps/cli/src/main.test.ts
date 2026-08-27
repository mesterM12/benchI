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
});
