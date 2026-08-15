"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { APP_NAME } from "@/lib/brand";
import { useSidecarStatus } from "@/hooks/useSidecarStatus";
import {
  DEFAULT_WORKBENCH_MODE,
  workbenchMode,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import {
  readStoredCollapsed,
  readStoredMode,
  writeStoredCollapsed,
  writeStoredMode,
} from "@/lib/workbench-state";
import { IconRail } from "./IconRail";
import { ModeCanvas } from "./ModeCanvas";

/**
 * The Workbench shell — rail, left column, canvas — and the container Stories
 * 1.4 through 1.7 build inside.
 *
 * Switching modes is `setMode` on ONE mounted shell: never `router.push`, never
 * a `<Link>`. Routing per mode would unmount everything above the mode panel,
 * which is exactly what `epics.md:367` forbids (a mode switch must not destroy
 * typed Chat input). Epic 1 ships no composer, so the rule has no visible
 * surface yet; honouring it structurally now is what lets Story 3.2 lift a
 * draft into this state without a rewrite.
 *
 * DOM order is rail → left column → canvas, so the tab order the accessibility
 * floor specifies falls out of the markup instead of `tabindex` juggling.
 */

export interface WorkbenchProps {
  /** The Wiki mode canvas — Story 1.2's server-rendered surface. */
  children: ReactNode;
  /** Rail badge counts. Epics 4 and 5 own the real numbers; 0 hides the badge. */
  todoCount?: number;
  reviewCount?: number;
}

/** Below this the rail becomes an off-canvas sheet (DESIGN.md Layout). */
const WIDE_QUERY = "(min-width: 900px)";

/** Stable so the sheet trigger can name the rail it opens via `aria-controls`. */
const RAIL_ID = "wb-mode-rail";

/** Stable so the rail's collapse chevron can name the column it toggles. */
const LEFT_ID = "wb-left-column";

export function Workbench({ children, todoCount = 0, reviewCount = 0 }: WorkbenchProps) {
  const [mode, setModeState] = useState<WorkbenchModeId>(DEFAULT_WORKBENCH_MODE);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  // Stored layout state exists only in the browser. Rendering it during SSR
  // would hydrate a different tree than the server sent, so the first paint is
  // always the default and the restore lands in an effect.
  const [mounted, setMounted] = useState(false);
  // What the live region says. Deliberately separate from `mode`: restoring a
  // stored mode on load is not a change the owner made, and announcing it would
  // report a mode switch that never happened. Only `selectMode` fills this in.
  const [announcement, setAnnouncement] = useState("");
  const sidecar = useSidecarStatus();
  const headingId = useId();
  const railRef = useRef<HTMLElement>(null);
  const sheetTriggerRef = useRef<HTMLButtonElement>(null);
  // Focus returns to the trigger only when the sheet was dismissed, not when it
  // was never opened — otherwise the first paint steals focus.
  const restoreFocusRef = useRef(false);

  const surface = workbenchMode(mode);

  useEffect(() => {
    setModeState(readStoredMode());
    setCollapsed(readStoredCollapsed());
    setMounted(true);
  }, []);

  // Mirrors `sheetOpen` for the callbacks below. A state updater must be pure,
  // so "was it open?" is read from here rather than from inside `setSheetOpen`.
  const sheetOpenRef = useRef(false);
  useEffect(() => {
    sheetOpenRef.current = sheetOpen;
  }, [sheetOpen]);

  const setSheetClosed = useCallback((restoreFocus: boolean) => {
    // Only arm the restore if the sheet was actually open: `selectMode` calls
    // this on every mode click, including at widths where no sheet exists.
    if (sheetOpenRef.current && restoreFocus) restoreFocusRef.current = true;
    setSheetOpen(false);
  }, []);

  /** Dismissals the owner performs — focus goes back where they left it. */
  const closeSheet = useCallback(() => setSheetClosed(true), [setSheetClosed]);

  const selectMode = useCallback(
    (next: WorkbenchModeId) => {
      setModeState(next);
      writeStoredMode(next);
      setAnnouncement(workbenchMode(next).label);
      closeSheet();
    },
    [closeSheet],
  );

  // The storage write is deliberately OUTSIDE the updater: an updater must be
  // pure, and React invokes it twice under StrictMode. Same rule `setSheetClosed`
  // follows for its focus-restore flag.
  const toggleCollapsed = useCallback(() => {
    const next = !collapsed;
    setCollapsed(next);
    writeStoredCollapsed(next);
  }, [collapsed]);

  // Esc closes the sheet — on the BUBBLE phase, deliberately. `useDialogA11y`
  // takes Esc on capture and stops propagation, so an open ConfirmDialog wins
  // first and exactly one layer closes per press. The sheet is navigation, not
  // a modal, so it must not reuse that hook (which also owns body overflow).
  //
  // Tab is handled here too. The open sheet sits over a backdrop that makes the
  // canvas unclickable, so letting Tab walk out of the rail would strand a
  // keyboard user on controls they can neither see nor operate. Focus cycles
  // within the rail instead; Esc, the backdrop and a mode choice all still
  // close it, so this is a loop, not a trap the owner cannot leave.
  useEffect(() => {
    if (!sheetOpen) return;
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        closeSheet();
        return;
      }
      if (event.key !== "Tab") return;
      const rail = railRef.current;
      if (!rail) return;
      // VISIBLE controls only. The collapse chevron is the last child of the
      // rail and is `display: none` below 900px — which is the only width where
      // the sheet exists at all. Taken raw, the list makes that hidden button
      // the wrap point: Shift+Tab off the first mode calls `focus()` on a
      // `display: none` element (a silent no-op) and dead-ends, while forward
      // Tab off the Settings link never matches `last`, so it is not prevented
      // and focus walks straight out of the rail onto the canvas the backdrop
      // has made unclickable. `getClientRects()` is empty for a `display: none`
      // element; `offsetParent` is not used here because the rail itself is
      // `position: fixed` at this breakpoint.
      const items = Array.from(
        rail.querySelectorAll<HTMLElement>("button:not([disabled]), a[href]"),
      ).filter((item) => item.getClientRects().length > 0);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      const inside = active instanceof Node && rail.contains(active);
      if (event.shiftKey && (!inside || active === first)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (!inside || active === last)) {
        event.preventDefault();
        first.focus();
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [sheetOpen, closeSheet]);

  // Widening past the breakpoint puts the rail back in the layout, so a sheet
  // left open would sit over a rail that is already visible.
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(WIDE_QUERY);
    const onChange = () => {
      // No focus restore on this path: the trigger is `display: none` above the
      // breakpoint, so focusing it would drop the keyboard user on <body>.
      // Widening puts the rail back into the layout at the position focus is
      // already in, which is where it should stay.
      if (query.matches) setSheetClosed(false);
    };
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, [setSheetClosed]);

  // Opening the sheet moves focus into it; closing returns it to the trigger,
  // so a keyboard user is never dropped on <body>.
  useEffect(() => {
    if (sheetOpen) {
      railRef.current?.querySelector<HTMLElement>("button, a")?.focus();
    } else if (restoreFocusRef.current) {
      restoreFocusRef.current = false;
      // `offsetParent` is null for a `display: none` element. Focusing one is a
      // silent no-op that leaves the document focused on <body>; leaving focus
      // untouched is strictly better.
      const trigger = sheetTriggerRef.current;
      if (trigger?.offsetParent) trigger.focus();
    }
  }, [sheetOpen]);

  return (
    <div
      className="wb-shell"
      data-collapsed={collapsed ? "true" : "false"}
      data-sheet-open={sheetOpen ? "true" : "false"}
      data-mounted={mounted ? "true" : "false"}
    >
      <button
        type="button"
        ref={sheetTriggerRef}
        className="wb-sheet-trigger"
        aria-expanded={sheetOpen}
        aria-controls={RAIL_ID}
        onClick={() => setSheetOpen((open) => !open)}
        data-no-localize
      >
        Modes
      </button>

      <IconRail
        ref={railRef}
        id={RAIL_ID}
        leftColumnId={LEFT_ID}
        mode={mode}
        onSelect={selectMode}
        collapsed={collapsed}
        onToggleCollapsed={toggleCollapsed}
        sidecar={sidecar}
        todoCount={todoCount}
        reviewCount={reviewCount}
      />

      {sheetOpen && (
        <div className="wb-backdrop" onClick={closeSheet} aria-hidden="true" />
      )}

      {/* Story 1.4 fills this column with the Knowledge | Files tabs, the tree,
          the Wiki switcher and New Wiki. Here it is the header plus the label
          of whatever the rail has selected. */}
      <aside className="wb-left" id={LEFT_ID} aria-label={`${surface.label} panel`}>
        <div className="wb-left-head">
          <h1 className="wb-title">{APP_NAME}</h1>
        </div>
        <p className="wb-left-surface" data-no-localize>
          {surface.label}
        </p>
      </aside>

      {/* A collapsed column is `display: none`, which takes the h1 above out of
          the accessibility tree along with it — leaving the document with no
          top-level heading at all. This restates it for exactly that state.
          Which one is live is decided in CSS, by the same rules that decide
          whether the column is showing, so the two can never both be exposed
          (below 900px the column is force-shown and this one withdraws). */}
      <h1 className="wb-sr-only wb-title-fallback">{APP_NAME}</h1>

      <ModeCanvas mode={mode} sidecar={sidecar} headingId={headingId}>
        {children}
      </ModeCanvas>

      {/* Announces the surface the rail just switched to (accessibility floor).
          Polite, so it never interrupts an in-progress announcement — and empty
          until the owner actually switches, so a restored mode is not reported
          as a change on every page load. */}
      <p className="wb-sr-only" aria-live="polite" data-no-localize>
        {announcement}
      </p>
    </div>
  );
}
