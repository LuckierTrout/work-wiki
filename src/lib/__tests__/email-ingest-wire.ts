/**
 * How many bytes a base64-encoded MIME part body occupies *on the wire*.
 *
 * Shared, not duplicated, because two suites need the same formula and a second
 * copy could drift from the first: `email-ingest-allowlist-parity.test.ts`
 * measures a full-size document against the Worker's raw-message cap, and
 * `email-ingest-worker.test.ts` calibrates this prediction against the actual
 * byte length of a fixture built by its own `multipartEmail` builder. Without
 * that calibration the formula could quietly stop describing how mail is really
 * encoded while both assertions stayed green.
 *
 * RFC 2045: 4 characters per 3 bytes, wrapped at 76 characters, CRLF after every
 * line including the last.
 *
 * Deliberately not a `*.test.ts` file — vitest's
 * `src/{@literal **}/__tests__/{@literal **}/*.test.ts` include does not collect
 * it, so it contributes a helper rather than a second copy of someone's suite.
 */
export function base64PartWireSize(byteLength: number): number {
  const chars = Math.ceil(byteLength / 3) * 4;
  return chars + 2 * Math.ceil(chars / 76);
}

/**
 * How many bytes a WORST-CASE quoted-printable MIME part body occupies *on the
 * wire* — every octet written as an `=XX` escape, which is what a byte-dense
 * `text/*` attachment or a non-ASCII body really approaches.
 *
 * Shared, not duplicated, for the same reason `base64PartWireSize` is: the
 * parity suite measures a full-size document against the Worker's raw-message
 * cap with it, and `email-ingest-worker.test.ts` calibrates it against the byte
 * length of a real quoted-printable part built by its own `multipartEmail`
 * builder. A second copy could drift from the first while both stayed green.
 *
 * RFC 2045 §6.7: `=XX` is 3 characters and may not be split across a line break,
 * and a line may not exceed 76 characters. So a line carries at most 25 escapes
 * — 75 characters — plus the `=` soft line break, then CRLF: 78 wire bytes per
 * 25 payload bytes. A short final line pays `remainder * 3` characters, its own
 * soft break and a CRLF.
 *
 * Every line ends in a soft break, the last one included, because the CRLF that
 * precedes the MIME boundary is otherwise a *hard* line break — a literal CRLF
 * appended to the decoded payload. `email-ingest-worker.test.ts` shows this at
 * the Worker's real decoder: without the trailing soft break PostalMime hands
 * back the payload plus a stray `\n`. That costs exactly one byte more than the
 * "final full line needs no soft break" shape, and it is the shape a client
 * sending a file with no trailing newline actually writes.
 *
 * `escapesPerLine` is how many escapes the sender packs into a line. 25 fills
 * the 76-character budget and is the default; a CONFORMING encoder may wrap
 * narrower, which costs MORE, not less — a line is `3k + 3` wire bytes for `k`
 * escapes, so the per-byte ratio `(3k + 3) / k` rises as `k` falls (3.12 at 25,
 * 3.125 at 24, 3.1304 at 23). The parity suite uses the parameter to pin how far
 * down the Worker's envelope headroom actually reaches.
 *
 * Counts the CRLF that terminates the last line, exactly as
 * `base64PartWireSize` does.
 */
export function quotedPrintablePartWireSize(byteLength: number, escapesPerLine = 25): number {
  // `3k` escape characters + the `=` soft break + CRLF.
  const lineWireSize = escapesPerLine * 3 + 3;
  const fullLines = Math.floor(byteLength / escapesPerLine);
  const remainder = byteLength % escapesPerLine;
  // Zero bytes needs no special case: it is zero full lines and no remainder.
  return remainder === 0 ? fullLines * lineWireSize : fullLines * lineWireSize + remainder * 3 + 3;
}
