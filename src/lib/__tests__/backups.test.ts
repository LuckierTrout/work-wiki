import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createOwnerBackup,
  isOwnerBackupDue,
  listBackupManifests,
  verifyOwnerBackup,
} from "../backups";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "backups-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  const root = `tenants/${tenantForOwner("alice")}`;
  await getStorage().writeFile(`${root}/wiki/plan.md`, "# Plan\n\nImportant memory.");
  await getStorage().writeAsset(`${root}/raw/plan/source.bin`, new Uint8Array([0, 1, 2, 255]).buffer);
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("owner backups", () => {
  it("copies text and binary tenant data and verifies an isolated restore", async () => {
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));
    expect(created.files).toHaveLength(2);
    expect(created.files.every((file) => file.sha256.length === 64)).toBe(true);
    const verified = await verifyOwnerBackup("alice", created.id, new Date("2026-08-03T09:00:00.000Z"));
    expect(verified.verificationStatus).toBe("passed");
    expect(await listBackupManifests("alice")).toHaveLength(1);
    expect(await getStorage().readFile(`tenants/${tenantForOwner("alice")}/wiki/plan.md`)).toContain("Important memory");
  });

  it("reports whether the daily backup interval has elapsed", async () => {
    expect(await isOwnerBackupDue("alice", new Date("2026-08-03T08:00:00.000Z"))).toBe(true);
    await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));
    expect(await isOwnerBackupDue("alice", new Date("2026-08-03T20:00:00.000Z"))).toBe(false);
    expect(await isOwnerBackupDue("alice", new Date("2026-08-04T09:00:00.000Z"))).toBe(true);
  });
});
