/**
 * Story 1.6 — drag-resize and durable layout.
 *
 * Two halves, for two reasons.
 *
 * EXECUTED: every geometry decision is a pure function in `workbench-split`, and
 * every storage accessor is a guarded read in `workbench-state`, so both are run
 * here rather than grepped for. That is the whole point of keeping them out of
 * the component — `vitest.config.ts` is `environment: "node"` with
 * `include: ["src/**\/__tests__/**\/*.test.ts"]`, so a bound typed into an event
 * handler could only ever be matched as source text, and a rewrite that kept the
 * comment and inverted the comparison would ship with the suite green.
 *
 * SCANNED: the wiring the node suite cannot execute — that the shell measures
 * itself, applies the clamp, hands each handle the SAME bounds it enforces, and
 * that the stylesheet positions the divider from the same custom properties the
 * grid tracks read. Every previous story in this epic lost a regression exactly
 * there.
 *
 * The one number that must not drift is asserted against `globals.css` itself:
 * the TypeScript constants and the `--wb-*` token declarations are two copies of
 * six numbers, so the stylesheet is parsed and each pair compared.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  DEFAULT_SPLIT_WIDTHS,
  SPLIT_DEFAULT_PREVIEW,
  SPLIT_DEFAULT_TREE,
  SPLIT_KEY_STEP,
  SPLIT_MIN_CANVAS,
  SPLIT_MIN_PREVIEW,
  SPLIT_MIN_TREE,
  SPLIT_PREVIEW_LABEL,
  SPLIT_RAIL_WIDTH,
  SPLIT_TREE_LABEL,
  clampSplitWidth,
  clampSplitWidths,
  isPrimarySplitPress,
  isSplitMeasured,
  isUnmodifiedSplitKey,
  layoutSignature,
  nextSplitWidthFromKey,
  showSplitHandle,
  splitBounds,
  splitLabel,
  splitStyleVars,
  splitWidthFromPointer,
  treeScrollActive,
  withSplitWidth,
  type SplitLayout,
  type SplitWidths,
} from "../workbench-split";
import {
  WORKBENCH_SELECTION_KEY,
  WORKBENCH_SPLIT_KEY,
  WORKBENCH_TREE_SCROLL_KEY,
  readStoredSelection,
  readStoredSplitWidths,
  readStoredTreeScroll,
  writeStoredSelection,
  writeStoredSplitWidths,
  writeStoredTreeScroll,
} from "../workbench-state";
import {
  buildFileTree,
  restorableSelection,
  selectionExists,
  type KnowledgeGroup,
} from "../workbench-tree";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function component(file: string): Promise<string> {
  return readFile(path.join(WORKBENCH, file), "utf8");
}

function globals(): Promise<string> {
  return readFile(path.join(SRC, "app/globals.css"), "utf8");
}

/** The single `.wb-shell { … }` declaration block — where every token lives. */
function tokenBlock(css: string): string {
  const start = css.indexOf(".wb-shell {");
  expect(start).toBeGreaterThan(-1);
  return css.slice(start, start + css.slice(start).indexOf("\n}"));
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const WIDE: SplitLayout = { shellWidth: 1400, previewOpen: true, collapsed: false };

function layout(overrides: Partial<SplitLayout> = {}): SplitLayout {
  return { ...WIDE, ...overrides };
}

function widths(tree: number, preview: number): SplitWidths {
  return { tree, preview };
}

const DEFAULTS = widths(SPLIT_DEFAULT_TREE, SPLIT_DEFAULT_PREVIEW);

// `workbench-state.test.ts`'s fixture, plus the `removeItem` the selection
// accessor needs to CLEAR a key rather than store `null` under a live shape.
type Store = Record<string, string>;

const realWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function stubWindow(localStorage: unknown): void {
  Object.defineProperty(globalThis, "window", {
    value: { localStorage },
    configurable: true,
    writable: true,
  });
}

function memoryStorage(initial: Store = {}) {
  const store: Store = { ...initial };
  return {
    store,
    getItem: (key: string) => (key in store ? store[key] : null),
    setItem: (key: string, value: string) => {
      store[key] = value;
    },
    removeItem: (key: string) => {
      delete store[key];
    },
  };
}

function throwingStorage() {
  return {
    getItem: () => {
      throw new Error("SecurityError: localStorage is disabled");
    },
    setItem: () => {
      throw new Error("QuotaExceededError");
    },
    removeItem: () => {
      throw new Error("SecurityError: localStorage is disabled");
    },
  };
}

function removeWindow(): void {
  Object.defineProperty(globalThis, "window", {
    value: undefined,
    configurable: true,
    writable: true,
  });
}

afterEach(() => {
  if (realWindow) Object.defineProperty(globalThis, "window", realWindow);
  else removeWindow();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The two copies of six numbers
// ---------------------------------------------------------------------------

describe("the geometry constants and the CSS tokens are one set of numbers", () => {
  it("restates every declared --wb-* width exactly", async () => {
    const tokens = tokenBlock(await globals());
    const pairs: Array<[string, number]> = [
      ["--wb-rail", SPLIT_RAIL_WIDTH],
      ["--wb-tree", SPLIT_DEFAULT_TREE],
      ["--wb-preview", SPLIT_DEFAULT_PREVIEW],
      ["--wb-split-min-tree", SPLIT_MIN_TREE],
      ["--wb-split-min-preview", SPLIT_MIN_PREVIEW],
      ["--wb-split-min-chat", SPLIT_MIN_CANVAS],
      // The keyboard step is the same kind of claim: its docblock says it
      // restates the shell's largest spacing step, which is only true while
      // nothing moves either copy.
      ["--wb-space-4", SPLIT_KEY_STEP],
    ];
    for (const [token, constant] of pairs) {
      // Parsed, never retyped: a literal here would be a THIRD copy, and the
      // test would go green on the day the other two disagreed with it.
      const match = new RegExp(`^\\s*${token}:\\s*(\\d+)px;`, "m").exec(tokens);
      expect({ token, declared: match?.[1] }).toEqual({
        token,
        declared: String(constant),
      });
    }
  });

  it("declares --wb-split-min-chat so it finally has a reader", async () => {
    // It has been in the token block since Story 1.3 with nothing reading it.
    // The canvas floor is the whole of what this story enforces, so the constant
    // above is that reader — and it must be the same number.
    expect(SPLIT_MIN_CANVAS).toBe(320);
    expect(tokenBlock(await globals())).toContain("--wb-split-min-chat: 320px;");
  });
});

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

describe("splitBounds", () => {
  it("gives the tree the frame minus rail, canvas floor and Preview", () => {
    expect(splitBounds("tree", widths(280, 360), WIDE)).toEqual({
      min: 200,
      max: 1400 - 48 - 320 - 360,
    });
  });

  it("gives the tree the Preview's room back when the Preview is closed", () => {
    expect(
      splitBounds("tree", widths(280, 360), layout({ previewOpen: false })),
    ).toEqual({ min: 200, max: 1400 - 48 - 320 });
  });

  it("measures the Preview against the tree that is actually rendered", () => {
    expect(splitBounds("preview", widths(280, 360), WIDE)).toEqual({
      min: 200,
      max: 1400 - 48 - 320 - 280,
    });
  });

  it("gives the Preview the whole tree track when the column is collapsed", () => {
    expect(
      splitBounds("preview", widths(280, 360), layout({ collapsed: true })),
    ).toEqual({ min: 200, max: 1400 - 48 - 320 });
  });

  it("never reports a maximum below its own floor, however small the frame", () => {
    // 700px cannot hold 48 + 200 + 320 + 200 at all. The answer is a degenerate
    // range, never a negative track — the grid would resolve that by overflowing
    // inside `overflow: hidden`, i.e. by clipping the Preview out of existence.
    const cramped = layout({ shellWidth: 700 });
    for (const id of ["tree", "preview"] as const) {
      const bounds = splitBounds(id, widths(280, 360), cramped);
      expect(bounds.max).toBe(bounds.min);
      expect(bounds.max).toBeGreaterThan(0);
    }
  });

  it("keeps the canvas floor in every mode, because a mode switch moves nothing", () => {
    // The bound is the same object whatever is on the canvas: Chat is one rail
    // click away at any moment, and a layout Chat could not live in would have to
    // snap under the owner the moment they clicked it.
    const bounds = splitBounds("tree", widths(280, 360), WIDE);
    expect(1400 - 48 - bounds.max - 360).toBe(SPLIT_MIN_CANVAS);
  });
});

// ---------------------------------------------------------------------------
// The clamp
// ---------------------------------------------------------------------------

describe("clampSplitWidths", () => {
  it("leaves a layout that fits exactly as the owner left it", () => {
    expect(clampSplitWidths(DEFAULTS, WIDE)).toEqual(DEFAULTS);
  });

  it("clamps the tree first, then the Preview against the clamped tree", () => {
    // Both stored widths outgrew the frame (a wider monitor last session). The
    // ORDER is the decision: tree 900 → 200 (the Preview still asks for 900), and
    // only then is the Preview measured against a 200px tree.
    expect(clampSplitWidths(widths(900, 900), WIDE)).toEqual({
      tree: 200,
      preview: 1400 - 48 - 320 - 200,
    });
  });

  it("raises a width that fell below its floor", () => {
    expect(clampSplitWidths(widths(40, 40), WIDE)).toEqual({
      tree: SPLIT_MIN_TREE,
      preview: SPLIT_MIN_PREVIEW,
    });
  });

  it("returns the widths untouched while the shell is unmeasured", () => {
    // Pre-mount there is no frame, and clamping against zero would rewrite the
    // owner's stored layout to the floors on the one render where nothing is
    // known. `isSplitMeasured` is the same guard the style vars use.
    const stored = widths(460, 520);
    const unmeasured = layout({ shellWidth: 0 });
    expect(isSplitMeasured(unmeasured)).toBe(false);
    expect(clampSplitWidths(stored, unmeasured)).toEqual(stored);
    expect(clampSplitWidths(stored, layout({ shellWidth: Number.NaN }))).toEqual(stored);
  });

  it("never lets the two side columns eat the canvas floor", () => {
    for (const shellWidth of [700, 900, 1200, 1400, 2400]) {
      for (const preferred of [widths(9999, 9999), widths(1, 1), widths(600, 600)]) {
        const applied = clampSplitWidths(preferred, layout({ shellWidth }));
        const canvas = shellWidth - SPLIT_RAIL_WIDTH - applied.tree - applied.preview;
        // At widths too small for every floor at once the columns hold their
        // own minimums and the canvas is what gives — which is the only ordering
        // that keeps both side columns operable.
        if (shellWidth >= SPLIT_RAIL_WIDTH + SPLIT_MIN_TREE + SPLIT_MIN_CANVAS + SPLIT_MIN_PREVIEW) {
          expect(canvas).toBeGreaterThanOrEqual(SPLIT_MIN_CANVAS);
        }
        expect(applied.tree).toBeGreaterThanOrEqual(SPLIT_MIN_TREE);
        expect(applied.preview).toBeGreaterThanOrEqual(SPLIT_MIN_PREVIEW);
      }
    }
  });
});

describe("clampSplitWidth / withSplitWidth", () => {
  it("fits one value into one range, in whole pixels", () => {
    const bounds = { min: 200, max: 672 };
    expect(clampSplitWidth(120, bounds)).toBe(200);
    expect(clampSplitWidth(900, bounds)).toBe(672);
    expect(clampSplitWidth(340.6, bounds)).toBe(341);
  });

  it("replaces one column's width and leaves the other's preference alone", () => {
    expect(withSplitWidth(widths(280, 360), "tree", 420)).toEqual(widths(420, 360));
    expect(withSplitWidth(widths(280, 360), "preview", 420)).toEqual(widths(280, 420));
  });
});

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------

describe("splitWidthFromPointer", () => {
  it("measures the tree rightwards from the rail's right edge", () => {
    expect(splitWidthFromPointer("tree", 700, 0, 1400)).toBe(700 - 0 - 48);
  });

  it("measures the Preview leftwards from the shell's right edge", () => {
    expect(splitWidthFromPointer("preview", 1100, 0, 1400)).toBe(1400 - 1100);
  });

  it("is measured from the shell's own rect, not from the viewport", () => {
    // A shell that does not start at x=0 needs no second rule.
    expect(splitWidthFromPointer("tree", 900, 200, 1400)).toBe(900 - 200 - 48);
    expect(splitWidthFromPointer("preview", 900, 200, 1400)).toBe(200 + 1400 - 900);
  });

  it("answers in whole pixels, and clamps only where the caller asks", () => {
    // A raw pointer width may be outside the range — the bounds are one decision
    // and the pointer maths is another, so this one does not fold them together.
    expect(splitWidthFromPointer("tree", 60.4, 0, 1400)).toBe(12);
    const bounds = splitBounds("tree", DEFAULTS, WIDE);
    expect(clampSplitWidth(splitWidthFromPointer("tree", 60.4, 0, 1400), bounds)).toBe(
      bounds.min,
    );
  });
});

// ---------------------------------------------------------------------------
// Keyboard
// ---------------------------------------------------------------------------

describe("nextSplitWidthFromKey", () => {
  const bounds = { min: 200, max: 672 };

  it("moves the tree divider the way the arrow points", () => {
    expect(nextSplitWidthFromKey("tree", "ArrowRight", 300, bounds)).toBe(
      300 + SPLIT_KEY_STEP,
    );
    expect(nextSplitWidthFromKey("tree", "ArrowLeft", 300, bounds)).toBe(
      300 - SPLIT_KEY_STEP,
    );
  });

  it("moves the Preview divider the way the arrow points, which INVERTS the width", () => {
    // The boundary, not the column, follows the key: ArrowLeft drags the divider
    // left, which makes the Preview wider. Getting this backwards is the one
    // mistake a sighted keyboard user notices immediately and a test would not.
    expect(nextSplitWidthFromKey("preview", "ArrowLeft", 300, bounds)).toBe(
      300 + SPLIT_KEY_STEP,
    );
    expect(nextSplitWidthFromKey("preview", "ArrowRight", 300, bounds)).toBe(
      300 - SPLIT_KEY_STEP,
    );
  });

  it("takes the column to the ends of the range it announces", () => {
    for (const id of ["tree", "preview"] as const) {
      expect(nextSplitWidthFromKey(id, "Home", 400, bounds)).toBe(bounds.min);
      expect(nextSplitWidthFromKey(id, "End", 400, bounds)).toBe(bounds.max);
    }
  });

  it("clamps a step that would leave the range", () => {
    expect(nextSplitWidthFromKey("tree", "ArrowLeft", bounds.min, bounds)).toBe(
      bounds.min,
    );
    expect(nextSplitWidthFromKey("tree", "ArrowRight", bounds.max, bounds)).toBe(
      bounds.max,
    );
  });

  it("claims nothing else, so Tab and Escape still work from a focused divider", () => {
    for (const key of ["Tab", "Escape", "Enter", " ", "ArrowUp", "ArrowDown", "a"]) {
      expect(nextSplitWidthFromKey("tree", key, 300, bounds)).toBeNull();
      expect(nextSplitWidthFromKey("preview", key, 300, bounds)).toBeNull();
    }
  });

  it("moves to a width the same bounds would allow a drag to reach", () => {
    // One definition of the range: what a key press produces is inside what
    // `aria-valuemin`/`aria-valuemax` report, because both come from here.
    const live = splitBounds("tree", DEFAULTS, WIDE);
    for (const key of ["ArrowLeft", "ArrowRight", "Home", "End"]) {
      const next = nextSplitWidthFromKey("tree", key, live.max, live);
      expect(next).not.toBeNull();
      expect(next as number).toBeGreaterThanOrEqual(live.min);
      expect(next as number).toBeLessThanOrEqual(live.max);
    }
  });
});

// ---------------------------------------------------------------------------
// What the shell renders
// ---------------------------------------------------------------------------

describe("splitStyleVars", () => {
  it("writes both custom properties in pixels once mounted and measured", () => {
    expect(splitStyleVars(widths(420, 300), true, WIDE)).toEqual({
      "--wb-tree": "420px",
      "--wb-preview": "300px",
    });
  });

  it("writes nothing during the server render or before measurement", () => {
    // A stored width in the SSR markup would make a browser-local view
    // preference part of every server render; a handle or a var written before
    // the shell has a width would describe a layout nobody has measured.
    expect(splitStyleVars(widths(420, 300), false, WIDE)).toBeUndefined();
    expect(splitStyleVars(widths(420, 300), true, layout({ shellWidth: 0 }))).toBeUndefined();
  });
});

describe("showSplitHandle", () => {
  it("shows the tree divider only when there is a tree", () => {
    expect(showSplitHandle("tree", true, WIDE)).toBe(true);
    expect(showSplitHandle("tree", true, layout({ collapsed: true }))).toBe(false);
  });

  it("shows the Preview divider only when the Preview is docked", () => {
    expect(showSplitHandle("preview", true, WIDE)).toBe(true);
    expect(showSplitHandle("preview", true, layout({ previewOpen: false }))).toBe(false);
  });

  it("shows neither before mount or before measurement", () => {
    for (const id of ["tree", "preview"] as const) {
      expect(showSplitHandle(id, false, WIDE)).toBe(false);
      expect(showSplitHandle(id, true, layout({ shellWidth: 0 }))).toBe(false);
    }
  });
});

describe("treeScrollActive", () => {
  it("runs for an expanded column without asking the element", () => {
    // Expanded is showing by construction, so the answer holds whichever way
    // `getClientRects()` came back.
    expect(treeScrollActive(false, true)).toBe(true);
    expect(treeScrollActive(false, false)).toBe(true);
  });

  it("runs for a collapsed column only while it is still rendered", () => {
    // `@media (max-width: 899px)` force-shows a collapsed column: the tree is
    // fully visible and scrollable there, and skipping it on the flag alone
    // would neither restore its offset nor remember it for every narrow load.
    expect(treeScrollActive(true, true)).toBe(true);
    // …and a genuinely hidden one reports `scrollTop === 0` by the browser's
    // own rules, so persisting there would overwrite the offset the owner is
    // about to come back to.
    expect(treeScrollActive(true, false)).toBe(false);
  });
});

describe("the accessible names", () => {
  it("are the Copy table's strings, character-exact", () => {
    expect(SPLIT_TREE_LABEL).toBe("Resize the left column");
    expect(SPLIT_PREVIEW_LABEL).toBe("Resize the Preview column");
    expect(splitLabel("tree")).toBe(SPLIT_TREE_LABEL);
    expect(splitLabel("preview")).toBe(SPLIT_PREVIEW_LABEL);
  });
});

describe("layoutSignature", () => {
  it("distinguishes every layout the reset effect watches", () => {
    expect(layoutSignature("wiki", "w1", "knowledge")).toBe(
      layoutSignature("wiki", "w1", "knowledge"),
    );
    expect(layoutSignature("wiki", "w1", "knowledge")).not.toBe(
      layoutSignature("chat", "w1", "knowledge"),
    );
    expect(layoutSignature("wiki", "w1", "knowledge")).not.toBe(
      layoutSignature("wiki", "w2", "knowledge"),
    );
    expect(layoutSignature("wiki", "w1", "knowledge")).not.toBe(
      layoutSignature("wiki", "w1", "files"),
    );
    // A registry with no current Wiki is still one layout, not a crash — and it
    // is not the same layout as one whose Wiki is literally named "null".
    expect(layoutSignature("wiki", null, "knowledge")).toBe(
      layoutSignature("wiki", null, "knowledge"),
    );
    expect(layoutSignature("wiki", null, "knowledge")).not.toBe(
      layoutSignature("wiki", "null", "knowledge"),
    );
  });

  it("cannot alias two layouts through a Wiki id, however it is spelled", () => {
    // A Wiki id is a free string, and the mode and the tab are not — which is
    // what the two closed unions buy: a signature can only be confused through
    // the middle term. `${wikiId ?? ""}` made "no current Wiki" and a Wiki whose
    // id is the empty string the SAME layout, which would let the guard keep a
    // row it should have cleared. Every id below stays distinct.
    const base = layoutSignature("wiki", "w1", "knowledge");
    expect(layoutSignature("wiki", null, "knowledge")).not.toBe(
      layoutSignature("wiki", "", "knowledge"),
    );
    for (const id of ['w"1', "w\\1", "w,1", "w]1", "w1 ", " w1", "w1 knowledge"]) {
      expect({ id, same: layoutSignature("wiki", id, "knowledge") === base }).toEqual({
        id,
        same: false,
      });
    }
  });
});

describe("the pointer and key gates", () => {
  it("starts a drag only for the primary button of the primary pointer", () => {
    // A right- or middle-click would otherwise take capture and arm
    // `data-resizing`, after which the divider follows a button-less pointer.
    expect(isPrimarySplitPress({ button: 0, isPrimary: true })).toBe(true);
    expect(isPrimarySplitPress({ button: 1, isPrimary: true })).toBe(false);
    expect(isPrimarySplitPress({ button: 2, isPrimary: true })).toBe(false);
    expect(isPrimarySplitPress({ button: -1, isPrimary: true })).toBe(false);
    // Second and later contacts on a multi-touch surface do not drive the drag.
    expect(isPrimarySplitPress({ button: 0, isPrimary: false })).toBe(false);
  });

  it("claims only an unmodified key press, Shift included", () => {
    const none = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false };
    expect(isUnmodifiedSplitKey(none)).toBe(true);
    // Alt+Left is browser-back, Ctrl/Alt+arrow is word-jump, Meta+Left is back on
    // macOS, Shift+arrow is selection-extension. This control implements none of
    // them, so claiming one — and preventing its default — only breaks it.
    for (const key of ["altKey", "ctrlKey", "metaKey", "shiftKey"] as const) {
      expect({ key, claimed: isUnmodifiedSplitKey({ ...none, [key]: true }) }).toEqual({
        key,
        claimed: false,
      });
    }
  });
});

// ---------------------------------------------------------------------------
// Does the restored row still exist?
// ---------------------------------------------------------------------------

const KNOWLEDGE: KnowledgeGroup[] = [
  {
    id: "",
    label: "Pages",
    count: 1,
    pages: [{ slug: "alpha", title: "Alpha" }],
  },
];

const FILES = buildFileTree(["wiki/", "wiki/a.md", "raw/", "raw/deep/"]);

describe("restorableSelection", () => {
  const stored = { wikiId: "w1", selection: { kind: "page", slug: "alpha" } } as const;

  it("restores a row that belongs to the Wiki the registry still calls current", () => {
    expect(restorableSelection(stored, "w1", KNOWLEDGE, FILES)).toEqual(stored.selection);
  });

  it("restores nothing for another Wiki's row", () => {
    // The row is in THIS tree — `selectionExists` alone would restore it. What
    // makes it wrong is whose Wiki it was picked in, and the failure is silent:
    // the Preview docks and loads a page from a Wiki the owner switched away
    // from. Inline in the mount effect this was reachable by grep only.
    expect(restorableSelection(stored, "w2", KNOWLEDGE, FILES)).toBeNull();
  });

  it("restores nothing when there is no current Wiki to scope it to", () => {
    expect(restorableSelection(stored, null, KNOWLEDGE, FILES)).toBeNull();
  });

  it("restores nothing when nothing was stored", () => {
    expect(restorableSelection(null, "w1", KNOWLEDGE, FILES)).toBeNull();
  });

  it("restores nothing for a row the trees no longer contain", () => {
    const gone = { wikiId: "w1", selection: { kind: "page", slug: "ghost" } } as const;
    expect(restorableSelection(gone, "w1", KNOWLEDGE, FILES)).toBeNull();
  });

  it("restores a file row the walk still lists", () => {
    const file = { wikiId: "w1", selection: { kind: "file", path: "wiki/a.md" } } as const;
    expect(restorableSelection(file, "w1", KNOWLEDGE, FILES)).toEqual(file.selection);
  });
});

describe("selectionExists", () => {
  it("restores a page the Knowledge tree still contains", () => {
    expect(selectionExists({ kind: "page", slug: "alpha" }, KNOWLEDGE, FILES)).toBe(true);
  });

  it("drops a page the tree no longer contains", () => {
    expect(selectionExists({ kind: "page", slug: "ghost" }, KNOWLEDGE, FILES)).toBe(false);
  });

  it("restores a file row the walk still lists", () => {
    expect(selectionExists({ kind: "file", path: "wiki/a.md" }, KNOWLEDGE, FILES)).toBe(
      true,
    );
  });

  it("drops a file row the walk no longer lists", () => {
    expect(selectionExists({ kind: "file", path: "wiki/gone.md" }, KNOWLEDGE, FILES)).toBe(
      false,
    );
  });

  it("drops a directory, which the tree never renders as a row", () => {
    // A disclosure has no bytes behind it, so restoring one would dock a Preview
    // with nothing in it and mark `aria-current` on a control that is not a row.
    expect(selectionExists({ kind: "file", path: "raw" }, KNOWLEDGE, FILES)).toBe(false);
    expect(selectionExists({ kind: "file", path: "raw/deep" }, KNOWLEDGE, FILES)).toBe(
      false,
    );
  });

  it("drops nothing at all", () => {
    expect(selectionExists(null, KNOWLEDGE, FILES)).toBe(false);
  });

  it("does not answer for the other tab's tree", () => {
    // A page is checked against `knowledge` and a file against `files`; crossing
    // them would restore a row the showing tab cannot render.
    expect(selectionExists({ kind: "page", slug: "wiki/a.md" }, KNOWLEDGE, FILES)).toBe(
      false,
    );
    expect(selectionExists({ kind: "file", path: "alpha" }, KNOWLEDGE, FILES)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

describe("readStoredSplitWidths", () => {
  it("defaults when nothing is stored", () => {
    stubWindow(memoryStorage());
    expect(readStoredSplitWidths()).toEqual(DEFAULT_SPLIT_WIDTHS);
  });

  it("round-trips a dragged layout", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredSplitWidths(widths(320, 420));
    expect(storage.store[WORKBENCH_SPLIT_KEY]).toBe('{"tree":320,"preview":420}');
    expect(readStoredSplitWidths()).toEqual(widths(320, 420));
  });

  it("falls each side back to its own default, independently", () => {
    // A partial object (an older build, a hand edit) must not drag the column
    // that IS stored back to its default too.
    for (const [raw, expected] of [
      ['{"tree":320}', widths(320, SPLIT_DEFAULT_PREVIEW)],
      ['{"preview":420}', widths(SPLIT_DEFAULT_TREE, 420)],
      ['{"tree":"320","preview":420}', widths(SPLIT_DEFAULT_TREE, 420)],
      ['{"tree":-40,"preview":420}', widths(SPLIT_DEFAULT_TREE, 420)],
      ['{"tree":0,"preview":420}', widths(SPLIT_DEFAULT_TREE, 420)],
      ['{"tree":null,"preview":420}', widths(SPLIT_DEFAULT_TREE, 420)],
    ] as const) {
      stubWindow(memoryStorage({ [WORKBENCH_SPLIT_KEY]: raw }));
      expect({ raw, widths: readStoredSplitWidths() }).toEqual({ raw, widths: expected });
    }
  });

  it("degrades to both defaults for a value that is not an object at all", () => {
    for (const raw of ["", "not json", "null", "[320,420]", '"320"', "42"]) {
      stubWindow(memoryStorage({ [WORKBENCH_SPLIT_KEY]: raw }));
      expect(readStoredSplitWidths()).toEqual(DEFAULT_SPLIT_WIDTHS);
    }
  });

  it("keeps a width larger than the frame — the clamp is the reader, not this", () => {
    // Rejecting it here would throw away a layout that becomes valid again the
    // moment the window is widened.
    stubWindow(memoryStorage({ [WORKBENCH_SPLIT_KEY]: '{"tree":900,"preview":900}' }));
    expect(readStoredSplitWidths()).toEqual(widths(900, 900));
    expect(clampSplitWidths(readStoredSplitWidths(), WIDE)).toEqual({
      tree: 200,
      preview: 832,
    });
  });

  it("degrades silently on a throwing store and on a server render", () => {
    stubWindow(throwingStorage());
    expect(readStoredSplitWidths()).toEqual(DEFAULT_SPLIT_WIDTHS);
    expect(() => writeStoredSplitWidths(widths(320, 420))).not.toThrow();
    removeWindow();
    expect(readStoredSplitWidths()).toEqual(DEFAULT_SPLIT_WIDTHS);
    expect(() => writeStoredSplitWidths(widths(320, 420))).not.toThrow();
  });
});

describe("readStoredSelection", () => {
  it("round-trips a page pick with the Wiki it was made in", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredSelection("w1", { kind: "page", slug: "alpha" });
    expect(readStoredSelection()).toEqual({
      wikiId: "w1",
      selection: { kind: "page", slug: "alpha" },
    });
  });

  it("round-trips a file pick", () => {
    stubWindow(memoryStorage());
    writeStoredSelection("w1", { kind: "file", path: "wiki/a.md" });
    expect(readStoredSelection()).toEqual({
      wikiId: "w1",
      selection: { kind: "file", path: "wiki/a.md" },
    });
  });

  it("carries the Wiki id so a restore can be scoped to the current one", () => {
    // The Wiki SELECTION is durable server-side through the registry's
    // `currentId`; what the stored row owes FR-8 is that it names which Wiki it
    // belonged to, so another Wiki's row is not restored over it.
    stubWindow(memoryStorage());
    writeStoredSelection("w1", { kind: "page", slug: "alpha" });
    const stored = readStoredSelection();
    expect(stored?.wikiId).toBe("w1");
    expect(stored?.wikiId === "w2").toBe(false);
  });

  it("clears the key rather than storing a null under a live shape", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredSelection("w1", { kind: "page", slug: "alpha" });
    writeStoredSelection("w1", null);
    expect(WORKBENCH_SELECTION_KEY in storage.store).toBe(false);
    expect(readStoredSelection()).toBeNull();
  });

  it("clears the key when there is no current Wiki to scope it to", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredSelection("w1", { kind: "page", slug: "alpha" });
    writeStoredSelection(null, { kind: "page", slug: "alpha" });
    expect(WORKBENCH_SELECTION_KEY in storage.store).toBe(false);
  });

  it("refuses every shape it cannot act on", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      '{"selection":{"kind":"page","slug":"alpha"}}',
      '{"wikiId":"","selection":{"kind":"page","slug":"alpha"}}',
      '{"wikiId":1,"selection":{"kind":"page","slug":"alpha"}}',
      '{"wikiId":"w1"}',
      '{"wikiId":"w1","selection":null}',
      '{"wikiId":"w1","selection":{"kind":"page"}}',
      '{"wikiId":"w1","selection":{"kind":"page","slug":""}}',
      '{"wikiId":"w1","selection":{"kind":"page","slug":42}}',
      '{"wikiId":"w1","selection":{"kind":"file"}}',
      '{"wikiId":"w1","selection":{"kind":"directory","path":"raw"}}',
      '{"wikiId":"w1","selection":{"slug":"alpha"}}',
    ]) {
      stubWindow(memoryStorage({ [WORKBENCH_SELECTION_KEY]: raw }));
      expect({ raw, read: readStoredSelection() }).toEqual({ raw, read: null });
    }
  });

  it("degrades silently on a throwing store and on a server render", () => {
    stubWindow(throwingStorage());
    expect(readStoredSelection()).toBeNull();
    expect(() => writeStoredSelection("w1", { kind: "page", slug: "a" })).not.toThrow();
    expect(() => writeStoredSelection("w1", null)).not.toThrow();
    removeWindow();
    expect(readStoredSelection()).toBeNull();
    expect(() => writeStoredSelection("w1", { kind: "page", slug: "a" })).not.toThrow();
    expect(() => writeStoredSelection("w1", null)).not.toThrow();
  });
});

describe("readStoredTreeScroll", () => {
  it("defaults both tabs to the top", () => {
    stubWindow(memoryStorage());
    expect(readStoredTreeScroll()).toEqual({ knowledge: 0, files: 0 });
  });

  it("restores an offset per tab", () => {
    stubWindow(
      memoryStorage({ [WORKBENCH_TREE_SCROLL_KEY]: '{"knowledge":120,"files":0}' }),
    );
    expect(readStoredTreeScroll()).toEqual({ knowledge: 120, files: 0 });
  });

  it("round-trips one tab without forgetting the other", () => {
    const storage = memoryStorage();
    stubWindow(storage);
    writeStoredTreeScroll("knowledge", 120);
    writeStoredTreeScroll("files", 40);
    expect(readStoredTreeScroll()).toEqual({ knowledge: 120, files: 40 });
    // The write rounds: `scrollTop` is fractional on a zoomed or hi-dpi display.
    writeStoredTreeScroll("files", 40.6);
    expect(readStoredTreeScroll().files).toBe(41);
  });

  it("degrades an unusable offset to the top of that tab only", () => {
    for (const [raw, expected] of [
      ['{"knowledge":-10,"files":40}', { knowledge: 0, files: 40 }],
      ['{"knowledge":12.5,"files":40}', { knowledge: 0, files: 40 }],
      ['{"knowledge":"120","files":40}', { knowledge: 0, files: 40 }],
      ['{"knowledge":null,"files":40}', { knowledge: 0, files: 40 }],
      ['{"files":40}', { knowledge: 0, files: 40 }],
      ["not json", { knowledge: 0, files: 0 }],
      ["[120,40]", { knowledge: 0, files: 0 }],
    ] as const) {
      stubWindow(memoryStorage({ [WORKBENCH_TREE_SCROLL_KEY]: raw }));
      expect({ raw, read: readStoredTreeScroll() }).toEqual({ raw, read: expected });
    }
  });

  it("degrades silently on a throwing store and on a server render", () => {
    stubWindow(throwingStorage());
    expect(readStoredTreeScroll()).toEqual({ knowledge: 0, files: 0 });
    expect(() => writeStoredTreeScroll("knowledge", 120)).not.toThrow();
    removeWindow();
    expect(readStoredTreeScroll()).toEqual({ knowledge: 0, files: 0 });
    expect(() => writeStoredTreeScroll("knowledge", 120)).not.toThrow();
  });
});

describe("the new storage keys", () => {
  it("keep the yopedia runtime prefix and its shape (AD-7)", () => {
    for (const key of [
      WORKBENCH_SPLIT_KEY,
      WORKBENCH_SELECTION_KEY,
      WORKBENCH_TREE_SCROLL_KEY,
    ]) {
      expect(key).toMatch(/^yopedia_[a-z_]+$/);
    }
    // Named, so a rename is a visible diff rather than a silently forgotten
    // preference for every returning owner.
    expect(WORKBENCH_SPLIT_KEY).toBe("yopedia_workbench_split");
    expect(WORKBENCH_SELECTION_KEY).toBe("yopedia_workbench_selection");
    expect(WORKBENCH_TREE_SCROLL_KEY).toBe("yopedia_workbench_tree_scroll");
  });
});

// ---------------------------------------------------------------------------
// Wiring the node suite cannot execute
// ---------------------------------------------------------------------------

describe("the shell wires the split without spelling any of it", () => {
  it("measures itself from its own rect, never from the viewport", async () => {
    const source = await component("Workbench.tsx");
    expect(source).toContain("ref={shellRef}");
    expect(source).toContain("shell.getBoundingClientRect().width");
    // …and measures ONCE IMMEDIATELY, not only on the next resize. Without this
    // call `shellWidth` stays 0 for the life of the page: `isSplitMeasured` is
    // false, so no divider ever renders and no stored width is ever applied —
    // the whole feature is dead and every other assertion here stays green.
    expect(source).toMatch(
      /const measure = \(\) => setShellWidth\(shell\.getBoundingClientRect\(\)\.width\);\s*\n\s*measure\(\);/,
    );
    expect(source).toContain('window.addEventListener("resize", measure)');
    expect(source).toContain('window.removeEventListener("resize", measure)');
    // The breakpoint is CSS's. A width comparison here would be a second copy of
    // the 1199px block, free to drift from it — and `ResizeObserver`-driven
    // layout branching is banned outright.
    const code = stripComments(source);
    expect(code).not.toContain("innerWidth");
    expect(code).not.toContain("ResizeObserver");
    expect(code).not.toContain("min-width: 1200");
  });

  it("applies the clamp at render and the vars only once mounted", async () => {
    const source = await component("Workbench.tsx");
    expect(source).toContain("clampSplitWidths(widths, layout)");
    expect(source).toContain("splitStyleVars(applied, mounted, layout)");
    expect(source).toContain('data-resizing={resizing ? "true" : "false"}');
  });

  it("hands each handle the SAME bounds its own clamp enforces", async () => {
    // A drag that stopped somewhere `aria-valuemax` said it should not is a lie
    // to a screen reader, so both must come from one `splitBounds` call.
    const source = await component("Workbench.tsx");
    expect(source).toContain('const treeBounds = splitBounds("tree", applied, layout)');
    expect(source).toContain(
      'const previewBounds = splitBounds("preview", applied, layout)',
    );
    expect(source).toMatch(/min=\{treeBounds\.min\}\s*\n\s*max=\{treeBounds\.max\}/);
    expect(source).toMatch(/min=\{previewBounds\.min\}\s*\n\s*max=\{previewBounds\.max\}/);
    expect(source).toContain("value={applied.tree}");
    expect(source).toContain("value={applied.preview}");
    expect(source).toContain('dragTo("tree", clientX, treeBounds)');
    expect(source).toContain('dragTo("preview", clientX, previewBounds)');
    expect(source).toContain('pressResizeKey("tree", key, applied.tree, treeBounds)');
    expect(source).toContain(
      'pressResizeKey("preview", key, applied.preview, previewBounds)',
    );
  });

  it("mounts each handle through the shared visibility rule", async () => {
    const source = await component("Workbench.tsx");
    expect(source).toContain('showSplitHandle("tree", mounted, layout)');
    expect(source).toContain('showSplitHandle("preview", mounted, layout)');
    expect(source).toContain('label={splitLabel("tree")}');
    expect(source).toContain('label={splitLabel("preview")}');
    // Tab order stays rail → left column → canvas → Preview, with each divider
    // following the column it moves.
    expect(source.indexOf('id="tree"')).toBeLessThan(source.indexOf("<ModeCanvas"));
    expect(source.indexOf("<ModeCanvas")).toBeLessThan(source.indexOf('id="preview"'));
    expect(source.indexOf('id="preview"')).toBeLessThan(source.indexOf("<PreviewColumn"));
  });

  it("routes every drag and key press through the pure functions", async () => {
    const source = await component("Workbench.tsx");
    expect(source).toContain("splitWidthFromPointer(id, clientX, rect.left, rect.width)");
    expect(source).toContain("nextSplitWidthFromKey(id, key, current, bounds)");
    expect(source).toContain("clampSplitWidth(raw, bounds)");
    expect(source).toContain("withSplitWidth(");
    // The press ARMS the flag. Gutted to a no-op, `data-resizing` never turns
    // on, `user-select: none` never applies, and every drag sweeps a text
    // selection across the tree it passes over.
    expect(source).toContain("const startResize = useCallback(() => setResizing(true), [])");
    // The preference is written once per gesture, not once per pointermove:
    // localStorage is synchronous and a drag is ~60 events a second.
    expect(source).toMatch(
      /const endResize = useCallback\(\(\) => \{\s*\n\s*setResizing\(false\);\s*\n\s*writeStoredSplitWidths\(latestRef\.current\.widths\);/,
    );
  });

  it("restores the widths and the row in the one mount effect", async () => {
    const source = await component("Workbench.tsx");
    expect(source).toContain("setWidths(readStoredSplitWidths())");
    // The whole restore decision is one executed function — the Wiki half of it
    // fails invisibly (another Wiki's row, restored over the current one), so it
    // must not be an inline condition only a grep can reach.
    expect(source).toContain(
      "restorableSelection(readStoredSelection(), wikiId, groups, nodes)",
    );
    expect(source).toContain("setSelection(restored)");
    expect(source).not.toContain("stored.wikiId === wikiId");
    // …and persists it, scoped to the Wiki it was made in.
    expect(source).toContain("writeStoredSelection(currentWikiId, selection)");
  });

  it("never writes a failed read down as a deselection", async () => {
    // A failed registry read leaves `currentWikiId` null; a failed index or file
    // read hands the trees down empty. `restorableSelection` correctly declines
    // in all three cases — and without this guard the very next run of the
    // persist effect clears the key, so one bad minute on the server forgets the
    // owner's row permanently. A genuine deselect with healthy reads still
    // clears it, which is why the guard is on the READS and not on `selection`.
    const source = await component("Workbench.tsx");
    expect(source).toMatch(
      /if \(currentWikiId === null \|\| knowledgeUnavailable \|\| filesUnavailable\) return;\s*\n\s*writeStoredSelection\(currentWikiId, selection\);/,
    );
    // Both flags are dependencies, or the guard is evaluated against a stale
    // render and lets through exactly the write it exists to stop.
    expect(source).toContain(
      "}, [mounted, currentWikiId, selection, knowledgeUnavailable, filesUnavailable]);",
    );
  });

  it("keeps the three frozen restores and the frozen reset effect", async () => {
    // These are Story 1.3's and 1.4's, pinned verbatim by two pre-existing test
    // files. This story adds beside them; it does not reword them.
    //
    // One exception, and it is DW-27's: the MODE restore is now URL-first, so
    // what the mount effect hands `setModeState` is the resolved mode rather
    // than the stored one. `workbench-chrome.test.ts` pins the resolution call
    // itself; what matters here is that the same one value reaches both
    // `setModeState` and the layout signature below, or a restored tree
    // selection is cleared by the reset effect.
    const source = await component("Workbench.tsx");
    for (const call of [
      "setModeState(restoredMode)",
      "setCollapsed(readStoredCollapsed())",
      "setTreeTab(readStoredTreeTab())",
      "writeStoredMode(next)",
      "writeStoredCollapsed(next)",
      "writeStoredTreeTab(next)",
      "isSameSelection(current, next) ? null : next",
      "isSameSelection(current, next) ? current : next",
      "shouldDockPreview(mode, selection)",
    ]) {
      expect(source).toContain(call);
    }
    expect(source).toMatch(
      /setSelection\(null\);\s*\n\s*\}, \[mode, currentWikiId, treeTab\]\)/,
    );
  });

  it("guards the restore so the reset effect cannot clear it", async () => {
    // Restoring mode, tab and row together makes the reset effect fire again
    // with the restored deps and clear the row that was just put back —
    // invisibly, with every existing assertion still green. The signature is
    // what makes the restore survive its own restore.
    const source = await component("Workbench.tsx");
    expect(source).toContain("restoreSignatureRef.current = layoutSignature(");
    expect(source).toMatch(
      /const pending = restoreSignatureRef\.current;\s*\n\s*if \(pending !== null\) \{\s*\n\s*if \(pending === layoutSignature\(mode, currentWikiId, treeTab\)\) \{\s*\n\s*restoreSignatureRef\.current = null;\s*\n\s*\}\s*\n\s*return;\s*\n\s*\}/,
    );
  });

  it("spells no width, floor or step of its own", async () => {
    // Every number in this file is a JSX index, a token name or a comment. A
    // bound typed here could only ever be grepped for.
    const source = await component("Workbench.tsx");
    for (const literal of ["200", "280", "320", "360", "1200", "1199", "48"]) {
      expect({ literal, found: stripComments(source).includes(literal) }).toEqual({
        literal,
        found: false,
      });
    }
  });
});

describe("SplitHandle carries the semantics and none of the geometry", () => {
  it("is a keyboard-operable vertical separator with a named range", async () => {
    const source = await component("SplitHandle.tsx");
    expect(source).toContain('role="separator"');
    expect(source).toContain('aria-orientation="vertical"');
    expect(source).toContain("aria-label={label}");
    expect(source).toContain("aria-valuenow={value}");
    expect(source).toContain("aria-valuemin={min}");
    expect(source).toContain("aria-valuemax={max}");
    expect(source).toContain("tabIndex={0}");
    expect(source).toContain("className={`wb-split-handle wb-split-handle--${id}`}");
  });

  it("captures the pointer and gives up capture on both exits", async () => {
    const source = await component("SplitHandle.tsx");
    expect(source).toContain("event.currentTarget.setPointerCapture(event.pointerId)");
    expect(source).toContain(
      "if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;",
    );
    expect(source).toContain("onMove(event.clientX)");
    // `lostpointercapture` ALONE. The browser releases an implicit capture right
    // after dispatching `pointerup`, so wiring both to `onEnd` fires it twice on
    // every ordinary drag — two `setResizing(false)` calls and two synchronous
    // localStorage writes per gesture, which is exactly what the shell's
    // "written once per gesture" comment says it does not do. This one event
    // still covers `pointercancel` and a capture the browser takes for a gesture
    // of its own, so nothing can strand `data-resizing` on.
    expect(source).toContain("onLostPointerCapture={onEnd}");
    expect(source).not.toContain("onPointerUp=");
    expect(source.match(/=\{onEnd\}/g) ?? []).toHaveLength(1);
  });

  it("starts a drag only for a primary press, and claims only an unmodified key", async () => {
    // Both rules live in `workbench-split` so the suite runs them; what a scan
    // can add is that the control actually asks, and asks BEFORE it captures.
    const source = await component("SplitHandle.tsx");
    expect(source).toMatch(
      /if \(!isPrimarySplitPress\(event\)\) return;[\s\S]{0,400}?setPointerCapture/,
    );
    expect(source).toMatch(
      /if \(!isUnmodifiedSplitKey\(event\)\) return;\s*\n\s*if \(onKey\(event\.key\)\) event\.preventDefault\(\);/,
    );
  });

  it("prevents the default only for a key the shell claimed", async () => {
    const source = await component("SplitHandle.tsx");
    expect(source).toContain("if (onKey(event.key)) event.preventDefault();");
  });

  it("contains no number, no bound and no storage", async () => {
    // `tabIndex={0}` is the one numeral, and it is a focus semantic rather than
    // a width. Everything else arrives as a prop.
    const code = stripComments(await component("SplitHandle.tsx")).replace(
      "tabIndex={0}",
      "",
    );
    expect(code).not.toMatch(/\d/);
    expect(code).not.toContain("Math.");
    expect(code).not.toContain("localStorage");
    expect(code).not.toContain("getBoundingClientRect");
    // The face lock: no chrome file under this directory may name the reading
    // face or its generic family.
    expect(code.replaceAll("sans-serif", "")).not.toContain("Georgia");
  });
});

describe("TreePanel remembers where each tree was left", () => {
  it("restores and persists per tab, through the guarded accessors", async () => {
    const source = await component("TreePanel.tsx");
    // On the element that actually SCROLLS. `.wb-tree-panel` is a flex column
    // with no overflow of its own, so a ref moved one element up leaves
    // `scrollTop` permanently 0: the restore writes 0, the listener never fires,
    // and the whole feature is dead with every other assertion here green.
    expect(source).toMatch(/ref=\{bodyRef\}\s*\n\s*className="wb-tree-body"/);
    expect(source).toContain("panel.scrollTop = readStoredTreeScroll()[tab]");
    expect(source).toContain("writeStoredTreeScroll(tab, panel.scrollTop)");
    // Both effects are keyed on the tab AND on the collapse, because showing a
    // hidden column is the moment the browser has just reset `scrollTop`.
    expect(source.match(/\}, \[tab, collapsed\]\);/g) ?? []).toHaveLength(2);
  });

  it("asks the element whether it is showing, not the collapse flag", async () => {
    // A `display: none` column reports `scrollTop === 0` by the browser's own
    // rules, so a persist that ran there would overwrite the offset the owner is
    // about to come back to. But the FLAG is not that question: the
    // `@media (max-width: 899px)` block force-shows a collapsed column, where the
    // tree is fully visible and scrollable — `if (collapsed) return;` would
    // neither restore nor remember its offset for every narrow load.
    const source = await component("TreePanel.tsx");
    expect(source).toContain("collapsed = false,");
    expect(source).not.toMatch(/if \(collapsed\) return;/);
    expect(source.match(/treeBodyShowing\(panel, collapsed\)/g) ?? []).toHaveLength(2);
    // The ELEMENT is asked here; what the answer MEANS is the executed
    // `treeScrollActive` above. Spelled inline, the rule could be inverted —
    // no offset ever restored, none ever written — with every scan below still
    // green, because each one only names a token this line happens to contain.
    expect(source).toContain(
      "return treeScrollActive(collapsed, panel.getClientRects().length > 0);",
    );
    // No width comparison in JS: the breakpoint has one definition, in the
    // stylesheet, and the element is what reports the outcome of it.
    const code = stripComments(source);
    expect(code).not.toContain("innerWidth");
    expect(code).not.toContain("matchMedia");
    expect(code).not.toContain("899");
    // …and the flag still reaches the panel, so both effects re-run on expand.
    const shell = await component("Workbench.tsx");
    expect(shell).toContain("collapsed={collapsed}");
  });

  it("force-shows a collapsed column below 900px, which is what makes that so", async () => {
    // The premise of the test above, read off the stylesheet rather than
    // asserted from memory: if this rule ever goes away, the element check is
    // merely redundant instead of wrong, and the test above says why it is there.
    const css = await globals();
    // The FIRST 899px block — Story 1.3's, which owns the left column at this
    // width. The last one is Story 1.5's Preview dock.
    const start = css.indexOf("@media (max-width: 899px)");
    expect(start).toBeGreaterThan(-1);
    const narrow = css.slice(start, css.indexOf("@media", start + 1));
    expect(narrow).toMatch(
      /\.wb-shell\[data-collapsed="true"\] \.wb-left \{\s*display: flex;/,
    );
  });

  it("coalesces the scroll write through one animation frame", async () => {
    const source = await component("TreePanel.tsx");
    expect(source).toContain("requestAnimationFrame");
    expect(source).toContain("cancelAnimationFrame(frame)");
    expect(source).toContain('addEventListener("scroll", onScroll, { passive: true })');
    expect(source).toContain('removeEventListener("scroll", onScroll)');
  });
});

describe("globals.css positions the divider from the grid's own properties", () => {
  it("declares the hit width in the one token block and makes the shell its origin", async () => {
    const css = await globals();
    expect(css.match(/^\.wb-shell \{$/gm) ?? []).toHaveLength(1);
    const tokens = tokenBlock(css);
    expect(tokens).toContain("--wb-split-hit: 9px;");
    expect(tokens).toContain("position: relative;");
  });

  it("reads --wb-tree and --wb-preview for the handle positions", async () => {
    // Computing `left` in JavaScript would be a second derivation of the layout;
    // reading the same custom property the track read makes the divider land on
    // the boundary by construction, inline override included.
    const css = await globals();
    expect(css).toContain(
      ".wb-split-handle--tree {\n  left: calc(var(--wb-rail) + var(--wb-tree) - var(--wb-split-hit) / 2);\n}",
    );
    expect(css).toContain(
      ".wb-split-handle--preview {\n  right: calc(var(--wb-preview) - var(--wb-split-hit) / 2);\n}",
    );
    // SLICED, not searched whole-file: `cursor: col-resize;` is also declared on
    // `.wb-split-handle` itself, so an unscoped `toContain` stays green with
    // this rule emptied — and every drag then sweeps a text selection across
    // the tree labels it passes over, with the cursor reverting each time the
    // pointer leaves the 9px strip. The prefixed form is asserted too: Safari
    // only dropped `-webkit-` for this property in 17.4.
    const resizingStart = css.indexOf('.wb-shell[data-resizing="true"] {');
    expect(resizingStart).toBeGreaterThan(-1);
    const resizing = css.slice(resizingStart, css.indexOf("}", resizingStart));
    expect(resizing).toContain("cursor: col-resize;");
    expect(resizing).toContain("-webkit-user-select: none;");
    expect(resizing).toContain("user-select: none;");
  });

  it("gives the handle the box the pointer path depends on", async () => {
    // Three declarations the drag cannot work without, and which no other
    // assertion here reaches. Deleting `touch-action: none` makes every touch
    // drag scroll the page instead of moving the divider; deleting the width
    // leaves a zero-wide target; dropping the stacking order puts the strip
    // under the column borders it sits between.
    const css = await globals();
    const start = css.indexOf(".wb-split-handle {");
    expect(start).toBeGreaterThan(-1);
    const rule = css.slice(start, css.indexOf("}", start));
    expect(rule).toContain("width: var(--wb-split-hit);");
    expect(rule).toContain("touch-action: none;");
    expect(rule).toMatch(/z-index: \d+;/);
    expect(rule).toContain("position: absolute;");
  });

  it("hides the handles below 1200px inside the block that already exists", async () => {
    const css = await globals();
    // No NEW responsive block: `workbench-left-column.test.ts` reads the LAST
    // block matching each query, so a third would silently retarget it.
    expect(css.match(/@media \(max-width: 1199px\)/g) ?? []).toHaveLength(2);
    expect(css.match(/@media \(max-width: 899px\)/g) ?? []).toHaveLength(2);
    const start = css.lastIndexOf("@media (max-width: 1199px)");
    const next = css.indexOf("@media", start + "@media (max-width: 1199px)".length);
    const block = css.slice(start, next === -1 ? undefined : next);
    expect(block).toMatch(/\.wb-split-handle \{\s*display: none;/);
  });

  it("paints the new rules from --wb-* tokens only", async () => {
    // `workbench-chrome.test.ts` bans the Folio tokens and the reading face in
    // every rule after the token block; this keeps the story's own slice honest
    // rather than relying on the whole-file check to notice.
    const css = await globals();
    const start = css.indexOf(".wb-split-handle {");
    expect(start).toBeGreaterThan(-1);
    const slice = css.slice(start, css.indexOf("/* ---- Docking the Preview", start));
    for (const banned of ["var(--ink)", "var(--paper)", "var(--accent)", "Georgia"]) {
      expect({ banned, found: slice.includes(banned) }).toEqual({ banned, found: false });
    }
    expect(slice).toContain("var(--wb-border)");
  });

  it("keeps the docked grid variants the last grid rules in the file", async () => {
    // The new rules go BEFORE them, because `[data-preview]` and
    // `[data-collapsed]` tie on specificity and source order is the mechanism.
    const css = await globals();
    expect(css.indexOf(".wb-split-handle {")).toBeLessThan(
      css.indexOf('.wb-shell[data-preview="true"] {'),
    );
    expect(css.lastIndexOf("grid-template-columns")).toBeGreaterThan(
      css.indexOf(".wb-split-handle {"),
    );
  });
});

/** Source with its comments removed, so a numeral in prose is not a finding. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "");
}
