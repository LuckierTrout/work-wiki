/**
 * Cascade delete for one stored Source (Stories 2.4–2.12).
 *
 * Finders are only: YAML `sources[]`, a Source-summary page (type + name), and
 * a YAML field equal to the Source path or slug. Body prose is never a finder.
 * Page deletes go through {@link deleteWikiPage}; Source bytes through
 * {@link deleteRawSourceBytes}. Todos are marked source-missing, never deleted.
 */

import { markActionItemsSourceMissing } from "./action-items";
import { serializeFrontmatter } from "./frontmatter";
import { deleteWikiPage, writeWikiPageWithSideEffects } from "./lifecycle";
import { logger } from "./logger";
import { deleteRawSourceBytes } from "./raw";
import { parseSources, serializeSources } from "./sources";
import { listWikiPages, readWikiPageWithFrontmatter } from "./wiki";

export const SOURCE_DELETE_TITLE = "Delete this source?";
export const SOURCE_DELETE_BODY =
  "This removes the Source and pages that only cite it. Shared pages keep their other sources.";
export const SOURCE_DELETE_CONFIRM = "Delete source";
export const SOURCE_DELETE_CANCEL = "Cancel";
export const SOURCE_ROUTE = "/api/workbench/source";

const BOOKKEEPING = new Set(["index", "log", "overview"]);

export function sourceRestFromPath(path: string): string | null {
  const trimmed = path.trim().replace(/^\/+/, "");
  if (!trimmed.startsWith("raw/sources/")) return null;
  const rest = trimmed.slice("raw/sources/".length);
  if (
    !rest ||
    rest.includes("\\") ||
    rest.includes("\0") ||
    rest.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return rest;
}

export function sourceCascadeKeys(path: string, sourceTitle?: string): string[] {
  const rest = sourceRestFromPath(path);
  if (!rest) return [];
  const keys = new Set<string>([path, rest, `raw/sources/${rest}`]);
  const segments = rest.split("/");
  const leaf = segments[segments.length - 1] ?? "";
  const leafBase = leaf.replace(/\.[^.]+$/, "");
  if (leaf) keys.add(leaf);
  if (leafBase) keys.add(leafBase);
  if (sourceTitle?.trim()) keys.add(sourceTitle.trim());
  return [...keys].filter(Boolean);
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
  for (const field of ["source_url", "path", "slug"] as const) {
    const value = frontmatter[field];
    if (typeof value === "string" && keySet.has(value)) return true;
  }
  return false;
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
  if (sources.length === 0) return false;
  const keySet = new Set(keys);
  return sources.every(
    (entry) =>
      keySet.has(entry.url) || (entry.raw_id ? keySet.has(entry.raw_id) : false),
  );
}

export async function cascadeDeleteSource(input: {
  owner: string;
  path: string;
  sourceTitle?: string;
}): Promise<{ deletedPages: string[]; updatedPages: string[] }> {
  const rest = sourceRestFromPath(input.path);
  if (!rest) throw new Error("That source path is not allowed.");
  const keys = sourceCascadeKeys(input.path, input.sourceTitle);
  const pages = await listWikiPages();
  const summaries: string[] = [];
  const others: string[] = [];

  for (const entry of pages) {
    if (BOOKKEEPING.has(entry.slug)) continue;
    const page = await readWikiPageWithFrontmatter(entry.slug);
    if (!page) continue;
    const summary = isSourceSummary(page.frontmatter, keys);
    const cites = pageCitesSource(page.frontmatter, keys);
    if (summary) summaries.push(entry.slug);
    else if (cites) others.push(entry.slug);
  }

  const deletedPages: string[] = [];
  const updatedPages: string[] = [];

  for (const slug of summaries) {
    await deleteWikiPage(slug, input.owner);
    deletedPages.push(slug);
  }

  for (const slug of others) {
    const page = await readWikiPageWithFrontmatter(slug);
    if (!page) continue;
    if (soleSource(page.frontmatter, keys)) {
      await deleteWikiPage(slug, input.owner);
      deletedPages.push(slug);
      continue;
    }
    const sources = parseSources(
      typeof page.frontmatter.sources === "string" ||
        Array.isArray(page.frontmatter.sources)
        ? (page.frontmatter.sources as string | string[])
        : undefined,
    );
    const keySet = new Set(keys);
    const kept = sources.filter(
      (entry) =>
        !keySet.has(entry.url) && !(entry.raw_id && keySet.has(entry.raw_id)),
    );
    const frontmatter = { ...page.frontmatter };
    frontmatter.sources = serializeSources(kept);
    frontmatter.source_count = String(kept.length);
    // Mechanical cleanup does not clear disputed.
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

  await deleteRawSourceBytes(rest, input.owner);

  try {
    for (const key of keys) {
      await markActionItemsSourceMissing(input.owner, key);
    }
  } catch (error) {
    logger.warn("source-cascade", "todo source-missing mark failed", error);
  }

  return { deletedPages, updatedPages };
}
