#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";
import { previewEvalSuite } from "@benchi/contracts";

type Request = (url: string | URL | globalThis.Request, init?: RequestInit) => Promise<Response>;

export async function runCli(args: string[], write = console.log, request: Request = fetch): Promise<number> {
  if (args[0] === "run" && (args[1] === "freeze" || args[1] === "inspect" || args[1] === "start") && args[2]) {
    const [, command, id] = args;
    const path = command === "freeze" ? "/api/v1/eval-runs" : `/api/v1/eval-runs/${encodeURIComponent(id)}${command === "start" ? ":start" : ""}`;
    const body = command === "freeze" ? { suiteRevisionId: id } : command === "start" ? {} : undefined;
    const response = await request(`${process.env.BENCHI_URL ?? "http://localhost:3000"}${path}`, {
      method: body === undefined ? "GET" : "POST",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json", "idempotency-key": randomUUID() }, body: JSON.stringify(body) })
    });
    write(await response.text());
    return response.ok ? 0 : 1;
  }
  const [command, file] = args;
  if (command === "suite") return runSuite(args.slice(1), write);
  if (command !== "preview" || !file) {
    write("usage: benchi preview <suite.yaml> [--json] | benchi suite <validate|create|revise|list|get> | benchi run <freeze|inspect|start> <id>");
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

async function runSuite(args: string[], write: (line: string) => void): Promise<number> {
  const [command, value, maybeFile] = args;
  const server = option(args, "--server") ?? process.env.BENCHI_SERVER ?? "http://localhost:3000";
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (process.env.BENCHI_SESSION) headers.Cookie = process.env.BENCHI_SESSION;
  let path = "/api/v1/eval-suites";
  let method = "GET";
  let body: string | undefined;
  if (command === "validate" || command === "create") {
    if (!value) return usage(write);
    path += command === "validate" ? "/validate" : "";
    method = "POST";
    body = JSON.stringify({ source: await readFile(value, "utf8") });
    if (command === "create") headers["Idempotency-Key"] = option(args, "--idempotency-key") ?? crypto.randomUUID();
  } else if (command === "revise") {
    if (!value || !maybeFile || !option(args, "--revision")) return usage(write);
    path += `/${encodeURIComponent(value)}`;
    method = "PUT";
    body = JSON.stringify({ source: await readFile(maybeFile, "utf8") });
    headers["Idempotency-Key"] = option(args, "--idempotency-key") ?? crypto.randomUUID();
    headers["If-Match"] = option(args, "--revision")!;
  } else if (command === "get") {
    if (!value) return usage(write);
    path += `/${encodeURIComponent(value)}`;
  } else if (command !== "list") return usage(write);
  const response = await fetch(`${server}${path}`, { method, headers, body });
  const result = await response.json();
  write(JSON.stringify(result));
  return response.ok && (typeof result !== "object" || result === null || !("ok" in result) || result.ok) ? 0 : 1;
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index < 0 ? undefined : args[index + 1];
}
function usage(write: (line: string) => void): 2 {
  write("usage: benchi suite validate|create <file> | revise <id> <file> --revision <n> | list | get <id>");
  return 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCli(process.argv.slice(2));
}
