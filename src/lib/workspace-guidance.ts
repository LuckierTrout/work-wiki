/**
 * The ACTIVE Wiki's Workspace Purpose, rendered for a prompt.
 *
 * This is the composed reader that sits above both stores: it asks `wikis.ts`
 * which Wiki is current and `workspace-profile.ts` for that Wiki's profile.
 * It lives in its own module because `wikis.ts` already imports
 * `workspace-profile.ts` (the seeder writes the profile), so putting this
 * lookup in the profile store would close an import cycle. See `wiki-paths.ts`
 * for the layering.
 *
 * Every prompt site that used to import `buildWorkspaceGuidance` from
 * `workspace-profile` imports it from here instead; the call signature is
 * unchanged, so switching the active Wiki now swaps which profile reaches
 * ingest, chat, query, monitoring, extraction and the agent runtime.
 *
 * Both reads happen on EVERY call unless the caller opts into a
 * {@link WorkspaceGuidanceCache} — an optional, caller-owned, per-operation memo
 * (DW-141). Only `ingest.ts` needs it today; every other prompt site asks once
 * per operation and passes nothing.
 */

import { logger } from "./logger";
import { getCurrentWiki } from "./wikis";
import {
  getWorkspaceProfile,
  renderWorkspaceGuidance,
} from "./workspace-profile";

/**
 * A caller-owned memo of resolved guidance, keyed by `owner`.
 *
 * Deliberately a plain `Map` the CALLER creates: the handle's lifetime is
 * exactly the lifetime of the variable holding it, so a request that makes one
 * resolves once and a request that makes none behaves exactly as before. There
 * is no module-level cache, no process-global, and no TTL — an ambient scope
 * (`AsyncLocalStorage`, or a singleton keyed by owner) would memoize everywhere
 * for free but hide the lifetime from the call site, and would silently span a
 * long bulk run where a Purpose saved mid-run should still be picked up.
 *
 * Keyed by `owner` so one handle shared by two owners never crosses their
 * guidance. Holds the PROMISE rather than the string so the `Promise.all` pairs
 * in `ingest.ts` share one in-flight resolution instead of racing two.
 */
export type WorkspaceGuidanceCache = Map<string, Promise<string>>;

/** A fresh, empty handle. One per request/operation — never reused across them. */
export function createWorkspaceGuidanceCache(): WorkspaceGuidanceCache {
  return new Map();
}

/**
 * The uncached resolution — today's body verbatim, moved here so the cached and
 * uncached paths cannot drift.
 */
async function resolveWorkspaceGuidance(owner: string): Promise<string> {
  try {
    const wiki = await getCurrentWiki(owner);
    // No Wiki, no profile to key a read on, no guidance (DW-137). This branch
    // used to read the retired `tenants/<t>` singleton so an owner who had not
    // created a Wiki yet still saw their pre-split purpose in every prompt —
    // the same read-through `getWorkspaceProfile` carried, kept a second time
    // because this path has no `wikiId`. Both are gone: the legacy address is
    // now relocated once by `workspace-profile-backfill.ts` and lives nowhere
    // on a live read path. An owner with no Wiki has nothing the prompt can
    // name, and inventing one from a retired file is exactly the behaviour that
    // had no end date.
    if (!wiki) return "";
    return renderWorkspaceGuidance(await getWorkspaceProfile(owner, wiki.id));
  } catch (error) {
    // Fail soft. Guidance is an ADDITION to a prompt — losing it degrades the
    // answer, while throwing would fail the whole ingest or chat turn over a
    // damaged registry or an unreadable profile. Warn so it is diagnosable.
    logger.warn(
      "workspace-guidance",
      `resolving the active wiki's Workspace Purpose for "${owner}" failed — continuing without it`,
      error,
    );
    return "";
  }
}

/**
 * The ACTIVE Wiki's Workspace Purpose, rendered for a prompt.
 *
 * With no `cache`, this is exactly the call it has always been: a registry read
 * plus a profile read, every time. Pass a handle from
 * {@link createWorkspaceGuidanceCache} to resolve at most once per owner for the
 * life of that handle — an `ingest()` of one document calls this up to three
 * times (system prompt, map/reduce REDUCE, reconcile) for a value that cannot
 * change mid-document.
 *
 * The memo is stored BEFORE the resolution settles, so concurrent callers join
 * the same in-flight promise rather than starting a second read.
 *
 * A fail-soft `""` is memoized too, and on purpose: the `catch` below means this
 * never rejects, so a memoized promise can never poison the request, and a
 * damaged registry that already warned once should not be re-read (and
 * re-warned) two more times for the same value.
 *
 * Be honest about what that costs now that the handle's scope is the CALLER's
 * (DW-324): a handle can span a whole request, not just one document, so a
 * single transient registry/profile failure strips the Workspace Purpose from
 * every remaining document of that request and warns about it exactly once.
 * That is accepted, not overlooked. Re-resolving per document is precisely the
 * repetition DW-324 removes, and the degrade is bounded — guidance is an
 * ADDITION to a prompt, and the next handle (the next request, or the next
 * `ingest()` that mints its own) resolves fresh. Contrast `NamesTermsCache`,
 * whose read can genuinely REJECT and is therefore evicted rather than pinned:
 * there the memoized value would be a thrown error, not a degraded prompt.
 */
export async function buildWorkspaceGuidance(
  owner: string,
  cache?: WorkspaceGuidanceCache,
): Promise<string> {
  if (!cache) return resolveWorkspaceGuidance(owner);
  const memo = cache.get(owner);
  if (memo) return memo;
  const pending = resolveWorkspaceGuidance(owner);
  cache.set(owner, pending);
  return pending;
}
