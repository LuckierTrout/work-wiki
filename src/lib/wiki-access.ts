import { isFilesystemWikiId, isSidecarWikiId } from "./chat-contract";
import { getWikiRegistry } from "./wikis";

export type WikiAccess =
  | { ok: true }
  | { ok: false; status: 400 | 404; error: string };

/**
 * Retrieve/Search/Chat bind to `current` or an existing owner Wiki UUID.
 * Pages stay in the tenant silo; this rejects ceremonial or foreign ids.
 */
export async function requireAccessibleWikiId(
  owner: string,
  wikiId: string,
): Promise<WikiAccess> {
  if (isFilesystemWikiId(wikiId) || !isSidecarWikiId(wikiId)) {
    return { ok: false, status: 400, error: "invalid_wiki_id" };
  }
  if (wikiId === "current") {
    return { ok: true };
  }
  const registry = await getWikiRegistry(owner);
  if (!registry.wikis.some((wiki) => wiki.id === wikiId)) {
    return { ok: false, status: 404, error: "wiki_not_found" };
  }
  return { ok: true };
}
