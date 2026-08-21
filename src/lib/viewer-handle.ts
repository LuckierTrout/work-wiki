"use client";

/**
 * The signed-in viewer's handle, resolved in the BROWSER — one copy of the rule.
 *
 * WHY THIS MODULE EXISTS. Several client islands gate an affordance on who the
 * viewer is: `ArticleActions` (Delete, Re-ingest, Graphify, Save to vault) and
 * `RevisionHistory` (Revert). Each needs the same answer, and the answer is not
 * a plain field read — it mirrors the server's `resolveHandle` in
 * `src/lib/auth.ts`, preferring the Clerk username and falling back to the
 * username on the X/Twitter external account, because Twitter-SSO users often
 * have no Clerk username set. Written out at each call site, that rule was
 * duplicated verbatim, and only its FIRST branch is exercised by the component
 * suites — so a drift between the copies would move two gates apart for exactly
 * the viewers the fallback exists for, silently. One copy, imported twice.
 *
 * WHY IT IS SAFE FOR A `"use client"` GRAPH. It imports `@clerk/nextjs` and
 * nothing else. It must never reach `@/lib/commons`, `@/lib/authz` or
 * `@/lib/wiki` — those pull storage, locks and `wiki.ts` into the browser
 * bundle, which is the whole reason the realm facts arrive at those islands as
 * server-computed props instead. `article-actions-gate.test.ts` scans this file
 * alongside the islands for exactly that.
 *
 * WHAT IT DOES NOT DECIDE. Only identity. Whether identity is ENOUGH is each
 * gate's own business, and every one of them is a convenience gate the server
 * re-authorizes anyway.
 */

import { useUser } from "@clerk/nextjs";

export interface ViewerHandle {
  /** Whether the Clerk session has resolved. Before it does, `handle` is
   *  `null` for a viewer who will turn out to be signed in — so any gate whose
   *  permissive answer depends on identity must wait for this. */
  isLoaded: boolean;
  /** Whether a session resolved to a signed-in user. */
  isSignedIn: boolean;
  /**
   * The viewer's handle, LOWERCASED, or `null` when signed out (or not yet
   * loaded). Lowercased here because every consumer compares it against
   * server-stored handles, which are lowercased on write — leaving the
   * normalization to each caller is the second way these gates could drift.
   */
  handle: string | null;
}

/** {@link ViewerHandle} for the current Clerk session. */
export function useViewerHandle(): ViewerHandle {
  const { isLoaded, isSignedIn, user } = useUser();
  const raw =
    user?.username ??
    user?.externalAccounts?.find(
      (a) => typeof a.provider === "string" && /(^|_)(x|twitter)$/i.test(a.provider),
    )?.username ??
    null;
  return {
    isLoaded,
    isSignedIn: !!isSignedIn,
    handle: raw?.toLowerCase() ?? null,
  };
}
