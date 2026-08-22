/**
 * One request-scoped handle for the two owner-keyed guidance memos (DW-322 /
 * DW-324).
 *
 * Every prompt that carries workspace guidance carries BOTH halves — the active
 * Wiki's Workspace Purpose and the owner's Names & Terms dictionary — and both
 * are resolved side by side at the same `Promise.all` pairs in `ingest.ts`.
 * Bundling their memos into one value means one optional trailing parameter to
 * thread instead of two parallel ones at every site.
 *
 * It is a COMPOSITE of two independently-owned memos rather than a single map
 * because both are keyed by `owner` but hold different values — one map would
 * collide on the key. Each leaf module owns the shape of its own memo; this
 * module only bundles them. It lives in its own file so neither leaf module has
 * to import the other (which would close an import cycle) and so a route can
 * mint a handle without importing the whole `ingest.ts` graph.
 *
 * The handle is CALLER-OWNED and PER-OPERATION: its lifetime is exactly the
 * lifetime of the variable holding it. There is no module-level cache, no
 * process-global and no TTL. An ambient scope (`AsyncLocalStorage`, a singleton
 * keyed by owner) would memoize everywhere for free, but it would hide the
 * lifetime from the call site and silently span a long-lived worker where a
 * Purpose or dictionary edit saved mid-run must still be picked up. Making the
 * scope a value the caller creates keeps "how stale may this be?" answerable by
 * reading the caller.
 *
 * Scope today, in four places:
 *
 *   - `ingest()` mints one per DOCUMENT when its caller supplies none.
 *   - `POST /api/ingest/batch` supplies one covering the URLs that request runs
 *     INLINE — and only those. URLs that ENQUEUE never see it: a queued task is
 *     its own later request and resolves guidance fresh, which is both what a
 *     queued task should do and the only option for a non-serializable handle.
 *   - The MCP `batch_ingest_urls` tool (`handleBatchIngest`) supplies one per
 *     TOOL CALL (DW-395). That door has no queue — every URL runs inline — so
 *     its handle covers the whole batch with no such split.
 *   - `mergePages()` mints one per MERGE (DW-323), covering its single
 *     reconcile call. A merge is one operation, so minting the handle STATES
 *     that scope instead of leaving it implied, and it is the seam a second
 *     guidance-consuming call in the same merge would use. It earns its keep
 *     today too: `mergePages` probes the dictionary under this handle before
 *     the fold — a merge cannot afford the rejection `listNamesTerms` can
 *     raise — and the reconcile then reads that memo instead of the store.
 *
 * What the two batch doors share is the unit: one user or agent action, one
 * consistent set of guidance. An edit landing mid-action is deliberately
 * invisible to the rest of it, and the next action mints a fresh handle that
 * sees it.
 */

import {
  createNamesTermsCache,
  type NamesTermsCache,
} from "./names-terms";
import {
  createWorkspaceGuidanceCache,
  type WorkspaceGuidanceCache,
} from "./workspace-guidance";

/** The two owner-keyed guidance memos that travel together. */
export interface GuidanceCache {
  /** Memoizes the active Wiki's rendered Workspace Purpose per owner. */
  workspace: WorkspaceGuidanceCache;
  /** Memoizes the owner's sorted Names & Terms ENTRIES (not the rendered block). */
  namesTerms: NamesTermsCache;
}

/** A fresh, empty handle. One per request/operation — never reused across them. */
export function createGuidanceCache(): GuidanceCache {
  return {
    workspace: createWorkspaceGuidanceCache(),
    namesTerms: createNamesTermsCache(),
  };
}
