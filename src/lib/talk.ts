// ---------------------------------------------------------------------------
// Talk pages — Phase 2 threaded discussion system (data layer)
// ---------------------------------------------------------------------------
//
// Each wiki page's discussions live in `discuss/<slug>.json` — a JSON file
// containing an array of TalkThread objects. JSON rather than markdown because
// talk pages are structured data (threading, status, IDs) that would be painful
// to round-trip through frontmatter.
// ---------------------------------------------------------------------------

import { getStorage } from "./storage";
import { getDataDir } from "./paths";
import { isEnoent } from "./errors";
import { logger } from "./logger";
import type { TalkThread } from "./types";

// ---------------------------------------------------------------------------
// RETIRED (DW-230, then DW-390): the thread WRITERS are gone.
//
// DW-230 deleted the auto-opened reconciliation-thread writer and the title
// constant that was its idempotency key. A `disputed: false → true` transition
// on the ingest, merge and metadata-patch paths used to open a talk thread
// through them. The talk HTTP surfaces are retired, so no surface could ever
// read that thread: the writer produced a discuss file nobody would see, on a
// page whose `disputed` flag already says the same thing where a reader can
// find it.
//
// That took the last non-test caller of the thread API, so DW-390 deleted it:
// `listThreads`, `getThread`, `createThread`, `addComment`, `resolveThread`
// and `hasOpenThread` no longer exist here, along with the discuss-file writer
// and the derived-index hooks (`syncDiscussStatsForSlug`,
// `recordTalkForAuthor`) that only those writers called. Both index modules are
// untouched and still correct — they simply have no production writer left.
// What became of their entries then differs, so don't read the two alike:
// discuss-stats is still rebuilt from ground truth by the daily maintenance
// scan, but the contributor index no longer is — DW-126 dropped it from
// `rebuildDerivedIndexes` (and DW-125 removed its lifecycle write hook) once
// nothing read it, so nothing rebuilds it on any schedule.
//
// WHAT IS LEFT, HONESTLY — five exports plus the `DiscussionStats` type, and
// only two of them are reached from production:
//   • `deleteDiscussions`          — LIVE. The page-lifecycle teardown in
//     `lifecycle.ts` runs it when a wiki page is deleted.
//   • `getDiscussRelPrefix`        — LIVE. `discuss-stats-index.ts` and
//     `contributors.ts` scan `discuss/` through it.
//   • `getDiscussionStatsForSlugs` — has ONE production caller, `browse.ts`'s
//     per-page discussion count — but `browse.ts` itself has no non-test
//     importer now that `/api/wiki/browse` is a `RETIRED_SURFACES` entry, so
//     the whole chain is unreached. SCHEMA.md files it under "Present but
//     unreached"; do not read the caller as evidence of live use.
//   • `getDiscussDir` / `ensureDiscussDir` — no non-test caller either. A path
//     builder and a documented no-op, kept only because the decision behind
//     DW-390 enumerated exactly the six writers above, not these two.
// Nothing here authors a thread or a comment any more; test fixtures build
// `discuss/<slug>.json` through `__tests__/discuss-fixtures.ts`.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

const DISCUSS_DIR_NAME = "discuss";

/** Returns the discuss directory path. */
export function getDiscussDir(): string {
  return `${getDataDir()}/${DISCUSS_DIR_NAME}`;
}

/**
 * Despite the name, creates nothing: the storage provider makes parent
 * directories on write, so `discuss/` never needs to exist ahead of the first
 * one (SCHEMA.md, "Talk pages"). Why the export survives with an empty body is
 * in the retired-surfaces banner at the top of this file.
 */
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
