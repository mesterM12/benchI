import { describe, expect, it } from "vitest";
import { OperationsApplication } from "./index.js";

const keys = { backup: "backup-key", release: "release-key" };

describe("Compose Installation operations", () => {
  it("restores an authenticated Backup Set in quarantine before opening independent Admission gates", () => {
    const source = new OperationsApplication(keys, { evalRuns: 3 });
    const backup = source.createBackupSet([{ name: "schema", passed: true }, { name: "objects", passed: true }]);
    const restored = new OperationsApplication(keys);

    expect(restored.restoreBackupSet(backup)).toEqual({ status: "quarantined", recoverySafetyRecords: 2 });
    expect(restored.admission()).toEqual({ read: false, scheduling: false });
    expect(restored.openReadAdmission()).toEqual({ read: true, scheduling: false });
    expect(restored.openSchedulingAdmission()).toEqual({ read: true, scheduling: true });
    expect(restored.data()).toEqual({ evalRuns: 3 });
  });

  it.each([
    ["corruption", (backup: ReturnType<OperationsApplication["createBackupSet"]>) => ({ ...backup, payload: `${backup.payload}x` }), "BACKUP_AUTHENTICATION_FAILED"],
    ["missing key", (backup: ReturnType<OperationsApplication["createBackupSet"]>) => backup, "BACKUP_KEY_MISSING"]
  ])("rejects %s before Admission", (_, alter, code) => {
    const source = new OperationsApplication(keys, { evalRuns: 3 });
    const backup = alter(source.createBackupSet([{ name: "schema", passed: true }]));
    const restored = new OperationsApplication(code === "BACKUP_KEY_MISSING" ? { release: keys.release } : keys);

    expect(() => restored.restoreBackupSet(backup)).toThrow(code);
    expect(restored.admission()).toEqual({ read: false, scheduling: false });
  });

  it("keeps Admission closed when a Recovery Safety Record fails", () => {
    const source = new OperationsApplication(keys);
    const backup = source.createBackupSet([{ name: "schema", passed: false }]);
    const restored = new OperationsApplication(keys);

    expect(() => restored.restoreBackupSet(backup)).toThrow("RECOVERY_SAFETY_FAILED:schema");
    expect(restored.admission()).toEqual({ read: false, scheduling: false });
  });

  it("verifies, migrates, and explicitly finalizes a signed release", () => {
    const operations = new OperationsApplication(keys, { schemaVersion: 1 });
    operations.openReadAdmission();
    operations.openSchedulingAdmission();
    const release = operations.signRelease({ version: "2.0.0", fromSchema: 1, toSchema: 2 });

    expect(operations.beginUpgrade(release)).toMatchObject({ status: "awaiting-finalization", fromSchema: 1, toSchema: 2, rollbackAllowed: true });
    expect(operations.admission()).toEqual({ read: false, scheduling: false });
    expect(operations.data()).toMatchObject({ schemaVersion: 2 });
    expect(operations.finalizeUpgrade()).toMatchObject({ status: "finalized", version: "2.0.0" });
    expect(operations.admission()).toEqual({ read: true, scheduling: false });
  });

  it("rolls an interrupted upgrade back before its finalization boundary", () => {
    const operations = new OperationsApplication(keys, { schemaVersion: 1, evalRuns: 3 });
    const release = operations.signRelease({ version: "2.0.0", fromSchema: 1, toSchema: 2 });

    operations.beginUpgrade(release);
    expect(operations.rollbackUpgrade("migration interrupted")).toMatchObject({ status: "rolled-back", error: "migration interrupted" });
    expect(operations.data()).toEqual({ schemaVersion: 1, evalRuns: 3 });
    expect(operations.admission()).toEqual({ read: false, scheduling: false });
  });

  it("rejects an unsigned release without migration", () => {
    const operations = new OperationsApplication(keys, { schemaVersion: 1 });
    const release = { ...operations.signRelease({ version: "2.0.0", fromSchema: 1, toSchema: 2 }), signature: "bad" };

    expect(() => operations.beginUpgrade(release)).toThrow("RELEASE_SIGNATURE_INVALID");
    expect(operations.data()).toEqual({ schemaVersion: 1 });
  });

  it("rejects a failed preflight without migration", () => {
    const operations = new OperationsApplication(keys, { schemaVersion: 1 });
    const release = operations.signRelease({ version: "2.0.0", fromSchema: 9, toSchema: 10 });

    expect(() => operations.beginUpgrade(release)).toThrow("UPGRADE_PREFLIGHT_FAILED");
    expect(operations.data()).toEqual({ schemaVersion: 1 });
  });

  it("redacts credentials from support bundles", () => {
    const operations = new OperationsApplication(keys);

    expect(operations.createSupportBundle({
      version: "1.0.0",
      environment: { DATABASE_URL: "postgres://admin:secret@db/benchi", NODE_ENV: "production" },
      recentEvents: [{ authorization: "Bearer private", message: "healthy" }]
    })).toEqual({
      version: "1.0.0",
      environment: { DATABASE_URL: "[REDACTED]", NODE_ENV: "production" },
      recentEvents: [{ authorization: "[REDACTED]", message: "healthy" }]
    });
  });
});
