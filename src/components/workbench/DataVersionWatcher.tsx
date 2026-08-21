"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  DATA_VERSION_POLL_MS,
  NO_DATA_VERSION_REFRESH,
  dataVersionRefreshPlan,
  fetchDataVersion,
  subscribeDataVersionCheck,
} from "@/lib/workbench-data-version";
import { useWorkbenchData } from "./WorkbenchData";

/**
 * The Workbench's refresh mechanism for KERNEL PAGE WRITES. Renders nothing.
 *
 * It is not the only `router.refresh()` in this directory, and deliberately so:
 * `WikiSwitcher.tsx` keeps its own, because switching the current Wiki — one of
 * the registry changes it drives — is not a kernel page write and moves no
 * `dataVersion` at all.
 *
 * CREATE, RE-TEMPLATE, RENAME AND DELETE ARE THE EXCEPTION (DW-49, DW-209,
 * DW-382). Create, re-template and rename write bytes a Preview renders as well
 * as touching the registry — create and re-template seed `purpose.md` and
 * `schema.md`, rename retitles `purpose.md`'s heading and moves the name the
 * Workbench heading shows — so all three bump the counter and reach this watcher
 * too, which is what un-stales a Preview left open on an artifact across a
 * re-apply or a rename.
 *
 * DELETE IS THE ODD ONE OF THE FOUR (DW-382), and worth stating separately
 * rather than flattening into the sentence above: it moves no bytes any Preview
 * renders. The current Wiki is undeletable and a Preview resolves the two
 * artifacts through `currentId` alone, so no client can be reading what a delete
 * takes — and it may take nothing at all, since removing the directory is
 * fail-soft and the bump is earned by the registry entry alone. What it bumps
 * FOR is the Wiki list: it removes a Wiki from `registry.wikis`, the list
 * `WikiSwitcher` renders and gates its controls on, which every OTHER open
 * client is still offering — and acting on a Wiki that is gone 404s.
 *
 * The switcher's own refresh stays because switching still moves nothing; the
 * two paths overlapping on create, rename and now delete costs the acting client
 * one redundant refresh, which is cheaper than the switcher guessing which of
 * its four operations bumped.
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
  // The version this watcher last issued refreshes for, and when the first and
  // most recent of them went out. A re-render whose own read lagged leaves the
  // baseline behind that version, so a later poll tries again — bounded by the
  // span those refreshes may cover, because a degraded server read
  // (`dataVersion` stuck at 0 while the route answers 7) would otherwise
  // refresh on every single poll, forever. Ref state, so it resets on remount
  // and is stored nowhere.
  const refreshStateRef = useRef(NO_DATA_VERSION_REFRESH);
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
        state: refreshStateRef.current,
      });
      refreshStateRef.current = plan.state;
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
