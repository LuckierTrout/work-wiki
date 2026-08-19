/**
 * Shared utilities for wiki link parsing and regex escaping.
 *
 * Centralises patterns that were previously duplicated across wiki.ts,
 * lifecycle.ts, and lint.ts.
 */

/**
 * Escape special regex characters in a string so it can be used
 * in a `new RegExp(...)` constructor safely.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A parsed wiki-style markdown link: `[text](slug.md)`
 */
export interface WikiLink {
  text: string;
  targetSlug: string;
}

/**
 * Extract all wiki-style markdown links from content.
 * Returns an array of { text, targetSlug } for each `[text](slug.md)` link found.
 */
export function extractWikiLinks(content: string): WikiLink[] {
  const results: WikiLink[] = [];
  const re = /\[([^\]]*)\]\(([^)]+)\.md\)/g;
  let match;
  while ((match = re.exec(content)) !== null) {
    results.push({ text: match[1], targetSlug: match[2] });
  }
  return results;
}

/**
 * Test whether `content` contains a markdown link to `targetSlug.md`.
 */
export function hasLinkTo(content: string, targetSlug: string): boolean {
  const pattern = new RegExp(`\\]\\(${escapeRegex(targetSlug)}\\.md\\)`);
  return pattern.test(content);
}

// ---------------------------------------------------------------------------
// Canonical owner-qualified URL builders (tenant-silos P2)
//
// Pages are addressed by `(tenant, slug)` and live at `/u/<tenant>/<slug>`,
// where `tenant` is the lowercased owner handle. This is the ONLY page URL
// shape — the public commons form `/wiki/<slug>` is retired and 404s.
//
// These are PURE string functions (no server imports) so client components can
// use them too: the server resolves `owner → tenant` and passes resolved tenant
// strings (and the slug→tenant map below) down as plain data.
// ---------------------------------------------------------------------------

/**
 * Catch-all tenant for ownerless / seed content. work-wiki is built in public by
 * yoyo, so unattributed/seed pages are the platform's own — they belong to the
 * `work-wiki` tenant. Defined here (a pure module) so both client and server
 * resolve owner→tenant identically; `wiki.ts` re-exports it.
 */
export const DEFAULT_TENANT = "yopedia";

/**
 * The canonical tenant for an owner handle: lowercased (owner checks are
 * case-insensitive, so one owner never splits across "Alice"/"alice" silos),
 * falling back to {@link DEFAULT_TENANT} for ownerless/seed content. The SINGLE
 * place tenant-from-owner is derived — used for the `/u/<tenant>/` URL, the
 * commons key, AND the physical silo folder, so all three stay identical.
 *
 * Normalizes the path-unsafe characters a tenant key/URL/folder can't contain
 * (whitespace, control chars, `/`, `\`, `.`) to `-`, so a free-form owner (e.g.
 * an API/MCP-supplied `"Jean Luc"`) still yields a valid, routable tenant rather
 * than a broken URL or a silo write that throws. Unicode (e.g. CJK handles) is
 * preserved — only the unsafe set is touched. Normal handles (Clerk usernames,
 * `alice--yoyo`) pass through unchanged apart from lowercasing.
 */
export function ownerToTenant(owner?: string | null): string {
  if (typeof owner !== "string") return DEFAULT_TENANT;
  const t = owner
    .trim()
    .toLowerCase()
    .replace(/[\s\u0000-\u001f/\\.]+/g, "-")
    .replace(/^-+|-+$/g, ""); // trim leading/trailing dashes
  return t.length > 0 ? t : DEFAULT_TENANT;
}

/**
 * Canonical owner-scoped page URL `/u/<tenant>/<slug>` (private/owned pages).
 *
 * The tenant segment is never allowed to be empty: `/u//<slug>` matches no
 * route, so a caller that lost its tenant would emit a dead link instead of one
 * the owner route can 308 onto the right handle. Empty falls back to
 * {@link DEFAULT_TENANT}.
 */
export function pagePath(tenant: string, slug: string): string {
  return `/u/${tenantSegment(tenant)}/${slug}`;
}

/**
 * The `/u/<tenant>` segment: the trimmed tenant, or {@link DEFAULT_TENANT} when
 * the caller lost it. Emitting the *untrimmed* value would put whitespace in the
 * path, so the same trim that decides the fallback also produces the segment.
 */
function tenantSegment(tenant: string): string {
  return tenant?.trim() || DEFAULT_TENANT;
}

/**
 * The page URL to use when the call site knows only the slug. The commons URL
 * `/wiki/<slug>` is retired (it 404s), and every page now lives at the
 * owner-scoped `/u/<tenant>/<slug>`; addressing it through {@link DEFAULT_TENANT}
 * is safe because the owner route 308-redirects a mismatched handle to the
 * page's real tenant. Prefer {@link pagePath} whenever the owner IS known.
 */
export function slugPath(slug: string): string {
  return pagePath(DEFAULT_TENANT, slug);
}

/**
 * Canonical edit URL `/u/<tenant>/<slug>/edit`. Empty tenant falls back to
 * {@link DEFAULT_TENANT} for the same reason {@link pagePath} does: `/u//<slug>`
 * matches no route, so a caller that lost its tenant would emit a dead link.
 */
export function editPath(tenant: string, slug: string): string {
  return `${pagePath(tenant, slug)}/edit`;
}

/**
 * Canonical raw-source URL `/u/<tenant>/raw/<slug>`. Empty tenant falls back to
 * {@link DEFAULT_TENANT} — see {@link editPath}.
 */
export function rawPath(tenant: string, slug: string): string {
  return `/u/${tenantSegment(tenant)}/raw/${slug}`;
}

/**
 * A precomputed slug→tenant map for resolving links where only the target slug
 * is known (in-content wikilinks, backlinks). Pre-P5 slugs are globally unique,
 * so one slug maps to exactly one tenant.
 */
export type SlugTenantMap = Record<string, string>;

/**
 * Resolve a target slug to its canonical page path — always the owner-scoped
 * `/u/<tenant>/<slug>`, via the {@link SlugTenantMap} (and `fallbackTenant` for
 * dangling/missing targets). The global `/wiki/<slug>` commons form is retired,
 * so there is no longer a public branch to take.
 *
 * The lookup is OWN-PROPERTY-ONLY and string-typed. The map is parsed response
 * JSON (`/api/wiki/routes`) or a server-built plain object, so its real entries
 * are always own string properties — while a page legitimately titled
 * "Constructor" slugifies to `constructor`, which a plain `map[slug]` would
 * answer with `Object.prototype.constructor`, a FUNCTION. That value is not a
 * tenant, and {@link tenantSegment}'s `.trim()` would throw a TypeError in the
 * middle of a render. Anything that isn't an own string entry falls back to
 * `fallbackTenant` — fall back, never throw.
 */
export function resolveSlugPath(
  slug: string,
  slugTenants: SlugTenantMap | undefined,
  fallbackTenant: string,
): string {
  const own =
    slugTenants && Object.prototype.hasOwnProperty.call(slugTenants, slug)
      ? (slugTenants as Record<string, unknown>)[slug]
      : undefined;
  return pagePath(typeof own === "string" ? own : fallbackTenant, slug);
}
