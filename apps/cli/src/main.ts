#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { previewEvalSuite } from "@benchi/contracts";

export async function runCli(args: string[], write = console.log): Promise<number> {
  const [command, file] = args;
  if (command !== "preview" || !file) {
    write("usage: benchi preview <suite.yaml> [--json]");
    return 2;
  }
  const result = previewEvalSuite(await readFile(file, "utf8"));
  if (args.includes("--json")) write(JSON.stringify(result));
  else if (result.ok) {
    write(`valid Eval Suite: ${result.trials.length} Eval Trial(s)`);
    for (const entry of result.trials) write(`${entry.id}`);
  } else {
    for (const diagnostic of result.diagnostics) write(`${diagnostic.path} ${diagnostic.code}`);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
