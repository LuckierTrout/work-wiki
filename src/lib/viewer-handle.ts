"use client";

/**
 * The signed-in viewer's handle, as the BROWSER sees it — one copy of the rule.
 * (Read from the Clerk session on every live request; see THE E2E SEAM below
 * for the one path where the answer is resolved on the server instead.)
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
 * WHY IT IS SAFE FOR A `"use client"` GRAPH. Its only imports are `react` and
 * `@clerk/nextjs` — both already in every island's bundle, so this module adds
 * nothing to it. It must never reach `@/lib/commons`, `@/lib/authz` or
 * `@/lib/wiki` — those pull storage, locks and `wiki.ts` into the browser
 * bundle, which is the whole reason the realm facts arrive at those islands as
 * server-computed props instead. `article-actions-gate.test.ts` scans this file
 * alongside the islands for exactly that.
 *
 * WHAT IT DOES NOT DECIDE. Only identity. Whether identity is ENOUGH is each
 * gate's own business, and every one of them is a convenience gate the server
 * re-authorizes anyway.
 *
 * THE E2E SEAM (DW-534). Under the armed Playwright harness the root layout
 * renders the shell WITHOUT `<ClerkProvider>` — dummy Clerk keys make it throw
 * before the app can paint — and the identity is the `yopedia_e2e` HMAC cookie
 * instead. Read through Clerk, this hook answered SIGNED OUT for the very owner
 * `middleware.ts` admits, so every client gate failed closed for the one viewer
 * the harness has. {@link E2eViewerHandleContext} is the way in: the layout
 * resolves the cookie on the SERVER (`src/components/E2eViewerIdentity.tsx`,
 * through the same `principalFromCookieValue` middleware and `getPrincipal`
 * share) and injects the finished {@link ViewerHandle}. No new route, no
 * `NEXT_PUBLIC_*` mirror of the identity, and nothing changes for a normal
 * request: with no provider mounted the context is `null` and the Clerk read
 * below is the whole hook, exactly as before.
 */

import { createContext, useContext } from "react";
import { useUser } from "@clerk/nextjs";

export interface ViewerHandle {
  /**
   * Whether the viewer's identity has RESOLVED — i.e. whether the other two
   * fields are an answer or a not-yet. Before it does, `handle` is `null` for a
   * viewer who will turn out to be signed in, so any gate whose permissive
   * answer depends on identity must wait for this.
   *
   * On the Clerk path that means "the Clerk session has resolved", and it
   * starts `false`. On the injected E2E path it is unconditionally `true` from
   * the first render: the cookie was already read and verified on the server
   * before the tree existed, so there is no window to wait out — and the field
   * still means the same thing, which is why consumers need no second branch.
   */
  isLoaded: boolean;
  /** Whether the resolved identity is a signed-in user. */
  isSignedIn: boolean;
  /**
   * The viewer's handle, LOWERCASED, or `null` when signed out (or not yet
   * loaded). Lowercased here because every consumer compares it against
   * server-stored handles, which are lowercased on write — leaving the
   * normalization to each caller is the second way these gates could drift.
   */
  handle: string | null;
}

/**
 * A server-resolved {@link ViewerHandle}, or `null` for "resolve from Clerk".
 *
 * Carries the WHOLE handle rather than a handle string so that "armed" is
 * distinguishable from "armed but signed out": under the E2E harness a request
 * with no (or an invalid) `yopedia_e2e` cookie must answer signed-out — the same
 * answer the server gives — and `{isLoaded:true, isSignedIn:false, handle:null}`
 * says that, where a bare `null` handle would be indistinguishable from "nobody
 * injected anything, go ask Clerk". Clerk is not reachable on that path, so the
 * difference is a thrown render, not a wrong answer.
 *
 * Exported for `src/components/E2eViewerIdentityProvider.tsx` only. Nothing in
 * a production render path mounts it.
 */
export const E2eViewerHandleContext = createContext<ViewerHandle | null>(null);

/** {@link ViewerHandle} for the current Clerk session. */
function useClerkViewerHandle(): ViewerHandle {
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

/**
 * {@link ViewerHandle} for the current viewer — the injected E2E identity when
 * one is mounted, the Clerk session otherwise.
 *
 * WHY THE CLERK READ IS CONDITIONAL. On the armed E2E path there is no
 * `<ClerkProvider>` anywhere in the tree, and `useUser()` THROWS outside one —
 * so "call both and pick" is not available: it would take down every page the
 * harness drives. The two shapes that avoid the conditional call are worse.
 * Moving the Clerk read into a provider would strand every mounted island suite
 * that renders the island bare with `useUser` mocked (three of them today), and
 * a `try/catch` around a hook is not a thing React supports.
 *
 * WHY IT IS SAFE. `react-hooks/rules-of-hooks` guards against the call ORDER
 * changing between renders of the same component. It cannot here: the provider
 * is mounted (or not) by `RootLayout` from `isE2eIdentityArmed()`, a read of the
 * server's process env, so for any given page load the context is present — or
 * absent — for the entire lifetime of the tree beneath it. There is no state,
 * prop or effect that can flip it mid-mount.
 */
export function useViewerHandle(): ViewerHandle {
  const injected = useContext(E2eViewerHandleContext);
  if (injected) return injected;
  // The branch is fixed for the lifetime of the tree (see the docblock above):
  // the E2E provider is mounted by the root layout from a server env read,
  // never from state, so the hook call order can never differ between two
  // renders of the same component. The directive stays on ONE line — a
  // `disable-next-line` whose reason wraps onto further comment lines applies
  // to the comment, not to the call, and eslint then reports it as unused.
  // eslint-disable-next-line react-hooks/rules-of-hooks -- fixed branch; see above
  return useClerkViewerHandle();
}
