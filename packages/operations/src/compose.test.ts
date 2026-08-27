import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("supported Compose Installation", () => {
  it("defines disposable applications and persistent PostgreSQL and object storage", () => {
    const compose = JSON.parse(execFileSync("docker", ["compose", "-f", resolve(import.meta.dirname, "../../../compose.yaml"), "config", "--format", "json"], {
      encoding: "utf8",
      env: { ...process.env, BENCHI_ADMIN_EMAIL: "admin@example.test", BENCHI_ADMIN_PASSWORD: "test-only-password", BETTER_AUTH_SECRET: "test-only-auth-secret", BACKUP_SIGNING_KEY: "test-only-backup-key", RELEASE_SIGNING_KEY: "test-only-release-key" }
    })) as { services: Record<string, { command?: string[]; read_only?: boolean; tmpfs?: unknown; volumes?: unknown[] }>; volumes: Record<string, unknown> };

    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(["web", "orchestrator", "worker", "postgres", "object-storage", "bootstrap"]));
    for (const role of ["web", "orchestrator", "worker"]) {
      expect(compose.services[role]).toMatchObject({ read_only: true });
      expect(compose.services[role]!.tmpfs).toBeDefined();
    }
    expect(compose.services.bootstrap!.command?.join(" ")).toContain("bootstrap-admin");
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(["postgres-data", "object-data"]));
  });
});
