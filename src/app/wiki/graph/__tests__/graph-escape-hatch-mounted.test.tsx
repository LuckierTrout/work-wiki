import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import GraphPage from "@/app/wiki/graph/page";
import { KNOWLEDGE_TREE_HREF } from "@/lib/workbench-url";
import { DEFAULT_TREE_TAB, TREE_TABS } from "@/lib/workbench-tree";
import type { UseGraphSimulationReturn } from "@/hooks/useGraphSimulation";

/**
 * MOUNTED facts about the graph canvas. Two of them, both about the same
 * element, because they need the same scaffolding — the Clerk / router /
 * simulation stubs below are what get this page to render at all, and a second
 * file holding a second copy of them is two stubs that drift apart.
 *
 *   1. The canvas's accessible escape hatch is REACHABLE (DW-461).
 *   2. The canvas ELEMENT itself takes no keyboard focus (DW-463).
 *
 * They are the two halves of one claim: the picture is not operable, so the
 * text alternative beside it has to be.
 *
 * ---------------------------------------------------------------------------
 * 1. The escape hatch (DW-461)
 *
 * `src/lib/__tests__/retired-surfaces.test.ts` pins the same escape hatch by
 * reading `page.tsx` as TEXT — assertions about the presence and the wording of
 * markup. Presence is not reachability. Adding `aria-hidden="true"` to the
 * visible `<Link>`, or `tabIndex={-1}`, prunes the only link a real reader can
 * reach while every one of those source scans stays green: the source still
 * contains a `<Link href={KNOWLEDGE_TREE_HREF}>` outside the canvas, still
 * spells no route literal, still names no retired surface. What a source scan
 * cannot ask is whether the accessibility tree still has the link in it.
 *
 * So this asks the rendered document instead, and it is the ONLY thing here
 * that does — the source pins stay where they are, beside it.
 *
 * WHY THE `.closest("canvas")` FILTER rather than "there is exactly one link".
 * The page ships TWO links to `KNOWLEDGE_TREE_HREF`: the visible one, and the
 * `<canvas>` fallback child that a client with no canvas support shows. In a
 * real accessibility tree the fallback is gone — `role="img"` prunes the
 * canvas's descendants — but dom-testing-library does not implement that
 * pruning, and jsdom holds the fallback `<a>` as ordinary DOM. Counting links
 * would therefore be satisfied by the unreachable one alone, which is exactly
 * the DW-131 bug this hatch exists to have fixed. The reachable set is the one
 * outside the canvas. That the filter is doing real work is asserted below
 * rather than assumed, because the day the query grows the pruning is the day
 * the filter silently becomes a no-op.
 *
 * `queryAllByRole`, never `getAllByRole`: the `get*` family THROWS "Unable to
 * find role" on an empty result, which would pre-empt this file's own
 * diagnostics in precisely the state they were written for.
 *
 * `getByRole` already honours `aria-hidden`, so the pruning case needs no extra
 * read; `tabIndex` is a separate fact and gets its own.
 *
 * ---------------------------------------------------------------------------
 * 2. The canvas element is not a focus stop (DW-463)
 *
 * The canvas once carried `tabIndex={0}` beside nothing but pointer handlers,
 * so a keyboard-only reader landed on a focus stop where Enter and Space did
 * nothing. The fix was to remove the focus stop, not to invent a keyboard node
 * cursor — see the block comment above the canvas in `page.tsx`.
 *
 * That pin is a MOUNTED read rather than a source scan for the same reason the
 * hatch's is: whether an element is a focus stop is a property of the rendered
 * DOM, and a source scan for a `tabIndex` prop would have to re-implement
 * `retired-surfaces.test.ts`'s brace-depth JSX tag scanner to find the canvas's
 * own opening tag — the duplication DW-460 already recorded.
 *
 * SCOPE: the canvas ELEMENT, not its subtree. The fallback
 * `<a href={KNOWLEDGE_TREE_HREF}>` child is itself focusable — in this jsdom it
 * reports `tabIndex === 0` and takes focus, and browsers likewise include
 * focusable canvas fallback content in the sequential focus order. So the claim
 * below is about the element, not about everything inside it. Whether that
 * fallback child should be reachable is a SEPARATE, pre-existing question: it
 * predates DW-463, it is deferred rather than fixed here, and nothing below
 * asserts anything about it.
 *
 * In particular, the DW-461 paragraph above — "`role=\"img\"` prunes the
 * canvas's descendants" — is about what an assistive-technology tree EXPOSES.
 * Pruning from the accessibility tree is not removal from the focus order, so
 * that sentence must not be read as covering the fallback child's focusability.
 */

// A signed-out reader is the smallest state that renders the graph at all: the
// `/api/vaults` effect is gated on `isSignedIn`, so this mock is also what keeps
// the suite off `fetch`.
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
  }),
}));

/**
 * The simulation is mocked at its RETURN SHAPE, not reshaped in `src/`: jsdom
 * has no 2D context, so the real hook's render loop cannot run here at all.
 *
 * `satisfies UseGraphSimulationReturn` is what keeps the stub honest. Without
 * it a field added to the hook and destructured by `GraphPage` would arrive
 * `undefined` here and this suite would stay green while the page it claims to
 * mount had moved on; with it, that drift is a `tsc` failure. (The type import
 * is erased, so it survives `vi.mock`'s hoisting.)
 *
 * `loading: false`, `fetchError: null`, `empty: false` is the one branch that
 * renders the escape hatch — the other three render a `<p>` and nothing else,
 * so a stub that drifted off this branch would assert nothing.
 */
vi.mock("@/hooks/useGraphSimulation", () => ({
  useGraphSimulation: () =>
    ({
      loading: false,
      empty: false,
      fetchError: null,
      canvasBg: "#0b0b0b",
      handleMouseMove: vi.fn(),
      handleMouseLeave: vi.fn(),
      handleClick: vi.fn(),
    }) satisfies UseGraphSimulationReturn,
}));

afterEach(() => {
  cleanup();
});

/** The tab a reader following `KNOWLEDGE_TREE_HREF` lands on. */
const LANDING_TAB = TREE_TABS.find((tab) => tab.id === DEFAULT_TREE_TAB);

/**
 * The accessible name the escape hatch's link must carry, DERIVED from the tab
 * constants rather than re-spelled here.
 *
 * `retired-surfaces.test.ts` couples the graph page's copy to `TREE_TABS` for
 * this reason, and a mounted suite that hard-coded `/Knowledge tree/` would
 * quietly opt out of that coupling: renaming the tab would leave this file
 * hunting for a name nothing renders, and the failure would read as a missing
 * role rather than as the rename it is.
 */
const TREE_LINK_NAME = new RegExp(
  `${(LANDING_TAB?.label ?? "«DEFAULT_TREE_TAB names no tab»").replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  )} tree`,
);

/**
 * Every link to the Knowledge tree in the document, reachable or not.
 *
 * Queried on `document` rather than on the render container, the
 * `src/components/__tests__/single-main-landmark-mounted.test.tsx` rationale: a
 * link reaching the DOM through a portal is outside the container subtree and
 * is still in the accessibility tree.
 */
function treeLinks(): HTMLElement[] {
  return screen.queryAllByRole("link", { name: TREE_LINK_NAME });
}

/** Those of them a reader can actually get to — see the header. */
function reachableTreeLinks(): HTMLElement[] {
  return treeLinks().filter((link) => link.closest("canvas") === null);
}

/**
 * The one reachable link, or a failure that says which of the two ways it is
 * gone. Every read below goes through this rather than indexing `[0]`, so a
 * pruned hatch is an assertion failure naming the defect and not a `TypeError`
 * on `undefined`.
 */
function theReachableLink(): HTMLElement {
  const reachable = reachableTreeLinks();
  expect(
    reachable,
    `no reachable link named ${TREE_LINK_NAME} outside the <canvas> — either the visible one was ` +
      "pruned from the accessibility tree, or the only one left is the fallback child, which a " +
      "client that CAN render the canvas never shows",
  ).toHaveLength(1);
  return reachable[0];
}

/**
 * The page's one `<canvas>`, or a failure that says which way it is gone.
 *
 * Hoisted rather than fetched inline, because BOTH describes below reason about
 * "the canvas" as a single element — the escape hatch's `.closest("canvas")`
 * filter and the focus pins alike — and one helper means one diagnostic when it
 * is missing.
 *
 * The COUNT is asserted rather than assumed: `document.querySelector("canvas")`
 * silently returns the first of however many there are, so a second canvas
 * appearing would leave every read below describing whichever rendered first
 * while still passing. `retired-surfaces.test.ts` pins the single canvas at the
 * SOURCE surface; this is the same fact at the rendered one.
 */
function theCanvas(): HTMLCanvasElement {
  const canvases = document.querySelectorAll("canvas");
  expect(
    canvases.length,
    "expected exactly one <canvas> on the graph page: none means the mocked useGraphSimulation " +
      "has drifted off the loading:false / empty:false / fetchError:null branch (the only one " +
      "that renders it); more than one means every read in this file is about whichever " +
      "rendered first",
  ).toBe(1);
  return canvases[0];
}

describe("the graph page's Knowledge tree escape hatch is reachable", () => {
  it("names a real tree tab, so the query below can find anything at all", () => {
    // The premise of `TREE_LINK_NAME`. Asserted rather than assumed, because a
    // `DEFAULT_TREE_TAB` naming no member would make every query in this file
    // hunt for a placeholder and fail with a message about links.
    expect(
      LANDING_TAB,
      `DEFAULT_TREE_TAB ("${DEFAULT_TREE_TAB}") names no TREE_TABS member`,
    ).toBeDefined();
  });

  it("renders the canvas whose alternative this link is", () => {
    // The premise of the `.closest("canvas")` filter. With no canvas on the
    // page, `.closest("canvas")` would be vacuously null for every link and the
    // "outside the canvas" assertion would stop distinguishing anything.
    render(<GraphPage />);
    const canvas = theCanvas();
    expect(canvas.getAttribute("role")).toBe("img");
    expect(canvas.querySelector(`a[href="${KNOWLEDGE_TREE_HREF}"]`)).not.toBeNull();
  });

  it("keeps the filter load-bearing: the query itself returns both links", () => {
    // THE ASSUMPTION THIS FILE RESTS ON, written down as an assertion. The
    // header says dom-testing-library does not prune a `role="img"` subtree, so
    // the unfiltered query sees the fallback child too and the filter is what
    // separates reachable from not. If that ever stops being true — the library
    // implements presentational children, or the fallback is removed — the
    // filter becomes a no-op and every assertion below would pass while
    // asserting nothing about reachability. This is the test that notices.
    render(<GraphPage />);
    const all = treeLinks();
    expect(
      all,
      "the unfiltered role query no longer returns BOTH links, so filtering by .closest(\"canvas\") " +
        "is no longer what distinguishes the reachable one — re-read this file's header before " +
        "trusting anything below",
    ).toHaveLength(2);
    expect(all.filter((link) => link.closest("canvas") !== null)).toHaveLength(1);
  });

  it("exposes exactly one Knowledge tree link outside the canvas", () => {
    render(<GraphPage />);
    theReachableLink();
  });

  it("points that link at KNOWLEDGE_TREE_HREF", () => {
    render(<GraphPage />);
    expect(theReachableLink().getAttribute("href")).toBe(KNOWLEDGE_TREE_HREF);
  });

  it("leaves that link in the keyboard order", () => {
    // The second half of "reachable". A link the role query still finds can be
    // `tabIndex={-1}`, which takes it out of the tab order for exactly the
    // readers this escape hatch is for.
    render(<GraphPage />);
    expect(
      theReachableLink().tabIndex,
      "the Knowledge tree link is out of the keyboard order (tabIndex < 0)",
    ).toBeGreaterThanOrEqual(0);
  });
});

describe("the graph canvas element is not a keyboard focus stop (DW-463)", () => {
  /**
   * Why this reads twice.
   *
   * The BEHAVIOURAL read is the fact itself: whether the element takes focus,
   * which is what a keyboard reader actually experiences. The MARKUP read is
   * what a reviewer greps for and what a diff shows — `tabIndex={0}` coming
   * back is a one-line change, and a failure that names the attribute is the
   * one that explains it fastest.
   *
   * They are not redundant. Each sees something the other cannot: the markup
   * read cannot see focusability that no `tabindex` spells (a `contenteditable`
   * canvas reports `tabIndex === -1` and carries no attribute, yet takes focus
   * in this jsdom), and the behavioural read cannot say WHICH prop put the
   * element back in reach.
   */
  const WHY_NO_TAB_STOP =
    "the graph <canvas> element takes keyboard focus again. A focus stop here is inert: the " +
    "canvas has pointer handlers only, and handleClick hit-tests clientX/clientY against node " +
    "positions, so no key press has a selected node to activate — which is exactly what put a " +
    "keyboard-only reader on an Enter/Space no-op in DW-463. If you are adding a REAL keyboard " +
    "activation path here — a node cursor the keyboard owns, plus onKeyDown reaching the same " +
    "handler the click does — this pin is the thing to update; until then the canvas advertises " +
    "the visible Knowledge tree link outside it, pinned above, as its text alternative.";

  it("takes no focus when focus is pushed onto it", () => {
    // jsdom's `focus()` honours focusability, so a plain `<canvas>` stays
    // unfocused here while a `tabIndex={0}` one becomes `activeElement`.
    //
    // This is deliberately STRICTER than "not in the sequential tab order":
    // `focus()` succeeds on a `tabIndex={-1}` element too, so an explicit
    // negative tabindex — not a tab stop, but programmatically focusable for no
    // reason this page has — would fail here while passing the markup read
    // below. If you land on exactly that split, it is the signal to come read
    // this block and decide deliberately, not a bug in either assertion.
    render(<GraphPage />);
    const canvas = theCanvas();
    canvas.focus();
    expect(document.activeElement, WHY_NO_TAB_STOP).not.toBe(canvas);
  });

  it("spells no focus stop in its markup either", () => {
    // Absent OR negative: both mean "not a tab stop", and the defect was the
    // positive one. Asserting `hasAttribute === false` alone would fail a
    // deliberate `tabIndex={-1}` while reporting it as a return to the keyboard
    // order, which is the wrong diagnosis.
    render(<GraphPage />);
    const attr = theCanvas().getAttribute("tabindex");
    expect(
      attr === null || Number(attr) < 0,
      `${WHY_NO_TAB_STOP} (tabindex=${JSON.stringify(attr)})`,
    ).toBe(true);
  });

  it("keeps the picture semantics that make the missing focus stop correct", () => {
    // Not operable is only defensible while the element is a PICTURE with a
    // text alternative. If the canvas ever stops being `role="img"` — becomes a
    // `role="application"`, say — "no focus stop" stops being the right answer
    // and this file should be revisited rather than trusted.
    render(<GraphPage />);
    const canvas = theCanvas();
    expect(
      canvas.getAttribute("role"),
      "the canvas is no longer role=\"img\", so \"a picture need not be operable\" no longer " +
        "justifies it having no focus stop (DW-463)",
    ).toBe("img");

    // Read once and null-checked before matching: `toMatch` on a `null` fails
    // as a matcher TYPE error ("received value must be a string"), which would
    // report a REMOVED label as a broken test rather than as the missing text
    // alternative it is.
    const label = canvas.getAttribute("aria-label");
    expect(
      label,
      "the canvas has no aria-label at all — it is an unlabelled role=img, so the text " +
        "alternative that justifies it having no focus stop is gone (DW-463)",
    ).not.toBeNull();
    expect(
      label ?? "",
      "the canvas's aria-label no longer names the Knowledge tree, so it no longer points a " +
        "screen-reader user at the alternative standing in for the absent focus stop (DW-463)",
    ).toMatch(TREE_LINK_NAME);
  });
});
