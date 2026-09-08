/**
 * Precomputed **contributor** index (Phase 2 — precomputed KV indexes).
 *
 * Serializes the wiki-wide contributor scan ({@link computeScanData}) into a KV
 * blob of RAW per-author tallies — edits, pages, comments, threads, reverts and
 * a first/last-seen range — readable in O(1) instead of re-scanning every page's
 * revisions + every talk thread. No trust score is stored: the formula is applied
 * on READ, in {@link profilesFromIndex} / {@link contributorProfileFromIndex},
 * so a change to it never leaves a stale number persisted.
 *
 * Shape:
 * ```
 * {
 *   authors: Record<handle, {
 *     editCount; pagesEdited: string[]; commentCount; threadsCreated;
 *     firstSeen; lastSeen; revertCount
 *   }>,
 *   totals: { revisionCount; contributorCount }
 * }
 * ```
 * `pagesEdited` is stored as the SLUG LIST (not a count) — a shape chosen when
 * the index was maintained incrementally (add a slug on edit, recount distinct
 * on read). Nothing maintains it incrementally today; the list is still what
 * {@link rebuildContributorIndex} writes and what the read path counts.
 *
 * --- RETIRED WIRING, HONESTLY (DW-125/126/535) ---
 * This module has NO production reader and NO production writer left:
 *   • The readers are gone. `/wiki/contributors`, `GET /api/contributors` and
 *     `GET /api/contributors/:handle` are `RETIRED_SURFACES` entries; there is
 *     no `/u/<handle>` page; the `contributors.ts` profile builders that used
 *     to consult {@link contributorProfileFromIndex} and
 *     {@link profilesFromIndex} were deleted along with them.
 *   • The incremental writers are gone. The lifecycle write/delete hook that
 *     called {@link recordEditForAuthor} / {@link reverseEditForAuthor} was
 *     removed with the last reader, and the talk-page hook that called
 *     {@link recordTalkForAuthor} went with the thread writers in DW-390.
 *   • The scheduled rebuild is gone. `rebuildDerivedIndexes` no longer runs
 *     {@link rebuildContributorIndex}: a full wiki-wide scan every day is a
 *     real cost, and nothing consumed the result.
 * The module is RETAINED — every export intact — as an on-demand rebuild and
 * repair tool, because deleting it would decide whether the contributor trust
 * surface ever returns, which is a product call, not a cleanup.
 *
 * Be precise about what "on-demand" means here: no route, CLI command, MCP tool
 * or maintenance task kind calls {@link rebuildContributorIndex} today. There is
 * no operator entry point to it at all — only a direct call from code (a future
 * caller, or a one-off written against this module). Read nothing here as live
 * wiring.
 */

import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import {
  computeScanData,
  computeTrustScore,
  type ContributorScanData,
} from "./contributors";
import type { ContributorProfile } from "./types";

/** KV/derived-index key (`_idx:contributors`). */
const CONTRIBUTOR_INDEX_KEY = "contributors";
/** Single global lock — the authors map is global. */
const CONTRIBUTOR_INDEX_LOCK = "contributors-index";

/** Per-author aggregate stored in the index. */
export interface ContributorIndexAuthor {
  editCount: number;
  /** Distinct slugs edited (stored as a list for incremental maintenance). */
  pagesEdited: string[];
  commentCount: number;
  threadsCreated: number;
  firstSeen: string;
  lastSeen: string;
  revertCount: number;
}

/** The full contributor index blob. */
export interface ContributorIndex {
  authors: Record<string, ContributorIndexAuthor>;
  totals: { revisionCount: number; contributorCount: number };
}

const EPOCH = new Date(0).toISOString();

function emptyIndexAuthor(): ContributorIndexAuthor {
  return {
    editCount: 0,
    pagesEdited: [],
    commentCount: 0,
    threadsCreated: 0,
    firstSeen: "",
    lastSeen: "",
    revertCount: 0,
  };
}

/**
 * Read the contributor index, or `null` when absent/corrupt. Returns `null`
 * (not an empty index) so callers can distinguish "no index → fall back to the
 * live scan" from "index present but empty → genuinely no contributors".
 */
export async function getContributorIndex(): Promise<ContributorIndex | null> {
  try {
    const idx = await getStorage().getIndex<ContributorIndex>(CONTRIBUTOR_INDEX_KEY);
    if (!idx || typeof idx !== "object" || !idx.authors) return null;
    return idx;
  } catch (err) {
    logger.warn("contributor-index", "contributor index unreadable; treating as absent:", err);
    return null;
  }
}

async function putContributorIndex(idx: ContributorIndex): Promise<void> {
  await getStorage().putIndex(CONTRIBUTOR_INDEX_KEY, idx);
}

/** Recompute `totals` from the authors map (cheap; keeps totals from drifting). */
function computeTotals(
  authors: Record<string, ContributorIndexAuthor>,
): ContributorIndex["totals"] {
  let revisionCount = 0;
  let contributorCount = 0;
  for (const a of Object.values(authors)) {
    revisionCount += a.editCount;
    contributorCount += 1;
  }
  return { revisionCount, contributorCount };
}

/** Build a {@link ContributorProfile} from one stored author aggregate. */
function profileFromIndexAuthor(
  handle: string,
  a: ContributorIndexAuthor,
): ContributorProfile {
  return {
    handle,
    editCount: a.editCount,
    pagesEdited: new Set(a.pagesEdited).size,
    commentCount: a.commentCount,
    threadsCreated: a.threadsCreated,
    firstSeen: a.firstSeen || EPOCH,
    lastSeen: a.lastSeen || EPOCH,
    revertCount: a.revertCount,
    trustScore: computeTrustScore(a.editCount, a.commentCount, a.revertCount),
  };
}

/**
 * Build ONE handle's profile from the index, or `null` when the index is ABSENT
 * (a caller could then fall back to a live {@link computeScanData} scan). A
 * handle missing from a PRESENT index has no recorded public contributions → an
 * empty profile, so the caller still avoids the scan. Mirrors
 * {@link profilesFromIndex} for a single handle. No production caller — the
 * profile surfaces this served are retired.
 */
export async function contributorProfileFromIndex(
  handle: string,
): Promise<ContributorProfile | null> {
  const idx = await getContributorIndex();
  if (!idx) return null;
  return profileFromIndexAuthor(handle, idx.authors[handle] ?? emptyIndexAuthor());
}

/** Build the full sorted profile list from the index. No production caller —
 *  the homepage badges and `/wiki/contributors` this served are retired. */
export function profilesFromIndex(idx: ContributorIndex): ContributorProfile[] {
  const profiles = Object.entries(idx.authors).map(([handle, a]) =>
    profileFromIndexAuthor(handle, a),
  );
  profiles.sort(
    (x, y) => y.editCount - x.editCount || x.handle.localeCompare(y.handle),
  );
  return profiles;
}

// ---------------------------------------------------------------------------
// Incremental maintenance — edit facts + talk facts.
//
// UNREACHED: the lifecycle write/delete hook and the talk-page hook that called
// these are both deleted. They remain as the primitives a rebuilt index would
// be kept current with, should the contributor surface ever return.
// ---------------------------------------------------------------------------

/**
 * Record one edit by `author` on `slug`. Bumps editCount, adds the slug to
 * pagesEdited, and advances firstSeen/lastSeen. `date` defaults to now. Leaves
 * revertCount alone — it is a pairwise diff over a page's revision history, not
 * a single-author fact, so only {@link rebuildContributorIndex} sets it.
 */
export async function recordEditForAuthor(
  author: string,
  slug: string,
  date: string = new Date().toISOString(),
): Promise<void> {
  if (!author) return;
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return; // No index yet → rebuildContributorIndex seeds it; don't fabricate one.
    const a = idx.authors[author] ?? emptyIndexAuthor();
    a.editCount += 1;
    if (!a.pagesEdited.includes(slug)) a.pagesEdited.push(slug);
    if (!a.firstSeen || date < a.firstSeen) a.firstSeen = date;
    if (!a.lastSeen || date > a.lastSeen) a.lastSeen = date;
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

/**
 * Reverse one edit by `author` on `slug`. Decrements editCount and drops the
 * slug from pagesEdited. firstSeen/lastSeen and revertCount are left alone —
 * only {@link rebuildContributorIndex} reconciles them from ground truth.
 */
export async function reverseEditForAuthor(
  author: string,
  slug: string,
): Promise<void> {
  if (!author) return;
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return;
    const a = idx.authors[author];
    if (!a) return;
    a.editCount = Math.max(0, a.editCount - 1);
    a.pagesEdited = a.pagesEdited.filter((s) => s !== slug);
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

/**
 * Record talk activity for `author`: one comment, and optionally a new thread.
 * Advances firstSeen/lastSeen. Idempotency is not guaranteed — call exactly once
 * per new comment/thread; only a {@link rebuildContributorIndex} reconciles
 * drift.
 */
export async function recordTalkForAuthor(
  author: string,
  opts: { comment?: boolean; thread?: boolean; date?: string } = {},
): Promise<void> {
  if (!author) return;
  const date = opts.date ?? new Date().toISOString();
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    const idx = await getContributorIndex();
    if (!idx) return;
    const a = idx.authors[author] ?? emptyIndexAuthor();
    if (opts.comment) a.commentCount += 1;
    if (opts.thread) a.threadsCreated += 1;
    if (!a.firstSeen || date < a.firstSeen) a.firstSeen = date;
    if (!a.lastSeen || date > a.lastSeen) a.lastSeen = date;
    idx.authors[author] = a;
    idx.totals = computeTotals(idx.authors);
    await putContributorIndex(idx);
  });
}

// ---------------------------------------------------------------------------
// Rebuild — serialize a full scan into the index shape
// ---------------------------------------------------------------------------

/** Serialize {@link ContributorScanData} into the persisted index shape. */
export function scanDataToIndex(data: ContributorScanData): ContributorIndex {
  const authors: Record<string, ContributorIndexAuthor> = {};
  for (const [handle, act] of data.activityMap) {
    const sorted = act.dates.slice().sort();
    authors[handle] = {
      editCount: act.editCount,
      pagesEdited: [...act.pagesEdited],
      commentCount: act.commentCount,
      threadsCreated: act.threadsCreated,
      firstSeen: sorted.length > 0 ? sorted[0] : EPOCH,
      lastSeen: sorted.length > 0 ? sorted[sorted.length - 1] : EPOCH,
      revertCount: data.revertCounts.get(handle) ?? 0,
    };
  }
  return { authors, totals: computeTotals(authors) };
}

/**
 * Rebuild the contributor index from a full wiki scan. The module's only entry
 * point with a reason to be called: an on-demand repair/rebuild tool. It is NOT
 * on the daily `rebuildDerivedIndexes` pass — the scan walks every page's
 * revisions and every `discuss/` file, and nothing reads the result. Callers
 * pay that cost deliberately, when they want the index refreshed.
 */
export async function rebuildContributorIndex(): Promise<ContributorIndex> {
  const data = await computeScanData(null);
  const idx = scanDataToIndex(data);
  await withFileLock(CONTRIBUTOR_INDEX_LOCK, async () => {
    await putContributorIndex(idx);
  });
  return idx;
}
