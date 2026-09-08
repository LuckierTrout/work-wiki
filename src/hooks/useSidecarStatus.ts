"use client";

import { useEffect, useRef, useState } from "react";
import { probeSidecar, type SidecarStatus } from "@/lib/sidecar";

/** Re-probe cadence while the tab is visible. */
const POLL_MS = 15000;

/**
 * Browser-side up/down signal for the local sidecar, for the rail's status dot
 * and Chat's fail-closed canvas (Story 1.3; Epic 3 owns the richer contract).
 *
 * Starts at `"unknown"` so the first server-rendered paint claims nothing: a
 * dot that renders "down" before any probe has run would accuse a running
 * sidecar, and one that renders "up" would promise a Chat that cannot answer.
 *
 * A hidden tab stops polling — the probe is a connection attempt against a
 * likely-refused local port, and hammering it in a backgrounded tab costs the
 * owner battery for an answer nobody is looking at. Coming back to the tab
 * re-probes immediately, so the dot is fresh by the time it is visible again.
 */
export function useSidecarStatus(): SidecarStatus {
  const [status, setStatus] = useState<SidecarStatus>("unknown");
  // Keeps a late answer from a probe started before unmount out of setState.
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function run() {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      const next = await probeSidecar(undefined, { signal: controller.signal });
      if (cancelled || controller.signal.aborted) return;
      setStatus(next);
    }

    function startPolling() {
      if (timer !== undefined) return;
      timer = setInterval(() => void run(), POLL_MS);
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

    if (document.visibilityState === "visible") {
      void run();
      startPolling();
    }
    document.addEventListener("visibilitychange", onVisibility);

    return () => {
      cancelled = true;
      stopPolling();
      document.removeEventListener("visibilitychange", onVisibility);
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  return status;
}
