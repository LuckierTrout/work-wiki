/**
 * RECORDED FSYNC BUDGETS for the filesystem write path (DW-293).
 *
 * Every whole-file write in `FilesystemStorageProvider` pays a real `fsync`, and
 * the production paths that write in a loop paid one per entry with nothing
 * bounding the total. This file is the pin: each path gets a named budget with
 * the number it spent BEFORE the batch doors existed recorded beside it, so a
 * regression fails with the figure it broke rather than with a stopwatch.
 *
 * WHY COUNTS AND NOT MILLISECONDS. A wall-clock threshold is a coin flip under a
 * parallel suite on a shared runner — the same code passes and fails depending
 * on what else is running. Syscalls are deterministic.
 *
 * TWO NUMBERS ARE MEASURED, because they answer different questions:
 *
 *   - `syncs` — how many `fsync`s the path issued. This is what per-entry
 *     durability costs, and `writeBatch` does NOT reduce it: `fsync` flushes one
 *     inode, and skipping a file's flush before its `rename` is the
 *     delayed-allocation hazard that produces zero-length files after a crash.
 *     Asserted as EQUALITY, not as a ceiling: a ceiling is met just as well by a
 *     path that stopped flushing, or stopped writing, as by one that got faster,
 *     and deleting `handle.sync()` outright would leave every ceiling green.
 *     Every row also reads back what it wrote, so "spent nothing because it did
 *     nothing" cannot pass either.
 *   - `barriers` — how many RUNS of flushes the path performed, where a run ends
 *     at the first `rename` that publishes anything. This is what `writeBatch`
 *     actually collapses: a window's flushes are all issued before any of its
 *     entries is renamed, so 64 batched entries cost two barriers instead of 64
 *     serialized flush-then-publish round-trips.
 *
 * A serialized loop publishes each file immediately after flushing it, so it
 * spends one barrier per sync — `barriers === syncs` is exactly the shape this
 * work exists to remove. Counting the runs rather than the overlap is what makes
 * the figure DETERMINISTIC: how many flushes happen to be in flight at once
 * depends on the libuv threadpool and on what else the parallel suite is doing,
 * but whether a publish separated two flushes does not.
 */
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";

/**
 * `open` is wrapped, not replaced: the provider reaches `fsync` only through a
 * `FileHandle` it got from `fs.open`, so this is the single path every sync
 * takes. `rename` is wrapped only to mark where one run of flushes ends;
 * `stat`/`readFile`/everything else stays real. Hoisted because `vi.mock` is
 * lifted above the imports.
 */
const fsyncs = vi.hoisted(() => ({ syncs: 0, barriers: 0, published: true }));

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  const open = async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args);
    return new Proxy(handle, {
      get(target, prop) {
        if (prop === "sync") {
          return async () => {
            fsyncs.syncs += 1;
            // First flush since the last publish opens a new run.
            if (fsyncs.published) {
              fsyncs.barriers += 1;
              fsyncs.published = false;
            }
            return target.sync();
          };
        }
        const value = Reflect.get(target, prop, target) as unknown;
        return typeof value === "function"
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
  };
  const rename = async (...args: Parameters<typeof actual.rename>) => {
    fsyncs.published = true;
    return actual.rename(...args);
  };
  return { ...actual, default: { ...actual, open, rename }, open, rename };
});

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { createOwnerBackup, verifyOwnerBackup } from "../backups";
import { BATCH_SYNC_WINDOW } from "../storage/filesystem";
import { preserveDocumentSources } from "../document-sources";
import { buildPortableArchive, importPortableArchive } from "../portable-archive";
import { serializeFrontmatter } from "../frontmatter";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner, wikiRelPath } from "../wiki";

// ---------------------------------------------------------------------------
// The budgets
// ---------------------------------------------------------------------------

/**
 * The batch row's size, derived from the provider's own window so that raising
 * `BATCH_SYNC_WINDOW` cannot quietly turn a two-window measurement into a
 * one-window one.
 */
const WRITE_BATCH_ENTRIES = BATCH_SYNC_WINDOW * 2;
/** One flush per entry — unchanged, and asserted EXACTLY so a lost flush fails. */
const FSYNC_BUDGET_WRITE_BATCH = WRITE_BATCH_ENTRIES;
/** …across ceil(N / BATCH_SYNC_WINDOW) barriers. Before: one barrier per entry. */
const BARRIER_BUDGET_WRITE_BATCH = WRITE_BATCH_ENTRIES / BATCH_SYNC_WINDOW;

/**
 * `importPortableArchive` restoring a 16-file archive (8 pages + 8 raw assets),
 * including both compatibility passes and the derived-index rebuild.
 * Before: 48 syncs across 48 barriers. The file count is unchanged — the same
 * bytes still have to be flushed — so it is the barrier figure that moved.
 */
const FSYNC_BUDGET_IMPORT_ARCHIVE = 48;
const BARRIER_BUDGET_IMPORT_ARCHIVE = 10;

/** `createOwnerBackup` over 16 tenant files. Before: 18 syncs, 18 barriers. */
const FSYNC_BUDGET_CREATE_BACKUP = 18;
const BARRIER_BUDGET_CREATE_BACKUP = 3;

/** `verifyOwnerBackup` over the same 16 files. Before: 18 syncs, 18 barriers. */
const FSYNC_BUDGET_VERIFY_BACKUP = 18;
const BARRIER_BUDGET_VERIFY_BACKUP = 3;

/**
 * `preserveDocumentSources` for 4 sources carrying 2 figures each, including the
 * source-index put and the page rewrite that attaches the figures.
 * Before: 21 syncs, 21 barriers.
 */
const FSYNC_BUDGET_PRESERVE_SOURCES = 21;
const BARRIER_BUDGET_PRESERVE_SOURCES = 10;

/**
 * `upsertEmbeddings` with 64 vectors: ONE whole-blob rewrite.
 * Before: 64 calls to `upsertEmbedding`, each its own whole-blob rewrite and
 * fsync — the 27 ms → 5091 ms regression this work exists to undo.
 */
const FSYNC_BUDGET_UPSERT_EMBEDDINGS = 1;

// ---------------------------------------------------------------------------
// Harness — the DATA_DIR + _resetStorage() shape the production suites use, so
// these budgets are measured through the real paths and not a provider stub.
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-bounds-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  resetCounters();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function resetCounters(): void {
  fsyncs.syncs = 0;
  fsyncs.barriers = 0;
  fsyncs.published = true;
}

const FIXTURE_FILES = 8;

function buf(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(
    value.byteOffset,
    value.byteOffset + value.byteLength,
  ) as ArrayBuffer;
}

/** The one place the tenant root is spelled, so a seed and a teardown cannot drift. */
function tenantRoot(owner: string): string {
  return `tenants/${tenantForOwner(owner)}`;
}

/** 8 pages + 8 raw assets under one owner's tenant root. */
async function seedTenant(owner: string): Promise<void> {
  const root = tenantRoot(owner);
  for (let i = 0; i < FIXTURE_FILES; i++) {
    await getStorage().writeFile(
      `${root}/wiki/page-${i}.md`,
      serializeFrontmatter(
        { owner, visibility: "public", authors: [owner] },
        `# Page ${i}\n\nBody ${i}.`,
      ),
    );
    await getStorage().writeAsset(
      `${root}/raw/page-${i}/source.bin`,
      buf(new Uint8Array([i, 1, 2])),
    );
  }
}

describe("filesystem write-path fsync budgets", () => {
  it("writeBatch keeps one fsync per entry but collapses the barriers", async () => {
    const entries = Array.from({ length: WRITE_BATCH_ENTRIES }, (_, i) => ({
      path: `batch/file-${i}.md`,
      body: `body ${i}`,
    }));

    resetCounters();
    await getStorage().writeBatch(entries);

    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_WRITE_BATCH);
    expect(fsyncs.barriers).toBe(BARRIER_BUDGET_WRITE_BATCH);

    // Load-bearing: a budget met by writing fewer files would be a regression
    // dressed as an improvement.
    for (let i = 0; i < WRITE_BATCH_ENTRIES; i++) {
      expect(await getStorage().readFile(`batch/file-${i}.md`)).toBe(`body ${i}`);
    }
  });

  it("importPortableArchive stays inside its budget", async () => {
    await seedTenant("alice");
    const archive = await buildPortableArchive("alice");
    await getStorage().deleteDirectory(tenantRoot("alice"));

    resetCounters();
    const result = await importPortableArchive("alice", buf(archive.bytes), "overwrite");

    expect(result.imported).toBe(FIXTURE_FILES * 2);
    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_IMPORT_ARCHIVE);
    expect(fsyncs.barriers).toBe(BARRIER_BUDGET_IMPORT_ARCHIVE);

    // The bytes actually came back — canonical path, compatibility path, and a
    // binary asset, which is every write shape the import performs.
    const restored = await getStorage().readFile(
      `${tenantRoot("alice")}/wiki/page-0.md`,
    );
    expect(restored).toContain("Body 0.");
    expect(await getStorage().readFile("wiki/page-0.md")).toBe(restored);
    expect(
      Buffer.from(
        await getStorage().readAsset(`${tenantRoot("alice")}/raw/page-7/source.bin`),
      ),
    ).toEqual(Buffer.from([7, 1, 2]));
  });

  it("createOwnerBackup and verifyOwnerBackup stay inside their budgets", async () => {
    await seedTenant("alice");

    resetCounters();
    const created = await createOwnerBackup("alice", new Date("2026-08-03T08:00:00.000Z"));
    expect(created.files).toHaveLength(FIXTURE_FILES * 2);
    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_CREATE_BACKUP);
    expect(fsyncs.barriers).toBe(BARRIER_BUDGET_CREATE_BACKUP);

    // Every copy is really on disk, at the size the manifest claims — the
    // manifest alone would be satisfied by a loop that wrote nothing.
    for (const file of created.files) {
      const copied = await getStorage().readAsset(file.backupPath);
      expect(copied.byteLength).toBe(file.size);
    }

    resetCounters();
    const verified = await verifyOwnerBackup(
      "alice",
      created.id,
      new Date("2026-08-03T09:00:00.000Z"),
    );
    // "passed" means every file was written into the verification prefix and
    // read back at its expected digest, so this row's read-back is the assertion
    // the function itself performs — the file count keeps it from passing
    // vacuously on an empty manifest.
    expect(verified.verificationStatus).toBe("passed");
    expect(verified.verificationError).toBeUndefined();
    expect(verified.files).toHaveLength(FIXTURE_FILES * 2);
    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_VERIFY_BACKUP);
    expect(fsyncs.barriers).toBe(BARRIER_BUDGET_VERIFY_BACKUP);
  });

  it("preserveDocumentSources stays inside its budget", async () => {
    await getStorage().writeFile(
      wikiRelPath("source.md"),
      serializeFrontmatter(
        { owner: "alice", visibility: "public", authors: ["alice"] },
        "# Source\n\nA source page.",
      ),
    );
    const sources = Array.from({ length: 4 }, (_, i) => ({
      bytes: buf(new Uint8Array([i, 9, 9, 9])),
      filename: `doc-${i}.docx`,
      contentType: "application/octet-stream",
      extracted: {
        format: "docx" as const,
        title: `Doc ${i}`,
        text: "text",
        metadata: {},
        assets: [0, 1].map((a) => ({
          filename: `img-${a}.png`,
          mediaType: "image/png",
          bytes: buf(new Uint8Array([i, a, 7])),
          alt: `alt ${a}`,
          context: `ctx ${a}`,
        })),
      },
    }));

    resetCounters();
    const stored = await preserveDocumentSources("source", "alice", sources);

    expect(stored).toHaveLength(4);
    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_PRESERVE_SOURCES);
    expect(fsyncs.barriers).toBe(BARRIER_BUDGET_PRESERVE_SOURCES);

    // Originals and figures both landed, for every source.
    for (const [index, record] of stored.entries()) {
      expect(
        Buffer.from(await getStorage().readAsset(record.originalKey)),
      ).toEqual(Buffer.from([index, 9, 9, 9]));
      expect(record.assets).toHaveLength(2);
      for (const [assetIndex, asset] of record.assets.entries()) {
        const name = asset.publicPath.slice("/api/assets/source/".length);
        expect(
          Buffer.from(await getStorage().readAsset(`raw/assets/source/${name}`)),
        ).toEqual(Buffer.from([index, assetIndex, 7]));
      }
    }
  });

  it("upsertEmbeddings writes the vector blob once, not once per vector", async () => {
    const entries = Array.from({ length: 64 }, (_, i) => ({
      id: `page-${i}`,
      vector: [i, 1],
      metadata: { model: "m", contentHash: `h${i}` },
    }));

    resetCounters();
    await getStorage().upsertEmbeddings(entries);

    expect(fsyncs.syncs).toBe(FSYNC_BUDGET_UPSERT_EMBEDDINGS);
    expect(await getStorage().getEmbeddingById("page-0")).toEqual(entries[0]);
    expect(await getStorage().getEmbeddingById("page-63")).toEqual(entries[63]);
    expect(await getStorage().queryEmbeddings([1, 1], 200)).toHaveLength(64);
  });
});
