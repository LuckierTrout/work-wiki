import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getDiscussStatsIndex,
  syncDiscussStatsForSlug,
  removeDiscussStatsForSlug,
  rebuildDiscussStatsIndex,
  statsFromThreads,
} from "../discuss-stats-index";
import { deleteDiscussions, getDiscussionStatsForSlugs } from "../talk";
import { writeDiscussFixture } from "./discuss-fixtures";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import type { TalkThread } from "../types";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "discuss-stats-test-"));
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

function thread(status: TalkThread["status"]): TalkThread {
  return { pageSlug: "p", title: "t", status, created: "", updated: "", comments: [] };
}

/** Seed an empty-but-present index so incremental hooks apply (not no-op). */
async function seedEmptyIndex() {
  await rebuildDiscussStatsIndex(); // no discuss files → writes `{}` (present, empty)
}

describe("no-op until seeded", () => {
  it("getDiscussStatsIndex returns null when absent", async () => {
    expect(await getDiscussStatsIndex()).toBeNull();
  });

  it("syncDiscussStatsForSlug no-ops before any rebuild (reader stays null)", async () => {
    await syncDiscussStatsForSlug("p", [thread("open")]);
    expect(await getDiscussStatsIndex()).toBeNull(); // not fabricated from one write
  });

  it("removeDiscussStatsForSlug no-ops before any rebuild", async () => {
    await removeDiscussStatsForSlug("p");
    expect(await getDiscussStatsIndex()).toBeNull();
  });

  it("rebuild seeds an empty-but-present index, then incremental updates apply", async () => {
    await seedEmptyIndex();
    expect(await getDiscussStatsIndex()).toEqual({});
    await syncDiscussStatsForSlug("p", [thread("open")]);
    expect((await getDiscussStatsIndex())?.p).toEqual({ total: 1, open: 1 });
  });
});

describe("syncDiscussStatsForSlug / removeDiscussStatsForSlug (after seeding)", () => {
  beforeEach(seedEmptyIndex);

  it("upserts {total, open} from the in-memory threads", async () => {
    await syncDiscussStatsForSlug("p", [thread("open"), thread("resolved")]);
    expect((await getDiscussStatsIndex())?.p).toEqual({ total: 2, open: 1 });
  });

  it("updates in place on re-sync", async () => {
    await syncDiscussStatsForSlug("p", [thread("open")]);
    await syncDiscussStatsForSlug("p", [thread("open"), thread("open")]);
    expect((await getDiscussStatsIndex())?.p).toEqual({ total: 2, open: 2 });
  });

  it("remove drops the entry", async () => {
    await syncDiscussStatsForSlug("p", [thread("open")]);
    await removeDiscussStatsForSlug("p");
    expect((await getDiscussStatsIndex())?.p).toBeUndefined();
  });
});

// The incremental-hook case that used to live here — "createThread /
// addComment / resolveThread keep stats fresh" — was deleted with its subject
// (DW-390). Those writers called `syncDiscussStatsForSlug` from `talk.ts`;
// both the writers and that hook are gone, so the case pinned nothing. The
// index is now maintained by `deleteDiscussions` (below) and the rebuild scan.
describe("talk teardown maintains the index (after seeding)", () => {
  beforeEach(seedEmptyIndex);

  it("deleteDiscussions removes the slug entry", async () => {
    const threads = await writeDiscussFixture("p", [
      { title: "Title", comments: [{ author: "alice", body: "first" }] },
    ]);
    // The entry has to be THERE for its removal to mean anything: the writers
    // that used to sync it are gone, so seed it through this module's own
    // upsert (the rebuild scan's incremental twin).
    await syncDiscussStatsForSlug("p", threads);
    expect((await getDiscussStatsIndex())?.p).toEqual({ total: 1, open: 1 });

    await deleteDiscussions("p");
    expect((await getDiscussStatsIndex())?.p).toBeUndefined();
  });
});

describe("rebuildDiscussStatsIndex", () => {
  it("scans the discuss dir and rebuilds all entries", async () => {
    await writeDiscussFixture("a", [
      { title: "A", status: "open", comments: [{ author: "alice", body: "x" }] },
    ]);
    await writeDiscussFixture("b", [
      { title: "B", status: "resolved", comments: [{ author: "bob", body: "y" }] },
    ]);
    await rebuildDiscussStatsIndex();
    const idx = await getDiscussStatsIndex();
    expect(idx?.a).toEqual({ total: 1, open: 1 });
    expect(idx?.b).toEqual({ total: 1, open: 0 });
  });
});

describe("getDiscussionStatsForSlugs read parity (fast path vs fallback)", () => {
  it("statsFromThreads counts correctly", () => {
    // Every non-`open` status counts toward `total` but not `open`. `wontfix`
    // is listed here purely as coverage: no test had driven that status through
    // the indexed path, not because the count ever treated it specially.
    expect(
      statsFromThreads([thread("open"), thread("resolved"), thread("wontfix")]),
    ).toEqual({
      total: 3,
      open: 1,
    });
  });

  it("fallback directory scan (empty index) matches the populated fast path", async () => {
    await writeDiscussFixture("a", [
      { title: "t", status: "open", comments: [{ author: "alice" }] },
      { title: "t", status: "resolved", comments: [{ author: "alice" }] },
    ]);

    // Index is absent → read falls back to the directory scan.
    expect(await getDiscussStatsIndex()).toBeNull();
    const fallback = await getDiscussionStatsForSlugs(["a", "missing"]);
    expect(fallback.get("a")).toEqual({ total: 2, open: 1 });
    expect(fallback.get("missing")).toEqual({ total: 0, open: 0 });

    // Rebuild → fast path → SAME result.
    await rebuildDiscussStatsIndex();
    expect(Object.keys((await getDiscussStatsIndex())!).length).toBeGreaterThan(0);
    const fast = await getDiscussionStatsForSlugs(["a", "missing"]);
    expect(fast.get("a")).toEqual(fallback.get("a"));
    expect(fast.get("missing")).toEqual(fallback.get("missing"));
  });

  it("a wontfix thread counts the same through the index as through the scan", async () => {
    // Indexed twin of the scan-path case "counts a wontfix thread toward total
    // but not open" in `talk.test.ts`; only `status` is load-bearing here. The
    // threads must be on disk BEFORE the rebuild: the index side reaches
    // `statsFromThreads` through `rebuildDiscussStatsIndex`'s scan, not through
    // `getDiscussionStatsForSlugs`, which only projects the stored
    // `{ total, open }` back out.
    await writeDiscussFixture("mixed-status", [
      { status: "open", comments: [{ author: "alice" }] },
      { status: "resolved", comments: [{ author: "bob" }] },
      { status: "wontfix", comments: [{ author: "carol" }] },
    ]);

    // Index absent → directory-scan fallback.
    expect(await getDiscussStatsIndex()).toBeNull();
    const fallback = await getDiscussionStatsForSlugs(["mixed-status"]);
    expect(fallback.get("mixed-status")).toEqual({ total: 3, open: 1 });

    // Rebuild → the fast path carries `wontfix` through `statsFromThreads`.
    await rebuildDiscussStatsIndex();
    expect((await getDiscussStatsIndex())?.["mixed-status"]).toEqual({ total: 3, open: 1 });
    const fast = await getDiscussionStatsForSlugs(["mixed-status"]);
    expect(fast.get("mixed-status")).toEqual(fallback.get("mixed-status"));

    // Index and disk agree above, so every assertion so far would also pass if
    // the fast path had thrown and silently fallen through to the scan. Make
    // them disagree: this sentinel exists only in the index — no discuss file
    // holds 99 threads — so reading it back is what proves the fast path, not
    // the scan, answered.
    await syncDiscussStatsForSlug("mixed-status", [
      ...Array.from({ length: 7 }, () => thread("open")),
      ...Array.from({ length: 92 }, () => thread("wontfix")),
    ]);
    const sentinel = await getDiscussionStatsForSlugs(["mixed-status"]);
    expect(sentinel.get("mixed-status")).toEqual({ total: 99, open: 7 });
  });
});
