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
  TREE_SCROLL_BANDS,
  type SplitWidths,
  type TreeScrollBand,
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
export const WORKBENCH_SOURCES_SCROLL_KEY = "yopedia_workbench_sources_scroll";
export const WORKBENCH_GRAPH_LAYOUT_KEY = "yopedia_workbench_graph_layout";
export const WORKBENCH_RESEARCH_FILL_KEY = "yopedia_workbench_research_fill";

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
  const parsed = readStoredValue(key);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}

/**
 * The same read, WITHOUT the object narrowing — for the one key whose legacy
 * shape is a bare number (see {@link readStoredSourcesScroll}). A migration has
 * to be able to SEE the value it is migrating, and `readStoredRecord` answers
 * `null` for a scalar just as it does for unreadable storage, which would erase
 * the offset it exists to carry forward.
 */
function readStoredValue(key: string): unknown {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === null) return null;
    return JSON.parse(raw) as unknown;
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
 * tab they did not leave — and, since DW-206, per WIDTH BAND as well.
 *
 * ONE OFFSET PER TAB WAS WRONG. The tab has two scroll RANGES, not one: above
 * 900px the tree body scrolls the left column's whole height, and below it
 * `globals.css` caps `.wb-tree-body` at `40vh`. A single stored number is
 * therefore recorded in whichever layout the owner happened to be in and
 * restored into the other, where the browser CLAMPS it — and the clamp fires a
 * `scroll`, which the persist effect writes straight back. Cross the breakpoint
 * once and the desktop offset is gone, replaced by the narrow layout's maximum.
 * Keying by {@link TreeScrollBand} gives each range its own memory, so neither
 * write can reach the other.
 *
 * LEGACY VALUES. A bare number under a tab is what every build before DW-206
 * wrote. It is read as that tab's WIDE offset — the range only the desktop
 * layout has, and the layout that number was almost certainly recorded in —
 * and the narrow band starts at the top rather than inheriting an offset from
 * a range it does not share. Anything else degrades to 0 for BOTH bands, the
 * same rule every other read in this file follows.
 */
export function readStoredTreeScroll(): Record<TreeTabId, Record<TreeScrollBand, number>> {
  const record = readStoredRecord(WORKBENCH_TREE_SCROLL_KEY);
  const offsets = {} as Record<TreeTabId, Record<TreeScrollBand, number>>;
  for (const tab of TREE_TABS) {
    const stored: unknown = record ? record[tab.id] : undefined;
    // The legacy shape, migrated on read: a number here is a pre-DW-206 offset
    // and belongs to the wide band alone.
    const legacy = typeof stored === "number";
    const banded =
      typeof stored === "object" && stored !== null && !Array.isArray(stored)
        ? (stored as Record<string, unknown>)
        : null;
    const bands = {} as Record<TreeScrollBand, number>;
    for (const band of TREE_SCROLL_BANDS) {
      bands[band] = legacy
        ? band === "wide"
          ? storedOffset(stored)
          : 0
        : banded
          ? storedOffset(banded[band])
          : 0;
    }
    offsets[tab.id] = bands;
  }
  return offsets;
}

export function writeStoredTreeScroll(
  tab: TreeTabId,
  band: TreeScrollBand,
  offset: number,
): void {
  // Read-modify-write through the narrowing read above, so a legacy or partly
  // unusable value is normalised into the banded shape by the first write
  // rather than left for the next read to keep migrating.
  const current = readStoredTreeScroll();
  writeStoredJson(WORKBENCH_TREE_SCROLL_KEY, {
    ...current,
    [tab]: { ...current[tab], [band]: storedOffset(Math.round(offset)) },
  });
}

/**
 * How far the Sources tree was scrolled, per WIDTH BAND (DW-519).
 *
 * The same argument {@link readStoredTreeScroll} makes one column over, for the
 * surface that was left out of it — reached by a different route in the
 * stylesheet, which is worth saying plainly because the two are easy to
 * conflate. `.wb-tree-body` is capped at `40vh` inside `@media (max-width:
 * 899px)`; `.wb-sources-tree` has NO narrow rule at all. It carries one
 * declaration block in the whole sheet (`flex: 1 1 auto; min-height: 0;
 * overflow: auto`), so what differs between the two layouts is the box it flexes
 * inside: above 900px `.wb-left` is a bounded column inside a `.wb-shell`
 * clamped to `100dvh`, and below it the shell stacks to one column, `.wb-left`
 * becomes `overflow: visible`, and — with a Preview docked — the shell's clamp
 * is released so the DOCUMENT scrolls instead.
 *
 * Either way the tree has two scroll RANGES and not one, so a single stored
 * number is recorded in whichever layout the owner happened to be in and
 * restored into the other, where the browser CLAMPS it. The clamp fires a
 * `scroll`, the persist writes it straight back, and one crossing of the
 * breakpoint destroys the desktop offset.
 *
 * There is no per-TAB dimension here: Sources mode has one tree.
 *
 * LEGACY VALUES. Every build before DW-519 wrote a bare integer STRING under
 * this key. `JSON.parse` reads it back as a number, and it is migrated into the
 * WIDE band on read — the range only the desktop layout has, and the one that
 * number was almost certainly recorded in — while the narrow band starts at the
 * top rather than inheriting an offset from a range it does not share. The
 * first write normalises the key to the banded shape. Anything else degrades to
 * 0 for BOTH bands, the same rule every other read in this file follows.
 */
export function readStoredSourcesScroll(): Record<TreeScrollBand, number> {
  const stored = readStoredValue(WORKBENCH_SOURCES_SCROLL_KEY);
  const legacy = typeof stored === "number";
  const banded =
    typeof stored === "object" && stored !== null && !Array.isArray(stored)
      ? (stored as Record<string, unknown>)
      : null;
  const bands = {} as Record<TreeScrollBand, number>;
  for (const band of TREE_SCROLL_BANDS) {
    bands[band] = legacy
      ? band === "wide"
        ? storedOffset(stored)
        : 0
      : banded
        ? storedOffset(banded[band])
        : 0;
  }
  return bands;
}

export function writeStoredSourcesScroll(
  band: TreeScrollBand,
  offset: number,
): void {
  // Read-modify-write through the narrowing read above, so a legacy or partly
  // unusable value is normalised into the banded shape by the first write
  // rather than left for the next read to keep migrating — and so neither
  // band's write can reach the other.
  const current = readStoredSourcesScroll();
  writeStoredJson(WORKBENCH_SOURCES_SCROLL_KEY, {
    ...current,
    [band]: storedOffset(Math.round(offset)),
  });
}

export interface GraphNodePosition {
  x: number;
  y: number;
}

export interface GraphLayoutCache {
  camera?: { x: number; y: number; ratio: number };
  positions: Record<string, GraphNodePosition>;
}

function storedPosition(value: unknown): GraphNodePosition | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (typeof record.x !== "number" || typeof record.y !== "number") return null;
  if (!Number.isFinite(record.x) || !Number.isFinite(record.y)) return null;
  return { x: record.x, y: record.y };
}

export function readStoredGraphLayout(): GraphLayoutCache {
  const record = readStoredRecord(WORKBENCH_GRAPH_LAYOUT_KEY);
  if (!record) return { positions: {} };
  const positions: Record<string, GraphNodePosition> = {};
  if (record.positions && typeof record.positions === "object" && !Array.isArray(record.positions)) {
    for (const [id, value] of Object.entries(record.positions as Record<string, unknown>)) {
      const pos = storedPosition(value);
      if (pos) positions[id] = pos;
    }
  }
  const cameraRaw = record.camera;
  let camera: GraphLayoutCache["camera"];
  if (cameraRaw && typeof cameraRaw === "object") {
    const cam = cameraRaw as Record<string, unknown>;
    if (
      typeof cam.x === "number" &&
      typeof cam.y === "number" &&
      typeof cam.ratio === "number" &&
      Number.isFinite(cam.x) &&
      Number.isFinite(cam.y) &&
      Number.isFinite(cam.ratio) &&
      cam.ratio > 0
    ) {
      camera = { x: cam.x, y: cam.y, ratio: cam.ratio };
    }
  }
  return camera ? { camera, positions } : { positions };
}

export function writeStoredGraphLayout(layout: GraphLayoutCache): void {
  writeStoredJson(WORKBENCH_GRAPH_LAYOUT_KEY, {
    ...(layout.camera ? { camera: layout.camera } : {}),
    positions: layout.positions,
  });
}

export function readStoredResearchFill(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKBENCH_RESEARCH_FILL_KEY);
    return raw && raw.length > 0 ? raw : null;
  } catch {
    return null;
  }
}

export function writeStoredResearchFill(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (!id) window.localStorage.removeItem(WORKBENCH_RESEARCH_FILL_KEY);
    else window.localStorage.setItem(WORKBENCH_RESEARCH_FILL_KEY, id);
  } catch {
    // private mode / quota
  }
}
