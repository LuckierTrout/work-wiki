// ---------------------------------------------------------------------------
// Talk pages — Phase 2 threaded discussion system (data layer)
// ---------------------------------------------------------------------------
//
// Each wiki page's discussions live in `discuss/<slug>.json` — a JSON file
// containing an array of TalkThread objects. JSON rather than markdown because
// talk pages are structured data (threading, status, IDs) that would be painful
// to round-trip through frontmatter.
//
// This module no longer WRITES that file — see the retirement note below. It
// reads it (for discussion stats) and deletes it (for page teardown).
// ---------------------------------------------------------------------------

import { getStorage } from "./storage";
import { getDataDir } from "./paths";
import { isEnoent } from "./errors";
import { logger } from "./logger";
import type { TalkThread } from "./types";

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

const DISCUSS_DIR_NAME = "discuss";

/** Returns the discuss directory path. */
export function getDiscussDir(): string {
  return `${getDataDir()}/${DISCUSS_DIR_NAME}`;
}

/** Creates the `discuss/` directory if it doesn't exist. */
export async function ensureDiscussDir(): Promise<void> {
  /* Storage provider creates parent directories on write — no-op. */
}

/** Storage-relative path for a discuss file. */
function discussRelPath(pageSlug: string): string {
  return `${DISCUSS_DIR_NAME}/${pageSlug}.json`;
}

/** Storage-relative path prefix for discuss files — used by contributors.ts. */
export function getDiscussRelPrefix(): string {
  return DISCUSS_DIR_NAME;
}

// ---------------------------------------------------------------------------
// Internal file I/O helpers
// ---------------------------------------------------------------------------

/** Read and parse the discuss JSON file for a page. Returns [] if not found. */
async function readDiscussFile(pageSlug: string): Promise<TalkThread[]> {
  try {
    const raw = await getStorage().readFile(discussRelPath(pageSlug));
    return JSON.parse(raw) as TalkThread[];
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}

// ---------------------------------------------------------------------------
// RETIRED (DW-230, then DW-390): the thread-writing API that used to live here.
//
// DW-230 deleted the auto-opened reconciliation-thread writer and the title
// constant that was its idempotency key. A `disputed: false -> true` transition
// on the ingest, merge and metadata-patch paths used to open a talk thread
// through it. The talk HTTP surfaces are gone, so no surface could ever read
// that thread: the writer produced a discuss file nobody would see, on a page
// whose `disputed` flag already says the same thing where a reader can find it.
// The three call sites and the writer were deleted together.
//
// That left the rest of the thread API READERLESS outside this module's own
// tests — the six exports that listed threads, fetched one by index, opened a
// thread, appended a comment, changed a thread's status, and asked whether any
// thread was still open. DW-390 deleted all six, and with them the private
// machinery that existed only to serve them: the monotonic comment-ID source
// and its test-only reset hook, the discuss-file writer, and the two fail-soft
// derived-index hooks (discuss-stats and contributor-index) whose only callers
// those writers were. Nothing in this module writes `discuss/<slug>.json` any
// more; the seeding those tests needed now comes from
// `src/lib/__tests__/discuss-fixture.ts`, which writes the on-disk shape
// directly.
//
// WHAT IS LEFT, HONESTLY. Three exports have non-test callers:
// `deleteDiscussions` (the page-lifecycle teardown in `lifecycle.ts`),
// `getDiscussRelPrefix` (`discuss-stats-index.ts`, `contributors.ts`) and
// `getDiscussionStatsForSlugs` (`browse.ts`). The `getDiscussDir` /
// `ensureDiscussDir` path helpers are exercised only by this module's tests;
// they describe where the store lives and were out of DW-390's scope, so they
// stay — but nothing below should be read as evidence that they are in use.
//
// The derived indexes are NOT retired: `discuss-stats-index.ts` and
// `contributor-index.ts` rebuild themselves by scanning storage directly, so
// losing the incremental hooks costs them nothing while no writer exists.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Discussion stats — lightweight counts for badges and index views
// ---------------------------------------------------------------------------

/** Thread count stats for a single wiki page. */
export interface DiscussionStats {
  /** Total number of threads (any status). */
  total: number;
  /** Number of threads with status "open". */
  open: number;
}

/**
 * Batch version: return discussion stats for multiple slugs in one pass.
 * Reads the discuss directory once and returns a Map keyed by slug.
 * Slugs with no discussions are included with `{ total: 0, open: 0 }`.
 */
export async function getDiscussionStatsForSlugs(
  slugs: string[],
): Promise<Map<string, DiscussionStats>> {
  const result = new Map<string, DiscussionStats>();

  // Pre-populate with zeros so every requested slug has an entry.
  for (const slug of slugs) {
    result.set(slug, { total: 0, open: 0 });
  }

  // Fast path: project the requested slugs out of the precomputed discuss-stats
  // index (O(1)). Falls through to the directory scan below only when the index
  // is ABSENT (reader → null); an empty-but-present index is authoritative.
  try {
    const { getDiscussStatsIndex } = await import("./discuss-stats-index");
    const idx = await getDiscussStatsIndex();
    if (idx !== null) {
      for (const slug of slugs) {
        const stat = idx[slug];
        if (stat) result.set(slug, { total: stat.total, open: stat.open });
      }
      return result;
    }
  } catch {
    // Fall through to the scan — the index is purely an accelerator.
  }

  // Read directory listing once to find which discuss files exist.
  let files: string[] = [];
  try {
    const entries = await getStorage().listFiles(DISCUSS_DIR_NAME);
    files = entries.map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return result; // No discuss dir → all zeros.
    throw err;
  }

  // Build a set of slugs we care about for fast lookup.
  const slugSet = new Set(slugs);

  // Only read files that match a requested slug.
  const promises: Promise<void>[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    const slug = file.slice(0, -5); // strip ".json"
    if (!slugSet.has(slug)) continue;

    promises.push(
      readDiscussFile(slug).then((threads) => {
        result.set(slug, {
          total: threads.length,
          open: threads.filter((t) => t.status === "open").length,
        });
      }),
    );
  }

  await Promise.all(promises);
  return result;
}

/**
 * Remove all discussions for a page (called when a wiki page is deleted).
 * No-op if no discussions exist.
 */
export async function deleteDiscussions(pageSlug: string): Promise<void> {
  try {
    await getStorage().deleteFile(discussRelPath(pageSlug));
  } catch (err) {
    if (!isEnoent(err)) throw err;
    // File didn't exist — nothing to delete.
  }
  // Drop this slug's discuss-stats entry (fail-soft).
  try {
    const { removeDiscussStatsForSlug } = await import("./discuss-stats-index");
    await removeDiscussStatsForSlug(pageSlug);
  } catch (err) {
    logger.warn("discuss-stats", `stats remove skipped for "${pageSlug}":`, err);
  }
}
