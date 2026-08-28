import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import { describe, expect, it } from "vitest";
import { runOpenCodeTrial } from "./index.js";

const exec = promisify(execFile);
const characterize = process.env.RUN_OPENCODE_CHARACTERIZATION === "1";

describe.runIf(characterize)("real OpenCode through Sandcastle", () => {
  it("fixes and commits a failing test in a disposable Git worktree", async () => {
    const repositoryPath = await mkdtemp(join(tmpdir(), "benchi-opencode-"));
    try {
      await writeFile(join(repositoryPath, "add.js"), "export const add = (left, right) => left - right;\n");
      await writeFile(join(repositoryPath, "add.test.js"), [
        'import assert from "node:assert/strict";',
        'import test from "node:test";',
        'import { add } from "./add.js";',
        'test("adds two numbers", () => assert.equal(add(2, 3), 5));',
        ""
      ].join("\n"));
      await writeFile(join(repositoryPath, "package.json"), '{"type":"module","scripts":{"test":"node --test"}}\n');
      await exec("git", ["init", "--initial-branch=main"], { cwd: repositoryPath });
      await exec("git", ["config", "user.name", "benchI characterization"], { cwd: repositoryPath });
      await exec("git", ["config", "user.email", "benchi@example.invalid"], { cwd: repositoryPath });
      await exec("git", ["add", "."], { cwd: repositoryPath });
      await exec("git", ["commit", "-m", "add failing task"], { cwd: repositoryPath });
      const { stdout: baseRevision } = await exec("git", ["rev-parse", "HEAD"], { cwd: repositoryPath });
      await expect(exec("npm", ["test"], { cwd: repositoryPath })).rejects.toMatchObject({ code: 1 });

      const result = await runOpenCodeTrial({
        attemptId: "real-opencode",
        repositoryPath,
        prompt: "Run npm test, fix the bug, rerun the test, commit the fix, then emit <promise>COMPLETE</promise>.",
        model: process.env.OPENCODE_CHARACTERIZATION_MODEL ?? "opencode/big-pickle",
        sandbox: noSandbox(),
        acceptanceCommand: "npm test"
      });

      expect(result.status).toBe("completed");
      expect(result.completionSignal).toBe("<promise>COMPLETE</promise>");
      expect(result.commits).toHaveLength(1);
      expect(result.acceptance).toMatchObject({ command: "npm test", exitCode: 0 });
      expect(result.branch).toBe("benchi/real-opencode");
      expect(result.preservedWorktreePath).toBeNull();
      await expect(exec("git", ["merge-base", "--is-ancestor", baseRevision.trim(), result.commits[0]!], { cwd: repositoryPath })).resolves.toBeDefined();
      const { stdout: branchRevision } = await exec("git", ["rev-parse", result.branch], { cwd: repositoryPath });
      expect(result.commits.at(-1)).toBe(branchRevision.trim());
      const { stdout: changedFiles } = await exec("git", ["diff-tree", "--no-commit-id", "--name-only", "-r", result.commits[0]!], { cwd: repositoryPath });
      expect(changedFiles.trim().split("\n")).toContain("add.js");
      await exec("git", ["checkout", result.branch], { cwd: repositoryPath });
      await expect(exec("npm", ["test"], { cwd: repositoryPath })).resolves.toMatchObject({ stderr: "" });
    } finally {
      await rm(repositoryPath, { recursive: true, force: true });
    }
  }, 10 * 60_000);
});
