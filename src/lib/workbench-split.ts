/**
 * The Workbench's column geometry (Story 1.6) — one module owning every number
 * a drag, a key press or a screen reader can produce.
 *
 * Pure and client-safe, exactly like `workbench-modes.ts` and `workbench-tree.ts`:
 * the shell and the separator control import it in the browser, and the node
 * suite imports it to EXECUTE the bounds, the clamp, pointer-x → width and
 * key → width. Every one of those is a pure function the `node` project runs
 * directly — which is why the separator control holds state and reads
 * `getBoundingClientRect()` but spells no bound, no comparison and no step: the
 * `dom` project mounts it to check the wiring, and the geometry itself is
 * settled here.
 *
 * The constants restate the six `--wb-*` geometry tokens declared in the single
 * `.wb-shell { … }` block in `globals.css`. Two copies of a number is drift
 * waiting to happen, so `workbench-split.test.ts` parses the stylesheet and
 * asserts each pair equal rather than trusting a comment.
 *
 * ONE definition of the bounds. `splitBounds` is what the clamp obeys AND what
 * a handle reports through `aria-valuemin` / `aria-valuemax`: a drag that stops
 * somewhere the ARIA range says it should not is a lie to a screen reader.
 */

// Type-only, and one-way: `workbench-modes` and `workbench-tree` import nothing
// from here, so naming their unions costs no cycle at build time or at runtime.
import type { WorkbenchModeId } from "@/lib/workbench-modes";
import type { TreeTabId } from "@/lib/workbench-tree";

// ---------------------------------------------------------------------------
// Geometry — asserted equal to the `globals.css` token declarations by a test
// ---------------------------------------------------------------------------

/** `--wb-rail: 48px` — the icon rail is never resizable, so it is a constant. */
export const SPLIT_RAIL_WIDTH = 48;

/** `--wb-split-min-tree: 200px`. */
export const SPLIT_MIN_TREE = 200;

/** `--wb-split-min-preview: 200px`. */
export const SPLIT_MIN_PREVIEW = 200;

/**
 * `--wb-split-min-chat: 320px`, applied to the CANVAS in every mode.
 *
 * `epics.md:442` reads "Chat (when visible) cannot go below 320px", and in
 * Epic 1 Chat is not a column — it is what the canvas renders when the rail's
 * second icon is active. Nothing about a mode switch changes a width, so a tree
 * dragged to leave 240px of canvas in Wiki mode would either crush Chat on the
 * next click or snap the layout under the owner. Holding the floor on the canvas
 * itself makes the rule true at every moment, and it is simultaneously the
 * "maximum" FR-6 asks for: the tree and the Preview cannot consume the frame
 * because the canvas keeps 320px.
 */
export const SPLIT_MIN_CANVAS = 320;

/** `--wb-tree: 280px` — the preferred width a browser with no memory starts at. */
export const SPLIT_DEFAULT_TREE = 280;

/** `--wb-preview: 360px`. */
export const SPLIT_DEFAULT_PREVIEW = 360;

/**
 * How far one arrow press moves a divider. Restates `--wb-space-4`, the shell's
 * largest spacing step, and is asserted equal to that declaration alongside the
 * six widths: small enough to land on a width the owner meant, large enough that
 * crossing a 400px range is not forty presses.
 */
export const SPLIT_KEY_STEP = 16;

/**
 * The COARSE keyboard step, derived rather than typed (DW-45).
 *
 * `SPLIT_KEY_STEP * 4` rather than `64`: crossing the tree's real range with the
 * arrow step alone is ~30 presses, and a second literal would be a seventh magic
 * number to keep on the stylesheet's pixel grid. Deriving it means the two steps
 * cannot drift apart, and PageUp/PageDown always land on a width an arrow could
 * also reach.
 */
export const SPLIT_KEY_PAGE_STEP = SPLIT_KEY_STEP * 4;

/**
 * `--wb-split-hit: 24px` — the grab strip a divider offers (DW-44).
 *
 * WCAG 2.2 AA SC 2.5.8 wants 24×24 CSS px, and the spacing exception does not
 * apply here because the tree rows beside the divider are adjacent targets. The
 * strip is asserted equal to the token declaration alongside the six widths, and
 * it is also the clamp on `splitGrabOffset`: a press the browser reports from
 * outside the strip cannot offset a drag by more than the strip is wide.
 */
export const SPLIT_HIT_WIDTH = 24;

/**
 * The one breakpoint at which the shell stops being three desktop columns
 * (DW-47). Below it the rail becomes an off-canvas sheet, a collapsed left
 * column is force-shown, and a docked Preview becomes a stacked fourth row.
 *
 * `globals.css` owns the media BLOCKS — four of them spell these widths out, and
 * several node suites slice the stylesheet by those exact strings. What this
 * module owns is the only copy any RUNTIME JavaScript is allowed to hold: the
 * shell's sheet and dock-reveal effects and `TreePanel`'s scroll memory all read
 * the constants below, so no component carries a breakpoint of its own to drift.
 * Both queries are BUILT from the one number, and `workbench-split.test.ts` pins
 * the result against the blocks in `globals.css` — the stylesheet is the
 * authority, and this is the single pointer at it.
 */
export const SPLIT_STACK_BREAKPOINT = 900;

/** Desktop and up: the rail is a column, not a sheet. */
export const SPLIT_WIDE_QUERY = `(min-width: ${SPLIT_STACK_BREAKPOINT}px)`;

/**
 * …and below it. NOT an exact complement: at a fractional width — 899.5px,
 * routine under browser zoom and fractional DPI scaling — neither query matches.
 * That gap is inherited from the four `@media` blocks in `globals.css` these two
 * constants exist to MIRROR, whose strings have to stay character-identical
 * because other node suites slice the stylesheet by them; closing it is a
 * stylesheet decision and would have to be made in both places at once.
 */
export const SPLIT_NARROW_QUERY = `(max-width: ${SPLIT_STACK_BREAKPOINT - 1}px)`;

/**
 * `PointerEvent.button` for the primary button — the left button on a mouse, and
 * the only value touch and pen report on a press.
 */
const PRIMARY_POINTER_BUTTON = 0;

// ---------------------------------------------------------------------------
// Copy — the accessible names, character-exact (Design Notes → Copy)
// ---------------------------------------------------------------------------

export const SPLIT_TREE_LABEL = "Resize the left column";
export const SPLIT_PREVIEW_LABEL = "Resize the Preview column";

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

/** Which boundary a separator sits on. Also the handle's modifier class. */
export type SplitId = "tree" | "preview";

/** The fields of a `pointerdown` a divider is allowed to look at. */
export interface SplitPointerPress {
  button: number;
  isPrimary: boolean;
}

/** The modifier state of a `keydown`. */
export interface SplitKeyModifiers {
  altKey: boolean;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
}

/**
 * Is this press one the divider should take the pointer for?
 *
 * A right- or middle-click on the grab strip would otherwise call
 * `setPointerCapture` and arm `data-resizing`, after which the divider follows a
 * pointer with no button held down for as long as the context menu is open.
 * `isPrimary` is the second half: on a multi-touch surface only the first
 * contact drives the drag, or two fingers fight over one boundary.
 */
export function isPrimarySplitPress(press: SplitPointerPress): boolean {
  return press.button === PRIMARY_POINTER_BUTTON && press.isPrimary;
}

/**
 * Is this key press the divider's to claim?
 *
 * ANY modifier means it is the platform's: Alt+Left is browser-back, Ctrl/Alt +
 * arrow is word-jump on Windows and Linux, Meta+Left is back on macOS, and
 * Shift+arrow is the selection-extension idiom. This divider implements no
 * modified gesture of its own, so claiming one — and calling `preventDefault` on
 * it — would only take a working shortcut away from a keyboard user who happened
 * to have focus on a separator.
 */
export function isUnmodifiedSplitKey(modifiers: SplitKeyModifiers): boolean {
  return (
    !modifiers.altKey && !modifiers.ctrlKey && !modifiers.metaKey && !modifiers.shiftKey
  );
}

/** The two resizable column widths, in CSS pixels. */
export interface SplitWidths {
  tree: number;
  preview: number;
}

/** Everything outside the two widths that decides how much room they have. */
export interface SplitLayout {
  /** The measured `.wb-shell` width. `0` before the shell has been measured. */
  shellWidth: number;
  /** Is the Preview docked as a fourth column? */
  previewOpen: boolean;
  /** Is the left column collapsed to a zero-width track? */
  collapsed: boolean;
}

/** The range one column may take, in CSS pixels. */
export interface SplitBounds {
  min: number;
  max: number;
}

/** The inline custom properties the shell applies once it has been measured. */
export interface SplitStyleVars {
  "--wb-tree": string;
  "--wb-preview": string;
}

/** The defaults a browser with no stored layout starts at. */
export const DEFAULT_SPLIT_WIDTHS: SplitWidths = {
  tree: SPLIT_DEFAULT_TREE,
  preview: SPLIT_DEFAULT_PREVIEW,
};

/** The label a separator announces itself with. */
export function splitLabel(id: SplitId): string {
  return id === "tree" ? SPLIT_TREE_LABEL : SPLIT_PREVIEW_LABEL;
}

/**
 * Has the shell been measured yet? Before the mount effect runs there is no
 * width, and every derived bound would be the floor — so the widths are left
 * exactly as they are and no inline custom property is written.
 */
export function isSplitMeasured(layout: SplitLayout): boolean {
  return Number.isFinite(layout.shellWidth) && layout.shellWidth > 0;
}

/**
 * Fit one width into one range, in whole pixels — the only comparison in this
 * story, and the reason a handler is not allowed to spell it.
 */
export function clampSplitWidth(value: number, bounds: SplitBounds): number {
  return Math.round(Math.min(Math.max(value, bounds.min), bounds.max));
}

/**
 * One column's width replaced; the other left exactly as the owner set it.
 *
 * Dragging the tree must not quietly rewrite the Preview's stored preference to
 * whatever it happened to be rendered at while the frame was narrow.
 */
export function withSplitWidth(
  widths: SplitWidths,
  id: SplitId,
  value: number,
): SplitWidths {
  return id === "tree" ? { ...widths, tree: value } : { ...widths, preview: value };
}

/**
 * How wide one column may be, given what the OTHER one is currently taking.
 *
 * The maximum is the frame minus the rail, minus the canvas floor, minus the
 * other side column — and never below this column's own floor, so a viewport
 * too small for every floor at once yields a degenerate (min === max) range
 * rather than a negative track the grid would resolve by overflowing.
 *
 * A collapsed left column contributes nothing, and a closed Preview contributes
 * nothing: in both cases the space is genuinely there for the other column.
 */
export function splitBounds(
  id: SplitId,
  widths: SplitWidths,
  layout: SplitLayout,
): SplitBounds {
  const min = id === "tree" ? SPLIT_MIN_TREE : SPLIT_MIN_PREVIEW;
  const other =
    id === "tree"
      ? layout.previewOpen
        ? widths.preview
        : 0
      : layout.collapsed
        ? 0
        : widths.tree;
  const room = layout.shellWidth - SPLIT_RAIL_WIDTH - SPLIT_MIN_CANVAS - other;
  return { min, max: Math.max(min, Math.round(room)) };
}

/**
 * Fit both preferred widths into the frame that actually exists.
 *
 * The ORDER is the content of the decision, which is why this is a function the
 * suite runs rather than a `minmax()` in the grid: a grid cannot express "when
 * there is not enough room, shrink the TREE" — it overflows instead, and
 * `.wb-shell` is `overflow: hidden`, so the Preview would be clipped out of
 * existence rather than the tree giving up 40px. The tree is clamped first, then
 * the Preview is clamped against the ALREADY-CLAMPED tree.
 *
 * An unmeasured shell returns the widths untouched: clamping against a zero
 * frame would rewrite the owner's stored layout to the floors on the one render
 * where nothing is known yet.
 */
export function clampSplitWidths(
  widths: SplitWidths,
  layout: SplitLayout,
): SplitWidths {
  if (!isSplitMeasured(layout)) return widths;
  const tree = clampSplitWidth(widths.tree, splitBounds("tree", widths, layout));
  const preview = clampSplitWidth(
    widths.preview,
    splitBounds("preview", { tree, preview: widths.preview }, layout),
  );
  return { tree, preview };
}

/**
 * Pointer x → the width of the column that divider governs.
 *
 * The tree grows rightwards from the rail's right edge; the Preview grows
 * leftwards from the shell's right edge. Both are measured from the shell's own
 * rect rather than from the viewport, so a shell that does not start at x=0 (a
 * future inspector panel, a print preview) needs no second rule.
 *
 * Returns the raw derived width — the caller clamps it, so the pointer maths and
 * the bounds stay one decision each.
 *
 * `grabOffset` is where inside the 24px strip the press landed (DW-44), and it
 * is SUBTRACTED in both directions because it was measured in the same width
 * space this returns. It defaults to `0`, which is Story 1.6's behaviour exactly:
 * the boundary jumps to the pointer. With a strip that is offset entirely to one
 * side of the boundary that jump is up to 24px on the first `pointermove`, so the
 * shell measures the grab once on `pointerdown` and hands it back here.
 */
export function splitWidthFromPointer(
  id: SplitId,
  clientX: number,
  shellLeft: number,
  shellWidth: number,
  grabOffset = 0,
): number {
  const raw =
    id === "tree"
      ? clientX - shellLeft - SPLIT_RAIL_WIDTH
      : shellLeft + shellWidth - clientX;
  return Math.round(raw - grabOffset);
}

/**
 * How far the press was from the boundary it grabbed, in width space.
 *
 * `splitWidthFromPointer(…) - current` works unchanged for BOTH ids because the
 * raw function already flips direction for the Preview: on either divider a
 * positive result means "this press asks for a wider column than the one on
 * screen", and feeding it straight back in cancels out to `current`.
 *
 * Clamped to `±SPLIT_HIT_WIDTH` through the same `clampSplitWidth` every other
 * bound goes through, rather than a second `Math.min`/`Math.max`: a press the
 * browser reports from outside the strip — a synthetic event, a capture that
 * arrived after the pointer had already moved — must not be able to offset the
 * rest of the drag by an arbitrary amount.
 */
export function splitGrabOffset(
  id: SplitId,
  clientX: number,
  shellLeft: number,
  shellWidth: number,
  current: number,
): number {
  const raw = splitWidthFromPointer(id, clientX, shellLeft, shellWidth) - current;
  return clampSplitWidth(raw, { min: -SPLIT_HIT_WIDTH, max: SPLIT_HIT_WIDTH });
}

/**
 * Key → the width that key asks for, or `null` when this handle does not claim
 * the key (which is what tells the control not to call `preventDefault`, so Tab,
 * Escape and every shortcut still work from a focused divider).
 *
 * The divider follows the arrow: on the TREE handle `ArrowRight` widens the
 * tree, and on the PREVIEW handle `ArrowRight` NARROWS the Preview — in both
 * cases the boundary itself moves the way the arrow points, which is the only
 * mapping a sighted keyboard user can predict. Home and End take the column to
 * the two numbers the same handle reports as `aria-valuemin` / `aria-valuemax`.
 *
 * PageDown/PageUp are the same rule at four times the step (DW-45): PageDown
 * moves the boundary RIGHT and PageUp moves it LEFT at both dividers, so on the
 * Preview handle PageDown narrows the Preview exactly as `ArrowRight` does. They
 * clamp to the same bounds the arrows do, so a coarse press can never leave the
 * range the separator announces.
 */
export function nextSplitWidthFromKey(
  id: SplitId,
  key: string,
  current: number,
  bounds: SplitBounds,
): number | null {
  if (key === "Home") return bounds.min;
  if (key === "End") return bounds.max;
  const grow = id === "tree" ? "ArrowRight" : "ArrowLeft";
  const shrink = id === "tree" ? "ArrowLeft" : "ArrowRight";
  if (key === grow) return clampSplitWidth(current + SPLIT_KEY_STEP, bounds);
  if (key === shrink) return clampSplitWidth(current - SPLIT_KEY_STEP, bounds);
  const pageGrow = id === "tree" ? "PageDown" : "PageUp";
  const pageShrink = id === "tree" ? "PageUp" : "PageDown";
  if (key === pageGrow) return clampSplitWidth(current + SPLIT_KEY_PAGE_STEP, bounds);
  if (key === pageShrink) return clampSplitWidth(current - SPLIT_KEY_PAGE_STEP, bounds);
  return null;
}

/**
 * The inline custom properties the shell writes onto `.wb-shell`, or `undefined`
 * while the first paint is still the server's.
 *
 * Widths, like mode and collapse, are read in an effect — so a stored 460px tree
 * paints at 280px for one frame. Writing them into the SSR markup instead would
 * make a browser-local view preference part of every server render for the sake
 * of that frame; `data-mounted="false"` already suppresses transitions during
 * exactly this window, so the correction is a jump rather than an animation
 * played back at the owner.
 *
 * Takes the ALREADY-CLAMPED widths: re-clamping here would be a second
 * derivation of the layout, and the clamp is not idempotent when a stored width
 * sits below its own floor.
 */
export function splitStyleVars(
  applied: SplitWidths,
  mounted: boolean,
  layout: SplitLayout,
): SplitStyleVars | undefined {
  if (!mounted || !isSplitMeasured(layout)) return undefined;
  return {
    "--wb-tree": `${applied.tree}px`,
    "--wb-preview": `${applied.preview}px`,
  };
}

/**
 * Is this separator on screen at all?
 *
 * A handle in the SSR markup would be a hydration mismatch, and one rendered
 * before the shell is measured would announce the floors as its range. Beyond
 * that: the tree divider needs a tree (not collapsed) and the Preview divider
 * needs a docked Preview. The BREAKPOINT is deliberately not here — handles are
 * hidden below 1200px by a media query, because the 900–1199px block pins both
 * side columns to their minimums and a width comparison in JavaScript would be a
 * second, drifting copy of that decision.
 */
export function showSplitHandle(
  id: SplitId,
  mounted: boolean,
  layout: SplitLayout,
): boolean {
  if (!mounted || !isSplitMeasured(layout)) return false;
  return id === "tree" ? !layout.collapsed : layout.previewOpen;
}

/**
 * Should the tree's scroll memory run against the panel that is on screen?
 *
 * The collapse FLAG is not the answer, only the reason to ask again. Below 900px
 * `globals.css` force-shows a collapsed column, so an owner who collapsed on a
 * desktop and then loads narrow gets a fully visible, scrollable tree — and a
 * guard that trusted the flag would neither restore its offset nor remember it.
 * An expanded column is showing by construction; a collapsed one is asked
 * directly, and `rendered` is what the element answered.
 *
 * The DECISION lives here rather than in the component for the same reason every
 * bound does: inverted in a `.tsx` it would kill the whole feature — no offset
 * ever restored, none ever written — with every source scan still green.
 */
export function treeScrollActive(collapsed: boolean, rendered: boolean): boolean {
  return !collapsed || rendered;
}

/**
 * The identity of the layout a restored selection belongs to.
 *
 * The shell's reset effect clears the selection whenever `mode`, `currentWikiId`
 * or `treeTab` changes, and its deps are pinned verbatim by
 * `workbench-left-column.test.ts`. Restoring all three in the mount effect makes
 * that effect fire again with the restored values and clear the pick that was
 * just restored — invisibly, with the suite still green. So the mount effect
 * records the signature of the state it restored, and the reset effect returns
 * without clearing until it sees that signature arrive.
 */
export function layoutSignature(
  mode: WorkbenchModeId,
  wikiId: string | null,
  treeTab: TreeTabId,
): string {
  // `JSON.stringify` rather than a delimiter: a Wiki id is a free string, so
  // joining on one would let mode `a` with id `b c` alias mode `a`, id `b` and
  // tab `c`. This function's entire job is one identity comparison, so an
  // encoding that can make two different layouts equal is the one thing it must
  // not have. The two closed unions are taken as themselves rather than as
  // `string`: a typo in a caller is then a compile error, instead of a signature
  // that never matches and a restore that is silently discarded.
  return JSON.stringify([mode, wikiId, treeTab]);
}
