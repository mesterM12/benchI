import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCli } from "./main.js";

describe("benchi", () => {
  it("previews suite through shared application contract as JSON", async () => {
    const directory = await mkdtemp(join(tmpdir(), "benchi-"));
    const file = join(directory, "suite.yaml");
    await writeFile(file, `kind: EvalSuite\nschemaVersion: "1"\nid: smoke\nagents: [{id: agent}]\ntasks: [{id: task}]\nmatrix: {repetitions: 1}\n`);

    const output: string[] = [];
    const exitCode = await runCli(["preview", file, "--json"], (line) => output.push(line));

    expect(exitCode).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, trials: [{ id: "agent__task__baseline__1" }] });
  });
});
