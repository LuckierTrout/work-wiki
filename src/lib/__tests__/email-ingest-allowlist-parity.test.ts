import { describe, expect, it } from "vitest";
import {
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_MIME_TYPES,
  detectDocumentFormat,
  isSupportedDocument,
} from "../document-extract";
import { MAX_DOCUMENT_SIZE } from "../constants";
import {
  MAX_EMAIL_ATTACHMENTS_RECORDED,
  MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENTS,
} from "../email-ingest";
import {
  BASE64_EXPANSION_FACTOR,
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
  MAX_EMAIL_CONTENT_CHARS as WORKER_MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_RAW_EMAIL_BYTES,
  MIME_ENVELOPE_HEADROOM_BYTES,
  QUOTED_PRINTABLE_EXPANSION_FACTOR,
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  WORST_CASE_TRANSFER_ENCODING_FACTOR,
  supportedAttachment,
} from "../../../workers/email-ingest/index";
import { base64PartWireSize, quotedPrintablePartWireSize } from "./email-ingest-wire";

/**
 * The email door and the app extractor keep two copies of the same allowlist.
 * That duplication is forced, not accidental: `workers/email-ingest/index.ts` is
 * bundled for Cloudflare and cannot import from `src/lib`, so nothing in the
 * source can express the invariant. This test is the pin.
 *
 * Without it the two drifted for real — `odt`, `ods`, `odp`, `epub`, `org`,
 * `rtf`, `mobi` and `text/x-markdown` were readable by the app but bounced at
 * the email door, and the Worker matched the whole `mimeType`, so a perfectly
 * ordinary `text/csv; charset=utf-8` part was rejected where an upload of the
 * same file was accepted. Both sides look self-consistent on their own; only a
 * comparison catches it.
 *
 * The extractor side is a *derived* list (`DOCUMENT_FORMATS` + alias keys,
 * `MIME_FORMATS` keys), never a literal restated here — a literal would have to
 * be edited alongside a new format and would therefore never fail.
 */

const sorted = (values: Iterable<string>) => [...values].sort();

describe("email-ingest allowlist parity", () => {
  it("accepts exactly the extensions the app extractor accepts", () => {
    expect(sorted(SUPPORTED_EXTENSIONS)).toEqual(
      sorted(SUPPORTED_DOCUMENT_EXTENSIONS),
    );
  });

  it("accepts exactly the MIME types the app extractor accepts", () => {
    expect(sorted(SUPPORTED_MIME_TYPES)).toEqual(
      sorted(SUPPORTED_DOCUMENT_MIME_TYPES),
    );
  });

  it("agrees with isSupportedDocument on every allowed extension", () => {
    // Empty content type on purpose, so this exercises the extension arm alone
    // and a format is not rescued by a matching MIME type. Note the direction:
    // the loop walks the EXTRACTOR's list, so it catches an extension the app
    // accepts and the Worker does not. The reverse — a Worker-only extension —
    // is caught by the set-equality test above, not here.
    const disagreements = SUPPORTED_DOCUMENT_EXTENSIONS.filter(
      (ext) =>
        supportedAttachment(`document.${ext}`, "") !==
        isSupportedDocument(`document.${ext}`, ""),
    );
    expect(disagreements).toEqual([]);
    expect(supportedAttachment("document.odt", "")).toBe(true);
  });

  it("agrees with isSupportedDocument on every allowed MIME type", () => {
    // Extensionless filename on purpose, mirroring the reasoning above -- and
    // likewise one-directional, with set equality covering the other direction.
    const disagreements = SUPPORTED_DOCUMENT_MIME_TYPES.filter(
      (mime) =>
        supportedAttachment("attachment", mime) !==
        isSupportedDocument("attachment", mime),
    );
    expect(disagreements).toEqual([]);
    expect(
      supportedAttachment("attachment", "application/vnd.oasis.opendocument.text"),
    ).toBe(true);
  });

  it("strips MIME parameters on both sides before matching", () => {
    // `.data` is not an allowed extension, so only the parameterised MIME type
    // can carry this one through.
    expect(supportedAttachment("c.data", "text/csv; charset=utf-8")).toBe(true);
    expect(isSupportedDocument("c.data", "text/csv; charset=utf-8")).toBe(true);
    expect(supportedAttachment("c.data", "TEXT/CSV; charset=UTF-8")).toBe(true);
  });

  it("reads a padded filename the same way on both sides", () => {
    // A folded or quoted `filename` parameter can arrive with surrounding
    // whitespace. The extractor trims before taking the extension; the Worker
    // did not, so `"report.pdf "` was accepted by the app and bounced at the
    // door -- a divergence the set comparison above cannot see, because both
    // lists still held `pdf`.
    for (const filename of ["report.pdf ", " report.pdf", "\treport.pdf\n"]) {
      expect(supportedAttachment(filename, "")).toBe(true);
      expect(isSupportedDocument(filename, "")).toBe(true);
    }
  });

  it("does not answer a prototype member as a supported format", () => {
    // The allowlists are plain object/Set lookups over attacker-controlled
    // filenames and content types. A bare `TABLE[key]` answers every
    // `Object.prototype` member with an inherited function -- truthy, and `??`
    // does not rescue it -- which made `weird.constructor` a "supported
    // document" and stopped `/api/ingest/document`'s 400 gate from firing.
    for (const key of ["constructor", "valueOf", "toString", "hasOwnProperty"]) {
      expect(detectDocumentFormat(`weird.${key.toLowerCase()}`, "")).toBeNull();
      expect(isSupportedDocument(`weird.${key.toLowerCase()}`, "")).toBe(false);
      expect(detectDocumentFormat("x", key.toLowerCase())).toBeNull();
      expect(isSupportedDocument("x", key.toLowerCase())).toBe(false);
      expect(supportedAttachment(`weird.${key.toLowerCase()}`, "")).toBe(false);
      expect(supportedAttachment("x", key.toLowerCase())).toBe(false);
    }
  });

  it("rejects the same unsupported attachment on both sides", () => {
    expect(supportedAttachment("program.exe", "application/octet-stream")).toBe(false);
    expect(isSupportedDocument("program.exe", "application/octet-stream")).toBe(false);
    // A part with neither a usable extension nor a usable type: the empty-string
    // lookups must not land on a set member.
    expect(supportedAttachment(null, "")).toBe(false);
    expect(isSupportedDocument("", "")).toBe(false);
  });

  it("caps forwarded attachments at the number the route will accept", () => {
    // The Worker truncates to its own literal; the route 400s above
    // MAX_EMAIL_DOCUMENTS. If the Worker's cap were the larger of the two, every
    // over-cap email would be rejected wholesale instead of truncated.
    expect(MAX_EMAIL_ATTACHMENTS).toBe(MAX_EMAIL_DOCUMENTS);
  });

  it("copies the app's per-document size ceiling", () => {
    expect(MAX_EMAIL_DOCUMENT_BYTES).toBe(MAX_DOCUMENT_SIZE);
  });

  /**
   * The raw cap is the one duplicated constant that cannot be pinned by
   * comparing numbers alone: `message.rawSize` is measured on an *encoded*
   * message, and `MAX_DOCUMENT_SIZE` bounds a *decoded* file. So the pin is at
   * the message surface — the true wire size of a full-size document, computed
   * the way RFC 2045 actually writes it (and the way this repo's fixtures write
   * it: `email-ingest-worker.test.ts` calibrates both wire-size formulas against
   * real `multipartEmail` fixtures).
   *
   * Measured as quoted-printable, because the SENDER's client picks the transfer
   * encoding and that is the worse of the two it may pick (DW-358).
   */
  it("admits a full-size document under the worst-case transfer encoding", () => {
    const wireSize = quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE);
    expect(wireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // Pinned as FIXED, not merely as changed: this is the exact message the
    // previous base64-only derivation bounced. A byte-dense `.csv` or `.txt`
    // inside the advertised 10 MB ceiling goes out with every octet escaped,
    // ~3.12x rather than ~1.37x, and did not fit under the old cap.
    //
    // Frozen as a literal on purpose. This is a HISTORICAL figure -- the cap
    // that actually shipped before DW-358, `ceil(10 MB * BASE64_EXPANSION_FACTOR)
    // + 64 KiB` as those terms stood on 2026-08-21. Re-deriving it from the live
    // constants would let it move with them, and the day
    // `MIME_ENVELOPE_HEADROOM_BYTES` changes this assertion would quietly stop
    // being about the cap that bounced the message. Never re-derive it.
    const PREVIOUS_BASE64_ONLY_CAP_BYTES = 14_414_471;
    expect(wireSize).toBeGreaterThan(PREVIOUS_BASE64_ONLY_CAP_BYTES);
    // DW-104 regression guard: widening for quoted-printable must not stop
    // admitting the base64 message the earlier fix was made to admit.
    const base64WireSize = base64PartWireSize(MAX_DOCUMENT_SIZE);
    expect(base64WireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // And the naive factor — the one the original "raise it to ~13.4 MB" figure
    // was built from — is still not enough even for base64: it omits the CRLF
    // after every 76-character line.
    expect(base64WireSize).toBeGreaterThan(Math.ceil(MAX_DOCUMENT_SIZE * (4 / 3)));
    // Derived from the exported terms, never restated as a literal: a hand-typed
    // cap would keep the comparisons above true only by coincidence, and would
    // stop tracking `MAX_DOCUMENT_SIZE` the moment it moved.
    expect(MAX_RAW_EMAIL_BYTES).toBe(
      Math.ceil(MAX_EMAIL_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
        MIME_ENVELOPE_HEADROOM_BYTES,
    );
    // Part headers, boundaries and the text body still have to fit.
    expect(MAX_RAW_EMAIL_BYTES - wireSize).toBeGreaterThanOrEqual(1024);
  });

  /**
   * `QUOTED_PRINTABLE_EXPANSION_FACTOR` is the worst case only among senders
   * that fill their lines to the 76-character maximum. Wrapping NARROWER is
   * conforming and costs more -- `3k + 3` wire bytes per `k` escapes -- so the
   * factor's comment states how far down the envelope headroom reaches. This is
   * that claim as a pin rather than as prose.
   */
  it("still admits a full-size document from a sender that wraps at 72 columns", () => {
    // 24 escapes per line: 72 characters of payload plus the `=` soft break, the
    // narrowest wrap the headroom covers. Computed through the same helper the
    // cap is measured with, not hand-typed, so it tracks the real formula.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 24)).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // And narrower really does cost more, so the direction of the claim is
    // pinned too: a test that only checked one width could not tell a widening
    // margin from a shrinking one.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 24)).toBeGreaterThan(
      quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE),
    );
    // 23 escapes (a 70-column wrap) is over the cap and stays over it. Recorded
    // as the KNOWN, BOUNDED limit the factor's comment names -- if a future
    // widening admits it, this assertion is the prompt to update that comment
    // rather than to leave it describing a boundary that has moved.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 23)).toBeGreaterThan(
      MAX_RAW_EMAIL_BYTES,
    );
  });

  it("computes the worst-case factor from the encodings it names", () => {
    // "Worst case" is a claim the suite checks, not a label on a constant. A
    // swap to the larger factor would leave the other export dead and this
    // relationship unobserved; the `Math.max` keeps both live and keeps the cap
    // tracking whichever is worse if either is ever corrected.
    expect(WORST_CASE_TRANSFER_ENCODING_FACTOR).toBeGreaterThanOrEqual(BASE64_EXPANSION_FACTOR);
    expect(WORST_CASE_TRANSFER_ENCODING_FACTOR).toBeGreaterThanOrEqual(
      QUOTED_PRINTABLE_EXPANSION_FACTOR,
    );
    // And today it is the quoted-printable one — so a regression that silently
    // dropped that term from the max would fail here rather than pass on the
    // weaker inequalities above.
    expect(WORST_CASE_TRANSFER_ENCODING_FACTOR).toBe(QUOTED_PRINTABLE_EXPANSION_FACTOR);
  });

  it("records the same number of attachment names the route keeps", () => {
    // The Worker truncates the forwarded `attachmentName` list; the route
    // truncates again in `sanitizeAttachmentNames`. A smaller Worker cap loses
    // names the route would have kept, silently.
    expect(MAX_EMAIL_ATTACHMENT_NAMES_RECORDED).toBe(MAX_EMAIL_ATTACHMENTS_RECORDED);
  });

  it("truncates the email body at the length the route accepts", () => {
    // Above this the route 400s the whole message, so a larger Worker cap turns
    // a truncated-but-ingested email into a total rejection.
    expect(WORKER_MAX_EMAIL_CONTENT_CHARS).toBe(MAX_EMAIL_CONTENT_CHARS);
  });
});
