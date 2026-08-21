"use client";

import type { ReactNode } from "react";
import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
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
 *
 * THE WIKI SUBTREE IS NEVER UNMOUNTED (DW-26). This used to return one of two
 * subtrees, so leaving Wiki destroyed `WikiWorkbench` — and with it an open
 * Create Wiki dialog, the name the owner had typed into it and the error it was
 * showing. Coming back rebuilt an empty card. Closing the dialog is not a way
 * to hide it either: `CreateWikiDialog` resets its fields when `open` goes
 * false, which discards the very draft this exists to keep. So Wiki renders in
 * every mode and goes behind `hidden` instead, which withdraws it from the
 * pixels, from the accessibility tree and from the tab order in one attribute.
 *
 * What `hidden` does NOT withdraw is anything a dialog did to the DOCUMENT — the
 * body scroll lock and the capture-phase Tab trap — so the same boolean is
 * published through {@link SurfaceVisibilityProvider} for `useDialogA11y` to
 * stand down on.
 *
 * SETTINGS HIDES THIS SECTION rather than replacing it (DW-373). The shell used
 * to render `SettingsCanvas` INSTEAD of this component, which unmounted the very
 * subtree the paragraph above exists to keep: opening Settings — by the rail
 * control or by `g s` — destroyed the dialog, the typed name and the error that
 * a mode switch preserves. So the shell renders both canvases and passes
 * `hidden` here, and the withdrawal happens at the `<section>` — one level up
 * from `.wb-canvas-mode`, because a wrapper cannot hide the element that
 * contains it. The a11y contracts move up with it: a hidden section carries
 * neither {@link CANVAS_ID} nor the negative tab index (the SHOWING canvas owns
 * both, and an id must be unique), and `visible` is published `false` for the
 * same reason a mode switch does it — `hidden` withdraws pixels, the a11y tree
 * and the tab order, and nothing a dialog did to the document.
 *
 * ONE `<section>` for both, rather than one per branch: `CANVAS_ID` is the skip
 * link's target, an id must be unique, and the negative tab index that makes it
 * a landing place belongs to whatever holds that id. The stub subtree is still
 * conditional — it holds no state to lose, and rendering it under Wiki would put
 * a second "Wiki" heading in the document.
 */

export interface ModeCanvasProps {
  mode: WorkbenchModeId;
  sidecar: SidecarStatus;
  headingId: string;
  /**
   * Is another canvas — Settings — on screen in this one's place (DW-373)?
   *
   * Required rather than defaulted: a caller that forgot it would silently put
   * a second `#wb-canvas` on the page, which is exactly the failure the
   * conditional id below exists to prevent.
   */
  hidden: boolean;
  children: ReactNode;
}

/**
 * The bypass target for the skip link. `<main>` wraps the whole shell, so
 * `#main-content` sits AHEAD of the rail; the canvas is where the content that
 * the rail should be skippable to actually begins (WCAG 2.4.1).
 */
export const CANVAS_ID = "wb-canvas";

export function ModeCanvas({
  mode,
  sidecar,
  headingId,
  hidden,
  children,
}: ModeCanvasProps) {
  const surface = workbenchMode(mode);
  const wikiActive = mode === "wiki";

  return (
    <section
      className="wb-canvas"
      hidden={hidden}
      // The canvas that is SHOWING owns the skip link's target and the negative
      // tab index that makes it a landing place. While Settings is up, this
      // section is hidden and `SettingsCanvas` carries both — so the id an
      // author must keep unique stays unique, and the bypass has exactly one
      // destination rather than two with the browser left to pick.
      id={hidden ? undefined : CANVAS_ID}
      tabIndex={hidden ? undefined : -1}
      // Whichever heading is actually on screen. The Wiki canvas already owns
      // one — `WikiWorkbench`'s `#wiki-workbench-heading`, which is also both of
      // its dialogs' fallback focus target — so the section borrows it rather
      // than announcing the surface twice; the stub branch renders its own.
      // While Wiki is hidden that heading is hidden with it, so the label moves
      // to the stub's instead of naming a node no reader can reach.
      aria-labelledby={wikiActive ? "wiki-workbench-heading" : headingId}
    >
      <SurfaceVisibilityProvider visible={wikiActive && !hidden}>
        <div className="wb-canvas-mode" hidden={!wikiActive}>
          {children}
        </div>
      </SurfaceVisibilityProvider>

      {!wikiActive && (
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
      )}
    </section>
  );
}
