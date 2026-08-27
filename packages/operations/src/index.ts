import { createHmac, timingSafeEqual } from "node:crypto";

export type Admission = { read: boolean; scheduling: boolean };
export type RecoverySafetyRecord = { name: string; passed: boolean };
export type BackupSet = { payload: string; signature: string };
export type Release = { version: string; fromSchema: number; toSchema: number; signature: string };
export type UpgradeReport = {
  status: "awaiting-finalization" | "finalized" | "rolled-back";
  version: string;
  fromSchema: number;
  toSchema: number;
  rollbackAllowed: boolean;
  error?: string;
};

type Keys = { backup?: string; release?: string };

export class OperationsApplication {
  #admission: Admission = { read: false, scheduling: false };
  #data: Record<string, unknown>;
  #upgrade?: { report: UpgradeReport; previousData: Record<string, unknown> };

  constructor(private readonly keys: Keys, data: Record<string, unknown> = {}) {
    this.#data = structuredClone(data);
  }

  createBackupSet(recoverySafetyRecords: RecoverySafetyRecord[]): BackupSet {
    if (!this.keys.backup) throw new Error("BACKUP_KEY_MISSING");
    const payload = JSON.stringify({ data: this.#data, recoverySafetyRecords });
    return { payload, signature: sign(payload, this.keys.backup) };
  }

  restoreBackupSet(backup: BackupSet): { status: "quarantined"; recoverySafetyRecords: number } {
    if (!this.keys.backup) throw new Error("BACKUP_KEY_MISSING");
    if (!authenticated(backup.payload, backup.signature, this.keys.backup)) throw new Error("BACKUP_AUTHENTICATION_FAILED");
    const restored = JSON.parse(backup.payload) as { data: Record<string, unknown>; recoverySafetyRecords: RecoverySafetyRecord[] };
    for (const record of restored.recoverySafetyRecords) {
      if (!record.passed) throw new Error(`RECOVERY_SAFETY_FAILED:${record.name}`);
    }
    this.#data = structuredClone(restored.data);
    this.#admission = { read: false, scheduling: false };
    return { status: "quarantined", recoverySafetyRecords: restored.recoverySafetyRecords.length };
  }

  admission(): Admission {
    return { ...this.#admission };
  }

  openReadAdmission(): Admission {
    this.#admission.read = true;
    return this.admission();
  }

  openSchedulingAdmission(): Admission {
    this.#admission.scheduling = true;
    return this.admission();
  }

  data(): Record<string, unknown> {
    return structuredClone(this.#data);
  }

  signRelease(release: Omit<Release, "signature">): Release {
    if (!this.keys.release) throw new Error("RELEASE_KEY_MISSING");
    return { ...release, signature: sign(releaseManifest(release), this.keys.release) };
  }

  beginUpgrade(release: Release): UpgradeReport {
    if (!this.keys.release) throw new Error("RELEASE_KEY_MISSING");
    if (!authenticated(releaseManifest(release), release.signature, this.keys.release)) throw new Error("RELEASE_SIGNATURE_INVALID");
    if (this.#upgrade || this.#data.schemaVersion !== release.fromSchema) throw new Error("UPGRADE_PREFLIGHT_FAILED");
    const report: UpgradeReport = { status: "awaiting-finalization", version: release.version, fromSchema: release.fromSchema, toSchema: release.toSchema, rollbackAllowed: true };
    this.#upgrade = { report, previousData: structuredClone(this.#data) };
    this.#admission = { read: false, scheduling: false };
    this.#data.schemaVersion = release.toSchema;
    return structuredClone(report);
  }

  finalizeUpgrade(): UpgradeReport {
    if (!this.#upgrade) throw new Error("UPGRADE_NOT_PENDING");
    this.#upgrade.report = { ...this.#upgrade.report, status: "finalized", rollbackAllowed: false };
    this.#admission = { read: true, scheduling: false };
    const report = structuredClone(this.#upgrade.report);
    this.#upgrade = undefined;
    return report;
  }

  rollbackUpgrade(error: string): UpgradeReport {
    if (!this.#upgrade) throw new Error("UPGRADE_ROLLBACK_UNAVAILABLE");
    this.#data = this.#upgrade.previousData;
    const report: UpgradeReport = { ...this.#upgrade.report, status: "rolled-back", error };
    this.#upgrade = undefined;
    return structuredClone(report);
  }

  createSupportBundle<T>(diagnostics: T): T {
    return redact(diagnostics) as T;
  }
}

function releaseManifest(release: Omit<Release, "signature">): string {
  return JSON.stringify({ version: release.version, fromSchema: release.fromSchema, toSchema: release.toSchema });
}

function sign(value: string, key: string): string {
  return createHmac("sha256", key).update(value).digest("hex");
}

function authenticated(value: string, signature: string, key: string): boolean {
  const expected = Buffer.from(sign(value, key), "hex");
  const supplied = Buffer.from(signature, "hex");
  return expected.length === supplied.length && timingSafeEqual(expected, supplied);
}

function redact(value: unknown, key = ""): unknown {
  if (/authorization|cookie|credential|database_url|password|secret|token/i.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, entry]) => [name, redact(entry, name)]));
  return value;
}
