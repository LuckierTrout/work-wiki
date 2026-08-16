/**
 * Browser-local memory of the Workbench's layout state: which mode was last
 * active, whether the left column was collapsed, which tree tab was showing,
 * how wide the two side columns were dragged, which row was picked, and how far
 * each tree was scrolled (FR-8).
 *
 * These are per-browser view preferences, not owner data, so they live in
 * localStorage rather than the kernel store — panel widths are explicitly
 * browser-local in the epic's own constraints. Which WIKI is current is the one
 * thing deliberately absent from this file — not to be confused with which row
 * is picked, which is stored here and scoped to a Wiki id: the current Wiki
 * survives reload server-side through the registry's `currentId`, and a second
 * copy here would be a rival source of truth for the one piece of state this
 * epic keeps in the kernel.
 *
 * The keys keep the `yopedia` runtime prefix (AD-7): the rebrand is
 * display-only, and renaming a storage key silently drops a returning owner back
 * to the default.
 *
 * Shape follows `recent-ingests.ts`: SSR guard first, try/catch around every
 * access (private mode and quota both throw), and runtime narrowing of the
 * value read back — anything unrecognised degrades to the default. A
 * hand-edited or stale value must not restore a row that is not on screen.
 */

import {
  DEFAULT_WORKBENCH_MODE,
  isWorkbenchModeId,
  type WorkbenchModeId,
} from "@/lib/workbench-modes";
import {
  DEFAULT_SPLIT_WIDTHS,
  SPLIT_DEFAULT_PREVIEW,
  SPLIT_DEFAULT_TREE,
  type SplitWidths,
} from "@/lib/workbench-split";
import {
  DEFAULT_TREE_TAB,
  TREE_TABS,
  isTreeTabId,
  type TreeSelection,
  type TreeTabId,
} from "@/lib/workbench-tree";

export const WORKBENCH_MODE_KEY = "yopedia_workbench_mode";
export const WORKBENCH_COLLAPSED_KEY = "yopedia_workbench_left_collapsed";
export const WORKBENCH_TREE_TAB_KEY = "yopedia_workbench_tree_tab";
export const WORKBENCH_SPLIT_KEY = "yopedia_workbench_split";
export const WORKBENCH_SELECTION_KEY = "yopedia_workbench_selection";
export const WORKBENCH_TREE_SCROLL_KEY = "yopedia_workbench_tree_scroll";

/** The only stored value that means "collapsed"; everything else is expanded. */
const COLLAPSED_TRUE = "1";

export function readStoredMode(): WorkbenchModeId {
  if (typeof window === "undefined") return DEFAULT_WORKBENCH_MODE;
  try {
    const raw = window.localStorage.getItem(WORKBENCH_MODE_KEY);
    // A mode id from an older build (or a hand-edited value) must not select a
    // mode that no longer exists — the rail would render with nothing active.
    return isWorkbenchModeId(raw) ? raw : DEFAULT_WORKBENCH_MODE;
  } catch {
    return DEFAULT_WORKBENCH_MODE;
  }
}

export function writeStoredMode(mode: WorkbenchModeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_MODE_KEY, mode);
  } catch {
    // localStorage unavailable (private mode / quota) — the mode still works
    // for this session; only the restore on reload is lost.
  }
}

export function readStoredCollapsed(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(WORKBENCH_COLLAPSED_KEY) === COLLAPSED_TRUE;
  } catch {
    return false;
  }
}

export function writeStoredCollapsed(collapsed: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_COLLAPSED_KEY, collapsed ? COLLAPSED_TRUE : "0");
  } catch {
    // Non-critical: the column stays collapsed for this session.
  }
}

export function readStoredTreeTab(): TreeTabId {
  if (typeof window === "undefined") return DEFAULT_TREE_TAB;
  try {
    const raw = window.localStorage.getItem(WORKBENCH_TREE_TAB_KEY);
    // Same rule as the mode above: a tab id from an older build (or a
    // hand-edited value) must not select a panel that no longer exists — the
    // tablist would render with nothing selected.
    return isTreeTabId(raw) ? raw : DEFAULT_TREE_TAB;
  } catch {
    return DEFAULT_TREE_TAB;
  }
}

export function writeStoredTreeTab(tab: TreeTabId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_TREE_TAB_KEY, tab);
  } catch {
    // Non-critical: the tab still switches for this session; only the restore
    // on reload is lost.
  }
}

// ---------------------------------------------------------------------------
// Story 1.6 — column widths, the tree selection, and the tree scroll offset
// ---------------------------------------------------------------------------

/**
 * The one JSON read. Everything below narrows what comes back itself, because
 * `JSON.parse` answers `null`, a number or a string just as happily as an
 * object, and a stored value is whatever the previous build (or a hand edit)
 * left behind.
 */
function readStoredRecord(key: string): Record<string, unknown> | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  } catch {
    // Unreadable storage or unparseable JSON — both mean "no stored value".
    return null;
  }
}

function writeStoredJson(key: string, value: unknown): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Non-critical: the layout still works for this session.
  }
}

function clearStored(key: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Same degrade as every write above.
  }
}

/** A width is only a width if it is a positive, finite number of pixels. */
function storedWidth(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.round(value)
    : fallback;
}

/**
 * The two dragged column widths. Each side falls back to its own default
 * INDEPENDENTLY: a stored object that lost one field (an older build, a partial
 * hand edit) must not drag the other column back to 280px too.
 *
 * A width larger than the frame is not rejected here — it is a preference, and
 * `clampSplitWidths` reduces it to what fits at render. Rejecting it would throw
 * away a layout that becomes valid again the moment the window is widened.
 */
export function readStoredSplitWidths(): SplitWidths {
  const record = readStoredRecord(WORKBENCH_SPLIT_KEY);
  if (!record) return DEFAULT_SPLIT_WIDTHS;
  return {
    tree: storedWidth(record.tree, SPLIT_DEFAULT_TREE),
    preview: storedWidth(record.preview, SPLIT_DEFAULT_PREVIEW),
  };
}

export function writeStoredSplitWidths(widths: SplitWidths): void {
  writeStoredJson(WORKBENCH_SPLIT_KEY, {
    tree: Math.round(widths.tree),
    preview: Math.round(widths.preview),
  });
}

/** What the shell stored: a row, and the Wiki whose trees it names. */
export interface StoredSelection {
  wikiId: string;
  selection: TreeSelection;
}

function storedSelectionShape(value: unknown): TreeSelection | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.kind === "page") {
    return typeof record.slug === "string" && record.slug.length > 0
      ? { kind: "page", slug: record.slug }
      : null;
  }
  if (record.kind === "file") {
    return typeof record.path === "string" && record.path.length > 0
      ? { kind: "file", path: record.path }
      : null;
  }
  // A `kind` this build does not have — the union grew or shrank between
  // sessions. Restoring it would dock a Preview nothing can render.
  return null;
}

/**
 * The last picked row, scoped to the Wiki it was picked in.
 *
 * The id travels with the pick because the Wiki selection itself is durable
 * SERVER-side: what this owes FR-8 is that a restored row belongs to the Wiki
 * the registry still calls current, not that it remembers which Wiki that was.
 * The caller is still responsible for checking the row exists — this only
 * guarantees the SHAPE is one the shell can act on.
 */
export function readStoredSelection(): StoredSelection | null {
  const record = readStoredRecord(WORKBENCH_SELECTION_KEY);
  if (!record) return null;
  const wikiId = record.wikiId;
  if (typeof wikiId !== "string" || wikiId.length === 0) return null;
  const selection = storedSelectionShape(record.selection);
  return selection ? { wikiId, selection } : null;
}

/**
 * Remember the pick, or forget it. A cleared selection REMOVES the key rather
 * than storing `null` under a live shape, so "nothing is picked" and "this build
 * wrote something it could not describe" stay distinguishable on read.
 */
export function writeStoredSelection(
  wikiId: string | null,
  selection: TreeSelection | null,
): void {
  if (wikiId === null || selection === null) {
    clearStored(WORKBENCH_SELECTION_KEY);
    return;
  }
  writeStoredJson(WORKBENCH_SELECTION_KEY, { wikiId, selection });
}

/** Scroll offsets are whole pixels from the top, never negative. */
function storedOffset(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0
    ? value
    : 0;
}

/**
 * How far each tree was scrolled. Per TAB, because the two trees are different
 * lengths and one offset would drop the owner in the wrong place on whichever
 * tab they did not leave.
 */
export function readStoredTreeScroll(): Record<TreeTabId, number> {
  const record = readStoredRecord(WORKBENCH_TREE_SCROLL_KEY);
  const offsets = {} as Record<TreeTabId, number>;
  for (const tab of TREE_TABS) {
    offsets[tab.id] = record ? storedOffset(record[tab.id]) : 0;
  }
  return offsets;
}

export function writeStoredTreeScroll(tab: TreeTabId, offset: number): void {
  writeStoredJson(WORKBENCH_TREE_SCROLL_KEY, {
    ...readStoredTreeScroll(),
    [tab]: storedOffset(Math.round(offset)),
  });
}
