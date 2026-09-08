"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import {
  readStoredSourcesScroll,
  writeStoredSourcesScroll,
} from "@/lib/workbench-state";
import {
  SPLIT_NARROW_QUERY,
  treeScrollBand,
} from "@/lib/workbench-split";
import { workbenchMode } from "@/lib/workbench-modes";
import {
  FILES_TRUNCATED_COPY,
  FILES_UNAVAILABLE_COPY,
  SOURCES_WINDOW_INITIAL,
  SOURCES_WINDOW_STEP,
  TREE_NO_WIKI_COPY,
  countSourceLeaves,
  nextSourceWindowLimit,
  sourcesTreeFromFiles,
  windowSourceTree,
  type FileNode,
  type TreeSelection,
} from "@/lib/workbench-tree";
import { workbenchSourcePath } from "@/lib/source-delete";
import { FileRows } from "./TreePanel";
import { MarkMeetingControl } from "./MarkMeetingControl";

export interface SourcesTreeProps {
  files: readonly FileNode[];
  truncated?: boolean;
  filesUnavailable?: boolean;
  hasWiki: boolean;
  selection: TreeSelection | null;
  onSelect: (selection: TreeSelection) => void;
  onDelete?: (path: string) => void;
  readOnly?: boolean;
}

const SOURCES_EMPTY = workbenchMode("sources").emptyState
  ?? "No sources yet. Ingest a file to add one.";

/**
 * Progressive `raw/sources/` tree for Sources mode. Windowed first paint;
 * scrolling grows the window without remounting the list.
 */
export function SourcesTree({
  files,
  truncated = false,
  filesUnavailable = false,
  hasWiki,
  selection,
  onSelect,
  onDelete,
  readOnly = false,
}: SourcesTreeProps) {
  const baseId = useId();
  const bodyRef = useRef<HTMLDivElement>(null);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const [windowLimit, setWindowLimit] = useState(SOURCES_WINDOW_INITIAL);
  const toggle = useCallback((key: string) => {
    setClosed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const all = sourcesTreeFromFiles(files);
  const visible = windowSourceTree(all, windowLimit);
  const leafCount = countSourceLeaves(all);

  // Is `.wb-sources-tree` on screen at all (DW-519)? The SAME three conditions
  // the early returns below branch on — a missing Wiki, an unreadable silo, and
  // an empty tree each render a sentence instead of the panel — collected into
  // one boolean because both scroll effects have to be KEYED on it.
  //
  // Without it the ordinary path never restores. On a first commit the shell has
  // no files yet, so this component renders the empty sentence, `bodyRef.current`
  // is null when the restore runs, and it returns having assigned nothing. The
  // files land a moment later and the panel appears — but `band` has not moved,
  // so the restore never runs again and the stored offset is never applied. The
  // persist side would recover by accident (`leafCount` is in its key and moves
  // from 0), which is the worst version of the bug: the tree goes on RECORDING
  // an offset it will never restore. `hasWiki` flipping is worse still — the
  // tree is derived from `files` alone, so `leafCount` does not move with it and
  // the persist side would not recover either.
  const treeShowing = hasWiki && !filesUnavailable && all.length > 0;

  // Is the viewport below the stacking breakpoint (DW-519)? The mirror of
  // `TreePanel`'s subscription, for the tree one mode over. This component
  // spells no width, no breakpoint and no `innerWidth`: it asks
  // `matchMedia(SPLIT_NARROW_QUERY)` and hands the boolean to the module that
  // decides what it MEANS.
  const [narrow, setNarrow] = useState(false);
  useEffect(() => {
    // SSR, and the handful of embedded webviews without the API: the effect
    // returns early and both effects below keep the wide band, which is the
    // pre-DW-519 behaviour.
    if (typeof window === "undefined" || !window.matchMedia) return;
    const query = window.matchMedia(SPLIT_NARROW_QUERY);
    // Seeded synchronously here rather than in `useState`, so the first render
    // is the server's on both sides of the breakpoint.
    setNarrow(query.matches);
    const onChange = (event: MediaQueryListEvent) => setNarrow(event.matches);
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);

  // Which of this tree's two scroll RANGES the current layout has (DW-206's
  // argument, DW-519's surface).
  //
  // `.wb-sources-tree` carries ONE rule in the whole stylesheet — `flex: 1 1
  // auto; min-height: 0; overflow: auto` — and no narrow override of its own, so
  // what changes across the breakpoint is the BOX it is flexing inside. Above
  // 900px `.wb-left` is a bounded column in a `.wb-shell` clamped to `100dvh`,
  // and this panel scrolls inside the height that clamp leaves it. Below it the
  // shell stacks to a single column and `.wb-left` becomes `overflow: visible`,
  // so the panel is measured against content rather than against a clamped
  // column — and with a Preview docked the shell's own clamp is released
  // outright and the DOCUMENT is what scrolls. (It is NOT the `40vh` cap that
  // `@media (max-width: 899px)` puts on `.wb-tree-body`: this tree has no such
  // cap. Same conclusion, reached by a different route.)
  //
  // So one offset shared across the crossing is not one offset. Restored into
  // whichever layout has the shorter range the browser CLAMPS it, the clamp
  // fires a `scroll`, and the persist below writes the clamp back over the
  // offset the owner is about to return to.
  const band = treeScrollBand(narrow);

  // The restore's own echo, armed by the restore below and spent by the persist
  // effect under it (DW-521).
  //
  // A VALUE, not a boolean, and it disarms on the FIRST scroll event whatever
  // that event says. A restore that assigns the offset the panel already holds
  // fires no `scroll` at all, so a boolean latch would still be set when the
  // owner's next genuine scroll arrived and would swallow it.
  const restoreEchoRef = useRef<number | null>(null);

  // Where the owner left this tree, per band. A LAYOUT effect (DW-524): a
  // passive one runs after the browser has painted, so a tree the owner is
  // being handed back paints once at the top and then visibly jumps to the
  // offset. Neither kind of effect runs during a server render, so nothing
  // about this component's SSR output changes.
  //
  // NO withdrawal key, because this component takes no `hidden` and no
  // `collapsed`: `Workbench` renders it as `mode === "sources" && …` inside a
  // `settingsOpen ? null : …` branch, so a mode switch and a Settings visit both
  // UNMOUNT it. That is why its memory is in localStorage and why the flushing
  // cleanup below is the whole of the other half of this fix.
  //
  // `treeShowing` IS in the key, and it is the one that makes the restore run on
  // the ordinary path at all: the panel does not exist on the first commit, and
  // the commit that grows one moves neither `band` nor anything else this effect
  // would otherwise watch. See the docblock on `treeShowing`.
  useLayoutEffect(() => {
    const panel = bodyRef.current;
    // Whatever the previous run armed is spent HERE, before the guard, not left
    // behind by it: a stale echo is the owner's own scroll, dropped for
    // matching a number no restore actually wrote.
    restoreEchoRef.current = null;
    if (!panel) return;
    panel.scrollTop = readStoredSourcesScroll()[band];
    // The value the browser ACTUALLY landed on. The assignment's own `scroll`
    // event is dispatched at the next rendering update rather than
    // synchronously (CSSOM View), so restoring before the listener is attached
    // does not keep that event out of it — and where the box is shorter than
    // the stored offset, the browser clamps the assignment and the echo carries
    // the CLAMP. Recorded, it would overwrite the offset the owner is about to
    // grow back into.
    restoreEchoRef.current = panel.scrollTop;
  }, [band, treeShowing]);

  useEffect(() => {
    const panel = bodyRef.current;
    if (!panel) return;
    setWindowLimit((current) =>
      nextSourceWindowLimit(
        current,
        leafCount,
        panel.scrollHeight > panel.clientHeight,
      ),
    );
  }, [leafCount, windowLimit]);

  // …and remembering it. Coalesced through `requestAnimationFrame` because a
  // scroll fires far faster than localStorage writes synchronously. Stays a
  // PASSIVE effect: it attaches a listener and has nothing to put on screen.
  //
  // The offset is captured AT THE SCROLL EVENT rather than inside the frame
  // (DW-208's shape, DW-519's surface). The cleanup used to cancel a pending
  // frame without flushing it, so a scroll in the last frame before the mode
  // switch or the Settings visit that UNMOUNTS this component was simply lost.
  // The flush cannot read the element at cleanup time — React has already
  // committed and the node is on its way out — and capturing at event time
  // removes the question entirely: `scrollTop` cannot move without a `scroll`
  // event, so the value the frame would have read and the value the event
  // captured are the same one. `-1` is the "nothing pending" sentinel, outside
  // the range a stored offset can hold.
  useEffect(() => {
    const panel = bodyRef.current;
    if (!panel) return;
    let frame = 0;
    let pending = -1;
    // Growing the window when a scroll reaches the bottom of what is rendered.
    // Extracted because it is NOT part of what the echo below suppresses: the
    // echo is about the stored OFFSET, and a restore that lands at the bottom of
    // the current window still has to be able to grow it. Suppressed along with
    // the write, a restored offset would re-apply and then the list would refuse
    // to continue until the owner scrolled away and back — and the other growth
    // effect above cannot cover it, because that one only fires while the panel
    // does NOT overflow.
    const growWindowAtBottom = () => {
      if (panel.scrollTop + panel.clientHeight < panel.scrollHeight - 48) return;
      setWindowLimit((current) =>
        current >= leafCount ? current : current + SOURCES_WINDOW_STEP,
      );
    };
    const onScroll = () => {
      // Read while the panel is demonstrably showing: a scroll event is proof
      // of that on its own.
      pending = panel.scrollTop;
      // Drop exactly one event — the restore's own echo (DW-521) — before this
      // starts recording. The arm is cleared UNCONDITIONALLY, so a restore that
      // changed nothing (and therefore fires no event at all) leaves an arm the
      // owner's next real scroll spends harmlessly instead of a latch that
      // swallows it.
      const echo = restoreEchoRef.current;
      restoreEchoRef.current = null;
      if (echo !== null && pending === echo) {
        pending = -1;
        // The POSITION still counts, even though the offset is not recorded.
        growWindowAtBottom();
        return;
      }
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        writeStoredSourcesScroll(band, pending);
        pending = -1;
        growWindowAtBottom();
      });
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      panel.removeEventListener("scroll", onScroll);
      if (frame === 0) return;
      cancelAnimationFrame(frame);
      // The lost last frame (DW-519). A pending value here is a scroll the
      // owner made that no frame has run for yet, and this component is being
      // unmounted by the very transition — a mode switch, a Settings visit —
      // whose whole premise is that it costs nothing.
      if (pending >= 0) writeStoredSourcesScroll(band, pending);
    };
  }, [leafCount, band, treeShowing]);

  if (!hasWiki) {
    return <p className="wb-tree-empty">{TREE_NO_WIKI_COPY}</p>;
  }
  if (filesUnavailable) {
    return <p className="wb-tree-empty">{FILES_UNAVAILABLE_COPY}</p>;
  }
  if (all.length === 0) {
    return <p className="wb-tree-empty">{SOURCES_EMPTY}</p>;
  }

  const selectedSource =
    selection?.kind === "file" ? workbenchSourcePath(selection.path) : null;

  return (
    <div className="wb-sources-tree" ref={bodyRef}>
      {selectedSource && (
        <MarkMeetingControl path={selectedSource} readOnly={readOnly} />
      )}
      <FileRows
        nodes={visible}
        depth={0}
        baseId={baseId}
        closed={closed}
        onToggle={toggle}
        selection={selection}
        onSelect={onSelect}
        onDelete={onDelete}
      />
      {truncated && <p className="wb-tree-note">{FILES_TRUNCATED_COPY}</p>}
    </div>
  );
}
