/**
 * The one JSON request helper the workbench's client components share.
 *
 * It began inside `WikiSwitcher.tsx` and was copied — badly — into
 * `WikiWorkbench.tsx`. The copy armed no deadline at all, which was the live
 * defect: a hung create or re-template stranded that card's `busy` flag for the
 * rest of the session, with no message to explain it. It also spread `...init`
 * AFTER `headers`, which was not yet costing anything — neither call site
 * passed `headers`, so the JSON label was always sent — but it made the content
 * type a default any future caller could silently replace. One owner for the
 * deadline, the JSON content type, the `...init` FIRST spread order and the
 * verdict on a failed write is what stops the two halves drifting again.
 *
 * Pure and client-safe (no `node:` imports, no storage) so a `"use client"`
 * component can import it directly.
 *
 * `SettingsCanvas.tsx` and `PreviewColumn.tsx` still carry their own deadlines:
 * both need the AbortController itself (one composes a caller signal, the other
 * cancels a superseded read), which this helper deliberately does not expose.
 */

/**
 * A request that never settles would leave the caller's in-flight flag true for
 * the rest of the session and its controls disabled with no error to explain
 * it. `finally` cannot rescue a promise that never resolves, so the deadline is
 * the rescue.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

export async function send<T>(url: string, init: RequestInit): Promise<T> {
  // `init` FIRST: both of the fields below are invariants of this helper, and
  // spreading the caller over them would let a future call silently drop the
  // JSON content type or the deadline the comment above promises.
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init.headers },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

/** What a failed write is, and what to say about it. */
export interface WriteFailure {
  /** The sentence to put in front of the owner. */
  message: string;
  /**
   * The deadline fired, so NOTHING IS KNOWN about the write.
   *
   * The request was abandoned on this side; the server may have applied it in
   * full, in part, or not at all. A caller that sees this must reconcile the
   * screen — `router.refresh()` — rather than leave a stale render behind a
   * message the owner would reasonably read as "nothing happened".
   */
  unconfirmed: boolean;
}

/**
 * What to show the owner, and whether the write's outcome is even known
 * (DW-283).
 *
 * `action` is ONE phrase per call site — "create the wiki", "apply the
 * template", "switch wiki", "rename the wiki", "delete the wiki" — and both
 * sentences are composed from it here. One owner for the verdict rather than a
 * per-caller guess, and one phrase rather than a pair of sentences typed out
 * beside each other, which is how the two would drift.
 *
 * Three outcomes, and only the first is new:
 *
 *   - the client deadline fired. `send` arms `AbortSignal.timeout`, and both
 *     abort flavours arrive as an error whose `name` is the whole signal — the
 *     message names the MECHANISM ("signal timed out", "This operation was
 *     aborted"), never the thing the owner was trying to do. This used to be
 *     reported as a flat `Couldn’t …`, which is a claim about the server that
 *     the client is in no position to make: the request left, and nothing came
 *     back to say what became of it.
 *   - the route answered with a reason. That message wins, exactly as before.
 *   - anything else. The caller's own sentence, exactly as before.
 */
export function writeFailure(cause: unknown, action: string): WriteFailure {
  const failed = `Couldn’t ${action}.`;
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") {
      return {
        // Makes NO claim about a refresh. The reconciliation is the caller's
        // `if (unconfirmed) router.refresh()`, and this helper causes no side
        // effect at all — a sentence announcing one would be false wherever a
        // caller forgot it, and past-tense at a moment when the refetch has not
        // landed even where they did not. What it can honestly do is send the
        // owner to the screen rather than to the button they just pressed.
        message:
          `The request to ${action} ran out of time before answering, so whether ` +
          `it went through is unknown. Check what the screen shows before trying ` +
          `again.`,
        unconfirmed: true,
      };
    }
    if (cause.message) return { message: cause.message, unconfirmed: false };
  }
  return { message: failed, unconfirmed: false };
}
