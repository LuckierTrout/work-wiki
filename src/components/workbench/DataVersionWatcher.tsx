"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  DATA_VERSION_POLL_MS,
  dataVersionRefreshPlan,
  fetchDataVersion,
  readDataVersionRefreshState,
  recordDataVersionRefreshState,
  subscribeDataVersionCheck,
} from "@/lib/workbench-data-version";
import { useWorkbenchData } from "./WorkbenchData";

/**
 * The Workbench's refresh mechanism for KERNEL PAGE WRITES. Renders nothing.
 *
 * It is not the only `router.refresh()` in this directory, and deliberately so:
 * `WikiSwitcher.tsx` keeps its own because that one is IMMEDIATE, and this one
 * cannot be. A registry change reaches this watcher no sooner than its next
 * poll — up to `DATA_VERSION_POLL_MS` later — which is far too long to leave
 * the tab whose owner just clicked looking at the state before the click.
 *
 * EVERY REGISTRY OPERATION MOVES THE COUNTER NOW, so the switcher's refresh is
 * the only thing the two mechanisms do not share. Create and re-template
 * (DW-49) seed `purpose.md` and `schema.md`; rename (DW-209) retitles
 * `purpose.md`'s heading and moves the name the Workbench heading shows; delete
 * (DW-382) removes a Wiki and its artifacts; and a switch (DW-518) moves the
 * `current` pointer every artifact read resolves through, changing what those
 * reads ANSWER without changing an artifact byte. All of them therefore reach
 * this watcher as well, which is what un-stales a Preview left open in ANOTHER
 * tab — the one the switcher's own refresh cannot reach at all.
 *
 * The two paths overlapping on every operation costs the ACTING tab one
 * redundant refresh, which is cheaper than either side guessing. `dataVersion`
 * is monotonic and every consumer is forward-only, so a duplicate forward move
 * costs one render and can never produce a wrong answer.
 *
 * Every write that goes through `runPageLifecycleOp` — the Preview editor's
 * save included — arrives here as well.
 *
 * `page.tsx` reads the `dataVersion` it rendered with and hands it down through
 * `WorkbenchDataProvider`; this compares it to what the gated route answers and,
 * when the served integer has moved FORWARD, calls `router.refresh()`.
 *
 * WHY `router.refresh()` IS THE TREE REFETCH. `page.tsx` is `force-dynamic` and
 * builds both trees server-side from `listReadableWikiPages(principal)` — the
 * only visibility gate there is. A client route returning `KnowledgeGroup[]`
 * would be a second implementation of that gate in a second place. Re-running
 * the server component pushes a new payload through the provider without a
 * navigation, without a reload and without unmounting the shell, so the mode,
 * the tree tab, the selection, the scroll offset and the column widths all
 * survive because they were never re-mounted.
 *
 * WHY IT LIVES HERE. `Workbench.tsx` must stay router-free (a mode switch is
 * state, never a route change) and `PreviewColumn.tsx` issues no request of its
 * own. Of the components the shell renders, this is the one that may hold a
 * router for THIS purpose, and it is mounted inside the provider so it can read
 * the baseline the server rendered with.
 *
 * It spells NO comparison and no budget arithmetic of its own: whether a polled
 * version warrants a refresh — and what this watcher should then remember — is
 * `dataVersionRefreshPlan`, which the node suite executes. Reading the clock is
 * the watcher's to do; deciding what the reading MEANS is not, so neither the
 * refresh window nor the settle interval is named here.
 */
export function DataVersionWatcher() {
  const router = useRouter();
  // The version the CURRENT server render was built from. Assigned during
  // render — the `useDialogA11y` idiom the shell already uses — so a poll that
  // started before a refresh compares against the payload now on screen rather
  // than against the one its closure captured.
  const { dataVersion } = useWorkbenchData();
  const servedRef = useRef(dataVersion);
  servedRef.current = dataVersion;
  // The version refreshes were last issued for, and when the first and most
  // recent of them went out, live in `workbench-data-version`'s module state —
  // beside `listeners`, and per TAB for the same reason (DW-410). A re-render
  // whose own read lagged leaves the baseline behind that version, so a later
  // poll tries again — bounded by the span those refreshes may cover, because a
  // degraded server read (`dataVersion` stuck at 0 while the route answers 7)
  // would otherwise refresh on every single poll, forever.
  //
  // NOT A REF ANY MORE, and that is the fix. A ref is seeded on every mount, so
  // StrictMode's double-mount, a route change or any remount of the shell handed
  // this watcher a fresh budget for a version it had already spent one on — and
  // the ceiling the two wall-clock bounds derive stopped holding, silently,
  // while every assertion about a single mount stayed green. The budget now
  // survives all three. What still resets it is a RELOAD: a new document is a
  // new module instance, a new tab, and a new budget — which is the scope both
  // this module's prose and `data-version.ts`'s have always claimed.

  // Keeps a late answer from a poll started before unmount out of a refresh.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function run() {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const result = await fetchDataVersion(controller.signal);
      if (cancelled || controller.signal.aborted) return;
      if (result.status !== "ok") return;
      // Recorded BEFORE the guard on purpose: every branch of the rule returns
      // the state that branch should leave behind, so there is no "compare,
      // then record" ordering here for a later tidy-up to reverse.
      const plan = dataVersionRefreshPlan({
        served: servedRef.current,
        polled: result.version,
        now: Date.now(),
        state: readDataVersionRefreshState(),
      });
      recordDataVersionRefreshState(plan.state);
      if (!plan.refresh) return;
      router.refresh();
    }

    function startPolling() {
      if (timer !== undefined) return;
      timer = setInterval(() => void run(), DATA_VERSION_POLL_MS);
    }

    function stopPolling() {
      if (timer === undefined) return;
      clearInterval(timer);
      timer = undefined;
    }

    function onVisibility() {
      if (document.visibilityState === "visible") {
        void run();
        startPolling();
      } else {
        stopPolling();
      }
    }

    // A backgrounded tab does not poll at all — nobody is looking at the trees,
    // and coming back re-checks immediately, so they are fresh by the time they
    // are visible again. The `useSidecarStatus` loop, verbatim in structure.
    if (document.visibilityState === "visible") {
      void run();
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibility);
    // The owner's own save asks for a check NOW rather than waiting a tick —
    // but the answer still comes from the server's integer, not from the
    // client's assumption that its write landed.
    const unsubscribe = subscribeDataVersionCheck(() => void run());

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
      unsubscribe();
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, [router]);

  return null;
}
