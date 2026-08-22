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
 * The BUDGET for one observed version, in wall-clock ms.
 *
 * A retry goes out only while the refreshes ALREADY issued for that version
 * span LESS than `WINDOW - SETTLE`. That span is read at the MOMENT OF THE
 * DECISION, so it bounds when a refresh may be issued, not the span a version
 * ends up with: a refresh at `t`, an hour hidden, and the retry it is still
 * owed leaves an achieved span of an hour. The COUNT is bounded either way —
 * see {@link dataVersionRefreshPlan}.
 *
 * Wall clock rather than a count of qualifying polls, and this is DW-377. The
 * old bound counted POLLS, so its meaning moved with the cadence and with how
 * many triggers fired: `run()` has three of them — the
 * {@link DATA_VERSION_POLL_MS} interval, `visibilitychange` back to visible and
 * the save nudge ({@link requestDataVersionCheck}) — and three alt-tabs or
 * three saves in a second spent the whole budget in milliseconds, re-stranding
 * exactly the lagged bump the retry exists to catch.
 *
 * Deliberately NOT derived from {@link DATA_VERSION_POLL_MS}: changing the
 * cadence must change neither bound. 30s covers the narrow window where the
 * route's read and `page.tsx`'s read disagree because they hit different
 * replicas — both go through the same Worker, so that window is short —
 * without making a genuinely degraded read expensive.
 *
 * The budget is spent by the REFRESHES ISSUED for a version, never by elapsed
 * wall clock: see {@link dataVersionRefreshPlan}.
 */
export const DATA_VERSION_REFRESH_WINDOW_MS = 30_000;

/**
 * How long a refresh is given to LAND before a repeat answer is read as "the
 * re-render did not catch up", in wall-clock ms.
 *
 * `router.refresh()` returns `void` and its render arrives asynchronously, so
 * "still rendering" is not observable from here; elapsed time is the honest
 * proxy. Within this interval of the last refresh for the SAME version, another
 * poll answering that version is declined — the in-flight guard DW-377 asks
 * for, spelled in the rule rather than in the watcher, so the node suite can
 * execute it and so `DataVersionWatcher.tsx` keeps owning no policy.
 *
 * Not derived from {@link DATA_VERSION_POLL_MS} either, though both are 10_000
 * today: that is tuning, not derivation. The watcher stamps the clock when a
 * poll ANSWERS, so consecutive ticks are a cadence apart plus latency jitter
 * and a retry can slip one tick when the later poll answers faster. That slip
 * COSTS a retry rather than merely delaying it, and the equality is tolerable
 * for that reason and not in spite of it: with latency alternating 200ms and
 * 150ms two answers land 9_950ms apart, the tick is declined as still in
 * flight, and the whole 20_000ms to the next eligible answer is then charged to
 * the span — so that version is refreshed for twice, not three times. Fewer
 * refreshes is the SAFE direction; the failure this bounds is the loop.
 */
export const DATA_VERSION_REFRESH_SETTLE_MS = 10_000;

/**
 * The refreshes already issued for one polled version.
 *
 * `version` is the number refreshes were issued FOR (not the number served),
 * and it is a HIGH-WATER MARK — a backwards read can never rewrite it down.
 * `firstRefreshAt` and `lastRefreshAt` are the wall-clock stamps of the first
 * and most recent refresh issued for that version; their SPAN is what the
 * budget is measured against. Ref state in the watcher, so it resets on remount
 * and is never persisted anywhere.
 */
export interface DataVersionRefreshState {
  readonly version: number;
  readonly firstRefreshAt: number;
  readonly lastRefreshAt: number;
}

/**
 * Nothing has been refreshed for yet. The watcher's ref seed.
 *
 * FROZEN, because this exact object is handed into every mounted watcher's ref
 * and is also what several branches of the rule below hand straight back. The
 * `readonly` markers are erased at build time; one stray
 * `state.lastRefreshAt = now` anywhere would otherwise mutate the seed shared
 * by every watcher in the tab.
 */
export const NO_DATA_VERSION_REFRESH: DataVersionRefreshState = Object.freeze({
  version: 0,
  firstRefreshAt: 0,
  lastRefreshAt: 0,
});

/** What the watcher should do with this poll, and what it should remember. */
export interface DataVersionRefreshPlan {
  /** Call `router.refresh()`. */
  readonly refresh: boolean;
  /**
   * The refresh state the watcher should now hold — returned rather than
   * computed by the caller, for the reason {@link PreviewFetchPlan.shown}
   * spells out: "compare, THEN record" is an ordering, and an ordering held by
   * two adjacent statements in an effect is one tidy-up away from being
   * reversed. Every branch below returns the state that branch should leave
   * behind, so the assignment can sit ABOVE the guard and there is nothing left
   * to hoist.
   */
  readonly state: DataVersionRefreshState;
}

/**
 * Does this polled version warrant re-running the server render — again?
 *
 * FORWARD-ONLY, first. KV is eventually consistent, so a poll can legitimately
 * answer a value LOWER than the one the server rendered with; treating any
 * inequality as a change would refresh on the stale read and then again on the
 * fresh one. A polled value at or below `served` is never a change.
 *
 * BOUNDED RETRY, second, and this is DW-48. `router.refresh()` re-runs the
 * server render, but nothing guarantees THAT render's own `readDataVersion()`
 * sees the bump the poll just saw: a replica lagging by one read answers the
 * pre-bump integer, the new baseline lands behind the version refreshed for,
 * and a watcher that recorded "done with 4" would then sit stale until the next
 * write. So the state records what was REFRESHED FOR, and while the served
 * baseline has not caught up a later poll tries again.
 *
 * THE IN-FLIGHT GUARD, third, and this is DW-377. A repeat answer within
 * {@link DATA_VERSION_REFRESH_SETTLE_MS} of the last refresh for that same
 * version is not evidence that the re-render failed to catch up — it is
 * evidence that the re-render has not landed YET. Declining it costs nothing
 * (a later poll past the interval still retries) and it is what makes the
 * budget independent of the trigger rate: a burst of saves, alt-tabs and
 * interval ticks all arrive inside one settle interval and spend nothing.
 *
 * THE BUDGET IS SPENT BY REFRESHES ISSUED, not by elapsed time. Giving up is
 * `state.lastRefreshAt - state.firstRefreshAt >= WINDOW - SETTLE` — the SPAN of
 * the refreshes actually issued — and never `now - state.firstRefreshAt >=
 * WINDOW`. A hidden tab issues nothing (the watcher stops polling entirely), a
 * sleeping machine issues nothing, and a forward clock correction is evidence
 * of nothing; time the watcher could not poll through must not close the
 * budget, or coming back to a backgrounded tab strands exactly the lagged bump
 * DW-48 exists to catch.
 *
 * The cap is what the old "at most once per version" rule was really for. With
 * `page.tsx`'s own read degraded to `0` while the route answers `7`, the
 * baseline NEVER catches up, and an unbounded retry is `router.refresh()` on
 * every poll forever. What bounds it is the span read AT THE MOMENT OF EACH
 * DECISION: a refresh goes out only while the ones already issued for that
 * version span LESS than `WINDOW - SETTLE`, and consecutive refreshes are at
 * least SETTLE apart, so before the n-th one the span is already at least
 * `(n - 2) * SETTLE`. That is under the bound only for
 * `n <= ceil(WINDOW / SETTLE)` = 3 — the same fixed price DW-48 chose, now
 * independent of both the cadence and the trigger rate. The span a version
 * ACHIEVES may be far larger, because the whole gap since the last refresh is
 * charged to it (a hidden tab does exactly that), and a larger span only ends
 * the budget sooner. Every degenerate clock (a gap, a jump either way, a
 * non-finite reading) costs FEWER refreshes, never more, and never a loop.
 *
 * A poll ABOVE the recorded version is a new bump and starts the budget over,
 * even after the previous one was spent. A poll BELOW it is a backwards read of
 * the same kind as the first rule's — the higher version was already refreshed
 * for, so there is nothing to do and nothing to record.
 */
export function dataVersionRefreshPlan(input: {
  served: number;
  polled: number;
  now: number;
  state: DataVersionRefreshState;
}): DataVersionRefreshPlan {
  const { served, polled, now, state } = input;
  // Caught up, unchanged, or a stale read: no refresh, and no state to move.
  if (polled <= served) return { refresh: false, state };
  // A version beyond anything refreshed for — a new bump. The budget restarts.
  if (polled > state.version) {
    return { refresh: true, state: { version: polled, firstRefreshAt: now, lastRefreshAt: now } };
  }
  // Behind the high-water mark: a backwards read while a refresh for a higher
  // version is outstanding. Recording it would rewrite the mark downward.
  if (polled !== state.version) return { refresh: false, state };
  // From here on this IS the version already refreshed for, and the baseline is
  // still behind it. A clock that cannot be compared decides nothing: every
  // elapsed comparison against a non-finite value is `false`, so both guards
  // below would fall through and this would refresh on EVERY poll forever — the
  // one loop the whole bound exists to prevent. The stamps are checked as well
  // as the reading, because a `now` that slipped into the new-bump branch above
  // (which records the clock without needing to compare it) would otherwise
  // poison this version's state permanently.
  if (
    !Number.isFinite(now) ||
    !Number.isFinite(state.firstRefreshAt) ||
    !Number.isFinite(state.lastRefreshAt)
  ) {
    return { refresh: false, state };
  }
  // Still in flight: the previous refresh has not had time to land (DW-377). A
  // backwards clock reading lands here too, which is the safe direction.
  if (now - state.lastRefreshAt < DATA_VERSION_REFRESH_SETTLE_MS) {
    return { refresh: false, state };
  }
  // Spent: the refreshes issued for this version already span the budget.
  if (
    state.lastRefreshAt - state.firstRefreshAt >=
    DATA_VERSION_REFRESH_WINDOW_MS - DATA_VERSION_REFRESH_SETTLE_MS
  ) {
    return { refresh: false, state };
  }
  // Settled, still behind, still inside the budget: retry (DW-48). The window
  // is measured from the FIRST refresh, so retries cannot slide it forward.
  return { refresh: true, state: { ...state, lastRefreshAt: now } };
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
