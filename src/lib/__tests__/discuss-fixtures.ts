/**
 * Shared discuss-file fixture builder (DW-390).
 *
 * `talk.ts`'s thread WRITERS (`createThread`, `addComment`, `resolveThread`,
 * and the readers `listThreads` / `getThread` / `hasOpenThread`) were deleted
 * once the talk HTTP surfaces were retired. Several suites had been using them
 * only to *build a `discuss/<slug>.json` file* so they could exercise a
 * surviving reader — `contributors.ts`, `contributor-index.ts`,
 * `discuss-stats-index.ts`, `migrate-to-tenants.ts`, `maintenance.ts` and
 * `talk.ts`'s own `getDiscussionStatsForSlugs` / `deleteDiscussions`. This is
 * the ONE writer those suites share, so the on-disk shape cannot drift between
 * them (the DW-117 lesson).
 *
 * It writes the exact same JSON shape the deleted `createThread`/`addComment`
 * wrote, through `getStorage()` — never through `fs` — at a path derived from
 * production's own `getDiscussRelPrefix()` rather than a second literal, so
 * the directory name has ONE source of truth (the same DW-117 lesson) and the
 * DW-230 "no thread was written" pins assert at the path production reads,
 * not at one this file computed for itself. The tenant-scoped provider then
 * resolves it identically (see `migrate-to-tenants.test.ts`).
 *
 * NOT named `*.test.ts`: `test-infra-conventions.test.ts` pins that rule, and
 * either vitest project would otherwise collect this file as an empty suite.
 */

import { getStorage } from "../storage";
import { isEnoent } from "../errors";
import { getDiscussRelPrefix } from "../talk";
import type { TalkThread, TalkComment } from "../types";

/**
 * Storage-relative path for a discuss file, built from the SAME prefix
 * `discuss-stats-index.ts` and `contributors.ts` scan through. `talk.ts`'s own
 * `discussRelPath` is private; `getDiscussRelPrefix()` is the exported half of
 * it, so this is a derivation, not a copy.
 */
function discussRelPath(pageSlug: string): string {
  return `${getDiscussRelPrefix()}/${pageSlug}.json`;
}

/** Terse spec for one comment in a fixture thread. */
export interface DiscussCommentSpec {
  /** Comment author handle (or agent ID). */
  author: string;
  /** Markdown body. Defaults to a stable placeholder. */
  body?: string;
  /** ISO date string. Defaults to "now". */
  created?: string;
  /** Parent comment id for a threaded reply. Defaults to null (top level). */
  parentId?: string | null;
}

/** Terse spec for one fixture thread. */
export interface DiscussThreadSpec {
  /** Thread title. Defaults to a stable placeholder. */
  title?: string;
  /** Thread status. Defaults to "open" — what `createThread` wrote. */
  status?: TalkThread["status"];
  /** Ordered comments. At least one is expected (a thread always has a root). */
  comments: DiscussCommentSpec[];
}

/**
 * Write `discuss/<pageSlug>.json` from a terse thread spec, replacing whatever
 * was there. Returns the threads exactly as persisted.
 *
 * Comment ids are minted deterministically per file (`<slug>-t<i>-c<j>`), so a
 * fixture is reproducible run to run; `created` defaults to now, and a thread's
 * `created`/`updated` are taken from its first/last comment — the same
 * relationship `createThread` + `addComment` produced.
 */
export async function writeDiscussFixture(
  pageSlug: string,
  threadSpecs: DiscussThreadSpec[],
): Promise<TalkThread[]> {
  const now = new Date().toISOString();

  const threads: TalkThread[] = threadSpecs.map((spec, threadIndex) => {
    const comments: TalkComment[] = spec.comments.map((comment, commentIndex) => ({
      id: `${pageSlug}-t${threadIndex}-c${commentIndex}`,
      author: comment.author,
      created: comment.created ?? now,
      body: comment.body ?? `comment ${commentIndex}`,
      parentId: comment.parentId ?? null,
    }));

    return {
      pageSlug,
      title: spec.title ?? `Thread ${threadIndex + 1}`,
      status: spec.status ?? "open",
      created: comments[0]?.created ?? now,
      updated: comments[comments.length - 1]?.created ?? now,
      comments,
    };
  });

  await getStorage().writeFile(
    discussRelPath(pageSlug),
    JSON.stringify(threads, null, 2),
  );
  return threads;
}

/**
 * Read back `discuss/<pageSlug>.json`. Returns `[]` when the file is absent —
 * the same "no discussions" answer the deleted `listThreads` gave, which is
 * what the DW-230 "no thread was written" pins assert.
 */
export async function readDiscussFixture(pageSlug: string): Promise<TalkThread[]> {
  try {
    const raw = await getStorage().readFile(discussRelPath(pageSlug));
    return JSON.parse(raw) as TalkThread[];
  } catch (err) {
    if (isEnoent(err)) return [];
    throw err;
  }
}
