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
