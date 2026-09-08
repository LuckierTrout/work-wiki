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
  AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
  AGGREGATE_DOCUMENT_AVERAGE_BYTES,
  AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES,
  BASE64_EXPANSION_FACTOR,
  EMAIL_ROUTING_MAX_INBOUND_BYTES,
  ENFORCED_AGGREGATE_DOCUMENT_BYTES,
  MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS,
  MAX_EMAIL_ATTACHMENT_NAMES_RECORDED,
  MAX_EMAIL_CONTENT_BYTES as WORKER_MAX_EMAIL_CONTENT_BYTES,
  MAX_EMAIL_CONTENT_CHARS as WORKER_MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_RAW_EMAIL_BYTES,
  MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT,
  MIME_ENVELOPE_HEADROOM_BYTES,
  MIME_STRUCTURAL_HEADROOM_BYTES,
  QUOTED_PRINTABLE_EXPANSION_FACTOR,
  RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES,
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
   *
   * Against `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, not the enforced cap. The
   * derivation is the term this claim was ever about -- "the budget is wide
   * enough for a full-size document however the sender encodes it" -- and it
   * survives DW-449 intact. What DW-449 changed is that the derivation is no
   * longer what a sender meets: `MAX_RAW_EMAIL_BYTES` clamps it to the 25 MiB
   * this repo records for Cloudflare Email Routing -- a bound chosen, not
   * observed (DW-706) -- and a maximally-escaped full-size document is above
   * that, so this Worker refuses it, and under that bound the transport would
   * have refused it first. Re-pointed rather than deleted, so the derivation's
   * reach stays measured here and the clamp is measurably a CEILING rather than
   * a re-derivation.
   */
  it("derives room for a worst-case-encoded full-size document, which the enforced cap then refuses", () => {
    const wireSize = quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE);
    expect(wireSize).toBeLessThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
    // ...and over the enforced cap, which is the gate the case in
    // `email-ingest-worker.test.ts` refuses on.
    expect(wireSize).toBeGreaterThan(MAX_RAW_EMAIL_BYTES);
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
    // DW-104 regression guard, and the one full-size admission that survives the
    // DW-449 clamp: measured against the ENFORCED cap, because this is a claim
    // about a message that really arrives rather than about the derivation.
    const base64WireSize = base64PartWireSize(MAX_DOCUMENT_SIZE);
    expect(base64WireSize).toBeLessThan(MAX_RAW_EMAIL_BYTES);
    // And the naive factor — the one the original "raise it to ~13.4 MB" figure
    // was built from — is still not enough even for base64: it omits the CRLF
    // after every 76-character line.
    expect(base64WireSize).toBeGreaterThan(Math.ceil(MAX_DOCUMENT_SIZE * (4 / 3)));
    // Derived from the exported terms, never restated as a literal: a hand-typed
    // cap would keep the comparisons above true only by coincidence, and would
    // stop tracking `MAX_DOCUMENT_SIZE` the moment it moved. The budget the cap
    // is derived from is the AGGREGATE one now (DW-362), not one document.
    expect(AGGREGATE_DERIVED_RAW_EMAIL_BYTES).toBe(
      Math.ceil(
        MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR,
      ) + MIME_ENVELOPE_HEADROOM_BYTES,
    );
    // Part headers, boundaries and the text body still have to fit -- under the
    // derivation for the worst-case document, and under the ENFORCED cap for the
    // base64 one, which is the message that actually gets to use that room.
    expect(AGGREGATE_DERIVED_RAW_EMAIL_BYTES - wireSize).toBeGreaterThanOrEqual(1024);
    expect(MAX_RAW_EMAIL_BYTES - base64WireSize).toBeGreaterThanOrEqual(1024);
  });

  /**
   * The cap is sized for the number of attachments this Worker actually
   * advertises and forwards, not for one document (DW-362). Before that, a
   * sender who respected every per-document and per-count limit could still be
   * refused wholesale at the door, and the over-cap acknowledgement line was
   * unreachable for anything but small files.
   *
   * The reachability claim is OBSERVED here rather than asserted in a comment:
   * the aggregate is measured part by part on the worst-case wire and compared
   * with the constant.
   *
   * The constant is `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` since DW-449. This whole
   * case is a statement about the DERIVATION -- that it is sized for the count
   * this Worker advertises -- and the clamp did not touch any term of it. The
   * enforced cap is lower, so this aggregate is refused at the door -- and under
   * the 25 MiB this repo records for Cloudflare Email Routing it would not have
   * reached the Worker at all; the gate case in
   * `email-ingest-worker.test.ts` pins that refusal and the figure it quotes.
   *
   * Since DW-455 it is also a statement about the BODY. The envelope headroom
   * used to claim it covered "an ordinary text body" while the Worker truncates
   * to `MAX_EMAIL_CONTENT_CHARS`, a body 14.3x the whole headroom on the
   * worst-case wire. The aggregate and a MAXIMAL body are measured together
   * here, because covering both at once is what the derivation now asserts.
   *
   * The body is measured in BYTES since DW-705, not in code units: the cap the
   * Worker truncates by counts UTF-16 code units, and a non-ASCII one costs up
   * to three bytes each. Every body pin below therefore reads
   * `MAX_EMAIL_CONTENT_BYTES`; aiming them at the code-unit figure measured the
   * ASCII case only and let the widest admissible body sit outside the
   * derivation unobserved.
   */
  it("derives room for MAX_EMAIL_ATTACHMENTS mid-size documents beside a maximal body, which the enforced cap then refuses", () => {
    // Measured PER PART, never by scaling one measurement. Ten separate mid-size
    // parts cost slightly more than one part of the whole budget -- each pays its
    // own short final line, a soft break and a CRLF -- and it is the ten-part
    // figure the envelope headroom has to absorb.
    const aggregateWireSize =
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES);
    expect(aggregateWireSize).toBeGreaterThan(
      quotedPrintablePartWireSize(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES),
    );
    expect(aggregateWireSize).toBeLessThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
    // The DW-455 claim, observed rather than asserted in a comment: the envelope
    // covers a body at the full `MAX_EMAIL_CONTENT_CHARS` on the SAME worst-case
    // wire the attachments are charged at, on top of the whole aggregate. Before
    // DW-455 this sum was over the derivation and the headroom comment said so.
    //
    // The body is measured with the shared quoted-printable helper rather than
    // counted as raw characters, because that is the encoding the derivation is
    // built from -- a character count would understate it by ~3.12x and the
    // assertion would pass on slack rather than on the headroom.
    const maximalBodyWireSize = quotedPrintablePartWireSize(WORKER_MAX_EMAIL_CONTENT_BYTES);
    expect(aggregateWireSize + maximalBodyWireSize).toBeLessThan(
      AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
    );
    // And the envelope headroom is still positive afterwards by the amount
    // `MIME_STRUCTURAL_HEADROOM_BYTES` claims to cover -- headers and a boundary
    // marker for EVERY part, not a flat slack figure that ten parts could
    // exhaust while the assertion stayed green.
    //
    // 512 bytes per part, stated rather than measured: a real part preamble is a
    // `--boundary` line, `Content-Type` with a filename parameter,
    // `Content-Disposition: attachment` with the filename again, and
    // `Content-Transfer-Encoding` -- a few hundred bytes for ordinary filenames,
    // and 512 leaves room for a long or RFC 2231-encoded one. Generous on
    // purpose: the point is that the margin scales with the part count, so an
    // over-estimate makes the assertion harder to pass, not easier.
    //
    // Charged against the aggregate-PLUS-BODY figure, which is the tight one now:
    // measuring the bare aggregate would leave the body's 936,000 bytes sitting
    // in the margin and the assertion would no longer be about structure.
    //
    // `MAX_EMAIL_ATTACHMENTS + 1` parts, not `MAX_EMAIL_ATTACHMENTS`: the shape
    // being measured is a multipart message of ten attachment parts AND a body
    // part, and the body part pays for its own boundary marker and headers
    // exactly as the attachments do. Charging only ten would let the eleventh
    // part's preamble come out of slack the assertion never accounted for.
    const PART_HEADER_AND_BOUNDARY_BUDGET_BYTES = 512;
    expect(
      AGGREGATE_DERIVED_RAW_EMAIL_BYTES - aggregateWireSize - maximalBodyWireSize,
    ).toBeGreaterThanOrEqual((MAX_EMAIL_ATTACHMENTS + 1) * PART_HEADER_AND_BOUNDARY_BUDGET_BYTES);
    // The bounded limit the `QUOTED_PRINTABLE_EXPANSION_FACTOR` comment now
    // names, pinned rather than left as prose. It MOVED with DW-455 rather than
    // disappearing: the bare aggregate at a 72-column wrap now fits, and what is
    // over the derivation is the aggregate AND a maximal body at that wrap.
    // Recorded so a future widening that admits it is prompted to update that
    // comment.
    expect(
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES, 24),
    ).toBeLessThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
    expect(
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES, 24) +
        quotedPrintablePartWireSize(WORKER_MAX_EMAIL_CONTENT_BYTES, 24),
    ).toBeGreaterThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
    // How far down the bare aggregate now reaches, pinned at its own edge rather
    // than left as the `QUOTED_PRINTABLE_EXPANSION_FACTOR` comment's prose: a
    // 54-column wrap still fits, a 51-column one does not. Both sides are
    // asserted, so a change that moved the edge in EITHER direction is caught --
    // a one-sided pin would stay green if the aggregate quietly stopped fitting
    // at wraps it is documented to survive.
    //
    // The edge MOVED DOWN with DW-705 (it was k=22 fits / k=21 over): the
    // byte-derived body term takes three times as much out of the average, so
    // the bare aggregate is smaller and survives narrower wraps. That is the
    // aggregate half of the trade becoming observable -- the pair-with-a-body
    // edge above did not move, because the derivation did not.
    expect(
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES, 18),
    ).toBeLessThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
    expect(
      MAX_EMAIL_ATTACHMENTS * quotedPrintablePartWireSize(AGGREGATE_DOCUMENT_AVERAGE_BYTES, 17),
    ).toBeGreaterThan(AGGREGATE_DERIVED_RAW_EMAIL_BYTES);
  });

  /**
   * DW-455 paid for the maximal body out of the aggregate average rather than by
   * widening the door. This is the pin on the "rather than": the honest envelope
   * has to cost the raw cap NOTHING.
   *
   * Compared against the PRE-DW-455 derivation recomputed from the constants that
   * survive -- `AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES` with the structural
   * headroom alone -- and never against a hand-typed 65,496,679. A snapshot would
   * agree with itself if `MAX_EMAIL_ATTACHMENTS` or either expansion factor ever
   * moved; this recomputation tracks them.
   */
  it("pays for the maximal body without widening the derived raw cap", () => {
    const nominalDerivation =
      Math.ceil(
        MAX_EMAIL_ATTACHMENTS *
          AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES *
          WORST_CASE_TRANSFER_ENCODING_FACTOR,
      ) + MIME_STRUCTURAL_HEADROOM_BYTES;
    expect(AGGREGATE_DERIVED_RAW_EMAIL_BYTES).toBeLessThanOrEqual(nominalDerivation);
    // The two halves of the trade, each named, so a future edit that keeps the
    // total while breaking the reason is still caught. The average gives up each
    // attachment's share of the body...
    expect(AGGREGATE_DOCUMENT_AVERAGE_BYTES).toBe(
      AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES -
        Math.ceil(WORKER_MAX_EMAIL_CONTENT_BYTES / MAX_EMAIL_ATTACHMENTS),
    );
    // ...and the envelope gains exactly the wire bytes that body costs.
    expect(MIME_ENVELOPE_HEADROOM_BYTES - MIME_STRUCTURAL_HEADROOM_BYTES).toBe(
      Math.ceil(WORKER_MAX_EMAIL_CONTENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR),
    );
    // The share is rounded UP, against the budget, so the budget can never round
    // in its own favour: ten shares cover the whole body rather than falling
    // short of it by the remainder.
    expect(
      MAX_EMAIL_ATTACHMENTS *
        (AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES - AGGREGATE_DOCUMENT_AVERAGE_BYTES),
    ).toBeGreaterThanOrEqual(WORKER_MAX_EMAIL_CONTENT_BYTES);
    // And the budget stays an integer -- `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`
    // feeds a `Math.floor(... / 1024 / 1024)` the acknowledgement quotes, and a
    // fractional byte count there is a figure no sender could act on.
    expect(Number.isInteger(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES)).toBe(true);
  });

  /**
   * The budget's floor. `Math.max` keeps both terms live so the DW-104/DW-358
   * admission survives any future lowering of the average or the attachment
   * count -- a plain multiplication would let a smaller `MAX_EMAIL_ATTACHMENTS`
   * silently push the cap below one full-size document again.
   */
  it("never budgets less than a single full-size document, and reaches the advertised count", () => {
    expect(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES).toBeGreaterThanOrEqual(MAX_EMAIL_DOCUMENT_BYTES);
    // Deliberately NOT re-stating `Math.max(MAX_EMAIL_DOCUMENT_BYTES,
    // MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES)` here. Copying
    // the source expression into the assertion can only ever detect an edit, and
    // would agree with the source however wrong both were. The assertions in this
    // case are the ones that say something the source does not.
    //
    // It really does reach across the advertised attachment count today --
    // otherwise the floor would be doing all the work and the aggregate case
    // above would be passing on the single-document derivation.
    expect(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES).toBe(
      MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES,
    );
    // The stated average has to stay a MID-SIZE one: at or above the
    // per-document ceiling the budget becomes `MAX_EMAIL_ATTACHMENTS` full-size
    // documents, ~312 MB on the worst-case wire, which is the shape DW-362
    // deliberately did not buy.
    expect(AGGREGATE_DOCUMENT_AVERAGE_BYTES).toBeLessThan(MAX_EMAIL_DOCUMENT_BYTES);
  });

  /**
   * What DW-455 COST, observed rather than only narrated in the constant's
   * comment. The pre-DW-455 budget was exactly `2 * MAX_EMAIL_DOCUMENT_BYTES`, so
   * two attachments at the advertised per-document ceiling fitted precisely --
   * the selection gate is a `>`, and their sum landed on the budget rather than
   * over it. Paying for the maximal body out of the average took that away: the
   * second is now an over-budget loss.
   *
   * A cost against the DERIVATION, which is what this case measures. Whether a
   * sender can still meet it is a separate question, and since DW-697 the answer
   * is no: the enforced budget is lower again, and a pair of full-size documents
   * is ~27.4 MiB of base64 -- refused at the door rather than losing its second
   * part. The clamp's own cases below measure what a sender does meet.
   *
   * Written as a derived comparison rather than as a hand-typed 20,971,520, so it
   * follows `MAX_EMAIL_DOCUMENT_BYTES` if that ever moves. This is a RECORD of an
   * accepted cost, not a veto: if a later change restores the room, re-aim this
   * case at what then holds instead of reading its failure as a regression.
   */
  it("no longer fits two full-size documents, which is what paying for the body cost", () => {
    expect(2 * MAX_EMAIL_DOCUMENT_BYTES).toBeGreaterThan(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    // The premise that makes the loss land exactly at the SECOND document: the
    // pre-DW-455 budget was two full-size documents to the byte, so the pair sat
    // on the gate rather than under it and any subtraction at all drops one.
    expect(MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES).toBe(
      2 * MAX_EMAIL_DOCUMENT_BYTES,
    );
    // And the subtraction is the body's share and nothing more -- the whole
    // shortfall is what the average gave up, not an unrelated narrowing.
    expect(
      MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES -
        MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    ).toBe(
      MAX_EMAIL_ATTACHMENTS * Math.ceil(WORKER_MAX_EMAIL_CONTENT_BYTES / MAX_EMAIL_ATTACHMENTS),
    );
    // ...and ONE full-size document still fits, which is the DW-104/DW-358
    // admission the floor above exists to protect. The cost stopped at the
    // second document.
    expect(MAX_EMAIL_DOCUMENT_BYTES).toBeLessThanOrEqual(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
  });

  /**
   * `QUOTED_PRINTABLE_EXPANSION_FACTOR` is the worst case only among senders
   * that fill their lines to the 76-character maximum. Wrapping NARROWER is
   * conforming and costs more -- `3k + 3` wire bytes per `k` escapes -- so the
   * factor's comment states how far down the envelope headroom reaches. This is
   * that claim as a pin rather than as prose.
   */
  it("still derives room for a full-size document from a sender that wraps at 72 columns", () => {
    // 24 escapes per line: 72 characters of payload plus the `=` soft break. Kept
    // as an explicit case because it is the admission DW-358 shipped and this
    // widening must not weaken. Computed through the same helper the cap is
    // measured with, not hand-typed, so it tracks the real formula.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 24)).toBeLessThan(
      AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
    );
    // And narrower really does cost more, so the direction of the claim is
    // pinned too: a test that only checked one width could not tell a widening
    // margin from a shrinking one.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 24)).toBeGreaterThan(
      quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE),
    );
    // Under the aggregate derivation the single-document admission survives
    // EVERY conforming wrap, not just 72 columns: `(3k + 3) / k` is monotonic in
    // `k`, so the narrowest wrap expressible -- one escape per line, ratio 6 --
    // is the worst of them, and it fits. Pinned at the extreme rather than at
    // some arbitrary width, because that one comparison settles all the others.
    expect(quotedPrintablePartWireSize(MAX_DOCUMENT_SIZE, 1)).toBeLessThan(
      AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
    );
    // The k=23 bound this test used to record belonged to the single-document
    // derivation and is gone with it (DW-362); the surviving bounded limit is
    // the aggregate one, pinned in the aggregate case above.
  });

  /**
   * The clamp itself (DW-449). The derivation says how wide the aggregate budget
   * NEEDS the door to be; `EMAIL_ROUTING_MAX_INBOUND_BYTES` says how wide this
   * repo has CHOSEN to assume Cloudflare Email Routing makes it -- a
   * conservative bound recorded, not measured (DW-706). A cap taken from the
   * derivation alone quoted senders 62.4 MB, two and a half times that bound,
   * inviting a resend at a size nothing here has any reason to think arrives.
   *
   * Written as a `Math.min` rather than as a swap to the smaller term, the same
   * way `WORST_CASE_TRANSFER_ENCODING_FACTOR` is a `Math.max`: both terms stay
   * exported, each keeps the assertions above, and the enforced figure keeps
   * tracking whichever is lower if either is ever corrected.
   */
  it("enforces the lower of the aggregate derivation and the platform inbound ceiling", () => {
    expect(MAX_RAW_EMAIL_BYTES).toBe(
      Math.min(AGGREGATE_DERIVED_RAW_EMAIL_BYTES, EMAIL_ROUTING_MAX_INBOUND_BYTES),
    );
    // The invariant that outlives today's arithmetic, and the reason the clamp
    // exists at all: whatever either term becomes, the Worker may never enforce
    // -- or quote -- a size above the ceiling recorded for the transport.
    expect(MAX_RAW_EMAIL_BYTES).toBeLessThanOrEqual(EMAIL_ROUTING_MAX_INBOUND_BYTES);
    // The platform figure in the unit this repo records it in, which is also the
    // unit `workers/email-ingest/README.md` gives operators. 25 MiB is an
    // unverified conservative bound, not a checked one (DW-706), so this pins
    // what was RECORDED rather than what was confirmed -- still the unit worth
    // pinning, because a byte count restated here would agree with the constant
    // however wrong both were.
    expect(EMAIL_ROUTING_MAX_INBOUND_BYTES / 1024 / 1024).toBe(25);
    // Which term binds TODAY, stated rather than left to the reader. Not a
    // requirement -- lowering the aggregate budget far enough would flip it, and
    // the `Math.min` above is what keeps that correct -- but recorded so a
    // future widening that flips it is prompted to revisit the cases above,
    // which measure the derivation precisely because it is not the enforced cap.
    expect(AGGREGATE_DERIVED_RAW_EMAIL_BYTES).toBeGreaterThan(EMAIL_ROUTING_MAX_INBOUND_BYTES);
    expect(MAX_RAW_EMAIL_BYTES).toBe(EMAIL_ROUTING_MAX_INBOUND_BYTES);
    // And the DW-104 admission still holds against the ENFORCED cap, not merely
    // against the derivation: a base64 full-size document is the one full-size
    // shape that still arrives.
    expect(base64PartWireSize(MAX_DOCUMENT_SIZE)).toBeLessThan(MAX_RAW_EMAIL_BYTES);
  });

  /**
   * The SECOND clamp (DW-697), one level down from the DW-449 one above. That
   * clamp fixed the figure the over-SIZE refusal quotes; this one fixes the
   * figure the over-BUDGET sentence quotes, and the budget the selection loop
   * spends with it.
   *
   * The defect it closes: `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` is derived from
   * the WORST transfer encoding, so nothing in the derivation ever asked whether
   * a message could carry that many DECODED bytes through the door the DW-449
   * clamp left. It could not -- 20,671,520 decoded bytes are over the enforced
   * gate under both encodings a real client picks -- so the quoted 19 MB named a
   * budget only an unencoded `7bit`/`8bit` sender could spend, which is not a
   * shape mainstream clients emit for the formats this Worker advertises.
   *
   * Both constants stay exported and both are measured here, exactly as the
   * derivation and the platform ceiling are above: the derivation records what
   * the budget NEEDS, and the enforced figure records what a sender can spend.
   */
  it("clamps the aggregate budget to what the enforced door can carry as base64", () => {
    // The lower of the two terms, and at or above the floor. Stated as the three
    // inequalities the `Math.max`/`Math.min` has to satisfy rather than by
    // copying the source expression, which could only ever detect an edit.
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBeLessThanOrEqual(
      MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES,
    );
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBeLessThanOrEqual(
      RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES,
    );
    // The DW-104/DW-358 admission the floor exists to protect: ONE full-size
    // document is still admissible against the budget, so a single part above it
    // is refused by the per-document ceiling and never becomes an over-budget
    // loss. If the carrying capacity ever computed BELOW this, the floor would
    // be doing all the work and the aggregate budget would have collapsed onto
    // the per-document ceiling -- which retires DW-362 and is a product
    // decision, not arithmetic.
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBeGreaterThanOrEqual(MAX_EMAIL_DOCUMENT_BYTES);
    expect(RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES).toBeGreaterThan(MAX_EMAIL_DOCUMENT_BYTES);
    // Which term binds TODAY, stated rather than left to the reader: the
    // carrying capacity, and it really is a NARROWING -- the clamp gives up
    // budget rather than being a no-op that would leave DW-697 unfixed.
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBe(RAW_CARRIED_AGGREGATE_DOCUMENT_BYTES);
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBeLessThan(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    // And it stays an integer -- it feeds a `Math.floor(... / 1024 / 1024)` the
    // acknowledgement quotes, and a fractional byte count there is a figure no
    // sender could act on.
    expect(Number.isInteger(ENFORCED_AGGREGATE_DOCUMENT_BYTES)).toBe(true);
    // The quoted MB is never larger than the budget enforced, the same
    // invariant `MAX_RAW_EMAIL_MB` carries for the raw gate. Written as the
    // floor arithmetic production uses, because the budget is not MiB-aligned.
    expect(
      Math.floor(ENFORCED_AGGREGATE_DOCUMENT_BYTES / 1024 / 1024) * 1024 * 1024,
    ).toBeLessThanOrEqual(ENFORCED_AGGREGATE_DOCUMENT_BYTES);
  });

  /**
   * The reachability claim itself, measured rather than asserted in a comment:
   * a message that spends the WHOLE enforced budget as base64 attachments really
   * does fit under the enforced door, and one that spends the whole DERIVED
   * budget really does not. The second half is the DW-697 defect as a pin -- if
   * a future widening makes the derived budget base64-reachable, the clamp is a
   * no-op and this case says so.
   */
  it("lets a base64 sender spend the whole enforced budget under the raw gate", () => {
    // Measured through the shared wire helper, never restated: the budget's own
    // base64 wire size plus the whole envelope allowance is inside the gate.
    expect(
      base64PartWireSize(ENFORCED_AGGREGATE_DOCUMENT_BYTES) + MIME_ENVELOPE_HEADROOM_BYTES,
    ).toBeLessThanOrEqual(MAX_RAW_EMAIL_BYTES);
    // And PER PART, which is the shape a real message has and costs slightly
    // more: ten parts each pay their own short final line. Measured beside a
    // MAXIMAL body on the worst-case wire -- the body is charged the same way
    // the derivation charges it -- with structural room left over for every
    // part's headers and boundary marker, the attachments' and the body's.
    const perPartBytes = Math.ceil(ENFORCED_AGGREGATE_DOCUMENT_BYTES / MAX_EMAIL_ATTACHMENTS);
    const aggregateWireSize = MAX_EMAIL_ATTACHMENTS * base64PartWireSize(perPartBytes);
    const maximalBodyWireSize = quotedPrintablePartWireSize(WORKER_MAX_EMAIL_CONTENT_BYTES);
    const PART_HEADER_AND_BOUNDARY_BUDGET_BYTES = 512;
    expect(MAX_RAW_EMAIL_BYTES - aggregateWireSize - maximalBodyWireSize).toBeGreaterThanOrEqual(
      (MAX_EMAIL_ATTACHMENTS + 1) * PART_HEADER_AND_BOUNDARY_BUDGET_BYTES,
    );
    // The defect, pinned as the thing that is NOT reachable: the derived budget
    // in base64 is over the enforced gate, which is why quoting it told senders
    // about a budget no message of theirs could ever spend.
    expect(base64PartWireSize(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES)).toBeGreaterThan(
      MAX_RAW_EMAIL_BYTES,
    );
    // Quoted-printable is not a candidate for a clamp target and this is why:
    // what the door carries at ~3.12x is BELOW the per-document floor, so no
    // quoted-printable-reachable aggregate budget exists at all. Recorded here
    // so a future edit that "fixes" the clamp by aiming it at the worst case is
    // met with the reason that cannot work.
    expect(
      Math.floor(
        (MAX_RAW_EMAIL_BYTES - MIME_ENVELOPE_HEADROOM_BYTES) / QUOTED_PRINTABLE_EXPANSION_FACTOR,
      ),
    ).toBeLessThan(MAX_EMAIL_DOCUMENT_BYTES);
  });

  /**
   * The band's UPPER edge, derived rather than restated. 19,156,674 is quoted in
   * four places -- twice in `workers/email-ingest/index.ts`, once in
   * `email-ingest-worker.test.ts` and once in `workers/email-ingest/README.md`
   * -- as the most decoded attachment payload a base64 message can carry before
   * the raw gate refuses it, and until this case nothing measured it. In a suite
   * whose whole convention is that such figures are computed from the exported
   * constants, four hand-typed copies of one number is exactly the drift the
   * convention exists to prevent.
   *
   * It is NOT `Math.floor(MAX_RAW_EMAIL_BYTES / BASE64_EXPANSION_FACTOR)`. The
   * ratio is a per-byte average that ignores how the final short line is
   * written, and it over-states the capacity by two bytes; only the per-part
   * wire measurement gives ...674. So the edge is found by walking DOWN from the
   * ratio's estimate through `base64PartWireSize`, the same helper the cap is
   * measured with everywhere else, and the walk is asserted to have been
   * necessary.
   */
  it("measures the widest base64 payload the raw gate admits, and the band above the budget", () => {
    let carried = Math.floor(MAX_RAW_EMAIL_BYTES / BASE64_EXPANSION_FACTOR);
    // The ratio really does over-state it, which is why the walk exists at all.
    // A future correction to `BASE64_EXPANSION_FACTOR` that made the ratio exact
    // would fail here rather than silently turning the loop into a no-op.
    expect(base64PartWireSize(carried)).toBeGreaterThan(MAX_RAW_EMAIL_BYTES);
    while (base64PartWireSize(carried) > MAX_RAW_EMAIL_BYTES) carried -= 1;
    // The edge, both sides of it: exactly this many decoded bytes fit on the
    // base64 wire, and one more does not. A one-sided pin would stay green if
    // the real edge moved UP.
    expect(base64PartWireSize(carried)).toBeLessThanOrEqual(MAX_RAW_EMAIL_BYTES);
    expect(base64PartWireSize(carried + 1)).toBeGreaterThan(MAX_RAW_EMAIL_BYTES);
    // The figure the comments and the README quote. Restated HERE and nowhere
    // else on purpose: this is the one place it is derived, so a change that
    // moves the edge fails here and names the four prose sites that owe an
    // update, rather than leaving them quietly wrong.
    const DOCUMENTED_BASE64_CARRIED_TOTAL_BYTES = 19_156_674;
    expect(carried).toBe(DOCUMENTED_BASE64_CARRIED_TOTAL_BYTES);
    // And the band the over-budget line is reachable in: non-empty, which is the
    // whole DW-697 claim, and ~0.70 MiB wide as the constant's docblock and the
    // README both say. The width is `MIME_ENVELOPE_HEADROOM_BYTES` converted
    // back through the expansion factor -- the envelope the enforced budget
    // reserves but a real message with a short body does not spend.
    expect(carried).toBeGreaterThan(ENFORCED_AGGREGATE_DOCUMENT_BYTES);
    expect((carried - ENFORCED_AGGREGATE_DOCUMENT_BYTES) / 1024 / 1024).toBeCloseTo(0.7, 2);
  });

  /**
   * The clamp is ABOVE the derivation and feeds back into no term of it, which
   * is what keeps `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` -- and therefore
   * `MAX_RAW_EMAIL_BYTES` and the 25.0 MB the refusal quotes -- untouched by
   * DW-697. Verified rather than assumed: the clamped budget's OWN derivation is
   * still over the platform ceiling, so the `Math.min` in `MAX_RAW_EMAIL_BYTES`
   * would still select the platform term even if the derivation were re-aimed at
   * the enforced figure.
   */
  it("leaves the raw gate and the size the refusal quotes exactly where they were", () => {
    expect(MAX_RAW_EMAIL_BYTES).toBe(EMAIL_ROUTING_MAX_INBOUND_BYTES);
    expect(
      Math.ceil(ENFORCED_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
        MIME_ENVELOPE_HEADROOM_BYTES,
    ).toBeGreaterThan(EMAIL_ROUTING_MAX_INBOUND_BYTES);
    // The circularity guard, stated as the ordering it depends on: the carrying
    // capacity is computed FROM the enforced gate, so the gate may not be
    // computed from it. The derivation the gate's `Math.min` reads is still the
    // one built from `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` -- pinned verbatim in
    // the full-size-document case above -- and the assertion here is that the
    // enforced budget is strictly smaller, so substituting it could only ever
    // have lowered the derivation, never raised the gate.
    expect(ENFORCED_AGGREGATE_DOCUMENT_BYTES).toBeLessThan(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES);
    expect(AGGREGATE_DERIVED_RAW_EMAIL_BYTES).toBeGreaterThan(EMAIL_ROUTING_MAX_INBOUND_BYTES);
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

  /**
   * DW-705. The body cap counts UTF-16 CODE UNITS -- both the Worker's
   * truncation and the route's rejection slice by `.length` -- while the size
   * derivation is arithmetic in BYTES. `MAX_EMAIL_CONTENT_BYTES` is the
   * conversion between the two, and this is the pin on it: an ASCII-only reading
   * of the cap is exactly the defect DW-705 recorded, and it would leave a
   * perfectly admissible non-ASCII body outside the derivation with nothing
   * failing.
   */
  it("sizes the body term for the widest encoding of the body cap, not the narrowest", () => {
    // Three UTF-8 bytes per UTF-16 code unit is the maximum over every input: a
    // BMP character is one code unit and at most 3 bytes, and a supplementary
    // character is 4 bytes across TWO code units -- 2 per unit, cheaper by this
    // measure. Asserted against real encoded strings rather than restated as a
    // literal, so the constant is checked against Unicode and not against
    // itself.
    const utf8Length = (value: string) => new TextEncoder().encode(value).length;
    expect(utf8Length("\u0041")).toBeLessThanOrEqual(MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT);
    // U+FFFD: one code unit, three UTF-8 bytes -- the maximum is REACHED, so the
    // bound is tight rather than merely safe.
    expect("\uFFFD".length).toBe(1);
    expect(utf8Length("\uFFFD")).toBe(MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT);
    // U+1F600: two code units, four UTF-8 bytes -- under the bound per unit,
    // which is why supplementary characters need no wider factor.
    expect("\u{1F600}".length).toBe(2);
    expect(utf8Length("\u{1F600}")).toBeLessThanOrEqual(
      MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT * "\u{1F600}".length,
    );
    // And the byte figure the derivation spends is the cap at that maximum.
    expect(WORKER_MAX_EMAIL_CONTENT_BYTES).toBe(
      WORKER_MAX_EMAIL_CONTENT_CHARS * MAX_UTF8_BYTES_PER_UTF16_CODE_UNIT,
    );
    // A body of `MAX_EMAIL_CONTENT_CHARS` non-ASCII BMP characters -- the shape
    // that used to be over the derivation -- is inside the envelope's body term
    // on the worst-case wire. Measured through the shared helper, the same way
    // the aggregate cases measure their parts.
    expect(
      quotedPrintablePartWireSize(WORKER_MAX_EMAIL_CONTENT_CHARS * utf8Length("\uFFFD")),
    ).toBeLessThanOrEqual(MIME_ENVELOPE_HEADROOM_BYTES - MIME_STRUCTURAL_HEADROOM_BYTES);
  });
});
