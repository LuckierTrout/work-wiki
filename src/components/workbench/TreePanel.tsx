"use client";

import { useCallback, useId, useState, type CSSProperties } from "react";
import {
  FILES_EMPTY_COPY,
  FILES_TRUNCATED_COPY,
  FILES_UNAVAILABLE_COPY,
  KNOWLEDGE_EMPTY_COPY,
  KNOWLEDGE_UNAVAILABLE_COPY,
  TREE_NO_WIKI_COPY,
  TREE_TABS,
  TREE_UNAVAILABLE_COPY,
  type FileNode,
  type KnowledgeGroup,
  type TreeSelection,
  type TreeTabId,
} from "@/lib/workbench-tree";
import { ChevronLeftIcon } from "./RailIcons";

/**
 * The left column's `Knowledge | Files` tabs and the tree under them (UX-DR5).
 *
 * Nested `<ul>` with native `<button>` rows, `aria-expanded` disclosures and
 * `aria-current` on the selection — deliberately not the ARIA tree pattern. A
 * real ARIA tree needs roving `tabindex` and arrow-key navigation, and this
 * repo has no DOM test environment to verify either (DW-24). What ships here is
 * a complete keyboard surface built entirely from platform semantics, with no
 * focus machinery that could silently rot.
 *
 * Both tabs stay in the tab order for the same reason: roving `tabindex` on the
 * tablist without arrow-key handling would leave the second tab unreachable.
 *
 * Every sentence comes from `@/lib/workbench-tree` — the copy the UX handoff
 * fixes has exactly one definition.
 */

export interface TreePanelProps {
  tab: TreeTabId;
  onTabChange: (tab: TreeTabId) => void;
  knowledge: readonly KnowledgeGroup[];
  files: readonly FileNode[];
  /** The file walk hit a cap; the tree below is real but incomplete. */
  truncated?: boolean;
  /** False when the registry is empty — neither tab has a Wiki to show. */
  hasWiki: boolean;
  /** The registry read failed, so "no wiki" is a claim this cannot make. */
  unavailable?: boolean;
  /**
   * The page index read failed. Distinct from `knowledge.length === 0`: an
   * empty tab tells the owner to ingest a source, which is advice premised on
   * a fact nobody has when the read failed.
   */
  knowledgeUnavailable?: boolean;
  /** Same distinction for the file walk. */
  filesUnavailable?: boolean;
  selection: TreeSelection | null;
  onSelect: (selection: TreeSelection) => void;
}

/** 12px per level (`mockups/todos.html:111`), applied in CSS from this depth. */
function indent(depth: number): CSSProperties {
  // A custom property rather than a literal `paddingLeft`, so the step itself
  // stays a `--wb-*` token in globals.css and this only says "how deep".
  return { "--wb-depth": depth } as CSSProperties;
}

export function TreePanel({
  tab,
  onTabChange,
  knowledge,
  files,
  truncated = false,
  hasWiki,
  unavailable = false,
  knowledgeUnavailable = false,
  filesUnavailable = false,
  selection,
  onSelect,
}: TreePanelProps) {
  const baseId = useId();
  // Groups and directories open by default: a tree that starts fully collapsed
  // hides the very thing the tab exists to show. Only explicit closes are
  // remembered, so a newly appeared group is open too.
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const toggle = useCallback((key: string) => {
    setClosed((current) => ({ ...current, [key]: !current[key] }));
  }, []);

  const panelId = `${baseId}-panel`;

  function body() {
    if (unavailable) {
      return <p className="wb-tree-empty">{TREE_UNAVAILABLE_COPY}</p>;
    }
    if (!hasWiki) {
      return <p className="wb-tree-empty">{TREE_NO_WIKI_COPY}</p>;
    }
    if (tab === "knowledge") {
      if (knowledgeUnavailable) {
        return <p className="wb-tree-empty">{KNOWLEDGE_UNAVAILABLE_COPY}</p>;
      }
      if (knowledge.length === 0) {
        return <p className="wb-tree-empty">{KNOWLEDGE_EMPTY_COPY}</p>;
      }
      return (
        <ul className="wb-tree-list">
          {knowledge.map((group, index) => {
            const key = `group:${group.id}`;
            // Positional, not derived from `group.id`: `type` is a free string,
            // so an id built from it can carry a space (an `aria-controls` value
            // is an IDREF LIST — one space and the reference silently breaks)
            // and a literal `type: untyped` would collide with the untyped
            // group's own fallback.
            const listId = `${baseId}-g-${index}`;
            const open = !closed[key];
            return (
              <li key={key}>
                <button
                  type="button"
                  className="wb-tree-row wb-tree-row--group"
                  aria-expanded={open}
                  // Only while open: a reference to an element that is not
                  // rendered is a dangling IDREF, which AT reports as a broken
                  // relationship rather than as a closed one. `aria-expanded`
                  // already carries the closed state.
                  aria-controls={open ? listId : undefined}
                  onClick={() => toggle(key)}
                  style={indent(0)}
                >
                  <ChevronLeftIcon className="wb-tree-chevron" />
                  <span className="wb-tree-label" title={group.label}>
                    {group.label}
                  </span>
                  <span className="wb-tree-count">{group.count}</span>
                </button>
                {open && (
                  <ul className="wb-tree-list" id={listId}>
                    {group.pages.map((page) => (
                      <li key={page.slug}>
                        <button
                          type="button"
                          className="wb-tree-row"
                          style={indent(1)}
                          aria-current={
                            selection?.kind === "page" && selection.slug === page.slug
                              ? "true"
                              : undefined
                          }
                          onClick={() => onSelect({ kind: "page", slug: page.slug })}
                        >
                          {/* The label ellipsizes at 280px, so the full title
                              has to stay recoverable without a Preview dock. */}
                          <span className="wb-tree-label" title={page.title}>
                            {page.title}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      );
    }
    if (tab === "files") {
      if (filesUnavailable) {
        return <p className="wb-tree-empty">{FILES_UNAVAILABLE_COPY}</p>;
      }
      if (files.length === 0) {
        return <p className="wb-tree-empty">{FILES_EMPTY_COPY}</p>;
      }
      return (
        <>
          <FileRows
            nodes={files}
            depth={0}
            baseId={baseId}
            closed={closed}
            onToggle={toggle}
            selection={selection}
            onSelect={onSelect}
          />
          {truncated && <p className="wb-tree-note">{FILES_TRUNCATED_COPY}</p>}
        </>
      );
    }
    // Every tab is handled by name above. A future third tab renders nothing
    // rather than falling through to the file tree under its own label — an
    // empty panel is a visible gap, a mislabelled one is not.
    return null;
  }

  return (
    <div className="wb-tree-panel" data-no-localize>
      <div className="wb-tabs" role="tablist" aria-label="Left column trees">
        {TREE_TABS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            id={`${baseId}-tab-${entry.id}`}
            aria-selected={tab === entry.id}
            // Only the selected tab controls the panel: there is one panel, and
            // an unselected tab claiming to control it says it is showing
            // content that belongs to its sibling.
            aria-controls={tab === entry.id ? panelId : undefined}
            className={`wb-tab${tab === entry.id ? " wb-tab--active" : ""}`}
            onClick={() => onTabChange(entry.id)}
          >
            {entry.label}
          </button>
        ))}
      </div>
      <div
        className="wb-tree-body"
        role="tabpanel"
        id={panelId}
        aria-labelledby={`${baseId}-tab-${tab}`}
        tabIndex={0}
      >
        {body()}
      </div>
    </div>
  );
}

interface FileRowsProps {
  nodes: readonly FileNode[];
  depth: number;
  /** Set on the `<ul>` so the disclosure above it can `aria-controls` it. */
  id?: string;
  /** Prefix for the ids a disclosure points its `aria-controls` at. */
  baseId: string;
  closed: Record<string, boolean>;
  onToggle: (key: string) => void;
  selection: TreeSelection | null;
  onSelect: (selection: TreeSelection) => void;
}

/**
 * Directories are disclosures; files are the selectable rows. A directory has
 * no bytes to preview, so making it selectable would dock a Preview column with
 * nothing in it — and an EMPTY directory gets no control at all, because a
 * disclosure that expands to nothing is a button with no effect to observe.
 */
function FileRows({
  nodes,
  depth,
  id,
  baseId,
  closed,
  onToggle,
  selection,
  onSelect,
}: FileRowsProps) {
  // Ids are positional and chained through the parent list's id, never built
  // from `node.path`: a directory or file name may contain a space, and a space
  // inside `aria-controls` splits it into two references that resolve to
  // nothing. Chaining keeps them unique across sibling subtrees at equal depth.
  const rowPrefix = id ?? `${baseId}-f`;
  return (
    <ul className="wb-tree-list" id={id}>
      {nodes.map((node, index) => {
        if (!node.isDirectory) {
          const active = selection?.kind === "file" && selection.path === node.path;
          return (
            <li key={node.path}>
              <button
                type="button"
                className="wb-tree-row"
                style={indent(depth)}
                aria-current={active ? "true" : undefined}
                onClick={() => onSelect({ kind: "file", path: node.path })}
              >
                <span className="wb-tree-label" title={node.path}>
                  {node.name}
                </span>
              </button>
            </li>
          );
        }
        if (node.children.length === 0) {
          return (
            <li key={node.path}>
              <span
                className="wb-tree-row wb-tree-row--group wb-tree-row--static"
                style={indent(depth)}
              >
                <span className="wb-tree-label" title={node.path}>
                  {node.name}/
                </span>
              </span>
            </li>
          );
        }
        const key = `dir:${node.path}`;
        const listId = `${rowPrefix}-${index}`;
        const open = !closed[key];
        return (
          <li key={node.path}>
            <button
              type="button"
              className="wb-tree-row wb-tree-row--group"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              onClick={() => onToggle(key)}
              style={indent(depth)}
            >
              <ChevronLeftIcon className="wb-tree-chevron" />
              <span className="wb-tree-label" title={node.path}>
                {node.name}/
              </span>
            </button>
            {open && (
              <FileRows
                nodes={node.children}
                depth={depth + 1}
                id={listId}
                baseId={baseId}
                closed={closed}
                onToggle={onToggle}
                selection={selection}
                onSelect={onSelect}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}
