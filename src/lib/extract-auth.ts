/**
 * Who may act on an extract record, and about whose Sources (Story 7.1).
 *
 * Its own module rather than a helper exported from a route file: a Next route
 * module's public surface is `GET`/`POST`, and importing a third export out of
 * one route into another makes the second route's bundle depend on the first
 * one's handlers.
 */

import { getPrincipal, getServicePrincipal } from "./auth";

export interface ExtractCaller {
  /**
   * Whose records this caller may act on, or `null` for "every owner".
   *
   * Only the service path can be unscoped, and it is the DEFAULT there on
   * purpose: the sidecar is one process on one laptop draining one vault, and
   * making it name an owner would mean a new env var whose only correct value
   * is whatever handle the browser happened to sign in as. A record still
   * carries its owner, so acting on one is still owner-scoped — see
   * {@link extractOwnerFor}.
   */
  owner: string | null;
  /** True for the bearer-token path, which may name an owner explicitly. */
  service: boolean;
}

/**
 * Resolve the caller, or `null` when nothing authorizes the request.
 *
 * TWO PATHS, and only one of them may name someone else:
 *
 *   - The SIDECAR has no Clerk session — it is a Node process on the owner's
 *     laptop — so it presents the owner-automation bearer token, which
 *     `getServicePrincipal` resolves. It may name an `owner`, and defaults to
 *     all of them. That is not an escalation: the token already authorizes
 *     writes as the service principal across the deployment.
 *   - A CLERK SESSION may act only on its own records, so a mismatched `owner`
 *     is refused rather than quietly narrowed to the caller — a request that
 *     asked about someone else's Sources should not get a plausible answer
 *     about its own.
 */
export async function resolveExtractCaller(
  request: Request,
  requestedOwner: string | null,
): Promise<ExtractCaller | null> {
  const service = getServicePrincipal(request);
  if (service) {
    const owner = requestedOwner?.trim();
    return { owner: owner || null, service: true };
  }
  const principal = await getPrincipal();
  if (!principal) return null;
  if (requestedOwner && requestedOwner.trim() !== principal.handle) return null;
  return { owner: principal.handle, service: false };
}

/**
 * The owner one specific record may be acted on as, or `null` to refuse.
 *
 * A scoped caller gets its own handle back and nothing else, so a Clerk
 * session naming someone else's `extractId` is refused before the record is
 * touched. An unscoped service caller inherits the RECORD's owner — the
 * doors below then operate exactly as that owner, which is what keeps
 * "extracted text is written as whoever stored the bytes" true even though
 * the poller never learned a handle.
 */
export function extractOwnerFor(
  caller: ExtractCaller,
  jobOwner: string,
): string | null {
  if (caller.owner === null) return caller.service ? jobOwner : null;
  return caller.owner === jobOwner ? caller.owner : null;
}
