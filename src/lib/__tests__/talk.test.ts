import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  getDiscussDir,
  ensureDiscussDir,
  deleteDiscussions,
  getDiscussionStatsForSlugs,
} from "../talk";
import { discussThread, seedDiscussFile, readDiscussThreads } from "./discuss-fixture";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "talk-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("talk page data layer", () => {
  describe("ensureDiscussDir", () => {
    it("is a no-op (storage provider creates directories on write)", async () => {
      // ensureDiscussDir is now a no-op — the storage provider handles
      // directory creation automatically when writing files.
      await ensureDiscussDir();
      // Verify getDiscussDir still returns a sensible path
      const dir = getDiscussDir();
      expect(dir).toContain("discuss");
    });
  });

  describe("deleteDiscussions", () => {
    it("removes all discussions for a page", async () => {
      const seeded = [
        discussThread("delete-page", { title: "Thread", authors: ["alice"] }),
      ];
      await seedDiscussFile("delete-page", seeded);
      // Verify file exists
      const filePath = path.join(getDiscussDir(), "delete-page.json");
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      // The ONE positive round-trip through the fixture's seed→read path. The
      // DW-230 regression guards in `ingest`/`merge`/`patch-metadata` all assert
      // `readDiscussThreads(...) === []`, which an ENOENT from a WRONG path
      // would satisfy just as happily as a genuinely unwritten file. Pinning a
      // real read here is what keeps those three guards non-vacuous.
      expect(await readDiscussThreads("delete-page")).toEqual(seeded);

      await deleteDiscussions("delete-page");

      // File should be gone
      await expect(fs.stat(filePath)).rejects.toThrow();
      // Reading it back should return empty
      const threads = await readDiscussThreads("delete-page");
      expect(threads).toEqual([]);
    });

    it("does not throw for nonexistent page", async () => {
      await expect(deleteDiscussions("no-such-page")).resolves.toBeUndefined();
    });
  });

  describe("getDiscussionStatsForSlugs", () => {
    it("returns a map with correct per-slug stats", async () => {
      // Page A: 2 threads, 1 open
      await seedDiscussFile("page-a", [
        discussThread("page-a", { title: "A1", authors: ["alice"] }),
        discussThread("page-a", {
          title: "A2",
          status: "resolved",
          authors: ["alice"],
        }),
      ]);

      // Page B: 1 thread, all open
      await seedDiscussFile("page-b", [
        discussThread("page-b", { title: "B1", authors: ["bob"] }),
      ]);

      // Page C: no threads (doesn't exist)

      const stats = await getDiscussionStatsForSlugs([
        "page-a",
        "page-b",
        "page-c",
      ]);

      expect(stats.get("page-a")).toEqual({ total: 2, open: 1 });
      expect(stats.get("page-b")).toEqual({ total: 1, open: 1 });
      expect(stats.get("page-c")).toEqual({ total: 0, open: 0 });
    });

    it("counts a wontfix thread toward total but not open", async () => {
      // Three threads: one left open, one resolved, one wontfix. Only the first
      // is `open`, but all three are `total` — a non-`open` status must not
      // disappear from the count.
      await seedDiscussFile("mixed-status", [
        discussThread("mixed-status", { title: "Thread 1", authors: ["alice"] }),
        discussThread("mixed-status", {
          title: "Thread 2",
          status: "resolved",
          authors: ["bob"],
        }),
        discussThread("mixed-status", {
          title: "Thread 3",
          status: "wontfix",
          authors: ["carol"],
        }),
      ]);

      const stats = await getDiscussionStatsForSlugs(["mixed-status"]);
      expect(stats.get("mixed-status")).toEqual({ total: 3, open: 1 });
    });

    it("returns all zeros when discuss directory does not exist", async () => {
      // Don't create any discussions — the discuss/ dir shouldn't exist
      const stats = await getDiscussionStatsForSlugs(["x", "y"]);
      expect(stats.get("x")).toEqual({ total: 0, open: 0 });
      expect(stats.get("y")).toEqual({ total: 0, open: 0 });
    });

    it("ignores discuss files for slugs not in the requested list", async () => {
      await seedDiscussFile("included", [
        discussThread("included", { title: "T", authors: ["alice"] }),
      ]);
      await seedDiscussFile("excluded", [
        discussThread("excluded", { title: "T", authors: ["bob"] }),
      ]);

      const stats = await getDiscussionStatsForSlugs(["included"]);
      expect(stats.has("included")).toBe(true);
      expect(stats.has("excluded")).toBe(false);
      expect(stats.get("included")).toEqual({ total: 1, open: 1 });
    });
  });
});

/**
 * The thread API this suite used to cover is GONE (DW-230, then DW-390).
 *
 * DW-230 deleted the auto-opened reconciliation-thread writer and its title
 * constant. They opened a talk thread whenever a page flipped `disputed` on the
 * ingest, merge or metadata-patch path. The talk HTTP surfaces are retired, so
 * nothing could read what they wrote — a maintenance loop with no reader. The
 * cases that pinned the writer's idempotency and its non-agent author coercion
 * were deleted with it; the "no thread is written" half of the invariant now
 * lives beside each of the three former call sites (`ingest.test.ts`,
 * `merge.test.ts`, `patch-metadata.test.ts`), where a reintroduced writer would
 * actually be observed.
 *
 * DW-390 finished the job: `listThreads`, `getThread`, `createThread`,
 * `addComment`, `resolveThread` and `hasOpenThread` had no caller outside this
 * file, so the cases that covered only *their* behavior went with them —
 * validation errors, threaded `parentId` nesting, resolve/reopen transitions,
 * and the `concurrent writes` case that pinned `withFileLock` inside
 * `addComment` (the lock's own coverage lives in `lock.test.ts`, and the
 * function it guarded no longer exists).
 *
 * What survives above is exactly what still has a live reader:
 * `getDiscussionStatsForSlugs` (`browse.ts`), `deleteDiscussions`
 * (`lifecycle.ts`) and the `getDiscussDir` / `ensureDiscussDir` path helpers.
 * Their fixtures come from `./discuss-fixture`, which writes the on-disk shape
 * documented in `SCHEMA.md` directly — nothing they assert ever flowed through
 * the deleted writers.
 */
