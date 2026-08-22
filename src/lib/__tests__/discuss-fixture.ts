/**
 * Shared on-disk fixture for `discuss/<slug>.json`.
 *
 * DW-390 deleted `talk.ts`'s thread-writing API (`createThread`, `addComment`,
 * `resolveThread`, …) because nothing outside tests read it. Several suites used
 * those writers purely as a convenient way to *produce* a discuss file for the
 * modules that really read one — `contributors.ts`, `contributor-index.ts`,
 * `discuss-stats-index.ts`, `maintenance.ts`, `migrate-to-tenants.ts`. This
 * helper is the single replacement writer, so those five suites share one
 * faithful rendering of the shape documented in `SCHEMA.md` instead of each
 * hand-rolling the JSON.
 *
 * Deliberately not a `*.test.ts` file — vitest's node project only collects
 * `src/{@literal **}/__tests__/{@literal **}/*.test.ts`, so this contributes a
 * helper rather than an empty suite. (`email-ingest-wire.ts` is the precedent.)
 */
import { getStorage } from "../storage";
import { getDiscussRelPrefix } from "../talk";
import { isEnoent } from "../errors";
import type { TalkThread, TalkComment } from "../types";

/** Default ISO timestamp for seeded threads and comments. */
const DEFAULT_CREATED = "2025-01-01T00:00:00.000Z";

/**
 * Monotonic comment-ID counter. The real IDs were millisecond timestamps; the
 * only property anything depends on is uniqueness within a file.
 */
let nextCommentId = 0;

/** Storage-relative path of a page's discuss file. */
function discussRelPath(pageSlug: string): string {
  return `${getDiscussRelPrefix()}/${pageSlug}.json`;
}

/**
 * One `TalkComment` in the documented shape.
 *
 * Module-private on purpose: `discussThread` is the only caller, and this change
 * exists to delete readerless exports — shipping a new one would undo the point.
 */
function discussComment(
  author: string,
  body = `comment by ${author}`,
  created: string = DEFAULT_CREATED,
): TalkComment {
  nextCommentId += 1;
  return {
    id: String(nextCommentId),
    author,
    created,
    body,
    parentId: null,
  };
}

/**
 * One `TalkThread` with a comment per entry of `authors`, in order.
 *
 * Comment order is load-bearing: `contributors.ts:mergeTalkActivity` treats
 * `comments[0].author` as the thread creator and counts every comment against
 * its author, so `authors[0]` is who created the thread.
 *
 * Throws on an empty `authors` array or a blank author, mirroring the retired
 * `createThread`: it guaranteed exactly one comment at index 0 and rejected
 * empty/whitespace authors, so no thread production ever wrote had zero comments
 * or an anonymous one. A fixture that could seed that shape would let a suite
 * assert against a state the real system cannot reach.
 */
export function discussThread(
  pageSlug: string,
  opts: {
    title?: string;
    status?: TalkThread["status"];
    authors: string[];
    created?: string;
  },
): TalkThread {
  if (opts.authors.length === 0) {
    throw new Error(
      `discussThread("${pageSlug}"): authors must not be empty — every thread has at least a creator comment`,
    );
  }
  for (const author of opts.authors) {
    if (!author || !author.trim()) {
      throw new Error(
        `discussThread("${pageSlug}"): every author must be a non-empty string`,
      );
    }
  }
  const created = opts.created ?? DEFAULT_CREATED;
  return {
    pageSlug,
    title: opts.title ?? `Thread on ${pageSlug}`,
    status: opts.status ?? "open",
    created,
    updated: created,
    comments: opts.authors.map((author) =>
      discussComment(author, undefined, created),
    ),
  };
}

/**
 * OVERWRITE `discuss/<slug>.json` with `threads`, in the shape `SCHEMA.md`
 * documents.
 *
 * Not a drop-in for the retired `createThread`, which read-appended-wrote: two
 * `seedDiscussFile` calls for one slug do NOT accumulate, the second discards
 * the first. Seed every thread a slug needs in a single call.
 *
 * Writes ONLY the file — no derived index is touched. If a discuss-stats index
 * is already present, `getDiscussionStatsForSlugs` takes its O(1) fast path and
 * will report stale counts for the seeded slug; a test in that situation must
 * also call `syncDiscussStatsForSlug` or `rebuildDiscussStatsIndex`, as
 * `discuss-stats-index.test.ts` does. (With no index present — the common case —
 * the reader falls back to a directory scan and sees the seeded file directly.)
 *
 * Throws if any thread's own `pageSlug` disagrees with the slug it would be
 * written under: every call site names the slug twice, and a copy-paste that
 * files page `b`'s threads under `discuss/a.json` would be silently
 * mis-attributed by `contributors.ts` rather than failing.
 */
export async function seedDiscussFile(
  pageSlug: string,
  threads: TalkThread[],
): Promise<void> {
  for (const thread of threads) {
    if (thread.pageSlug !== pageSlug) {
      throw new Error(
        `seedDiscussFile("${pageSlug}"): thread self-identifies as page "${thread.pageSlug}" — a discuss file must only contain threads for its own slug`,
      );
    }
  }
  await getStorage().writeFile(
    discussRelPath(pageSlug),
    JSON.stringify(threads, null, 2),
  );
}

/** Read a page's threads back. Returns `[]` when no discuss file exists. */
export async function readDiscussThreads(
  pageSlug: string,
): Promise<TalkThread[]> {
  try {
    const raw = await getStorage().readFile(discussRelPath(pageSlug));
    return JSON.parse(raw) as TalkThread[];
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}
