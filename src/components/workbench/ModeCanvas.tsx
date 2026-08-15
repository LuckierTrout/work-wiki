"use client";

import type { ReactNode } from "react";
import {
  CHAT_SIDECAR_DOWN_COPY,
  CHAT_SIDECAR_UP_COPY,
  GRAPH_NARROW_COPY,
  workbenchMode,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import type { SidecarStatus } from "@/lib/sidecar";

/**
 * The active mode's canvas.
 *
 * Wiki hosts Story 1.2's real surface (passed in as `children`, server
 * rendered). Every other mode is not built yet, and renders exactly one muted
 * sentence — no illustration, no emoji, no encouragement (UX-DR15 / UX-DR23).
 * A mode that rendered nothing would be a dead rail icon; a mode that rendered
 * a stub would be a lie about what works.
 *
 * Every sentence comes from `@/lib/workbench-modes`, never inlined here, so the
 * copy the UX handoff fixes has exactly one definition.
 */

export interface ModeCanvasProps {
  mode: WorkbenchModeId;
  sidecar: SidecarStatus;
  headingId: string;
  children: ReactNode;
}

/**
 * The bypass target for the skip link. `<main>` wraps the whole shell, so
 * `#main-content` sits AHEAD of the rail; the canvas is where the content that
 * the rail should be skippable to actually begins (WCAG 2.4.1).
 */
export const CANVAS_ID = "wb-canvas";

export function ModeCanvas({ mode, sidecar, headingId, children }: ModeCanvasProps) {
  const surface = workbenchMode(mode);

  if (mode === "wiki") {
    // The Wiki canvas already owns a heading — `WikiWorkbench`'s
    // `#wiki-workbench-heading`, which is also both of its dialogs' fallback
    // focus target. Rendering a second "Wiki" heading here would announce the
    // surface twice, so the section borrows the one that exists.
    //
    // No `data-no-localize` here: this branch renders no copy of its own, and
    // opting Story 1.2's surface out of localization is not this story's call.
    return (
      <section
        className="wb-canvas"
        id={CANVAS_ID}
        tabIndex={-1}
        aria-labelledby="wiki-workbench-heading"
      >
        {children}
      </section>
    );
  }

  // `data-no-localize`: `src/lib/i18n.ts` carries entries for "Chat", "Review"
  // and "Settings", so LocaleProvider's body-wide observer would rewrite this
  // heading while the rail tooltip next to it — already opted out — stayed
  // English. Half-translated chrome is worse than untranslated chrome.
  return (
    <section
      className="wb-canvas"
      id={CANVAS_ID}
      tabIndex={-1}
      aria-labelledby={headingId}
      data-no-localize
    >
      <div className="wb-canvas-pad">
        <h2 id={headingId} className="wb-surface-title">
          {surface.label}
        </h2>
        {mode === "chat" ? (
          // Fails closed. Until a sidecar answers on the loopback port there is
          // no Chat to degrade into — the Worker cannot reach localhost, so a
          // server-side stand-in would be a stub, not an answer.
          <p className="wb-empty">
            {sidecar === "up" ? CHAT_SIDECAR_UP_COPY : CHAT_SIDECAR_DOWN_COPY}
          </p>
        ) : mode === "graph" ? (
          // Both sentences render; CSS width queries reveal exactly one. No
          // user-agent branch and no width measurement in JS (UX-DR24).
          <>
            <p className="wb-empty wb-empty--wide">{surface.emptyState}</p>
            <p className="wb-empty wb-empty--narrow">{GRAPH_NARROW_COPY}</p>
          </>
        ) : (
          <p className="wb-empty">{surface.emptyState}</p>
        )}
      </div>
    </section>
  );
}
