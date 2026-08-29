import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  backupTruncationLabel,
  createOwnerBackup,
  isOwnerBackupDue,
  listBackupManifests,
  summarizeBackup,
  verifyOwnerBackup,
} from "../backups";
import { listOperations } from "../operation-ledger";
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

  it("leaves a within-limits backup exactly the shape it was before truncation existed", async () => {
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));

    // The flag is ABSENT, not `false` — an old manifest and a whole one must be
    // indistinguishable, so every reader that checks `truncated` for truthiness
    // keeps answering "complete".
    expect("truncated" in created).toBe(false);
    expect("truncationReason" in created).toBe(false);
    const onDisk = JSON.parse(
      await getStorage().readFile(
        `backups/${tenantForOwner("alice")}/${created.id}/manifest.json`,
      ),
    ) as Record<string, unknown>;
    expect("truncated" in onDisk).toBe(false);
    expect("truncationReason" in onDisk).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// DW-215 — the limits truncate instead of throwing
// ---------------------------------------------------------------------------
//
// A tenant that outgrows a limit used to take the owner's whole backup down
// with it: `walkFiles` and the copy loop both THREW, so there was no manifest,
// no ledger line and nothing recovered. The limits are injected here rather
// than lowered in production, the same seam `isOwnerBackupDue`'s `intervalMs`
// uses — otherwise these cases would have to materialise 10k files or 2 GB.

describe("backups that hit a limit", () => {
  const ROOT = `tenants/${tenantForOwner("alice")}`;

  /**
   * `count` extra files, nested, so the walk has to recurse to reach a cap.
   *
   * The cases below derive their limits from the ACTUAL file count rather than
   * assuming the shared fixture's two: a case whose truncation depends on how
   * many files someone else's `beforeEach` happens to seed silently stops
   * testing anything the day that fixture grows.
   */
  async function seedExtras(count: number): Promise<void> {
    for (let index = 0; index < count; index += 1) {
      await getStorage().writeFile(`${ROOT}/wiki/deep/extra-${index}.md`, `# ${index}`);
    }
  }

  /**
   * What the tenant holds RIGHT NOW, read off disk.
   *
   * Deliberately not "take an untruncated backup and count it": the operation
   * ledger lives at `tenants/<t>/operation-ledger.json`, INSIDE the tree a
   * backup walks, so every backup grows the thing the next one measures. A
   * probe backup would move the boundary it was taken to find.
   */
  async function measureTenant(): Promise<{ count: number; bytes: number }> {
    let count = 0;
    let bytes = 0;
    const visit = async (dir: string): Promise<void> => {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) await visit(child);
        else {
          count += 1;
          bytes += (await fs.stat(child)).size;
        }
      }
    };
    await visit(path.join(tmpDir, ROOT));
    return { count, bytes };
  }

  it("stops at the file cap, records a partial backup, and still resolves", async () => {
    await seedExtras(3);
    const { count: total } = await measureTenant();
    const maxFiles = total - 2;

    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles, maxBytes: 1024 * 1024 },
    );

    // Exactly the cap — not the cap plus the one that tripped it — and strictly
    // fewer than the tenant holds, so the truncation is real whatever the
    // shared fixture seeds.
    expect(created.files).toHaveLength(maxFiles);
    expect(created.files.length).toBeLessThan(total);
    expect(created.truncated).toBe(true);
    expect(created.truncationReason).toBe("file-count");
    expect(created.totalBytes).toBe(
      created.files.reduce((sum, file) => sum + file.size, 0),
    );

    // The manifest is on disk and the ledger line says SUCCEEDED — a partial
    // backup is a backup — while naming itself partial.
    expect(await listBackupManifests("alice")).toHaveLength(1);
    const [operation] = await listOperations("alice", 10);
    expect(operation.status).toBe("succeeded");
    expect(operation.detail).toContain("partial");
    expect(operation.detail).toContain("file-count");
  });

  it("stops before the file that would pass the byte cap, counting only what was copied", async () => {
    const big = "x".repeat(4_096);
    await getStorage().writeFile(`${ROOT}/wiki/big.md`, big);

    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: 100, maxBytes: 64 },
    );

    expect(created.truncated).toBe(true);
    expect(created.truncationReason).toBe("total-bytes");
    // `totalBytes` is what LANDED, so the omitted file's bytes are not counted
    // and every entry still has real content behind it.
    expect(created.totalBytes).toBeLessThanOrEqual(64);
    expect(created.totalBytes).toBe(
      created.files.reduce((sum, file) => sum + file.size, 0),
    );
    expect(created.files.some((file) => file.path.endsWith("big.md"))).toBe(false);
  });

  // The two boundaries. `walkFiles` pushes while `files.length < maxFiles` and
  // the copy loop breaks when `totalBytes + byteLength > maxBytes`, so a tenant
  // sitting EXACTLY on either limit is the off-by-one both rewrites are most
  // likely to get wrong — and getting it wrong means marking a whole backup
  // partial, which is a lie in the safe direction but still a lie.

  it("is NOT truncated by a tenant holding exactly `maxFiles` files", async () => {
    await seedExtras(2);
    const { count: total } = await measureTenant();

    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: total, maxBytes: 1024 * 1024 },
    );

    // Sitting exactly ON the limit is whole. `walkFiles` pushes while
    // `files.length < maxFiles`, so this is the off-by-one that would mark a
    // complete backup partial — a lie in the safe direction, but still a lie.
    expect(created.files).toHaveLength(total);
    expect("truncated" in created).toBe(false);
    expect("truncationReason" in created).toBe(false);
  });

  it("is NOT truncated by a tenant holding exactly `maxBytes` bytes", async () => {
    await seedExtras(2);
    const { count: total, bytes: exact } = await measureTenant();

    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: 100, maxBytes: exact },
    );

    // The last byte that fits still fits: the copy loop breaks on
    // `totalBytes + byteLength > maxBytes`, never on `>=`.
    expect(created.totalBytes).toBe(exact);
    expect(created.files).toHaveLength(total);
    expect("truncated" in created).toBe(false);
  });

  it("IS truncated one byte under what the tenant holds", async () => {
    await seedExtras(2);
    const { bytes: exact } = await measureTenant();

    // The mirror of the case above: the boundary is a real edge, not a limit
    // nothing ever reaches.
    const over = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: 100, maxBytes: exact - 1 },
    );
    expect(over.truncated).toBe(true);
    expect(over.truncationReason).toBe("total-bytes");
    expect(over.totalBytes).toBeLessThan(exact);
  });

  it("verifies a truncated manifest, because the copied set is the manifest", async () => {
    await seedExtras(3);
    const { count: total } = await measureTenant();
    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: total - 2, maxBytes: 1024 * 1024 },
    );
    expect(created.truncated).toBe(true);

    const verified = await verifyOwnerBackup(
      "alice",
      created.id,
      new Date("2026-08-03T09:00:00.000Z"),
    );

    // Truncation is its own fact: it does not make the backup unverified or
    // failed, and it survives the verify pass's manifest rewrite.
    expect(verified.verificationStatus).toBe("passed");
    expect(verified.truncated).toBe(true);
    expect(verified.truncationReason).toBe("file-count");
  });

  it("carries the partial flags through `summarizeBackup` to the API body", async () => {
    await seedExtras(3);
    const { count: total } = await measureTenant();
    const created = await createOwnerBackup(
      "alice",
      new Date("2026-08-03T08:00:00.000Z"),
      { maxFiles: total - 2, maxBytes: 1024 * 1024 },
    );

    // The summary is what the route returns and the health desk reads. If the
    // flags stopped here, the owner-facing surface could never say "partial".
    const summary = summarizeBackup(created);
    expect(summary.truncated).toBe(true);
    expect(summary.truncationReason).toBe("file-count");
    expect(summary.fileCount).toBe(created.files.length);
    expect("files" in summary).toBe(false);
  });
});

describe("the partial-backup label", () => {
  // ONE source for this sentence: the ledger detail and the health desk row
  // both read it here, and they drifted the moment each spelled it itself.

  it("names which limit stopped the copy", () => {
    expect(backupTruncationLabel({ truncated: true, truncationReason: "file-count" }))
      .toBe("partial — stopped at the file-count limit");
    expect(backupTruncationLabel({ truncated: true, truncationReason: "total-bytes" }))
      .toBe("partial — stopped at the total-bytes limit");
  });

  it("still says partial when the reason is absent or unknown", () => {
    // A backup that says it is truncated IS truncated whether or not this build
    // knows the word for why. Calling it whole is the one wrong answer.
    expect(backupTruncationLabel({ truncated: true })).toBe(
      "partial — stopped at a safety limit",
    );
    expect(
      backupTruncationLabel({
        truncated: true,
        truncationReason: "sideways" as never,
      }),
    ).toBe("partial — stopped at a safety limit");
  });

  it("says nothing at all about a whole backup", () => {
    expect(backupTruncationLabel({})).toBeNull();
  });
});
