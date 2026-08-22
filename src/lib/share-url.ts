import { pagePath } from "./links";
import { tenantForOwner } from "./wiki";

/** Narrow an unknown frontmatter value to a string (or undefined). */
export function str(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/**
 * The canonical wiki URL for a page, from its frontmatter: always the
 * owner-scoped `/u/<tenant>/<slug>`. The global `/wiki/<slug>` commons URL is
 * retired (it 404s), so there is no public-vs-owner branch left to take — every
 * page resolves to its owner's silo.
 */
export function wikiUrlFor(
  slug: string,
  fm: { owner?: unknown; visibility?: unknown; type?: unknown },
): string {
  return pagePath(tenantForOwner(str(fm.owner)), slug);
}
