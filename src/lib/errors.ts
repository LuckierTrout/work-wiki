/**
 * Extract a human-readable message from an unknown caught value.
 *
 * Handles Error instances, plain strings, and falls back to a default message
 * for anything else (null, undefined, numbers, objects, etc.).
 */
export function getErrorMessage(
  error: unknown,
  fallback = "An unexpected error occurred",
): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return fallback;
}

/**
 * A caller-supplied-input error (bad/oversized/unsafe input) that a route
 * should surface as a 4xx, distinct from a server-side failure. Lets routes
 * classify by type rather than by string-matching the message.
 */
export class ClientInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClientInputError";
  }
}

/**
 * Whether a caught value is a caller-input fault.
 *
 * Matches on `name`, not `instanceof`: a `ClientInputError` thrown by a SECOND
 * copy of this module — vitest's two projects, a bundler splitting server and
 * edge chunks, the stdio MCP entry compiled separately — fails `instanceof`
 * against the copy the route imported, and the caller's 400 would silently
 * become a 500 in production only, where no test can see it. So the check is
 * structural on purpose; `errors.test.ts` pins it against a foreign error
 * object. The same reasoning, and the same shape, as
 * {@link import("./read-only").isReadOnlyError}.
 *
 * `instanceof Error` is proven BEFORE `name` is read, for the reason
 * {@link isInfrastructureFault} documents: the caught value in a route's catch
 * block is arbitrary, and a property read on it can itself throw.
 *
 * Narrows to `Error`, not to `ClientInputError`: under a duplicated graph the
 * value genuinely is NOT an instance of the imported class, so claiming that
 * type would be a lie — while `Error` is both true and enough to read
 * `.message` off it under `strict`.
 */
export function isClientInputError(err: unknown): err is Error {
  return err instanceof Error && err.name === "ClientInputError";
}

/**
 * A stored-artifact fault: the bytes we persisted are unreadable, wrong-shaped,
 * or the filesystem refused us. Always a server fault (5xx), never the
 * caller's, and repairable in place. The mirror image of
 * {@link ClientInputError}: it lets a route classify by type rather than by
 * string-matching a message that may read like the caller's mistake.
 *
 * Extends `Error` directly and subclasses nothing, so an existing
 * `instanceof` ladder that ends in a bare 500 keeps returning 500 for it.
 */
export class StoreFaultError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "StoreFaultError";
  }
}

/**
 * Check whether an unknown caught value is a fault in the INFRASTRUCTURE
 * beneath us — one we threw as a {@link StoreFaultError}, or ANY Node errno
 * failure, off the filesystem or off the network. Never the caller's input.
 *
 * The errno branch is the load-bearing half (DW-481): `EINVAL: invalid
 * argument, open '…'` never passes through our code as a typed throw, so no
 * amount of retyping in the store modules would catch it. Its sentence reads
 * like "invalid" input, which is exactly how a message-matching route ladder
 * mistook a broken disk for the caller's own 400. Probing the errno `code` is
 * the same shape {@link isEnoent} uses one function down.
 *
 * THE NAME SAYS "INFRASTRUCTURE", NOT "STORE", BECAUSE THE PROBE IS SHAPED,
 * NOT ENUMERATED (DW-685). The pattern reads the errno's SHAPE, so a socket's
 * `ECONNREFUSED` / `ETIMEDOUT` / `ECONNRESET` answers `true` here exactly as
 * the disk's `EINVAL` does. That answer is CORRECT — a refused socket is ours
 * to repair and deserves the same 500-plus-bounded-retry as a refused disk —
 * but under the old name it sent an operator to the filesystem for a fault
 * that was never there.
 *
 * TWO LIMITS, both deliberate and both pre-existing; this pass renamed the
 * predicate, it did not re-scope it.
 *
 * 1. The errno must sit on the CAUGHT VALUE ITSELF. A raw socket or DNS
 *    rejection carries it there and matches. Node's `fetch` does not: undici
 *    rejects with `TypeError: fetch failed` and keeps the errno one level down
 *    on `.cause`, so a fetch-shaped network failure answers `false` and lands
 *    on the generic transient 500 at the bottom of a route's ladder — the same
 *    500, reached by fall-through. Unwrapping `cause` would change what this
 *    predicate answers, which is a behaviour change nothing has asked for.
 * 2. `/^E[A-Z0-9]+$/` has no `_` in its class, so codes that carry one —
 *    `EAI_AGAIN` off `getaddrinfo`, the whole `ERR_FS_*` family — do NOT
 *    match. That under-claim is the other half of DW-685, and it is why
 *    narrowing to a storage-errno allowlist was considered and rejected: an
 *    allowlist must enumerate every storage errno and would still miss
 *    `ERR_FS_*`, trading one wrong answer for another. Of the two halves, only
 *    the NAME was wrong for every code the probe does match; the verdict for
 *    those was right, and still is.
 */
export function isInfrastructureFault(error: unknown): boolean {
  if (error instanceof StoreFaultError) return true;
  // `instanceof Error` is proven BEFORE `code` is read: this classifier runs
  // inside a route's catch block, where the caught value is arbitrary, and a
  // property read on it can itself throw (a getter on a hostile or exotic
  // object). A classifier that throws would replace the fault being reported
  // with a second, unrelated one.
  if (!(error instanceof Error)) return false;
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code);
}

/** Check whether an unknown caught value is a Node.js ENOENT (file-not-found) error. */
export function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error &&
    "code" in err &&
    (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}
