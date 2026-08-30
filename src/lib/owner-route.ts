import { getPrincipal, getServicePrincipal, type Principal } from "./auth";
import { getOwnerHandle, isOwnerConfigured, isOwnerPrincipal } from "./owner";

/**
 * Signed-in owner for kernel wiki / chat / search APIs.
 * When NO owner is configured (tests), any signed-in principal passes —
 * "unconfigured" now means NEITHER `YOPEDIA_OWNER_USER_ID` NOR
 * `NEXT_PUBLIC_OWNER_HANDLE` is set, so a deployment that names the owner by id
 * alone still gates, instead of falling through to "any signed-in user".
 */
export async function requireOwnerPrincipal(): Promise<Principal | null> {
  const principal = await getPrincipal();
  if (!principal) return null;
  if (isOwnerConfigured() && !isOwnerPrincipal(principal)) return null;
  return principal;
}

/**
 * The owner, by SESSION or by OWNER-AUTOMATION TOKEN (Story 8.2).
 *
 * WHY THIS EXISTS: the sidecar is a process on the owner's laptop with no
 * browser and no cookie jar. It reaches the kernel with the owner-automation
 * bearer token — the same credential `extract-loop.mjs` has presented since Epic
 * 7 — so every route the loopback door proxies, and every kernel read the Chat
 * Agent's tools make, has to accept that token or the whole door answers 401.
 *
 * THE OWNER GATE STILL APPLIES, to both branches. `getServicePrincipal` derives
 * its handle from `YOPEDIA_SERVICE_PRINCIPAL`, and a deployment that pointed that
 * at somebody who is not the owner would otherwise get a token that reads the
 * owner's private wiki. The check is the same one the session branch gets.
 *
 * SESSION FIRST, so a signed-in owner in the browser is attributed as themselves
 * rather than as `service:…` — attribution lands in page frontmatter, and a
 * Review created from the Workbench should not be authored by a robot.
 */
export async function requireOwnerOrServicePrincipal(
  request: Request,
): Promise<Principal | null> {
  const session = await requireOwnerPrincipal();
  if (session) return session;
  const service = getServicePrincipal(request);
  if (!service) return null;
  // KEYED ON THE HANDLE ALONE, unlike the session branch above — deliberately.
  // A service principal's id is synthesized, so it carries no Clerk id to
  // compare and `isOwnerPrincipal` decides it on the handle. Gating this branch
  // on `isOwnerConfigured()` would refuse the token outright on a deployment
  // that sets `YOPEDIA_OWNER_USER_ID` and NOT `NEXT_PUBLIC_OWNER_HANDLE`:
  // "configured" would be true while the only fact this principal has to offer
  // is unset, so the sidecar and every automation would lose every route this
  // gate protects. The condition below is exactly the one this branch has always
  // had — refuse only when a handle IS configured and the service handle differs.
  const ownerHandle = getOwnerHandle();
  if (ownerHandle && !isOwnerPrincipal(service)) return null;
  return service;
}
