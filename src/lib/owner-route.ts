import { getPrincipal, type Principal } from "./auth";
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
