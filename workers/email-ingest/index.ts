import PostalMime from "postal-mime";

interface KVNamespace {
  get(key: string, type: "json"): Promise<unknown>;
}

interface Fetcher {
  fetch(request: Request): Promise<Response>;
}

interface EmailIngestConfig {
  enabled?: boolean;
  inboundAddress?: string;
  allowedSenders?: string[];
}

interface ForwardableEmailMessage {
  readonly from: string;
  readonly to: string;
  readonly headers: Headers;
  readonly raw: ReadableStream<Uint8Array>;
  readonly rawSize: number;
  setReject(reason: string): void;
  reply(builder: {
    from: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

interface Env {
  YOPEDIA_CONFIG: KVNamespace;
  YOPEDIA: Fetcher;
  YOPEDIA_SERVICE_TOKEN?: string;
  YOPEDIA_SITE_URL?: string;
}

const CONFIG_KEY = "_idx:email-ingest-config";
/**
 * Duplicates `MAX_DOCUMENT_SIZE` in `src/lib/constants.ts` — the per-document
 * ceiling `/api/email/ingest` enforces on every staged attachment. The
 * duplication is forced: this module is bundled for Cloudflare and cannot import
 * from `src/lib`. Pinned against the original by
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
 */
export const MAX_EMAIL_DOCUMENT_BYTES = 10 * 1024 * 1024;
/**
 * The figure quoted back to a sender whose attachment was too big. Written the
 * same way `/api/email/ingest` writes it (`MAX_DOCUMENT_SIZE / 1024 / 1024`), so
 * the two sides of the same ceiling cannot quote different numbers.
 */
const MAX_EMAIL_DOCUMENT_MB = MAX_EMAIL_DOCUMENT_BYTES / 1024 / 1024;
/**
 * Supported attachments forwarded from one email. Must equal the route's
 * `MAX_EMAIL_DOCUMENTS`, which rejects anything above it with a 400 — pinned by
 * the parity test, since this module cannot import the constant.
 */
export const MAX_EMAIL_ATTACHMENTS = 10;
/**
 * The per-document average the aggregate budget is STATED at.
 *
 * This module's reading of DW-362's worked example, not a figure quoted from the
 * decision. The recorded decision names no size at all — it asks only for "a
 * stated aggregate budget (up to `MAX_EMAIL_ATTACHMENTS` documents, or an
 * explicit total)" — and the ledger's example is ten 2 MB documents, decimal.
 * 2 MiB is chosen here as the nearest binary figure to that example, so the
 * budget lands slightly above what the ledger described rather than below it.
 *
 * Stated rather than derived because the derived alternative —
 * `MAX_EMAIL_ATTACHMENTS * MAX_EMAIL_DOCUMENT_BYTES` — is 100 MiB decoded and
 * ~312 MB on the worst-case wire, a shape no mail transport carries and a direct
 * worsening of the buffered-decoded-bytes exposure recorded as DW-360/DW-456.
 */
export const AGGREGATE_DOCUMENT_AVERAGE_BYTES = 2 * 1024 * 1024;
/**
 * The DECODED attachment budget one message is sized for: `MAX_EMAIL_ATTACHMENTS`
 * documents at `AGGREGATE_DOCUMENT_AVERAGE_BYTES` each — 20,971,520 bytes
 * (20 MiB).
 *
 * It exists because the raw cap used to be derived from exactly ONE full-size
 * document while this Worker advertises, and forwards, up to
 * `MAX_EMAIL_ATTACHMENTS` of them, so several mid-size files respecting every
 * per-document and per-count limit were still refused wholesale at the door
 * (DW-362).
 *
 * What that WIDENS, stated as a band rather than as a fix. The over-cap
 * acknowledgement line further down needs more than `MAX_EMAIL_ATTACHMENTS`
 * supported parts to survive the gate, so it is reachable only for messages of
 * eleven or more attachments whose average stays under what the cap leaves each
 * one: ~1.82 MiB decoded on the worst-case wire (11 parts of
 * `AGGREGATE_DOCUMENT_AVERAGE_BYTES` reach 71,974,287 bytes and are still
 * refused), ~4.15 MiB under base64, and less again as the count rises. Wider
 * than the "small attachments" band it had before, not unbounded.
 *
 * Floored at `MAX_EMAIL_DOCUMENT_BYTES` with a `Math.max` — the same shape
 * `WORST_CASE_TRANSFER_ENCODING_FACTOR` uses — so both terms stay live and the
 * DW-104/DW-358 admission (ONE full-size document must fit under either
 * encoding) is computed rather than assumed. Lowering the average or the
 * attachment count can therefore never push the budget below a single document.
 * Pinned by `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
 *
 * This is the cap's DERIVATION only. Nothing enforces the aggregate after
 * decoding: the per-document ceiling and the attachment count are still the only
 * post-decode gates, and bounding buffered decoded bytes is DW-360/DW-456's
 * subject, not this constant's.
 */
export const MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES = Math.max(
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES,
);
/**
 * Base64 writes 4 characters for every 3 bytes, and RFC 2045 wraps the result at
 * 76 characters with a CRLF after each line — 78 wire bytes per 76 characters of
 * payload. `message.rawSize` is the on-the-wire RFC 822 byte count, measured
 * before anything is decoded, so a bare 4/3 factor is not enough: it bounces a
 * full-size document by ~2.6%.
 */
export const BASE64_EXPANSION_FACTOR = (4 / 3) * (78 / 76);
/**
 * The other encoding a sending client may pick — and the worse one. RFC 2045
 * §6.7 lets any octet be written as `=XX`, 3 characters for 1 byte, and mail
 * clients escape essentially every octet of a byte-dense `text/*` attachment or
 * a non-ASCII body. The 76-character line limit costs more here than it does for
 * base64 because an `=XX` escape may not be split across a line break: a line
 * holds at most 25 escapes (75 characters) before the `=` soft line break and
 * its CRLF, so 25 payload bytes reach the wire as 78.
 *
 * ASSUMES the sender fills its lines to that 76-character maximum. This is the
 * worst case among encoders that do; it is NOT the worst case outright. A
 * conforming encoder may wrap narrower, and narrower costs more: `k` escapes on
 * a line is `3k + 3` wire bytes, so the per-byte ratio `(3k + 3) / k` RISES as
 * `k` falls — 3.12 at k=25, 3.125 at k=24 (a 72-column wrap), 3.1304 at k=23.
 *
 * The residual, stated rather than left implicit. A maximally-escaped
 * `MAX_EMAIL_DOCUMENT_BYTES` document reaches 32,715,573 bytes at k=25 and
 * 32,768,001 at k=24, both far under the 65,496,679-byte
 * `MAX_RAW_EMAIL_BYTES` the aggregate budget now yields — and so is every
 * narrower wrap, down to k=1 at 62,914,560 bytes. Since `(3k + 3) / k` only
 * rises as `k` falls, ONE full-size document is admissible at every conforming
 * wrap; the k=23 limit this comment used to record was a property of the old
 * single-document derivation and no longer exists (DW-362).
 *
 * The bounded limit MOVED rather than disappeared, and it now lives at the
 * aggregate the cap is sized for: `MAX_EMAIL_ATTACHMENTS` parts of
 * `AGGREGATE_DOCUMENT_AVERAGE_BYTES` reach 65,431,170 bytes at k=25 and fit, but
 * 65,536,020 at k=24 (a 72-column wrap) and do not. So a sender who fills a
 * message to the full aggregate AND wraps narrower than the 76-character maximum
 * is still refused at the door. That is a bounded, known limit, not an oversight
 * — widening for it would cost headroom against a shape no mainstream client
 * emits. Pinned at both widths by
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
 */
export const QUOTED_PRINTABLE_EXPANSION_FACTOR = 3 * (78 / 75);
/**
 * The sender's client chooses the transfer encoding, not this Worker, so the
 * pre-decode cap has to survive the worst of the encodings it may choose.
 *
 * Written as a `Math.max` over the named factors rather than as a swap to the
 * larger one: both terms stay live and readable at the constant, "worst case" is
 * computed rather than merely asserted in a comment, and the cap keeps tracking
 * whichever factor is worse if either is ever corrected. Pinned against the two
 * encodings by `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
 */
export const WORST_CASE_TRANSFER_ENCODING_FACTOR = Math.max(
  BASE64_EXPANSION_FACTOR,
  QUOTED_PRINTABLE_EXPANSION_FACTOR,
);
/**
 * Headroom for everything that is not the encoded attachment bodies: per-part
 * headers and boundary markers for up to `MAX_EMAIL_ATTACHMENTS` parts, the
 * per-part remainder `WORST_CASE_TRANSFER_ENCODING_FACTOR` under-counts (each
 * part pays its own short final line, so ten 2 MiB parts cost 65,431,170 bytes
 * against one 20 MiB part's 65,431,143), and an ordinary text body.
 *
 * It is not enough for a maximal body — a message at the full
 * `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` leaves 65,509 bytes here, under
 * `MAX_EMAIL_CONTENT_CHARS` — and is not meant to be: the pair only has to be
 * simultaneously satisfiable for realistic mail, not at both extremes at once.
 * Pinned as a trade-off by `src/lib/__tests__/email-ingest-worker.test.ts`.
 */
export const MIME_ENVELOPE_HEADROOM_BYTES = 64 * 1024;
/**
 * The pre-decode ceiling, derived rather than restated: a message carrying the
 * whole `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` budget has to fit under it once
 * transfer encoding, the RFC 2045 line wrap and the MIME envelope are paid for —
 * otherwise the route's own gates are unreachable over email and a message every
 * per-document and per-count limit admits is refused at the door.
 *
 * Sized for the AGGREGATE, not for one document (DW-362). This Worker advertises
 * and forwards up to `MAX_EMAIL_ATTACHMENTS` attachments, so a cap derived from
 * a single `MAX_EMAIL_DOCUMENT_BYTES` document put its own advertised maximum
 * out of reach: ten 2 MiB files bounced wholesale at ~65 MB on the wire.
 *
 * That ~65 MB is the residual, and it is the reason this change is not already
 * covered by DW-358. The ledger's worked example was measured in BASE64 (~27 MB
 * for ten 2 MB files) and has fitted since DW-358 widened the cap to 32,781,108
 * bytes — DW-458 records that premise as stale. What still failed, and what this
 * derivation fixes, is the same aggregate under the WORST-CASE encoding the cap
 * is derived from: quoted-printable puts those ten parts at 65,431,170 bytes,
 * twice the old cap. See `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` for the band the
 * over-cap acknowledgement line is reachable in as a result.
 *
 * Derived from the WORST transfer encoding a client may pick, not from base64
 * alone (DW-358). `message.rawSize` is counted before anything is decoded, and
 * clients routinely send `text/*` attachments and non-ASCII bodies as
 * quoted-printable — ~3.12x on byte-dense content against base64's ~1.37x. A
 * base64-only derivation therefore still bounced a `.csv` or `.txt` well under
 * the advertised 10 MB per-document ceiling: the same defect DW-104 fixed for
 * base64, left unfixed for the other encoding.
 *
 * The factor is a per-byte RATIO, not the exact per-message arithmetic, and it
 * under-counts: at `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` it yields 65,431,143
 * against an exact worst-case wire size of 65,431,170 for ten separate parts,
 * because every part's final short line pays for a soft break and a CRLF that no
 * ratio can express. `MIME_ENVELOPE_HEADROOM_BYTES` absorbs that difference
 * along with everything else, which is why the cap is derived from the ratio and
 * not from the exact formula: the exact one lives in the test helper, where it
 * can be calibrated against a real fixture.
 *
 * That lands the cap at 65,496,679 bytes (~62.46 MiB), quoted to senders as
 * 62.4 MB. Far above the "about 13.4 MB" recorded in the 2026-08-19 decision —
 * which was a bare `MAX_DOCUMENT_SIZE * 4 / 3`, the arithmetic of one encoding
 * rather than its intent — and above the 32,781,108-byte single-document figure
 * DW-358 left behind. Only this cap moves: the per-document ceiling, the
 * attachment count, the body cap and the `message.rawSize` gate itself are
 * unchanged, and nothing new is enforced after decoding.
 */
export const MAX_RAW_EMAIL_BYTES =
  Math.ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
  MIME_ENVELOPE_HEADROOM_BYTES;
/**
 * Rounded DOWN to the displayed precision, so the figure quoted back to the
 * sender is never larger than the limit actually enforced.
 */
const MAX_RAW_EMAIL_MB = (
  Math.floor((MAX_RAW_EMAIL_BYTES / 1024 / 1024) * 10) / 10
).toFixed(1);
/**
 * Duplicates `MAX_EMAIL_CONTENT_CHARS` in `src/lib/email-ingest.ts`, which 400s
 * a longer body — truncating here to a different number would either lose text
 * the route would have accepted or post a body it rejects wholesale. Pinned by
 * the parity test, since this module cannot import the constant.
 */
export const MAX_EMAIL_CONTENT_CHARS = 100_000;
/**
 * Duplicates `MAX_EMAIL_ATTACHMENTS_RECORDED` in `src/lib/email-ingest.ts`,
 * which truncates the recorded name list to the same number in
 * `sanitizeAttachmentNames`. Pinned by the parity test.
 */
export const MAX_EMAIL_ATTACHMENT_NAMES_RECORDED = 20;
const TRUNCATION_MARKER = "\n\n[Email body truncated]";
/**
 * Duplicates the app extractor's allowlist (`SUPPORTED_DOCUMENT_EXTENSIONS` and
 * `SUPPORTED_DOCUMENT_MIME_TYPES` in `src/lib/document-extract.ts`). The
 * duplication is forced: this module is bundled for Cloudflare and cannot import
 * from `src/lib`. Both sets are exported so
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` can pin them against
 * the extractor's own lists — a format added on either side fails that test
 * until it is added on the other.
 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "md",
  "markdown",
  "txt",
  "html",
  "htm",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "zip",
  "odt",
  "ods",
  "odp",
  "epub",
  "org",
  "rtf",
  "mobi",
]);
export const SUPPORTED_MIME_TYPES: ReadonlySet<string> = new Set([
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "text/csv",
  "application/csv",
  "text/markdown",
  "text/x-markdown",
  "text/plain",
  "text/html",
  "application/xhtml+xml",
  "application/pdf",
  "application/zip",
  "application/x-zip-compressed",
  "application/vnd.oasis.opendocument.text",
  "application/vnd.oasis.opendocument.spreadsheet",
  "application/vnd.oasis.opendocument.presentation",
  "application/epub+zip",
  "text/org",
  "application/rtf",
  "text/rtf",
  "application/x-mobipocket-ebook",
]);

export function supportedAttachment(filename: string | null, mimeType: string): boolean {
  // `.trim()` mirrors `extension()` in `src/lib/document-extract.ts`. Without it
  // a folded or quoted `filename` parameter that arrives as `"report.pdf "` is
  // rejected here and accepted there — an allowlist divergence one surface below
  // where a set-equality comparison can see it.
  const ext = filename?.trim().toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
  if (SUPPORTED_EXTENSIONS.has(ext)) return true;
  // `Content-Type: text/csv; charset=utf-8` is one of ours; matching the whole
  // header value rejected it. The app extractor strips parameters the same way.
  const mime = mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return mime.length > 0 && SUPPORTED_MIME_TYPES.has(mime);
}

/**
 * One attachment's name, safe to interpolate into a reply the sender reads.
 *
 * Scrubbed the way `sanitizeAttachmentNames` in `src/lib/email-ingest.ts`
 * scrubs the names it records — collapse CR/LF/TAB, trim, cap at 200 — because
 * a MIME `filename` parameter is attacker-controlled text and this string lands
 * in an outbound email body. An unscrubbed CR/LF would forge extra lines in the
 * acknowledgement. Never returns empty: a nameless part still has to be
 * countable in a sentence that lists what was dropped.
 */
function replyAttachmentName(filename: string | null): string {
  return (
    (filename || "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 200) ||
    "unnamed attachment"
  );
}

/**
 * Decode one parsed attachment's payload into a standalone byte copy.
 *
 * The copy is not incidental: a view handed straight to `Blob` may be backed by
 * a SharedArrayBuffer, which is not a valid BlobPart. Copying also makes the
 * result safe to hold across the size filter and reuse in the forwarding loop.
 */
function attachmentBytes(content: ArrayBuffer | Uint8Array | string): Uint8Array<ArrayBuffer> {
  const source =
    typeof content === "string"
      ? new TextEncoder().encode(content)
      : content instanceof ArrayBuffer
        ? new Uint8Array(content)
        : new Uint8Array(content.buffer, content.byteOffset, content.byteLength);
  const bytes = new Uint8Array(new ArrayBuffer(source.byteLength));
  bytes.set(source);
  return bytes;
}

function normalizeAddress(value: string): string {
  return value.trim().toLowerCase();
}

function htmlToText(html: string): string {
  return html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<\s*br\s*\/?\s*>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|h[1-6])\s*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function reply(
  message: ForwardableEmailMessage,
  subject: string,
  text: string,
): Promise<void> {
  try {
    await message.reply({
      from: message.to,
      subject: `Re: ${subject}`,
      text,
    });
  } catch (error) {
    console.error("email-ingest: reply failed", error);
  }
}

function safeError(value: unknown): string {
  if (!value || typeof value !== "object") return "work-wiki could not accept this email.";
  const error = (value as Record<string, unknown>).error;
  return typeof error === "string" && error.trim()
    ? error.replace(/[\r\n]+/g, " ").slice(0, 300)
    : "work-wiki could not accept this email.";
}

export default {
  async email(message: ForwardableEmailMessage, env: Env): Promise<void> {
    const config = (await env.YOPEDIA_CONFIG.get(CONFIG_KEY, "json")) as
      | EmailIngestConfig
      | null;
    if (!config?.enabled) {
      message.setReject("Email ingestion is not enabled for this work-wiki.");
      return;
    }

    const from = normalizeAddress(message.from);
    const to = normalizeAddress(message.to);
    const allowed = Array.isArray(config.allowedSenders)
      ? config.allowedSenders.map(normalizeAddress)
      : [];
    if (!allowed.includes(from)) {
      message.setReject("This sender is not approved for work-wiki ingestion.");
      return;
    }
    if (config.inboundAddress && normalizeAddress(config.inboundAddress) !== to) {
      message.setReject("This address is not configured for work-wiki ingestion.");
      return;
    }

    const headerSubject =
      message.headers.get("subject")?.replace(/[\r\n]+/g, " ").trim() ||
      "Emailed note";
    if (message.rawSize > MAX_RAW_EMAIL_BYTES) {
      await reply(
        message,
        headerSubject,
        `work-wiki did not process this message because it is larger than ${MAX_RAW_EMAIL_MB} MB.`,
      );
      return;
    }

    const serviceToken = env.YOPEDIA_SERVICE_TOKEN;
    if (!serviceToken) {
      console.error("email-ingest: YOPEDIA_SERVICE_TOKEN is missing");
      await reply(
        message,
        headerSubject,
        "work-wiki could not queue this email because the ingest service is not configured.",
      );
      return;
    }

    let parsed: Awaited<ReturnType<typeof PostalMime.parse>>;
    try {
      parsed = await PostalMime.parse(message.raw);
    } catch (error) {
      console.error("email-ingest: MIME parse failed", error);
      await reply(
        message,
        headerSubject,
        "work-wiki could not read this email. Send a new message with a plain-text or HTML body.",
      );
      return;
    }

    const subject =
      parsed.subject?.replace(/[\r\n]+/g, " ").trim() || headerSubject;
    const messageId =
      parsed.messageId?.trim() || message.headers.get("message-id")?.trim() || "";
    const rawContent = parsed.text?.trim() || htmlToText(parsed.html || "");
    if (!messageId) {
      await reply(
        message,
        subject,
        "work-wiki could not process this message because it has no Message-ID. Please resend it from a standard email client.",
      );
      return;
    }
    // Every loss is counted from `parsed.attachments`, never from the
    // 20-capped `attachmentNames` list: the old
    // `attachmentNames.length - supportedAttachments.length` subtraction called a
    // cap-truncated *supported* file "unsupported", and understated the loss
    // entirely once a sender attached more than 20 files (DW-247).
    //
    // Bytes are decoded ONCE, here, because that is the only way to know a
    // part's size: `attachment.content` is a string, an ArrayBuffer or a view,
    // and `mimeType`/`filename` say nothing about length. The same copies are
    // reused by the forwarding loop below, so nothing is decoded twice.
    //
    // Guarded, because the decode MOVED: the byte copy used to sit inside the
    // try/catch around the forward, so a degenerate `content` or a failed
    // allocation still produced the retry reply below. Out here an uncaught
    // throw would escape `email()` and the sender would hear nothing at all.
    type DecodedAttachment = {
      attachment: (typeof parsed.attachments)[number];
      bytes: Uint8Array<ArrayBuffer>;
    };
    let eligibleAttachments: DecodedAttachment[];
    try {
      eligibleAttachments = parsed.attachments
        .filter((attachment) => supportedAttachment(attachment.filename, attachment.mimeType))
        .map((attachment) => ({ attachment, bytes: attachmentBytes(attachment.content) }));
    } catch (error) {
      console.error("email-ingest: attachment decode failed", error);
      await reply(
        message,
        subject,
        "work-wiki could not queue this email. Please try again in a few minutes.",
      );
      return;
    }
    // The byte filter runs BEFORE the `MAX_EMAIL_ATTACHMENTS` slice, so an
    // oversized part never consumes a cap slot that a forwardable file could
    // have used (DW-253). Forwarding it would only buy a 400 from the route.
    const oversizedAttachments = eligibleAttachments.filter(
      ({ bytes }) => bytes.byteLength > MAX_EMAIL_DOCUMENT_BYTES,
    );
    const withinSizeAttachments = eligibleAttachments.filter(
      ({ bytes }) => bytes.byteLength <= MAX_EMAIL_DOCUMENT_BYTES,
    );
    const supportedAttachments = withinSizeAttachments.slice(0, MAX_EMAIL_ATTACHMENTS);
    const unsupportedCount = parsed.attachments.length - eligibleAttachments.length;
    const oversizedCount = oversizedAttachments.length;
    const overCapCount = withinSizeAttachments.length - supportedAttachments.length;
    const skippedAttachmentCount = unsupportedCount + oversizedCount + overCapCount;
    // Built once and used by both exits: the sender has to be told which file
    // was left behind whether or not anything else survived to be ingested.
    const oversizedLine = oversizedCount
      ? `${oversizedCount} attachment${oversizedCount === 1 ? " was" : "s were"} not queued because ${
          oversizedCount === 1 ? "it is" : "they are"
        } larger than ${MAX_EMAIL_DOCUMENT_MB} MB: ${oversizedAttachments
          .map(({ attachment }) => replyAttachmentName(attachment.filename))
          .join(", ")}.`
      : "";
    if (!rawContent && supportedAttachments.length === 0) {
      await reply(
        message,
        subject,
        [
          // Keyed on `unsupportedCount`, NOT on `parsed.attachments.length`: a
          // sender whose only attachment was a supported-but-oversized PDF has
          // not "sent no supported document attachment", and telling them so
          // two paragraphs above a sentence naming that same PDF is a
          // contradiction. When something really did fail the allowlist the
          // format list is still the useful answer, so it stays verbatim.
          unsupportedCount
            ? "work-wiki found no email text or supported document attachment. Supported attachments: Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, ZIP, ODT/ODS/ODP, EPUB, MOBI, Org, and RTF."
            : "work-wiki found no email text to ingest.",
          oversizedLine,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      return;
    }

    const content =
      rawContent.length > MAX_EMAIL_CONTENT_CHARS
        ? `${rawContent.slice(0, MAX_EMAIL_CONTENT_CHARS - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`
        : rawContent;
    const attachmentNames = parsed.attachments
      .map((attachment) => attachment.filename || "unnamed attachment")
      .slice(0, MAX_EMAIL_ATTACHMENT_NAMES_RECORDED);

    let response: Response;
    try {
      const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");
      if (!site) throw new Error("YOPEDIA_SITE_URL is missing");
      const form = new FormData();
      form.append("from", from);
      form.append("to", to);
      form.append("subject", subject);
      form.append("messageId", messageId);
      if (content) form.append("content", content);
      for (const name of attachmentNames) form.append("attachmentName", name);
      // The true total, so the route reports the real loss instead of
      // re-deriving it from the truncated name list.
      form.append("skippedAttachmentCount", String(skippedAttachmentCount));
      // `index` numbers by position among the FORWARDED attachments, not among
      // all parsed parts — an oversized or unsupported part that never reaches
      // this loop must not shift the `attachment-<n>` fallback of the ones that
      // do.
      for (const [index, { attachment, bytes }] of supportedAttachments.entries()) {
        const filename = attachment.filename || `attachment-${index + 1}`;
        form.append(
          "attachments",
          new Blob([bytes], { type: attachment.mimeType || "application/octet-stream" }),
          filename,
        );
      }
      response = await env.YOPEDIA.fetch(
        new Request(`${site}/api/email/ingest`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${serviceToken}`,
          },
          body: form,
        }),
      );
    } catch (error) {
      console.error("email-ingest: service binding request failed", error);
      await reply(
        message,
        subject,
        "work-wiki could not queue this email. Please try again in a few minutes.",
      );
      return;
    }

    const result = (await response.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!response.ok) {
      await reply(message, subject, safeError(result));
      return;
    }

    const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");
    const jobId = typeof result?.jobId === "string" ? result.jobId : "";
    const slug = typeof result?.slug === "string" ? result.slug : "";
    const lines = [
      slug ? "work-wiki has already processed this email." : "work-wiki received your email and queued it for processing.",
      jobId ? `Job: ${jobId}` : "",
      // `/wiki/<slug>` is retired (404); the owner-scoped form via the default
      // tenant 308s to the page's real tenant. Inlined — workers cannot import
      // `src/lib`.
      slug && site ? `Page: ${site}/u/yopedia/${encodeURIComponent(slug)}` : "",
      !slug && site ? `Track it under Recent ingests: ${site}/ingest` : "",
      !slug ? "work-wiki will send a final receipt when processing succeeds or fails." : "",
      supportedAttachments.length
        ? `${supportedAttachments.length} supported attachment${supportedAttachments.length === 1 ? " was" : "s were"} queued for ingestion.`
        : "",
      oversizedLine,
      overCapCount
        ? `${overCapCount} supported attachment${overCapCount === 1 ? " was" : "s were"} not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`
        : "",
      unsupportedCount
        ? `${unsupportedCount} unsupported attachment${unsupportedCount === 1 ? " was" : "s were"} recorded but skipped.`
        : "",
    ].filter(Boolean);
    await reply(message, subject, lines.join("\n\n"));
  },

  async fetch(): Promise<Response> {
    return new Response("yopedia email-ingest ok\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
