"use client";

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { APP_NAME } from "@/lib/brand";
import { useSidecarStatus } from "@/hooks/useSidecarStatus";
import {
  DEFAULT_WORKBENCH_MODE,
  workbenchMode,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import {
  DEFAULT_SPLIT_WIDTHS,
  clampSplitWidth,
  clampSplitWidths,
  layoutSignature,
  nextSplitWidthFromKey,
  showSplitHandle,
  splitBounds,
  splitLabel,
  splitStyleVars,
  splitWidthFromPointer,
  withSplitWidth,
  type SplitBounds,
  type SplitId,
  type SplitLayout,
  type SplitWidths,
} from "@/lib/workbench-split";
import {
  readStoredCollapsed,
  readStoredMode,
  readStoredSelection,
  readStoredSplitWidths,
  readStoredTreeTab,
  writeStoredCollapsed,
  writeStoredMode,
  writeStoredSelection,
  writeStoredSplitWidths,
  writeStoredTreeTab,
} from "@/lib/workbench-state";
import {
  DEFAULT_TREE_TAB,
  isSameSelection,
  restorableSelection,
  shouldDockPreview,
  wikilinkSelection,
  type TreeSelection,
  type TreeTabId,
} from "@/lib/workbench-tree";
import { IconRail } from "./IconRail";
import { ModeCanvas } from "./ModeCanvas";
import { PreviewColumn } from "./PreviewColumn";
import { SplitHandle } from "./SplitHandle";
import { TreePanel } from "./TreePanel";
import { WikiSwitcher } from "./WikiSwitcher";
import { useWorkbenchData } from "./WorkbenchData";

/**
 * The Workbench shell — rail, left column, canvas, and the Preview column that
 * docks beside them — and the container Stories 1.5 through 1.7 build inside.
 *
 * Switching modes is `setMode` on ONE mounted shell: never `router.push`, never
 * a `<Link>`. Routing per mode would unmount everything above the mode panel,
 * which is exactly what `epics.md:367` forbids (a mode switch must not destroy
 * typed Chat input). Epic 1 ships no composer, so the rule has no visible
 * surface yet; honouring it structurally now is what lets Story 3.2 lift a
 * draft into this state without a rewrite.
 *
 * DOM order is rail → left column → canvas → Preview, so the tab order the
 * accessibility floor specifies falls out of the markup instead of `tabindex`
 * juggling.
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
  // The left column's working set is server-loaded in `page.tsx` and handed
  // across the server/client boundary by `WorkbenchDataProvider`.
  const {
    wikis,
    currentWikiId,
    registryUnavailable,
    knowledge,
    knowledgeUnavailable,
    files,
    filesUnavailable,
    filesTruncated,
    dataVersion,
  } = useWorkbenchData();
  const [mode, setModeState] = useState<WorkbenchModeId>(DEFAULT_WORKBENCH_MODE);
  const [collapsed, setCollapsed] = useState(false);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [treeTab, setTreeTab] = useState<TreeTabId>(DEFAULT_TREE_TAB);
  // Which tree row is showing in the Preview column. The shell owns it — not
  // the tree — so Story 1.6 has one place to restore it from and the Preview
  // dock is decided by the same component that owns the grid.
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  // Stored layout state exists only in the browser. Rendering it during SSR
  // would hydrate a different tree than the server sent, so the first paint is
  // always the default and the restore lands in an effect.
  const [mounted, setMounted] = useState(false);
  // What the live region says. Deliberately separate from `mode`: restoring a
  // stored mode on load is not a change the owner made, and announcing it would
  // report a mode switch that never happened. Only `selectMode` fills this in.
  const [announcement, setAnnouncement] = useState("");
  // The owner's PREFERRED column widths — what they dragged to, not what fits.
  // `clampSplitWidths` reduces them to the frame at render, so narrowing the
  // window never quietly rewrites the layout they chose.
  const [widths, setWidths] = useState<SplitWidths>(DEFAULT_SPLIT_WIDTHS);
  // The measured shell. Zero until the mount effect runs, which is what keeps
  // the first paint the server's and the inline width vars unwritten.
  const [shellWidth, setShellWidth] = useState(0);
  const [resizing, setResizing] = useState(false);
  const sidecar = useSidecarStatus();
  const headingId = useId();
  const railRef = useRef<HTMLElement>(null);
  const shellRef = useRef<HTMLDivElement>(null);
  const sheetTriggerRef = useRef<HTMLButtonElement>(null);
  // Focus returns to the trigger only when the sheet was dismissed, not when it
  // was never opened — otherwise the first paint steals focus.
  const restoreFocusRef = useRef(false);
  // The layout a restored selection belongs to. See the reset effect below: the
  // restore and the reset would otherwise fight, and the reset would win.
  const restoreSignatureRef = useRef<string | null>(null);
  // Read inside handlers and the mount effect without taking a dependency on
  // them — assigned during render, the `useDialogA11y` idiom `PreviewColumn`
  // already follows. The mount effect must see the trees the FIRST render was
  // given; a dependency on them would re-run the whole restore on every refetch.
  const latestRef = useRef({ currentWikiId, knowledge, files, widths });
  latestRef.current = { currentWikiId, knowledge, files, widths };

  const surface = workbenchMode(mode);

  useEffect(() => {
    // Read once for the restore signature, then again at the three call sites
    // `workbench-chrome.test.ts:195-205` and `workbench-left-column.test.ts:72-82`
    // pin verbatim. The accessors are guarded reads with no side effect, so the
    // second call costs nothing and the frozen form stays exactly as it was.
    const restoredMode = readStoredMode();
    const restoredTab = readStoredTreeTab();
    setModeState(readStoredMode());
    setCollapsed(readStoredCollapsed());
    setTreeTab(readStoredTreeTab());
    setWidths(readStoredSplitWidths());
    // A stored row is restored only when it belongs to the Wiki the registry
    // still calls current AND still names a row in the trees this render was
    // given. A deleted page, another Wiki's row, or a kind whose tree does not
    // contain it all restore nothing: no Preview docks, and no row carries
    // `aria-current`.
    const { currentWikiId: wikiId, knowledge: groups, files: nodes } = latestRef.current;
    const restored = restorableSelection(readStoredSelection(), wikiId, groups, nodes);
    if (restored) {
      restoreSignatureRef.current = layoutSignature(restoredMode, wikiId, restoredTab);
      setSelection(restored);
    }
    setMounted(true);
  }, []);

  // Leaving Wiki mode, switching Wikis, or switching tabs undocks the Preview:
  // in each case the selection names a row in a tree that is no longer the one
  // on screen, so the docked column would describe something the owner cannot
  // point at and nothing visible would carry `aria-current`. Undocking is a
  // layout change only — no route change, exactly like a mode switch.
  //
  // The guard is what makes a restored selection survive its own restore. The
  // mount effect restores mode, tab and row together, which makes this effect
  // fire again with the restored deps and clear the row that was just put back —
  // invisibly, and with every existing assertion still green. So the restore
  // records the signature of the layout it restored INTO, and this returns
  // without clearing until that signature arrives. Every later change behaves
  // exactly as it did before.
  useEffect(() => {
    const pending = restoreSignatureRef.current;
    if (pending !== null) {
      if (pending === layoutSignature(mode, currentWikiId, treeTab)) {
        restoreSignatureRef.current = null;
      }
      return;
    }
    setSelection(null);
  }, [mode, currentWikiId, treeTab]);

  // The pick outlives the SESSION — not the tab, the mode or the Wiki: the reset
  // effect above clears the selection whenever any of those change, and this
  // then clears the key with it. What survives a reload is the row the owner was
  // still on when they closed the tab, scoped to the Wiki they were in.
  //
  // …but only when the shell actually knows. A failed registry read leaves
  // `currentWikiId` null, and a failed index or file read hands the trees down
  // empty — in all three cases the restore above correctly declines, and writing
  // that outcome down would record "we could not find out" as "the owner
  // deselected" and forget the row permanently after one bad minute on the
  // server. A genuine deselect with healthy reads still clears the key.
  useEffect(() => {
    if (!mounted) return;
    if (currentWikiId === null || knowledgeUnavailable || filesUnavailable) return;
    writeStoredSelection(currentWikiId, selection);
  }, [mounted, currentWikiId, selection, knowledgeUnavailable, filesUnavailable]);

  // The frame the clamp measures against. `getBoundingClientRect()` on the shell
  // itself, never the viewport's own width: the shell is a grid child of
  // `layout.tsx`'s <main>, so what the window reports is not what it gets. No
  // `ResizeObserver` — a resize listener is the whole of what changes here, and
  // the responsive breakpoints stay in CSS where they can't drift.
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const measure = () => setShellWidth(shell.getBoundingClientRect().width);
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
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

  // Same rule as the collapse toggle: the storage write is outside any state
  // updater, because React invokes updaters twice under StrictMode.
  const selectTreeTab = useCallback((next: TreeTabId) => {
    setTreeTab(next);
    writeStoredTreeTab(next);
  }, []);

  // Picking the row that is already picked deselects it. Without this the only
  // ways to undock the Preview are leaving Wiki mode, switching tabs, or
  // switching Wikis — none of which the owner would reach for to close a panel.
  const selectRow = useCallback((next: TreeSelection) => {
    setSelection((current) => (isSameSelection(current, next) ? null : next));
  }, []);

  // Following a `[[wikilink]]` in the Preview. Deliberately NOT `selectRow`:
  // that one toggles, so a link pointing at the page already showing would
  // undock the column instead of staying on it. Which row it lands on depends on
  // the tab, which is `wikilinkSelection`'s whole job — and it never changes the
  // tab itself, because the reset effect above would clear the selection this
  // just made. No route change: the shell owns selection, and always has.
  const openPage = useCallback(
    (slug: string) => {
      setSelection((current) => {
        const next = wikilinkSelection(treeTab, files, slug);
        // Returning the SAME object makes React bail out. Without this, a link
        // pointing at the row already showing hands the Preview a new object,
        // and its fetch effect is keyed on selection IDENTITY — so the body it
        // already has is torn down, `Loading…` flashes, and the same bytes are
        // fetched again. `isSameSelection` is the shell's one equality rule.
        return isSameSelection(current, next) ? current : next;
      });
    },
    [treeTab, files],
  );

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

  // The press begins; the shell suppresses text selection for its duration.
  const startResize = useCallback(() => setResizing(true), []);

  // …and ends. The preference is written ONCE, here, rather than on every
  // pointermove: a drag is ~60 events a second, and localStorage is synchronous.
  const endResize = useCallback(() => {
    setResizing(false);
    writeStoredSplitWidths(latestRef.current.widths);
  }, []);

  // The only geometry the shell touches is the rect it measures. Where the
  // pointer lands and what the range is are both `workbench-split`'s answers.
  const dragTo = useCallback((id: SplitId, clientX: number, bounds: SplitBounds) => {
    const shell = shellRef.current;
    if (!shell) return;
    const rect = shell.getBoundingClientRect();
    const raw = splitWidthFromPointer(id, clientX, rect.left, rect.width);
    setWidths((current) => withSplitWidth(current, id, clampSplitWidth(raw, bounds)));
  }, []);

  // Returns whether the divider claimed the key, so the control knows whether to
  // prevent the default — Tab and Escape must still work from a focused handle.
  const pressResizeKey = useCallback(
    (id: SplitId, key: string, current: number, bounds: SplitBounds) => {
      const next = nextSplitWidthFromKey(id, key, current, bounds);
      if (next === null) return false;
      const updated = withSplitWidth(latestRef.current.widths, id, next);
      setWidths(updated);
      writeStoredSplitWidths(updated);
      return true;
    },
    [],
  );

  // The dock rule is a pure function in `workbench-tree`, not a condition typed
  // here: it is the story's headline behaviour, and inlined in JSX it could only
  // ever be grepped for, never executed by a test.
  const previewOpen = shouldDockPreview(mode, selection);

  // Everything below is `workbench-split`'s: the widths the grid gets, the range
  // each divider enforces AND announces, whether a divider exists at all, and
  // the two inline custom properties. Not one of them is spelled here.
  const layout: SplitLayout = { shellWidth, previewOpen, collapsed };
  const applied = clampSplitWidths(widths, layout);
  const treeBounds = splitBounds("tree", applied, layout);
  const previewBounds = splitBounds("preview", applied, layout);

  return (
    <div
      className="wb-shell"
      ref={shellRef}
      style={splitStyleVars(applied, mounted, layout) as CSSProperties | undefined}
      data-collapsed={collapsed ? "true" : "false"}
      data-sheet-open={sheetOpen ? "true" : "false"}
      data-mounted={mounted ? "true" : "false"}
      data-preview={previewOpen ? "true" : "false"}
      data-resizing={resizing ? "true" : "false"}
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

      {/* Header (product title, Wiki switcher, New Wiki), then the tabs and the
          tree — but the trees describe the Wiki surface, so every other mode
          keeps the muted label it has had since Story 1.3 rather than showing a
          Knowledge tree next to, say, the Lint canvas. */}
      <aside className="wb-left" id={LEFT_ID} aria-label={`${surface.label} panel`}>
        <div className="wb-left-head">
          <h1 className="wb-title">{APP_NAME}</h1>
          <WikiSwitcher
            wikis={wikis}
            currentWikiId={currentWikiId}
            unavailable={registryUnavailable}
          />
        </div>
        {mode === "wiki" ? (
          <TreePanel
            tab={treeTab}
            onTabChange={selectTreeTab}
            knowledge={knowledge}
            files={files}
            truncated={filesTruncated}
            hasWiki={currentWikiId !== null}
            unavailable={registryUnavailable}
            knowledgeUnavailable={knowledgeUnavailable}
            filesUnavailable={filesUnavailable}
            selection={selection}
            onSelect={selectRow}
            collapsed={collapsed}
          />
        ) : (
          <p className="wb-left-surface" data-no-localize>
            {surface.label}
          </p>
        )}
      </aside>

      {/* A collapsed column is `display: none`, which takes the h1 above out of
          the accessibility tree along with it — leaving the document with no
          top-level heading at all. This restates it for exactly that state.
          Which one is live is decided in CSS, by the same rules that decide
          whether the column is showing, so the two can never both be exposed
          (below 900px the column is force-shown and this one withdraws). */}
      <h1 className="wb-sr-only wb-title-fallback">{APP_NAME}</h1>

      {/* Each divider follows the column it moves, so the tab order reads
          rail → left column → divider → canvas → divider → Preview. Rendered
          only once mounted AND measured: a handle in the SSR markup would be a
          hydration mismatch, and one rendered before the shell has a width would
          announce the floors as its whole range. Below 1200px they are hidden by
          a media query, never by a width comparison here. */}
      {showSplitHandle("tree", mounted, layout) && (
        <SplitHandle
          id="tree"
          label={splitLabel("tree")}
          value={applied.tree}
          min={treeBounds.min}
          max={treeBounds.max}
          onStart={startResize}
          onMove={(clientX) => dragTo("tree", clientX, treeBounds)}
          onEnd={endResize}
          onKey={(key) => pressResizeKey("tree", key, applied.tree, treeBounds)}
        />
      )}

      <ModeCanvas mode={mode} sidecar={sidecar} headingId={headingId}>
        {children}
      </ModeCanvas>

      {showSplitHandle("preview", mounted, layout) && (
        <SplitHandle
          id="preview"
          label={splitLabel("preview")}
          value={applied.preview}
          min={previewBounds.min}
          max={previewBounds.max}
          onStart={startResize}
          onMove={(clientX) => dragTo("preview", clientX, previewBounds)}
          onEnd={endResize}
          onKey={(key) => pressResizeKey("preview", key, applied.preview, previewBounds)}
        />
      )}

      {/* After the canvas in the DOM, so the tab order stays rail → left column
          → canvas → Preview without a single `tabindex` (EXPERIENCE.md:165). */}
      {previewOpen && (
        <PreviewColumn
          selection={selection}
          knowledge={knowledge}
          files={files}
          onOpenPage={openPage}
          // The trees come from the server render, which the watcher re-runs;
          // the Preview's bytes come from a client read keyed on the
          // selection, so a refreshed page changes nothing about them. This is
          // the Preview's half of the same signal — the shell is where context
          // becomes props, and it stays router-free.
          dataVersion={dataVersion}
        />
      )}

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
