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
import * as talk from "../talk";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { writeDiscussFixture, readDiscussFixture } from "./discuss-fixtures";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "talk-test-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  // `deleteDiscussions` dynamic-imports `removeDiscussStatsForSlug`, which
  // writes the index under `withFileLock` — leave no lock held across suites.
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
  describe("the module's export surface (DW-390 deletion pin)", () => {
    // This repo has re-added a talk write-half AFTER a previous removal (see
    // `spec-dw-128-131-338-339-340-doc-drift-retired-surfaces.md`), and the
    // rest of this change only removes code — nothing left behind would fail
    // if a writer came back. This case is that alarm: re-export any of the six
    // and it goes red here, next to the banner explaining why they went.
    const DELETED = [
      "listThreads",
      "getThread",
      "createThread",
      "addComment",
      "resolveThread",
      "hasOpenThread",
      "_resetTimestamp",
    ] as const;

    const SURVIVING = [
      "getDiscussDir",
      "ensureDiscussDir",
      "getDiscussRelPrefix",
      "getDiscussionStatsForSlugs",
      "deleteDiscussions",
    ] as const;

    it("exports no thread writer, and none of their test-only scaffolding", () => {
      const exported = Object.keys(talk);
      for (const name of DELETED) {
        expect(
          exported,
          `talk.ts must not export "${name}" — the thread writers were deleted ` +
            `in DW-390 once the retired talk HTTP surfaces left them with no ` +
            `caller. A discuss file nothing serves is storage churn that reads ` +
            `like a working feature.`,
        ).not.toContain(name);
      }
    });

    it("still exports every reader that outlived them", () => {
      const exported = Object.keys(talk);
      for (const name of SURVIVING) {
        expect(exported, `talk.ts must still export "${name}"`).toContain(name);
      }
    });
  });

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
      await writeDiscussFixture("delete-page", [
        { title: "Thread", comments: [{ author: "alice", body: "Hi" }] },
      ]);
      // Verify file exists
      const filePath = path.join(getDiscussDir(), "delete-page.json");
      await expect(fs.stat(filePath)).resolves.toBeDefined();

      await deleteDiscussions("delete-page");

      // File should be gone
      await expect(fs.stat(filePath)).rejects.toThrow();
      // Reading back should return empty
      const threads = await readDiscussFixture("delete-page");
      expect(threads).toEqual([]);
    });

    it("does not throw for nonexistent page", async () => {
      await expect(deleteDiscussions("no-such-page")).resolves.toBeUndefined();
    });
  });

  describe("getDiscussionStatsForSlugs", () => {
    it("returns a map with correct per-slug stats", async () => {
      // Page A: 2 threads, 1 open
      await writeDiscussFixture("page-a", [
        { title: "A1", status: "open", comments: [{ author: "alice", body: "open" }] },
        { title: "A2", status: "resolved", comments: [{ author: "alice", body: "resolved" }] },
      ]);

      // Page B: 1 thread, all open
      await writeDiscussFixture("page-b", [
        { title: "B1", status: "open", comments: [{ author: "bob", body: "open" }] },
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
      await writeDiscussFixture("mixed-status", [
        { title: "Thread 1", status: "open", comments: [{ author: "alice", body: "Open" }] },
        { title: "Thread 2", status: "resolved", comments: [{ author: "bob", body: "Resolved" }] },
        { title: "Thread 3", status: "wontfix", comments: [{ author: "carol", body: "Wontfix" }] },
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
      await writeDiscussFixture("included", [
        { title: "T", comments: [{ author: "alice", body: "body" }] },
      ]);
      await writeDiscussFixture("excluded", [
        { title: "T", comments: [{ author: "bob", body: "body" }] },
      ]);

      const stats = await getDiscussionStatsForSlugs(["included"]);
      expect(stats.has("included")).toBe(true);
      expect(stats.has("excluded")).toBe(false);
      expect(stats.get("included")).toEqual({ total: 1, open: 1 });
    });
  });
});

/**
 * The auto-opened reconciliation-thread writer and its title constant are GONE
 * (DW-230), and so is the whole thread API they were the last caller of
 * (DW-390).
 *
 * DW-230: they opened a talk thread whenever a page flipped `disputed` on the
 * ingest, merge or metadata-patch path. The talk HTTP surfaces are retired, so
 * nothing could read what they wrote — a maintenance loop with no reader. The
 * cases that pinned the writer's idempotency and its non-agent author coercion
 * were deleted with it; the "no thread is written" half of the invariant now
 * lives beside each of the three former call sites (`ingest.test.ts`,
 * `merge.test.ts`, `patch-metadata.test.ts`), where a reintroduced writer would
 * actually be observed.
 *
 * DW-390: that left `listThreads`, `getThread`, `createThread`, `addComment`,
 * `resolveThread` and `hasOpenThread` with no non-test caller at all, so they
 * were deleted too — along with `_resetTimestamp`, the discuss-file writer and
 * the derived-index hooks only they used. Their describes went with them: they
 * asserted the behaviour of code that no longer exists. What survives above is
 * the coverage of the three exports that still have live callers, rebuilt on
 * `./discuss-fixtures`, the one shared writer of `discuss/<slug>.json` the
 * suites now share. The suites that used the writers merely to BUILD a discuss
 * file (`contributors`, `contributor-index`, `discuss-stats-index`,
 * `migrate-to-tenants`, `maintenance`) kept every assertion — only the fixture
 * builder changed.
 */
