import type { DocumentFormat } from "./document-extract";
import type { Principal } from "./auth";
import { canReadPage } from "./authz";
import {
  listDocumentSources,
  type StoredDocumentSource,
} from "./document-sources";
import { getPageIndex } from "./page-index";
import type { IndexEntry } from "./types";
import type { Vault } from "./vault";
import { readWikiPageWithFrontmatter } from "./wiki";

export interface VaultExplorerSource {
  sha256: string;
  filename: string;
  contentType: string;
  format: DocumentFormat;
  size: number;
  storedAt: string;
  relativePath?: string;
  assets?: Array<{
    filename: string;
    mediaType: string;
    publicPath: string;
    alt: string;
    context: string;
  }>;
}

export interface VaultExplorerEntry {
  slug: string;
  title: string;
  summary?: string;
  tags: string[];
  updated?: string;
  confidence?: number;
  owner?: string;
  type?: string;
  sourceCount?: number;
  /** Directory portion of a bulk upload's original relative path. */
  folderPath?: string;
  /** Preserved originals visible only through the owner-gated vault routes. */
  sources: VaultExplorerSource[];
  /** A stale vault reference whose page has since disappeared. */
  missing?: boolean;
}

type VaultExplorerMetadata = Omit<VaultExplorerEntry, "sources"> & {
  visibility?: string;
};

function cleanRelativePath(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const segments = value
    .replace(/\\/g, "/")
    .split("/")
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== "." && segment !== "..");
  return segments.length > 0 ? segments.join("/").slice(0, 1_000) : undefined;
}

/** Directory portion of an upload path, or undefined for a loose file. */
export function folderFromRelativePath(
  relativePath: string | undefined,
): string | undefined {
  const clean = cleanRelativePath(relativePath);
  if (!clean) return undefined;
  const slash = clean.lastIndexOf("/");
  return slash > 0 ? clean.slice(0, slash) : undefined;
}

function sourceForExplorer(record: StoredDocumentSource): VaultExplorerSource {
  const relativePath = cleanRelativePath(record.relativePath);
  return {
    sha256: record.sha256,
    filename: record.filename,
    contentType: record.contentType,
    format: record.format,
    size: record.size,
    storedAt: record.storedAt,
    assets: record.assets.map((asset) => ({ ...asset })),
    ...(relativePath ? { relativePath } : {}),
  };
}

function entryFromIndex(entry: IndexEntry): VaultExplorerMetadata {
  return {
    slug: entry.slug,
    title: entry.title,
    ...(entry.summary ? { summary: entry.summary } : {}),
    tags: entry.tags ?? [],
    ...(entry.updated ? { updated: entry.updated } : {}),
    ...(entry.confidence !== undefined ? { confidence: entry.confidence } : {}),
    ...(entry.owner ? { owner: entry.owner } : {}),
    ...(entry.type ? { type: entry.type } : {}),
    ...(entry.visibility ? { visibility: entry.visibility } : {}),
    ...(entry.sourceCount !== undefined
      ? { sourceCount: entry.sourceCount }
      : {}),
  };
}

async function fallbackEntry(
  slug: string,
): Promise<VaultExplorerMetadata> {
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) {
    return { slug, title: slug, tags: [], missing: true };
  }
  const fm = page.frontmatter;
  return {
    slug,
    title: typeof fm.title === "string" && fm.title ? fm.title : page.title,
    ...(typeof fm.summary === "string" && fm.summary
      ? { summary: fm.summary }
      : {}),
    tags: Array.isArray(fm.tags)
      ? fm.tags.filter((tag): tag is string => typeof tag === "string")
      : [],
    ...(typeof fm.updated === "string" && fm.updated
      ? { updated: fm.updated }
      : {}),
    ...(typeof fm.confidence === "number"
      ? { confidence: fm.confidence }
      : {}),
    ...(typeof fm.owner === "string" && fm.owner ? { owner: fm.owner } : {}),
    ...(typeof fm.type === "string" && fm.type ? { type: fm.type } : {}),
    ...(typeof fm.visibility === "string" && fm.visibility
      ? { visibility: fm.visibility }
      : {}),
    ...(typeof fm.source_count === "number"
      ? { sourceCount: fm.source_count }
      : {}),
  };
}

/**
 * Resolve a vault's flat slug membership into the metadata needed by the file
 * explorer. Page metadata and owner-scoped source records are fetched in
 * parallel, avoiding a client-side waterfall on first paint.
 */
export async function getVaultExplorerEntries(
  vault: Vault,
  principal: Principal,
): Promise<VaultExplorerEntry[]> {
  const metaIndex = await getPageIndex();

  const entries = await Promise.all(
    vault.slugs.map(async (slug) => {
      const metadataPromise = metaIndex?.[slug]
        ? Promise.resolve(entryFromIndex(metaIndex[slug]))
        : fallbackEntry(slug);
      // Source metadata is optional enrichment. A transient/missing source
      // index must not make the vault's authoritative page list disappear.
      const sourcesPromise = listDocumentSources(slug, principal.handle).catch(
        () => [] as StoredDocumentSource[],
      );
      const [metadata, records] = await Promise.all([
        metadataPromise,
        sourcesPromise,
      ]);
      if (!canReadPage(metadata, principal)) return null;
      const sources = records.map(sourceForExplorer);
      const folderPath = folderFromRelativePath(sources[0]?.relativePath);
      const { visibility: _visibility, ...visibleMetadata } = metadata;
      return {
        ...visibleMetadata,
        ...(folderPath ? { folderPath } : {}),
        sources,
      };
    }),
  );
  return entries.filter((entry): entry is VaultExplorerEntry => entry !== null);
}
