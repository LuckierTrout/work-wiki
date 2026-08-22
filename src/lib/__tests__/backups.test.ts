import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createOwnerBackup,
  isOwnerBackupDue,
  listBackupManifests,
  summarizeBackup,
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
  vi.restoreAllMocks();
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

  // -------------------------------------------------------------------------
  // Degradation at the safety limits (DW-215)
  // -------------------------------------------------------------------------
  //
  // The limits used to THROW, which meant a tenant that outgrew them lost its
  // backup entirely — the owner's only recovery path switched off by the very
  // growth it exists to survive. The decision is to stop at the limit, keep a
  // real verifiable manifest of what fit, and say partial out loud. The limits
  // are injected here so the rows are exercised without a 2 GB fixture.

  const SPACIOUS = { maxFiles: 10_000, maxBytes: 2 * 1024 * 1024 * 1024 };

  /** The two seeded tenant files' sizes, so a byte budget need not be guessed. */
  async function seededSizes(): Promise<number[]> {
    const root = `tenants/${tenantForOwner("alice")}`;
    return Promise.all(
      [`${root}/wiki/plan.md`, `${root}/raw/plan/source.bin`].map(async (path) =>
        (await getStorage().readAsset(path)).byteLength,
      ),
    );
  }

  it("stops at the file limit and flags the manifest instead of throwing", async () => {
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxFiles: 1,
    });

    expect(created.files).toHaveLength(1);
    expect(created.truncated).toEqual(["file-count"]);
    // Partial, not failed: the copy it DID make is real.
    const [only] = created.files;
    expect((await getStorage().readAsset(only.backupPath)).byteLength).toBe(only.size);
  });

  it("stops BEFORE the file that would cross the byte limit, so totalBytes describes real copies", async () => {
    const sizes = await seededSizes();
    // One short of the whole tenant: whichever file the walk reaches first fits,
    // and the second one cannot — regardless of listing order.
    const maxBytes = sizes[0] + sizes[1] - 1;

    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxBytes,
    });

    expect(created.truncated).toEqual(["total-bytes"]);
    expect(created.files).toHaveLength(1);
    expect(created.totalBytes).toBeLessThanOrEqual(maxBytes);
    // The offending file is absent from `files` AND was never copied — an entry
    // counted but not written would describe a backup that does not exist.
    expect(created.totalBytes).toBe(
      created.files.reduce((sum, file) => sum + file.size, 0),
    );
    for (const file of created.files) {
      expect((await getStorage().readAsset(file.backupPath)).byteLength).toBe(file.size);
    }
  });

  it("does NOT flag a tenant that ends EXACTLY at the file limit", async () => {
    // The boundary the flag's shape lives on. `truncated` must mean "a FILE was
    // left out", not "the budget was reached".
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxFiles: 2,
    });

    expect(created.files).toHaveLength(2);
    expect("truncated" in created).toBe(false);
  });

  it("does NOT flag an exact fit that still has an empty directory left to descend into", async () => {
    // The interleaving the plain exact-fit row above cannot reach: the budget is
    // met, and only then does a DIRECTORY come up. A guard at the top of the walk
    // loop calls that truncation — parking a complete backup on "attention"
    // forever over a directory that held nothing — while a guard on the push
    // asks the only question that matters: was a file left out?
    //
    // `readdir` order is arbitrary, so the listing is sorted here to pin this one
    // interleaving rather than leave the row depending on which order the
    // filesystem happened to return.
    const root = `tenants/${tenantForOwner("alice")}`;
    await fs.mkdir(path.join(tmpDir, `${root}/zz-empty`), { recursive: true });
    const storage = getStorage();
    const realList = storage.listFiles.bind(storage);
    vi.spyOn(storage, "listFiles").mockImplementation(async (prefix) =>
      [...await realList(prefix)].sort((a, b) => a.name.localeCompare(b.name)),
    );

    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxFiles: 2,
    });

    // raw/plan/source.bin, then wiki/plan.md fills the budget, and `zz-empty` is
    // visited after — a complete backup of every file the tenant holds.
    expect(created.files).toHaveLength(2);
    expect("truncated" in created).toBe(false);
  });

  it("does NOT flag a tenant whose bytes come to EXACTLY the byte limit", async () => {
    const sizes = await seededSizes();
    const exact = sizes[0] + sizes[1];

    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxBytes: exact,
    });

    // The last file FITS at the boundary — the check is "would adding it go
    // OVER", so `>=` here would drop a file the tenant had room for.
    expect(created.files).toHaveLength(2);
    expect(created.totalBytes).toBe(exact);
    expect("truncated" in created).toBe(false);
  });

  it("names BOTH limits, file-count first, when one run reaches each of them", async () => {
    // A third file of the same size as the largest seeded one, so the outcome
    // does not depend on the order `listFiles` happens to return: whichever two
    // files the walk reaches, the third is left out (file count) and the second
    // one copied would cross 27 bytes (total size).
    const root = `tenants/${tenantForOwner("alice")}`;
    await getStorage().writeFile(`${root}/wiki/notes.md`, "S".repeat(25));
    expect(await seededSizes()).toEqual([25, 4]);

    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      maxFiles: 2,
      maxBytes: 27,
    });

    // Order is part of the contract — the walk runs before the copy, so
    // "file-count" is always pushed first.
    expect(created.truncated).toEqual(["file-count", "total-bytes"]);
    expect(created.files).toHaveLength(1);
    expect(created.totalBytes).toBeLessThanOrEqual(27);
  });

  it("carries NO truncated field when the tenant fits inside both limits", async () => {
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));

    expect(created.files).toHaveLength(2);
    // Absent, not an empty array — that is what keeps every `version: 1`
    // manifest already on disk parsing as exactly what it is.
    expect("truncated" in created).toBe(false);
    expect(Object.keys(summarizeBackup(created)).sort()).toEqual([
      "createdAt",
      "fileCount",
      "id",
      "owner",
      "tenant",
      "totalBytes",
      "version",
    ]);
  });

  it("verifies a truncated backup — a manifest checks exactly the entries it holds", async () => {
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"), {
      ...SPACIOUS,
      maxFiles: 1,
    });

    const verified = await verifyOwnerBackup("alice", created.id, new Date("2026-08-03T09:00:00.000Z"));

    expect(verified.verificationStatus).toBe("passed");
    // The flag survives the manifest round-trip, so "verified" never erases
    // "partial" for whoever reads it back.
    expect(verified.truncated).toEqual(["file-count"]);
    expect((await listBackupManifests("alice"))[0].truncated).toEqual(["file-count"]);
  });

  it("reports whether the daily backup interval has elapsed", async () => {
    expect(await isOwnerBackupDue("alice", new Date("2026-08-03T08:00:00.000Z"))).toBe(true);
    await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));
    expect(await isOwnerBackupDue("alice", new Date("2026-08-03T20:00:00.000Z"))).toBe(false);
    expect(await isOwnerBackupDue("alice", new Date("2026-08-04T09:00:00.000Z"))).toBe(true);
  });
});
