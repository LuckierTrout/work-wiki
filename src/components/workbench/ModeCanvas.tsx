"use client";

import { useLayoutEffect, useRef, type ReactNode } from "react";
import { usePageOrigin } from "@/hooks/usePageOrigin";
import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
import {
  chatSidecarDownCopy,
  workbenchMode,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import type { SidecarStatus } from "@/lib/sidecar";
import type { TreeSelection } from "@/lib/workbench-tree";
import { ChatCanvas } from "./ChatCanvas";
import { GraphCanvas } from "./GraphCanvas";
import { LintCanvas } from "./LintCanvas";
import { ResearchCanvas } from "./ResearchCanvas";
import { ReviewCanvas } from "./ReviewCanvas";
import { SearchCanvas } from "./SearchCanvas";
import { SkillsCanvas } from "./SkillsCanvas";
import { TodosCanvas } from "./TodosCanvas";

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
 * THE WHOLE CANVAS GOES THE SAME WAY WHILE SETTINGS IS OPEN (DW-373). The shell
 * used to render `SettingsCanvas` INSTEAD of this one, which unmounted the very
 * subtree the paragraph above exists to keep — opening Settings destroyed the
 * dialog and its draft exactly as a mode switch once did. So the shell keeps
 * this canvas mounted and passes {@link ModeCanvasProps.hidden}; the `<section>`
 * takes the attribute, gives up `CANVAS_ID`, the landing tab index and its
 * label to the Settings section that is now beside it, and publishes
 * `visible={false}` so a dialog underneath stands its document work down. The
 * stub branch is skipped with it: it holds no state to lose, and leaving it
 * rendered would put a second node on `headingId` — the id `SettingsCanvas`
 * puts on its own heading.
 *
 * What `hidden` does NOT withdraw is anything a dialog did to the DOCUMENT — the
 * body scroll lock and the capture-phase Tab trap — so the same boolean is
 * published through {@link SurfaceVisibilityProvider} for `useDialogA11y` to
 * stand down on.
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
   * Another surface — Settings — is showing in this canvas's place (DW-373).
   *
   * The subtree stays MOUNTED and goes off screen, so the draft inside it
   * survives the visit. Everything that must be unique in the document moves to
   * whatever is showing instead.
   */
  hidden?: boolean;
  /**
   * A Preview is docked and on screen (DW-719).
   *
   * NEVER READ FOR ITS MEANING — only for WHEN. Which element actually scrolls
   * behind the canvas is the stylesheet's answer, and the stylesheet flips it
   * on this condition without `hidden` moving: docking a Preview below the
   * stacking breakpoint releases `.wb-shell`'s clamp, and the DOCUMENT starts
   * scrolling instead of `.wb-canvas`. The restore below keys on this so it
   * RE-PROBES; {@link canvasScroller} still decides.
   */
  previewOpen?: boolean;
  /**
   * The viewport is below the stacking breakpoint (DW-719).
   *
   * The other half of the same flip, and the same rule: an input to when the
   * effect runs, never to what it decides. The shell subscribes to
   * `SPLIT_NARROW_QUERY` on this component's behalf, which is what keeps this
   * file free of a width, a breakpoint, a `matchMedia` and a `max-width`.
   */
  narrow?: boolean;
  children: ReactNode;
  wikiId?: string | null;
  readOnly?: boolean;
  onDockPreview?: (selection: TreeSelection) => void;
  onTodoCountChange?: (count: number) => void;
  onReviewCountChange?: (count: number) => void;
  onOpenResearch?: (projectId: string) => void;
  dataVersion?: number;
  researchFillId?: string | null;
}

/**
 * The bypass target for the skip link. `<main>` wraps the whole shell, so
 * `#main-content` sits AHEAD of the rail; the canvas is where the content that
 * the rail should be skippable to actually begins (WCAG 2.4.1).
 */
export const CANVAS_ID = "wb-canvas";

/**
 * Which element is ACTUALLY scrolling behind the mode canvas (DW-523).
 *
 * Usually `.wb-canvas` itself — it carries `overflow: auto` and lives inside a
 * shell that clamps itself to the viewport. But below the stacking breakpoint,
 * with a Preview docked, `globals.css` releases that clamp (`height: auto`,
 * `overflow: visible` on `.wb-shell`) so the Preview's fourth row is reachable
 * at all; the canvas row then resolves to its CONTENT instead of scrolling
 * inside its own overflow, and the DOCUMENT is what moves. A restore that reads
 * and writes `.wb-canvas` there reads 0, writes 0, and hands the owner the top
 * of the page every time. The stylesheet owns that condition and the width that
 * triggers it — nothing here spells either.
 *
 * THE DOCUMENT IS ASKED, AND THE CANVAS IS THE DEFAULT. Asking the canvas
 * instead (`canvas.scrollHeight > canvas.clientHeight`) inverts the failure:
 * both report 0 with no layout — in jsdom, and on any not-yet-laid-out first
 * run — so the document would take every restore it should not have. The
 * document overflows only where the shell's clamp is off, which is exactly the
 * case this exists for.
 *
 * `document.scrollingElement` is the standard handle on the viewport's scroll
 * box; `documentElement` is the fallback for the environments that return null.
 */
function canvasScroller(canvas: HTMLElement): HTMLElement {
  const root =
    (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
  return root.scrollHeight > root.clientHeight ? root : canvas;
}

export function ModeCanvas({
  mode,
  sidecar,
  headingId,
  hidden = false,
  previewOpen = false,
  narrow = false,
  children,
  wikiId = "current",
  readOnly = false,
  onDockPreview,
  onTodoCountChange,
  onReviewCountChange,
  onOpenResearch,
  dataVersion = 0,
  researchFillId = null,
}: ModeCanvasProps) {
  const surface = workbenchMode(mode);
  const wikiActive = mode === "wiki";

  // This page's own origin, which decides which fail-closed Chat sentence the
  // owner is owed (DW-607). The probe cannot say WHY it failed, so the origin
  // is the only evidence available: on one the sidecar admits without
  // configuration, `down` means nothing answered; anywhere else the process may
  // be running and simply refused.
  //
  // The read-after-mount rule and the reason `null` is the right initial value
  // now live in {@link usePageOrigin}, which the rail dot and the API/MCP pane
  // ask the same question through (DW-750) — three inline effects on one screen
  // were three chances for one of them to read `window` during render.
  const pageOrigin = usePageOrigin();

  // On screen — the mode is Wiki AND no other surface is over the canvas. What
  // the wrapper's own `hidden` and the published visibility both key on, so the
  // two can never disagree.
  const wikiShowing = wikiActive && !hidden;

  // Where the surface was scrolled to before it went off screen (DW-416).
  //
  // `display: none` discards a scroll box: a Settings visit — whose whole
  // premise under DW-373 is that it costs nothing, the section stays MOUNTED —
  // still drops the owner at the top of a long canvas on the way back. This is
  // `TreePanel`'s withdrawal-keyed restore, one column over.
  //
  // WHICH element holds that offset is a layout question, not a constant, and
  // {@link canvasScroller} is where it is answered: `.wb-canvas` carries
  // `overflow: auto` and is the scroll container for the layout the shell
  // clamps, but the stylesheet releases that clamp for a docked Preview below
  // the stacking breakpoint and the DOCUMENT scrolls there instead (DW-523).
  // One run of this effect picks one scroller and reads, writes and listens on
  // that one — never on both.
  //
  // A REF, not storage. The section survives the visit mounted, so the offset
  // never has to cross a reload and there is no FR-8 claim to make here: no new
  // localStorage key, and nothing keyed per MODE either — the surface is one
  // scroll container whichever mode is rendering inside it, exactly as the
  // browser treats it.
  const canvasRef = useRef<HTMLElement>(null);
  // `null` until something has actually been recorded, which is NOT the same as
  // 0. On the document branch the scroller is the PAGE, and a first mount that
  // wrote a 0 into it would undo the browser's own scroll restoration, a
  // `#hash` landing, or whatever position the document was already at before
  // hydration — for a surface that has not gone off screen even once and so has
  // nothing to restore. A number here means "the owner left it here"; `null`
  // means "leave the page where you found it".
  const canvasScrollRef = useRef<number | null>(null);
  // The restore's own echo, armed with the value the browser landed on and
  // spent by the first `scroll` event whatever that event says (DW-521). A
  // boolean would be a latch with no way to spend it: a restore that assigns
  // the offset the surface already holds fires no `scroll` at all, so the arm
  // would still be set when the owner's next genuine scroll arrived and would
  // swallow it.
  const restoreEchoRef = useRef<number | null>(null);
  // WHICH ELEMENT the offset in `canvasScrollRef` was recorded on (DW-719).
  //
  // The offset belongs to the surface, not to this component: the stylesheet
  // moves which element scrolls when a Preview docks or the stacking breakpoint
  // is crossed, and neither of those moves `hidden`. Re-applying a canvas offset
  // to the page — or a page offset to the canvas — is not a restore, it is a
  // jump to a number that never meant anything on that surface. So the probe's
  // answer is remembered, and a different answer DROPS the offset rather than
  // spending it on the wrong box.
  const scrollerRef = useRef<HTMLElement | null>(null);
  // A LAYOUT effect (DW-524): a passive one runs after the browser has painted,
  // so an un-withdrawn canvas paints at the top and then visibly jumps to the
  // offset. On the server this simply does not run — an effect of either kind
  // only runs in the browser — so nothing about the server render changes.
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    // Whatever the previous run armed is spent HERE, before the guard, not left
    // behind by it: an early return would otherwise leave a stale echo that the
    // owner's next genuine scroll could collide with — the same value, arrived
    // at honestly, silently dropped.
    restoreEchoRef.current = null;
    // `hidden` IS the withdrawal, and coming back is the moment the browser has
    // just reset `scrollTop` to 0. The other two keys are the moments the
    // stylesheet changes WHICH element scrolls with `hidden` unmoved (DW-719).
    if (!canvas || hidden) return;
    const scroller = canvasScroller(canvas);
    // The offset belongs to the element it was recorded on. The stylesheet moves
    // that element without `hidden` moving, so re-applying it to the other
    // surface would scroll the page to a canvas offset — or the canvas to a page
    // one.
    if (scrollerRef.current !== scroller) {
      scrollerRef.current = scroller;
      canvasScrollRef.current = null;
    }
    // A viewport scroll is dispatched at `Document` and does NOT bubble from
    // `documentElement`, so listening on the element that scrolls only works
    // while that element is the canvas.
    const target: EventTarget = scroller === canvas ? canvas : document;
    // The restore runs BEFORE the listener is attached, and that is still not
    // enough on its own: the assignment's own `scroll` is dispatched at the
    // next rendering update rather than synchronously (CSSOM View), so the
    // listener installed below receives it anyway and re-records the value just
    // re-applied — a no-op, EXCEPT where the browser CLAMPED the assignment
    // because the surface has not reached its previous content height yet.
    // Arming the echo with what the browser actually landed on is what keeps
    // that clamp out of the ref.
    const stored = canvasScrollRef.current;
    if (stored !== null) {
      scroller.scrollTop = stored;
      restoreEchoRef.current = scroller.scrollTop;
    }
    const onScroll = () => {
      const landed = scroller.scrollTop;
      const echo = restoreEchoRef.current;
      restoreEchoRef.current = null;
      if (echo !== null && landed === echo) return;
      canvasScrollRef.current = landed;
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => target.removeEventListener("scroll", onScroll);
  }, [hidden, previewOpen, narrow]);

  return (
    <section
      ref={canvasRef}
      className="wb-canvas"
      hidden={hidden}
      // All three are GIVEN UP while Settings is showing: `SettingsCanvas`
      // renders the same id, the same landing tab index and the same
      // `headingId`, and two live answers to any of them would be a duplicate
      // id, an ambiguous skip link and a label pointing into hidden content.
      // `undefined` omits the attribute outright rather than emptying it.
      id={hidden ? undefined : CANVAS_ID}
      tabIndex={hidden ? undefined : -1}
      // Whichever heading is actually on screen. The Wiki canvas already owns
      // one — `WikiWorkbench`'s `#wiki-workbench-heading`, which is also both of
      // its dialogs' fallback focus target — so the section borrows it rather
      // than announcing the surface twice; the stub branch renders its own.
      // While Wiki is hidden that heading is hidden with it, so the label moves
      // to the stub's instead of naming a node no reader can reach.
      aria-labelledby={
        hidden ? undefined : wikiActive ? "wiki-workbench-heading" : headingId
      }
    >
      <SurfaceVisibilityProvider visible={wikiShowing}>
        <div className="wb-canvas-mode" hidden={!wikiShowing}>
          {children}
        </div>
      </SurfaceVisibilityProvider>

      {sidecar === "up" ? (
        <SurfaceVisibilityProvider visible={mode === "chat" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "chat" || hidden}>
          {mode === "chat" && !hidden ? (
            <h2 id={headingId} className="wb-surface-title">
              {workbenchMode("chat").label}
            </h2>
          ) : null}
          <ChatCanvas
            wikiId={wikiId ?? "current"}
            readOnly={readOnly}
            onDockPreview={onDockPreview ?? (() => {})}
          />
        </div>
      </SurfaceVisibilityProvider>
      ) : mode === "chat" && !hidden ? (
        <div className="wb-canvas-pad">
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("chat").label}
          </h2>
          <p className="wb-empty">{chatSidecarDownCopy(pageOrigin)}</p>
        </div>
      ) : null}

      <SurfaceVisibilityProvider visible={mode === "search" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "search" || hidden}>
        {mode === "search" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("search").label}
          </h2>
        ) : null}
        <SearchCanvas
          wikiId={wikiId ?? "current"}
          onDockPreview={onDockPreview ?? (() => {})}
        />
      </div>
      </SurfaceVisibilityProvider>

      <SurfaceVisibilityProvider visible={mode === "todos" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "todos" || hidden}>
        {mode === "todos" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("todos").label}
          </h2>
        ) : null}
        <TodosCanvas
          wikiId={wikiId ?? "current"}
          readOnly={readOnly}
          active={mode === "todos" && !hidden}
          onDockPreview={onDockPreview ?? (() => {})}
          onPendingCountChange={onTodoCountChange}
        />
      </div>
      </SurfaceVisibilityProvider>

      <SurfaceVisibilityProvider visible={mode === "graph" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "graph" || hidden}>
        {mode === "graph" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("graph").label}
          </h2>
        ) : null}
        <GraphCanvas
          wikiId={wikiId ?? "current"}
          readOnly={readOnly}
          active={mode === "graph" && !hidden}
          dataVersion={dataVersion}
          onDockPreview={onDockPreview ?? (() => {})}
          onOpenResearch={onOpenResearch}
        />
      </div>
      </SurfaceVisibilityProvider>

      <SurfaceVisibilityProvider visible={mode === "lint" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "lint" || hidden}>
        {mode === "lint" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("lint").label}
          </h2>
        ) : null}
        <LintCanvas
          wikiId={wikiId ?? "current"}
          readOnly={readOnly}
          active={mode === "lint" && !hidden}
          onDockPreview={onDockPreview ?? (() => {})}
        />
      </div>
      </SurfaceVisibilityProvider>

      <SurfaceVisibilityProvider visible={mode === "review" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "review" || hidden}>
        {mode === "review" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("review").label}
          </h2>
        ) : null}
        <ReviewCanvas
          wikiId={wikiId ?? null}
          readOnly={readOnly}
          active={mode === "review" && !hidden}
          dataVersion={dataVersion}
          onDockPreview={onDockPreview ?? (() => {})}
          onPendingCountChange={onReviewCountChange}
          onOpenResearch={onOpenResearch}
        />
      </div>
      </SurfaceVisibilityProvider>

      <SurfaceVisibilityProvider visible={mode === "research" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "research" || hidden}>
        {mode === "research" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("research").label}
          </h2>
        ) : null}
        <ResearchCanvas
          // `null`, not the `"current"` placeholder every other canvas takes:
          // this one PERSISTS the value on a research project, and a stored
          // `"current"` is a wiki id that resolves to nothing forever.
          wikiId={wikiId ?? null}
          active={mode === "research" && !hidden}
          filledId={researchFillId}
          readOnly={readOnly}
        />
      </div>
      </SurfaceVisibilityProvider>

      {/* The Skills rail lists what the sidecar scanned, and owns the switch
          that hides a pack from `/skill` and from the Agent (Story 8.6). */}
      <SurfaceVisibilityProvider visible={mode === "skills" && !hidden}>
        <div className="wb-canvas-pad" hidden={mode !== "skills" || hidden}>
        {mode === "skills" && !hidden ? (
          <h2 id={headingId} className="wb-surface-title">
            {workbenchMode("skills").label}
          </h2>
        ) : null}
        <SkillsCanvas active={mode === "skills" && !hidden} readOnly={readOnly} />
      </div>
      </SurfaceVisibilityProvider>

      {!wikiActive &&
        !hidden &&
        mode !== "chat" &&
        mode !== "search" &&
        mode !== "todos" &&
        mode !== "graph" &&
        mode !== "lint" &&
        mode !== "review" &&
        mode !== "research" &&
        mode !== "skills" && (
        <div className="wb-canvas-pad">
          <h2 id={headingId} className="wb-surface-title">
            {surface.label}
          </h2>
          <p className="wb-empty">{surface.emptyState}</p>
        </div>
      )}
    </section>
  );
}
