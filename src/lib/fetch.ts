/**
 * URL fetching and image downloading.
 *
 * This module is the main entry point for URL-related operations. It also
 * re-exports HTML parsing and URL safety utilities from their dedicated
 * modules for backwards compatibility — existing imports from "./fetch" or
 * "@/lib/fetch" continue to work unchanged.
 */

import path from "path";
import {
  MAX_RESPONSE_SIZE,
  MAX_CONTENT_LENGTH,
  FETCH_TIMEOUT_MS,
  MAX_IMAGES_PER_SOURCE,
  MAX_PDF_SIZE,
} from "./constants";
import { logger } from "./logger";
import {
  stripHtml,
  htmlToMarkdown,
  extractTitle,
  extractWithReadability,
  extractImageUrls,
} from "./html-parse";
import { validateUrlSafety } from "./url-safety";
import { getStorage } from "./storage";
import { rawRelPath } from "./wiki";
import { ClientInputError, getErrorMessage } from "./errors";
import { bytesSha256 } from "./source-sha256";

/**
 * Hex characters of the SHA-256 folded into a stored asset filename. 12 hex
 * chars is 48 bits — far past collision range for one page's images, and short
 * enough to keep the key readable in a markdown embed.
 */
const IMAGE_DIGEST_PREFIX_LEN = 12;

// Re-export HTML parsing utilities for backwards compatibility
export { stripHtml, htmlToMarkdown, extractTitle, extractWithReadability } from "./html-parse";

// Re-export URL safety utilities for backwards compatibility
export { validateUrlSafety } from "./url-safety";

// ---------------------------------------------------------------------------
// URL detection
// ---------------------------------------------------------------------------

/** Check if a string looks like a URL (starts with http:// or https://). */
export function isUrl(input: string): boolean {
  const trimmed = input.trim();
  return trimmed.startsWith("http://") || trimmed.startsWith("https://");
}

// ---------------------------------------------------------------------------
// URL fetching
// ---------------------------------------------------------------------------

// MIME types that fetchUrlContent will accept. Anything outside this list
// (e.g. image/png) is rejected early to avoid feeding binary garbage into the
// HTML-parsing pipeline. PDFs are handled via a dedicated extraction path.
export const ALLOWED_CONTENT_TYPES = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
  "application/xml",
  "text/xml",
  "application/pdf",
];

/** Per-call overrides for {@link fetchUrlContent}. */
export interface FetchUrlOptions {
  /**
   * The content types this CALLER accepts, defaulting to
   * {@link ALLOWED_CONTENT_TYPES}.
   *
   * Narrowing is a door policy, not a capability question. Workbench Intake
   * passes a list without `application/pdf` because that surface must FAIL a
   * PDF visibly rather than extract it, while generic URL ingest keeps the
   * full list. The vault `{ pdfUrl }` door does not use this function at all
   * — it calls {@link fetchPdfBytes} and enqueues extract. Expressed as an
   * argument so the remaining text doors share one fetch, one redirect chain,
   * one SSRF guard and one Readability path.
   */
  allowedContentTypes?: readonly string[];
  /**
   * Cap on extracted text. `null` means do not truncate. Deep Research passes
   * null so synthesis sees the full extracted body; every other door keeps the
   * kernel default ({@link MAX_CONTENT_LENGTH}).
   */
  maxContentLength?: number | null;
}

/**
 * Extract a PDF's text WITH layout structure preserved.
 *
 * unpdf's `extractText` flattens every text item into a single space-joined run
 * (no line breaks), turning a long PDF into one unreadable wall — bad for the
 * human "View raw" surface and weaker as synthesis input. Instead we read
 * pdf.js' per-item text and use each item's `hasEOL` flag to rebuild lines, with
 * a blank line between pages. Falls back to `extractText` when the structured
 * API isn't available (e.g. a stubbed doc) or yields nothing. Shared by the URL
 * and upload PDF paths. Uses a dynamic import to avoid the ~1.6 MB pdf.js bundle
 * on every request.
 */
export async function pdfToText(buffer: ArrayBuffer): Promise<string> {
  const { getDocumentProxy, extractText } = await import("unpdf");
  const doc = await getDocumentProxy(new Uint8Array(buffer));
  try {
    try {
      if (typeof doc.getPage === "function" && doc.numPages > 0) {
        const pages: string[] = [];
        for (let p = 1; p <= doc.numPages; p++) {
          const page = await doc.getPage(p);
          const content = await page.getTextContent();
          const lines: string[] = [];
          let line = "";
          for (const item of content.items as Array<{
            str?: string;
            hasEOL?: boolean;
          }>) {
            if (typeof item.str !== "string") continue;
            line += item.str;
            if (item.hasEOL) {
              lines.push(line.trimEnd());
              line = "";
            }
          }
          if (line.trim()) lines.push(line.trimEnd());
          pages.push(lines.join("\n"));
        }
        const structured = pages.join("\n\n").trim();
        if (structured) return structured;
      }
    } catch {
      // Structured extraction unavailable/failed — fall through to flat text.
    }
    const { text } = await extractText(doc, { mergePages: false });
    return (Array.isArray(text) ? text.join("\n\n") : text).trim();
  } finally {
    await doc.cleanup();
  }
}

async function extractPdfText(
  buffer: ArrayBuffer,
  fallbackTitle: string,
  maxContentLength: number | null = MAX_CONTENT_LENGTH,
): Promise<{ title: string; content: string }> {
  const trimmed = (await pdfToText(buffer)).trim();
  if (!trimmed) {
    throw new ClientInputError(
      "PDF has no extractable text layer. Scanned/image-only PDFs are not supported yet.",
    );
  }

  // Title from the first non-empty line (often the document title).
  const firstLine =
    trimmed.split("\n").find((l) => l.trim().length > 0)?.trim() ??
    fallbackTitle;
  const title = firstLine.length > 200 ? firstLine.slice(0, 200) : firstLine;

  const content = maxContentLength !== null && trimmed.length > maxContentLength
    ? trimmed.slice(0, maxContentLength) + "\n\n[Content truncated]"
    : trimmed;

  return { title: title || fallbackTitle, content };
}

/**
 * Walk a redirect chain by hand, re-checking SSRF safety at every hop.
 *
 * ONE DEADLINE FOR THE WHOLE CHAIN (DW-700). The signal used to be armed inside
 * the loop, so each hop got a fresh `FETCH_TIMEOUT_MS` and five redirects could
 * legally spend six of them -- up to 90 s, past the client deadline that is
 * supposed to outlive this one. Creating the signal ONCE before the loop makes
 * the constant a TOTAL: it covers every hop and, because the returned
 * `Response` body is still tied to it, the body read that follows as well.
 */
async function fetchFollowingRedirects(
  url: string,
): Promise<{ response: Response; finalUrl: string }> {
  // SSRF protection: reject private/reserved addresses before fetching
  validateUrlSafety(url);

  const MAX_REDIRECTS = 5;
  const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

  // Armed HERE, not per hop: the clock must not restart on a redirect.
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);

  let currentUrl = url;
  let response: Response | undefined;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    response = await fetch(currentUrl, {
      headers: {
        "User-Agent": "llm-wiki/1.0",
        Accept: "text/html,application/xhtml+xml,*/*",
      },
      signal,
      redirect: "manual",
    });

    if (!REDIRECT_STATUSES.has(response.status)) {
      break;
    }

    const location = response.headers.get("location");
    if (!location) {
      throw new Error(`Redirect (${response.status}) without Location header`);
    }

    const resolvedUrl = new URL(location, currentUrl).toString();
    validateUrlSafety(resolvedUrl);
    currentUrl = resolvedUrl;

    if (hop === MAX_REDIRECTS) {
      throw new Error(`Too many redirects (max ${MAX_REDIRECTS})`);
    }
  }

  if (!response) {
    throw new Error("No response received");
  }

  if (!response.ok) {
    throw new Error(
      `Failed to fetch URL: ${response.status} ${response.statusText}`,
    );
  }

  return { response, finalUrl: currentUrl };
}

function responseMimeType(response: Response): string | null {
  const raw = response.headers.get("content-type");
  return raw ? raw.split(";")[0].trim().toLowerCase() : null;
}

/**
 * The sniff window, in bytes. 512 is enough for `%PDF-` at offset 0 and for any
 * leading markup, and it is the same window browsers use for the equivalent job.
 */
const SNIFF_WINDOW_BYTES = 512;

/**
 * The tags that make a leading `<` HTML rather than "some angle bracket".
 *
 * Deliberately a CLOSED list. `text/plain` is the honest answer for a document
 * that opens with `<not-a-tag>`, and calling it HTML would hand it to
 * Readability, which would return an empty article and fail the whole fetch.
 */
const HTML_SNIFF_RE =
  /^(?:<!doctype\s+html|<!--|<html[\s>]|<head[\s>]|<body[\s>]|<meta[\s/>]|<title[\s>]|<script[\s>]|<style[\s>]|<link[\s/>]|<div[\s>]|<span[\s>]|<p[\s>]|<h[1-6][\s>]|<br[\s/>]|<table[\s>]|<a[\s>]|<ul[\s>]|<ol[\s>]|<article[\s>]|<section[\s>]|<main[\s>]|<nav[\s>]|<header[\s>]|<footer[\s>]|<iframe[\s>]|<frameset[\s>]|<font[\s>])/i;

/**
 * What the leading bytes SAY they are, for a response that declared nothing.
 *
 * DW-441: both fetch doors guarded with `if (mimeType && ...)`, so a response
 * that omitted `Content-Type` skipped the allowlist entirely and whatever
 * arrived was ingested unchecked. This is the substitute evidence — and it is
 * only ever EVIDENCE: the caller's `allowedContentTypes` still decides what the
 * door takes, exactly as it does for a declared type.
 *
 * CONSERVATIVE BY CONSTRUCTION. `null` is "I cannot tell", and every door
 * treats `null` as a refusal, so anything this function is unsure about is
 * refused rather than defaulted to `text/html`. A single NUL or non-whitespace
 * C0 control byte inside the window is taken as binary and ends the sniff —
 * that is what keeps a PNG, an ELF binary or a tarball out of the HTML parser.
 */
export function sniffContentType(prefix: Uint8Array): string | null {
  if (prefix.byteLength === 0) return null;
  const window = prefix.subarray(0, SNIFF_WINDOW_BYTES);

  // `%PDF-` magic, at offset 0 only — the same anchor the spec gives it.
  const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d];
  if (
    window.byteLength >= PDF_MAGIC.length &&
    PDF_MAGIC.every((byte, i) => window[i] === byte)
  ) {
    return "application/pdf";
  }

  for (const byte of window) {
    // TAB, LF, FF and CR are text; every other C0 control (NUL included) is not.
    if (byte === 0x09 || byte === 0x0a || byte === 0x0c || byte === 0x0d) continue;
    if (byte < 0x20) return null;
  }

  // Non-fatal: a 512-byte cut can land mid-codepoint, and one replacement char
  // at the tail must not turn a readable document into a refusal.
  const text = new TextDecoder("utf-8").decode(window).trimStart();
  if (!text) return null;
  if (/^<\?xml[\s?]/i.test(text)) {
    // An XML DECLARATION is how XHTML opens too, and answering `application/xml`
    // for all of them refuses a page type the doors explicitly allow: Workbench
    // Intake takes `application/xhtml+xml` and does NOT take `application/xml`.
    // So the declaration alone is not the verdict — a doctype or an `<html` tag
    // inside the same window is what separates a page from a data document.
    return /<!doctype\s+html|<html[\s>]/i.test(text)
      ? "application/xhtml+xml"
      : "application/xml";
  }
  if (HTML_SNIFF_RE.test(text)) return "text/html";
  return "text/plain";
}

/** The sniff window over a buffer that has already been read in full. */
function sniffWindowOf(buffer: ArrayBuffer): Uint8Array {
  return new Uint8Array(buffer, 0, Math.min(SNIFF_WINDOW_BYTES, buffer.byteLength));
}

/**
 * Read a whole body as BYTES, enforcing `capBytes` INCREMENTALLY.
 *
 * `response.arrayBuffer()` is unbounded DURING the read: its size check can
 * only run once everything is already in memory, and the declared
 * `Content-Length` pre-check does not fire on precisely the population these
 * byte reads serve — servers with missing or spoofed length headers. The text
 * path has always cancelled mid-stream for that reason; this is the same
 * protection for the paths that need the bytes rather than the text.
 *
 * `arrayBuffer()` remains the fallback for a response with no readable stream
 * (test fixtures, and some runtimes), which is the only case that still buffers
 * before it checks.
 */
async function readCappedBytes(
  response: Response,
  capBytes: number,
  tooLarge: (bytes: number) => Error,
): Promise<ArrayBuffer> {
  const declared = Number(response.headers.get("Content-Length") ?? 0);
  if (declared > capBytes) throw tooLarge(declared);

  const reader = response.body?.getReader();
  if (!reader) {
    const buffer = await response.arrayBuffer();
    if (buffer.byteLength > capBytes) throw tooLarge(buffer.byteLength);
    return buffer;
  }

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > capBytes) {
      await reader.cancel();
      throw tooLarge(total);
    }
    chunks.push(value);
  }

  const joined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined.buffer;
}

/** The PDF doors' own size sentence, which names the format deliberately. */
function pdfTooLarge(bytes: number): Error {
  return new ClientInputError(
    `PDF too large (${(bytes / 1024 / 1024).toFixed(1)} MB). Maximum: ${MAX_PDF_SIZE / 1024 / 1024} MB.`,
  );
}

async function readPdfBuffer(response: Response): Promise<ArrayBuffer> {
  return readCappedBytes(response, MAX_PDF_SIZE, pdfTooLarge);
}

/**
 * The bytes of a HEADERLESS body, read before anything knows what they are.
 *
 * Capped at `MAX_PDF_SIZE` rather than `MAX_RESPONSE_SIZE` because the type is
 * still unknown: capping at the text limit first would refuse a headerless PDF
 * that a header-declared one is allowed to be. Once the sniff says it is not a
 * PDF, {@link decodeCappedText} applies the text cap it should have been under.
 *
 * TYPE-NEUTRAL WORDING, unlike `readPdfBuffer`'s: `intakeUrl` relays this
 * sentence verbatim to whoever pasted the URL, and telling an owner their HTML
 * page is too large a PDF describes a document nobody supplied.
 */
async function readSniffBuffer(response: Response): Promise<ArrayBuffer> {
  return readCappedBytes(
    response,
    MAX_PDF_SIZE,
    (bytes) =>
      new ClientInputError(
        `Content too large (${(bytes / 1024 / 1024).toFixed(1)} MB, max ${MAX_PDF_SIZE / 1024 / 1024} MB).`,
      ),
  );
}

/**
 * Decode a body that was already read in full, under the ordinary text cap.
 *
 * DECODED LENGTH, not byte length. `readTextBody` has always compared the
 * decoded string's `.length`, and comparing bytes here would measure a
 * different thing: a CJK or emoji document runs roughly three bytes per UTF-16
 * code unit, so the same page would be accepted when the origin declares a type
 * and refused when it does not. The byte-level bound is already applied by
 * {@link readSniffBuffer}, so decoding first is itself bounded.
 */
function decodeCappedText(buffer: ArrayBuffer): string {
  const text = new TextDecoder().decode(buffer);
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(`Content too large (max ${MAX_RESPONSE_SIZE})`);
  }
  return text;
}

/** Read a response body as text, enforcing MAX_RESPONSE_SIZE as it streams. */
async function readTextBody(response: Response): Promise<string> {
  // Check Content-Length header before reading body (early rejection)
  const contentLength = response.headers.get("content-length");
  if (contentLength && parseInt(contentLength, 10) > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Content too large: ${contentLength} bytes (max ${MAX_RESPONSE_SIZE})`,
    );
  }

  // Stream the body and enforce size limit incrementally to prevent
  // unbounded memory consumption from servers with missing/spoofed
  // Content-Length headers.
  const reader = response.body?.getReader();
  if (reader) {
    const decoder = new TextDecoder();
    let accumulated = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      accumulated += decoder.decode(value, { stream: true });
      if (accumulated.length > MAX_RESPONSE_SIZE) {
        await reader.cancel();
        throw new Error(
          `Content too large (max ${MAX_RESPONSE_SIZE})`,
        );
      }
    }
    // Flush any remaining bytes in the decoder
    accumulated += decoder.decode();
    return accumulated;
  }
  // Fallback: no streaming body available (e.g. in some test environments)
  const text = await response.text();
  if (text.length > MAX_RESPONSE_SIZE) {
    throw new Error(
      `Content too large (max ${MAX_RESPONSE_SIZE})`,
    );
  }
  return text;
}

function pdfNameFromUrl(url: string): { filename: string; title: string } {
  const leaf = new URL(url).pathname.split("/").pop() || "document.pdf";
  const filename = /\.pdf$/i.test(leaf) ? leaf : `${leaf || "document"}.pdf`;
  const title = filename.replace(/\.pdf$/i, "") || "PDF Document";
  return { filename, title };
}

/**
 * Fetch a PDF as raw bytes. Does not parse.
 *
 * The vault `{ pdfUrl }` door and leftover `source:pdf` queue tasks need the
 * bytes so they can store-then-extract. Worker `unpdf` is not this path.
 *
 * A HEADERLESS response is sniffed rather than waved through (DW-441): the
 * guard below used to start `mimeType &&`, so a server that declared nothing
 * had its bytes returned as a PDF whatever they were. ON THAT PATH the `.pdf`
 * leaf of the URL does not stand in for the evidence — a filename is what the
 * caller asked for, not what arrived.
 *
 * It is NOT a claim about the whole door. The `application/octet-stream`
 * branch below still accepts the leaf as its only evidence, with no byte check
 * at all: a server that declares the generic binary type for a `.pdf` URL is
 * taken at its word. That predates this change and is left exactly as it was.
 */
export async function fetchPdfBytes(
  url: string,
): Promise<{ bytes: ArrayBuffer; filename: string; title: string }> {
  const { response, finalUrl } = await fetchFollowingRedirects(url);
  const mimeType = responseMimeType(response);
  const names = pdfNameFromUrl(finalUrl);
  const looksPdf = /\.pdf$/i.test(names.filename);
  if (!mimeType) {
    const bytes = await readPdfBuffer(response);
    const sniffed = sniffContentType(sniffWindowOf(bytes));
    if (sniffed !== "application/pdf") {
      throw new ClientInputError(
        `Unsupported content type: ${sniffed ?? "unknown"}. Only PDF is accepted at this door.`,
      );
    }
    return { bytes, ...names };
  }
  if (
    mimeType !== "application/pdf" &&
    !(mimeType === "application/octet-stream" && looksPdf)
  ) {
    throw new ClientInputError(
      `Unsupported content type: ${mimeType}. Only PDF is accepted at this door.`,
    );
  }
  return { bytes: await readPdfBuffer(response), ...names };
}

/**
 * Fetch a URL and extract its text content and title.
 *
 * Uses @mozilla/readability + linkedom for robust HTML-to-text extraction.
 * Falls back to regex-based `stripHtml()` when Readability can't parse the page.
 * Applies a 15-second timeout and a 5 MB response size limit for safety.
 *
 * For `text/plain` and `text/markdown` responses the raw text is returned
 * directly (no HTML parsing).
 */
export async function fetchUrlContent(
  url: string,
  options?: FetchUrlOptions,
): Promise<{ title: string; content: string }> {
  const allowedContentTypes = options?.allowedContentTypes ?? ALLOWED_CONTENT_TYPES;

  const { response } = await fetchFollowingRedirects(url);

  // ---------- Content-Type validation ----------
  // Reassignable, and deliberately ONE variable: the PDF branch, the
  // plain-text/markdown branch and the image-salvage guard all re-read this,
  // and a sniffed type has to steer all three exactly as a declared one does.
  let mimeType = responseMimeType(response);

  // The body, when the headerless path had to read it to find out what it is.
  // Read ONCE and reused below — the PDF branch takes the buffer and the text
  // branch decodes it, because the stream is consumed either way.
  let sniffedBuffer: ArrayBuffer | null = null;

  if (mimeType) {
    if (!allowedContentTypes.includes(mimeType)) {
      // A ClientInputError, not a bare Error: the response arrived and was
      // understood — the CALLER's door does not take this type — so the route
      // above answers 400 with this sentence rather than logging a 500.
      throw new ClientInputError(
        `Unsupported content type: ${mimeType}. Only HTML and text content can be ingested.`,
      );
    }
  } else {
    // DW-441: no `Content-Type` at all. The guard used to read
    // `mimeType && !allowed.includes(mimeType)`, so this response skipped the
    // allowlist entirely and whatever arrived was ingested unchecked. Sniff the
    // leading bytes instead and put the ANSWER through the caller's own door —
    // a declared type is never second-guessed, but an absent one is not a pass.
    //
    // Read through `readSniffBuffer` (MAX_PDF_SIZE, enforced incrementally)
    // rather than MAX_RESPONSE_SIZE because the type is not known yet: capping
    // at the smaller limit first would refuse a headerless PDF that a
    // header-declared one is allowed to be. The MAX_RESPONSE_SIZE check still
    // applies below once the sniff says it is not a PDF.
    sniffedBuffer = await readSniffBuffer(response);
    mimeType = sniffContentType(sniffWindowOf(sniffedBuffer));
    if (!mimeType || !allowedContentTypes.includes(mimeType)) {
      throw new ClientInputError(
        `Unsupported content type: ${mimeType ?? "unknown"}. Only HTML and text content can be ingested.`,
      );
    }
  }

  // Generic URL ingest still parses PDF text here. The vault PDF door and
  // `source:pdf` tasks use {@link fetchPdfBytes} instead and never reach unpdf.
  if (mimeType === "application/pdf") {
    const buffer = sniffedBuffer ?? (await readPdfBuffer(response));
    return extractPdfText(
      buffer,
      new URL(url).pathname.split("/").pop()?.replace(/\.pdf$/i, "") ??
        "PDF Document",
      options?.maxContentLength === null
        ? null
        : (options?.maxContentLength ?? MAX_CONTENT_LENGTH),
    );
  }

  // The headerless path already consumed the stream to sniff it, so THAT same
  // buffer is decoded here — a second read of a used body would throw.
  const body = sniffedBuffer
    ? decodeCappedText(sniffedBuffer)
    : await readTextBody(response);

  let title: string;
  let content: string;

  // For plain-text and markdown responses, skip the HTML parsing path entirely
  if (mimeType === "text/plain" || mimeType === "text/markdown") {
    title = new URL(url).hostname;
    content = body.trim();
  } else {
    // HTML / XHTML / XML path — try Readability first for proper article extraction
    const article = extractWithReadability(body);
    if (article) {
      title = article.title || extractTitle(body) || new URL(url).hostname;
      // Convert Readability's sanitised HTML to markdown so we preserve
      // images, links, headings, and formatting from the source article.
      content = htmlToMarkdown(article.htmlContent);
    } else {
      // Fallback to regex-based stripping for non-article pages
      title = extractTitle(body) || new URL(url).hostname;
      content = stripHtml(body);
    }
  }

  if (!content) {
    throw new Error("No text content could be extracted from the URL");
  }

  const contentCap = options?.maxContentLength === null
    ? null
    : (options?.maxContentLength ?? MAX_CONTENT_LENGTH);
  if (contentCap !== null && content.length > contentCap) {
    content = content.slice(0, contentCap) + "\n\n[Content truncated]";
  }

  // Readability prunes figures that look decorative (lazy-loaded, empty alt, SVG
  // diagrams), so technical posts often lose their diagrams. Salvage image URLs
  // straight from the source DOM and reference any the extracted content is
  // missing, so the immutable RAW source snapshot still captures the article's
  // figures. (Ingest strips all images from the synthesized wiki page — see
  // `stripImageMarkdown` — so these never appear in the page body.) Appended
  // AFTER truncation so a long article never drops its figures. HTML path only.
  if (mimeType !== "text/plain" && mimeType !== "text/markdown") {
    const salvaged = extractImageUrls(body, url).filter(
      (u) => !content.includes(u),
    );
    if (salvaged.length > 0) {
      content += "\n\n" + salvaged.map((u) => `![](${u})`).join("\n\n");
    }
  }

  return { title, content };
}

// ---------------------------------------------------------------------------
// Image downloading
// ---------------------------------------------------------------------------

/** Regex matching markdown image references: ![alt](url) */
const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)]+)\)/g;

/**
 * Sanitise a URL-derived filename: strip query/hash, prevent path traversal,
 * and ensure it has a reasonable extension.
 */
function sanitizeImageFilename(rawUrl: string): string {
  let urlPath: string;
  try {
    urlPath = new URL(rawUrl).pathname;
  } catch (err) {
    // Not a valid URL — fallback to the raw string
    if (!(err instanceof TypeError)) {
      logger.warn("fetch", "unexpected error parsing URL:", err);
    }
    urlPath = rawUrl;
  }

  // Take only the last path segment
  let name = urlPath.split("/").pop() || "image";

  // Remove any query params or hash that slipped through
  name = name.split("?")[0].split("#")[0];

  // Replace path-traversal sequences and dangerous chars
  name = name.replace(/\.\./g, "_").replace(/[/\\:*?"<>|]/g, "_");

  // If the name is empty or only whitespace after sanitisation, use a default
  if (!name.trim()) {
    name = "image";
  }

  // Ensure a reasonable extension if missing
  const VALID_IMAGE_EXTS = new Set([
    ".jpg", ".jpeg", ".png", ".gif", ".webp", ".svg", ".bmp", ".ico", ".avif",
  ]);
  const ext = path.extname(name).toLowerCase();
  if (!VALID_IMAGE_EXTS.has(ext)) {
    name += ".jpg"; // default extension
  }

  return name;
}

/**
 * Download images referenced in markdown content and store them via
 * the storage provider. Rewrites image URLs in the markdown to point
 * to local paths.
 *
 * @param markdown - Markdown content with `![alt](url)` image references
 * @param slug - The source slug (used to namespace image files)
 * @param _rawDir - Unused (kept for API compatibility); assets are stored
 *                  via `rawRelPath("assets/<slug>/<filename>")`
 * @returns The markdown with rewritten image URLs
 */
export async function downloadImages(
  markdown: string,
  slug: string,
  _rawDir: string,
): Promise<string> {
  // Collect all absolute-URL image references
  const matches: Array<{ full: string; alt: string; url: string }> = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(MD_IMAGE_RE.source, MD_IMAGE_RE.flags);
  while ((m = re.exec(markdown)) !== null) {
    const url = m[2];
    // Skip data URIs and relative paths
    if (url.startsWith("data:")) continue;
    if (!url.startsWith("http://") && !url.startsWith("https://")) continue;
    matches.push({ full: m[0], alt: m[1], url });
  }

  if (matches.length === 0) return markdown;

  // Limit to MAX_IMAGES_PER_SOURCE to avoid abuse
  const toDownload = matches.slice(0, MAX_IMAGES_PER_SOURCE);

  const storage = getStorage();

  // Track used filenames for deduplication
  const usedNames = new Map<string, number>();

  // Build a replacement map: original markdown → rewritten markdown
  const replacements = new Map<string, string>();

  for (const { full, alt, url } of toDownload) {
    try {
      const resp = await fetch(url, {
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });

      if (!resp.ok) {
        logger.warn("downloadImages", `HTTP ${resp.status} for ${url}, keeping original`);
        continue;
      }

      // Check content-type is an image
      const contentType = resp.headers.get("content-type") || "";
      if (!contentType.startsWith("image/")) {
        logger.warn("downloadImages", `Non-image content-type "${contentType}" for ${url}, keeping original`);
        continue;
      }

      const arrayBuf = await resp.arrayBuffer();
      // Respect MAX_RESPONSE_SIZE
      if (arrayBuf.byteLength > MAX_RESPONSE_SIZE) {
        logger.warn("downloadImages", `Image too large (${arrayBuf.byteLength} bytes) for ${url}, keeping original`);
        continue;
      }

      // Determine local filename (deduplicate if needed)
      let filename = sanitizeImageFilename(url);
      const baseName = path.basename(filename, path.extname(filename));
      const ext = path.extname(filename);
      const count = usedNames.get(filename) ?? 0;
      if (count > 0) {
        filename = `${baseName}-${count}${ext}`;
      }
      usedNames.set(
        `${baseName}${ext}`,
        count + 1,
      );

      // Write via storage provider using relative path
      const storagePath = rawRelPath(`assets/${slug}/${filename}`);
      await storage.writeAsset(storagePath, arrayBuf);

      // Rewrite the markdown reference to the local path
      const localPath = `assets/${slug}/${filename}`;
      replacements.set(full, `![${alt}](${localPath})`);
    } catch (err) {
      logger.warn(
        "downloadImages",
        `Failed to download ${url}: ${err instanceof Error ? err.message : String(err)}`,
      );
      // Keep the original URL on failure
    }
  }

  // Apply replacements
  let result = markdown;
  for (const [original, replacement] of replacements) {
    result = result.replace(original, replacement);
  }

  return result;
}

/**
 * Fetch a single image by URL and store it as an asset under
 * `assets/<slug>/<filename>`. Used by the image-ingest flow.
 *
 * Unlike {@link downloadImages} (which degrades gracefully across many embedded
 * images), this **throws** on hard failures (unsafe URL, non-image, oversized,
 * fetch error) so the calling route can return a clear client error — the user
 * gave us a single URL and expects feedback if it's bad.
 *
 * @returns the local markdown ref, the raw bytes (for the vision model), the
 *          filename, and the content type.
 */
/**
 * Fetch an image by URL and validate it WITHOUT storing it yet (so the caller
 * can run vision and pick a slug before the asset path is fixed). Throws a
 * {@link ClientInputError} on unsafe/non-image/oversized input (→ 4xx).
 */
export async function fetchImageBytes(
  url: string,
): Promise<{ bytes: ArrayBuffer; filename: string; contentType: string }> {
  try {
    validateUrlSafety(url); // SSRF guard — throws on private/unsafe hosts
  } catch (err) {
    throw new ClientInputError(getErrorMessage(err));
  }

  const resp = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!resp.ok) {
    throw new ClientInputError(`Failed to fetch image: HTTP ${resp.status}`);
  }
  const contentType = resp.headers.get("content-type") || "";
  if (!contentType.startsWith("image/")) {
    throw new ClientInputError(
      `URL is not an image (content-type: ${contentType || "unknown"})`,
    );
  }
  const bytes = await resp.arrayBuffer();
  if (bytes.byteLength > MAX_RESPONSE_SIZE) {
    throw new ClientInputError(
      `Image too large (${bytes.byteLength} bytes, max ${MAX_RESPONSE_SIZE})`,
    );
  }
  return { bytes, filename: sanitizeImageFilename(url), contentType };
}

/**
 * Fetch an image by URL and store it as an asset.
 *
 * The returned `filename` is the name {@link storeImageBytes} ACTUALLY wrote —
 * the digest-prefixed one — not the name the fetch suggested. The two fields
 * have to compose: a caller rebuilding `assets/<slug>/<filename>` from this
 * return value must land on the key `localPath` names, and since DW-693 the
 * stored name carries a content digest the suggested name does not.
 */
export async function storeImageAsset(
  url: string,
  slug: string,
): Promise<{ localPath: string; bytes: ArrayBuffer; filename: string; contentType: string }> {
  const { bytes, filename: suggestedName, contentType } = await fetchImageBytes(url);
  const { localPath, filename } = await storeImageBytes(bytes, slug, suggestedName);
  return { localPath, bytes, filename, contentType };
}

/**
 * Store raw image bytes (e.g. an uploaded file) as an asset under
 * `assets/<slug>/<digest>-<filename>`. `suggestedName` may be a URL or a plain
 * filename; it's sanitized. Enforces {@link MAX_RESPONSE_SIZE}.
 *
 * CONTENT-ADDRESSED, and it has to be (DW-693). Callers mint `slug` BEFORE the
 * page slug is final — `ingestImage` derives it from `slugify(title)` because
 * the key has to be embedded in the body it hands to `ingest()`, and `ingest()`
 * is what uniquifies the slug (forking off another owner's private page). So
 * two uploads sharing a title and a sanitized filename would otherwise address
 * ONE key, and the second upload would silently replace the first page's image.
 * Folding a digest of the bytes into the filename makes that impossible:
 * different bytes can never share a key, identical bytes harmlessly share one.
 *
 * The door below is `writeAssetIfAbsent` — CREATE-ONLY (DW-572). The digest
 * made an overwrite harmless; the door makes it impossible, which is what FR-2
 * ("stored bytes are never mutated") actually asks for. An occupied key is a
 * plain success: it holds these exact bytes already, so the same
 * `{ localPath, filename }` is returned as on creation. A provider failure
 * throws and fails the upload rather than falling back to an overwrite.
 *
 * The digest goes in the FILENAME, never the directory. `/api/assets/[...path]`
 * reads the first segment as the page slug to gate private-page assets; a
 * digest there resolves to no page and every such image would be served
 * ungated. Keeping it ahead of the sanitized name also preserves the extension,
 * so `contentTypeFor` still answers correctly.
 */
export async function storeImageBytes(
  bytes: ArrayBuffer,
  slug: string,
  suggestedName: string,
): Promise<{ localPath: string; filename: string; created: boolean }> {
  if (bytes.byteLength > MAX_RESPONSE_SIZE) {
    throw new ClientInputError(
      `Image too large (${bytes.byteLength} bytes, max ${MAX_RESPONSE_SIZE})`,
    );
  }
  const digest = (await bytesSha256(bytes)).slice(0, IMAGE_DIGEST_PREFIX_LEN);
  const filename = `${digest}-${sanitizeImageFilename(suggestedName)}`;
  const localPath = assetRefPath(slug, filename);
  // `false` means the content-addressed key was already occupied by these same
  // bytes — a plain success, not an error. It is REPORTED rather than discarded
  // because it is the "this call created the key" fact (DW-738): only a creator
  // may delete the pre-fork key when `ingest()` re-keys a forked page's asset,
  // since an occupied key holds the OTHER page's identical bytes.
  const created = await getStorage().writeAssetIfAbsent(
    rawRelPath(localPath),
    bytes,
  );
  return { localPath, filename, created };
}

/**
 * The markdown ref for one stored image: `assets/<slug>/<filename>`.
 *
 * The one spelling the WRITE side shares — the store here, {@link
 * rekeyImageAsset} below, `ingest()`'s fork re-key and the `asset-slug-rekey`
 * migration's copy target all mint the ref through this, so a page's embedded
 * ref and the key behind it cannot drift apart. It is NOT the only place the
 * `assets/` literal appears in the repo, and claiming so would be false: the
 * READ side spells its own — `/api/assets/[...path]` rebuilds the path from URL
 * segments, and the migration's ref-scanning regex has to spell the prefix to
 * recognize it. Those parse; this one constructs.
 */
export function assetRefPath(slug: string, filename: string): string {
  return `assets/${slug}/${filename}`;
}

/**
 * Move one stored image from `assets/<fromSlug>/<filename>` to
 * `assets/<toSlug>/<filename>`, returning the NEW markdown ref.
 *
 * WHY THIS EXISTS (DW-738). `ingestImage` has to mint the asset key before the
 * page slug is final — the key goes into the body it hands `ingest()`, and
 * `ingest()` is what uniquifies the slug when the realm-fork guard forks off
 * another owner's private page. So a forked page's image was left sitting in
 * the OTHER page's asset directory, where `/api/assets/[...path]` gates it on
 * the wrong page's visibility and `syncSiloForPage` mirrors it into the wrong
 * tenant. Re-keying onto the final slug is what puts the bytes under the page
 * that owns them.
 *
 * Copy-then-delete, and the delete is OPTIONAL and caller-gated. Passing
 * `removeSource: false` leaves the source key alone, which is the required
 * behaviour whenever this ingest did not create it: `writeAssetIfAbsent`
 * answering `false` means the key already held byte-identical content belonging
 * to the other page, and removing it would be data loss. The delete is also
 * FAIL-SOFT — the bytes are already readable at the new key by then, so a
 * provider hiccup on the cleanup must not fail an otherwise-complete ingest;
 * the worst case is one orphaned copy under the old page's directory.
 *
 * PASS `bytes` WHENEVER THE CALLER STILL HOLDS THEM. The ingest path does, and
 * threading them through is not just one saved read — it closes a race. Two
 * concurrent ingests of byte-identical images under one title produce one
 * `created: true` and one `created: false`; if the creator forks, copies and
 * DELETES the source key first, the other ingest's read of that key throws, and
 * the ingest-side re-key has no try/catch by design, so a fully synthesized
 * ingest fails on a cleanup it never depended on. Supplying the buffer removes
 * the dependency entirely. The storage read stays as the fallback for a caller
 * that has only the key (the maintenance migration reads per ref itself).
 *
 * `writeAssetIfAbsent` at the destination, not `writeAsset`: the keys are
 * content-addressed, so an occupied destination already holds these exact bytes
 * (FR-2 — stored bytes are never mutated).
 */
export async function rekeyImageAsset(
  fromSlug: string,
  toSlug: string,
  filename: string,
  options?: { removeSource?: boolean; bytes?: ArrayBuffer },
): Promise<string> {
  const fromRef = assetRefPath(fromSlug, filename);
  const toRef = assetRefPath(toSlug, filename);
  if (fromRef === toRef) return toRef;

  const storage = getStorage();
  const bytes = options?.bytes ?? (await storage.readAsset(rawRelPath(fromRef)));
  await storage.writeAssetIfAbsent(rawRelPath(toRef), bytes);

  if (options?.removeSource) {
    try {
      await storage.deleteFile(rawRelPath(fromRef));
    } catch (err) {
      logger.warn(
        "fetch",
        `re-keyed ${fromRef} → ${toRef} but could not remove the source key`,
        err,
      );
    }
  }
  return toRef;
}
