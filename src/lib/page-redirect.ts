/**
 * Alias forwarding for a slug that has no page of its own.
 *
 * When a page is merged away (or renamed), its old slug is recorded as an
 * alias of the survivor. The owner-scoped route's miss path calls this so a
 * wikilink to the old slug 308s to the survivor's canonical
 * `/u/<tenant>/<slug>` instead of 404-ing. Because resolution goes through
 * `resolveAlias`, a missing slug that matches an existing page's slugified
 * TITLE (not just a recorded alias) forwards the same way. The retired public
 * commons URL `/wiki/<slug>` is never a forwarding target (AD-21 stands).
 */

import { resolveAlias } from "./alias-index";
import { canReadFrontmatter } from "./authz";
import { pagePath } from "./links";
import { logger } from "./logger";
import { readWikiPageWithFrontmatter, tenantForOwner } from "./wiki";
import type { Principal } from "./auth";

/**
 * Where `/u/<handle>/<slug>` should 308 when no page readable by `principal`
 * exists at `slug` — or `null`, in which case the route renders its 404 UI.
 *
 * Principal-aware and fail-closed so forwarding never becomes a private-page
 * existence oracle. It forwards only when ALL of these hold:
 *   - the alias index resolves `slug` to a DIFFERENT canonical slug — the
 *     index maps every live slug to itself, so an existing-but-unreadable
 *     page would otherwise 308 to its own URL forever;
 *   - the survivor page actually exists; and
 *   - `principal` may read it ({@link canReadFrontmatter}) — an anonymous
 *     viewer of a private survivor gets `null` (indistinguishable from a
 *     missing page) while its owner is forwarded.
 *
 * The target is always the survivor's canonical owner-scoped URL (one hop),
 * never the `DEFAULT_TENANT` form.
 */
export async function aliasRedirectForMissing(
  slug: string,
  principal: Principal | null,
): Promise<string | null> {
  // Fail closed on ANY error: building the alias index parses every page's
  // frontmatter, and one corrupt file would otherwise turn every missing-page
  // request into a 500. A broken index must degrade to the 404 UI, not break
  // the route.
  try {
    const canonical = await resolveAlias(slug);
    if (!canonical || canonical === slug) return null;

    const survivor = await readWikiPageWithFrontmatter(canonical);
    if (!survivor) return null;
    if (!canReadFrontmatter(survivor.frontmatter, principal)) return null;

    const owner = survivor.frontmatter.owner;
    return pagePath(
      tenantForOwner(typeof owner === "string" ? owner : undefined),
      canonical,
    );
  } catch (err) {
    // Degrading silently would hide that ALL alias forwarding is down (e.g.
    // one corrupt page file breaking index builds) — keep the 404 fallback
    // but leave an operator-visible trace.
    logger.warn("page-redirect", "alias forwarding failed for slug:", slug, err);
    return null;
  }
}
