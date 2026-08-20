import { unzipSync, zlibSync } from "fflate";
import { MAX_CONTENT_LENGTH, MAX_DOCUMENT_SIZE } from "./constants";
import { ClientInputError } from "./errors";
import { extractTitle, htmlToMarkdown } from "./html-parse";
import { describeImage } from "./vision";

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
type OfficeFormat = "docx" | "pptx" | "xlsx";

const MAX_ARCHIVE_TEXT_BYTES = 12 * 1024 * 1024;
const MAX_ARCHIVE_ENTRY_BYTES = 6 * 1024 * 1024;
const MAX_DOCUMENT_IMAGES = 50;
const MAX_DOCUMENT_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_DOCUMENT_IMAGE_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_SHEETS = 100;
const MAX_ROWS_PER_SHEET = 10_000;
const MAX_COLUMNS_PER_SHEET = 256;
const MAX_ZIP_ENTRIES = 500;
const MAX_ZIP_ENTRY_BYTES = 10 * 1024 * 1024;
const MAX_ZIP_TOTAL_BYTES = 30 * 1024 * 1024;
const MAX_PDF_IMAGES = 8;
const MAX_PDF_IMAGE_PIXELS = 12_000_000;

const MIME_FORMATS: Record<string, DocumentFormat> = {
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
const EXTENSION_ALIASES: Record<string, DocumentFormat> = {
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
 * The token each format is called by in user-facing prose. Four hand-written
 * sentences enumerate the supported formats:
 * `workers/email-ingest/index.ts` (a Cloudflare Worker reply string, in a
 * bundle that cannot import `src/lib` at all), `workers/email-ingest/README.md`
 * (Markdown), `src/components/EmailIngestSettings.tsx` (a JSX bullet) and
 * `src/app/api/ingest/document/route.ts` (an API error message).
 *
 * The last two COULD import a sentence generated from this map. Generating at
 * only those two would leave the Worker string and the README unpinned and
 * split one convention into two, so `prose-inventory-parity.test.ts` instead
 * reads all six of the repo's prose inventories back out of their files and
 * compares their tokens to a derived set — this map being the derived set for
 * these four.
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

export interface ExtractedDocument {
  format: DocumentFormat;
  title: string;
  text: string;
  metadata: {
    creator?: string;
    created?: string;
    modified?: string;
  };
  assets: ExtractedDocumentAsset[];
}

export interface ExtractedDocumentAsset {
  filename: string;
  mediaType: string;
  bytes: ArrayBuffer;
  alt: string;
  context: string;
}

const IMAGE_MEDIA_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  bmp: "image/bmp",
  ico: "image/x-icon",
};

function extension(filename: string): string {
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
function ownLookup<T>(table: Record<string, T>, key: string): T | null {
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

function decodeXml(value: string): string {
  return value.replace(
    /&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,
    (entity, code: string) => {
      if (code[0] === "#") {
        const hex = code[1]?.toLowerCase() === "x";
        const point = Number.parseInt(code.slice(hex ? 2 : 1), hex ? 16 : 10);
        return Number.isFinite(point) && point >= 0 && point <= 0x10ffff
          ? String.fromCodePoint(point)
          : entity;
      }
      return ({ amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<string, string>)[
        code.toLowerCase()
      ] ?? entity;
    },
  );
}

function xmlText(fragment: string, tagPattern: string): string[] {
  const values: string[] = [];
  const re = new RegExp(`<${tagPattern}\\b[^>]*>([\\s\\S]*?)<\\/${tagPattern}>`, "gi");
  for (const match of fragment.matchAll(re)) {
    const text = decodeXml(match[1].replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    if (text) values.push(text);
  }
  return values;
}

function truncate(text: string): string {
  const trimmed = text.replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n").trim();
  return trimmed.length > MAX_CONTENT_LENGTH
    ? `${trimmed.slice(0, MAX_CONTENT_LENGTH - 25).trimEnd()}\n\n[Content truncated]`
    : trimmed;
}

function fallbackTitle(filename: string, label: string): string {
  return filename.replace(/\.(docx|pptx|xlsx|csv|odt|ods|odp|epub|org|rtf|mobi)$/i, "").trim() || label;
}

function concatBytes(parts: readonly Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function uint32(value: number): Uint8Array {
  return new Uint8Array([
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ]);
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const body = concatBytes([typeBytes, data]);
  return concatBytes([uint32(data.length), body, uint32(crc32(body))]);
}

/** Encode raw unpdf pixels into a portable PNG without native canvas/sharp. */
export function rawPixelsToPng(input: {
  data: Uint8ClampedArray;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
}): ArrayBuffer {
  const { width, height, channels } = input;
  if (width < 1 || height < 1 || width * height > MAX_PDF_IMAGE_PIXELS) {
    throw new ClientInputError("PDF image dimensions are outside the safe limit.");
  }
  const rows = new Uint8Array(height * (1 + width * 4));
  for (let y = 0; y < height; y += 1) {
    const row = y * (1 + width * 4);
    rows[row] = 0;
    for (let x = 0; x < width; x += 1) {
      const source = (y * width + x) * channels;
      const target = row + 1 + x * 4;
      if (channels === 1) {
        rows[target] = input.data[source];
        rows[target + 1] = input.data[source];
        rows[target + 2] = input.data[source];
        rows[target + 3] = 255;
      } else {
        rows[target] = input.data[source];
        rows[target + 1] = input.data[source + 1];
        rows[target + 2] = input.data[source + 2];
        rows[target + 3] = channels === 4 ? input.data[source + 3] : 255;
      }
    }
  }
  const ihdr = concatBytes([
    uint32(width), uint32(height), new Uint8Array([8, 6, 0, 0, 0]),
  ]);
  const png = concatBytes([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", zlibSync(rows, { level: 6 })),
    pngChunk("IEND", new Uint8Array()),
  ]);
  return png.buffer.slice(png.byteOffset, png.byteOffset + png.byteLength) as ArrayBuffer;
}

function rtfToText(rtf: string): string {
  const cp1252 = [
    "€", "\u0081", "‚", "ƒ", "„", "…", "†", "‡", "ˆ", "‰", "Š", "‹", "Œ", "\u008d", "Ž", "\u008f",
    "\u0090", "‘", "’", "“", "”", "•", "–", "—", "˜", "™", "š", "›", "œ", "\u009d", "ž", "Ÿ",
  ];
  return rtf
    .replace(/\\par[d]?\b/g, "\n")
    .replace(/\\tab\b/g, "\t")
    .replace(/\\'[0-9a-f]{2}/gi, (value) => {
      const byte = Number.parseInt(value.slice(2), 16);
      return byte >= 0x80 && byte <= 0x9f ? cp1252[byte - 0x80] : String.fromCharCode(byte);
    })
    .replace(/\\u(-?\d+)\??/g, (_match, value: string) =>
      String.fromCharCode((Number.parseInt(value, 10) + 65536) % 65536))
    .replace(/\\[a-z]+-?\d* ?/gi, "")
    .replace(/[{}]/g, "")
    .replace(/\\([{}\\])/g, "$1")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function palmDocDecompress(input: Uint8Array): Uint8Array {
  const output: number[] = [];
  for (let index = 0; index < input.length; index += 1) {
    const byte = input[index];
    if (byte >= 1 && byte <= 8) {
      for (let count = 0; count < byte && index + 1 < input.length; count += 1) output.push(input[++index]);
    } else if (byte <= 0x7f) output.push(byte);
    else if (byte <= 0xbf && index + 1 < input.length) {
      const pair = (byte << 8) | input[++index];
      const distance = (pair >> 3) & 0x7ff;
      const length = (pair & 7) + 3;
      for (let count = 0; count < length; count += 1) {
        output.push(distance <= output.length ? output[output.length - distance] : 32);
      }
    } else {
      output.push(32, byte ^ 0x80);
    }
  }
  return new Uint8Array(output);
}

function extractMobi(bytes: ArrayBuffer): string {
  const data = new Uint8Array(bytes);
  if (data.length < 100) throw new ClientInputError("The MOBI file is too small or corrupt.");
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const recordCount = view.getUint16(76, false);
  if (recordCount < 2 || 78 + recordCount * 8 > data.length) throw new ClientInputError("The MOBI record table is invalid.");
  const offsets = Array.from({ length: recordCount }, (_, index) => view.getUint32(78 + index * 8, false));
  const first = offsets[0];
  if (first + 16 > data.length) throw new ClientInputError("The MOBI header is invalid.");
  const compression = view.getUint16(first, false);
  const textRecordCount = Math.min(view.getUint16(first + 8, false), recordCount - 1, 500);
  const chunks: Uint8Array[] = [];
  for (let index = 1; index <= textRecordCount; index += 1) {
    const start = offsets[index];
    const end = offsets[index + 1] ?? data.length;
    if (start >= end || end > data.length) continue;
    const record = data.slice(start, end);
    chunks.push(compression === 2 ? palmDocDecompress(record) : record);
  }
  const decoded = new TextDecoder("windows-1252").decode(concatBytes(chunks)).replace(/\0/g, "").trim();
  if (!decoded) throw new ClientInputError("The MOBI file contains no extractable text.");
  return /<[a-z][\s\S]*>/i.test(decoded) ? htmlToMarkdown(decoded) : decoded;
}

function openDocumentText(files: Record<string, Uint8Array>, format: "odt" | "ods" | "odp"): string {
  const content = files["content.xml"];
  if (!content) throw new ClientInputError(`The ${format.toUpperCase()} file has no content.xml.`);
  const xml = new TextDecoder().decode(content);
  if (format === "odt") {
    return Array.from(xml.matchAll(/<(text:h|text:p)\b([^>]*)>([\s\S]*?)<\/\1>/gi))
      .map((match) => {
        const text = decodeXml(match[3].replace(/<text:tab\b[^>]*\/?>(?:<\/text:tab>)?/gi, "\t").replace(/<[^>]+>/g, "")).trim();
        const level = match[1].toLowerCase() === "text:h" ? Math.min(6, Math.max(1, Number(attr(match[2], "text:outline-level")) || 2)) : 0;
        return text ? `${level ? `${"#".repeat(level)} ` : ""}${text}` : "";
      }).filter(Boolean).join("\n\n");
  }
  if (format === "odp") {
    return Array.from(xml.matchAll(/<draw:page\b([^>]*)>([\s\S]*?)<\/draw:page>/gi))
      .map((match, index) => `## Slide ${index + 1}\n\n${decodeXml(match[2].replace(/<text:p\b[^>]*>/gi, "").replace(/<\/text:p>/gi, "\n").replace(/<[^>]+>/g, " ")).replace(/\s+\n/g, "\n").trim()}`)
      .join("\n\n");
  }
  return Array.from(xml.matchAll(/<table:table\b([^>]*)>([\s\S]*?)<\/table:table>/gi))
    .map((table, index) => {
      const rows = Array.from(table[2].matchAll(/<table:table-row\b[^>]*>([\s\S]*?)<\/table:table-row>/gi))
        .slice(0, MAX_ROWS_PER_SHEET)
        .map((row) => Array.from(row[1].matchAll(/<table:table-cell\b[^>]*>([\s\S]*?)<\/table:table-cell>/gi))
          .slice(0, MAX_COLUMNS_PER_SHEET)
          .map((cell) => decodeXml(cell[1].replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim()));
      return `## ${decodeXml(attr(table[1], "table:name")) || `Sheet ${index + 1}`}\n\n${markdownTable(rows)}`;
    }).join("\n\n");
}

function extractEpub(files: Record<string, Uint8Array>): { title?: string; creator?: string; text: string } {
  const packageEntry = Object.entries(files).find(([name]) => /\.opf$/i.test(name));
  const opf = packageEntry ? new TextDecoder().decode(packageEntry[1]) : "";
  const title = xmlText(opf, "dc:title")[0];
  const creator = xmlText(opf, "dc:creator")[0];
  const sections = Object.entries(files)
    .filter(([name]) => /\.(?:xhtml|html|htm)$/i.test(name) && !/nav\.(?:xhtml|html)$/i.test(name))
    .sort(([a], [b]) => a.localeCompare(b))
    .slice(0, 300)
    .map(([name, value]) => `## ${name}\n\n${htmlToMarkdown(new TextDecoder().decode(value))}`);
  return { title, creator, text: sections.join("\n\n---\n\n") };
}

async function extractPdfDocument(input: {
  bytes: ArrayBuffer;
  filename: string;
}): Promise<ExtractedDocument> {
  const { pdfToText } = await import("./fetch");
  const textLayer = truncate(await pdfToText(input.bytes));
  const { extractImages, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(input.bytes));
  const assets: ExtractedDocumentAsset[] = [];
  const descriptions: string[] = [];
  let pixels = 0;
  try {
    for (let page = 1; page <= pdf.numPages && assets.length < MAX_PDF_IMAGES; page += 1) {
      let images: Awaited<ReturnType<typeof extractImages>> = [];
      try { images = await extractImages(pdf, page); } catch { continue; }
      for (const image of images) {
        if (assets.length >= MAX_PDF_IMAGES) break;
        const imagePixels = image.width * image.height;
        if (image.width < 64 || image.height < 64 || pixels + imagePixels > MAX_PDF_IMAGE_PIXELS) continue;
        pixels += imagePixels;
        const bytes = rawPixelsToPng(image);
        const vision = await describeImage(bytes, {
          mediaType: "image/png",
          prompt: "Transcribe all legible text in this PDF figure, then describe the chart, diagram, photograph, or visual evidence factually. Preserve uncertainty and do not infer values that are not visible.",
          maxTokens: 700,
          cache: true,
        });
        const alt = vision?.text.split("\n").find((line) => line.trim())?.slice(0, 180) || `PDF figure on page ${page}`;
        assets.push({
          filename: `page-${page}-image-${assets.length + 1}.png`,
          mediaType: "image/png",
          bytes,
          alt,
          context: `PDF page ${page}`,
        });
        if (vision?.text) descriptions.push(`### Figure on page ${page}\n\n${vision.text}`);
      }
    }
  } finally {
    await pdf.destroy().catch(() => undefined);
  }
  const text = truncate([
    textLayer,
    descriptions.length ? `## Visual evidence\n\n${descriptions.join("\n\n")}` : "",
  ].filter(Boolean).join("\n\n"));
  if (!text) throw new ClientInputError("PDF contains no extractable text or readable images.");
  const firstLine = text.split("\n").find((line) => line.trim())?.trim();
  return {
    format: "pdf",
    title: firstLine?.slice(0, 200) || fallbackTitle(input.filename, "PDF document"),
    text,
    metadata: {},
    assets,
  };
}

function coreProperties(files: Record<string, Uint8Array>): {
  title?: string;
  creator?: string;
  created?: string;
  modified?: string;
} {
  const core = files["docProps/core.xml"];
  if (!core) return {};
  const xml = new TextDecoder().decode(core);
  const value = (tag: string, max: number) => xmlText(xml, tag)[0]?.slice(0, max);
  return {
    ...(value("dc:title", 200) ? { title: value("dc:title", 200) } : {}),
    ...(value("dc:creator", 200) ? { creator: value("dc:creator", 200) } : {}),
    ...(value("dcterms:created", 64) ? { created: value("dcterms:created", 64) } : {}),
    ...(value("dcterms:modified", 64) ? { modified: value("dcterms:modified", 64) } : {}),
  };
}

function archiveEntryKind(
  format: Exclude<DocumentFormat, "csv">,
  name: string,
): "xml" | "image" | null {
  if (name === "docProps/core.xml") return "xml";
  if (format === "docx") {
    if (name === "word/document.xml" || name === "word/_rels/document.xml.rels") {
      return "xml";
    }
    if (/^word\/media\/[^/]+$/i.test(name) && mediaTypeFor(name)) return "image";
    return null;
  }
  if (format === "pptx") {
    if (
      name === "ppt/presentation.xml" ||
      name === "ppt/_rels/presentation.xml.rels" ||
      /^ppt\/(slides\/slide\d+|notesSlides\/notesSlide\d+)\.xml$/i.test(name) ||
      /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i.test(name)
    ) return "xml";
    if (/^ppt\/media\/[^/]+$/i.test(name) && mediaTypeFor(name)) return "image";
    return null;
  }
  return (
    name === "xl/workbook.xml" ||
    name === "xl/_rels/workbook.xml.rels" ||
    name === "xl/sharedStrings.xml" ||
    /^xl\/worksheets\/sheet\d+\.xml$/i.test(name)
  ) ? "xml" : null;
}

function openOfficeArchive(
  bytes: ArrayBuffer,
  format: OfficeFormat,
): Record<string, Uint8Array> {
  const input = new Uint8Array(bytes);
  if (input[0] !== 0x50 || input[1] !== 0x4b) {
    throw new ClientInputError(`The .${format} file is not a valid Office document.`);
  }
  let total = 0;
  let imageTotal = 0;
  let imageCount = 0;
  try {
    return unzipSync(input, {
      filter(file) {
        const kind = archiveEntryKind(format, file.name);
        if (!kind) return false;
        if (kind === "image") {
          if (
            imageCount >= MAX_DOCUMENT_IMAGES ||
            file.originalSize > MAX_DOCUMENT_IMAGE_BYTES ||
            imageTotal + file.originalSize > MAX_DOCUMENT_IMAGE_TOTAL_BYTES
          ) {
            return false;
          }
          imageCount += 1;
          imageTotal += file.originalSize;
          return true;
        }
        if (file.originalSize > MAX_ARCHIVE_ENTRY_BYTES) {
          throw new ClientInputError(`The .${format} file contains an oversized XML part.`);
        }
        total += file.originalSize;
        if (total > MAX_ARCHIVE_TEXT_BYTES) {
          throw new ClientInputError(`The .${format} file expands beyond the safe extraction limit.`);
        }
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ClientInputError) throw error;
    throw new ClientInputError(`The .${format} file could not be opened.`);
  }
}

function mediaTypeFor(filename: string): string | null {
  const ext = filename.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  return ownLookup(IMAGE_MEDIA_TYPES, ext);
}

function assetFromArchive(
  files: Record<string, Uint8Array>,
  target: string,
  alt: string,
  context: string,
): ExtractedDocumentAsset | null {
  const bytes = files[target];
  const mediaType = mediaTypeFor(target);
  if (!bytes || !mediaType) return null;
  const filename = target.split("/").pop() || "image";
  const copied = bytes.slice().buffer as ArrayBuffer;
  return {
    filename,
    mediaType,
    bytes: copied,
    alt: alt.trim().slice(0, 240) || filename,
    context,
  };
}

function docxParagraph(fragment: string): string {
  const text = xmlText(fragment.replace(/<w:(tab|br)\b[^>]*\/?>/gi, " "), "w:t").join("");
  if (!text) return "";
  const style = fragment.match(/<w:pStyle\b[^>]*w:val=["']Heading([1-6])["']/i)?.[1];
  return style ? `${"#".repeat(Number(style))} ${text}` : text;
}

function docxTable(fragment: string): string {
  const rows: string[][] = [];
  for (const row of fragment.matchAll(/<w:tr\b[^>]*>([\s\S]*?)<\/w:tr>/gi)) {
    const cells: string[] = [];
    for (const cell of row[1].matchAll(/<w:tc\b[^>]*>([\s\S]*?)<\/w:tc>/gi)) {
      const value = Array.from(cell[1].matchAll(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/gi))
        .map((match) => docxParagraph(match[0]))
        .filter(Boolean)
        .join(" ");
      cells.push(value);
    }
    if (cells.some(Boolean)) rows.push(cells);
  }
  return markdownTable(rows);
}

function extractDocx(files: Record<string, Uint8Array>): {
  text: string;
  assets: ExtractedDocumentAsset[];
} {
  const document = files["word/document.xml"];
  if (!document) throw new ClientInputError("The DOCX file has no document body.");
  const xml = new TextDecoder().decode(document);
  const relBytes = files["word/_rels/document.xml.rels"];
  const relationships = relBytes
    ? relationshipMap(new TextDecoder().decode(relBytes), "word/document.xml")
    : new Map<string, string>();
  const parts: string[] = [];
  const assets: ExtractedDocumentAsset[] = [];
  const seenTargets = new Set<string>();
  let blockNumber = 0;
  for (const block of xml.matchAll(/<w:(p|tbl)\b[^>]*>[\s\S]*?<\/w:\1>/gi)) {
    blockNumber += 1;
    const value = block[1].toLowerCase() === "tbl" ? docxTable(block[0]) : docxParagraph(block[0]);
    if (value) parts.push(value);
    const alt = decodeXml(
      block[0].match(/<wp:docPr\b[^>]*(?:descr|title|name)=["']([^"']+)["']/i)?.[1] ?? "",
    );
    for (const image of block[0].matchAll(/<a:blip\b[^>]*r:embed=["']([^"']+)["'][^>]*\/?>(?:<\/a:blip>)?/gi)) {
      const target = relationships.get(image[1]);
      if (!target || seenTargets.has(target)) continue;
      const asset = assetFromArchive(
        files,
        target,
        alt,
        block[1].toLowerCase() === "tbl" ? `Table near block ${blockNumber}` : `Paragraph ${blockNumber}`,
      );
      if (!asset) continue;
      seenTargets.add(target);
      assets.push(asset);
      parts.push(`_[Embedded image: ${asset.alt}]_`);
    }
  }
  return { text: parts.join("\n\n"), assets };
}

function numberedFiles(files: Record<string, Uint8Array>, pattern: RegExp): [number, Uint8Array][] {
  return Object.entries(files)
    .map(([name, value]) => [Number(name.match(pattern)?.[1] ?? 0), value] as [number, Uint8Array])
    .filter(([number]) => number > 0)
    .sort(([a], [b]) => a - b);
}

function resolveArchiveTarget(sourceFile: string, target: string): string | null {
  if (/^[a-z]+:/i.test(target) || target.startsWith("//")) return null;
  const parts = sourceFile.split("/");
  parts.pop();
  for (const part of target.replace(/^\//, "").split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(part);
  }
  return parts.join("/");
}

function relationshipMap(xml: string, sourceFile: string): Map<string, string> {
  const relationships = new Map<string, string>();
  for (const rel of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
    const id = attr(rel[1], "Id");
    const path = resolveArchiveTarget(sourceFile, attr(rel[1], "Target"));
    if (id && path) relationships.set(id, path);
  }
  return relationships;
}

function extractPptx(files: Record<string, Uint8Array>): {
  text: string;
  assets: ExtractedDocumentAsset[];
} {
  const fallbackSlides = numberedFiles(files, /^ppt\/slides\/slide(\d+)\.xml$/i)
    .map(([number]) => ({ number, path: `ppt/slides/slide${number}.xml` }));
  let slides = fallbackSlides;
  const presentation = files["ppt/presentation.xml"];
  const presentationRels = files["ppt/_rels/presentation.xml.rels"];
  if (presentation && presentationRels) {
    const relationships = relationshipMap(
      new TextDecoder().decode(presentationRels),
      "ppt/presentation.xml",
    );
    const ordered = Array.from(
      new TextDecoder().decode(presentation).matchAll(/<p:sldId\b([^>]*)\/?>(?:<\/p:sldId>)?/gi),
    ).map((match, index) => ({
      number: index + 1,
      path: relationships.get(attr(match[1], "r:id")) ?? "",
    })).filter((slide) => Boolean(files[slide.path]));
    if (ordered.length) slides = ordered;
  }
  if (slides.length === 0) throw new ClientInputError("The PPTX file has no slides.");
  const assets: ExtractedDocumentAsset[] = [];
  const seenTargets = new Set<string>();
  const text = slides.map(({ number, path }) => {
    const bytes = files[path];
    const xml = new TextDecoder().decode(bytes);
    const paragraphs = Array.from(xml.matchAll(/<a:p\b[^>]*>[\s\S]*?<\/a:p>/gi))
      .map((match) => xmlText(match[0], "a:t").join(""))
      .filter(Boolean);
    const slideFilename = path.split("/").pop() ?? "";
    const relPath = `ppt/slides/_rels/${slideFilename}.rels`;
    const relBytes = files[relPath];
    const relationships = relBytes
      ? relationshipMap(new TextDecoder().decode(relBytes), path)
      : new Map<string, string>();
    const notePath = Array.from(relationships.values()).find((target) =>
      /^ppt\/notesSlides\/notesSlide\d+\.xml$/i.test(target),
    );
    const noteBytes = notePath ? files[notePath] : undefined;
    const noteText = noteBytes
      ? xmlText(new TextDecoder().decode(noteBytes), "a:t").filter(
          (value) => value !== String(number),
        )
      : [];
    const imageDescriptions = Array.from(
      xml.matchAll(/<p:cNvPr\b([^>]*)\/?>(?:<\/p:cNvPr>)?/gi),
    ).map((match) =>
      decodeXml(attr(match[1], "descr") || attr(match[1], "title") || attr(match[1], "name")),
    ).filter(Boolean);
    const imageLines: string[] = [];
    let imageIndex = 0;
    for (const image of xml.matchAll(/<a:blip\b[^>]*r:embed=["']([^"']+)["'][^>]*\/?>(?:<\/a:blip>)?/gi)) {
      const target = relationships.get(image[1]);
      if (!target || seenTargets.has(target)) continue;
      const asset = assetFromArchive(
        files,
        target,
        imageDescriptions[imageIndex] || "",
        `Slide ${number}`,
      );
      imageIndex += 1;
      if (!asset) continue;
      seenTargets.add(target);
      assets.push(asset);
      imageLines.push(`- ${asset.alt} (${asset.filename})`);
    }
    return [
      `## Slide ${number}`,
      paragraphs.join("\n"),
      imageLines.length ? `### Embedded images\n${imageLines.join("\n")}` : "",
      noteText.length ? `### Speaker notes\n${noteText.join("\n")}` : "",
    ].filter(Boolean).join("\n\n");
  }).join("\n\n");
  return { text, assets };
}

function attr(fragment: string, name: string): string {
  return fragment.match(new RegExp(`\\b${name}=["']([^"']*)["']`, "i"))?.[1] ?? "";
}

function markdownCell(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}

function markdownTable(rows: string[][]): string {
  if (rows.length === 0) return "";
  const width = Math.min(MAX_COLUMNS_PER_SHEET, Math.max(...rows.map((row) => row.length)));
  const normalized = rows.map((row) =>
    Array.from({ length: width }, (_, index) => markdownCell(row[index] ?? "")),
  );
  const header = normalized[0];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...normalized.slice(1).map((row) => `| ${row.join(" | ")} |`),
  ].join("\n");
}

function columnIndex(reference: string): number {
  const letters = reference.match(/^[A-Z]+/i)?.[0]?.toUpperCase() ?? "";
  let result = 0;
  for (const letter of letters) result = result * 26 + letter.charCodeAt(0) - 64;
  return Math.max(0, result - 1);
}

function worksheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/gi)) {
    if (rows.length >= MAX_ROWS_PER_SHEET) break;
    const values: string[] = [];
    for (const cell of row[1].matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/gi)) {
      const index = Math.min(MAX_COLUMNS_PER_SHEET - 1, columnIndex(attr(cell[1], "r")));
      const type = attr(cell[1], "t");
      const raw = xmlText(cell[2], "v")[0] ?? "";
      const value = type === "s"
        ? shared[Number(raw)] ?? ""
        : type === "inlineStr"
          ? xmlText(cell[2], "t").join("")
          : type === "b"
            ? raw === "1" ? "TRUE" : "FALSE"
            : raw;
      values[index] = value;
    }
    if (values.some((value) => value !== undefined && value !== "")) rows.push(values);
  }
  return rows;
}

function extractXlsx(files: Record<string, Uint8Array>): string {
  const sharedXml = files["xl/sharedStrings.xml"];
  const shared = sharedXml
    ? Array.from(new TextDecoder().decode(sharedXml).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi))
        .map((match) => xmlText(match[1], "t").join(""))
    : [];

  const workbook = files["xl/workbook.xml"];
  const relationships = files["xl/_rels/workbook.xml.rels"];
  const relationshipPaths = new Map<string, string>();
  if (relationships) {
    const xml = new TextDecoder().decode(relationships);
    for (const rel of xml.matchAll(/<Relationship\b([^>]*)\/?>(?:<\/Relationship>)?/gi)) {
      const id = attr(rel[1], "Id");
      const target = attr(rel[1], "Target").replace(/^\/?/, "");
      if (id && target && !target.includes("..")) {
        relationshipPaths.set(id, target.startsWith("xl/") ? target : `xl/${target}`);
      }
    }
  }

  const sheets: { name: string; path: string }[] = [];
  if (workbook) {
    const xml = new TextDecoder().decode(workbook);
    for (const sheet of xml.matchAll(/<sheet\b([^>]*)\/?>(?:<\/sheet>)?/gi)) {
      const name = decodeXml(attr(sheet[1], "name")) || `Sheet ${sheets.length + 1}`;
      const id = attr(sheet[1], "r:id");
      const path = relationshipPaths.get(id);
      if (path && files[path]) sheets.push({ name, path });
    }
  }
  if (sheets.length === 0) {
    for (const [number] of numberedFiles(files, /^xl\/worksheets\/sheet(\d+)\.xml$/i)) {
      sheets.push({ name: `Sheet ${number}`, path: `xl/worksheets/sheet${number}.xml` });
    }
  }
  if (sheets.length === 0) throw new ClientInputError("The XLSX file has no worksheets.");

  return sheets.slice(0, MAX_SHEETS).map(({ name, path }) => {
    const rows = worksheetRows(new TextDecoder().decode(files[path]), shared);
    return `## ${name}\n\n${markdownTable(rows) || "[Empty worksheet]"}`;
  }).join("\n\n");
}

export function parseCsv(csv: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let value = "";
  let quoted = false;
  for (let i = 0; i < csv.length && rows.length < MAX_ROWS_PER_SHEET; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') {
        value += '"';
        i += 1;
      } else if (char === '"') quoted = false;
      else value += char;
    } else if (char === '"' && value.length === 0) quoted = true;
    else if (char === ",") {
      if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
      value = "";
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && csv[i + 1] === "\n") i += 1;
      if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
      if (row.some((cell) => cell.trim())) rows.push(row);
      row = [];
      value = "";
    } else value += char;
  }
  if (quoted) throw new ClientInputError("The CSV file has an unterminated quoted field.");
  if (value || row.length) {
    if (row.length < MAX_COLUMNS_PER_SHEET) row.push(value);
    if (row.some((cell) => cell.trim())) rows.push(row);
  }
  return rows;
}

export function extractDocumentText(input: {
  bytes: ArrayBuffer;
  filename: string;
  contentType?: string;
}): ExtractedDocument {
  const { bytes, filename, contentType } = input;
  if (bytes.byteLength === 0) throw new ClientInputError("The document is empty.");
  if (bytes.byteLength > MAX_DOCUMENT_SIZE) {
    throw new ClientInputError(`Document too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB).`);
  }
  const format = detectDocumentFormat(filename, contentType);
  if (!format) {
    throw new ClientInputError(
      "Unsupported document type. Upload PDF, Word, PowerPoint, spreadsheet, OpenDocument, EPUB, MOBI, RTF, Org, Markdown, text, HTML, CSV, or ZIP files.",
    );
  }

  if (format === "pdf" || format === "zip") {
    throw new ClientInputError(`.${format} extraction requires the asynchronous document pipeline.`);
  }

  if (format === "md" || format === "txt" || format === "html" || format === "org" || format === "rtf") {
    const decoded = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const text = truncate(
      format === "html" ? htmlToMarkdown(decoded) : format === "rtf" ? rtfToText(decoded) : decoded,
    );
    if (!text) throw new ClientInputError(`The .${format} file contains no extractable text.`);
    return {
      format,
      title:
        (format === "html" ? extractTitle(decoded) : undefined) ??
        fallbackTitle(filename, `${format.toUpperCase()} document`),
      text,
      metadata: {},
      assets: [],
    };
  }

  if (format === "mobi") {
    return {
      format,
      title: fallbackTitle(filename, "MOBI ebook"),
      text: truncate(extractMobi(bytes)),
      metadata: {},
      assets: [],
    };
  }

  if (format === "csv") {
    const csv = new TextDecoder().decode(bytes).replace(/^\uFEFF/, "");
    const text = truncate(markdownTable(parseCsv(csv)));
    if (!text) throw new ClientInputError("The CSV file contains no rows.");
    return {
      format,
      title: fallbackTitle(filename, "CSV document"),
      text,
      metadata: {},
      assets: [],
    };
  }

  if (format === "odt" || format === "ods" || format === "odp") {
    const files = Object.fromEntries(safeArchiveEntries(bytes));
    const text = truncate(openDocumentText(files, format));
    if (!text) throw new ClientInputError(`The .${format} file contains no extractable text.`);
    const metadata = files["meta.xml"] ? new TextDecoder().decode(files["meta.xml"]) : "";
    const title = xmlText(metadata, "dc:title")[0];
    const creator = xmlText(metadata, "meta:initial-creator")[0] ?? xmlText(metadata, "dc:creator")[0];
    return {
      format,
      title: title ?? fallbackTitle(filename, `${format.toUpperCase()} document`),
      text,
      metadata: { ...(creator ? { creator } : {}) },
      assets: [],
    };
  }

  if (format === "epub") {
    const extracted = extractEpub(Object.fromEntries(safeArchiveEntries(bytes)));
    const text = truncate(extracted.text);
    if (!text) throw new ClientInputError("The EPUB contains no extractable chapters.");
    return {
      format,
      title: extracted.title ?? fallbackTitle(filename, "EPUB ebook"),
      text,
      metadata: { ...(extracted.creator ? { creator: extracted.creator } : {}) },
      assets: [],
    };
  }

  const files = openOfficeArchive(bytes, format);
  const core = coreProperties(files);
  const extracted = format === "docx"
    ? extractDocx(files)
    : format === "pptx"
      ? extractPptx(files)
      : { text: extractXlsx(files), assets: [] };
  const metadataLines = [
    core.creator ? `- Creator: ${core.creator}` : "",
    core.created ? `- Created: ${core.created}` : "",
    core.modified ? `- Modified: ${core.modified}` : "",
  ].filter(Boolean);
  const text = truncate([
    metadataLines.length ? `## Document metadata\n\n${metadataLines.join("\n")}` : "",
    extracted.text,
  ].filter(Boolean).join("\n\n"));
  if (!text) throw new ClientInputError(`The .${format} file contains no extractable text.`);
  return {
    format,
    title: core.title ?? fallbackTitle(filename, `${format.toUpperCase()} document`),
    text,
    metadata: {
      ...(core.creator ? { creator: core.creator } : {}),
      ...(core.created ? { created: core.created } : {}),
      ...(core.modified ? { modified: core.modified } : {}),
    },
    assets: extracted.assets,
  };
}

function safeArchiveEntries(bytes: ArrayBuffer): Array<[string, Uint8Array]> {
  const input = new Uint8Array(bytes);
  if (input[0] !== 0x50 || input[1] !== 0x4b) {
    throw new ClientInputError("The .zip file is not a valid ZIP archive.");
  }
  let count = 0;
  let total = 0;
  try {
    const files = unzipSync(input, {
      filter(file) {
        if (file.name.endsWith("/")) return false;
        count += 1;
        if (count > MAX_ZIP_ENTRIES) {
          throw new ClientInputError(`ZIP archives may contain at most ${MAX_ZIP_ENTRIES} files.`);
        }
        if (file.originalSize > MAX_ZIP_ENTRY_BYTES) {
          throw new ClientInputError(`ZIP entry "${file.name}" is too large.`);
        }
        total += file.originalSize;
        if (total > MAX_ZIP_TOTAL_BYTES) {
          throw new ClientInputError("The ZIP archive expands beyond the safe extraction limit.");
        }
        return true;
      },
    });
    return Object.entries(files).sort(([a], [b]) => a.localeCompare(b));
  } catch (error) {
    if (error instanceof ClientInputError) throw error;
    throw new ClientInputError("The .zip file could not be opened.");
  }
}

/** Full async extractor, including PDFs and safe ZIP/Obsidian exports. */
export async function extractDocumentTextAsync(input: {
  bytes: ArrayBuffer;
  filename: string;
  contentType?: string;
  relativePath?: string;
}): Promise<ExtractedDocument> {
  const format = detectDocumentFormat(input.filename, input.contentType);
  if (format === "pdf") {
    if (input.bytes.byteLength === 0) throw new ClientInputError("The document is empty.");
    return extractPdfDocument({ bytes: input.bytes, filename: input.filename });
  }

  if (format === "zip") {
    const sections: string[] = [];
    const assets: ExtractedDocumentAsset[] = [];
    for (const [relativePath, value] of safeArchiveEntries(input.bytes)) {
      if (
        relativePath.startsWith("__MACOSX/") ||
        relativePath.split("/").some((part) => part.startsWith("."))
      ) continue;
      const nestedFormat = detectDocumentFormat(relativePath);
      if (!nestedFormat || nestedFormat === "zip") continue;
      const nestedBytes = value.buffer.slice(
        value.byteOffset,
        value.byteOffset + value.byteLength,
      ) as ArrayBuffer;
      try {
        const nested = await extractDocumentTextAsync({
          bytes: nestedBytes,
          filename: relativePath,
          relativePath,
        });
        sections.push(`## File: ${relativePath}\n\n${nested.text}`);
        assets.push(...nested.assets);
      } catch (error) {
        if (error instanceof ClientInputError && /no extractable text layer/i.test(error.message)) {
          continue;
        }
        throw error;
      }
    }
    const text = truncate(sections.join("\n\n---\n\n"));
    if (!text) {
      throw new ClientInputError(
        "The ZIP archive contains no supported text or document files.",
      );
    }
    return {
      format,
      title: fallbackTitle(input.filename, "ZIP archive"),
      text,
      metadata: {},
      assets,
    };
  }

  const extracted = extractDocumentText(input);
  if (!input.relativePath || input.relativePath === input.filename) return extracted;
  return {
    ...extracted,
    text: truncate(`## Import location\n\n\`${input.relativePath}\`\n\n${extracted.text}`),
  };
}
