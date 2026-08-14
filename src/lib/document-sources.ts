import type { ExtractedDocument } from "./document-extract";
import { serializeFrontmatter } from "./frontmatter";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { getStorage } from "./storage";
import {
  rawRelPath,
  readWikiPageWithFrontmatter,
  tenantForOwner,
  validateSlug,
} from "./wiki";

export interface DocumentSourceInput {
  bytes: ArrayBuffer;
  filename: string;
  contentType?: string;
  /** Browser-supplied path from a directory upload (for example, `Q1/notes.docx`). */
  relativePath?: string;
  extracted: ExtractedDocument;
}

export interface StoredDocumentSource {
  sha256: string;
  filename: string;
  contentType: string;
  format: ExtractedDocument["format"];
  size: number;
  originalKey: string;
  storedAt: string;
  /** Original directory-upload path. Absent for single files and legacy records. */
  relativePath?: string;
  assets: Array<{
    filename: string;
    mediaType: string;
    publicPath: string;
    alt: string;
    context: string;
  }>;
}

function safeFilename(filename: string, fallback: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^\.+/, "")
    .slice(0, 180);
  return cleaned || fallback;
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}

function recordIndexKey(owner: string, slug: string): string {
  return `document-sources:${tenantForOwner(owner)}:${slug}`;
}

/**
 * Read the preserved upload records for one owner-owned page. The index is
 * deliberately owner-scoped: callers must already know whose source store they
 * are allowed to inspect. Missing and legacy indexes are an ordinary empty
 * state, while storage failures still surface to the route/page error boundary.
 */
export async function listDocumentSources(
  slug: string,
  owner: string,
): Promise<StoredDocumentSource[]> {
  validateSlug(slug);
  const records = await getStorage().getIndex<StoredDocumentSource[]>(
    recordIndexKey(owner, slug),
  );
  return Array.isArray(records) ? records : [];
}

function pageSummary(body: string, fallback: string): string {
  const line = body
    .split("\n")
    .map((value) => value.trim())
    .find((value) => value && !value.startsWith("#") && !value.startsWith("!["));
  return (line || fallback).replace(/[*_`]/g, "").slice(0, 200);
}

async function appendSourceFigures(
  slug: string,
  owner: string,
  records: StoredDocumentSource[],
): Promise<void> {
  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) throw new Error(`Cannot attach document figures: page "${slug}" was not found.`);

  const entries: string[] = [];
  for (const record of records) {
    const newAssets = record.assets.filter((asset) => !page.body.includes(asset.publicPath));
    if (newAssets.length === 0) continue;
    entries.push(
      [
        `### ${record.filename}`,
        ...newAssets.flatMap((asset) => [
          `![${asset.alt}](${asset.publicPath})`,
          `_${asset.context} · embedded in ${record.filename}_`,
        ]),
      ].join("\n\n"),
    );
  }
  if (entries.length === 0) return;

  const heading = /(?:^|\n)## Source figures\s*(?:\n|$)/.test(page.body)
    ? ""
    : "## Source figures\n\n";
  const body = `${page.body.trimEnd()}\n\n${heading}${entries.join("\n\n")}`;
  const title = body.match(/^#\s+(.+?)\s*$/m)?.[1]?.trim() || slug;
  await writeWikiPageWithSideEffects({
    slug,
    title,
    content: serializeFrontmatter(page.frontmatter, body),
    summary: pageSummary(body, title),
    logOp: "other",
    logDetails: () => `preserved embedded figures from ${records.length} document source(s)`,
    crossRefSource: null,
    author: owner,
  });
}

/**
 * Permanently preserve original document/archive bytes and their web-safe embedded
 * figures after the canonical page slug is known. Originals are owner-scoped
 * in R2; figures are stored under the page slug so the existing authenticated
 * asset route can enforce the page's visibility.
 */
export async function preserveDocumentSources(
  slug: string,
  owner: string,
  sources: readonly DocumentSourceInput[],
): Promise<StoredDocumentSource[]> {
  validateSlug(slug);
  if (sources.length === 0) return [];

  const storage = getStorage();
  const tenant = tenantForOwner(owner);
  const stored: StoredDocumentSource[] = [];

  for (const [sourceIndex, source] of sources.entries()) {
    const digest = await sha256(source.bytes);
    const shortDigest = digest.slice(0, 16);
    const filename = safeFilename(source.filename, `document-${sourceIndex + 1}.${source.extracted.format}`);
    const originalKey = rawRelPath(
      `originals/${tenant}/${slug}/${shortDigest}-${filename}`,
    );
    await storage.writeAsset(originalKey, source.bytes);

    const assets: StoredDocumentSource["assets"] = [];
    for (const [assetIndex, asset] of source.extracted.assets.entries()) {
      const assetName = safeFilename(
        asset.filename,
        `image-${assetIndex + 1}`,
      );
      const storedName = `source-${shortDigest}-${assetIndex + 1}-${assetName}`;
      await storage.writeAsset(rawRelPath(`assets/${slug}/${storedName}`), asset.bytes);
      assets.push({
        filename: asset.filename,
        mediaType: asset.mediaType,
        publicPath: `/api/assets/${slug}/${storedName}`,
        alt: asset.alt,
        context: asset.context,
      });
    }

    stored.push({
      sha256: digest,
      filename: source.filename,
      contentType: source.contentType || "application/octet-stream",
      format: source.extracted.format,
      size: source.bytes.byteLength,
      originalKey,
      storedAt: new Date().toISOString(),
      ...(source.relativePath ? { relativePath: source.relativePath } : {}),
      assets,
    });
  }

  const indexKey = recordIndexKey(owner, slug);
  const existing = await storage.getIndex<StoredDocumentSource[]>(indexKey);
  const byDigest = new Map(
    (Array.isArray(existing) ? existing : []).map((record) => [record.sha256, record]),
  );
  for (const record of stored) byDigest.set(record.sha256, record);
  await storage.putIndex(indexKey, Array.from(byDigest.values()));
  await appendSourceFigures(slug, owner, stored);
  return stored;
}
