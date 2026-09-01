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
 * Duplicates `MAX_EMAIL_CONTENT_CHARS` in `src/lib/email-ingest.ts`, which 400s
 * a longer body — truncating here to a different number would either lose text
 * the route would have accepted or post a body it rejects wholesale. Pinned by
 * the parity test, since this module cannot import the constant.
 *
 * Declared HERE, far above the truncation it governs, because since DW-455 it is
 * a term of the size derivation below as well as a parity duplicate:
 * `AGGREGATE_DOCUMENT_AVERAGE_BYTES` subtracts each attachment's share of these
 * characters from the nominal average, and `MIME_ENVELOPE_HEADROOM_BYTES` adds
 * their encoded cost back on the wire. Module-scope `const` initialisation order
 * forces the position; the value and its parity pin are unchanged by the move.
 */
export const MAX_EMAIL_CONTENT_CHARS = 100_000;
/**
 * The per-document average the aggregate budget is STATED at, BEFORE the body is
 * paid for.
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
 * worsening of the buffered-decoded-bytes exposure recorded as DW-360.
 *
 * Kept as its own named constant rather than folded into the average below so
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` can pin that DW-455
 * did not widen the raw cap against the PRE-DW-455 derivation itself, computed
 * from this nominal and `MIME_STRUCTURAL_HEADROOM_BYTES`, rather than against a
 * hand-typed snapshot of what that derivation used to yield.
 */
export const AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES = 2 * 1024 * 1024;
/**
 * The per-document average the budget is actually sized at: the nominal above,
 * less each attachment's share of a maximal body — 2,087,152 bytes.
 *
 * DW-455. `MIME_ENVELOPE_HEADROOM_BYTES` used to claim its 64 KiB covered "an
 * ordinary text body" while this Worker admits, and truncates to,
 * `MAX_EMAIL_CONTENT_CHARS` — 312,000 bytes on the worst-case wire, 4.8x that
 * whole allowance. The envelope now buys a MAXIMAL body honestly, and this
 * subtraction is where it is paid for.
 *
 * The identity that makes the trade exact: a decoded body byte and a decoded
 * attachment byte are both charged `WORST_CASE_TRANSFER_ENCODING_FACTOR`, so
 * surrendering `MAX_EMAIL_CONTENT_CHARS` decoded bytes of aggregate budget buys
 * precisely the `Math.ceil(MAX_EMAIL_CONTENT_CHARS * f)` wire bytes the body
 * needs. `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is unchanged at 65,496,679 as a
 * result — the honest envelope costs the raw cap nothing, and nothing quoted to
 * a sender about the raw gate moves.
 *
 * The share is rounded UP rather than down: the shares then cover the whole body
 * even when the division is inexact, the average stays an integer, and the
 * budget can never round in its own favour.
 */
export const AGGREGATE_DOCUMENT_AVERAGE_BYTES =
  AGGREGATE_DOCUMENT_NOMINAL_AVERAGE_BYTES -
  Math.ceil(MAX_EMAIL_CONTENT_CHARS / MAX_EMAIL_ATTACHMENTS);
/**
 * The DECODED attachment budget one message is sized for: `MAX_EMAIL_ATTACHMENTS`
 * documents at `AGGREGATE_DOCUMENT_AVERAGE_BYTES` each — 20,871,520 bytes
 * (~19.90 MiB, quoted to senders as 19 MB).
 *
 * Slightly under the round 20 MiB it used to be, and deliberately so: since
 * DW-455 the average has each attachment's share of `MAX_EMAIL_CONTENT_CHARS`
 * subtracted from it, which is what buys the maximal body its place in
 * `MIME_ENVELOPE_HEADROOM_BYTES` without widening the raw cap.
 *
 * What that PAYMENT COSTS, stated here rather than discovered later. The old
 * 20,971,520 was exactly `2 * MAX_EMAIL_DOCUMENT_BYTES`, and the selection gate
 * below is a `>`, so two attachments at the advertised per-document ceiling used
 * to fit precisely — with nothing to spare. At 20,871,520 they no longer do: the
 * first is forwarded and the second becomes an over-budget loss, named in the
 * acknowledgement as a file left behind once the total budget was spent. That is
 * a real narrowing of a shape a sender could hit, not a theoretical one — the
 * pair is ~20.0 MiB on the wire as unencoded `7bit`/`8bit` parts and clears the
 * 25 MiB raw gate, which is the same encoding the DW-360 budget cases use. It is
 * accepted rather than fixed because the alternative is widening the raw cap,
 * which the DW-455 decision ruled out. Pinned by
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`, so the cost is
 * observed rather than only narrated here.
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
 * `AGGREGATE_DOCUMENT_AVERAGE_BYTES` reach 71,631,087 bytes and are still
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
 * This is the cap's derivation AND, since DW-360, the post-decode bound: the
 * forwarding selection below stops appending parts to the outbound `FormData`
 * once their decoded lengths reach this figure. That pairing is the point. The
 * cap is derived from the WORST transfer encoding, so a sender using a CHEAPER
 * one (base64 at ~1.37x, an unencoded 7bit/8bit part at ~1x) could otherwise
 * slip far more decoded bytes past the raw gate than the budget names — ~47 MB
 * under the 62.4 MB `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` this budget yields, and
 * ~19 MB under the 25 MiB figure the DW-449 clamp actually enforces.
 *
 * WHICH peak this bounds, stated precisely, because the loose reading of it is
 * wrong. It bounds the `FormData` copies of the SELECTED parts — the bytes this
 * Worker chooses to hold and forward. It does NOT bound the message's whole
 * buffered payload: `PostalMime.parse(message.raw)` has already decoded the
 * entire MIME tree into `parsed.attachments` before the selection loop runs, and
 * that parse-time peak is still bounded solely by `MAX_RAW_EMAIL_BYTES` — which
 * DW-362 RAISED and the DW-449 clamp has since lowered to 25 MiB. So the budget
 * halves a doubled exposure rather than removing it; bounding the parse itself
 * would mean streaming the MIME tree, a different change entirely.
 */
export const MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES = Math.max(
  MAX_EMAIL_DOCUMENT_BYTES,
  MAX_EMAIL_ATTACHMENTS * AGGREGATE_DOCUMENT_AVERAGE_BYTES,
);
/**
 * The aggregate budget as the acknowledgement quotes it. Rounded DOWN, for the
 * same reason `MAX_RAW_EMAIL_MB` is: the figure a sender is told about must
 * never be larger than the one actually enforced.
 */
const MAX_EMAIL_AGGREGATE_DOCUMENT_MB = Math.floor(
  MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES / 1024 / 1024,
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
 * `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` the aggregate budget yields — and so is
 * every narrower wrap, down to k=1 at 62,914,560 bytes. Since `(3k + 3) / k`
 * only rises as `k` falls, ONE full-size document is admissible AGAINST THE
 * DERIVATION at every conforming wrap; the k=23 limit this comment used to
 * record was a property of the old single-document derivation and no longer
 * exists (DW-362).
 *
 * The bounded limit MOVED rather than disappeared, and since DW-455 it lives at
 * the whole shape the derivation is sized for — the aggregate AND a maximal body
 * together, not the attachments alone. `MAX_EMAIL_ATTACHMENTS` parts of
 * `AGGREGATE_DOCUMENT_AVERAGE_BYTES` by themselves reach 65,119,170 bytes at
 * k=25 and now fit under `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` at every wrap down
 * to k=22 (65,223,510 / 65,336,940 / 65,460,690); only k=21, at 65,596,230, is
 * over. Add a `MAX_EMAIL_CONTENT_CHARS` body and the pair is 65,431,170 at k=25,
 * inside the derivation with 65,509 bytes of structural slack left, but
 * 65,536,011 at k=24 (a 72-column wrap) and over. That is a bounded, known limit,
 * not an oversight — widening for it would cost headroom against a shape no
 * mainstream client emits. Pinned at both widths by
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts`.
 *
 * None of those figures is what a sender meets today (DW-449). The ENFORCED gate
 * is `MAX_RAW_EMAIL_BYTES`, clamped to the 26,214,400-byte
 * `EMAIL_ROUTING_MAX_INBOUND_BYTES`, and EVERY quoted-printable figure above is
 * over it — this Worker refuses those messages at the door, and under the
 * ceiling `EMAIL_ROUTING_MAX_INBOUND_BYTES` records they would not have reached
 * it in the first place. That ceiling is a bound this repo adopted, not one it
 * observed (DW-457), so the upstream half of that sentence is only as good as
 * the bound. Worst-case quoted-printable therefore carries roughly 8.0 MiB of
 * decoded payload past the enforced gate, not a full-size document; base64
 * still carries one (14,348,938 bytes on the wire) with room to spare.
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
 * Headroom for the MIME STRUCTURE alone: per-part headers and boundary markers
 * for up to `MAX_EMAIL_ATTACHMENTS` parts, plus the per-part remainder
 * `WORST_CASE_TRANSFER_ENCODING_FACTOR` under-counts — each part pays its own
 * short final line, so ten `AGGREGATE_DOCUMENT_AVERAGE_BYTES` parts cost
 * 65,119,170 bytes against the 65,119,143 the ratio yields for the budget taken
 * as one number.
 *
 * Not the body: since DW-455 the body has its own term, added next door. This is
 * the 64 KiB that was always structural, kept separately named for two reasons —
 * the two halves of the envelope stay legible at the constant, the same
 * both-terms-stay-live idiom `WORST_CASE_TRANSFER_ENCODING_FACTOR` and
 * `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` use; and the parity suite's non-widening
 * pin needs it to recompute the pre-DW-455 derivation.
 */
export const MIME_STRUCTURAL_HEADROOM_BYTES = 64 * 1024;
/**
 * The whole envelope allowance: the structural term above plus the worst-case
 * wire cost of a maximal ASCII body — 65,536 + 312,000 = 377,536 bytes.
 *
 * DW-455. The flat 64 KiB this used to be claimed to cover "an ordinary text
 * body" while this Worker admits, and truncates to, `MAX_EMAIL_CONTENT_CHARS` —
 * `Math.ceil(100,000 * 3.12)` = 312,000 bytes on the worst-case wire, 4.8x the
 * entire allowance. The allowance was dishonest about a body shape the module
 * itself produces on purpose; that is the defect, and this is the fix.
 *
 * WHAT IT BUYS, stated exactly, because the loose reading of it is the same
 * defect again. `MAX_EMAIL_CONTENT_CHARS` bounds UTF-16 CODE UNITS, not bytes —
 * the truncation further down tests `rawContent.length` and slices by that same
 * measure, and so does the route. This term charges those units as if each were
 * one byte, so what it buys is a maximal ASCII body and nothing wider. A body of
 * 100,000 non-ASCII BMP characters is up to ~300,000 decoded bytes and ~936,000
 * on the worst-case wire, against the 312,000 bought here plus 65,509 bytes of
 * structural slack: such a message is OVER the derivation.
 *
 * 312,000 is the figure the recorded decision named, and it is left as it stands
 * rather than re-derived at 3 bytes per code unit — which would triple the body
 * term and take three times as much out of the aggregate budget to pay for it.
 * The shortfall is inert today for the same reason the whole derivation is: since
 * DW-449 `EMAIL_ROUTING_MAX_INBOUND_BYTES` wins the `Math.min` below, so no
 * message is ever measured against `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` at all.
 * Read it as a known, bounded gap in a dormant figure — and re-open it before the
 * platform ceiling ever rises above that derivation.
 *
 * It costs the raw cap NOTHING. `AGGREGATE_DOCUMENT_AVERAGE_BYTES` surrenders
 * `MAX_EMAIL_CONTENT_CHARS` decoded bytes of aggregate budget to pay for it, and
 * a decoded body byte and a decoded attachment byte are charged the same factor:
 * `ceil(20,871,520 * 3.12) + 377,536 === ceil(20,971,520 * 3.12) + 65,536 ===
 * 65,496,679`.
 *
 * That EXACT equality is a property of today's VALUES, not a consequence of the
 * same-factor identity. The per-attachment share is rounded UP, so the budget
 * always gives up at least as much as the envelope takes; it gives up exactly as
 * much only because `MAX_EMAIL_CONTENT_CHARS` divides evenly by
 * `MAX_EMAIL_ATTACHMENTS` (and is a whole number of 25-escape lines). The
 * guarantee that always holds, and the one
 * `src/lib/__tests__/email-ingest-allowlist-parity.test.ts` pins, is the weaker
 * one: never WIDER than the pre-DW-455 derivation. A future value that does not
 * divide evenly makes it narrower, which is safe, rather than breaking a pin.
 *
 * What NOW HOLDS, where a trade-off used to be recorded. A message carrying the
 * full `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` ALONGSIDE an ASCII body at
 * `MAX_EMAIL_CONTENT_CHARS` is 65,431,170 bytes on the worst-case wire and fits
 * under `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, leaving 65,509 bytes for headers and
 * boundaries. That pair is what this is sized for — not every pair of extremes.
 * Two are still over it, both bounded and both named: a narrower quoted-printable
 * wrap of that same pair, recorded at `QUOTED_PRINTABLE_EXPANSION_FACTOR`, and
 * the non-ASCII body above.
 *
 * A property of `AGGREGATE_DERIVED_RAW_EMAIL_BYTES`, which is what this headroom
 * is added to. The DW-449 clamp sits ABOVE that arithmetic and does not change
 * it: it lowers the enforced gate without re-sizing any term of the derivation.
 */
export const MIME_ENVELOPE_HEADROOM_BYTES =
  MIME_STRUCTURAL_HEADROOM_BYTES +
  Math.ceil(MAX_EMAIL_CONTENT_CHARS * WORST_CASE_TRANSFER_ENCODING_FACTOR);
/**
 * The pre-decode ceiling, derived rather than restated: a message carrying the
 * whole `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` budget has to fit under it once
 * transfer encoding, the RFC 2045 line wrap and the MIME envelope are paid for —
 * otherwise the route's own gates are unreachable over email and a message every
 * per-document and per-count limit admits is refused at the door.
 *
 * The envelope term includes a MAXIMAL body since DW-455, so "every limit admits"
 * now means the body cap too: a message at the full budget carrying a
 * `MAX_EMAIL_CONTENT_CHARS` body is 65,431,170 bytes on the worst-case wire and
 * is inside this figure.
 *
 * Sized for the AGGREGATE, not for one document (DW-362). This Worker advertises
 * and forwards up to `MAX_EMAIL_ATTACHMENTS` attachments, so a cap derived from
 * a single `MAX_EMAIL_DOCUMENT_BYTES` document put its own advertised maximum
 * out of reach: ten mid-size files bounced wholesale at ~65 MB on the wire.
 *
 * That ~65 MB is the residual, and it is the reason this is not already covered
 * by DW-358. The ledger's worked example was measured in BASE64 (~27 MB for ten
 * 2 MB files) and fits under any of these caps. What still failed, and what this
 * derivation fixes, is the same aggregate under the WORST-CASE encoding the cap
 * is derived from: quoted-printable puts those ten parts at 65,119,170 bytes,
 * twice the single-document cap. See `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` for
 * the band the over-cap acknowledgement line is reachable in as a result.
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
 * under-counts: at `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` it yields 65,119,143
 * against an exact worst-case wire size of 65,119,170 for ten separate parts,
 * because every part's final short line pays for a soft break and a CRLF that no
 * ratio can express. `MIME_STRUCTURAL_HEADROOM_BYTES` absorbs that difference
 * along with everything else structural, which is why the cap is derived from the
 * ratio and not from the exact formula: the exact one lives in the test helper,
 * where it can be calibrated against a real fixture.
 *
 * That lands the DERIVATION at 65,496,679 bytes (~62.46 MiB) — the same figure it
 * yielded before DW-455, which moved bytes between the budget and the envelope
 * without adding any. It is no longer
 * the figure quoted to senders: `MAX_RAW_EMAIL_BYTES` below clamps it to the
 * platform ceiling, and 25.0 MB is what the refusal names (DW-449). Far above
 * the "about 13.4 MB" recorded in the 2026-08-19 decision —
 * which was a bare `MAX_DOCUMENT_SIZE * 4 / 3`, the arithmetic of one encoding
 * rather than its intent. Only this cap moves: the per-document ceiling, the
 * attachment count, the body cap and the `message.rawSize` gate itself are
 * unchanged. What is NEW below it is the post-decode aggregate bound (DW-360),
 * which holds the bytes actually copied into the outbound `FormData` to the same
 * `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` this cap is sized for.
 *
 * READ THIS BEFORE THE ARITHMETIC ABOVE: since DW-449 this constant gates
 * nothing. It appears only inside the `Math.min` below, where
 * `EMAIL_ROUTING_MAX_INBOUND_BYTES` wins, so `WORST_CASE_TRANSFER_ENCODING_FACTOR`
 * and `MIME_ENVELOPE_HEADROOM_BYTES` are — today — arithmetic no message is ever
 * measured against. It is kept for two reasons rather than inlined away: it is
 * the record of what the aggregate budget NEEDS the door to be, which is the
 * claim the parity suite still measures; and it is the term that binds again as
 * soon as `EMAIL_ROUTING_MAX_INBOUND_BYTES` reaches it — at or above 65,496,679
 * bytes (~62.46 MiB), since the `Math.min` below makes the derivation the
 * enforced cap on a tie — at which point every figure above becomes live without
 * anyone having to re-derive it.
 *
 * Two different thresholds, and it is worth not confusing them. 25 MiB is a
 * bound this repo recorded rather than verified (DW-457): if the real published
 * limit is anything ABOVE 25 MiB, work-wiki is narrowing itself and giving up
 * reach the transport would have carried. But only a real limit at or above
 * ~62.46 MiB makes THIS arithmetic live again. In between — a real ceiling of,
 * say, 30 MiB — the narrowing is self-imposed while the clamp still binds and
 * this derivation stays dormant. Treat the paragraphs above as that record, not
 * as a description of what senders meet.
 */
export const AGGREGATE_DERIVED_RAW_EMAIL_BYTES =
  Math.ceil(MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES * WORST_CASE_TRANSFER_ENCODING_FACTOR) +
  MIME_ENVELOPE_HEADROOM_BYTES;
/**
 * Cloudflare Email Routing's inbound ceiling AS THIS REPO RECORDS IT — the
 * transport limit this Worker means to stay under, not a budget of its own. A
 * message larger than the real ceiling is rejected by the platform before the
 * `email()` handler is invoked at all, so a refusal quoting any larger figure
 * invites the sender to resend under a size the transport has already refused
 * (DW-449).
 *
 * 25 MiB is an UNVERIFIED bound, not a checked one (DW-457). It entered this
 * repository on 2026-08-31 under DW-449, adopted AS IF verified against
 * Cloudflare's published limits — but DW-449's own record says the figure could
 * not be verified offline, so that verification cannot have happened. It is
 * RETAINED now for a different reason than it was adopted: not because anyone
 * checked it, but because it is conservative. This repository records no fetch
 * of https://developers.cloudflare.com/email-routing/limits/, then or since.
 * That URL stays as the place to look, not as a citation of something read.
 *
 * What re-verification would settle, and why an unchecked figure is KEPT LOW
 * rather than dropped altogether. If the published ceiling is HIGHER than
 * 25 MiB, this constant is a narrowing work-wiki imposes on itself and the
 * reach described at `MAX_RAW_EMAIL_BYTES` is given up by choice. If it is
 * LOWER, the bound is not conservative at all: the clamp is insufficient and
 * the refusal still quotes a size the transport would reject on its own. Only
 * the first is safe by default, which is the whole argument for keeping it.
 * Written as `25 * 1024 * 1024` rather than as 26,214,400 so the MiB stays
 * legible at the constant.
 */
export const EMAIL_ROUTING_MAX_INBOUND_BYTES = 25 * 1024 * 1024;
/**
 * The cap this Worker actually enforces: the lower of what the aggregate budget
 * needs and what this repo records the transport as carrying (an unverified
 * bound — see `EMAIL_ROUTING_MAX_INBOUND_BYTES`).
 *
 * Written as a `Math.min` over the two named terms rather than as a swap to the
 * smaller one — the same both-terms-stay-live idiom
 * `WORST_CASE_TRANSFER_ENCODING_FACTOR` and `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`
 * use. Each term stays exported and separately pinned, and the enforced figure
 * keeps tracking whichever is lower if either ever moves.
 *
 * The PLATFORM term binds today: 26,214,400 against the derivation's
 * 65,496,679. What that costs, stated here rather than discovered later — a
 * maximally-escaped quoted-printable full-size document (32,715,573 bytes on the
 * wire) and the whole aggregate budget (65,119,170) no longer reach this Worker.
 * The reachable admissions that survive are base64 — a full-size document is
 * 14,348,938 bytes, ~11.3 MiB clear — and roughly 8.0 MiB decoded under
 * worst-case quoted-printable.
 *
 * Those losses are ACCEPTED BY DECISION, not observed (DW-457).
 * `EMAIL_ROUTING_MAX_INBOUND_BYTES` is an unverified conservative bound, so the
 * DW-362 aggregate worst case is out of reach because this repo chose a low
 * ceiling — not because the transport was ever seen refusing it. Three branches,
 * kept apart because they do not cost the same thing. If the real ceiling is
 * EXACTLY 25 MiB, the clamp gives up nothing that was ever deliverable and only
 * stops a promise the refusal copy used to make. If it is BELOW 25 MiB, the
 * bound is not conservative at all: the clamp is insufficient and the refusal
 * still quotes a size the transport would reject on its own. If it is ABOVE,
 * this clamp is itself where those bytes are surrendered.
 * Re-verifying the platform figure is what would tell you which, and until
 * someone does, this repo accepts the narrowing as the safe way to be wrong.
 */
export const MAX_RAW_EMAIL_BYTES = Math.min(
  AGGREGATE_DERIVED_RAW_EMAIL_BYTES,
  EMAIL_ROUTING_MAX_INBOUND_BYTES,
);
/**
 * Rounded DOWN to the displayed precision, so the figure quoted back to the
 * sender is never larger than the limit actually enforced.
 */
const MAX_RAW_EMAIL_MB = (
  Math.floor((MAX_RAW_EMAIL_BYTES / 1024 / 1024) * 10) / 10
).toFixed(1);
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
  "xls",
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
  "application/vnd.ms-excel",
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
 * The FORWARDING predicate (eligibility): whether the sending client labelled
 * this part inline — a signature logo, an embedded screenshot — rather than
 * attaching it.
 *
 * Reads `disposition` and NOTHING else, and is never widened. Its counting
 * counterpart `decorativePart` below ALSO trusts a `Content-ID` the HTML body
 * references, and the two must stay separate predicates: this one decides what
 * is DROPPED. A `.md` that arrives carrying `Content-ID: <notes@x>` and no
 * `Content-Disposition` is still a document the sender sent, and a predicate
 * that both trusted Content-ID and gated forwarding would discard it in silence
 * (DW-566). A Content-ID may cost a part its place in the counts; it may never
 * cost the sender the file.
 *
 * `postal-mime` surfaces every such part in `parsed.attachments`, so the loss
 * accounting used to report a branded email footer back to its own sender as an
 * "unsupported attachment ... recorded but skipped" (DW-359). Nobody attached
 * it; nobody can act on being told it was skipped.
 *
 * `disposition` is `"attachment" | "inline" | null`. Only the explicit `"inline"`
 * is treated as inline: a `null` disposition is an unlabelled part, which is far
 * likelier to be a real attachment whose header the sending client omitted than
 * a decoration, and guessing wrong HERE drops a file the sender really did send.
 *
 * This is an ELIGIBILITY filter, not merely an accounting one (DW-446). An
 * inline part is removed before the allowlist runs, so it can never spend a
 * `MAX_EMAIL_ATTACHMENTS` slot or a byte of the aggregate budget, and is never
 * forwarded — not even when it is itself a supported document. Forwarding it
 * while excluding it from every reported loss is how a sender who attached nine
 * files was told they had exceeded a ten-attachment limit: the slot was spent,
 * and the sentence explaining where it went was suppressed.
 *
 * What it is NOT allowed to do is lose the part silently: a supported document
 * dropped here gets its own loss term and its own named sentence (DW-565),
 * because a document must never arrive and go unmentioned.
 */
function inlineByDisposition(attachment: {
  disposition: "attachment" | "inline" | null;
}): boolean {
  return attachment.disposition === "inline";
}

/**
 * One `Content-ID` value, in the shape a body's `cid:` reference is written in.
 *
 * `contentId` arrives angle-bracketed (`<logo@example.com>`) and a body
 * references it bare (`cid:logo@example.com`), so the brackets have to come off
 * before the two can be compared at all. Lower-cased because the left-hand side
 * of a Content-ID is nominally case-sensitive but is round-tripped through
 * clients that do not preserve case, and a case mismatch puts the phantom
 * "unsupported attachment ... recorded but skipped" line back in front of a
 * sender who attached nothing (DW-359).
 *
 * Matching too eagerly never loses a FILE — eligibility does not read any of
 * this (DW-566) — but it is not free either. An over-eager match on a real
 * UNSUPPORTED attachment takes it out of `countableAttachments`, and so out of
 * `attachmentNames`, out of `unsupportedCount` and out of every sentence: the
 * sender is told nothing at all about a file they really did attach. That is
 * the cost being traded against the phantom line, and it is why the reference
 * scan below errs towards under-matching.
 */
function normalizeCid(value: string): string {
  return value.trim().replace(/^</, "").replace(/>$/, "").trim().toLowerCase();
}

/**
 * How many distinct `cid:` references one body may contribute.
 *
 * `parsed.html` can be tens of megabytes, and every distinct token in it would
 * otherwise become a `Set` entry — a body of millions of one-character
 * references amplifies into far more memory than the parsed message that
 * carried it, in the same worker isolate the aggregate byte budget exists to
 * protect. Well past what any real client emits: a signature has a handful of
 * embedded images, and a rich newsletter tens.
 *
 * Hitting the cap costs nothing but a phantom line. References past it are not
 * collected, so a decoration they would have matched is merely counted as the
 * unlabelled real attachment it appears to be — the pre-DW-450 behaviour, on a
 * message no real client sends.
 */
const MAX_HTML_CID_REFERENCES = 512;

/**
 * Every `cid:` target the HTML body references from a URL-bearing position.
 *
 * This is the evidence that turns an unlabelled part into a decoration: a part
 * is embedded IN the message only if some body points at it. A `Content-ID`
 * alone proves nothing — clients stamp one on real attachments too — so an
 * unreferenced one leaves the part a real attachment (DW-450).
 *
 * `parsed.related` is deliberately not the signal: `multipart/related` marks a
 * whole subtree, including parts nothing references, and the recorded decision
 * names a Content-ID plus a body reference.
 *
 * Deliberately narrow, in two ways, because the two errors are not the same
 * size. UNDER-matching costs at worst the phantom "unsupported attachment ...
 * recorded but skipped" line DW-450 is about — a sentence about a decoration.
 * OVER-matching takes a file the sender really attached out of the counts, the
 * recorded names and every sentence, so they are told nothing about it at all.
 * When in doubt, do not match:
 *
 * 1. `<script>`, `<style>` and comments are stripped first, mirroring
 *    `htmlToText`'s own first step. A `cid:` inside a script string, a CSS
 *    rule or a commented-out draft is not the body pointing at a part.
 * 2. Only URL-bearing positions are read — `src`/`href`/`background`/`poster`
 *    attributes and CSS `url(...)` in an inline `style`. Scanning the whole
 *    document would let a quoted reply that merely MENTIONS `cid:something`
 *    in prose delete an attachment from the accounting.
 *
 * All three attribute spellings are matched (double-quoted, single-quoted and
 * bare), since the delimiter is the sending client's choice, not the sender's.
 */
function htmlCidReferences(html: string): ReadonlySet<string> {
  const references = new Set<string>();
  const scannable = html
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const patterns = [
    /(?:src|href|background|poster)\s*=\s*(?:"\s*cid:([^"]*)"|'\s*cid:([^']*)'|cid:([^\s"'>]+))/gi,
    /url\(\s*(?:"\s*cid:([^"]*)"|'\s*cid:([^']*)'|cid:([^\s"')]+))\s*\)/gi,
  ];
  for (const pattern of patterns) {
    for (const match of scannable.matchAll(pattern)) {
      const reference = normalizeCid(match[1] ?? match[2] ?? match[3] ?? "");
      if (reference) references.add(reference);
      if (references.size >= MAX_HTML_CID_REFERENCES) return references;
    }
  }
  return references;
}

/**
 * The COUNTING predicate: whether a part is a decoration for the purposes of
 * the recorded name list and the loss terms.
 *
 * Strictly wider than the forwarding predicate `inlineByDisposition` above, and
 * wider in exactly one place — where the `Content-Disposition` header is ABSENT.
 * A part a client labelled nothing at all, but whose `Content-ID` the HTML body
 * references, is an embedded graphic by construction: the body points at it
 * (DW-450). An explicit `disposition: "attachment"` stays a real attachment
 * however it is referenced, and a bare `null` with no referenced `contentId`
 * stays one too — that is the unlabelled real attachment the widening must not
 * swallow.
 *
 * The two predicates differ because the two mistakes are not the same size.
 * Being miscounted costs the sender a sentence; being dropped costs them a file.
 * This predicate may be wrong about a signature logo and nothing is lost; the
 * forwarding one may not be (DW-566).
 */
function decorativePart(
  attachment: {
    disposition: "attachment" | "inline" | null;
    contentId?: string;
  },
  referencedCids: ReadonlySet<string>,
): boolean {
  if (inlineByDisposition(attachment)) return true;
  // A TRUTHY check, not `!== null`. `disposition` is typed
  // `"attachment" | "inline" | null`, but "absent" reaches this Worker as
  // `undefined` too — from a parser upgrade, or from a caller building the
  // shape by hand — and `inlineByDisposition` already treats `undefined` and
  // `null` alike. A strict `!== null` here would make the two predicates
  // disagree about what "unlabelled" means, and the Content-ID branch
  // unreachable for the very shape it exists for. Any non-empty value that is
  // not `"inline"` stays a real attachment, which is the safe direction.
  if (attachment.disposition) return false;
  const cid = attachment.contentId ? normalizeCid(attachment.contentId) : "";
  return cid.length > 0 && referencedCids.has(cid);
}

/**
 * How many bytes one parsed attachment decodes to, WITHOUT decoding it.
 *
 * The aggregate budget below has to be applied before anything is copied into
 * the outbound `FormData`, and the obvious way to measure a part — encode it and
 * read the result's length — would allocate the very bytes the budget exists to
 * bound, defeating its purpose for exactly the message that trips it.
 *
 * `ArrayBuffer` and `Uint8Array` both carry `byteLength` for free. The string
 * branch is a fallback (`postal-mime`'s default `attachmentEncoding` is
 * `arraybuffer`), and is measured by scanning code units rather than by calling
 * `TextEncoder.encode`: the arithmetic is UTF-8's own, and a lone surrogate
 * costs the 3 bytes its U+FFFD replacement really occupies.
 *
 * Exported ONLY so that arithmetic can be pinned against `TextEncoder` itself.
 * Every fixture the sibling suites build reaches this through real PostalMime,
 * whose default `attachmentEncoding` is `arraybuffer`, so the string branch is
 * unreachable from a behavioural test and would otherwise ship unobserved —
 * see `src/lib/__tests__/email-ingest-worker-normalization.test.ts`.
 */
export function decodedByteLength(content: ArrayBuffer | Uint8Array | string): number {
  if (typeof content !== "string") return content.byteLength;
  let bytes = 0;
  for (let i = 0; i < content.length; i += 1) {
    const code = content.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff && i + 1 < content.length) {
      const next = content.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        // A surrogate PAIR is one code point: four UTF-8 bytes for two units.
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
  }
  return bytes;
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
 * The tail of a loss sentence: the names of the files it is about.
 *
 * Capped at `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` with a counted remainder, so
 * one reply line can never grow with the sender's attachment count — a message
 * of hundreds of eligible parts all refused by the same bound would otherwise
 * name every one of them at up to 200 characters each. The COUNT the sentence
 * opens with stays the true total; only the naming is truncated.
 *
 * The lists that reach here are no longer inline-free. THREE lists are passed
 * in — oversized, over-budget and inline-dropped; the over-cap and unsupported
 * sentences are counts with no names. Two of the three are inline-free, because
 * inline parts are dropped at eligibility upstream of the sizing partition and
 * the selection loop (DW-446). The third is precisely the inline-labelled
 * supported documents eligibility dropped, whose names have to reach the sender
 * or a document arrives and no sentence anywhere mentions it (DW-565).
 *
 * So this function filters nothing, and must not start to: the CALLER decides
 * which parts a sentence is about, and one caller's parts are all inline. What
 * these names must never do is reach `attachmentNames` — see the comment there.
 */
function replyLossNames(
  attachments: readonly { filename: string | null }[],
): string {
  const names = attachments.map((attachment) =>
    replyAttachmentName(attachment.filename),
  );
  const named = names.slice(0, MAX_EMAIL_ATTACHMENT_NAMES_RECORDED);
  const unnamed = names.length - named.length;
  return `${named.join(", ")}${
    unnamed ? `, and ${unnamed} other${unnamed === 1 ? "" : "s"}` : ""
  }`;
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
    // ...and from the COUNTABLE parts of it: decorations the sender never chose
    // to attach are excluded from every loss the acknowledgement reports and
    // from the recorded name list (DW-359).
    //
    // The body's `cid:` targets, collected once. They are the evidence that
    // turns an UNLABELLED part into a decoration for counting purposes: a
    // `Content-ID` alone proves nothing, a referenced one means the body embeds
    // the part (DW-450).
    const referencedCids = htmlCidReferences(parsed.html || "");
    // TWO predicates, and this is the call site where the difference shows.
    // COUNTING asks `decorativePart`, which also trusts a referenced
    // `Content-ID`; FORWARDING (the `eligibleAttachments` filter below and
    // everything it feeds) asks `inlineByDisposition`, which never does. A part
    // whose only inline signal is a referenced Content-ID therefore leaves the
    // COUNTS but never leaves ELIGIBILITY — a Content-ID must not cost the
    // sender a file (DW-566).
    //
    // The `supportedAttachment(...) ||` disjunct is what keeps the two lists a
    // superset/subset pair over one order-preserving pass. A supported document
    // carrying a referenced Content-ID is decorative by the counting predicate
    // yet still eligible, so it has to stay countable too: dropping it here
    // while it stayed eligible would make
    // `countableAttachments.length - eligibleAttachments.length` under-report,
    // and could drive it negative.
    const countableAttachments = parsed.attachments.filter(
      (attachment) =>
        !inlineByDisposition(attachment) &&
        (supportedAttachment(attachment.filename, attachment.mimeType) ||
          !decorativePart(attachment, referencedCids)),
    );
    // Eligibility is derived from the COUNTABLE list, not from
    // `parsed.attachments`: excluding an inline part is now about what may be
    // FORWARDED, not only about what is counted (DW-446). Intersecting the
    // countable list with the allowlist yields exactly
    // "not inline by disposition AND supported" — the counting predicate's
    // extra Content-ID reach cannot subtract from it, because the disjunct
    // above readmits every supported part. Filtering here —
    // ahead of sizing, the per-document partition and the selection loop — is
    // what stops an inline part from spending a `MAX_EMAIL_ATTACHMENTS` slot or
    // a byte of `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES` that a real attachment then
    // loses. Charging the sender for a part they never attached is bad; doing it
    // while the loss accounting below hides the charge is worse — they were
    // told they had exceeded a ten-attachment limit having attached nine files.
    //
    // Everything downstream — `sizedAttachments`, the oversized partition and
    // the selection loop's outputs — is inline-free by construction, so the
    // loss counts below are plain `.length` reads.
    const eligibleAttachments = countableAttachments.filter((attachment) =>
      supportedAttachment(attachment.filename, attachment.mimeType),
    );
    // Sizes, measured ONCE for every eligible part and reused by both bounds
    // below. `decodedByteLength` allocates nothing — it reads `byteLength` off
    // the buffer shapes and scans only the string fallback — so measuring here
    // costs no more than measuring inside the selection loop did.
    const sizedAttachments = eligibleAttachments.map((attachment) => ({
      attachment,
      size: decodedByteLength(attachment.content),
    }));
    // The per-DOCUMENT ceiling (DW-253), run BEFORE the selection loop.
    //
    // Two byte bounds answer different questions and must not be merged:
    // `MAX_EMAIL_DOCUMENT_BYTES` mirrors the route's own `MAX_DOCUMENT_SIZE`,
    // which 400s a single file above it; `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`
    // bounds what the forwarding loop copies in TOTAL. Partitioning first is
    // what makes an oversized part cost nothing but itself: it consumes neither
    // a `MAX_EMAIL_ATTACHMENTS` slot nor any of the aggregate budget, so it can
    // never turn a legal message into an over-cap or over-budget refusal.
    //
    // Forwarding it would only buy a 400 the sender pays for with their body and
    // every other attachment.
    const oversizedAttachments = sizedAttachments
      .filter(({ size }) => size > MAX_EMAIL_DOCUMENT_BYTES)
      .map(({ attachment }) => attachment);
    const withinCeilingAttachments = sizedAttachments.filter(
      ({ size }) => size <= MAX_EMAIL_DOCUMENT_BYTES,
    );
    // The forwarding selection, bounded by BOTH limits the cap is sized for: the
    // attachment COUNT, and — since DW-360 — the aggregate DECODED byte budget
    // `AGGREGATE_DERIVED_RAW_EMAIL_BYTES` is derived from.
    //
    // The byte bound is not redundant with the raw gate. `message.rawSize` is
    // measured on the wire, and every encoding a sender may pick is cheaper than
    // the worst-case ~3.12x the derivation assumes: base64 is ~1.37x and an
    // unencoded 7bit/8bit part is ~1x. So a message inside the enforced
    // `MAX_RAW_EMAIL_BYTES` can still carry more decoded bytes than the budget
    // names — ~47 MB under the 62.4 MB derivation, and, since the DW-449 clamp,
    // up to the 25 MiB gate itself for an unencoded part. Without this loop
    // every one of those bytes would be copied AGAIN into `FormData` and held
    // there for the lifetime of the forward.
    //
    // What it does not bound: `PostalMime.parse` above has already decoded the
    // whole MIME tree, so the parse-time peak is `MAX_RAW_EMAIL_BYTES`' problem
    // — a figure DW-362 raised and the DW-449 clamp then lowered to 25 MiB. The
    // budget bounds the second copy, not the first — see
    // `MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES`.
    //
    // Sizes come from `decodedByteLength`, which reads `byteLength` (or scans a
    // string) and allocates nothing: no attachment is decoded any more times
    // than the forwarding loop below already decoded it.
    const supportedAttachments: typeof eligibleAttachments = [];
    const overBudgetAttachments: typeof eligibleAttachments = [];
    let aggregateBytes = 0;
    for (const { attachment, size } of withinCeilingAttachments) {
      // The count cap is checked first and BREAKS, so parts beyond it stay
      // over-cap losses rather than being re-labelled as over-budget ones.
      if (supportedAttachments.length >= MAX_EMAIL_ATTACHMENTS) break;
      if (aggregateBytes + size > MAX_EMAIL_AGGREGATE_DOCUMENT_BYTES) {
        // `continue`, not `break`: a smaller file behind an enormous one still
        // fits, and refusing it would make the loss depend on part order rather
        // than on the budget.
        overBudgetAttachments.push(attachment);
        continue;
      }
      aggregateBytes += size;
      supportedAttachments.push(attachment);
    }
    // The FIFTH loss term (DW-565): supported documents eligibility dropped
    // because the sending client labelled them inline. Before this they left
    // eligibility and contributed to none of the four terms, so a message whose
    // only part was an inline `.md` was answered "work-wiki found no email text
    // to ingest." — a document arrived and no sentence mentioned it.
    //
    // `inlineByDisposition` again, NOT `decorativePart`: this term is exactly
    // the parts the FORWARDING predicate dropped, so it has to read the same
    // predicate the forwarding filter read. Widening it to the counting one
    // would name a document that was forwarded perfectly well -- a supported
    // part carrying only a referenced Content-ID is decorative for counting and
    // eligible for forwarding (DW-566), and reporting that as "not queued"
    // contradicts the queued sentence one line above it.
    //
    // Read straight off `parsed.attachments`, and disjoint from the other four
    // by construction: every one of those is derived from
    // `countableAttachments`, which `inlineByDisposition` excluded these from.
    // No other partition can contain them, and they can contain nothing any
    // other partition holds.
    //
    // Only SUPPORTED parts qualify. An inline logo appears in no count and no
    // sentence (DW-359) — it was never ingestible, so there is nothing to tell
    // the sender they might have had.
    const inlineDroppedAttachments = parsed.attachments.filter(
      (attachment) =>
        inlineByDisposition(attachment) &&
        supportedAttachment(attachment.filename, attachment.mimeType),
    );
    const unsupportedCount = countableAttachments.length - eligibleAttachments.length;
    const oversizedCount = oversizedAttachments.length;
    const overBudgetCount = overBudgetAttachments.length;
    const inlineDroppedCount = inlineDroppedAttachments.length;
    // The residue, so the five terms stay disjoint: an oversized part never
    // entered the selection loop, so it must be subtracted here or it would be
    // re-reported as an over-cap casualty — telling the sender to send fewer
    // files, which would not have helped.
    const overCapCount =
      eligibleAttachments.length -
      supportedAttachments.length -
      oversizedCount -
      overBudgetCount;
    const skippedAttachmentCount =
      unsupportedCount +
      oversizedCount +
      overBudgetCount +
      overCapCount +
      inlineDroppedCount;
    // Built once and used by BOTH exits: a sender has to be told which file was
    // left behind whether or not anything else survived to be ingested. DW-360
    // created a new way for `supportedAttachments` to be empty while every part
    // was a supported document, and computing this sentence only in the
    // acknowledgement discarded it at exactly the exit that needed it most.
    //
    // The NAMED list is capped at `MAX_EMAIL_ATTACHMENT_NAMES_RECORDED` with a
    // counted tail, while the count stays the true total. The selection loop
    // `continue`s past an over-budget part and the count cap only `break`s once
    // `MAX_EMAIL_ATTACHMENTS` parts have been SELECTED, so a message of two
    // large files followed by hundreds of small eligible ones — all comfortably
    // under the raw gate — would otherwise name every one of them, at up to 200
    // characters each, in a single outbound reply line. Every other name-bearing
    // surface in this module is capped; this one was not.
    const overBudgetLine = overBudgetCount
      ? `${overBudgetCount} supported attachment${
          overBudgetCount === 1 ? " was" : "s were"
        } not queued because this email exceeds the ${MAX_EMAIL_AGGREGATE_DOCUMENT_MB} MB total attachment budget: ${replyLossNames(
          overBudgetAttachments,
        )}.`
      : "";
    // The per-document loss, kept as its OWN sentence for the same reason: a
    // file over the ceiling is not an over-cap casualty and is not an
    // unsupported format, and reporting it as either tells the sender to make a
    // change that would not have helped. Named as well as counted, so they know
    // which file to shrink or split.
    const oversizedLine = oversizedCount
      ? `${oversizedCount} attachment${oversizedCount === 1 ? " was" : "s were"} not queued because ${
          oversizedCount === 1 ? "it is" : "they are"
        } larger than ${MAX_EMAIL_DOCUMENT_MB} MB: ${replyLossNames(oversizedAttachments)}.`
      : "";
    // The inline loss, in the same shape as the two above — count, reason,
    // names — and shared by both exits for the same reason (DW-565). A document
    // that arrived and was not queued has to be named whichever exit the
    // message takes, and the no-content exit is the one that needed it most: it
    // is reached precisely when the inline document was the ONLY thing in the
    // message.
    //
    // Named HERE and nowhere else. `attachmentNames` must not carry these names
    // — the route derives a `localSkipped` FLOOR from
    // `attachmentNames.length - attachments.length`, so a recorded name with no
    // forwarded file behind it re-creates the phantom skip DW-359 removed. The
    // names reach the SENDER, who can re-send the file; the recorded list stays
    // a list of files that travelled.
    const inlineDroppedLine = inlineDroppedCount
      ? `${inlineDroppedCount} supported attachment${
          inlineDroppedCount === 1 ? " was" : "s were"
        } not queued because ${
          inlineDroppedCount === 1 ? "it was" : "they were"
        } marked inline by the sending client: ${replyLossNames(
          inlineDroppedAttachments,
        )}.`
      : "";
    // The last two loss sentences, hoisted for the same reason as the three
    // above them — they now have a SECOND consumer (DW-452). Written inline in
    // the acknowledgement's `lines` array, they were reachable from exactly one
    // exit; the refusal exit below carries all five, and no sentence in this
    // module is authored twice.
    //
    // These two are COUNTS with no names, unlike the three above: an over-cap
    // casualty and an unsupported part are both identified well enough by their
    // reason, and `attachmentNames` already carries the unsupported names to
    // the route for the activity history.
    //
    // Hoisting them is deliberately NOT the same as adding them to the
    // no-content exit, which keeps its exact four-sentence set. An over-cap
    // count is zero by construction there — that exit is reached only when
    // `supportedAttachments` is empty, and `overCapCount` counts eligible parts
    // the selection loop had no room for. The unsupported sentence is a
    // deliberate omission rather than a vacuous one: that exit's first sentence
    // already carries the format list on the `unsupportedCount &&
    // !inlineDroppedCount` branch, and where that branch is suppressed it is
    // suppressed ON PURPOSE (DW-565) — a message carrying an unsupported file
    // beside an inline-labelled supported one must not be told to fix a format
    // problem two lines above a sentence naming a Markdown file that arrived.
    // Adding this sentence there would reintroduce exactly that contradiction.
    const overCapLine = overCapCount
      ? `${overCapCount} supported attachment${
          overCapCount === 1 ? " was" : "s were"
        } not queued because this email exceeds the ${MAX_EMAIL_ATTACHMENTS}-attachment limit.`
      : "";
    const unsupportedLine = unsupportedCount
      ? `${unsupportedCount} unsupported attachment${
          unsupportedCount === 1 ? " was" : "s were"
        } recorded but skipped.`
      : "";
    if (!rawContent && supportedAttachments.length === 0) {
      await reply(
        message,
        subject,
        [
          // Keyed on `unsupportedCount`, NOT on the countable list: a sender
          // whose only part was a supported document dropped for the aggregate
          // budget (DW-360) or for the per-document ceiling (DW-253) has not
          // "sent no supported document attachment", and telling
          // them so two paragraphs above a sentence naming that same file is a
          // contradiction. A message whose only part was an inline
          // signature logo has no countable attachment at all, so it still gets
          // the plain no-text sentence rather than being told to fix a format
          // problem it does not have (DW-359). When something really did fail
          // the allowlist, the format list is still the useful answer, verbatim.
          //
          // ...and suppressed again by `!inlineDroppedCount`, for exactly the
          // reason recorded above (DW-565). A message carrying an unsupported
          // file AND an inline-labelled supported one would otherwise open with
          // the format branch below — "found no ... supported document
          // attachment", then the allowlist — two lines above a sentence naming
          // a Markdown file that arrived. The same contradiction, in the shape
          // where the format list is not even the useful advice: what that
          // sender has to change is their client's inline labelling, which the
          // line below tells them, and a format list would send them to convert
          // a file already in a supported format.
          //
          // (The allowlist is spelled out ONCE in this module. A second copy in
          // this comment would break the prose-inventory parity anchor that
          // keeps the sentence honest — see `prose-inventory-parity.test.ts`.)
          unsupportedCount && !inlineDroppedCount
            ? "work-wiki found no email text or supported document attachment. Supported attachments: Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX/XLS, CSV, ZIP, ODT/ODS/ODP, EPUB, MOBI, Org, and RTF."
            : "work-wiki found no email text to ingest.",
          oversizedLine,
          // Retained rather than reachable. Since the per-document ceiling
          // partition runs first, a part that alone exceeds the aggregate budget
          // also exceeds `MAX_EMAIL_DOCUMENT_BYTES` — and the budget is floored
          // at that ceiling by `Math.max` — so the first within-ceiling part is
          // always selected and this exit cannot be reached with an over-budget
          // loss. Kept so the sentence survives if that relationship ever
          // changes; the reachable over-budget report is in the acknowledgement.
          overBudgetLine,
          // Reachable, and the reason this exit needed a fifth sentence: an
          // inline-labelled `.md` with no body reaches exactly here, and used
          // to be answered with the no-text sentence alone (DW-565).
          inlineDroppedLine,
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
    // Countable parts only. `src/app/api/email/ingest/route.ts` derives a
    // `localSkipped` FLOOR from `attachmentNames.length - attachments.length`,
    // so a part named here but never forwarded would be re-reported as a
    // skipped attachment downstream, undoing DW-359 one surface below this one.
    //
    // Which is why an inline-dropped DOCUMENT is COUNTED but not NAMED here: it
    // is in `skippedAttachmentCount` (the route takes the larger of the two
    // figures, so a worker total above the local floor is safe) and it is named
    // to the sender in `inlineDroppedLine`, but adding it to this list would
    // add a phantom skip on top of the real one it already contributes. The two
    // surfaces answer different questions — this one records what travelled,
    // the reply explains what did not.
    //
    // Named through `replyAttachmentName`, the same helper the reply's loss
    // sentences use, so the RECORDED name and the sentence the sender reads
    // agree about what one part is called (DW-454). `filename ||
    // "unnamed attachment"` was a truthiness check: a part named `"   "` was
    // "unnamed attachment" in the sentence and a bare run of spaces in the
    // field recorded beside it — and `sanitizeAttachmentNames` in
    // `src/lib/email-ingest.ts` trims and `.filter(Boolean)`s the recorded
    // names, so that one dropped route-side and the activity history lost a
    // file the sender had just been told about. A CR/LF name diverged the same
    // way, and was recorded with the line breaks still in it.
    //
    // The forwarded `Blob` filename in the loop below is deliberately NOT
    // routed through the helper and stays raw. It is not a display name: its
    // `attachment-${index + 1}` fallback is positional, and the route derives
    // `intakeSourceSlug(file.name)` from it — collapsing several unnamed parts
    // onto one shared "unnamed attachment" would collide those slugs where the
    // positional fallback keeps them distinct. Three surfaces, and only the two
    // that are prose about a file have to agree.
    //
    // Routing through the helper cannot change the LIST'S LENGTH, which is
    // load-bearing: it falls back to `"unnamed attachment"` and so always
    // returns a non-empty string, one name per countable part exactly as the
    // bare `||` did. The route floors its skip count at
    // `Math.max(0, attachmentNames.length - attachments.length,
    // payload.attachments.length - attachments.length)` — two floors, of which
    // this length feeds the first — so a shorter list here would lower that
    // floor and under-report the loss.
    const attachmentNames = countableAttachments
      .map((attachment) => replyAttachmentName(attachment.filename))
      .slice(0, MAX_EMAIL_ATTACHMENT_NAMES_RECORDED);

    // ONE definition, read by both consumers: the forward target below and the
    // acknowledgement's page/ingest links further down. The same expression was
    // written out twice, which is two things to keep in step for no gain — and
    // the second copy was invisible to the suite until DW-363 went looking for
    // it, because every transport assertion read only the first: deleting the
    // acknowledgement's trim shipped green while every sender got a page link
    // with a quadrupled slash in it. DW-451 leaves one definition, so there is
    // nothing left for the two consumers to disagree about.
    const site = (env.YOPEDIA_SITE_URL || "").replace(/\/+$/, "");
    let response: Response;
    try {
      // The guard stays INSIDE the `try`, even though the value no longer is:
      // this `throw` has no bespoke reply of its own — it is caught below,
      // logged as "service binding request failed" and answered with the
      // generic retry sentence. Hoisting it out would change the sender-visible
      // behaviour of a misconfigured worker.
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
      for (const [index, attachment] of supportedAttachments.entries()) {
        const filename = attachment.filename || `attachment-${index + 1}`;
        const source = typeof attachment.content === "string"
          ? new TextEncoder().encode(attachment.content)
          : attachment.content instanceof ArrayBuffer
            ? new Uint8Array(attachment.content)
            : new Uint8Array(
                attachment.content.buffer,
                attachment.content.byteOffset,
                attachment.content.byteLength,
              );
        // Copy into a view whose buffer is definitely an ArrayBuffer: a view
        // over a SharedArrayBuffer is not a valid BlobPart.
        const bytes = new Uint8Array(source.byteLength);
        bytes.set(source);
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
      // The route's own refusal, and then everything this message lost on the
      // way to it (DW-452). Replying with `safeError(result)` alone discarded
      // five sentences the handler had already built: a sender whose message
      // was refused for a reason of the route's own — a read-only wiki, an
      // unavailable queue — heard nothing about the attachments dropped before
      // the forward was even attempted, and re-sending the same message once
      // the route recovered would drop them again in the same silence.
      //
      // The same consts the acknowledgement reads, in the same order, so the
      // two exits cannot describe one message differently. `.filter(Boolean)`
      // is what keeps a no-loss refusal a single bare sentence with no trailing
      // blank lines.
      await reply(
        message,
        subject,
        [
          safeError(result),
          oversizedLine,
          overBudgetLine,
          inlineDroppedLine,
          overCapLine,
          unsupportedLine,
        ]
          .filter(Boolean)
          .join("\n\n"),
      );
      return;
    }

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
      overBudgetLine,
      inlineDroppedLine,
      overCapLine,
      unsupportedLine,
    ].filter(Boolean);
    await reply(message, subject, lines.join("\n\n"));
  },

  async fetch(): Promise<Response> {
    return new Response("yopedia email-ingest ok\n", {
      headers: { "content-type": "text/plain" },
    });
  },
};
