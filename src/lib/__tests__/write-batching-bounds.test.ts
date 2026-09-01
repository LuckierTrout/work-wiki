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
 * WHY MARGINAL, NOT TOTAL, FOR THE LOOP PATHS. An import or a backup also does
 * fixed work — a manifest, an index reconstruction, a derived-index rebuild —
 * and that fixed cost is large enough to hide a per-item regression inside a
 * single total. So each loop path is measured at N and again at 3N items and the
 * assertion is on the MARGINAL cost: (barriers at 3N − barriers at N) / 2N. Fixed
 * writes cancel; only what scales with the input survives.
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
import { rebuildVectorStore } from "../embeddings";
import { createOwnerBackup } from "../backups";
import { serializeFrontmatter } from "../frontmatter";
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
 * Extra barriers `importPortableArchive` may spend per additional manifest
 * entry.
 *
 * MEASURED: 0. Four entries cost 12 barriers; twelve entries cost 12 — every
 * one of those 12 is fixed work (the manifest read-back's index reconstruction
 * and the derived-index rebuild), and the entries themselves now cost nothing
 * because they all land in the same two directories inside one batch.
 *
 * With the batch's payload fsync switched back on, the same measurement reads
 * 23 → 39, i.e. 2 per entry: the tenant write and its compatibility copy.
 */
const IMPORT_MARGINAL_BARRIERS_PER_ENTRY = 0;

/**
 * Extra barriers `createOwnerBackup` may spend per additional copied file.
 *
 * MEASURED: 0. Four files cost 3 barriers; twelve files cost 3 — the 3 are the
 * batch's directory barrier, the manifest write and the ledger line.
 *
 * With the batch's payload fsync switched back on: 7 → 15, i.e. 1 per file.
 */
const BACKUP_MARGINAL_BARRIERS_PER_FILE = 0;

/** Pages seeded for the rebuild bound — deliberately not a multiple of 32. */
const REBUILD_PAGES = 40;

/** Mirrors `EMBEDDING_FLUSH_BATCH` in `embeddings.ts`. */
const REBUILD_FLUSH_BATCH = 32;

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

/** Seed `count` owner pages, build an archive, wipe, then import it. */
async function measureImport(count: number): Promise<{
  barriers: number;
  imported: number;
}> {
  await freshDataDir();
  for (let i = 0; i < count; i++) {
    await getStorage().writeFile(
      `tenants/alice/wiki/page-${i}.md`,
      serializeFrontmatter(
        { owner: "alice", visibility: "private", authors: ["alice"] },
        `# Page ${i}\n\nBody ${i}.`,
      ),
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
      await getStorage().readFile(`tenants/alice/wiki/page-${i}.md`),
    ).toContain(`Body ${i}.`);
  }
  return { barriers: used, imported: result.imported };
}

/** Seed `count` tenant assets, then take a backup of them. */
async function measureBackup(count: number): Promise<number> {
  await freshDataDir();
  for (let i = 0; i < count; i++) {
    await getStorage().writeAsset(
      `tenants/alice/raw/asset-${i}.bin`,
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
  it("adds no more than the recorded marginal cost per imported archive entry", async () => {
    const small = await measureImport(4);
    const large = await measureImport(12);

    const marginal = (large.barriers - small.barriers) / (12 - 4);
    expect(marginal).toBeLessThanOrEqual(IMPORT_MARGINAL_BARRIERS_PER_ENTRY);
    expect(large.imported).toBeGreaterThanOrEqual(12);
  }, 60_000);

  it("adds no more than the recorded marginal cost per backed-up file", async () => {
    const small = await measureBackup(4);
    const large = await measureBackup(12);

    const marginal = (large - small) / (12 - 4);
    expect(marginal).toBeLessThanOrEqual(BACKUP_MARGINAL_BARRIERS_PER_FILE);
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
    // count IS the number of times the whole index was rewritten.
    expect(used).toBeLessThanOrEqual(REBUILD_INDEX_STORES);
    for (let i = 0; i < REBUILD_PAGES; i++) {
      expect(await getStorage().getEmbeddingById(`vec-${i}`)).not.toBeNull();
    }
  }, 60_000);
});
