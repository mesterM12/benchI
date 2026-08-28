import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("supported Compose Installation", () => {
  it("defines disposable applications and persistent PostgreSQL and object storage", () => {
    const compose = JSON.parse(execFileSync("docker", ["compose", "--profile", "acceptance", "-f", resolve(import.meta.dirname, "../../../compose.yaml"), "config", "--format", "json"], {
      encoding: "utf8",
      env: { ...process.env, BENCHI_ADMIN_EMAIL: "admin@example.test", BENCHI_ADMIN_PASSWORD: "test-only-password", BETTER_AUTH_SECRET: "test-only-auth-secret", BACKUP_SIGNING_KEY: "test-only-backup-key", RELEASE_SIGNING_KEY: "test-only-release-key", OPENCODE_CHARACTERIZATION_MODEL: "test/provider" }
    })) as { services: Record<string, { command?: string[]; read_only?: boolean; tmpfs?: unknown; volumes?: unknown[]; healthcheck?: unknown; depends_on?: Record<string, { condition: string }> }>; volumes: Record<string, unknown> };

    expect(Object.keys(compose.services)).toEqual(expect.arrayContaining(["web", "orchestrator", "worker", "postgres", "object-storage", "bootstrap"]));
    for (const role of ["web", "orchestrator", "worker"]) {
      expect(compose.services[role]).toMatchObject({ read_only: true });
      expect(compose.services[role]!.tmpfs).toBeDefined();
    }
    expect(compose.services.bootstrap!.command?.join(" ")).toContain("bootstrap-admin");
    expect(compose.services["object-storage"]!.healthcheck).toBeDefined();
    expect(compose.services.orchestrator!.healthcheck).toBeDefined();
    expect(compose.services.worker!.healthcheck).toBeDefined();
    expect(compose.services["release-acceptance"]).toMatchObject({ command: ["sh", "scripts/release-acceptance.sh"], profiles: ["acceptance"], depends_on: { bootstrap: { condition: "service_completed_successfully" } } });
    expect(compose.services.bootstrap!.depends_on).toMatchObject({
      postgres: { condition: "service_healthy" },
      "object-storage": { condition: "service_healthy" }
    });
    expect(compose.services.web!.depends_on).toMatchObject({
      bootstrap: { condition: "service_completed_successfully" },
      orchestrator: { condition: "service_healthy" },
      worker: { condition: "service_healthy" }
    });
    expect(Object.keys(compose.volumes)).toEqual(expect.arrayContaining(["postgres-data", "object-data"]));
  });
});
