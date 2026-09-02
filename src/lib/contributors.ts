// ---------------------------------------------------------------------------
// Contributor scan — Phase 2 trust and attribution (data layer)
// ---------------------------------------------------------------------------
//
// Aggregates raw contributor activity from two data sources:
//   1. Revision history — edits and page counts
//   2. Talk page discussions — comments and threads created
//
// WHAT THIS MODULE IS NOW: the wiki-wide scan ({@link computeScanData}), the
// pure reducers behind it, and the trust formula ({@link computeTrustScore}).
// The three profile BUILDERS that used to sit on top — one handle, a batch of
// handles, and every contributor — are deleted (DW-125; SCHEMA.md's
// "Contributor profiles" section names them). The contributor product surfaces
// they fed (`/wiki/contributors`, `GET /api/contributors[/:handle]`) are
// `RETIRED_SURFACES` entries, so the builders had test-only callers left.
//
// The one importer left is `src/lib/contributor-index.ts`, which serializes a
// scan into the persisted index shape and applies the trust formula on read.
// That module has no production caller of its own either — it is retained as an
// on-demand rebuild/repair tool, not live wiring. Nothing runs this scan on a
// schedule or on a request path any more.
// ---------------------------------------------------------------------------

import { getStorage } from "./storage";
import { listReadableWikiPages, isAgentScopedType } from "./wiki";
import type { Principal } from "./auth";
import { listRevisions, type Revision } from "./revisions";
import { getDiscussRelPrefix } from "./talk";
import { isEnoent } from "./errors";
import { normalizeActor } from "./agent-handle";
import type { TalkThread } from "./types";

// ---------------------------------------------------------------------------
// Internal: scan discuss directory for all thread files
// ---------------------------------------------------------------------------

/** Read and parse all discuss JSON files. Returns an array of TalkThread[]. */
async function loadAllThreads(): Promise<TalkThread[]> {
  const prefix = getDiscussRelPrefix();
  const storage = getStorage();
  let files: string[];
  try {
    const entries = await storage.listFiles(prefix);
    files = entries.map((e) => e.name);
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }

  const all: TalkThread[] = [];
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const raw = await storage.readFile(`${prefix}/${file}`);
      const threads = JSON.parse(raw) as TalkThread[];
      if (Array.isArray(threads)) {
        all.push(...threads);
      }
    } catch {
      // Malformed file — skip silently.
    }
  }
  return all;
}

// ---------------------------------------------------------------------------
// Internal: aggregate raw activity data
// ---------------------------------------------------------------------------

export interface AuthorActivity {
  editCount: number;
  pagesEdited: Set<string>;
  commentCount: number;
  threadsCreated: number;
  dates: string[];
}

export function emptyActivity(): AuthorActivity {
  return {
    editCount: 0,
    pagesEdited: new Set(),
    commentCount: 0,
    threadsCreated: 0,
    dates: [],
  };
}

/** Reduce per-page revision lists into activity keyed by author handle. Pure —
 *  the storage reads happen once in {@link computeScanData}. */
export function reduceActivity(
  revisionsPerPage: Revision[][],
): Map<string, AuthorActivity> {
  const map = new Map<string, AuthorActivity>();
  for (const revisions of revisionsPerPage) {
    for (const rev of revisions) {
      if (!rev.author) continue;
      const author = normalizeActor(rev.author);
      let act = map.get(author);
      if (!act) {
        act = emptyActivity();
        map.set(author, act);
      }
      act.editCount++;
      act.pagesEdited.add(rev.slug);
      act.dates.push(rev.date);
    }
  }
  return map;
}

/** Merge talk-page activity into an existing activity map. */
export function mergeTalkActivity(
  map: Map<string, AuthorActivity>,
  threads: TalkThread[],
): void {
  for (const thread of threads) {
    for (let i = 0; i < thread.comments.length; i++) {
      const comment = thread.comments[i];
      const author = normalizeActor(comment.author);
      let act = map.get(author);
      if (!act) {
        act = emptyActivity();
        map.set(author, act);
      }
      act.commentCount++;
      act.dates.push(comment.created);

      // The first comment (index 0) is the thread creator.
      if (i === 0) {
        act.threadsCreated++;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Revert detection
// ---------------------------------------------------------------------------

/** Size reduction threshold — a revision must shrink the previous content by
 *  more than this fraction to count as a revert. */
const REVERT_SIZE_REDUCTION_THRESHOLD = 0.5;

/**
 * Detect "reverts" from per-page revision lists — cases where revision N+1 by
 * author B substantially reduces the content of revision N by author A (>50%
 * size reduction). Pure; storage reads happen once in {@link computeScanData}.
 *
 * Returns a map from author handle → number of times their content was reverted.
 */
export function reduceReverts(revisionsPerPage: Revision[][]): Map<string, number> {
  const revertCounts = new Map<string, number>();

  for (const revisions of revisionsPerPage) {
    if (revisions.length < 2) continue;

    // listRevisions returns newest-first; we need chronological order.
    const chronological = revisions.slice().reverse();

    for (let i = 0; i < chronological.length - 1; i++) {
      const current = chronological[i];
      const next = chronological[i + 1];

      // Both revisions must have authors, and they must be different.
      if (!current.author || !next.author) continue;
      const currentAuthor = normalizeActor(current.author);
      const nextAuthor = normalizeActor(next.author);
      if (currentAuthor === nextAuthor) continue;

      // Check if the next revision substantially reduced the content size.
      if (current.sizeBytes === 0) continue;
      const reduction = (current.sizeBytes - next.sizeBytes) / current.sizeBytes;
      if (reduction > REVERT_SIZE_REDUCTION_THRESHOLD) {
        const count = revertCounts.get(currentAuthor) ?? 0;
        revertCounts.set(currentAuthor, count + 1);
      }
    }
  }

  return revertCounts;
}

// ---------------------------------------------------------------------------
// Trust score
// ---------------------------------------------------------------------------

/** Compute trust score from activity counts and revert rate.
 *  Formula: min(1, (editCount + commentCount) / 50) * (1 - min(0.5, revertCount * 0.1))
 *  Each revert reduces trust by 10%, capped at 50% reduction. */
export function computeTrustScore(editCount: number, commentCount: number, revertCount: number): number {
  const activityScore = Math.min(1, (editCount + commentCount) / 50);
  const revertPenalty = 1 - Math.min(0.5, revertCount * 0.1);
  return activityScore * revertPenalty;
}

// ---------------------------------------------------------------------------
// Shared scan data — one wiki-wide pass, reused by every consumer of a scan
// ---------------------------------------------------------------------------

/** The result of one wiki-wide contributor scan. */
export interface ContributorScanData {
  /** Revision activity per author handle. */
  activityMap: Map<string, AuthorActivity>;
  /** Revert counts per author handle. */
  revertCounts: Map<string, number>;
}

/**
 * Perform a single wiki-wide scan: revision activity, talk threads, and
 * revert detection. Expensive — it lists every readable page, reads every
 * page's revisions and every `discuss/` file — so it is computed once and the
 * result handed on, never re-run per handle.
 */
export async function computeScanData(
  principal: Principal | null = null,
): Promise<ContributorScanData> {
  // Human pages only — agent-scoped pages are authored by the agent itself
  // (e.g. "yuanhao--yoyo"), not a human contributor, so their revisions never
  // factor in. Filtering here also means we never read them.
  const pages = (await listReadableWikiPages(principal)).filter(
    (p) => !isAgentScopedType(p.type),
  );

  // Read every page's revisions ONCE, in parallel, and reuse the result for
  // both the activity scan and revert detection. Previously each of those
  // re-read all revisions in a serial await-in-loop — N pages turned into N
  // sequential storage round-trips, twice, the dominant cost on the homepage.
  // Threads load concurrently in the same barrier.
  const [revisionsPerPage, threads] = await Promise.all([
    Promise.all(pages.map((p) => listRevisions(p.slug))),
    loadAllThreads(),
  ]);

  const activityMap = reduceActivity(revisionsPerPage);
  mergeTalkActivity(activityMap, threads);
  const revertCounts = reduceReverts(revisionsPerPage);
  return { activityMap, revertCounts };
}
