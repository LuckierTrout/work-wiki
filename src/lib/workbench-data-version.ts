/**
 * The consumer half of the `dataVersion` refresh signal: the route the browser
 * polls, the cadence it polls at, and every DECISION the watcher and the Preview
 * column make about what a polled number means.
 *
 * Pure and client-safe, the same rule `workbench-preview.ts` follows — the
 * component imports it in the browser and the node suite executes it. That is
 * the whole reason these are functions rather than conditions typed into an
 * effect: vitest runs `environment: "node"` and this repo has no DOM test
 * environment, so a comparison written inside `DataVersionWatcher` could only
 * ever be grepped for, and "refresh when it moved forward" is exactly the kind
 * of rule a rewrite keeps the wording of while changing the behaviour.
 *
 * There is no React here, no storage, and `fetch` is a parameter — the suite
 * drives it with a stub and never opens a socket.
 */

import { isSameSelection, type TreeSelection } from "./workbench-tree";

// ---------------------------------------------------------------------------
// The route and the cadence
// ---------------------------------------------------------------------------

/** The gated read. One place, so the route and its one caller cannot drift. */
export const DATA_VERSION_ROUTE = "/api/workbench/version";

/**
 * Re-poll cadence while the tab is VISIBLE — a hidden tab does not poll at all.
 *
 * The same order of magnitude as the sidecar probe (15s): the answer is one
 * integer from KV, and the owner's own save does not wait for a tick anyway
 * (it calls {@link requestDataVersionCheck}). This cadence only has to cover
 * writes made from somewhere else — a CLI run, an agent, another tab.
 */
export const DATA_VERSION_POLL_MS = 10_000;

// ---------------------------------------------------------------------------
// Reading it
// ---------------------------------------------------------------------------

/** The subset of a `Response` this module reads. */
export interface DataVersionResponseLike {
  ok: boolean;
  json: () => Promise<unknown>;
}

/** The subset of `fetch` this module calls. The global satisfies it. */
export type DataVersionFetch = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<DataVersionResponseLike>;

/**
 * What one poll produced.
 *
 * `stale` (the caller aborted — a newer run started, or the watcher unmounted)
 * and `unavailable` (401, 500, a body that is not `{ dataVersion: <integer> }`,
 * a transport failure) are deliberately separate from each other and both
 * separate from `ok`, because only `ok` may ever reach a comparison. Neither
 * failure carries a message: nothing about this signal is ever shown to the
 * owner, so there is no sentence for a transport string to leak into.
 */
export type DataVersionResult =
  | { status: "ok"; version: number }
  | { status: "stale" }
  | { status: "unavailable" };

/**
 * Is this parsed body the answer the route promises?
 *
 * A 200 is not a promise about shape. `{ dataVersion: "4" }` would compare
 * `"4" > 3` as `true` today and `"10" > 9` as `false` tomorrow, so the type is
 * checked rather than trusted — the same rule `isPreviewPayload` follows for the
 * same reason.
 */
function servedVersion(value: unknown): number | null {
  if (!value || typeof value !== "object") return null;
  const version = (value as Record<string, unknown>).dataVersion;
  if (typeof version !== "number") return null;
  if (!Number.isInteger(version)) return null; // covers NaN and Infinity
  return version >= 0 ? version : null;
}

/**
 * Poll the route once.
 *
 * The abort check is made TWICE — when the response lands and after the body is
 * parsed — because both awaits are points at which a newer run may have started
 * or the watcher may have unmounted, and a `router.refresh()` from a superseded
 * run is a render nobody asked for.
 */
export async function fetchDataVersion(
  signal: AbortSignal,
  fetchImpl: DataVersionFetch = fetch,
): Promise<DataVersionResult> {
  try {
    const response = await fetchImpl(DATA_VERSION_ROUTE, { signal });
    if (signal.aborted) return { status: "stale" };
    if (!response.ok) return { status: "unavailable" };
    const body: unknown = await response.json();
    if (signal.aborted) return { status: "stale" };
    const version = servedVersion(body);
    return version === null ? { status: "unavailable" } : { status: "ok", version };
  } catch {
    // An abort is the caller's own doing; anything else is a real failure, and
    // neither is worth telling the owner about — a poll that could not answer
    // simply means no refresh this tick.
    return signal.aborted ? { status: "stale" } : { status: "unavailable" };
  }
}

// ---------------------------------------------------------------------------
// The two decisions
// ---------------------------------------------------------------------------

/**
 * Does this polled version warrant re-running the server render?
 *
 * FORWARD-ONLY. KV is eventually consistent, so a poll can legitimately answer
 * a value LOWER than the one the server rendered with; treating any inequality
 * as a change would refresh on the stale read and then again on the fresh one.
 *
 * `refreshedFor` guards the opposite failure. If `page.tsx`'s own read degrades
 * to `0` while the route answers `7`, the served baseline never catches up — and
 * an unguarded watcher would call `router.refresh()` on every single poll,
 * forever. Refreshing at most once per observed version bounds that to one
 * wasted render.
 */
export function shouldRefreshForDataVersion(input: {
  served: number;
  polled: number;
  refreshedFor: number;
}): boolean {
  return input.polled > input.served && input.polled > input.refreshedFor;
}

/** What the Preview's effect should do on this run. */
export interface PreviewFetchPlan {
  /** Read the selection's bytes again. */
  fetch: boolean;
  /** Discard the payload, the editor, the draft and the confirm state first. */
  reset: boolean;
  /**
   * The row the column should now record as the one it has read bytes for —
   * `next` when this run fetches, and the UNCHANGED `shown` when it does not.
   *
   * Returned rather than assigned by the caller on purpose. "Compare the shown
   * row to the next one, THEN record the next one" is an ordering, and an
   * ordering held only by two adjacent statements in an effect is one tidy-up
   * away from being reversed: hoisting the assignment above the comparison
   * makes every run look like the same row, so picking another row while the
   * editor is open would keep row A's bytes and A's open draft under row B's
   * header — with every source scan still passing. Handing the answer back
   * leaves no assignment to hoist.
   */
  shown: TreeSelection | null;
}

/**
 * Why the Preview's effect is re-running, and therefore what it may touch.
 *
 * The effect is keyed on `[selection, dataVersion, editing]`, and its first act
 * used to be discarding the editor and the draft — right for a new row, and
 * catastrophic for a bump that lands while the owner is mid-edit. Three
 * outcomes, one function:
 *
 * - a different row: fetch AND reset, exactly as before — a pick abandons the
 *   editor, which is what `save`'s own slug check also refuses to work around;
 * - the same row while the editor is open: nothing at all, so the draft, the
 *   editor and the confirm state are untouched. `editing` is in the deps so
 *   that closing the editor lets the deferred read happen;
 * - the same row, idle: fetch WITHOUT reset — a silent refresh that leaves
 *   `loading` and the current payload alone, so a write somewhere else does not
 *   flash `Loading…` at an owner who is reading.
 *
 * `shown` is the row the last read was FOR and `next` is the row the effect is
 * running for now; the equality between them is `isSameSelection`, the shell's
 * one rule, applied here rather than at the call site.
 */
export function previewFetchPlan(input: {
  shown: TreeSelection | null;
  next: TreeSelection;
  editing: boolean;
}): PreviewFetchPlan {
  if (!isSameSelection(input.shown, input.next)) {
    return { fetch: true, reset: true, shown: input.next };
  }
  if (input.editing) return { fetch: false, reset: false, shown: input.shown };
  return { fetch: true, reset: false, shown: input.next };
}

// ---------------------------------------------------------------------------
// The nudge
// ---------------------------------------------------------------------------
//
// Two refresh paradigms is the state this story exists to end, so the Preview's
// own save no longer calls `router.refresh()`. But a save whose trees only catch
// up on the next poll tick is a visible regression, so the column asks the
// watcher to check NOW. The ANSWER still comes from the server's integer — this
// is a nudge, not a claim that the write landed.

const listeners = new Set<() => void>();

/**
 * Run `listener` whenever something asks for an immediate check. Returns the
 * unsubscribe, which the watcher calls from its effect cleanup — without it a
 * remounted shell would accumulate watchers that each refresh.
 */
export function subscribeDataVersionCheck(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Ask every subscribed watcher to poll now. */
export function requestDataVersionCheck(): void {
  // A copy, so a listener that unsubscribes itself cannot skip its neighbour,
  // and a try/catch per listener, so one throwing watcher does not silently
  // strand the others. Nothing is logged: this module is client-safe and there
  // is no surface on which a refresh nudge failing means anything to the owner.
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch {
      // Deliberately ignored — see above.
    }
  }
}

/** Drop every listener. **Test-only**, so files cannot leak state into each other. */
export function _resetDataVersionListeners(): void {
  listeners.clear();
}
