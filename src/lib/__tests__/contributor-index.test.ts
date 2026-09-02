import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getContributorIndex,
  recordEditForAuthor,
  reverseEditForAuthor,
  recordTalkForAuthor,
  rebuildContributorIndex,
  profilesFromIndex,
} from "../contributor-index";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { saveRevision } from "../revisions";
import { writeDiscussFixture } from "./discuss-fixtures";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contributor-index-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createPage(slug: string, title: string, content: string) {
  await ensureDirectories();
  await writeWikiPage(slug, content);
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch { /* none */ }
  const line = `- [${title}](${slug}.md) — ${title}`;
  if (!existing.includes(line)) {
    await fs.writeFile(
      indexPath,
      existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
      "utf-8",
    );
  }
}

describe("incremental maintenance (seeded index)", () => {
  beforeEach(async () => {
    // The incremental hooks are no-ops until the index exists (the daily rebuild
    // seeds it). Seed an empty index by rebuilding over an empty wiki.
    await ensureDirectories();
    await rebuildContributorIndex();
  });

  it("recordEditForAuthor bumps editCount + pagesEdited", async () => {
    await recordEditForAuthor("alice", "p1", "2026-01-01T00:00:00Z");
    await recordEditForAuthor("alice", "p2", "2026-01-02T00:00:00Z");
    await recordEditForAuthor("alice", "p1", "2026-01-03T00:00:00Z"); // same page again
    const idx = (await getContributorIndex())!;
    expect(idx.authors.alice.editCount).toBe(3);
    expect(new Set(idx.authors.alice.pagesEdited)).toEqual(new Set(["p1", "p2"]));
    expect(idx.authors.alice.firstSeen).toBe("2026-01-01T00:00:00Z");
    expect(idx.authors.alice.lastSeen).toBe("2026-01-03T00:00:00Z");
    expect(idx.totals.revisionCount).toBe(3);
    expect(idx.totals.contributorCount).toBe(1);
  });

  it("reverseEditForAuthor decrements editCount + drops the slug", async () => {
    await recordEditForAuthor("alice", "p1");
    await recordEditForAuthor("alice", "p2");
    await reverseEditForAuthor("alice", "p1");
    const idx = (await getContributorIndex())!;
    expect(idx.authors.alice.editCount).toBe(1);
    expect(idx.authors.alice.pagesEdited).toEqual(["p2"]);
  });

  it("recordTalkForAuthor bumps comment / thread counts", async () => {
    await recordTalkForAuthor("bob", { comment: true, thread: true });
    await recordTalkForAuthor("bob", { comment: true });
    const idx = (await getContributorIndex())!;
    expect(idx.authors.bob.commentCount).toBe(2);
    expect(idx.authors.bob.threadsCreated).toBe(1);
  });
});

describe("rebuildContributorIndex — scan → index serialization", () => {
  it("serializes revision, talk and revert facts from the scan into the index", async () => {
    await createPage("p1", "P1", "# P1\n\nbody");
    await createPage("p2", "P2", "# P2\n\nbody");
    // alice writes long, then bob shrinks it >50% → a revert against alice.
    await saveRevision("p1", "# P1\n\n" + "x".repeat(1000), "alice");
    await saveRevision("p1", "# P1\n\nShort.", "bob");
    await saveRevision("p2", "# P2\n\nv1", "alice");
    await writeDiscussFixture("p1", [
      { title: "Q", comments: [{ author: "bob", body: "a question" }] },
    ]);

    expect(await getContributorIndex()).toBeNull();
    const idx = await rebuildContributorIndex();

    // Revision facts: counts and the DISTINCT slug list.
    expect(idx.authors.alice.editCount).toBe(2);
    expect(new Set(idx.authors.alice.pagesEdited)).toEqual(new Set(["p1", "p2"]));
    // Talk facts, from the discuss file the same scan reads.
    expect(idx.authors.bob.commentCount).toBe(1);
    expect(idx.authors.bob.threadsCreated).toBe(1);
    // Revert facts — only the full scan produces these.
    expect(idx.authors.alice.revertCount).toBe(1);
    expect(idx.authors.bob.revertCount).toBe(0);
    // Totals are derived from the authors map.
    expect(idx.totals.contributorCount).toBe(2);
    expect(idx.totals.revisionCount).toBe(3);
    // …and it is what a subsequent read returns.
    expect(await getContributorIndex()).toEqual(idx);
  });

  it("derives firstSeen/lastSeen from the earliest and latest revision dates", async () => {
    // The incremental hooks above advance firstSeen/lastSeen from the `date`
    // they are handed. This pins the OTHER derivation — the min/max over a
    // scan's collected dates that only the rebuild performs — so replacing it
    // with a constant (an epoch, or the newest date twice) fails here.
    await createPage("dated", "Dated", "# Dated\n\nbody");
    const revisionsDir = path.join(process.env.WIKI_DIR!, ".revisions", "dated");
    await fs.mkdir(revisionsDir, { recursive: true });

    const earlyTs = 1700000000000; // 2023-11-14
    const midTs   = 1750000000000; // 2025-06-15
    const lateTs  = 1800000000000; // 2027-01-15
    // Written newest-first on disk order-independence: the scan sorts, not us.
    for (const ts of [midTs, lateTs, earlyTs]) {
      await fs.writeFile(path.join(revisionsDir, `${ts}.md`), `v${ts}`, "utf-8");
      await fs.writeFile(
        path.join(revisionsDir, `${ts}.meta.json`),
        JSON.stringify({ author: "timekeeper" }),
        "utf-8",
      );
    }

    const idx = await rebuildContributorIndex();
    const a = idx.authors.timekeeper;
    expect(a.editCount).toBe(3);
    expect(a.firstSeen).toBe(new Date(earlyTs).toISOString());
    expect(a.lastSeen).toBe(new Date(lateTs).toISOString());
    // Not the same value twice — the two ends are genuinely distinct.
    expect(a.firstSeen).not.toBe(a.lastSeen);
  });

  it("profilesFromIndex recounts pagesEdited DISTINCTLY from the stored slug list", async () => {
    // The index stores a slug LIST; a profile reports a COUNT of distinct slugs.
    // alice edits one page twice and another once → 3 edits over 2 pages.
    await createPage("p1", "P1", "# P1\n\nbody");
    await createPage("p2", "P2", "# P2\n\nbody");
    await saveRevision("p1", "# P1\n\nv1", "alice");
    await saveRevision("p1", "# P1\n\nv2", "alice");
    await saveRevision("p2", "# P2\n\nv1", "alice");

    const idx = await rebuildContributorIndex();
    const alice = profilesFromIndex(idx).find((p) => p.handle === "alice")!;
    expect(alice.editCount).toBe(3);
    // 2, not 3 — a COUNT of pages, never the edit count.
    expect(alice.pagesEdited).toBe(2);

    // …and the recount is genuinely DISTINCT, not just the list's length. A
    // rebuilt index can't show that (its list comes from a Set, so it never
    // holds a duplicate), so pin it on the pure reader with a list that does.
    // This is the defence that keeps a duplicate-bearing index — a hand-repaired
    // one, or a future incremental writer that forgets to dedupe — from
    // reporting more pages than the author actually touched.
    const dupes = profilesFromIndex({
      authors: {
        dup: {
          editCount: 3,
          pagesEdited: ["p1", "p1", "p2"],
          commentCount: 0,
          threadsCreated: 0,
          firstSeen: "2026-01-01T00:00:00Z",
          lastSeen: "2026-01-03T00:00:00Z",
          revertCount: 0,
        },
      },
      totals: { revisionCount: 3, contributorCount: 1 },
    });
    expect(dupes[0].pagesEdited).toBe(2); // 2 distinct, not 3 entries
  });

  it("profilesFromIndex applies the trust formula and sorts by editCount", async () => {
    await createPage("p1", "P1", "# P1\n\nbody");
    await saveRevision("p1", "# P1\n\nv1", "alice");
    await saveRevision("p1", "# P1\n\nv2", "alice");
    await saveRevision("p1", "# P1\n\nv3", "bob");
    const idx = await rebuildContributorIndex();
    const profiles = profilesFromIndex(idx);
    // alice has more edits → sorts first.
    expect(profiles[0].handle).toBe("alice");
    expect(profiles[0].editCount).toBe(2);
    expect(profiles.every((p) => p.trustScore >= 0 && p.trustScore <= 1)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The index is UNWIRED (DW-125 / DW-126)
// ---------------------------------------------------------------------------
//
// Nothing in production writes this index or schedules its rebuild any more:
// the lifecycle write/delete hooks and the `contributors` step of
// `rebuildDerivedIndexes` were removed with the retired contributor surfaces.
// These cases pin that absence, so a hook or a rebuild step reappearing (and
// with it the full-wiki scan the daily maintenance pass used to pay for) fails
// here rather than silently returning.
// ---------------------------------------------------------------------------

describe("no production writer and no scheduled rebuild", () => {
  it("rebuildDerivedIndexes rebuilds the six live indexes and NOT contributors", async () => {
    await createPage("p1", "P1", "# P1\n\nbody");
    const { rebuildDerivedIndexes } = await import("../maintenance");

    const results = await rebuildDerivedIndexes();

    // The six index rebuilds the function still runs. (`silo-reconcile` is
    // reported into the same map but is a post-step, not an index rebuild —
    // it predates this change and is untouched by it.)
    const indexRebuilds = Object.keys(results).filter((k) => k !== "silo-reconcile");
    expect(indexRebuilds.sort()).toEqual(
      ["backlinks", "commons", "discuss-stats", "owner-slugs", "pages", "recent"].sort(),
    );
    // …and each of them actually SUCCEEDED. Every step is fail-soft, so a
    // rebuild that threw still reports its key with `{ ok: false }` — asserting
    // the key set alone would pass on a pass that rebuilt nothing at all.
    for (const name of indexRebuilds) {
      expect(results[name]).toEqual({ ok: true });
    }
    expect(results).not.toHaveProperty("contributors");
    // The step is gone, so the daily pass never runs the wiki-wide contributor
    // scan — and never seeds the index it used to write.
    expect(await getContributorIndex()).toBeNull();
  });

  it("a lifecycle WRITE leaves the seeded index untouched while its own indexes update", async () => {
    await ensureDirectories();
    await rebuildContributorIndex(); // seed: empty wiki → empty authors map
    const seeded = await getContributorIndex();
    expect(seeded).toEqual({ authors: {}, totals: { revisionCount: 0, contributorCount: 0 } });

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    await writeWikiPageWithSideEffects({
      slug: "written-page",
      title: "Written Page",
      content: "# Written Page\n\nBody.\n",
      summary: "A written page",
      logOp: "ingest",
      author: "alice",
    });

    // The write itself landed, side effects and all — the page is stored and
    // listed, so the lifecycle path around the deleted hook still runs.
    const { readWikiPage, listWikiPages } = await import("../wiki");
    expect(await readWikiPage("written-page")).not.toBeNull();
    expect((await listWikiPages()).map((p) => p.slug)).toContain("written-page");

    // But the contributor index is byte-identical to the seed: no editCount, no
    // pagesEdited entry, no author key for "alice".
    expect(await getContributorIndex()).toEqual(seeded);
  });

  it("a lifecycle DELETE does not decrement the index", async () => {
    // Scope note: `deleteWikiPage` passes NO recovery argument, so this path
    // never carried the `.delete.contributor` idempotency receipt — not even
    // before the change. The receipt only ever existed on the merge delete, and
    // it is pinned there, in `merge.test.ts`. What has teeth HERE is the
    // decrement: alice's tally must survive a delete of a page she edited.
    await createPage("doomed", "Doomed", "# Doomed\n\nBody.\n");
    await saveRevision("doomed", "# Doomed\n\nBody.\n", "alice");
    const seeded = await rebuildContributorIndex();
    expect(seeded.authors.alice.editCount).toBe(1);
    expect(seeded.authors.alice.pagesEdited).toContain("doomed");

    const { deleteWikiPage } = await import("../lifecycle");
    await deleteWikiPage("doomed", "alice");

    // The page really is gone…
    const { readWikiPage } = await import("../wiki");
    expect(await readWikiPage("doomed")).toBeNull();
    // …and alice's tally is exactly as the rebuild left it: no decrement ran.
    expect(await getContributorIndex()).toEqual(seeded);
  });
});
