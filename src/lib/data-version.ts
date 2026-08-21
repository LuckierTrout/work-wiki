/**
 * `_idx:data-version` — the Workbench's refresh signal: ONE monotonic integer in
 * the config store that every successful kernel page write and delete raises by
 * exactly one.
 *
 * The bump happens at a single site, the tail of `runPageLifecycleOp`, so a page
 * written by the Preview editor, the CLI, MCP, an agent or (from Epic 2) Ingest
 * all move the same number without one of the ~40 call sites knowing this module
 * exists. The Workbench polls `GET /api/workbench/version`, compares, and
 * re-runs the server render when it has moved FORWARD — see
 * `workbench-data-version.ts` for the consumer half.
 *
 * Same module shape as the other derived indexes (`page-index.ts`): a key, a
 * lock, a fail-soft reader and a `withFileLock` mutator over the storage
 * provider's index API — so it is KV `_idx:data-version` in `YOPEDIA_CONFIG` on
 * Cloudflare and `<DATA_DIR>/.indexes/data-version.json` in local dev, with no
 * provider branch here. Two deliberate differences from `page-index`: this one
 * defaults to `0` rather than `null` (there is no "fall back to a scan" — an
 * unseeded counter simply has not counted yet), and it ALWAYS writes rather than
 * no-opping until something seeds it.
 *
 * Nothing here throws. A config-store hiccup must never turn a write that
 * already landed into a failed one: a stale tree is recoverable by the owner's
 * next poll or reload, a rejected save is not.
 */
import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { logger } from "./logger";

/** Logical index key. The provider prepends its own `_idx:` prefix. */
export const DATA_VERSION_KEY = "data-version";

/**
 * The `withFileLock` key that serializes the read-modify-write — the same
 * serializer every other derived index uses.
 *
 * It is IN-PROCESS ONLY (`lock.ts` says so), and this app deploys to Workers,
 * where isolates are not one process. So two ops landing in different isolates
 * can still both read `n` and both store `n + 1`, and the lock only rules that
 * out where the whole store is one process — local dev on the filesystem
 * provider, and any single-instance deployment.
 *
 * That residual collapse is survivable, which is why no cross-isolate lock is
 * invented here. A collapsed bump still MOVES the signal, and the refresh it
 * produces re-renders everything — the trees and the docked row alike — so no
 * client ends up with a partial view. What is lost is only the write that lands
 * after a client has already refreshed for the collapsed number: it waits for
 * the next bump, or for the owner's next reload.
 *
 * The read half of the read-modify-write is eventually consistent too, so the
 * counter can also move BACKWARDS, not merely fail to advance: an isolate whose
 * read is stale by more than one generation stores a value LOWER than what is
 * already there. Consumers never see that as a change — the comparison in
 * `dataVersionRefreshPlan` is forward-only against the version the client's own
 * render was built from, and its refresh state holds a second high-water mark:
 * the highest version already refreshed FOR, which a regressed counter must
 * also climb back past before anything below it is treated as a bump. So a
 * regression costs more than a collapse does: every write until the counter
 * passes the higher of those two marks is ignored rather than just the one. It
 * still self-heals, since each bump moves it up again, and a reload
 * re-baselines the client immediately. Making this exact would mean a
 * provider-atomic increment, which the storage contract does not offer and
 * which no consumer of this signal is worth adding one for.
 */
export const DATA_VERSION_LOCK = "data-version";

/**
 * What a stored value is worth.
 *
 * Anything that is not a non-negative, finite INTEGER reads as `0` rather than
 * propagating: a hand-edited `"x"`, a `1.5`, a `-1` or a `NaN` would otherwise
 * flow straight into `previous + 1` and produce a counter that never compares
 * usefully again. The next bump then stores `1`, so a NEW page load is correct
 * immediately.
 *
 * An ALREADY-OPEN tab is not, and this is the honest cost: the comparison is
 * forward-only, so a tab whose server render baselined at 50 will not refresh
 * again until the restarted counter passes 50 — 49 writes it silently ignores.
 * Reloading the window fixes it. That is judged the right trade against the
 * alternative, which is trusting a corrupt value into the arithmetic and
 * getting a counter no client can compare against at all.
 */
function narrowStoredVersion(value: unknown): number {
  if (typeof value !== "number") return 0;
  if (!Number.isInteger(value)) return 0; // covers NaN and Infinity
  return value >= 0 ? value : 0;
}

/**
 * The current signal, or `0` when it has never been written or cannot be read.
 *
 * `0` is deliberately indistinguishable from "absent": a consumer that cannot
 * learn the version must not refresh, and the forward-only comparison in
 * `dataVersionRefreshPlan` (`workbench-data-version.ts`) bounds a degraded `0`
 * on the SERVER side to a WALL-CLOCK budget PER OBSERVED VERSION rather than an
 * unbounded loop: refreshes for one version are at least
 * `DATA_VERSION_REFRESH_SETTLE_MS` apart, and one is issued only while those
 * already out span LESS than
 * `DATA_VERSION_REFRESH_WINDOW_MS - DATA_VERSION_REFRESH_SETTLE_MS` at the
 * moment of that decision, so at most three ever go out for it — however fast
 * the polls arrive, and from whichever of the watcher's triggers (DW-377). Per version, not in total: with a live
 * writer bumping the counter, a server read stuck at `0` costs up to three
 * wasted renders for every write, indefinitely — a 3× amplification over the
 * one-per-version behaviour this replaced (DW-48). That is the accepted price
 * of never stranding a real bump whose re-render merely lagged; the failure it
 * bounds is the loop, not the amplification.
 */
export async function readDataVersion(): Promise<number> {
  try {
    return narrowStoredVersion(await getStorage().getIndex<unknown>(DATA_VERSION_KEY));
  } catch (err) {
    logger.warn("data-version", "read failed; reporting 0", err);
    return 0;
  }
}

/**
 * Raise the signal by exactly one and return what was stored.
 *
 * Monotonic means monotonic: `previous + 1`, never a timestamp and never a
 * random token, so a consumer can tell "moved forward" from "moved at all" and
 * a stale eventually-consistent read is a no-op instead of a refresh.
 *
 * Fail-soft, like every other side effect in the lifecycle pipeline: a store
 * that rejects is warned about and answered with `0` — the same value an unread
 * counter reports — never thrown. The caller in `lifecycle.ts` wraps this again
 * for the same reason; neither guard is load-bearing on its own being the only
 * one.
 */
export async function bumpDataVersion(): Promise<number> {
  try {
    return await withFileLock(DATA_VERSION_LOCK, async () => {
      const next = narrowStoredVersion(
        await getStorage().getIndex<unknown>(DATA_VERSION_KEY),
      ) + 1;
      await getStorage().putIndex(DATA_VERSION_KEY, next);
      return next;
    });
  } catch (err) {
    logger.warn("data-version", "bump failed; the signal did not move", err);
    return 0;
  }
}
