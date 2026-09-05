"use client";

import { useEffect, useState } from "react";

/**
 * This page's own origin, or `null` until the browser has been asked (DW-750).
 *
 * THE ONE FACT A PAGE HOLDS FOR FREE about whether the loopback sidecar's door
 * would admit it. The sidecar admits a fixed set of loopback origins without any
 * configuration; anywhere else the owner has to list the origin in
 * `WORKWIKI_SIDECAR_ALLOWED_ORIGINS`. A browser probe that fails cannot report
 * WHY — a refused connection and a CORS refusal are the same opaque rejection
 * (DW-607) — so every surface that wants to say something honest about a failed
 * probe selects its sentence from this value rather than from a diagnosis it
 * cannot make.
 *
 * READ AFTER MOUNT, never during render. `window` does not exist on the server,
 * and a render that reached for it on the client would produce different markup
 * from the one React is hydrating — the sentence would swap under a hydration
 * mismatch. `null` until the effect runs is deliberately the state every
 * consumer's selector degrades to, so the first client render is byte-identical
 * to the server's and the swap that follows is a normal re-render.
 *
 * A HOOK rather than a copy of the state/effect pair in each surface (it lived
 * inline in `ModeCanvas` first): the rail dot, the Chat canvas and the API/MCP
 * pane all answer the same question on the same screen, and three hand-written
 * effects are three chances for one of them to read the origin during render.
 */
export function usePageOrigin(): string | null {
  const [pageOrigin, setPageOrigin] = useState<string | null>(null);
  useEffect(() => {
    setPageOrigin(window.location.origin);
  }, []);
  return pageOrigin;
}
