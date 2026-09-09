import { ownerTenantHandle } from "./owner";
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

import { NextResponse } from "next/server";
import type { Principal } from "./auth";
import { requireOwnerOrServicePrincipal } from "./owner-route";
import { V1_BODY_TOO_LARGE_ERROR, V1_MAX_BODY_BYTES } from "./v1-contract";
import { listReadableWikiPages } from "./wiki";
import {
  buildKnowledgeTree,
  workbenchSlugGate,
  type WorkbenchSlugGate,
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
  const access = await requireAccessibleWikiId(ownerTenantHandle(principal), wikiId);
  if (!access.ok) {
    return { ok: false, status: access.status, error: access.error };
  }
  if (wikiId !== "current") {
    return { ok: true, principal, wikiId, requested: wikiId };
  }
  const registry = await getWikiRegistry(ownerTenantHandle(principal));
  return {
    ok: true,
    principal,
    wikiId: registry.currentId,
    requested: wikiId,
  };
}

/**
 * The slug gate this principal's file doors run on — both halves of it.
 *
 * THE SAME GATE the Workbench's own file listing uses, derived the same way —
 * `listReadableWikiPages` → knowledge tree → `workbenchSlugGate`. A second
 * expression of "what may this caller see" is how the external door ends up
 * more permissive than the in-product tree, and the door is the one an agent
 * talks to. It returns the PAIR rather than just `readableSlugs` for exactly
 * that reason: the three `/api/v1` doors keep sharing one expression, and a
 * route cannot pick up the `wiki/` half while leaving the `raw/` half behind
 * (DW-32).
 */
export async function v1SlugGate(
  principal: Principal,
): Promise<WorkbenchSlugGate> {
  const entries = await listReadableWikiPages(principal);
  return workbenchSlugGate(entries, buildKnowledgeTree(entries));
}

/**
 * Shared 1 MiB body gate for cloud `/api/v1` POST/PATCH routes (AD-6).
 * Refused, not truncated — a partial JSON parse would be a different request.
 */
export async function readV1JsonBody(
  request: Request,
): Promise<
  { ok: true; body: unknown } | { ok: false; response: NextResponse }
> {
  const raw = await request.arrayBuffer();
  if (raw.byteLength > V1_MAX_BODY_BYTES) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: V1_BODY_TOO_LARGE_ERROR },
        { status: 400 },
      ),
    };
  }
  if (raw.byteLength === 0) return { ok: true, body: {} };
  try {
    return { ok: true, body: JSON.parse(new TextDecoder().decode(raw)) };
  } catch {
    return { ok: true, body: {} };
  }
}
