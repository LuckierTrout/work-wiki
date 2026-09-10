import type { Principal } from "./auth";
import { isOwnerPrincipal } from "./owner";
import { listReadableWikiPages } from "./wiki";
import { buildKnowledgeTree, workbenchSlugGate } from "./workbench-tree";
import { rawPathAllowed } from "./workbench-files";

/**
 * Additional visibility gate for the human raw-source page and Download API.
 * Callers MUST first pass canReadSlug's strict frontmatter/private-page gate.
 * The deployment owner may access agent-scoped sources (DW-771); everyone
 * else keeps the existing raw API's Workbench visibility boundary.
 *
 * A flat display path identifies the same slug as a per-source snapshot, so
 * both raw shapes share this decision without interpolating a source id.
 * Storage readers still own slug/source-id validation and immutable bytes.
 * Derivation errors propagate: the API returns sanitized 500, the page 404.
 */
export async function rawSourceAccessAllowed(
  slug: string,
  principal: Principal | null,
): Promise<boolean> {
  if (isOwnerPrincipal(principal)) return true;
  const entries = await listReadableWikiPages(principal);
  const { hiddenSlugs } = workbenchSlugGate(entries, buildKnowledgeTree(entries));
  return rawPathAllowed(`raw/sources/${slug}.md`, hiddenSlugs);
}
