/**
 * The document format tables, and the pure functions that read them.
 *
 * These lived in `./document-extract` — but that module's head imports `fflate`
 * and `./vision` (which reaches `./storage` and `./llm`), so nothing in a client
 * bundle could ever import it. `src/lib/bulk-document-import.ts` and
 * `src/components/BulkDocumentImport.tsx` therefore kept hand-written copies of
 * the allowlist, and the copies fell seven formats behind: dropping `plan.odt`
 * into bulk import was refused client-side even though POSTing the same file to
 * `/api/ingest/document` succeeds (DW-246).
 *
 * So the tables move to a leaf module with ZERO imports (not even
 * `./constants`), exactly as `./lint-types` did for `ALL_CHECK_TYPES` in DW-75,
 * and `./document-extract` re-exports every public name from here so existing
 * importers — including `email-ingest-allowlist-parity.test.ts` and
 * `prose-inventory-parity.test.ts` — are untouched.
 */

export const DOCUMENT_FORMATS = [
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "md",
  "txt",
  "html",
  "pdf",
  "zip",
  "odt",
  "ods",
  "odp",
  "epub",
  "org",
  "rtf",
  "mobi",
] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

export const MIME_FORMATS: Record<string, DocumentFormat> = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "text/csv": "csv",
  "application/csv": "csv",
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/pdf": "pdf",
  "application/zip": "zip",
  "application/x-zip-compressed": "zip",
  "application/vnd.oasis.opendocument.text": "odt",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/vnd.oasis.opendocument.presentation": "odp",
  "application/epub+zip": "epub",
  "text/org": "org",
  "application/rtf": "rtf",
  "text/rtf": "rtf",
  "application/x-mobipocket-ebook": "mobi",
};

/**
 * Extensions that are not themselves `DocumentFormat` members but name one.
 * Lifted out of `detectDocumentFormat` so the exported extension allowlist below
 * is derived from the same table the detector consults — a hand-copied list
 * would drift silently the moment an alias is added here.
 */
export const EXTENSION_ALIASES: Record<string, DocumentFormat> = {
  markdown: "md",
  htm: "html",
};

/**
 * Every filename extension `detectDocumentFormat` accepts, and every content
 * type it accepts. Exported so `email-ingest-allowlist-parity.test.ts` can pin
 * the Cloudflare Worker's duplicate allowlist against the extractor's real
 * behaviour: the Worker bundle cannot import `src/lib`, so the two lists must
 * stay duplicated in source and the test is what keeps them in agreement.
 */
export const SUPPORTED_DOCUMENT_EXTENSIONS: readonly string[] = [
  // Deduped: promoting an alias key into `DOCUMENT_FORMATS` (plausible for
  // `htm`) would otherwise fail the parity test on a length mismatch for a
  // reason that has nothing to do with the two allowlists drifting apart.
  ...new Set<string>([...DOCUMENT_FORMATS, ...Object.keys(EXTENSION_ALIASES)]),
];
export const SUPPORTED_DOCUMENT_MIME_TYPES: readonly string[] =
  Object.keys(MIME_FORMATS);

/**
 * The token each format is called by in user-facing prose. Five sentences
 * enumerate the supported formats — four hand-written:
 * `workers/email-ingest/index.ts` (a Cloudflare Worker reply string, in a
 * bundle that cannot import `src/lib` at all), `workers/email-ingest/README.md`
 * (Markdown), `src/components/EmailIngestSettings.tsx` (a JSX bullet) and
 * `src/app/api/ingest/document/route.ts` (an API error message) — plus one
 * GENERATED: `SUPPORTED_FORMATS_SENTENCE` in `./bulk-document-import`, the
 * bulk-import rejection copy, which joins `Object.values` of this map at module
 * load and so cannot drift at all (DW-246).
 *
 * That generated one is the shape the other four would take if they could. Two
 * of them COULD — `EmailIngestSettings.tsx` and the ingest route — but the
 * Worker string and the README cannot import from `src/lib` under any
 * arrangement, so generating at only those two would leave the other two
 * unpinned and split one convention into two. `prose-inventory-parity.test.ts`
 * therefore reads all six of the repo's prose inventories back out of their
 * files and compares their tokens to a derived set — this map being the derived
 * set for the four hand-written format sentences.
 *
 * It lives here, next to `DOCUMENT_FORMATS`, because `Record<DocumentFormat, …>`
 * is exhaustive at compile time: a format added above cannot land without a
 * label, and once it has one the four prose tests name it as unmentioned. The
 * labels are the prose spelling, not a mechanical upper-casing — `md` is
 * written "Markdown" and `org` is written "Org".
 */
export const DOCUMENT_FORMAT_LABELS: Record<DocumentFormat, string> = {
  docx: "DOCX",
  pptx: "PPTX",
  xlsx: "XLSX",
  csv: "CSV",
  md: "Markdown",
  txt: "TXT",
  html: "HTML",
  pdf: "PDF",
  zip: "ZIP",
  odt: "ODT",
  ods: "ODS",
  odp: "ODP",
  epub: "EPUB",
  org: "Org",
  rtf: "RTF",
  mobi: "MOBI",
};

export function extension(filename: string): string {
  const match = filename.trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] ?? "";
}

/**
 * Look a key up in one of the format tables WITHOUT walking the prototype
 * chain.
 *
 * A bare `TABLE[key]` answers `"constructor"`, `"valueOf"`, `"toString"` and
 * every other `Object.prototype` member with an inherited function, and `?? null`
 * does NOT rescue it — the inherited value is neither `null` nor `undefined`.
 * `detectDocumentFormat("weird.constructor")` therefore returned `Object` (a
 * truthy non-format), `isSupportedDocument` returned true for it, and the
 * "Unsupported document type" 400 gate in `src/app/api/ingest/document/route.ts`
 * stopped firing. `hasOwnProperty.call` rather than `Object.hasOwn` because the
 * build targets ES2018.
 */
export function ownLookup<T>(table: Record<string, T>, key: string): T | null {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;
}

export function detectDocumentFormat(
  filename: string,
  contentType?: string,
): DocumentFormat | null {
  const ext = extension(filename);
  const alias = ownLookup(EXTENSION_ALIASES, ext);
  if (alias) return alias;
  if (DOCUMENT_FORMATS.includes(ext as DocumentFormat)) {
    return ext as DocumentFormat;
  }
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mime ? ownLookup(MIME_FORMATS, mime) : null;
}

export function isSupportedDocument(filename: string, contentType?: string): boolean {
  return detectDocumentFormat(filename, contentType) !== null;
}
