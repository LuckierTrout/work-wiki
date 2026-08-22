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
 * They do NOT carry their own verdict: the resolve-style write clients they call
 * (`savePreviewBody`, `revertArtifactRevision`, `saveWorkbenchSettings`) route
 * their non-ok and thrown branches through {@link refusedWriteFailure} and
 * {@link thrownWriteFailure} here, so every workbench write — whoever armed the
 * signal — reports an unknown outcome in the SAME sentence (DW-374/375/376).
 */

/**
 * A request that never settles would leave the caller's in-flight flag true for
 * the rest of the session and its controls disabled with no error to explain
 * it. `finally` cannot rescue a promise that never resolves, so the deadline is
 * the rescue.
 */
export const REQUEST_TIMEOUT_MS = 15_000;

/**
 * A non-2xx, carrying the STATUS as a fact rather than as a rendering of one.
 *
 * `send` used to throw a bare `Error`, so the only trace of the status left in
 * the system was the text `Request failed (504)` — and the classifier below
 * cannot tell a gateway giving up from the route's own refusal by reading a
 * sentence. Re-deriving the fact from its rendering is how the two come apart
 * the first time somebody rewords the copy, so the status rides the error.
 *
 * The MESSAGE is unchanged: the server's own sentence when it supplied one, and
 * the same `Request failed (n)` when it did not.
 */
export class RequestFailedError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "RequestFailedError";
    this.status = status;
  }
}

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
  if (!response.ok) {
    throw new RequestFailedError(
      body.error || `Request failed (${response.status})`,
      response.status,
    );
  }
  return body;
}

/**
 * {@link send}'s sibling for a MULTIPART body — a file upload.
 *
 * It cannot be a `send` call with a `FormData` init: that helper's whole
 * invariant is a JSON `Content-Type` header, and a multipart request needs the
 * boundary parameter the browser generates. Setting the label by hand produces a
 * body no server can parse, and making the header optional in `send` would give
 * away the invariant its docblock promises for every other caller.
 *
 * SO THE HEADER IS THE ONLY DIFFERENCE. The deadline, the `{ error }` sentence
 * and the {@link RequestFailedError} carrying the status are all `send`'s
 * verbatim, which is what keeps a failed upload reported in the same words as
 * every other Workbench write (via {@link writeFailure}). Content type is left
 * UNSET rather than assigned: `fetch` fills it in from the `FormData` body,
 * boundary included.
 */
export async function sendForm<T>(url: string, body: FormData): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const parsed = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) {
    throw new RequestFailedError(
      parsed.error || `Request failed (${response.status})`,
      response.status,
    );
  }
  return parsed;
}

/**
 * The statuses that mean NOBODY ANSWERED — not "the route said no".
 *
 * The rule is not "5xx" and not "anything a proxy can emit": it is whether an
 * ORIGIN GAVE THIS ANSWER. A 502 is a proxy reporting that it could not get a
 * usable reply out of the origin, and a 504 that it gave up waiting for one — no
 * route composed either, and the origin may have applied the write in full
 * before the proxy stopped listening.
 *
 * 503 IS DELIBERATELY NOT HERE, and it is the interesting one. A generic proxy
 * emits 503 too, but THIS APP'S OWN ROUTES emit it as a definite refusal:
 * `PUT /api/settings` answers 503 with `CONFIG_UNREADABLE_COPY` when the
 * store cannot be read, and refuses BEFORE merging anything, so nothing was
 * written (`src/app/api/settings/route.ts`'s `configUnreadable`); the batch
 * ingest route answers 503 the same way. Reading those as silence would discard
 * an arrived, actionable sentence, tell the owner the outcome is unknown, and
 * send `SettingsCanvas` to clear the version it was holding — all for a write
 * that provably did not land. A status this codebase itself uses as a verdict
 * cannot also be read as the absence of one.
 *
 * Deliberately NOT 4xx and NOT a plain 500 either: those are the route's OWN
 * answer — it ran, it decided, and it said so. Calling them unknown would send
 * the owner to reconcile a screen that is already correct.
 */
export const UNCONFIRMED_STATUSES: readonly number[] = [502, 504];

/** Is this response status one nobody's verdict reached us through? */
export function unconfirmedStatus(status: number): boolean {
  return UNCONFIRMED_STATUSES.includes(status);
}

/**
 * Is this THROWN cause one that leaves the write's outcome unknown?
 *
 * Three shapes, one rule — the request left and no verdict came back:
 *
 *   - both abort flavours (`TimeoutError` from `AbortSignal.timeout`,
 *     `AbortError` from an explicit abort). The request was abandoned on THIS
 *     side; the server may have applied it in full, in part, or not at all.
 *   - a `TypeError`, which is the only thing `fetch` rejects with when the
 *     connection itself fails: `Failed to fetch`, `NetworkError when attempting
 *     to fetch resource`, `Load failed` — one per engine, all the same fact.
 *     The bytes may well have arrived before the socket went away.
 *   - a {@link RequestFailedError} carrying one of {@link UNCONFIRMED_STATUSES}
 *     — 502 or 504, and NOT 503, for the reason that constant states in full.
 */
export function unconfirmedCause(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  if (cause.name === "TimeoutError" || cause.name === "AbortError") return true;
  if (cause instanceof RequestFailedError) return unconfirmedStatus(cause.status);
  return cause instanceof TypeError;
}

/**
 * THE unconfirmed sentence. One phrasing for every surface and every cause.
 *
 * Makes NO claim about a refresh. The reconciliation is the caller's
 * `if (unconfirmed) …`, and this helper causes no side effect at all — a
 * sentence announcing one would be false wherever a caller forgot it, and
 * past-tense at a moment when the refetch has not landed even where they did
 * not. What it can honestly do is send the owner to the screen rather than to
 * the button they just pressed.
 *
 * Widened past "ran out of time" deliberately: it now has to be true of a fired
 * deadline, a dropped connection and a gateway that gave up alike, so it speaks
 * about the MISSING CONFIRMATION rather than about any one mechanism. No
 * transport vocabulary — no Copy table contains any.
 */
export function unconfirmedWriteMessage(action: string): string {
  return (
    `Nothing came back to confirm whether the attempt to ${action} went ` +
    `through, so the outcome is unknown. Check what the screen shows before ` +
    `trying again.`
  );
}

/** What a failed write is, and what to say about it. */
export interface WriteFailure {
  /** The sentence to put in front of the owner. */
  message: string;
  /**
   * NOTHING IS KNOWN about the write: it may have landed in full.
   *
   * Three ways in, one meaning — the deadline fired, the connection dropped, or
   * a gateway answered instead of the route (see {@link unconfirmedCause}). In
   * every one of them the request left and no verdict came back, so the server
   * may have applied it in full, in part, or not at all.
   *
   * A caller that sees this MUST reconcile — `router.refresh()`, a re-list, or
   * dropping a precondition it can no longer trust — and must never tell the
   * owner the write failed. Leaving a stale render behind a message the owner
   * would reasonably read as "nothing happened" is the whole defect.
   */
  unconfirmed: boolean;
}

/**
 * What to show the owner, and whether the write's outcome is even known
 * (DW-283, DW-374).
 *
 * For callers of {@link send}, which throws the SERVER's own sentence — so
 * relaying a thrown message is right here and wrong in {@link thrownWriteFailure}.
 *
 * `action` is ONE phrase per call site — "create the wiki", "apply the
 * template", "switch wiki", "rename the wiki", "delete the wiki" — and both
 * sentences are composed from it here. One owner for the verdict rather than a
 * per-caller guess, and one phrase rather than a pair of sentences typed out
 * beside each other, which is how the two would drift.
 *
 * Three outcomes:
 *
 *   - nothing answered. A fired deadline, a dropped connection, or a gateway
 *     that gave up ({@link unconfirmedCause}) — the request left and no verdict
 *     came back. This used to be reported as a flat `Couldn’t …`, or worse as
 *     `Failed to fetch` and `Request failed (504)`, all of which are claims
 *     about the SERVER that the client is in no position to make.
 *   - the route answered with a reason. That message wins, exactly as before.
 *   - anything else. The caller's own sentence, exactly as before.
 */
export function writeFailure(cause: unknown, action: string): WriteFailure {
  if (unconfirmedCause(cause)) {
    return { message: unconfirmedWriteMessage(action), unconfirmed: true };
  }
  if (cause instanceof Error && cause.message) {
    return { message: cause.message, unconfirmed: false };
  }
  return { message: `Couldn’t ${action}.`, unconfirmed: false };
}

/**
 * The same verdict for a client that CAUGHT its own `fetch` — and that must
 * never relay the caught message.
 *
 * {@link send} throws the server's sentence, so {@link writeFailure} relays it.
 * `savePreviewBody`, `revertArtifactRevision` and `saveWorkbenchSettings` do
 * not: they RETURN the server's sentence from the response body and only ever
 * THROW on transport, so a thrown message there is `Failed to fetch` or
 * `signal timed out` — exactly the vocabulary those docblocks already refuse.
 * `fallback` is the Copy table's sentence for that surface.
 */
export function thrownWriteFailure(
  cause: unknown,
  action: string,
  fallback: string,
): WriteFailure {
  if (unconfirmedCause(cause)) {
    return { message: unconfirmedWriteMessage(action), unconfirmed: true };
  }
  return { message: fallback, unconfirmed: false };
}

/**
 * The verdict on a non-2xx a resolve-style client read the STATUS of directly.
 *
 * `served` is the trimmed `{ error }` sentence the body carried, or `""` for a
 * body that would not parse, carried no key, or carried a blank one. On a
 * gateway status the body is IGNORED: whatever a proxy put in it, it is not the
 * route's verdict, and the owner needs to be told the outcome is unknown rather
 * than handed a proxy's error page.
 */
export function refusedWriteFailure(
  status: number,
  served: string,
  action: string,
  fallback: string,
): WriteFailure {
  if (unconfirmedStatus(status)) {
    return { message: unconfirmedWriteMessage(action), unconfirmed: true };
  }
  return { message: served || fallback, unconfirmed: false };
}
