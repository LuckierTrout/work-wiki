/**
 * `_idx:data-version` — the Workbench's refresh signal: ONE monotonic integer
 * that every successful kernel page write and delete raises by exactly one.
 *
 * The bump happens at a single site, the tail of `runPageLifecycleOp`, so a page
 * written by the Preview editor, the CLI, MCP, an agent or (from Epic 2) Ingest
 * all move the same number without one of the ~40 call sites knowing this module
 * exists. The Workbench polls `GET /api/workbench/version`, compares, and
 * re-runs the server render when it has moved FORWARD — see
 * `workbench-data-version.ts` for the consumer half.
 *
 * Same module shape as the other derived indexes (`page-index.ts`): a key, a
 * lock name, a fail-soft reader and a mutator over the storage provider's index
 * API. The mutator is `incrementIndex`, not a `getIndex`/`putIndex` pair under
 * `withFileLock`. That pair is isolate-local on Workers: two isolates can both
 * read `n` and both store `n + 1`, and an eventually-consistent KV read can
 * store a value LOWER than what is already there. `incrementIndex` is
 * provider-atomic — filesystem serializes the file; Cloudflare compare-and-swaps
 * an R2 object — so a successful bump is exactly `previous + 1` across isolates.
 *
 * The logical key stays `"data-version"`. Locally that is
 * `<DATA_DIR>/.indexes/data-version.json`. On Cloudflare it is the R2 object
 * `_idx/data-version` (not KV `_idx:data-version`): KV has no increment and is
 * eventually consistent. A leftover KV value seeds the first R2 write so a
 * deploy does not restart the counter.
 *
 * Nothing here throws. A config-store hiccup must never turn a write that
 * already landed into a failed one: a stale tree is recoverable by the owner's
 * next poll or reload, a rejected save is not.
 */
import { getStorage } from "./storage";
import { isAtomicCounterIndexKey } from "./storage/types";
import { narrowIndexInteger } from "./storage/index-integer";
import { logger } from "./logger";

/** Logical index key. The provider prepends its own `_idx:` / `_idx/` prefix. */
export const DATA_VERSION_KEY = "data-version";

if (!isAtomicCounterIndexKey(DATA_VERSION_KEY)) {
  throw new Error(
    `DATA_VERSION_KEY ${JSON.stringify(DATA_VERSION_KEY)} is not in ATOMIC_COUNTER_INDEX_KEYS`,
  );
}

/**
 * The lock name the filesystem provider serializes this counter on
 * (`index:${DATA_VERSION_KEY}`). Kept exported so callers that must not nest
 * another lock key around a bump can name the resource; the increment itself
 * lives inside `incrementIndex`, not a `withFileLock` in this module.
 */
export const DATA_VERSION_LOCK = "data-version";

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
    return narrowIndexInteger(await getStorage().getIndex<unknown>(DATA_VERSION_KEY));
  } catch (err) {
    logger.warn("data-version", "read failed; reporting 0", err);
    return 0;
  }
}

/**
 * Raise the signal by exactly one and return what was stored.
 *
 * Monotonic means monotonic: `previous + 1`, never a timestamp and never a
 * random token, so a consumer can tell "moved forward" from "moved at all".
 * The provider increment is what makes that true across Worker isolates, not
 * an in-process lock around a read-modify-write.
 *
 * Fail-soft, like every other side effect in the lifecycle pipeline: a store
 * that rejects is warned about and answered with `0` — the same value an unread
 * counter reports — never thrown. The caller in `lifecycle.ts` wraps this again
 * for the same reason; neither guard is load-bearing on its own being the only
 * one.
 */
export async function bumpDataVersion(): Promise<number> {
  try {
    return await getStorage().incrementIndex(DATA_VERSION_KEY);
  } catch (err) {
    logger.warn("data-version", "bump failed; the signal did not move", err);
    return 0;
  }
}
