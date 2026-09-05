/**
 * Alias forwarding for a slug that has no page of its own.
 *
 * When a page is merged away (or renamed), its old slug is recorded as an
 * alias of the survivor. THREE routes share this gate on their miss path —
 * the page view (`/u/<handle>/<slug>`), the editor (`.../<slug>/edit`) and the
 * raw browser (`/u/<handle>/raw/<slug>`) — so an old bookmark for any of the
 * three 308s to the survivor's EQUIVALENT URL instead of 404-ing. Because
 * resolution goes through `resolveAlias`, a missing slug that matches an
 * existing page's slugified TITLE (not just a recorded alias) forwards the
 * same way. The retired public commons URL `/wiki/<slug>` is never a
 * forwarding target (AD-21 stands).
 *
 * The gate itself ({@link aliasTargetForMissing}) returns the survivor's
 * `{tenant, canonical}` PARTS rather than a URL, because each route has to
 * rebuild its own surface's shape: forwarding a viewer from `/edit` to the
 * read view would be a cross-surface redirect, and rewriting one route's URL
 * into another's would put URL-shape knowledge in three places.
 *
 * The MACHINE doors (`GET /api/raw/<slug>` and the write verbs on
 * `/api/wiki/<slug>`) share the same gate through a THIRD projection,
 * {@link canonicalSlugHintForMissing} — and do NOT redirect: they keep their
 * 404 and name the survivor in the body instead (DW-233).
 */

import { resolveAlias } from "./alias-index";
import { canReadFrontmatter } from "./authz";
import { pagePath } from "./links";
import { logger } from "./logger";
import { readWikiPageWithFrontmatter, tenantForOwner } from "./wiki";
import type { Principal } from "./auth";

/**
 * The survivor a missing `slug` should forward to, as the parts each route
 * needs to build ITS OWN URL — or `null`, in which case the route keeps its
 * existing miss behavior (404, or the editor's "nothing to edit" copy).
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
 * `tenant` is always the survivor's canonical tenant, so every caller lands on
 * the real owner in ONE hop, never via the `DEFAULT_TENANT` form.
 */
export async function aliasTargetForMissing(
  slug: string,
  principal: Principal | null,
): Promise<{ tenant: string; canonical: string } | null> {
  // Fail closed on ANY error: building the alias index parses every page's
  // frontmatter, and one corrupt file would otherwise turn every missing-page
  // request into a 500. A broken index must degrade to each route's own miss
  // behavior, not break the route.
  try {
    const canonical = await resolveAlias(slug);
    if (!canonical || canonical === slug) return null;

    const survivor = await readWikiPageWithFrontmatter(canonical);
    if (!survivor) return null;
    if (!canReadFrontmatter(survivor.frontmatter, principal)) return null;

    const owner = survivor.frontmatter.owner;
    return {
      tenant: tenantForOwner(typeof owner === "string" ? owner : undefined),
      canonical,
    };
  } catch (err) {
    // Degrading silently would hide that ALL alias forwarding is down (e.g.
    // one corrupt page file breaking index builds) — keep the miss fallback
    // but leave an operator-visible trace.
    logger.warn("page-redirect", "alias forwarding failed for slug:", slug, err);
    return null;
  }
}

/**
 * Where `/u/<handle>/<slug>` (the PAGE view) should 308 when no page readable
 * by `principal` exists at `slug` — or `null`, in which case the route 404s.
 *
 * The page-shaped projection of {@link aliasTargetForMissing}; the edit and raw
 * routes project the same target through `editPath` / `rawPath` instead.
 */
export async function aliasRedirectForMissing(
  slug: string,
  principal: Principal | null,
): Promise<string | null> {
  const target = await aliasTargetForMissing(slug, principal);
  return target ? pagePath(target.tenant, target.canonical) : null;
}

/**
 * The `canonicalSlug` hint a MACHINE door puts on a miss-404 body — or `{}`,
 * which spreads to nothing, so the envelope is byte-identical to today's
 * wherever the gate declines.
 *
 * The envelope-shaped projection of {@link aliasTargetForMissing}, beside the
 * page-shaped {@link aliasRedirectForMissing}: `/api/raw/<slug>` and the write
 * verbs on `/api/wiki/<slug>` keep their 404 STATUS (the recorded 2026-08-28
 * decision — an API caller is not a browser and must not be silently
 * redirected), and instead name the survivor in the body so an HTTP client
 * holding a merged-away slug can follow it in one hop. That is any caller of
 * these two ROUTES — a script, a fetch from another service, the app's own
 * clients — and NOT the MCP tools, which dispatch through `src/mcp.ts` and
 * never touch these handlers. Three projections of ONE gate, so no route
 * re-derives the fail-closed predicate.
 *
 * SLUG ONLY, never the tenant or the owner's handle: both machine doors are
 * slug-keyed, so the tenant would be information the caller cannot use and the
 * gate deliberately does not have to leak.
 *
 * NOT AN EXISTENCE ORACLE, for the same three reasons the gate itself is not:
 * it is principal-aware, fail-closed, and requires `canonical !== slug`. The
 * ACL-cloak 404s — a page that exists but this caller may not read — resolve to
 * THEMSELVES in the alias index and so carry no hint at all.
 */
export async function canonicalSlugHintForMissing(
  slug: string,
  principal: Principal | null,
): Promise<{ canonicalSlug?: string }> {
  const target = await aliasTargetForMissing(slug, principal);
  return target ? { canonicalSlug: target.canonical } : {};
}
