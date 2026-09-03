import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  ensureDirectories,
  writeWikiPageWithSideEffects,
  serializeFrontmatter,
  getWikiDir,
  type Frontmatter,
} from "../wiki";
import { writeDiscussFixture } from "./discuss-fixtures";
import {
  scanForMaintenance,
  rebuildDerivedIndexes,
  sweepOrphanWikiDirs,
  backfillWorkspaceProfiles,
  reapStrandedScratchFiles,
} from "../maintenance";
import { listCommonsPages } from "../commons";
import { _resetStorage, getStorage } from "../storage";
import { wikisRootPath } from "../wiki-paths";
import { ORPHAN_SWEEP_GRACE_MS } from "../wikis";
import { STRANDED_SCRATCH_GRACE_MS } from "../storage/filesystem";
import { READ_ONLY_REFUSAL } from "../read-only";
import { logger } from "../logger";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};
const TODAY = new Date().toISOString().slice(0, 10);
const PAST = "2020-01-01";

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "maint-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR", "NEXT_PUBLIC_OWNER_HANDLE"]) {
    saved[k] = process.env[k];
  }
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  vi.restoreAllMocks();
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR", "NEXT_PUBLIC_OWNER_HANDLE"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seed(slug: string, over: Partial<Frontmatter> = {}) {
  const fm: Frontmatter = {
    created: PAST,
    updated: PAST, // old, so not skipped as "edited today"
    owner: "alice",
    visibility: "public",
    authors: ["alice"],
    contributors: [],
    confidence: 0.7,
    expiry: "2099-01-01",
    tags: [],
    disputed: false,
    ...over,
  };
  await writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content: serializeFrontmatter(fm, `# ${slug}\n\nThis is a sufficiently long body paragraph that exceeds the fifty character empty-page threshold used by the maintenance scanner.`),
    summary: `Summary for ${slug}.`,
    logOp: "ingest",
    crossRefSource: null,
  });
}

describe("scanForMaintenance", () => {
  it("enqueues a staleness task for an expired page with a source_url", async () => {
    await seed("stale", { expiry: PAST, source_url: "https://example.com/s" });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({ kind: "maintain", op: "staleness", slug: "stale" });
  });

  it("enqueues a stale-page fix for an expired page with no source_url", async () => {
    await seed("expired-nosource", { expiry: PAST });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "expired-nosource",
      lintType: "stale-page",
    });
  });

  it("produces no task for a disputed page (reconcile-from-talk retired)", async () => {
    await seed("disputed", { disputed: true });
    await writeDiscussFixture("disputed", [
      { title: "Issue", comments: [{ author: "bob", body: "This claim looks wrong." }] },
    ]);
    expect(await scanForMaintenance()).toHaveLength(0);
  });

  it("enqueues a fix for a legacy page missing all yopedia schema fields", async () => {
    // Write a page with only owner/visibility/updated — no confidence/authors/expiry.
    await writeWikiPageWithSideEffects({
      slug: "legacy",
      title: "legacy",
      content: serializeFrontmatter(
        { owner: "alice", visibility: "public", updated: PAST } as Frontmatter,
        "# legacy\n\nOld page.",
      ),
      summary: "legacy",
      logOp: "ingest",
      crossRefSource: null,
    });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "legacy",
      lintType: "unmigrated-page",
    });
  });

  it("enqueues a fix to clear a dangling supersedes reference", async () => {
    await seed("rev", { supersedes: "deleted-page" }); // target not seeded → dangling
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "rev",
      lintType: "supersedes-dangling",
    });
  });

  it("enqueues a broken-link fix for each dead wiki link in a page", async () => {
    // Seed a target page and a page that links to both a live and a dead slug.
    await seed("target-exists");
    // Write a page whose body has links to both an existing and a non-existing slug.
    const fm: Frontmatter = {
      created: PAST,
      updated: PAST,
      owner: "alice",
      visibility: "public",
      authors: ["alice"],
      contributors: [],
      confidence: 0.7,
      expiry: "2099-01-01",
      tags: [],
      disputed: false,
    };
    await writeWikiPageWithSideEffects({
      slug: "has-broken",
      title: "has-broken",
      content: serializeFrontmatter(
        fm,
        "# Has Broken\n\nSee [existing](target-exists.md) and [dead](no-such-page.md).",
      ),
      summary: "Has broken links.",
      logOp: "ingest",
      crossRefSource: null,
    });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "has-broken",
      lintType: "broken-link",
      targetSlug: "no-such-page",
    });
    // The existing link should NOT produce a task.
    expect(tasks).not.toContainEqual(
      expect.objectContaining({ targetSlug: "target-exists" }),
    );
  });

  it("emits multiple broken-link tasks for multiple dead links in one page", async () => {
    const fm: Frontmatter = {
      created: PAST,
      updated: PAST,
      owner: "alice",
      visibility: "public",
      authors: ["alice"],
      contributors: [],
      confidence: 0.7,
      expiry: "2099-01-01",
      tags: [],
      disputed: false,
    };
    await writeWikiPageWithSideEffects({
      slug: "multi-broken",
      title: "multi-broken",
      content: serializeFrontmatter(
        fm,
        "# Multi\n\n[a](dead-a.md) and [b](dead-b.md).",
      ),
      summary: "Multi broken.",
      logOp: "ingest",
      crossRefSource: null,
    });
    const tasks = await scanForMaintenance();
    const brokenTasks = tasks.filter(
      (t) => t.kind === "maintain" && t.op === "fix" && t.lintType === "broken-link",
    );
    expect(brokenTasks).toHaveLength(2);
    expect(brokenTasks).toContainEqual(
      expect.objectContaining({ slug: "multi-broken", targetSlug: "dead-a" }),
    );
    expect(brokenTasks).toContainEqual(
      expect.objectContaining({ slug: "multi-broken", targetSlug: "dead-b" }),
    );
  });

  it("never flags a PRIVATE page (commons-only; avoids the reingest-fork loop)", async () => {
    await seed("priv-stale", {
      visibility: "private",
      expiry: PAST,
      source_url: "https://example.com/s",
    });
    await seed("priv-disputed", { visibility: "private", disputed: true });
    await writeDiscussFixture("priv-disputed", [
      { title: "Issue", comments: [{ author: "bob", body: "Wrong." }] },
    ]);
    expect(await scanForMaintenance()).toHaveLength(0);
  });

  it("skips a page edited today (let recent changes settle)", async () => {
    await seed("fresh", { expiry: PAST, source_url: "https://x.com", updated: TODAY });
    expect(await scanForMaintenance()).toHaveLength(0);
  });

  it("caps the number of tasks per scan", async () => {
    for (let i = 0; i < 5; i++) {
      await seed(`stale-${i}`, { expiry: PAST, source_url: `https://x.com/${i}` });
    }
    expect(await scanForMaintenance(2)).toHaveLength(2);
  });

  it("enqueues an orphan-page fix for a file on disk with no index entry", async () => {
    // Seed a normal page (indexed), then write a raw .md file that bypasses the index.
    await seed("indexed-page");
    const wikiDir = getWikiDir();
    await fs.writeFile(
      path.join(wikiDir, "orphan-page.md"),
      "# Orphan\n\nThis page exists on disk but is not in the index.",
    );
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "orphan-page",
      lintType: "orphan-page",
    });
  });

  it("does NOT flag an indexed page as orphan", async () => {
    await seed("well-indexed");
    const tasks = await scanForMaintenance();
    expect(tasks).not.toContainEqual(
      expect.objectContaining({ slug: "well-indexed", lintType: "orphan-page" }),
    );
  });

  it("enqueues an empty-page fix for a page with trivially short content", async () => {
    // Seed a page with very short body (under 50 chars after heading).
    const fm: Frontmatter = {
      created: PAST,
      updated: PAST,
      owner: "alice",
      visibility: "public",
      authors: ["alice"],
      contributors: [],
      confidence: 0.7,
      expiry: "2099-01-01",
      tags: [],
      disputed: false,
    };
    await writeWikiPageWithSideEffects({
      slug: "empty-stub",
      title: "empty-stub",
      content: serializeFrontmatter(fm, "# Empty Stub\n\nTiny."),
      summary: "An empty stub.",
      logOp: "ingest",
      crossRefSource: null,
    });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "empty-stub",
      lintType: "empty-page",
    });
  });

  it("does NOT flag a page with substantial content as empty", async () => {
    await seed("substantial");
    const tasks = await scanForMaintenance();
    expect(tasks).not.toContainEqual(
      expect.objectContaining({ slug: "substantial", lintType: "empty-page" }),
    );
  });

  it("enqueues a missing-crossref fix when a page mentions another page's title without linking", async () => {
    // Seed two pages: "machine-learning" mentions "artificial intelligence" by title
    // but doesn't link to it.
    const fm: Frontmatter = {
      created: PAST,
      updated: PAST,
      owner: "alice",
      visibility: "public",
      authors: ["alice"],
      contributors: [],
      confidence: 0.7,
      expiry: "2099-01-01",
      tags: [],
      disputed: false,
    };
    await writeWikiPageWithSideEffects({
      slug: "artificial-intelligence",
      title: "Artificial Intelligence",
      content: serializeFrontmatter(
        fm,
        "# Artificial Intelligence\n\nArtificial intelligence is the simulation of human intelligence by machines, covering a broad range of techniques and applications.",
      ),
      summary: "AI overview.",
      logOp: "ingest",
      crossRefSource: null,
    });
    await writeWikiPageWithSideEffects({
      slug: "machine-learning",
      title: "Machine Learning",
      content: serializeFrontmatter(
        fm,
        "# Machine Learning\n\nMachine learning is a subfield of artificial intelligence that uses statistical methods to learn patterns from data.",
      ),
      summary: "ML overview.",
      logOp: "ingest",
      crossRefSource: null,
    });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({
      kind: "maintain",
      op: "fix",
      slug: "machine-learning",
      lintType: "missing-crossref",
      targetSlug: "artificial-intelligence",
    });
  });

  it("enqueues a staleness task for a low-confidence page with a source_url", async () => {
    await seed("low-conf", { confidence: 0.4, source_url: "https://example.com/src" });
    const tasks = await scanForMaintenance();
    expect(tasks).toContainEqual({ kind: "maintain", op: "staleness", slug: "low-conf" });
  });

  it("does NOT enqueue a task for a low-confidence page without a source_url", async () => {
    await seed("low-conf-nosrc", { confidence: 0.4 });
    const tasks = await scanForMaintenance();
    expect(tasks).not.toContainEqual(
      expect.objectContaining({ slug: "low-conf-nosrc", op: "staleness" }),
    );
  });

  it("does NOT enqueue a low-confidence task for a page above the threshold", async () => {
    await seed("high-conf", { confidence: 0.7, source_url: "https://example.com/src" });
    const tasks = await scanForMaintenance();
    expect(tasks).not.toContainEqual(
      expect.objectContaining({ slug: "high-conf", op: "staleness" }),
    );
  });
});

describe("rebuildDerivedIndexes — commons index (#398)", () => {
  it("includes the commons index in the daily self-heal rebuild", async () => {
    await seed("agentic-systems");

    const results = await rebuildDerivedIndexes();

    // The commons index must be one of the rebuilt indexes (it powers every
    // unauthenticated surface; without this it never self-heals from drift).
    expect(results).toHaveProperty("commons");
    expect(results.commons.ok).toBe(true);

    // And the rebuild actually populated it with the public page.
    const commons = await listCommonsPages();
    expect(commons.map((p) => p.slug)).toContain("agentic-systems");
  });
});

describe("sweepOrphanWikiDirs — the scheduled orphan-directory GC (DW-147)", () => {
  const OWNER = "alice";

  /**
   * Built from `wikisRootPath`, the same helper the sweep itself addresses
   * through — never hand-joined. A helper that spelled the tenancy layout a
   * second time would plant its "orphan" somewhere the sweep never looks the
   * day that layout moves, and the no-op assertions below would then pass
   * vacuously while the real behaviour had silently broken.
   */
  function wikisRoot(): string {
    return path.join(tmpDir, ...wikisRootPath(OWNER).split("/"));
  }

  /** An unreferenced `wikis/<uuid>/`, backdated past the sweep's grace window. */
  async function plantAgedOrphan(id: string): Promise<string> {
    const dir = path.join(wikisRoot(), id);
    await fs.mkdir(dir, { recursive: true });
    const file = path.join(dir, "purpose.md");
    await fs.writeFile(file, "# Orphan\n");
    const when = new Date(Date.now() - ORPHAN_SWEEP_GRACE_MS * 2);
    await fs.utimes(file, when, when);
    await fs.utimes(dir, when, when);
    return dir;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  it("sweeps the configured owner's tenant and returns the count", async () => {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    const { createWiki } = await import("../wikis");
    // The registry has to NAME a wiki, or the sweep's empty-registry rule
    // (a lost wikis.json reads identically) leaves everything alone.
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    const orphan = await plantAgedOrphan("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee");

    expect(await sweepOrphanWikiDirs()).toBe(1);

    expect(await exists(orphan)).toBe(false);
    expect(await exists(path.join(wikisRoot(), wiki.id))).toBe(true);
  });

  it("is a no-op when no owner handle is configured", async () => {
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    const orphan = await plantAgedOrphan("11111111-2222-4333-8444-555555555555");

    // Single-owner deployment: with nobody configured there is no tenant to
    // resolve, so the scan must not guess one and start deleting.
    expect(await sweepOrphanWikiDirs()).toBe(0);
    expect(await exists(orphan)).toBe(true);
  });

  it("returns 0 instead of throwing when the sweep fails", async () => {
    // Fail-soft like `purgeStaleJobs`: this runs inside the maintenance scan,
    // and a storage hiccup here must not 500 a scan that did everything else.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    const { createWiki } = await import("../wikis");
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    vi.spyOn(getStorage(), "listFiles").mockRejectedValue(
      new Error("listing the wikis directory failed"),
    );

    await expect(sweepOrphanWikiDirs()).resolves.toBe(0);
  });

  it("records the stale-tombstone residual in its SCOPE docblock (DW-488)", async () => {
    // DW-488 is a DOCUMENTATION gap, not a behaviour one: the inline-versus-
    // scheduled split is already pinned by "leaves the marker alone on the sweep
    // that runs inside a delete" in `wikis.test.ts`, and DW-291 settled that the
    // inline path must not pay the per-claimed-directory probe. What was missing
    // is that the SCOPE note here accounted only for orphan DIRECTORIES on
    // pre-gate tenants — which `deleteWiki` at least reclaims inline — and said
    // nothing about their stale `.discarded` markers, which no path clears at
    // all. The note IS the deliverable, so the note is what this observes.
    const source = await fs.readFile(
      path.resolve(__dirname, "../maintenance.ts"),
      "utf8",
    );
    // BOTH ANCHORS HAVE TO RESOLVE, or this row fails open: `indexOf` returns -1
    // when either is renamed, `slice(start, -1)` then hands back very nearly the
    // whole module, and every substring below would match text from somewhere
    // else in it while the docblock said nothing at all.
    const start = source.indexOf("SCOPE (DW-288, settled)");
    const end = source.indexOf("export async function sweepOrphanWikiDirs");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const scope = source.slice(start, end);

    // The orphan-directory residual the note already carried, unchanged…
    expect(scope).toContain("The one honest residual today is tenants created");

    // …and the tombstone residual beside it, asserted on the PARAGRAPH rather
    // than on the whole block, so four substrings scattered across a long
    // docblock cannot satisfy this row between them.
    const opens = scope.indexOf("THE SECOND RESIDUAL");
    const widen = scope.indexOf("Widen this only if");
    expect(opens).toBeGreaterThan(0);
    expect(widen).toBeGreaterThan(opens);
    const residual = scope.slice(opens, widen);
    expect(residual).toContain("DW-488");
    expect(residual).toContain("clearStaleDiscardTombstones");
    expect(residual).toMatch(/scheduled/i);
    expect(residual).toMatch(/ACCEPTED, not fixed/i);
    // …and the widen-trigger the note already names, which now covers both.
    expect(scope.slice(widen)).toContain("readActiveWikiSchema");
  });
});

describe("backfillWorkspaceProfiles — the scheduled Workspace Purpose migration (DW-137)", () => {
  const OWNER = "alice";

  /**
   * The retired tenant-global profile, planted where the migration reads it.
   *
   * Hand-joined from `tenantForOwner` rather than imported from a helper,
   * because there deliberately IS no exported helper for this address: DW-137
   * left it spelled once, inside `workspace-profile-backfill.ts`, and
   * `wiki-schema-edit.test.ts` fails the build if a second spelling appears in
   * `src/`. A test fixture is the one place the duplicate is harmless.
   */
  async function plantLegacyProfile(): Promise<string> {
    const { tenantForOwner } = await import("../wiki");
    const file = path.join(
      tmpDir,
      "tenants",
      tenantForOwner(OWNER),
      "workspace-profile.json",
    );
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(
      file,
      JSON.stringify({
        version: 1,
        scenario: "custom",
        purpose: "Hand-authored before the split.",
        keyQuestions: [],
        inScope: [],
        outOfScope: [],
        outputLanguage: "English",
        pageConventions: "",
        createdAt: "2020-01-01T00:00:00.000Z",
        updatedAt: "2021-06-30T00:00:00.000Z",
      }),
    );
    return file;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  it("migrates the configured owner's tenant and returns the count", async () => {
    // THE ONLY PRODUCTION PATH INTO THE MIGRATION. `scan-route.test.ts` mocks
    // `@/lib/maintenance` wholesale and the backfill suite calls the library
    // function directly, so without this case an `if (1) return 0;` at the top
    // of the wrapper leaves every other suite in the repo green while the
    // migration never runs anywhere.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    const { createWiki } = await import("../wikis");
    const { wikiProfilePath } = await import("../wiki-paths");
    const wiki = await createWiki(OWNER, { name: "Ops", scenario: "business" });
    // A wiki from before per-Wiki profiles: no file of its own.
    const own = path.join(tmpDir, ...wikiProfilePath(OWNER, wiki.id).split("/"));
    await fs.rm(own);
    const legacy = await plantLegacyProfile();

    expect(await backfillWorkspaceProfiles()).toBe(1);

    const { getWorkspaceProfile } = await import("../workspace-profile");
    expect((await getWorkspaceProfile(OWNER, wiki.id)).purpose).toBe(
      "Hand-authored before the split.",
    );
    expect(await exists(legacy)).toBe(false);
  });

  it("is a no-op when no owner handle is configured", async () => {
    // Single-owner deployment: with nobody configured there is no tenant to
    // resolve, so the scan must not guess one and start writing profiles.
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    const legacy = await plantLegacyProfile();

    expect(await backfillWorkspaceProfiles()).toBe(0);
    expect(await exists(legacy)).toBe(true);
  });

  it("returns 0 instead of throwing when the migration fails", async () => {
    // Fail-soft like `sweepOrphanWikiDirs`: this runs inside the maintenance
    // scan, and a storage hiccup in a one-time migration must not 500 a scan
    // that did everything else. The registry read is what breaks here — it
    // happens under the lock, past every guard that answers 0 on its own.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER;
    const { createWiki } = await import("../wikis");
    await createWiki(OWNER, { name: "Ops", scenario: "business" });
    await plantLegacyProfile();
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (target: string) => {
      if (target.endsWith("wikis.json")) throw new Error("the registry is gone");
      return readFile(target);
    });

    await expect(backfillWorkspaceProfiles()).resolves.toBe(0);
  });
});


describe("reapStrandedScratchFiles — the scheduled scratch GC (DW-292)", () => {
  /**
   * The env flag is saved HERE rather than in the file-level hooks because it
   * is this suite's only user: a value exported in a developer's shell would
   * otherwise turn the reaping rows below into refusals.
   */
  let savedReadOnly: string | undefined;
  let savedProvider: string | undefined;

  beforeEach(() => {
    savedReadOnly = process.env.YOPEDIA_READONLY;
    savedProvider = process.env.STORAGE_PROVIDER;
    delete process.env.YOPEDIA_READONLY;
    delete process.env.STORAGE_PROVIDER;
  });

  afterEach(() => {
    if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = savedReadOnly;
    if (savedProvider === undefined) delete process.env.STORAGE_PROVIDER;
    else process.env.STORAGE_PROVIDER = savedProvider;
  });

  /** A `.tmp-<uuid>.tmp` under DATA_DIR, dated `ageMs` into the past. */
  async function plantScratch(name: string, ageMs: number): Promise<string> {
    const full = path.join(tmpDir, name);
    await fs.writeFile(full, "half a payload");
    const when = new Date(Date.now() - ageMs);
    await fs.utimes(full, when, when);
    return full;
  }

  async function exists(target: string): Promise<boolean> {
    try {
      await fs.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  it("reclaims a stranded scratch file and reports the count", async () => {
    const stranded = await plantScratch(
      ".tmp-11111111-2222-4333-8444-555555555555.tmp",
      STRANDED_SCRATCH_GRACE_MS * 2,
    );

    expect(await reapStrandedScratchFiles()).toBe(1);
    expect(await exists(stranded)).toBe(false);
  });

  it("calls the provider with NO cap argument, so production keeps the shipped bound", async () => {
    // THE CALL-SITE HALF of the reaper's cap pin. `storage-fs.test.ts` pins
    // that `candidateCap` DEFAULTS to `STRANDED_SCRATCH_CANDIDATE_CAP`, but a
    // default only holds while nobody overrides it — and the parameter exists
    // precisely so tests CAN. Nothing else in the suite would notice this
    // wrapper starting to pass one: adding a cap of 5 here leaves every row
    // green while production silently reclaims 5 stranded files per tick
    // instead of 500, a backlog that grows forever and whose symptom —
    // a small non-zero count on every tick — is indistinguishable from health.
    //
    // Asserted as "called with exactly zero arguments" rather than "not called
    // with 5": the override is test-only, so ANY argument from this call site
    // is the regression, whatever its value.
    const provider = getStorage() as unknown as {
      reapStrandedScratchFiles: (...args: unknown[]) => Promise<number>;
    };
    const pass = vi
      .spyOn(provider, "reapStrandedScratchFiles")
      .mockResolvedValue(7);

    await expect(reapStrandedScratchFiles()).resolves.toBe(7);

    expect(pass).toHaveBeenCalledWith();
  });

  it("leaves a scratch file a live write could still be holding", async () => {
    // The grace window is the ONLY thing separating a crash leftover from an
    // in-flight write's tmp file — both are `.tmp-<uuid>.tmp` in the
    // destination's own directory — so a pass that took a seconds-old one
    // would truncate a write that was about to publish.
    const inFlight = await plantScratch(
      ".tmp-66666666-7777-4888-8999-aaaaaaaaaaaa.tmp",
      1_000,
    );

    expect(await reapStrandedScratchFiles()).toBe(0);
    expect(await exists(inFlight)).toBe(true);
  });

  it("refuses on a read-only deployment instead of quietly reclaiming nothing", async () => {
    // The gate sits BEFORE the try, so the fail-soft catch below cannot swallow
    // it: a direct library caller — a CLI command, an ops script — meets the
    // refusal rather than reading `0` as "nothing to reclaim". The scan route
    // has already answered `maintenanceScan` long before this is reached.
    process.env.YOPEDIA_READONLY = "1";
    const stranded = await plantScratch(
      ".tmp-bbbbbbbb-cccc-4ddd-8eee-ffffffffffff.tmp",
      STRANDED_SCRATCH_GRACE_MS * 2,
    );

    await expect(reapStrandedScratchFiles()).rejects.toThrow(
      READ_ONLY_REFUSAL.scratchFileReap,
    );
    expect(await exists(stranded)).toBe(true);
  });

  it("returns 0 without touching storage on a deployment that is not on disk", async () => {
    // The ONE branch only this suite can reach: the provider-level rows in
    // `storage-fs.test.ts` are a filesystem provider by construction, and R2
    // has no such method to call. Scratch files are an artifact of publishing
    // through a filesystem — R2's create-only put is native — so there is
    // nothing to reclaim and the wrapper must answer 0 rather than narrowing
    // against a class the deployment never instantiated.
    const stranded = await plantScratch(
      ".tmp-99999999-8888-4777-8666-555555555555.tmp",
      STRANDED_SCRATCH_GRACE_MS * 2,
    );
    _resetStorage();
    process.env.STORAGE_PROVIDER = "cloudflare-r2";
    // The 0 alone proves nothing — the fail-soft catch below also answers 0,
    // and on an R2 deployment `getStorage()` throws for want of an initialised
    // binding. A CLEAN short-circuit is a 0 with nothing logged; falling
    // through to the catch is a 0 with a scan-level error on every tick.
    const errored = vi.spyOn(logger, "error").mockImplementation(() => {});

    expect(await reapStrandedScratchFiles()).toBe(0);

    expect(errored).not.toHaveBeenCalled();
    // …and it short-circuited BEFORE resolving a provider: the file a
    // filesystem pass would have taken is still there.
    expect(await exists(stranded)).toBe(true);
  });

  it("returns 0 instead of throwing when the walk fails", async () => {
    // Fail-soft like `sweepOrphanWikiDirs`: this runs inside the maintenance
    // scan, and a storage hiccup here must not 500 a scan that did everything
    // else. The walk's OWN fault behaviour — per-entry skips, and the base-path
    // rejection this converts — is pinned at the provider in `storage-fs.test.ts`,
    // which is the only place a row can see inside a single pass.
    const provider = getStorage() as unknown as {
      reapStrandedScratchFiles: () => Promise<number>;
    };
    vi.spyOn(provider, "reapStrandedScratchFiles").mockRejectedValue(
      new Error("walking the data directory failed"),
    );

    await expect(reapStrandedScratchFiles()).resolves.toBe(0);
  });
});
