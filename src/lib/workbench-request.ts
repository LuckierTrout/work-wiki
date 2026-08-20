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
 * timeout-message fallback is what stops the two halves drifting again.
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

/**
 * What to show the owner. A timeout's own message ("signal timed out") names
 * the mechanism rather than the thing that failed, so those fall back to the
 * caller's sentence; a server-supplied message is always preferred.
 */
export function failureMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error) {
    if (cause.name === "TimeoutError" || cause.name === "AbortError") return fallback;
    if (cause.message) return cause.message;
  }
  return fallback;
}
