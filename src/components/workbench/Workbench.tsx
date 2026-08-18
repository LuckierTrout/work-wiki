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
  initialMode,
  locationHref,
  modeHref,
  readModeFromSearch,
} from "@/lib/workbench-url";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_LABEL,
  settingsAnnouncement,
  settingsCategory,
  type SettingsCategoryId,
} from "@/lib/workbench-settings";
import {
  PREVIEW_CLOSED_COPY,
  PREVIEW_DISCARD_CONFIRM_BODY,
  PREVIEW_DISCARD_CONFIRM_LABEL,
  PREVIEW_DISCARD_CONFIRM_TITLE,
  PREVIEW_KEEP_EDITING_COPY,
  PREVIEW_REMOVED_COPY,
  previewDockAnnouncement,
} from "@/lib/workbench-preview";
import {
  DEFAULT_TREE_TAB,
  isSameSelection,
  restorableSelection,
  selectionName,
  selectionRefreshAction,
  shouldDockPreview,
  wikilinkSelection,
  type TreeSelection,
  type TreeTabId,
} from "@/lib/workbench-tree";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { IconRail } from "./IconRail";
import { ModeCanvas } from "./ModeCanvas";
import { PreviewColumn } from "./PreviewColumn";
import { SettingsCanvas } from "./SettingsCanvas";
import { SettingsNav } from "./SettingsNav";
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
 * The active mode is nonetheless MIRRORED into `?mode=` (DW-27), so a mode can
 * be linked, bookmarked and reached with Back. That is `window.history`
 * pushState / replaceState — Next 15's sanctioned shallow-routing call, which
 * updates the URL with no server round trip and no unmount — never the router,
 * and never a `next/navigation` search-params hook (it would force a Suspense
 * boundary onto `page.tsx`). The ban is on ROUTING, not on the URL. Every rule
 * about WHAT the URL says lives in `workbench-url.ts` where the node suite can
 * execute it; all that is spelled here is WHEN a history entry is written.
 *
 * One consequence of that mirroring reaches outside this file: because Next
 * patches the history methods, the search-params hook elsewhere in the tree SEES
 * each write — and `Analytics` (mounted app-wide by `ClientProviders`) captures
 * a `$pageview` whenever it changes. So a mode switch is now a pageview — one
 * per rail click, plus one more when the mount seed corrects the URL.
 * Recorded rather than suppressed: a mode has an address now, so counting a
 * switch as a page view is the honest reading, and the alternative is teaching
 * `Analytics` to special-case a param this component owns.
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
  // Story 1.9's surface. Deliberately NOT persisted: `workbench-state.ts`'s
  // durable set is mode, tab, selection, collapse and widths, and a reload must
  // not land the owner in Settings holding a form they have no context for.
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsCategoryId, setSettingsCategoryId] = useState<SettingsCategoryId>(
    DEFAULT_SETTINGS_CATEGORY,
  );
  // Which tree row is showing in the Preview column. The shell owns it — not
  // the tree — so Story 1.6 has one place to restore it from and the Preview
  // dock is decided by the same component that owns the grid.
  const [selection, setSelection] = useState<TreeSelection | null>(null);
  // A pick the owner made that has NOT been applied, because the Preview editor
  // is holding unsaved text (DW-36). State rather than a ref: the discard dialog
  // renders from it, and `null` is the whole of "no pick is being held". The
  // held pick changes nothing else — no announcement, no `ownerPickedRef` write,
  // no storage write — so cancelling leaves the shell byte-identical.
  const [pendingSelection, setPendingSelection] = useState<TreeSelection | null>(null);
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
  // Mirrors `mode` for the `popstate` handler, which has to ask "did this
  // traversal actually move the mode?" without taking `mode` as a dependency —
  // that would tear the listener down and rebuild it on every mode change, and
  // on every re-render that follows one. Assigned during render, the same idiom
  // `sheetOpenRef` and `latestRef` already use.
  const modeRef = useRef(mode);
  modeRef.current = mode;
  // Read inside handlers and the mount effect without taking a dependency on
  // them — assigned during render, the `useDialogA11y` idiom `PreviewColumn`
  // already follows. The mount effect must see the trees the FIRST render was
  // given; a dependency on them would re-run the whole restore on every refetch.
  const latestRef = useRef({ currentWikiId, knowledge, files, widths });
  latestRef.current = { currentWikiId, knowledge, files, widths };
  // WHICH layout the current selection belongs to. A dependency of the
  // reconciliation effect below rather than something it reads from a ref: the
  // effect owns a record of the last signature it saw, and a record only that
  // effect writes goes STALE the moment the layout moves without it running.
  // The next tree-only refresh — a genuinely different commit — would then
  // still compare against the pre-switch signature, conclude the layout had
  // just moved, and stand down on a real deletion. So a layout change re-runs
  // this effect too: it records the new signature and returns.
  const signature = layoutSignature(mode, currentWikiId, treeTab);
  // The live pick, for the reconciliation effect and the two selection setters.
  // Assigned during render, the same idiom as `latestRef` above: taking
  // `selection` as a dependency would re-run "did the row leave the tree?" on
  // every pick, which is the one moment the answer is guaranteed to be about
  // the wrong thing.
  const liveRef = useRef({ selection, docked: false });
  // The docked column, so a narrow layout can scroll it into view (DW-34).
  const previewRef = useRef<HTMLElement>(null);
  // Has the OWNER picked a row in this session? Only the two selection setters
  // write it, which is what separates a dock the owner asked for from the mount
  // restore — the one commit where a Preview appears with nobody having touched
  // anything, and the one where scrolling to it would move the page under them.
  const ownerPickedRef = useRef(false);
  // The layout signature the last reconciliation ran against. A Wiki, mode or
  // tab change and a refreshed server render can land in the SAME commit, and
  // the reset effect owns the clear in that case — so this is how the
  // reconciliation recognises the commit it must stay out of.
  const reconciledSignatureRef = useRef<string | null>(null);
  // Does the docked Preview's editor hold unsaved text (DW-36)? A ref, not
  // state: nothing renders from it and it is read inside a click handler, the
  // same split `sheetOpenRef` and `liveRef` already make. Written only by the
  // column's own report, which an unmounting column ends with `false`.
  const previewDirtyRef = useRef(false);

  const surface = workbenchMode(mode);

  // The dock rule is a pure function in `workbench-tree`, not a condition typed
  // here: it is the story's headline behaviour, and inlined in JSX it could only
  // ever be grepped for, never executed by a test.
  // …with one conjunction: a docked Preview beside a Settings detail column
  // would describe a tree row the owner cannot point at, because the trees are
  // not on screen while the settings nav has the left column.
  //
  // Computed HERE, above the effects, because two of them need it: the narrow
  // reveal, and the reconciliation — which must not speak about a column that
  // is not on screen. Settings holds a live selection with this false for as
  // long as it is open.
  const previewOpen = shouldDockPreview(mode, selection) && !settingsOpen;
  liveRef.current = { selection, docked: previewOpen };

  useEffect(() => {
    // The URL wins over storage, and only for the MODE (DW-27): a deep link is
    // an explicit instruction, while the stored mode is a preference from an
    // earlier session. Everything below still reads storage and nothing else —
    // the tab, the collapse flag, the widths and the row are browser-local view
    // state with nothing to link to.
    //
    // URL-first is not an SSR guarantee. This is an EFFECT, exactly like the
    // widths and the selection restore below it: the first paint is the
    // server's, so `/?mode=chat` paints the default Wiki canvas for one frame
    // and this corrects it. Reading the param during render instead would put a
    // browser-only value in the server's markup and hydrate a different tree —
    // the same reason `mounted` exists (see its declaration above).
    //
    // `readStoredMode` and `readStoredTreeTab` are each read more than once —
    // for the resolution, for the comparison below, and at the call sites
    // `workbench-chrome.test.ts` and `workbench-left-column.test.ts:72-82` pin
    // verbatim. The accessors are guarded reads with no side effect, so the
    // extra calls cost nothing and the frozen forms stay exactly as they were.
    const restoredMode = initialMode(window.location.search, readStoredMode());
    const restoredTab = readStoredTreeTab();
    setModeState(restoredMode);
    setCollapsed(readStoredCollapsed());
    setTreeTab(readStoredTreeTab());
    setWidths(readStoredSplitWidths());
    // Seed the URL so the FIRST entry names its mode too. Without this, Back
    // after one switch lands on an entry with no `mode` at all and the popstate
    // handler below would have to invent a policy for it. `replaceState`, so no
    // entry is added and the owner's Back button still leaves the app on the
    // first press.
    try {
      const seeded = modeHref(window.location, restoredMode);
      if (seeded !== locationHref(window.location)) {
        window.history.replaceState(null, "", seeded);
      }
    } catch {
      // History unavailable — a sandboxed iframe or opaque-origin document
      // throws `SecurityError`, and Safari throws it again after ~100 calls in
      // 30 seconds. The shell keeps working for this session; only the linkable
      // URL is lost. Deliberately caught HERE rather than around the whole
      // effect: the selection restore and `setMounted(true)` come after this,
      // and letting a history failure skip them would leave the split handles
      // unrendered and the inline width vars unwritten — a layout bug with no
      // visible connection to the URL.
    }
    // A stored row is restored only when it belongs to the Wiki the registry
    // still calls current AND still names a row in the trees this render was
    // given. A deleted page, another Wiki's row, or a kind whose tree does not
    // contain it all restore nothing: no Preview docks, and no row carries
    // `aria-current`.
    const { currentWikiId: wikiId, knowledge: groups, files: nodes } = latestRef.current;
    const restored = restorableSelection(readStoredSelection(), wikiId, groups, nodes);
    if (restored) {
      // …and it is restored onto the tab that can MARK it (DW-46). The stored
      // row and the stored tab are two independent values, and `wikilinkSelection`
      // deliberately produces a page/Files pairing — so the tab is corrected to
      // `restored.tab` rather than the row being rejected. Not persisted: the
      // correction is a pure function of the row, so a reload reproduces it, and
      // writing it would overwrite the owner's last explicit tab choice.
      if (restored.tab !== restoredTab) setTreeTab(restored.tab);
      // The EFFECTIVE mode, never the stored one. On a deep link the two differ,
      // and a signature naming a layout the shell is not in never arrives — so
      // the reset effect's guard returns forever and the Preview goes on
      // describing a row that has left the tree on screen.
      //
      // …and the EFFECTIVE tab, for exactly the same reason: a signature naming
      // the tab that was stored rather than the one just switched to would never
      // arrive either, so the reset effect would stop clearing forever and the
      // very next tab change would leave a Preview docked over a tree with
      // nothing current in it.
      restoreSignatureRef.current = layoutSignature(restoredMode, wikiId, restored.tab);
      setSelection(restored.selection);
    }
    // LAST, and deliberately after every storage READ above: a deep link that
    // beat storage writes itself down, and doing it earlier would make the reads
    // above observe a value this same effect had just written — which is exactly
    // how the signature bug one line up stops being reachable in a test.
    //
    // Why write at all: `applyMode` keeps "what is on screen" and "what a
    // param-less reload would restore" in step on every other path, and a deep
    // link must not be the one place they diverge — otherwise `/?mode=chat`
    // shows Chat, and the owner's next visit to a bare `/` silently drops them
    // back into Wiki. Silent by design: this moves storage, not the live region,
    // and a restore is still not a change the owner made. It is also what makes
    // the `popstate` guard below sound for a foreign entry carrying no `mode` at
    // all — `initialMode` then falls back to storage, which now names the mode
    // already on screen, so the guard skips it instead of announcing a switch
    // that never happened.
    if (restoredMode !== readStoredMode()) writeStoredMode(restoredMode);
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

  // A row can leave the tree without the owner touching anything: another
  // actor, an agent or a CLI run deletes the page, the watcher re-runs the
  // server render, and the refreshed trees simply no longer contain it (DW-53).
  // Nothing noticed before this — the selection stayed alive, no visible row
  // carried `aria-current`, and the Preview went on describing something the
  // owner could not point at.
  //
  // A SEPARATE effect from the reset above, and deliberately so: the reset's
  // deps are frozen at `[mode, currentWikiId, treeTab]` (Story 1.4), and adding
  // the trees to them would clear the selection on every refresh rather than on
  // the ones that lost the row. What is left is that both can fire in the same
  // commit — the reset runs first and clears, and this one, reading a
  // render-assigned ref, would still see the old pick and announce a REMOVAL
  // for a layout change. `layoutMoved` is that guard, executed inside
  // `selectionRefreshAction` rather than typed here.
  //
  // `signature` is in the dependency array for the reason its declaration
  // gives: this effect owns the record, so it has to see every layout change or
  // the record it compares against describes a layout two switches ago.
  useEffect(() => {
    if (!mounted) return;
    const { selection: picked, docked } = liveRef.current;
    const layoutMoved = reconciledSignatureRef.current !== signature;
    reconciledSignatureRef.current = signature;
    // Three answers, because clearing and SAYING SO are separate acts: a stale
    // pick must never survive, but a sentence about a column that closed is a
    // lie when no column was showing (Settings has the left column, and the
    // selection outlives it). A failed read is not a deletion and neither is a
    // truncated walk; which flag applies is the selection's own kind, which is
    // why all four arrive separately rather than pre-`||`-ed into one boolean.
    const action = selectionRefreshAction({
      selection: picked,
      knowledge,
      files,
      docked,
      knowledgeUnavailable,
      filesUnavailable,
      filesTruncated,
      layoutMoved,
    });
    if (action === "keep") return;
    setSelection(null);
    // Spoken only when there was something to see go: this is the one undock the
    // owner did not ask for, and a column that simply vanished mid-read is
    // indistinguishable from a bug.
    if (action === "report") setAnnouncement(PREVIEW_REMOVED_COPY);
  }, [
    mounted,
    knowledge,
    files,
    knowledgeUnavailable,
    filesUnavailable,
    filesTruncated,
    signature,
  ]);

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

  /**
   * Everything a mode change does to this shell, with nothing said about the
   * URL. Split out of `selectMode` so a `popstate` — which arrives with the URL
   * ALREADY moved — can reuse it without writing a second history entry for the
   * traversal that just happened.
   */
  const applyMode = useCallback(
    (next: WorkbenchModeId) => {
      setModeState(next);
      // Storage is written on this path too, including from `popstate`: what is
      // on screen and what a param-less reload would restore must not diverge.
      // Outside any state updater, the rule `toggleCollapsed` already follows —
      // React invokes updaters twice under StrictMode.
      writeStoredMode(next);
      setAnnouncement(workbenchMode(next).label);
      // Leaving Settings is what DISCARDS the draft: `SettingsCanvas` owns it,
      // so unmounting the surface is the whole of "unsaved edits are discarded
      // on leave". No diff, no prompt, nothing sent.
      setSettingsOpen(false);
      closeSheet();
    },
    [closeSheet],
  );

  const selectMode = useCallback(
    (next: WorkbenchModeId) => {
      applyMode(next);
      try {
        // Compared against the URL, not against `mode`: no dependency on the
        // state this is about to change, and re-clicking the mode already
        // showing adds no entry for Back to swallow before it reaches the
        // previous mode.
        if (readModeFromSearch(window.location.search) !== next) {
          window.history.pushState(null, "", modeHref(window.location, next));
        }
      } catch {
        // Same degrade as the mount seed, and the reason this sits AFTER
        // `applyMode` rather than around it: the mode has already switched and
        // been written down, so a history failure costs the owner a linkable
        // URL and nothing else. Rethrowing would take the mode switch with it.
      }
    },
    [applyMode],
  );

  // Back and Forward. The entry the browser moved to is the only input — the
  // same `initialMode` rule the mount effect uses, so load and traversal cannot
  // drift — and a traversal that MOVES the mode is a change the owner made, so
  // unlike the restore on load it announces the surface it lands on
  // (EXPERIENCE.md:175).
  useEffect(() => {
    const onPopState = () => {
      const next = initialMode(window.location.search, readStoredMode());
      // Not every entry in this session is one the shell wrote. The skip link
      // in `SiteChrome` is an `<a href="#wb-canvas">`, and following it pushes a
      // fragment entry carrying the SAME `?mode=` — so Back from there is a
      // traversal with no mode change in it. Handing that to `applyMode` would
      // close Settings (discarding the draft `SettingsCanvas` holds), rewrite
      // storage and announce a surface switch that never happened. `modeRef`
      // rather than `mode`, so this listener is registered once and not rebuilt
      // on every mode change.
      if (next === modeRef.current) return;
      applyMode(next);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [applyMode]);

  // Opening Settings is `useState` on the ONE mounted shell, exactly as a mode
  // switch is — never `router.push`, never a `<Link>`. The announcement names
  // the surface the same way a mode change does (EXPERIENCE.md:175).
  //
  // It TOGGLES. The rail control renders `aria-current="page"` and the active
  // wash while Settings is showing, which reads as a control that is on and can
  // therefore be turned off; a press that only ever opened would leave the mode
  // canvas reachable solely by picking a mode. Closing announces the surface the
  // owner lands back on, exactly as `selectMode` does.
  const toggleSettings = useCallback(() => {
    if (settingsOpen) {
      setSettingsOpen(false);
      setAnnouncement(workbenchMode(mode).label);
    } else {
      setSettingsOpen(true);
      setAnnouncement(settingsAnnouncement(settingsCategory(settingsCategoryId).label));
    }
    closeSheet();
  }, [closeSheet, mode, settingsCategoryId, settingsOpen]);

  const selectSettingsCategory = useCallback((next: SettingsCategoryId) => {
    setSettingsCategoryId(next);
    setAnnouncement(settingsAnnouncement(settingsCategory(next).label));
  }, []);

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
  //
  // Both outcomes are ANNOUNCED (DW-34). Docking and undocking are layout
  // changes with no focus move and no route change, so to a screen-reader user
  // a click on a tree row otherwise produces nothing at all: a panel appeared
  // somewhere below, or the one they were reading stopped existing.
  //
  // Everything a pick DOES, with nothing said about whether it may happen. Split
  // out of `selectRow` (DW-36) so the guard below can hold a pick without
  // touching any of it, and so the discard confirm can hand the very same pick
  // through unchanged — a second copy of this body is how the held path would
  // start announcing something different from the direct one.
  const applySelection = useCallback((next: TreeSelection) => {
    // Outside the state updater, the rule `toggleCollapsed` already follows —
    // React invokes updaters twice under StrictMode, and an announcement made
    // in there would be written twice and, worse, made by a function that is
    // required to be pure. The live pick comes from the render-assigned ref, so
    // this callback still takes no dependency on it.
    const { knowledge: groups, files: nodes } = latestRef.current;
    // The owner is picking, so a dock from here on is a change they made — see
    // the reveal effect below, which stays out of the mount restore.
    ownerPickedRef.current = true;
    setAnnouncement(
      isSameSelection(liveRef.current.selection, next)
        ? PREVIEW_CLOSED_COPY
        : previewDockAnnouncement(selectionName(next, groups, nodes)),
    );
    setSelection((current) => (isSameSelection(current, next) ? null : next));
  }, []);

  // …and WHETHER it may happen. The Preview's fetch effect closes the editor on
  // every new pick, so before DW-36 one stray click on a tree row silently
  // destroyed unsaved markdown. The pick is HELD instead: nothing is announced,
  // nothing is written, the selection does not move, and the row the owner was
  // on keeps `aria-current` — so Cancel is genuinely a no-op rather than an undo.
  //
  // Re-picking the SHOWN row is held too. It would deselect, which unmounts the
  // editor — the same loss by a different route, and the one case a guard
  // written as "is this a different row?" would let through.
  //
  // Only the tree-selection path is gated. A mode switch, a Wiki switch, a tab
  // switch and Settings all still discard silently: the ledger defers those to
  // whichever story gives the editor a lifecycle, and gating them here would put
  // this dialog in front of navigation it was not designed for.
  const selectRow = useCallback(
    (next: TreeSelection) => {
      if (previewDirtyRef.current) {
        setPendingSelection(next);
        return;
      }
      applySelection(next);
    },
    [applySelection],
  );

  /** The column's one report, parked in a ref. Stable, because it is read from an effect. */
  const reportPreviewDirty = useCallback((dirty: boolean) => {
    previewDirtyRef.current = dirty;
  }, []);

  // Discard: the held pick applies exactly as it would have. The editor closes
  // because the column's own fetch effect resets on a new row — the shell says
  // nothing about the editor, which is the whole reason the report travels up as
  // a boolean and the state stays down there.
  const confirmDiscard = useCallback(() => {
    const next = pendingSelection;
    setPendingSelection(null);
    if (next) applySelection(next);
  }, [applySelection, pendingSelection]);

  /** Keep editing — Cancel, Esc and the backdrop all land here. The pick is dropped. */
  const cancelDiscard = useCallback(() => setPendingSelection(null), []);

  // Following a `[[wikilink]]` in the Preview. Deliberately NOT `selectRow`:
  // that one toggles, so a link pointing at the page already showing would
  // undock the column instead of staying on it. Which row it lands on depends on
  // the tab, which is `wikilinkSelection`'s whole job — and it never changes the
  // tab itself, because the reset effect above would clear the selection this
  // just made. No route change: the shell owns selection, and always has.
  //
  // Deliberately NOT gated on the dirty check (DW-36), and not because the loss
  // would be acceptable: this path cannot fire while the editor is open at all.
  // The editor REPLACES the rendered body in `PreviewColumn`, so there is no
  // wikilink on screen to follow — the one control that calls this is unmounted
  // for exactly as long as a draft exists. A guard here would be dead code
  // asserting a condition nothing can reach.
  const openPage = useCallback(
    (slug: string) => {
      const next = wikilinkSelection(treeTab, files, slug);
      // Following a link is a pick too, for the reveal effect's purposes.
      ownerPickedRef.current = true;
      // Announced only when the column actually MOVES. A link pointing at the
      // page already showing makes React bail out below, so there is no dock to
      // report — and `Preview, Alpha` spoken over an unchanged Alpha would tell
      // the owner something happened when nothing did. Computed here, outside
      // the updater, for the same StrictMode reason `selectRow` gives.
      if (!isSameSelection(liveRef.current.selection, next)) {
        const { knowledge: groups, files: nodes } = latestRef.current;
        setAnnouncement(previewDockAnnouncement(selectionName(next, groups, nodes)));
      }
      setSelection((current) => {
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
      // Tab off the Settings control never matches `last`, so it is not prevented
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

  // Below 900px the Preview is not a column beside the canvas — it is a stacked
  // fourth ROW, past the fold of a shell that is `100dvh; overflow: hidden`.
  // Docking one there looked like a tap that did nothing (DW-34). The CSS
  // releases the shell's clamp while a Preview is docked so there is somewhere
  // to scroll TO; this brings the column into view once there is.
  //
  // Keyed on the ROW as well as on the dock. At this width the column is below
  // the fold whether or not one was already open, so picking a second row while
  // the first is showing changes content the owner cannot see — the identical
  // "a tap appeared to do nothing" symptom, and the common case once a Preview
  // is in use at all. `selection` is the shell's stable identity for a pick:
  // `openPage` returns the SAME object when a wikilink points at the row
  // already showing, so a link that changes nothing scrolls nothing either.
  //
  // No focus move, on this path or any other: the announcement is the whole of
  // the report, and pulling focus off the tree row the owner just clicked would
  // cost a keyboard user their place in the tree.
  //
  // …and never for a RESTORE. The mount effect docks a stored pick, which makes
  // `previewOpen` true on a commit the owner did nothing to cause — this would
  // then open every page load below 900px already scrolled past the tree and
  // the canvas to the bottom row. It is the same rule the restore already
  // follows for the live region (announce nothing), applied to the other half
  // of the report: a reveal answers a pick, and a restore is not one.
  useEffect(() => {
    if (!previewOpen) return;
    if (!ownerPickedRef.current) return;
    if (typeof window === "undefined" || !window.matchMedia) return;
    // The WIDE layout already has the column on screen; scrolling there would
    // move a shell that does not scroll and, in a browser that honours it, jump
    // the canvas for no reason.
    if (window.matchMedia(WIDE_QUERY).matches) return;
    // An optional CALL, not a feature test: jsdom ships no `scrollIntoView` and
    // neither do a few embedded webviews, and a dock that throws is strictly
    // worse than a dock the owner has to scroll to themselves.
    previewRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [previewOpen, selection]);

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
      // Settings puts its own nav in the left column, so a collapsed column
      // would leave no category reachable at all — and `collapsed` is durable,
      // so that state would survive every reload. CSS force-shows the column
      // while this is true; the owner's stored preference is not rewritten, and
      // it takes effect again the moment Settings closes.
      data-settings={settingsOpen ? "true" : "false"}
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
      >
        Modes
      </button>

      <IconRail
        ref={railRef}
        id={RAIL_ID}
        leftColumnId={LEFT_ID}
        mode={mode}
        onSelect={selectMode}
        onToggleSettings={toggleSettings}
        settingsActive={settingsOpen}
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
      <aside
        className="wb-left"
        id={LEFT_ID}
        aria-label={`${settingsOpen ? SETTINGS_LABEL : surface.label} panel`}
      >
        <div className="wb-left-head">
          <h1 className="wb-title">{APP_NAME}</h1>
          <WikiSwitcher
            wikis={wikis}
            currentWikiId={currentWikiId}
            unavailable={registryUnavailable}
          />
        </div>
        {settingsOpen ? (
          // Settings' own nav takes the column the trees usually have (UX-DR14).
          <SettingsNav
            category={settingsCategoryId}
            onSelect={selectSettingsCategory}
          />
        ) : mode === "wiki" ? (
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
          <p className="wb-left-surface">
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

      {/* ONE canvas at a time. `SettingsCanvas` takes `CANVAS_ID` and
          `tabIndex={-1}` from `ModeCanvas` while it is open, so the skip link
          keeps exactly one target and the id stays unique. */}
      {settingsOpen ? (
        <SettingsCanvas category={settingsCategoryId} headingId={headingId} />
      ) : (
        <ModeCanvas mode={mode} sidecar={sidecar} headingId={headingId}>
          {children}
        </ModeCanvas>
      )}

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
          // One boolean UP, never the draft (DW-36): the shell decides whether a
          // pick may be applied, which needs one bit, and a shell that could
          // read the text would be a second owner of the editor's state.
          onDirtyChange={reportPreviewDirty}
          // …and the shell keeps the geometry. Below 900px the column is a
          // stacked row the shell has to scroll to; the column itself never
          // reads the viewport.
          ref={previewRef}
        />
      )}

      {/* The held pick's discard gate (DW-36). The SAME `ConfirmDialog` the
          Preview's edit gate uses — one dialog implementation, one overlay level
          (UX-DR17) — and the two can never coexist: this one opens only while
          the editor is open, and the column's edit-confirm is reachable only
          from an `Edit` button that renders `canEdit && !editing`.

          No `fallbackFocusRef`: the opener is the tree row the owner clicked,
          which is still mounted on both outcomes, so `useDialogA11y`'s own
          restore puts focus back where they left it either way. */}
      <ConfirmDialog
        open={pendingSelection !== null}
        title={PREVIEW_DISCARD_CONFIRM_TITLE}
        body={PREVIEW_DISCARD_CONFIRM_BODY}
        confirmLabel={PREVIEW_DISCARD_CONFIRM_LABEL}
        cancelLabel={PREVIEW_KEEP_EDITING_COPY}
        onConfirm={confirmDiscard}
        onCancel={cancelDiscard}
      />

      {/* Announces the surface the rail just switched to (accessibility floor).
          Polite, so it never interrupts an in-progress announcement — and empty
          until the owner actually switches, so a restored mode is not reported
          as a change on every page load. */}
      <p className="wb-sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
