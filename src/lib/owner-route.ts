import { getPrincipal, getServicePrincipal, type Principal } from "./auth";
import { getOwnerHandle, isOwnerHandle } from "./owner";

/**
 * Signed-in owner for kernel wiki / chat / search APIs.
 * When no owner handle is configured (tests), any signed-in principal passes.
 */
export async function requireOwnerPrincipal(): Promise<Principal | null> {
  const principal = await getPrincipal();
  if (!principal) return null;
  const owner = getOwnerHandle();
  if (owner && !isOwnerHandle(principal.handle)) return null;
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
  const owner = getOwnerHandle();
  if (owner && !isOwnerHandle(service.handle)) return null;
  return service;
}
