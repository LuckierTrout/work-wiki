/**
 * The three things every cloud `/api/v1` route does before it does anything
 * (Story 8.2).
 *
 * SERVER-ONLY, unlike `v1-contract.ts`: this one reaches auth, the Wiki registry
 * and the page read gate. The split matters — `SettingsCanvas` imports the
 * contract in the browser, and folding these helpers into it would pull Clerk
 * and storage into the client bundle.
 *
 * WHY A HELPER AND NOT NINE COPIES: "owner principal, then `{id}` resolution,
 * then the read gate" is one sequence, and nine hand-written copies of it is
 * eight chances for one route to resolve `{id}` without checking the registry.
 * The one asymmetry the façade has — a filesystem path is loopback-only and this
 * side must always refuse it — lives inside `requireAccessibleWikiId`, so it is
 * enforced here for every route at once.
 */

import type { Principal } from "./auth";
import { requireOwnerOrServicePrincipal } from "./owner-route";
import { listReadableWikiPages } from "./wiki";
import {
  buildKnowledgeTree,
  readableSlugsFromKnowledge,
} from "./workbench-tree";
import { requireAccessibleWikiId } from "./wiki-access";
import { getWikiRegistry } from "./wikis";

export type V1Caller =
  | {
      ok: true;
      principal: Principal;
      /**
       * The Wiki the request is about, already resolved.
       *
       * `current` becomes the registry's `currentId`, which may be `null` on a
       * workspace that has never created a Wiki. `null` is not an error — the
       * flat pre-Wiki tree is still readable — so routes take it as "no Wiki
       * artifact dir", exactly as `listWorkbenchFilePaths` does.
       */
      wikiId: string | null;
      /** What `{id}` was, verbatim, for echoing back. */
      requested: string;
    }
  | { ok: false; status: number; error: string };

/**
 * Owner + `{id}`, resolved once.
 *
 * 401 for no principal and NOT 404: this façade is reached with a Clerk session
 * or an owner-automation token, and a caller holding neither needs to be told to
 * authenticate rather than that the wiki does not exist.
 *
 * THE REQUEST IS REQUIRED because the automation branch reads its bearer header.
 * The sidecar has no session, so a façade that only accepted cookies would 401
 * every single proxied loopback call — the door would be closed by construction.
 */
export async function resolveV1Caller(
  wikiId: string,
  request: Request,
): Promise<V1Caller> {
  const principal = await requireOwnerOrServicePrincipal(request);
  if (!principal) return { ok: false, status: 401, error: "Sign in required." };
  const access = await requireAccessibleWikiId(principal.handle, wikiId);
  if (!access.ok) {
    return { ok: false, status: access.status, error: access.error };
  }
  if (wikiId !== "current") {
    return { ok: true, principal, wikiId, requested: wikiId };
  }
  const registry = await getWikiRegistry(principal.handle);
  return {
    ok: true,
    principal,
    wikiId: registry.currentId,
    requested: wikiId,
  };
}

/**
 * The set of page slugs this principal may read.
 *
 * THE SAME GATE the Workbench's own file listing uses, derived the same way —
 * `listReadableWikiPages` → knowledge tree → slugs. A second expression of "what
 * may this caller see" is how the external door ends up more permissive than the
 * in-product tree, and the door is the one an agent talks to.
 */
export async function v1ReadableSlugs(
  principal: Principal,
): Promise<ReadonlySet<string>> {
  const entries = await listReadableWikiPages(principal);
  return readableSlugsFromKnowledge(buildKnowledgeTree(entries));
}
