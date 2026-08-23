/**
 * Cascade delete for one stored Source (Stories 2.4–2.12).
 *
 * Finders are only: YAML `sources[]` url/raw_id, a Source-summary page
 * (type + identity), and a YAML field equal to the Source path. Body prose
 * is never a finder. Keys are exact identity only — not leaf names or titles.
 * Pages are owner-scoped. Page deletes go through {@link deleteWikiPage};
 * Source bytes through {@link deleteRawSourceBytes}. Todos are marked
 * source-missing, never deleted.
 */

import { markActionItemsSourceMissing } from "./action-items";
import { markTodosSourceMissing } from "./todos";
import { serializeFrontmatter } from "./frontmatter";
import { cancelJobsForSource } from "./ingest-jobs";
import { deleteWikiPage, writeWikiPageWithSideEffects } from "./lifecycle";
import { logger } from "./logger";
import { deleteRawSourceBytes } from "./raw";
import { sourceIdentityKeys, sourceRestFromPath } from "./source-delete";
import { getStorage } from "./storage";
import { parseSources, serializeSources } from "./sources";
import { listWikiPages, readWikiPageWithFrontmatter } from "./wiki";

export { sourceRestFromPath } from "./source-delete";

const BOOKKEEPING = new Set(["index", "log", "overview"]);
const CASCADE_MARKER_PREFIX = "source-cascade";

function ownerOwnsPage(
  owner: string,
  frontmatter: Record<string, unknown>,
): boolean {
  const pageOwner = frontmatter.owner;
  if (typeof pageOwner !== "string" || !pageOwner.trim()) return false;
  const human = (handle: string) => {
    const i = handle.indexOf("--");
    return (i >= 0 ? handle.slice(0, i) : handle).trim().toLowerCase();
  };
  return human(owner) === human(pageOwner);
}

export function sourceCascadeKeys(path: string, _sourceTitle?: string): string[] {
  return sourceIdentityKeys(path);
}

function yamlFieldCites(
  frontmatter: Record<string, unknown>,
  keySet: Set<string>,
): string[] {
  const matched: string[] = [];
  for (const field of ["source_url", "path", "source_path"] as const) {
    const value = frontmatter[field];
    if (typeof value === "string" && keySet.has(value)) matched.push(field);
  }
  return matched;
}

function pageCitesSource(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const keySet = new Set(keys);
  const sources = parseSources(
    typeof frontmatter.sources === "string" || Array.isArray(frontmatter.sources)
      ? (frontmatter.sources as string | string[])
      : undefined,
  );
  for (const entry of sources) {
    if (keySet.has(entry.url) || (entry.raw_id && keySet.has(entry.raw_id))) {
      return true;
    }
  }
  return yamlFieldCites(frontmatter, keySet).length > 0;
}

function isSourceSummary(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return frontmatter.type === "summary" && pageCitesSource(frontmatter, keys);
}

function soleSource(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  const sources = parseSources(
    typeof frontmatter.sources === "string" || Array.isArray(frontmatter.sources)
      ? (frontmatter.sources as string | string[])
      : undefined,
  );
  const keySet = new Set(keys);
  const yamlHit = yamlFieldCites(frontmatter, keySet).length > 0;
  if (sources.length === 0) return yamlHit;
  return sources.every(
    (entry) =>
      keySet.has(entry.url) || (entry.raw_id ? keySet.has(entry.raw_id) : false),
  );
}

function linkedRawRests(
  frontmatter: Record<string, unknown>,
  keys: readonly string[],
): string[] {
  const keySet = new Set(keys);
  const rests = new Set<string>();
  const sources = parseSources(
    typeof frontmatter.sources === "string" || Array.isArray(frontmatter.sources)
      ? (frontmatter.sources as string | string[])
      : undefined,
  );
  for (const entry of sources) {
    if (!keySet.has(entry.url) && !(entry.raw_id && keySet.has(entry.raw_id))) {
      continue;
    }
    const fromUrl = sourceRestFromPath(entry.url);
    if (fromUrl) rests.add(fromUrl);
    if (entry.raw_id) {
      const fromId = sourceRestFromPath(entry.raw_id) ?? entry.raw_id;
      if (fromId && !fromId.includes("..")) rests.add(fromId);
    }
  }
  return [...rests];
}

function markerPath(owner: string, rest: string): string {
  const safe = rest.replace(/[^a-zA-Z0-9._/-]/g, "_");
  return `${CASCADE_MARKER_PREFIX}/${owner}/${safe}.json`;
}

interface CascadeMarker {
  summaries: string[];
  others: string[];
  rawRests: string[];
  deletedPages: string[];
  updatedPages: string[];
}

async function readMarker(
  owner: string,
  rest: string,
): Promise<CascadeMarker | null> {
  try {
    const raw = await getStorage().readFile(markerPath(owner, rest));
    return JSON.parse(raw) as CascadeMarker;
  } catch {
    return null;
  }
}

async function writeMarker(
  owner: string,
  rest: string,
  marker: CascadeMarker,
): Promise<void> {
  await getStorage().writeFile(markerPath(owner, rest), JSON.stringify(marker));
}

async function clearMarker(owner: string, rest: string): Promise<void> {
  try {
    await getStorage().deleteFile(markerPath(owner, rest));
  } catch {
    // already gone
  }
}

export async function cascadeDeleteSource(input: {
  owner: string;
  path: string;
  sourceTitle?: string;
}): Promise<{ deletedPages: string[]; updatedPages: string[] }> {
  const rest = sourceRestFromPath(input.path);
  if (!rest) throw new Error("That source path is not allowed.");
  const keys = sourceCascadeKeys(input.path);
  const keySet = new Set(keys);

  await cancelJobsForSource(input.owner, keys);

  const resumed = await readMarker(input.owner, rest);
  let summaries: string[] = [];
  let others: string[] = [];
  const rawRests = new Set<string>(resumed?.rawRests ?? [rest]);
  const deletedPages: string[] = [...(resumed?.deletedPages ?? [])];
  const updatedPages: string[] = [...(resumed?.updatedPages ?? [])];

  if (resumed) {
    summaries = resumed.summaries;
    others = resumed.others;
  } else {
    const pages = await listWikiPages();
    for (const entry of pages) {
      if (BOOKKEEPING.has(entry.slug)) continue;
      const page = await readWikiPageWithFrontmatter(entry.slug);
      if (!page) continue;
      if (!ownerOwnsPage(input.owner, page.frontmatter)) continue;
      const summary = isSourceSummary(page.frontmatter, keys);
      const cites = pageCitesSource(page.frontmatter, keys);
      if (summary) summaries.push(entry.slug);
      else if (cites) others.push(entry.slug);
      if (summary || cites) {
        for (const linked of linkedRawRests(page.frontmatter, keys)) {
          rawRests.add(linked);
        }
      }
    }
    await writeMarker(input.owner, rest, {
      summaries,
      others,
      rawRests: [...rawRests],
      deletedPages,
      updatedPages,
    });
  }

  for (const slug of [...summaries]) {
    await deleteWikiPage(slug, input.owner);
    deletedPages.push(slug);
    summaries = summaries.filter((item) => item !== slug);
    await writeMarker(input.owner, rest, {
      summaries,
      others,
      rawRests: [...rawRests],
      deletedPages,
      updatedPages,
    });
  }

  for (const slug of [...others]) {
    const page = await readWikiPageWithFrontmatter(slug);
    if (!page) {
      others = others.filter((item) => item !== slug);
      continue;
    }
    if (soleSource(page.frontmatter, keys)) {
      await deleteWikiPage(slug, input.owner);
      deletedPages.push(slug);
    } else {
      const sources = parseSources(
        typeof page.frontmatter.sources === "string" ||
          Array.isArray(page.frontmatter.sources)
          ? (page.frontmatter.sources as string | string[])
          : undefined,
      );
      const kept = sources.filter(
        (entry) =>
          !keySet.has(entry.url) && !(entry.raw_id && keySet.has(entry.raw_id)),
      );
      const frontmatter = { ...page.frontmatter };
      frontmatter.sources = serializeSources(kept);
      frontmatter.source_count = String(kept.length);
      for (const field of yamlFieldCites(frontmatter, keySet)) {
        delete frontmatter[field];
      }
      const content = serializeFrontmatter(frontmatter, page.body);
      await writeWikiPageWithSideEffects({
        slug,
        title: page.title,
        content,
        summary: page.body.replace(/^#\s+.+$/m, "").trim().slice(0, 200),
        logOp: "edit",
        crossRefSource: null,
        author: input.owner,
        logDetails: () => `dropped source ${input.path} from "${slug}"`,
      });
      updatedPages.push(slug);
    }
    others = others.filter((item) => item !== slug);
    await writeMarker(input.owner, rest, {
      summaries,
      others,
      rawRests: [...rawRests],
      deletedPages,
      updatedPages,
    });
  }

  for (const linked of rawRests) {
    await deleteRawSourceBytes(linked, input.owner);
  }

  try {
    for (const key of keys) {
      await markActionItemsSourceMissing(input.owner, key);
    }
    await markTodosSourceMissing(input.owner, input.path);
  } catch (error) {
    logger.warn("source-cascade", "todo source-missing mark failed", error);
  }

  await clearMarker(input.owner, rest);
  return { deletedPages, updatedPages };
}
