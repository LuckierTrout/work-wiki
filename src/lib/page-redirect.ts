/**
 * Forwarding for a slug that has no page of its own.
 *
 * This existed so a **merged-away** or renamed slug kept working on the public
 * commons URL `/wiki/<slug>` instead of 404-ing. That URL is retired (it 404s
 * unconditionally), so there is no longer a commons target to forward to.
 */

/**
 * Where `/wiki/<slug>` should 308 when no page exists at `slug`. Always `null`
 * now: the commons surface is retired, so nothing may forward to it (AD-21).
 * Kept as a named seam rather than deleted so the retirement is explicit and a
 * later epic can reintroduce alias forwarding against the owner-scoped URL.
 */
export async function commonsRedirectForMissing(
  _slug: string,
): Promise<string | null> {
  return null;
}
