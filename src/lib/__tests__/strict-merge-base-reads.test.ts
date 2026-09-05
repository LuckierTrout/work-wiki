import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import {
  ensureDirectories,
  listWikiPages,
  readWikiPage,
  tenantForOwner,
  tenantWikiRelPath,
  wikiRelPath,
} from "../wiki";
import { serializeFrontmatter } from "../frontmatter";
import { serializeSources, buildSourceEntry } from "../sources";
import { getStorage, _resetStorage } from "../storage";
import { _resetLocks, _setDurableLocksForTests } from "../lock";
import { resetAliasIndex } from "../alias-index";
import { rebuildPageIndex } from "../page-index";

// ---------------------------------------------------------------------------
// An UNREADABLE page is not an ABSENT one — the two library modules whose
// existing coverage lives in `lifecycle.test.ts` (DW-495)
// ---------------------------------------------------------------------------

/**
 * `cascadeDeleteSource` and `runIngestBookkeeping` are exercised for real by
 * `src/lib/__tests__/lifecycle.test.ts`, and that file is the counter-check
 * that this change is behaviour-NEUTRAL without a blip — so it stays unedited
 * and the blip rows live here instead.
 *
 * What each of the three merge-base reads did with a non-ENOENT storage
 * failure before `{ fresh: true, strict: true }`:
 *
 *   - `source-cascade.ts`'s per-page read answered `null`, and the `continue`
 *     under it quietly dropped the slug from `others`. The cascade then
 *     REPORTED SUCCESS while the dead source reference stayed in the stored
 *     file.
 *   - `ingest-bookkeeping.ts`'s `overview` read answered `null`, so the write
 *     took `createOnly` over a stored overview — losing the `created` date
 *     that read exists to preserve.
 *   - the same module's summary scan answered `null` for one page, skipped it,
 *     found no existing summary for the source, and MINTED A DUPLICATE summary
 *     page at a fresh slug.
 *
 * Classification is what is pinned: the storage failure reaches the caller,
 * and nothing is silently dropped, overwritten, or duplicated.
 */

// ---------------------------------------------------------------------------
// Temp directory setup — copied from lifecycle.test.ts, which drives these
// same two modules
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "strict-merge-base-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // Isolate DATA_DIR so the per-tenant silo mirror (tenants/…, relative to the
  // data dir) and derived indexes land under tmp, not the repo cwd.
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  _setDurableLocksForTests(false);
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  _resetStorage();
  _setDurableLocksForTests(false);
  await fs.rm(tmpDir, { recursive: true, force: true });
  resetAliasIndex();
});

/**
 * A ONE-SHOT non-ENOENT failure on `<slug>.md`: the file is there, the
 * provider is not, for exactly one read. Every other path is served for real.
 *
 * One-shot deliberately. With the page index seeded (see `rebuildPageIndex`
 * below) the converted read is the FIRST read of the file the call makes, and
 * a spy that failed EVERY read of it would also break the write that follows —
 * so the call would reject whether or not the read rethrows, and the row would
 * pin nothing. Failing only the converted read leaves the old behaviour
 * running to completion, which is what the harm assertions catch.
 */
function blipOnce(slug: string) {
  const storage = getStorage();
  const originalRead = storage.readFile.bind(storage);
  const state = { blipped: false };
  const spy = vi
    .spyOn(storage, "readFile")
    .mockImplementation(async (filePath: string) => {
      if (!state.blipped && filePath.endsWith(`${slug}.md`)) {
        state.blipped = true;
        throw new Error("storage unavailable");
      }
      return originalRead(filePath);
    });
  return { spy, state };
}

// ===========================================================================
// cascadeDeleteSource
// ===========================================================================

describe("cascadeDeleteSource — a blipped page is not a page without a citation (DW-495)", () => {
  it("rejects with the STORAGE error instead of silently dropping the cited page", async () => {
    const { cascadeDeleteSource } = await import("../source-cascade");
    const { rawSourceRelPath } = await import("../raw");
    const sourcePath = "raw/sources/meet/deadbeef.md";
    await getStorage().writeFile(rawSourceRelPath("meet/deadbeef.md"), "# Meet\n");

    // One page that cites the doomed source AND another one, so the cascade's
    // `others` arm (rewrite, not delete) is what handles it.
    const shared = serializeSources([
      buildSourceEntry(sourcePath, "text", "alice", "deadbeef"),
      buildSourceEntry("raw/sources/other/keep.md", "text", "alice", "keep"),
    ]);
    await writeWikiPageWithSideEffects({
      slug: "shared",
      title: "Shared",
      content: serializeFrontmatter(
        { sources: shared, owner: "alice" },
        "# Shared\n",
      ),
      summary: "a shared page",
      logOp: "ingest",
    });
    const before = (await readWikiPage("shared"))!.content;

    // The blip has to spare the ENUMERATION read (`source-cascade.ts`'s first
    // per-page read, strict in its own right since DW-737) and hit only the
    // merge-base read in the `others` loop — otherwise the page never enters
    // `others` and the row asserts THAT conversion instead of this one. The
    // cascade writes its resume marker between those two points, so arming on
    // that write is exact. The row below drives the enumeration read.
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    const originalWrite = storage.writeFile.bind(storage);
    let armed = false;
    const writeSpy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (filePath: string, content: string) => {
        await originalWrite(filePath, content);
        if (filePath.startsWith("source-cascade/")) armed = true;
      });
    const readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (filePath: string) => {
        if (armed && filePath.endsWith("shared.md")) {
          throw new Error("storage unavailable");
        }
        return originalRead(filePath);
      });

    let caught: unknown;
    try {
      await cascadeDeleteSource({ owner: "alice", path: sourcePath });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(armed).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("storage unavailable");

    // THE HARM THIS ROW EXISTS FOR: before the conversion the cascade RESOLVED
    // here, having dropped the slug from `others` — leaving this page citing a
    // source that no longer exists, with nothing to say so.
    expect((await readWikiPage("shared"))!.content).toBe(before);
    expect((await readWikiPage("shared"))!.content).toContain("deadbeef");
  }, 20_000);

  /**
   * DW-737 — the WORSE of the two sites, converted second.
   *
   * The `others` read only mis-handles a page already known to cite the doomed
   * source. A drop during ENUMERATION removes the page from the cascade's world
   * entirely, and the `writeMarker` immediately below that loop PERSISTS the
   * omission: a retry takes the `if (resumed)` arm and never re-enumerates, so
   * one transient fault becomes permanent. The cascade then deletes the raw
   * source bytes anyway and reports success, leaving a page citing bytes that
   * are gone.
   */
  it("rejects before writing a marker or deleting a byte when ENUMERATION blips", async () => {
    const { cascadeDeleteSource } = await import("../source-cascade");
    const { rawSourceRelPath } = await import("../raw");
    const sourcePath = "raw/sources/meet/deadbeef.md";
    const rawRel = rawSourceRelPath("meet/deadbeef.md");
    await getStorage().writeFile(rawRel, "# Meet\n");

    // Two sources again, so a completed cascade would REWRITE this page rather
    // than delete it — the harm is then visible as changed bytes, not just an
    // absent file.
    const shared = serializeSources([
      buildSourceEntry(sourcePath, "text", "alice", "deadbeef"),
      buildSourceEntry("raw/sources/other/keep.md", "text", "alice", "keep"),
    ]);
    await writeWikiPageWithSideEffects({
      slug: "shared",
      title: "Shared",
      content: serializeFrontmatter(
        { sources: shared, owner: "alice" },
        "# Shared\n",
      ),
      summary: "a shared page",
      logOp: "ingest",
    });
    const before = (await readWikiPage("shared"))!.content;

    // Seeding the page index puts `listWikiPages` on its metadata fast path, so
    // the enumeration read is genuinely the FIRST read of `shared.md` the call
    // makes and the one-shot blip cannot be spent by the listing.
    await rebuildPageIndex();

    const storage = getStorage();
    const markerWrites: string[] = [];
    const originalWrite = storage.writeFile.bind(storage);
    const writeSpy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (filePath: string, content: string) => {
        if (filePath.startsWith("source-cascade/")) markerWrites.push(filePath);
        return originalWrite(filePath, content);
      });
    const { spy: readSpy, state } = blipOnce("shared");

    let caught: unknown;
    try {
      await cascadeDeleteSource({ owner: "alice", path: sourcePath });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
      writeSpy.mockRestore();
    }

    expect(state.blipped).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("storage unavailable");

    // THE HARM. Before the conversion this RESOLVED: `shared` was dropped from
    // the enumeration, the marker below the loop froze that omission for every
    // retry, and the tail deleted the raw bytes regardless.
    expect(markerWrites).toEqual([]);
    expect((await readWikiPage("shared"))!.content).toBe(before);
    expect((await readWikiPage("shared"))!.content).toContain("deadbeef");
    expect(await getStorage().readFile(rawRel)).toBe("# Meet\n");
  }, 20_000);

  it("still treats a genuinely ABSENT page as absent and completes", async () => {
    // `strict` changes what a NON-ENOENT fault does and nothing else. A slug
    // `listWikiPages` names whose file is gone must still be skipped by the
    // `continue`, or the conversion would turn every stale index entry into a
    // hard cascade failure.
    const { cascadeDeleteSource } = await import("../source-cascade");
    const { rawSourceRelPath } = await import("../raw");
    const sourcePath = "raw/sources/meet/cafe0000.md";
    await getStorage().writeFile(rawSourceRelPath("meet/cafe0000.md"), "# Meet\n");

    await writeWikiPageWithSideEffects({
      slug: "cites",
      title: "Cites",
      content: serializeFrontmatter(
        {
          sources: serializeSources([
            buildSourceEntry(sourcePath, "text", "alice", "cafe0000"),
            buildSourceEntry("raw/sources/other/keep.md", "text", "alice", "keep"),
          ]),
          owner: "alice",
        },
        "# Cites\n",
      ),
      summary: "a citing page",
      logOp: "ingest",
    });
    await writeWikiPageWithSideEffects({
      slug: "vanished",
      title: "Vanished",
      content: serializeFrontmatter({ owner: "alice" }, "# Vanished\n"),
      summary: "about to disappear",
      logOp: "ingest",
    });

    // Seed the index so the listing below serves from its METADATA rather than
    // re-reading the files — that is what lets a slug survive in the listing
    // after its bytes are gone, which is the state the enumeration read has to
    // meet an ENOENT in.
    await rebuildPageIndex();

    // Delete the BYTES out from under the listing, through the real path
    // helpers — a write lands in the tenant silo AND the flat compatibility
    // copy, so both have to go or `readWikiPage` still resolves one of them.
    const storage = getStorage();
    let removed = 0;
    for (const candidate of [
      wikiRelPath("vanished.md"),
      tenantWikiRelPath(tenantForOwner("alice"), "vanished.md"),
      tenantWikiRelPath(tenantForOwner(undefined), "vanished.md"),
    ]) {
      try {
        await storage.deleteFile(candidate);
        removed += 1;
      } catch {
        // Not every layout holds a copy; the assertion below is what decides
        // whether enough of them did.
      }
    }
    expect(removed).toBeGreaterThan(0);
    // THE ANTI-VACUITY PAIR. Without the first the row can pass having deleted
    // nothing; without the second `listWikiPages` simply stops yielding the
    // slug and the enumeration read is never reached for it — either way the
    // ENOENT `continue` this row exists for goes unexercised.
    expect(await readWikiPage("vanished")).toBeNull();
    expect((await listWikiPages()).map((entry) => entry.slug)).toContain(
      "vanished",
    );

    const result = await cascadeDeleteSource({ owner: "alice", path: sourcePath });

    // The cascade ran to completion: the surviving citing page was rewritten,
    // and the vanished slug simply was not part of it.
    expect(result.updatedPages).toContain("cites");
    expect(result.deletedPages).not.toContain("vanished");
    expect((await readWikiPage("cites"))!.content).not.toContain("cafe0000");
  }, 20_000);
});

// ===========================================================================
// runIngestBookkeeping
// ===========================================================================

describe("runIngestBookkeeping — a blipped page is not an absent one (DW-495)", () => {
  /** Drive the module the way `ingest` does. */
  async function run(overrides: Record<string, unknown> = {}) {
    const { runIngestBookkeeping } = await import("../ingest-bookkeeping");
    return runIngestBookkeeping({
      owner: "alice",
      actor: "alice",
      sourceTitle: "Standup",
      sourceText: "We agreed to ship the digest on Friday.",
      sourcePath: "raw/sources/standup/abc0000000000000.md",
      sourceType: "text",
      rawId: "abc0000000000000",
      ...overrides,
    } as Parameters<typeof runIngestBookkeeping>[0]);
  }

  it("rejects with the STORAGE error rather than re-creating the stored overview", async () => {
    // The overview the merge-base read protects has to actually BE stored.
    await run();
    const before = (await readWikiPage("overview"))!.content;

    // Seeding the page index puts `listWikiPages` on its metadata fast path,
    // so the scan no longer reads page files and `regenerateOverview`'s own
    // read is the first read of `overview.md` the call makes.
    await rebuildPageIndex();

    const { spy: readSpy, state } = blipOnce("overview");
    let caught: unknown;
    try {
      await run({ sourceText: "A second pass that must not land." });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
    }

    expect(state.blipped).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    // Before the conversion this rejected too — but with the lifecycle's
    // CONFLICT sentence, raised by the `createOnly` re-check the blipped
    // `null` had already sent it into. The storage failure is what the caller
    // needs to see.
    expect((caught as Error).message).toContain("storage unavailable");

    // The `createOnly` branch was never taken over the stored overview: its
    // bytes — `created` date included — are exactly as they were.
    expect((await readWikiPage("overview"))!.content).toBe(before);
  }, 20_000);

  it("rejects with the STORAGE error rather than minting a DUPLICATE source summary", async () => {
    await run();
    const summariesBefore = (await listWikiPages()).filter((entry) =>
      entry.title.includes("source summary"),
    );
    expect(summariesBefore).toHaveLength(1);
    const summarySlug = summariesBefore[0].slug;

    // Seeding the page index puts `listWikiPages` on its metadata fast path,
    // so the scan no longer reads page files and `findExistingSourceSummary`'s
    // own read is the first read of the summary this call makes.
    await rebuildPageIndex();

    // The scan that looks for an existing summary for this source is the read
    // under test. Blipped, it used to skip this page, find nothing, and hand
    // `ensureSourceSummary` a free slug for a second summary of one source.
    const { spy: readSpy, state } = blipOnce(summarySlug);
    let caught: unknown;
    try {
      await run({ sourceText: "The same source, ingested again." });
    } catch (err) {
      caught = err;
    } finally {
      readSpy.mockRestore();
    }

    expect(state.blipped).toBe(true);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("storage unavailable");

    // THE HARM THIS ROW EXISTS FOR: before the conversion this call RESOLVED,
    // having minted `<slug>-2` — a second summary page for one source, with
    // the stored one left behind.
    const summariesAfter = (await listWikiPages()).filter((entry) =>
      entry.title.includes("source summary"),
    );
    expect(summariesAfter.map((entry) => entry.slug)).toEqual([summarySlug]);
  }, 20_000);
});
