/**
 * Tests for the contributor SCAN — what survives in `src/lib/contributors.ts`
 * after DW-125 deleted the three profile builders (one handle, a batch of
 * handles, and every contributor) along with the retired contributor product
 * surfaces they fed. SCHEMA.md's "Contributor profiles" section names them.
 *
 * The subjects here are the exports that remain: `computeScanData` (the
 * wiki-wide activity + revert + talk scan), `computeTrustScore` (the trust
 * formula the contributor index applies on read) and the pure `reduceReverts`.
 * Every semantic the deleted builders used to assert through — agent-page
 * exclusion, automation-actor folding, talk counting, revert detection,
 * first/last seen, the trust formula — is asserted below against those.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { computeScanData, computeTrustScore, reduceReverts } from "../contributors";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { saveRevision, type Revision } from "../revisions";
import { writeDiscussFixture } from "./discuss-fixtures";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "contributors-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
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
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Helper: create a wiki page and register it in the index. */
async function createPage(slug: string, title: string, content: string) {
  await ensureDirectories();
  await writeWikiPage(slug, content);
  // updateIndex replaces the whole index, so we need to read existing entries first.
  // For tests, just write a single-entry index — tests create pages sequentially.
  const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
  let existing = "";
  try {
    existing = await fs.readFile(indexPath, "utf-8");
  } catch { /* doesn't exist yet */ }
  const line = `- [${title}](${slug}.md) — Summary of ${title}`;
  if (!existing.includes(line)) {
    const newContent = existing
      ? `${existing.trimEnd()}\n${line}\n`
      : `# Wiki Index\n\n${line}\n`;
    await fs.writeFile(indexPath, newContent, "utf-8");
  }
}

describe("computeScanData — revision activity", () => {
  it("returns empty maps when no revisions exist", async () => {
    await ensureDirectories();
    const { activityMap, revertCounts } = await computeScanData();
    expect(activityMap.size).toBe(0);
    expect(revertCounts.size).toBe(0);
  });

  it("aggregates edits per author across pages", async () => {
    await createPage("page-a", "Page A", "# Page A\n\nContent.");
    await createPage("page-b", "Page B", "# Page B\n\nContent.");

    // Alice edits page-a twice, bob edits page-b once.
    await saveRevision("page-a", "# Page A\n\nv1", "alice");
    await saveRevision("page-a", "# Page A\n\nv2", "alice");
    await saveRevision("page-b", "# Page B\n\nv1", "bob");

    const { activityMap } = await computeScanData();
    expect(activityMap.get("alice")!.editCount).toBe(2);
    expect(activityMap.get("alice")!.pagesEdited).toEqual(new Set(["page-a"]));
    expect(activityMap.get("bob")!.editCount).toBe(1);
  });

  it("counts distinct pages edited, not edits", async () => {
    await createPage("page-x", "Page X", "# Page X\n\nContent.");
    await createPage("page-y", "Page Y", "# Page Y\n\nContent.");

    await saveRevision("page-x", "# Page X\n\nv1", "alice");
    await saveRevision("page-x", "# Page X\n\nv2", "alice");
    await saveRevision("page-y", "# Page Y\n\nv1", "alice");

    const { activityMap } = await computeScanData();
    const alice = activityMap.get("alice")!;
    expect(alice.editCount).toBe(3);
    expect(alice.pagesEdited).toEqual(new Set(["page-x", "page-y"]));
  });

  it("excludes agent-scoped pages so agents aren't scanned as contributors", async () => {
    // A human page edited by a human...
    await createPage("page-a", "Page A", "# Page A\n\nContent.");
    await saveRevision("page-a", "# Page A\n\nv1", "alice");

    // ...and an agent-scoped page authored by the agent itself. Its author
    // (the agent's composite id) must NOT surface in the scan at all.
    await createPage(
      "agent-note",
      "Agent Note",
      "---\ntype: agent-knowledge\n---\n\n# Agent Note\n\nLearned.",
    );
    await saveRevision("agent-note", "# Agent Note\n\nv1", "yuanhao--yoyo");

    const { activityMap } = await computeScanData();
    expect([...activityMap.keys()]).toEqual(["alice"]);
  });

  it("folds automation authors (system/lint-fix) into the agent, not their own handles", async () => {
    await createPage(
      "page-a",
      "Page A",
      "---\nowner: alice\nvisibility: public\n---\n\n# Page A\n\nc.",
    );
    await saveRevision("page-a", "# Page A\n\nv1", "alice");
    await saveRevision("page-a", "# Page A\n\nv2", "system");
    await saveRevision("page-a", "# Page A\n\nv3", "lint-fix");
    // ...and a talk comment by an automation actor (the mergeTalkActivity path).
    await writeDiscussFixture("page-a", [
      {
        title: "T",
        comments: [
          { author: "alice", body: "post" },
          { author: "lint-fix", body: "auto comment" },
        ],
      },
    ]);

    const { activityMap } = await computeScanData({ id: "alice", handle: "alice" });
    const handles = [...activityMap.keys()];
    expect(handles).toContain("alice");
    expect(handles).toContain("yoyo");
    expect(handles).not.toContain("system");
    expect(handles).not.toContain("lint-fix");
    // Both automation revisions land on the agent, and so does its comment.
    expect(activityMap.get("yoyo")!.editCount).toBe(2);
    expect(activityMap.get("yoyo")!.commentCount).toBe(1);
  });

  it("honors the principal's visibility — a private page is scanned only for its owner", async () => {
    // A PUBLIC page edited by alice (visible to everyone).
    await createPage(
      "pub",
      "Pub",
      "---\nowner: alice\nvisibility: public\n---\n\n# Pub\n\nc.",
    );
    await saveRevision("pub", "# Pub\n\nv1", "alice");

    // A PRIVATE page owned+edited by bob (invisible to anonymous).
    await createPage(
      "priv",
      "Priv",
      "---\nowner: bob\nvisibility: private\n---\n\n# Priv\n\nc.",
    );
    await saveRevision("priv", "# Priv\n\nv1", "bob");

    const anon = await computeScanData(null);
    expect([...anon.activityMap.keys()]).toEqual(["alice"]);

    const asBob = await computeScanData({ id: "bob", handle: "bob" });
    expect([...asBob.activityMap.keys()].sort()).toEqual(["alice", "bob"]);
  });
});

describe("computeScanData — talk activity", () => {
  it("counts comments and credits the thread to its first commenter", async () => {
    await ensureDirectories();

    // Alice creates the thread (1 thread, 1 comment), bob replies (1
    // comment, 0 threads), alice follows up (2 comments total).
    await writeDiscussFixture("some-page", [
      {
        title: "Discussion",
        comments: [
          { author: "alice", body: "Initial post" },
          { author: "bob", body: "Reply to alice" },
          { author: "alice", body: "Follow-up" },
        ],
      },
    ]);

    const { activityMap } = await computeScanData();
    expect(activityMap.get("alice")!.commentCount).toBe(2);
    expect(activityMap.get("alice")!.threadsCreated).toBe(1);
    expect(activityMap.get("bob")!.commentCount).toBe(1);
    expect(activityMap.get("bob")!.threadsCreated).toBe(0);
  });

  it("has no entry at all for a handle with no activity", async () => {
    await ensureDirectories();
    const { activityMap, revertCounts } = await computeScanData();
    expect(activityMap.has("nobody")).toBe(false);
    expect(revertCounts.get("nobody")).toBeUndefined();
  });
});

describe("computeScanData — first/last seen", () => {
  it("carries the full date range of an author's revisions", async () => {
    await createPage("page-dates", "Dates", "# Dates\n\nContent.");

    // Create revisions with known timestamps by writing files directly
    const revisionsDir = path.join(process.env.WIKI_DIR!, ".revisions", "page-dates");
    await fs.mkdir(revisionsDir, { recursive: true });

    const earlyTs = 1700000000000; // 2023-11-14
    const lateTs  = 1800000000000; // 2027-01-15

    await fs.writeFile(path.join(revisionsDir, `${earlyTs}.md`), "v1", "utf-8");
    await fs.writeFile(
      path.join(revisionsDir, `${earlyTs}.meta.json`),
      JSON.stringify({ author: "timekeeper" }),
      "utf-8",
    );

    await fs.writeFile(path.join(revisionsDir, `${lateTs}.md`), "v2", "utf-8");
    await fs.writeFile(
      path.join(revisionsDir, `${lateTs}.meta.json`),
      JSON.stringify({ author: "timekeeper" }),
      "utf-8",
    );

    const { activityMap } = await computeScanData();
    // `dates` is what firstSeen/lastSeen are derived from (sorted min/max) by
    // every consumer of a scan — `contributor-index.ts:scanDataToIndex` today.
    const sorted = activityMap.get("timekeeper")!.dates.slice().sort();
    expect(sorted[0]).toBe(new Date(earlyTs).toISOString());
    expect(sorted[sorted.length - 1]).toBe(new Date(lateTs).toISOString());
  });
});

describe("computeTrustScore — the trust formula", () => {
  it("caps the activity factor at 1.0 for prolific contributors", () => {
    // 60 contributions is well above the /50 saturation point.
    expect(computeTrustScore(60, 0, 0)).toBe(1);
    expect(computeTrustScore(30, 30, 0)).toBe(1);
  });

  it("scales proportionally below the saturation point", () => {
    // 10 edits → trust = min(1, 10/50) = 0.2
    expect(computeTrustScore(10, 0, 0)).toBeCloseTo(0.2);
  });

  it("includes comment count in the activity factor", () => {
    // 5 comments, 0 edits → trust = min(1, 5/50) = 0.1
    expect(computeTrustScore(0, 5, 0)).toBeCloseTo(0.1);
  });

  it("penalizes each revert by 10%, capped at a 50% reduction", () => {
    // 1 edit, 1 revert → 0.02 * 0.9 = 0.018
    expect(computeTrustScore(1, 0, 1)).toBeCloseTo(0.018);
    // 6 reverts → the penalty caps at 0.5 even though 6*0.1 = 0.6
    expect(computeTrustScore(6, 0, 6)).toBeCloseTo(0.06);
    expect(computeTrustScore(6, 0, 6)).toBe(computeTrustScore(6, 0, 5));
  });

  it("applies to the counts a real scan produces", async () => {
    await createPage("page-low", "Low Page", "# Low\n\nContent.");
    for (let i = 0; i < 10; i++) {
      await saveRevision("page-low", `# Low\n\nv${i}`, "newcomer");
    }
    await writeDiscussFixture("page-low", [
      { title: "T", comments: [{ author: "newcomer", body: "hi" }] },
    ]);

    const { activityMap, revertCounts } = await computeScanData();
    const act = activityMap.get("newcomer")!;
    expect(act.editCount).toBe(10);
    expect(act.commentCount).toBe(1);
    // 11 contributions, no reverts → 11/50.
    expect(
      computeTrustScore(act.editCount, act.commentCount, revertCounts.get("newcomer") ?? 0),
    ).toBeCloseTo(0.22);
  });
});

describe("computeScanData — revert detection", () => {
  it("records no revert when nobody shrinks another author's content", async () => {
    await createPage("page-norevert", "No Revert", "# No Revert\n\nContent.");

    for (let i = 0; i < 10; i++) {
      await saveRevision("page-norevert", `# No Revert\n\nv${i} ${"x".repeat(100)}`, "alice");
    }

    const { revertCounts } = await computeScanData();
    expect(revertCounts.get("alice") ?? 0).toBe(0);
  });

  it("counts a >50% shrink by a different author against the reverted author", async () => {
    await createPage("page-reverted", "Reverted", "# Reverted\n\nContent.");

    // Alice writes a long revision; bob substantially reduces it.
    await saveRevision("page-reverted", "# Reverted\n\n" + "x".repeat(1000), "alice");
    await saveRevision("page-reverted", "# Reverted\n\nShort.", "bob");

    const { revertCounts } = await computeScanData();
    expect(revertCounts.get("alice")).toBe(1);
    // Bob's own content was never reverted.
    expect(revertCounts.get("bob") ?? 0).toBe(0);
  });

  it("does not count an author shrinking their OWN content", async () => {
    await createPage("page-self", "Self Edit", "# Self\n\nContent.");

    await saveRevision("page-self", "# Self\n\n" + "x".repeat(1000), "alice");
    await saveRevision("page-self", "# Self\n\nShort.", "alice");

    const { revertCounts } = await computeScanData();
    expect(revertCounts.get("alice") ?? 0).toBe(0);
  });

  it("requires more than a 50% size reduction", async () => {
    await createPage("page-small-edit", "Small Edit", "# Small\n\nContent.");

    // Alice writes 100 chars; bob trims only ~30% — not a revert.
    await saveRevision("page-small-edit", "# Small\n\n" + "x".repeat(100), "alice");
    await saveRevision("page-small-edit", "# Small\n\n" + "x".repeat(77), "bob");

    const { revertCounts } = await computeScanData();
    expect(revertCounts.get("alice") ?? 0).toBe(0);
  });

  it("accumulates repeated reverts of the same author", async () => {
    await createPage("page-multi", "Multi Revert", "# Multi\n\nContent.");

    for (let i = 0; i < 6; i++) {
      await saveRevision("page-multi", `# Multi\n\n${"x".repeat(1000)} round ${i}`, "alice");
      await saveRevision("page-multi", "# Multi\n\nReverted.", "bob");
    }

    const { activityMap, revertCounts } = await computeScanData();
    expect(revertCounts.get("alice")).toBe(6);
    // …and the trust formula caps the penalty those 6 reverts carry.
    const act = activityMap.get("alice")!;
    expect(computeTrustScore(act.editCount, act.commentCount, 6)).toBeCloseTo(0.06);
  });

  it("keys revert counts on the NORMALIZED handle, so automation reverts land on the agent", async () => {
    await createPage("page-auto-revert", "Auto Revert", "# Auto\n\nContent.");
    // "system" writes a large revision...
    await saveRevision("page-auto-revert", "# Auto\n\n" + "x".repeat(1000), "system");
    // ...then a human substantially shrinks it (>50% reduction = revert).
    await saveRevision("page-auto-revert", "# Auto\n\nShort.", "alice");

    const { activityMap, revertCounts } = await computeScanData();
    // The normalized handle "yoyo" appears in BOTH maps with matching keys.
    expect(activityMap.has("yoyo")).toBe(true);
    expect(revertCounts.get("yoyo")).toBe(1);
    expect(revertCounts.has("system")).toBe(false);
  });
});

describe("reduceReverts — normalizeActor (pure)", () => {
  /** Helper to build a minimal Revision object for unit tests. */
  function rev(author: string, sizeBytes: number, timestamp = 0): Revision {
    return { timestamp, date: new Date(timestamp).toISOString(), slug: "test-page", sizeBytes, author };
  }

  it("treats different automation handles as same-author (no false revert)", () => {
    // "system" writes 1000 bytes, then "lint-fix" shrinks to 100 bytes.
    // Both normalise to "yoyo", so this is a same-author edit, NOT a revert.
    const revisions: Revision[][] = [
      [rev("lint-fix", 100, 2), rev("system", 1000, 1)], // newest-first
    ];
    const counts = reduceReverts(revisions);
    // No revert should be counted — same normalized author.
    expect(counts.size).toBe(0);
  });

  it("keys revert counts on the normalized handle", () => {
    // "system" writes 1000 bytes, then "alice" shrinks to 100 (>50% reduction).
    // The revert count should be keyed as "yoyo" (normalized "system"), not "system".
    const revisions: Revision[][] = [
      [rev("alice", 100, 2), rev("system", 1000, 1)], // newest-first
    ];
    const counts = reduceReverts(revisions);
    expect(counts.get("yoyo")).toBe(1);
    expect(counts.has("system")).toBe(false);
  });
});
