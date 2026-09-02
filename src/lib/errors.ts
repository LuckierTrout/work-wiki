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
 * {@link isStoreFault} documents: the caught value in a route's catch block is
 * arbitrary, and a property read on it can itself throw.
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
 * Check whether an unknown caught value is a storage fault — one we threw as a
 * {@link StoreFaultError}, or a Node errno failure off the filesystem itself.
 *
 * The errno branch is the load-bearing half (DW-481): `EINVAL: invalid
 * argument, open '…'` never passes through our code as a typed throw, so no
 * amount of retyping in the store modules would catch it. Its sentence reads
 * like "invalid" input, which is exactly how a message-matching route ladder
 * mistook a broken disk for the caller's own 400. Probing the errno `code` is
 * the same shape {@link isEnoent} uses one function down.
 */
export function isStoreFault(error: unknown): boolean {
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
