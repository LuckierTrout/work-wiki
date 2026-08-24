"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeReviewCount } from "@/lib/review-count";
import { send } from "@/lib/workbench-request";

/** Keep the rail's Review count scoped to the current Wiki and latest request. */
export function useReviewBadge(
  currentWikiId: string | null,
  dataVersion: number,
  initialCount: number,
): readonly [number, (count: number) => void] {
  const [count, setCount] = useState(() => normalizeReviewCount(initialCount) ?? 0);
  const requestSeq = useRef(0);
  const wikiRef = useRef(currentWikiId);
  const initialRef = useRef(initialCount);

  useEffect(() => {
    let cancelled = false;
    const seq = ++requestSeq.current;
    const wikiChanged = wikiRef.current !== currentWikiId;
    const initialChanged = initialRef.current !== initialCount;
    wikiRef.current = currentWikiId;
    initialRef.current = initialCount;

    if (initialChanged) {
      setCount(normalizeReviewCount(initialCount) ?? 0);
    } else if (wikiChanged) {
      setCount(0);
    }

    // A Review count without a Wiki scope is meaningless and the unscoped
    // endpoint can include cards from every Wiki. Keep the rail at zero and do
    // not issue a request until the shell has a concrete current Wiki.
    if (!currentWikiId) {
      setCount(0);
      return () => {
        cancelled = true;
      };
    }

    const query = `?wikiId=${encodeURIComponent(currentWikiId)}`;
    send<{ pendingCount?: number }>(`/api/review-queue${query}`, { method: "GET" })
      .then((body) => {
        const next = normalizeReviewCount(body.pendingCount);
        if (!cancelled && seq === requestSeq.current && next !== null) {
          setCount(next);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dataVersion, currentWikiId, initialCount]);

  const onCountChange = useCallback((next: number) => {
    const normalized = normalizeReviewCount(next);
    if (normalized === null) return;
    requestSeq.current += 1;
    setCount(normalized);
  }, []);

  return [count, onCountChange] as const;
}
