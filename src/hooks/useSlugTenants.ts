"use client";

import { useEffect, useState } from "react";
import { resolveSlugPath, type SlugTenantMap } from "@/lib/links";

// Session-level cache so the slug→tenant map is fetched at most once across all
// components that use it (search, query sources, lint, batch, ingest).
let cache: SlugTenantMap | null = null;
let inflight: Promise<SlugTenantMap> | null = null;

// Mounted hooks, so a map that arrives AFTER they mounted still reaches them
// (DW-234). A component mounted while `/api/wiki/routes` was failing used to
// keep its DEFAULT_TENANT hrefs for its whole lifetime: its effect ran once,
// resolved the degraded `{}`, and nothing ever re-read the session cache — so a
// later cold caller's successful load warmed the module for everyone EXCEPT the
// components already on screen.
const listeners = new Set<(map: SlugTenantMap) => void>();

/**
 * Bumped by {@link _resetSlugTenants}. A request created before a reset keeps
 * running (nothing cancels a `fetch`), so without this it would land LATE and
 * write its map over the one the post-reset caller already cached — and
 * broadcast that stale map to every listener that subscribed after the reset.
 * The abandoned chain still ANSWERS its own caller; it just stops writing to
 * module state it no longer owns.
 */
let generation = 0;

/**
 * Run `listener` when a later `loadSlugTenants()` caches a map. Returns the
 * unsubscribe, which the hook calls from its effect cleanup — without it a
 * remounted tree would accumulate one listener per mount, each setting state on
 * a component that is gone.
 *
 * Module-private on purpose: the recovery signal is another caller's successful
 * load, not something app code subscribes to.
 */
function subscribe(listener: (map: SlugTenantMap) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Fetch the readability-gated slug→tenant map from `/api/wiki/routes`.
 * Concurrent callers share the in-flight request and later callers get the
 * cached map. Any failure resolves to `{}` so link building degrades to the
 * DEFAULT_TENANT fallback href instead of breaking, and ALL failure modes are
 * SYMMETRIC: a rejected fetch, a non-OK response and a malformed body each
 * return `{}` WITHOUT caching it, so the next caller retries. A non-OK response
 * therefore throws into the shared `.catch` rather than substituting `{}`
 * inside the chain — otherwise one transient 401/429/500 would pin every
 * in-content link to the DEFAULT_TENANT form (and its extra 308 hop) until a
 * full page reload.
 *
 * Only a successful map is cached; that also means an empty map from a viewer
 * with no readable pages is a legitimate `{}` and caches normally. Exported
 * (rather than kept as a private closure) so the caching contract is directly
 * testable.
 */
export function loadSlugTenants(): Promise<SlugTenantMap> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    const era = generation;
    const request = fetch("/api/wiki/routes")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/wiki/routes responded ${r.status}`);
        return r.json();
      })
      .then((parsed: unknown) => {
        // `r.json()` is `any` — the response body is not a typed map just
        // because the route declares one. A `null` body would cache falsy, so
        // `if (cache)` would miss it and EVERY caller would re-fetch forever;
        // an array or a scalar would cache and be handed to every renderer,
        // where `resolveSlugPath`'s own-property guard is the only thing left
        // standing between it and the page. Treat anything that isn't a plain
        // object like the other failure modes: `{}` back, nothing cached.
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error("/api/wiki/routes returned a non-object body");
        }
        const m = parsed as SlugTenantMap;
        // Abandoned by a reset while this request was in flight: answer the
        // caller that asked for it, but touch no module state — see
        // {@link generation}.
        if (era !== generation) return m;
        cache = m;
        // Only a SUCCESSFUL cache fill broadcasts. A degraded `{}` never
        // reaches here (it comes out of the `.catch` below), which is the
        // point: notifying on it would hand every mounted component a state
        // change carrying no new information.
        //
        // Iterate a SNAPSHOT of the set: `Set` iteration already tolerates a
        // listener deleting its own entry, so the copy is not about that — it
        // is so one broadcast reaches exactly the listeners that were
        // subscribed when it began, whichever of them a neighbour adds or
        // removes mid-loop. (A listener removed by a neighbour is therefore
        // still called; the hook's `on` flag is what makes that harmless.)
        // A try/catch per listener so one throwing hook does not strand the
        // rest — and, because this runs INSIDE the success `.then`, does not
        // reject the shared promise into the degrading `.catch` below.
        for (const listener of [...listeners]) {
          try {
            listener(m);
          } catch {
            // Deliberately ignored — see above.
          }
        }
        return m;
      })
      .catch(() => ({}) as SlugTenantMap)
      .finally(() => {
        // Only if it is still OURS. An abandoned pre-reset request settling
        // late would otherwise clear the slot belonging to the request that
        // replaced it, and concurrent callers would each start a duplicate.
        if (inflight === request) inflight = null;
      });
    inflight = request;
  }
  return inflight;
}

/**
 * Register `listener` from a test. **Test-only** — a thin door onto the private
 * {@link subscribe} above, because the resilience the notify loop is written for
 * (one throwing listener must not strand its neighbours, and must not reject the
 * shared promise into the degrading `.catch`) has no other way in: every real
 * listener is a hook's `setMap`, which does not throw. Returns the unsubscribe.
 * Nothing the app ships calls this — app code gets the map from the hook.
 */
export function _subscribeSlugTenants(
  listener: (map: SlugTenantMap) => void,
): () => void {
  return subscribe(listener);
}

/**
 * How many hooks are currently subscribed. **Test-only**, and the counterpart of
 * the effect cleanup: "the listener is gone after unmount" is otherwise
 * invisible from outside the module — React no longer warns on a `setState`
 * against an unmounted component, so a leaked listener would be silent until it
 * had accumulated one per mount for the life of the tab.
 */
export function _slugTenantListenerCount(): number {
  return listeners.size;
}

/**
 * Drop the session cache and disown any in-flight request, so the next
 * `loadSlugTenants()` re-fetches. **Test-only** — exported so a suite can
 * express "the map is still loading" or "routes failed" on a MOUNTED component
 * (DW-262), which is otherwise unreachable once any test in the file has warmed
 * the singleton. Nothing the app ships calls this.
 *
 * It deliberately does NOT clear {@link listeners}. Subscriptions belong to
 * mounts, and a mount removes its own on cleanup; clearing them here would
 * silently detach every component still on screen and turn its cleanup into a
 * no-op — so a suite that reset mid-life to stage an outage would watch those
 * components never recover and read the DW-234 bug back as product behavior.
 * Leaving them alone means a reset changes only what its name says.
 */
export function _resetSlugTenants(): void {
  cache = null;
  inflight = null;
  generation += 1;
}

/**
 * Pure map→href resolution: the canonical `/u/<tenant>/<slug>` when the map
 * knows the slug's tenant, else the DEFAULT_TENANT form (which 308-redirects
 * to canonical). Split out of the hook so the load-bearing mapping is directly
 * testable without a renderer.
 */
export function hrefFromMap(map: SlugTenantMap, slug: string): string {
  return resolveSlugPath(slug, map, "");
}

/**
 * Resolve a target slug to its canonical `/u/<tenant>/<slug>` href on the
 * client. Falls back to the default tenant (which 308-redirects to canonical)
 * while the map is loading or for an unknown slug — so links always work, just
 * with one redirect hop in the fallback case.
 *
 * Also exposes the raw `slugTenants` map so callers can hand it to
 * `MarkdownRenderer` (its `slugTenants` prop), letting in-content wikilinks
 * resolve to canonical owner-scoped URLs the same way.
 */
export function useSlugTenants() {
  const [map, setMap] = useState<SlugTenantMap>(cache ?? {});
  useEffect(() => {
    let on = true;
    // Empty deps ON PURPOSE: module scope is the tab, so this must run once per
    // mount. What keeps the mount live afterwards is the subscription, not a
    // dependency — a mount that resolved a degraded `{}` gets the recovered map
    // from the next caller's successful load instead of staying on the
    // DEFAULT_TENANT fallback for its whole lifetime (DW-234).
    const unsubscribe = subscribe((m) => {
      if (on) setMap(m);
    });
    loadSlugTenants().then((m) => {
      if (on) setMap(m);
    });

    /**
     * The self-initiated half of recovery (DW-723). DW-234's broadcast only
     * ever PROPAGATES a load somebody else paid for, and nothing outside this
     * hook calls `loadSlugTenants()` — so "the next cold caller" is always a
     * later MOUNT. A surface that goes idle after an outage (a Workbench
     * sitting still: no navigation, no panel opening) never mounts anything
     * again and would keep its DEFAULT_TENANT hrefs, and their extra 308 hop,
     * for the life of the tab.
     *
     * Still no polling and no timer: user attention is the trigger.
     */
    const retryIfDegraded = () => {
      // Read the MODULE `cache` at event time, not at effect time — the effect
      // runs once per mount with `[]` deps, so anything closed over here (the
      // hook's `map`, a snapshot of `cache`) would be frozen at mount and the
      // degraded check would answer for a moment that has passed.
      //
      // `cache !== null` is exactly "a map has already arrived successfully" (a
      // legitimately empty `{}` from an OK response caches and counts), and
      // production never clears the cache — only the `_resetSlugTenants` test
      // seam does. So the first success turns this into a permanent no-op for
      // the rest of the tab's life: THAT, not a counter or a backoff, is what
      // bounds the retry.
      //
      // Be honest about this line, though: it is REDUNDANT BY CONSTRUCTION
      // today and no test can distinguish its presence. What actually stops a
      // warm session from re-fetching is `loadSlugTenants`' own
      // `if (cache) return Promise.resolve(cache)` short-circuit, one frame
      // below. Deleting this guard changes no observable behavior. It stays
      // because it is where the BOUND is legible — and because it is the half
      // that would still be correct if that short-circuit ever gained a TTL or
      // a revalidation pass, which would otherwise silently turn every
      // attention event on a healthy tab back into a request.
      if (cache !== null) return;
      // A tab going HIDDEN must not re-fetch — the repo idiom from
      // `useSidecarStatus` and `DataVersionWatcher`. Nobody is looking.
      if (document.visibilityState !== "visible") return;
      // No `.then`: a successful load broadcasts to every subscriber and this
      // hook is one, so the recovered map arrives through the EXISTING path
      // rather than a second route into `setMap`. A still-failing one degrades
      // to `{}`, caches nothing, and leaves this hook eligible to retry on the
      // next attention event. Concurrent calls — N mounted hooks × 2 events —
      // collapse into one request via `loadSlugTenants`' `inflight` slot.
      //
      // That dedupe has a consequence worth stating, because it is a contract
      // and not an accident: an event that lands while a FAILING request is
      // still in flight JOINS that request rather than starting a second one,
      // and is answered its degraded `{}`. So it buys no retry of its own —
      // the next attention event is the one that does. Slow failures are
      // exactly when someone switches away and back mid-request, so this is a
      // reachable path, not a corner: the alternative (bypassing `inflight`)
      // would stampede the endpoint precisely while it is already struggling.
      void loadSlugTenants();
    };
    // Two events, not one. `visibilitychange` covers tab switching and
    // un-minimising; a window that merely lost OS focus to another app usually
    // stays `visibilityState === "visible"`, and returning to it fires only
    // `focus` — which is the idle-Workbench case DW-723 is about.
    document.addEventListener("visibilitychange", retryIfDegraded);
    window.addEventListener("focus", retryIfDegraded);

    return () => {
      on = false;
      unsubscribe();
      document.removeEventListener("visibilitychange", retryIfDegraded);
      window.removeEventListener("focus", retryIfDegraded);
    };
  }, []);
  const hrefForSlug = (slug: string): string => hrefFromMap(map, slug);
  return { hrefForSlug, slugTenants: map };
}
