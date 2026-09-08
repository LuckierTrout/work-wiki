"use client";

import { useId, useState } from "react";

/**
 * Why the button refuses, said out loud.
 *
 * CHARACTER-IDENTICAL to `READ_ONLY_REFUSAL.reingest`, the sentence
 * `POST /api/ingest/reingest` answers with its 403 — so the owner reads the
 * same words whether the surface stated the refusal or the server did. It is
 * duplicated rather than imported because `read-only.ts` pulls `./config` (the
 * settings/storage graph, and `process.env`), which does not belong in a browser
 * bundle. `read-only-copy-parity.test.ts` compares the two so the duplication
 * cannot drift.
 */
export const REINGEST_READ_ONLY_COPY =
  "Pages cannot be re-ingested while this deployment is read-only.";

interface ReingestButtonProps {
  slug: string;
  /**
   * `YOPEDIA_READONLY=1`, read on the server by the page that renders this and
   * threaded down through {@link import("./ArticleView").ArticleView} — no
   * route and no client fetch is added for a fact the process already holds.
   *
   * `POST /api/ingest/reingest` now answers 403 on such a deployment (DW-187),
   * and the kernel page writer refuses the write behind it (DW-188). Left
   * ungated the control still looks live: the owner presses it, waits out a
   * request, and meets the refusal as a red error string. So the refusal is
   * stated up front instead — `aria-disabled` (never `disabled`, which would
   * take the control out of the tab order) plus a handler that returns before
   * the fetch, and a sentence wired as the button's own description.
   */
  readOnly?: boolean;
}

/**
 * Re-ingest a page directly: re-fetch the page's source, re-synthesize, and
 * write it in place over `/api/ingest/reingest`. There is no preview/review
 * step — the re-ingest runs synchronously and the page reloads on success.
 */
export function ReingestButton({ slug, readOnly = false }: ReingestButtonProps) {
  const noteId = useId();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reingest() {
    // BEFORE the request, not after: the server answers 403 either way, and an
    // owner who presses a live-looking control deserves the reason up front
    // rather than as the tail of a round trip.
    if (readOnly) return;

    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ingest/reingest", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ slug }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error ?? "Re-ingest failed");
        setLoading(false);
        return;
      }
      // Reload so the reader sees the updated page.
      window.location.reload();
    } catch {
      setError("Network error — could not reach the server");
      setLoading(false);
    }
  }

  return (
    <div className="inline-flex flex-col items-start gap-1">
      <button
        onClick={reingest}
        disabled={loading}
        // `disabled` stays for the transient in-flight state; the standing
        // refusal is `aria-disabled`, so the control keeps its place in the tab
        // order and the sentence below can be announced with it.
        aria-disabled={readOnly || undefined}
        aria-describedby={readOnly ? noteId : undefined}
        aria-label="Re-ingest source content"
        className={`rounded-md border border-foreground/20 px-4 py-2 text-sm font-medium text-foreground transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${
          readOnly ? "opacity-50 cursor-default" : "hover:bg-foreground/5"
        }`}
      >
        {loading ? "Re-ingesting…" : "Re-ingest"}
      </button>
      {readOnly && (
        <span id={noteId} className="text-xs text-foreground/60">
          {REINGEST_READ_ONLY_COPY}
        </span>
      )}
      {error && (
        <span className="text-xs text-red-600 dark:text-red-400">{error}</span>
      )}
    </div>
  );
}
