/**
 * DW-293 / DW-679 — recorded durability-barrier bounds.
 *
 * WHAT THIS SUITE IS. Every whole-file write on the filesystem provider ends in
 * a real fsync, and the paths that write in a LOOP used to pay one per file (two,
 * before the publication lock's gratuitous fsync went). Nothing bounded that:
 * an archive import, a backup copy and a vector-store rebuild each cost barriers
 * proportional to their input, and a regression that reintroduced a per-item
 * fsync would pass every correctness test in the repo.
 *
 * WHY A COUNT, NOT A CLOCK. Wall-clock under a parallel suite is dominated by
 * contention, not by the work — the numbers that motivated this change (a
 * contributor path measured at 27ms and then at 5091ms) say more about what else
 * was running than about the write path. The invariant underneath them is "one
 * barrier per write", and a COUNT of fsync calls is deterministic across
 * machines, cores and disks.
 *
 * WHY BOTH N AND 3N FOR THE LOOP PATHS. An import or a backup also does fixed
 * work — a manifest, an index reconstruction, a derived-index rebuild — and that
 * fixed cost is large enough to hide a per-item regression inside a single
 * total. So each loop path is measured at N and again at 3N items: the MARGINAL
 * cost, (barriers at 3N − barriers at N) / 2N, cancels the fixed writes and
 * leaves only what scales. Both totals are asserted EXACTLY as well, because a
 * marginal bound alone cannot see a fixed-cost blow-up.
 *
 * WHAT THE BOUNDS CLAIM — and what they do not. The door spends ONE BARRIER PER
 * DIRECTORY. On a flat fixture the directory count is constant in N, so the
 * marginal cost is 0 BY CONSTRUCTION and a suite that measured only that would
 * be measuring its own fixture. Every loop path is therefore measured twice,
 * flat and nested, and the nested shape — one directory per item, which is what
 * `raw/sources/<slug>/<id>.<ext>` gives a real tenant — is where the marginal
 * cost comes back to 1–2 per item. That is the true claim: per directory, not
 * per file.
 *
 * HOW THE COUNT IS TAKEN. `FileHandle` is not exported and `node:fs/promises` is
 * an ESM namespace vitest cannot spy on, so the seam is the prototype every
 * handle shares: open one file, take `Object.getPrototypeOf(handle)`, wrap
 * `sync`. The wrapper asks the handle whether its fd is a directory, which is
 * what separates a batch's ONE directory barrier from a per-file payload fsync.
 * Patched in `beforeEach`, restored in `afterEach`.
 *
 * EVERY BOUND BELOW RECORDS THE MEASUREMENT THAT PRODUCED IT. A bound that is
 * beaten is not a failure — tighten it, and say what it measures now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// The embed call is the only thing in `rebuildVectorStore` that would reach a
// network; everything else this suite measures is real.
vi.mock("ai", () => ({ embed: vi.fn(), embedMany: vi.fn() }));

// No Workers bindings here: the filesystem provider is the whole point.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => {
    throw new Error("no cloudflare context");
  }),
}));

// Only the vector switch is forced on; every other config door stays real so
// the archive and backup paths behave exactly as they do in production.
vi.mock("../config", async () => {
  const actual = await vi.importActual<typeof import("../config")>("../config");
  return {
    ...actual,
    // A plain function, not a `vi.fn`: this switch must survive every
    // between-test mock reset, since a rebuild that never ran measures nothing.
    getVectorSearchSettings: () => ({
      enabled: true,
      provider: "openai" as const,
      model: "text-embedding-3-small",
      baseUrl: undefined,
    }),
  };
});

import { embed } from "ai";
// `../embeddings` FIRST, deliberately. `vi.mock("../config", …)` only reaches
// `embeddings.ts`'s own `./config` import when the mocked module is first
// pulled into the graph THROUGH a module under test rather than by this file
// directly — import it after something that loads `config.ts` unmocked and
// `rebuildVectorStore` reads the real, disabled vector switch and refuses to run.
import { EMBEDDING_FLUSH_BATCH, rebuildVectorStore } from "../embeddings";
import { createOwnerBackup } from "../backups";
import { buildPortableArchive, importPortableArchive } from "../portable-archive";
import { _resetStorage, getStorage } from "../storage";
import { updateIndex, writeWikiPage } from "../wiki";

// ---------------------------------------------------------------------------
// Recorded bounds
// ---------------------------------------------------------------------------

/**
 * A single unbatched `writeFile`: the payload fsync, and nothing else.
 *
 * MEASURED: 1. It was 2 before this change — the second was
 * `withFilesystemPublicationLock` fsyncing the lock file it creates, whose
 * contents nothing has ever read.
 */
const UNBATCHED_WRITE_BARRIERS = 1;

/**
 * Twelve unbatched writes — the shape the batch door exists to replace.
 *
 * MEASURED: 12. This is not a bound to improve; it is the CONTROL the batched
 * run is compared against, and it must stay one-per-write.
 */
const UNBATCHED_TWELVE_WRITES_BARRIERS = 12;

/**
 * One batch, one directory, twelve members.
 *
 * MEASURED: 1 (against 12 for the same twelve writes unbatched).
 */
const BATCH_ONE_DIRECTORY_BARRIERS = 1;

/**
 * One batch spanning three directories, twelve members.
 *
 * MEASURED: 3 — one per DISTINCT directory, not one per member and not one per
 * scope.
 */
const BATCH_THREE_DIRECTORIES_BARRIERS = 3;

/**
 * WHAT THE DOOR ACTUALLY BUYS, and the honest claim these four constants pin.
 *
 * A batch spends ONE barrier PER DIRECTORY, not one per batch and not one per
 * file. So the saving a real caller sees is decided entirely by the SHAPE of
 * what it writes, and a benchmark that only ever writes flat fixtures measures
 * its own fixture rather than the door:
 *
 *   - FLAT — every member lands in the same directory (`wiki/page-N.md`,
 *     `raw/asset-N.bin`). The directory count is constant in N, so the marginal
 *     cost per item really is 0. This is the best case, and it is NOT what a
 *     real tenant looks like.
 *   - NESTED — one directory per item, which is the production shape:
 *     `raw/sources/<slug>/<id>.<ext>` gives a Source its own directory, and the
 *     archive import writes each one TWICE (tenant path + flat compatibility
 *     path), in two different directories. Here a per-directory barrier trends
 *     back toward one per file, and the batch saves the payload fsyncs but not
 *     the directory barriers.
 *
 * Both shapes are measured below, and both bounds are EXACT totals rather than
 * ceilings: with a ceiling of 0, a run that spends FEWER barriers passes just as
 * happily, so a fixed-cost blow-up elsewhere on the path stays invisible.
 */

/** `importPortableArchive`, all entries in one directory. MEASURED: 12 at N=4 AND at N=12 (marginal 0). */
const IMPORT_FLAT_BARRIERS = { small: 12, large: 12 } as const;

/** `createOwnerBackup`, all files in one directory. MEASURED: 3 at N=4 AND at N=12 (marginal 0). */
const BACKUP_FLAT_BARRIERS = { small: 3, large: 3 } as const;

/**
 * `importPortableArchive`, one directory per entry — the production shape.
 *
 * MEASURED: 18 at N=4, 34 at N=12 → marginal 2 per entry, which is exactly the
 * two directories each entry creates (its tenant path and its flat compatibility
 * path). NOT 0, and it is not supposed to be: the door charges per directory.
 *
 * What the batch still buys here is the payload fsyncs. With it switched off the
 * same measurement reads 29 → 61, i.e. 4 per entry — so the batch removes half
 * the marginal cost on this shape and all of it on the flat one.
 */
const IMPORT_NESTED_BARRIERS = { small: 18, large: 34 } as const;

/**
 * `createOwnerBackup`, one directory per file — the production shape.
 *
 * MEASURED: 6 at N=4, 14 at N=12 → marginal 1 per file: each source file gets
 * its own destination directory under the backup prefix.
 *
 * With the payload fsync switched back on: 10 → 26, i.e. 2 per file.
 */
const BACKUP_NESTED_BARRIERS = { small: 6, large: 14 } as const;

/** Items in the small and large runs of every marginal measurement. */
const SMALL_N = 4;
const LARGE_N = 12;

/** Pages seeded for the rebuild bound — deliberately not a multiple of 32. */
const REBUILD_PAGES = 40;

/**
 * The real constant, imported rather than copied — a hand-written 32 here would
 * let `embeddings.ts` change while the bound meant to express it silently did not.
 */
const REBUILD_FLUSH_BATCH = EMBEDDING_FLUSH_BATCH;

/**
 * How many times a rebuild may store the whole embeddings index.
 *
 * `ceil(N / 32)` flushes plus one of slack, so a change to where the tail flush
 * falls does not need this file edited. MEASURED at N = 40: 2 stores (one full
 * batch of 32, one tail of 8), against a bound of 3.
 *
 * Before this change it was N: the provider reloaded, rewrote and fsynced the
 * entire blob once per vector.
 */
const REBUILD_INDEX_STORES =
  Math.ceil(REBUILD_PAGES / REBUILD_FLUSH_BATCH) + 1;

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalDataDir: string | undefined;
let originalModel: string | undefined;
let originalOpenAiKey: string | undefined;

let handleProto: { sync: () => Promise<void> } | null = null;
let originalSync: (() => Promise<void>) | null = null;
let fileSyncs = 0;
let directorySyncs = 0;

/** Barriers since the last {@link resetBarriers}, of both kinds. */
function barriers(): number {
  return fileSyncs + directorySyncs;
}

function resetBarriers(): void {
  fileSyncs = 0;
  directorySyncs = 0;
}

/** Wipe DATA_DIR back to empty and drop the provider singleton pointing at it. */
async function freshDataDir(): Promise<void> {
  await fs.rm(tmpDir, { recursive: true, force: true });
  await fs.mkdir(tmpDir, { recursive: true });
  _resetStorage();
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "write-batching-bounds-"));
  originalDataDir = process.env.DATA_DIR;
  originalModel = process.env.EMBEDDING_MODEL;
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.DATA_DIR = tmpDir;
  process.env.EMBEDDING_MODEL = "text-embedding-3-small";
  process.env.OPENAI_API_KEY = "sk-test";
  _resetStorage();

  // Grab the shared FileHandle prototype from a throwaway handle.
  const probePath = path.join(tmpDir, ".barrier-probe");
  const probe = await fs.open(probePath, "w");
  handleProto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
  await probe.close();
  await fs.rm(probePath, { force: true });
  originalSync = handleProto.sync;
  handleProto.sync = async function patched(this: fs.FileHandle) {
    if ((await this.stat()).isDirectory()) directorySyncs += 1;
    else fileSyncs += 1;
    return originalSync!.call(this);
  };
  resetBarriers();
});

afterEach(async () => {
  if (handleProto && originalSync) handleProto.sync = originalSync;
  handleProto = null;
  originalSync = null;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalModel === undefined) delete process.env.EMBEDDING_MODEL;
  else process.env.EMBEDDING_MODEL = originalModel;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The door itself
// ---------------------------------------------------------------------------

describe("write barrier bounds — the batch door", () => {
  it("charges an unbatched write exactly one barrier", async () => {
    resetBarriers();
    await getStorage().writeFile("bounds/solo.md", "solo");

    expect(barriers()).toBe(UNBATCHED_WRITE_BARRIERS);
  });

  it("collapses twelve writes in one directory from twelve barriers to one, byte for byte", async () => {
    const payload = (i: number) => `file ${i}\n`;

    resetBarriers();
    for (let i = 0; i < 12; i++) {
      await getStorage().writeFile(`individual/f${i}.md`, payload(i));
    }
    const individual = barriers();

    resetBarriers();
    await getStorage().withBatchedWrites(async (batch) => {
      for (let i = 0; i < 12; i++) {
        await batch.writeFile(`batched/f${i}.md`, payload(i));
      }
    });
    const batched = barriers();

    expect(individual).toBe(UNBATCHED_TWELVE_WRITES_BARRIERS);
    expect(batched).toBe(BATCH_ONE_DIRECTORY_BARRIERS);
    // Same bytes either way — the batch trades durability, never content.
    for (let i = 0; i < 12; i++) {
      expect(await getStorage().readFile(`individual/f${i}.md`)).toBe(payload(i));
      expect(await getStorage().readFile(`batched/f${i}.md`)).toBe(payload(i));
    }
  });

  it("charges one barrier per DISTINCT directory a batch touches", async () => {
    resetBarriers();
    await getStorage().withBatchedWrites(async (batch) => {
      for (let i = 0; i < 12; i++) {
        await batch.writeFile(`dir${i % 3}/f${i}.md`, `${i}`);
      }
    });

    expect(barriers()).toBe(BATCH_THREE_DIRECTORIES_BARRIERS);
    for (let i = 0; i < 12; i++) {
      expect(await getStorage().readFile(`dir${i % 3}/f${i}.md`)).toBe(`${i}`);
    }
  });
});

// ---------------------------------------------------------------------------
// The loop paths, measured marginally
// ---------------------------------------------------------------------------

/**
 * How a fixture lays its files out.
 *
 * `flat` puts everything in one directory; `nested` gives each item its own,
 * which is what `raw/sources/<slug>/<id>.<ext>` does in production. The door
 * charges per DIRECTORY, so this choice — not the item count — is what decides
 * what a batch saves.
 */
type Shape = "flat" | "nested";

/** The tenant-relative path of item `i` under `shape`. */
function itemPath(shape: Shape, i: number): string {
  return shape === "flat"
    ? `raw/asset-${i}.bin`
    : `raw/sources/slug-${i}/doc-${i}.bin`;
}

/** Seed `count` owner files, build an archive, wipe, then import it. */
async function measureImport(count: number, shape: Shape): Promise<{
  barriers: number;
  imported: number;
}> {
  await freshDataDir();
  for (let i = 0; i < count; i++) {
    await getStorage().writeAsset(
      `tenants/alice/${itemPath(shape, i)}`,
      new Uint8Array([i % 256, 1, 2, 3]).buffer,
    );
  }
  const archive = await buildPortableArchive("alice");
  const bytes = archive.bytes.buffer.slice(
    archive.bytes.byteOffset,
    archive.bytes.byteOffset + archive.bytes.byteLength,
  ) as ArrayBuffer;

  await freshDataDir();
  resetBarriers();
  const result = await importPortableArchive("alice", bytes, "skip");
  const used = barriers();

  for (let i = 0; i < count; i++) {
    expect(
      (await getStorage().readAsset(`tenants/alice/${itemPath(shape, i)}`)).byteLength,
    ).toBe(4);
  }
  return { barriers: used, imported: result.imported };
}

/** Seed `count` tenant assets, then take a backup of them. */
async function measureBackup(count: number, shape: Shape): Promise<number> {
  await freshDataDir();
  for (let i = 0; i < count; i++) {
    await getStorage().writeAsset(
      `tenants/alice/${itemPath(shape, i)}`,
      new Uint8Array([i % 256, 1, 2, 3]).buffer,
    );
  }
  resetBarriers();
  const manifest = await createOwnerBackup("alice");
  const used = barriers();
  expect(manifest.files.length).toBe(count);
  for (const file of manifest.files) {
    expect((await getStorage().readAsset(file.backupPath)).byteLength)
      .toBe(file.size);
  }
  return used;
}

describe("write barrier bounds — the loop paths", () => {
  it("spends a FLAT archive import exactly its recorded totals — nothing per entry", async () => {
    const small = await measureImport(SMALL_N, "flat");
    const large = await measureImport(LARGE_N, "flat");

    // Exact, not a ceiling: a bound of "no more than 0 per entry" is also met
    // by a run whose FIXED cost tripled.
    expect(small.barriers).toBe(IMPORT_FLAT_BARRIERS.small);
    expect(large.barriers).toBe(IMPORT_FLAT_BARRIERS.large);
    expect((large.barriers - small.barriers) / (LARGE_N - SMALL_N)).toBe(0);
    expect(large.imported).toBeGreaterThanOrEqual(LARGE_N);
  }, 60_000);

  it("spends a NESTED archive import exactly its recorded totals — per DIRECTORY, not per file", async () => {
    // The production shape: each Source gets its own directory, and the import
    // writes it twice (tenant path + flat compatibility path). The batch still
    // removes every payload fsync; what it cannot remove is a barrier for a
    // directory that exists only because of this one entry.
    const small = await measureImport(SMALL_N, "nested");
    const large = await measureImport(LARGE_N, "nested");

    expect(small.barriers).toBe(IMPORT_NESTED_BARRIERS.small);
    expect(large.barriers).toBe(IMPORT_NESTED_BARRIERS.large);
    // The honest claim: 2 per entry, one for each directory the entry creates.
    expect((large.barriers - small.barriers) / (LARGE_N - SMALL_N)).toBe(2);
  }, 60_000);

  it("spends a FLAT backup exactly its recorded totals — nothing per file", async () => {
    const small = await measureBackup(SMALL_N, "flat");
    const large = await measureBackup(LARGE_N, "flat");

    expect(small).toBe(BACKUP_FLAT_BARRIERS.small);
    expect(large).toBe(BACKUP_FLAT_BARRIERS.large);
    expect((large - small) / (LARGE_N - SMALL_N)).toBe(0);
  }, 60_000);

  it("spends a NESTED backup exactly its recorded totals — per DIRECTORY, not per file", async () => {
    const small = await measureBackup(SMALL_N, "nested");
    const large = await measureBackup(LARGE_N, "nested");

    expect(small).toBe(BACKUP_NESTED_BARRIERS.small);
    expect(large).toBe(BACKUP_NESTED_BARRIERS.large);
    // One per file, because each file lands in a directory of its own.
    expect((large - small) / (LARGE_N - SMALL_N)).toBe(1);
  }, 60_000);

  it("stores the embeddings index a bounded number of times per rebuild", async () => {
    (embed as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0.1, 0.2, 0.3],
    });
    for (let i = 0; i < REBUILD_PAGES; i++) {
      await writeWikiPage(`vec-${i}`, `# Vec ${i}\n\nBody ${i}.`);
    }
    await updateIndex(
      Array.from({ length: REBUILD_PAGES }, (_, i) => ({
        slug: `vec-${i}`,
        title: `Vec ${i}`,
        summary: `Body ${i}.`,
      })),
    );

    resetBarriers();
    const result = await rebuildVectorStore();
    const used = barriers();

    expect(result.embedded).toBe(REBUILD_PAGES);
    // The ONLY writes a rebuild makes are the index stores, so the barrier
    // count IS the number of times the whole index was rewritten. Asserted
    // exactly at the DERIVED flush count — one full batch plus the tail — and
    // then against the recorded ceiling, so neither a regression nor an
    // unexplained improvement passes silently.
    expect(used).toBe(Math.ceil(REBUILD_PAGES / REBUILD_FLUSH_BATCH));
    expect(used).toBeLessThanOrEqual(REBUILD_INDEX_STORES);
    for (let i = 0; i < REBUILD_PAGES; i++) {
      expect(await getStorage().getEmbeddingById(`vec-${i}`)).not.toBeNull();
    }
  }, 60_000);
});
