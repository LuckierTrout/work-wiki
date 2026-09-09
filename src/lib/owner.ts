/**
 * Site owner identity.
 *
 * work-wiki is a single-owner deployment: the owner is the human who runs the
 * site (the deployer). Owner-only surfaces — e.g. the Lint health-check admin
 * tool — are gated on this module.
 *
 * TWO FACTS, ONE ANSWER (DW-486). The owner is identified by:
 *
 *  - `YOPEDIA_OWNER_USER_ID` — the STABLE Clerk user id. Server-only, and what
 *    the deployment gate in `src/middleware.ts` admits on. It cannot drift: a
 *    username change, or a user with no username and no linked X account (whose
 *    handle falls back to the raw Clerk id in `getPrincipal`), leaves it alone.
 *  - `NEXT_PUBLIC_OWNER_HANDLE` — the owner's canonical storage handle. Public, so
 *    the value is available to both server and client bundles; it's inlined at
 *    build time (see the deploy workflow), so changing it requires a redeploy.
 *
 * They used to be gated on independently — middleware on the id, every route and
 * page gate on the handle — so an owner whose handle drifted was admitted by the
 * deployment gate and then 403'd/404'd by the route gate, with no in-app
 * recovery (a build-time var needs a redeploy). {@link isOwnerPrincipal} makes
 * it one fact: the stable id decides whenever the principal carries a real Clerk
 * id, and the handle comparison survives only as the fallback — for bearer
 * service principals (whose ids are synthesized, not Clerk's) and for any
 * deployment with no `YOPEDIA_OWNER_USER_ID` configured.
 *
 * This module stays import-light: identity types are structural and no auth or
 * storage module is imported. Client controls receive the server's owner flag;
 * the stable owner user id is never exposed to the browser.
 */

import { isSynthesizedPrincipalId } from "./principal-id";

/** The configured owner handle, or null when unset (→ nobody is the owner). */
export function getOwnerHandle(): string | null {
  const h = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  return h && h.trim() ? h.trim() : null;
}

/**
 * The configured owner Clerk user id, or null when unset/blank.
 *
 * The ONE production reader of `YOPEDIA_OWNER_USER_ID` (mirroring the DW-157
 * rule for {@link getOwnerHandle}), pinned by
 * `src/lib/__tests__/owner-single-reader.test.ts`, so grepping for
 * `getOwnerUserId` finds every place the owner's stable id is resolved. It
 * reads exactly as the middleware's inline `?.trim()` did: blank and
 * whitespace-only are "not configured".
 *
 * Server-only in practice — the var is not `NEXT_PUBLIC_*`, so this answers
 * `null` in a client bundle.
 */
export function getOwnerUserId(): string | null {
  const id = process.env.YOPEDIA_OWNER_USER_ID;
  return id && id.trim() ? id.trim() : null;
}

/** Whether `handle` is the site owner. Case-insensitive; false when unset. */
export function isOwnerHandle(handle: string | null | undefined): boolean {
  const owner = getOwnerHandle();
  return !!owner && !!handle && handle.toLowerCase() === owner.toLowerCase();
}

/**
 * Whether this deployment names an owner AT ALL, by EITHER fact.
 *
 * Lives here rather than in `owner-route.ts` for the same reason
 * {@link getOwnerUserId} does: "is an owner configured?" is an `owner.ts`
 * question, and several route comments already restate it in prose. Callers that
 * grant an unconfigured deployment some permissiveness (today only
 * `requireOwnerPrincipal`) must key it on this, NOT on `getOwnerHandle()` alone —
 * a deployment that names the owner by id and nothing else is configured, and
 * must not fall through to "any signed-in user".
 */
export function isOwnerConfigured(): boolean {
  return getOwnerUserId() !== null || getOwnerHandle() !== null;
}

/**
 * Whether `principal` is the site owner — the ONE server-side owner predicate.
 *
 * The stable Clerk id decides when there is one to decide with; the handle is
 * the fallback. Fail-closed throughout: a null/undefined principal is never the
 * owner, and with NEITHER env var configured nobody is (not even the deployer).
 *
 * The synthesized-id branch is explicit rather than "any id": several callers
 * act with no Clerk session and mint their own `<kind>:<value>` id — the bearer
 * service credential (`service:`), the MCP agent tokens (`agent:`), an agent run
 * acting for its human (`agent-owner:`). None can ever equal the owner's Clerk
 * id, so gating them on the id would silently revoke the sidecar's token and
 * strip every agent of the owner grant it writes with. They keep the handle
 * comparison, which is the only fact they carry. See `./principal-id`.
 */
export function isOwnerPrincipal(
  principal: { id?: string | null; handle?: string | null } | null | undefined,
): boolean {
  if (!principal) return false;
  const ownerId = getOwnerUserId();
  if (ownerId && principal.id && !isSynthesizedPrincipalId(principal.id)) {
    return principal.id === ownerId;
  }
  return isOwnerHandle(principal.handle);
}

/** Storage namespace for a session, without changing its authenticated identity. */
export function ownerTenantHandle(
  principal: { id?: string | null; handle?: string | null } | null | undefined,
): string {
  const canonical = getOwnerHandle();
  return canonical && isOwnerPrincipal(principal)
    ? canonical
    : principal?.handle ?? "";
}
