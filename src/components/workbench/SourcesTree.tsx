"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  readStoredSourcesScroll,
  writeStoredSourcesScroll,
} from "@/lib/workbench-state";
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

  useEffect(() => {
    const panel = bodyRef.current;
    if (!panel) return;
    panel.scrollTop = readStoredSourcesScroll();
  }, []);

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

  useEffect(() => {
    const panel = bodyRef.current;
    if (!panel) return;
    let frame = 0;
    const onScroll = () => {
      if (frame !== 0) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        writeStoredSourcesScroll(panel.scrollTop);
        if (panel.scrollTop + panel.clientHeight >= panel.scrollHeight - 48) {
          setWindowLimit((current) =>
            current >= leafCount ? current : current + SOURCES_WINDOW_STEP,
          );
        }
      });
    };
    panel.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      panel.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [leafCount]);

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
