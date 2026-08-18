"use client";

import { useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import {
  DATA_VERSION_POLL_MS,
  fetchDataVersion,
  shouldRefreshForDataVersion,
  subscribeDataVersionCheck,
} from "@/lib/workbench-data-version";
import { useWorkbenchData } from "./WorkbenchData";

/**
 * The Workbench's refresh mechanism for KERNEL PAGE WRITES. Renders nothing.
 *
 * It is not the only `router.refresh()` in this directory, and deliberately so:
 * `WikiSwitcher.tsx` keeps its own, because the registry changes it drives —
 * switching the current Wiki, renaming one, deleting one — are not kernel page
 * writes and move no `dataVersion` at all. Renaming is the one of those three
 * that also rewrites bytes (`purpose.md`'s heading) and still does not bump,
 * which is a known gap rather than a decision — DW-209.
 *
 * CREATE AND RE-TEMPLATE ARE THE EXCEPTION (DW-49). Both SEED bytes as well as
 * touching the registry — `purpose.md` and `schema.md` — so both now bump the
 * counter and reach this watcher too, which is what un-stales a Preview left
 * open on an artifact across a re-apply. The switcher's own refresh stays
 * because the other three cases still move nothing; the two paths overlapping
 * on create costs one redundant refresh, which is cheaper than the switcher
 * guessing which of its four operations bumped.
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
 * It spells NO comparison of its own: whether a polled version warrants a
 * refresh is `shouldRefreshForDataVersion`, which the node suite executes.
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
  // The highest version this watcher has already refreshed for. Without it, a
  // degraded server read (`dataVersion` stuck at 0 while the route answers 7)
  // would refresh on every single poll, forever.
  const refreshedForRef = useRef(0);
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
      if (
        !shouldRefreshForDataVersion({
          served: servedRef.current,
          polled: result.version,
          refreshedFor: refreshedForRef.current,
        })
      ) {
        return;
      }
      refreshedForRef.current = result.version;
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
