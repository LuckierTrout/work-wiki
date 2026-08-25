/**
 * Is anything actually listening for extract work? (Story 7.1)
 *
 * `probeSidecar` cannot answer this. It dials `127.0.0.1`, which only the
 * BROWSER can reach — a Worker route that called it would report `down`
 * unconditionally and dress the lie as a health check. So the kernel learns the
 * sidecar is alive the only way it honestly can: the sidecar polls
 * `GET /api/extract/jobs`, and that poll stamps a timestamp here.
 *
 * A heartbeat rather than a registration: a sidecar that was killed writes
 * nothing on the way out, and a flag it had set would say "up" forever. The
 * absence of a recent poll is the signal, which is the fail-closed direction —
 * an owner told extract is unavailable when it is merely slow loses a compile
 * they can retry, while the reverse loses the wait with no sentence at all.
 */

import { isEnoent } from "./errors";
import { logger } from "./logger";
import { getStorage } from "./storage";

/**
 * How long a poll vouches for the sidecar.
 *
 * Several times the poll interval, so one skipped tick (a long parse holding
 * the loop, a laptop that slept for a moment) does not read as a dead process.
 */
export const EXTRACT_POLL_FRESH_MS = 90 * 1000;

const POLL_PREFIX = "extract-poll";

/**
 * The key an UNSCOPED poller stamps.
 *
 * The sidecar drains every owner without being told a handle (see
 * `extract-auth`), so it cannot stamp a per-owner heartbeat — and the arrival
 * door still has to answer "is anything listening?" for the handle that just
 * dropped a file. A poll under this key vouches for all of them, which is
 * exactly what an unscoped poller is doing.
 */
export const EXTRACT_POLL_ANY = "__any__";

/** Owner handles are compared, never joined into a path unescaped. */
function relPathFor(owner: string): string {
  const safe = owner.replace(/[^\w.@-]/g, "_").slice(0, 128);
  if (!safe) throw new Error("invalid extract poll owner");
  return `${POLL_PREFIX}/${safe}.json`;
}

/**
 * Record that a poller asked for work. Fail-soft: a heartbeat that could not be
 * written must not fail the poll it was observing.
 */
export async function recordExtractPoll(owner: string): Promise<void> {
  try {
    await getStorage().writeFile(
      relPathFor(owner),
      JSON.stringify({ owner, at: new Date().toISOString() }),
    );
  } catch (error) {
    logger.warn("extract", `could not record poll for "${owner}"`, error);
  }
}

/** ISO timestamp of the last poll for this owner, or `null` if never. */
export async function lastExtractPoll(owner: string): Promise<string | null> {
  try {
    const raw = await getStorage().readFile(relPathFor(owner));
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed.at === "string" ? parsed.at : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    logger.warn("extract", `could not read poll for "${owner}"`, error);
    return null;
  }
}

/**
 * Has a sidecar polled recently enough to be worth queueing for?
 *
 * `false` when nothing ever polled — which is exactly the state of a
 * deployment where the owner never started the sidecar, and the state the
 * sidecar-down sentence exists to describe.
 */
export async function isExtractPollerLive(
  owner: string,
  now: number = Date.now(),
): Promise<boolean> {
  const stamps = await Promise.all([
    lastExtractPoll(owner),
    lastExtractPoll(EXTRACT_POLL_ANY),
  ]);
  return stamps.some((at) => {
    if (!at) return false;
    const ms = Date.parse(at);
    return Number.isFinite(ms) && now - ms <= EXTRACT_POLL_FRESH_MS;
  });
}
