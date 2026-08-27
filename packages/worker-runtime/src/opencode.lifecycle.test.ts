import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentProvider } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { describe, expect, it, vi } from "vitest";
import { runOpenCodeTrial } from "./index.js";

const exec = promisify(execFile);
const deterministicAgent: AgentProvider = {
  name: "deterministic-test-agent",
  env: {},
  captureSessions: false,
  buildPrintCommand: () => ({
    command: `node -e ${JSON.stringify("require('fs').writeFileSync('failure.txt', 'inspectable'); console.log('deterministic output'); process.exit(7)")}`
  }),
  parseStreamLine: (line) => [{ type: "text", text: line }]
};

vi.mock("@ai-hero/sandcastle", async (importOriginal) => ({
  ...await importOriginal<typeof import("@ai-hero/sandcastle")>(),
  opencode: () => deterministicAgent
}));

describe("Sandcastle worktree lifecycle", () => {
  it("preserves failed work for inspection until explicit cleanup", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "benchi-lifecycle-"));
    try {
      await writeFile(join(repositoryPath, "README.md"), "fixture\n");
      await exec("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
      await exec("git", ["config", "user.name", "benchI test"], { cwd: repositoryPath });
      await exec("git", ["config", "user.email", "benchi@example.invalid"], { cwd: repositoryPath });
      await exec("git", ["add", "."], { cwd: repositoryPath });
      await exec("git", ["commit", "-m", "fixture"], { cwd: repositoryPath });

      const result = await runOpenCodeTrial({
        attemptId: "lifecycle-failure",
        repositoryPath,
        prompt: "fail deterministically",
        model: "test-only",
        sandbox: noSandbox()
      });

      expect(result.status).toBe("failed");
      expect(result.output.stdout).toEqual({ availability: "stream-events-only", text: null });
      expect(result.preservedWorktreePath).toBe(result.runtime.worktreePath);
      expect(await readFile(join(result.preservedWorktreePath!, "failure.txt"), "utf8")).toBe("inspectable");

      await unlink(join(result.preservedWorktreePath!, "failure.txt"));
      await exec("git", ["worktree", "remove", result.preservedWorktreePath!], { cwd: repositoryPath });
      await exec("git", ["branch", "-D", result.branch], { cwd: repositoryPath });
      await expect(access(result.preservedWorktreePath!)).rejects.toThrow();
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  });
});
