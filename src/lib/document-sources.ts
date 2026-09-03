import type { ExtractedDocument } from "./document-extract";
import { serializeFrontmatter } from "./frontmatter";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { RAW_ASSETS_DIR } from "./raw";
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
  // FRESH+STRICT (DW-495). `page.content` is the merge base for the write at
  // the bottom of this function. Without `strict` a non-ENOENT storage blip
  // flattens to `null` and is reported through the throw below as
  // `page "<slug>" was not found` — the wrong story about a page that is
  // stored and only momentarily unreadable. Strict rethrows the storage
  // failure instead, and it propagates out through `preserveDocumentSources`.
  const page = await readWikiPageWithFrontmatter(slug, {
    fresh: true,
    strict: true,
  });
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
    expectedContent: page.content,
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
    // CREATE-ONLY (FR-2, DW-572). `shortDigest` is derived from `source.bytes`,
    // so an occupied key already holds THESE bytes — the boolean is discarded
    // deliberately, not a dropped error: `false` means "another arrival wrote
    // the identical object first", which is a no-op success. The record below
    // still names `originalKey` either way. A provider FAILURE throws from
    // here and fails the arrival; it never degrades to `writeAsset`.
    await storage.writeAssetIfAbsent(originalKey, source.bytes);

    const assets: StoredDocumentSource["assets"] = [];
    for (const [assetIndex, asset] of source.extracted.assets.entries()) {
      const assetName = safeFilename(
        asset.filename,
        `image-${assetIndex + 1}`,
      );
      const storedName = `source-${shortDigest}-${assetIndex + 1}-${assetName}`;
      // Create-only, but NOT for the same reason as the original above. This
      // key carries the digest of the SOURCE DOCUMENT plus the extraction
      // index — never a digest of `asset.bytes` — so it is source-addressed,
      // not byte-addressed. An occupied key means the same source was
      // re-extracted BY THE SAME EXTRACTOR, and the premise that the stored
      // figure equals the one in hand holds only while extraction output stays
      // stable for a given input.
      //
      // THE ACCEPTED COST of freezing it: if extraction output ever changes for
      // an unchanged source — a `document-extract.ts` dependency bump, or a
      // change to `MAX_PDF_IMAGES` / `MAX_PDF_IMAGE_PIXELS` — the stored figure
      // bytes now STAY, while `putIndex` below and `appendSourceFigures` still
      // rewrite the record and the "Source figures" markdown with the new
      // `filename` / `mediaType` / `alt` / `context`. That leaves a stale figure
      // under refreshed metadata, where `writeAsset` used to refresh the bytes.
      // This is a real, reachable outcome, accepted in exchange for FR-2's
      // guarantee that published figure bytes are never mutated; the fix if it
      // ever bites is to fold an extractor version into the key, not to reopen
      // the overwrite door. Boolean discarded — `publicPath` is unchanged
      // either way.
      await storage.writeAssetIfAbsent(
        rawRelPath(`${RAW_ASSETS_DIR}/${slug}/${storedName}`),
        asset.bytes,
      );
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
