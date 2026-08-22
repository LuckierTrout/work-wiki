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
  SUPPORTED_EXTENSIONS,
  SUPPORTED_MIME_TYPES,
  supportedAttachment,
} from "../../../workers/email-ingest/index";
import { base64PartWireSize } from "./email-ingest-wire";

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
   * it: `email-ingest-worker.test.ts` calibrates `base64PartWireSize` against a
   * real `multipartEmail` fixture).
   */
  it("admits a full-size document once it is base64-encoded on the wire", () => {
    const wireSize = base64PartWireSize(MAX_DOCUMENT_SIZE);
    expect(wireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // The naive factor — the one the original "raise it to ~13.4 MB" figure was
    // built from — is NOT enough: it omits the CRLF after every 76-character
    // line and bounces the very document this cap exists to admit.
    expect(wireSize).toBeGreaterThan(Math.ceil(MAX_DOCUMENT_SIZE * (4 / 3)));
    // Derived from the exported terms, never restated as a literal: a hand-typed
    // cap would keep the comparison above true only by coincidence, and would
    // stop tracking `MAX_DOCUMENT_SIZE` the moment it moved.
    expect(MAX_RAW_EMAIL_BYTES).toBe(
      Math.ceil(MAX_EMAIL_DOCUMENT_BYTES * BASE64_EXPANSION_FACTOR) +
        MIME_ENVELOPE_HEADROOM_BYTES,
    );
    // Part headers, boundaries and the text body still have to fit.
    expect(MAX_RAW_EMAIL_BYTES - wireSize).toBeGreaterThanOrEqual(1024);
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
