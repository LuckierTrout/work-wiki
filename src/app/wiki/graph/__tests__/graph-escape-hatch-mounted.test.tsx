import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import GraphPage from "@/app/wiki/graph/page";
import { KNOWLEDGE_TREE_HREF } from "@/lib/workbench-url";
import { DEFAULT_TREE_TAB, TREE_TABS } from "@/lib/workbench-tree";
import type { UseGraphSimulationReturn } from "@/hooks/useGraphSimulation";

/**
 * MOUNTED facts about the graph canvas, all about the same corner of the same
 * page, because they need the same scaffolding — the Clerk / router /
 * simulation stubs below are what get this page to render at all, and a second
 * file holding a second copy of them is two stubs that drift apart.
 *
 *   1. The canvas's accessible escape hatch is REACHABLE (DW-461).
 *   2. The canvas ELEMENT is the page's one graph focus stop, and its fallback
 *      child is not (DW-594).
 *   3. The canvas advertises its keyboard affordance and ships the live region
 *      that speaks it (DW-595).
 *
 * They are one claim in three parts: the picture is operable from the keyboard
 * now, so every focus stop it puts in the tab order has to lead somewhere a
 * reader can see, and a reader who cannot see it has to be told the keys exist
 * and be able to hear where the cursor went.
 *
 * The parts are split across TWO describes rather than three — (2) and (3) are
 * both "what the page's markup promises about the keyboard", and the same
 * `theCanvas()` read answers both. Whether that promise is KEPT is
 * `graph-activation-mounted.test.tsx`'s subject, against the real hook; the
 * hook is a stub here, so nothing in this file can ask it.
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
 * 2. Which of the canvas's elements are focus stops (DW-594)
 *
 * The canvas once carried `tabIndex={0}` beside nothing but pointer handlers,
 * so a keyboard-only reader landed on a focus stop where Enter and Space did
 * nothing. DW-463 answered that by removing the stop. DW-595 built the missing
 * half instead — `useGraphSimulation` owns a keyboard node cursor, the arrows
 * move it, Enter and Space route through the same `openNode` a click does — so
 * the canvas is a tab stop again, this time one that leads somewhere. That the
 * activation actually works is `graph-activation-mounted.test.tsx`'s subject,
 * against the REAL hook; this file mocks the hook and can only ask about the
 * markup the page puts in the tab order.
 *
 * The remaining defect DW-463 explicitly left open was the fallback
 * `<a href={KNOWLEDGE_TREE_HREF}>` child: canvas fallback content is displayed
 * only by a client that cannot render the canvas at all, yet every browser that
 * CAN render it still includes focusable fallback content in the sequential
 * focus order — a focus stop rendering nothing on screen. DW-594 takes it out
 * of the tab order with `tabIndex={-1}` while leaving the link itself in place,
 * because `retired-surfaces.test.ts` pins the fallback as a real link and a
 * canvas-less client still needs it.
 *
 * These are MOUNTED reads rather than source scans for the same reason the
 * hatch's are: whether an element is a focus stop is a property of the rendered
 * DOM, and a source scan for a `tabIndex` prop would have to re-implement
 * `retired-surfaces.test.ts`'s brace-depth JSX tag scanner to find the canvas's
 * own opening tag — the duplication DW-460 already recorded.
 *
 * WHY TAB ORDER AND NEVER `.focus()` for the fallback child. In this jsdom an
 * element with `tabindex="-1"` reports `tabIndex === -1` but still ACCEPTS
 * programmatic focus, exactly as a browser does — that is what a negative
 * tabindex means. So `.focus()` would fail on a correctly-fixed anchor. The
 * question DW-594 is about is the SEQUENTIAL order, which `tabIndex < 0`
 * answers.
 *
 * The DW-461 paragraph above — "`role=\"img\"` prunes the canvas's
 * descendants" — is about what an assistive-technology tree EXPOSES. Pruning
 * from the accessibility tree is not removal from the focus order; the
 * `tabIndex={-1}` pinned below is what does that.
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
      handleKeyDown: vi.fn(),
      handleFocus: vi.fn(),
      handleBlur: vi.fn(),
      cursorAnnouncement: "",
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

describe("the graph canvas's focus stops lead somewhere (DW-594/595)", () => {
  /**
   * Why the canvas reads twice.
   *
   * The BEHAVIOURAL read is the fact itself: whether the element takes focus,
   * which is what a keyboard reader actually experiences. The MARKUP read is
   * what a reviewer greps for and what a diff shows — `tabIndex` going away is
   * a one-line change, and a failure that names the attribute is the one that
   * explains it fastest.
   *
   * They are not redundant. Each sees something the other cannot: the markup
   * read cannot see focusability that no `tabindex` spells (a `contenteditable`
   * canvas reports `tabIndex === -1` and carries no attribute, yet takes focus
   * in this jsdom), and the behavioural read cannot say WHICH prop put the
   * element in reach — nor distinguish `tabIndex={0}` from `tabIndex={-1}`,
   * since `focus()` succeeds on both.
   */
  const WHY_TAB_STOP =
    "the graph <canvas> is no longer a keyboard tab stop. It has to be one: DW-595 gave it a " +
    "keyboard node cursor (arrows move it, Enter/Space route through the same openNode a click " +
    "does), and a reader who cannot reach the element cannot use any of it. If you are removing " +
    "the focus stop, the keyboard path in useGraphSimulation and its pins in " +
    "graph-activation-mounted.test.tsx are what you are removing with it — the earlier DW-463 " +
    "answer, 'a picture need not be operable', only held while nothing here was operable.";

  const WHY_NO_FALLBACK_TAB_STOP =
    "the <canvas> fallback <a> is back in the sequential tab order. Fallback content is DISPLAYED " +
    "only by a client that cannot render the canvas at all, but a browser that can render it " +
    "still puts focusable fallback content in the focus order — so this is a tab stop that " +
    "renders nothing on screen (DW-594). Keep the link (retired-surfaces.test.ts pins it, and a " +
    "canvas-less client needs it); keep tabIndex={-1} beside it.";

  it("takes focus when focus is pushed onto the canvas", () => {
    // jsdom's `focus()` honours focusability, so a plain `<canvas>` stays
    // unfocused here while a `tabIndex={0}` one becomes `activeElement`.
    render(<GraphPage />);
    const canvas = theCanvas();
    canvas.focus();
    expect(document.activeElement, WHY_TAB_STOP).toBe(canvas);
  });

  it("spells that focus stop in its markup", () => {
    // Positive, not merely present: `tabIndex={-1}` would take focus under the
    // behavioural read above while leaving the canvas out of the SEQUENTIAL
    // order — reachable by script and by nothing a keyboard reader does.
    render(<GraphPage />);
    const attr = theCanvas().getAttribute("tabindex");
    expect(
      attr !== null && Number(attr) >= 0,
      `${WHY_TAB_STOP} (tabindex=${JSON.stringify(attr)})`,
    ).toBe(true);
  });

  it("keeps the fallback <a> out of the tab order", () => {
    // TAB ORDER, never `.focus()`: a negative tabindex still ACCEPTS
    // programmatic focus in this jsdom and in every browser, so a `.focus()`
    // read would fail on the correctly-fixed anchor. See the header.
    render(<GraphPage />);
    const fallback = theCanvas().querySelector<HTMLAnchorElement>(
      `a[href="${KNOWLEDGE_TREE_HREF}"]`,
    );
    expect(
      fallback,
      "no fallback <a> inside the <canvas> — a client that cannot render the canvas now has no " +
        "text alternative at all (DW-131)",
    ).not.toBeNull();
    expect(fallback!.tabIndex, WHY_NO_FALLBACK_TAB_STOP).toBeLessThan(0);
  });

  it("keeps the picture semantics the announcement is built around", () => {
    // The canvas is operable but still a PICTURE: `role="img"` is what
    // DW-131/DW-461 pin, and it is why the keyboard cursor is announced by a
    // sibling live region rather than by the canvas's own name. If this ever
    // becomes `role="application"` — which suppresses browse mode — the whole
    // announcement design should be revisited rather than trusted.
    render(<GraphPage />);
    const canvas = theCanvas();
    expect(
      canvas.getAttribute("role"),
      "the canvas is no longer role=\"img\", so the picture-plus-live-region design DW-594/595 " +
        "chose no longer describes it (DW-131/DW-461)",
    ).toBe("img");

    // Read once and null-checked before matching: `toMatch` on a `null` fails
    // as a matcher TYPE error ("received value must be a string"), which would
    // report a REMOVED label as a broken test rather than as the missing text
    // alternative it is.
    const label = canvas.getAttribute("aria-label");
    expect(
      label,
      "the canvas has no aria-label at all — it is an unlabelled role=img, so its text " +
        "alternative is gone (DW-131/DW-461)",
    ).not.toBeNull();
    expect(
      label ?? "",
      "the canvas's aria-label no longer names the Knowledge tree, so it no longer points a " +
        "screen-reader user at the alternative beside it (DW-461)",
    ).toMatch(TREE_LINK_NAME);
  });

  it("tells a screen-reader user the keys exist", () => {
    // The canvas is an operable `role="img"`, which advertises no interaction
    // of its own — nothing about a picture says "the arrows do something here".
    // `page.tsx` puts that sentence in the label deliberately, and without this
    // read, trimming the label back to its pre-DW-595 wording leaves the whole
    // keyboard path undiscoverable while every other assertion stays green.
    render(<GraphPage />);
    const label = theCanvas().getAttribute("aria-label") ?? "";
    expect(
      label,
      "the canvas's aria-label no longer names the arrow keys, so a screen-reader user is never " +
        "told the keyboard cursor exists (DW-595)",
    ).toMatch(/arrow keys/i);
    expect(
      label,
      "the canvas's aria-label no longer names the key that opens a node (DW-595)",
    ).toMatch(/enter/i);
  });

  it("carries a polite live region for the cursor announcement", () => {
    // The canvas's name is static, so the node under the keyboard cursor is
    // announced HERE. Without the region, the cursor moves silently and the
    // keyboard path is usable only by someone who can see the ring — which is
    // the reader it was not built for.
    // EITHER attribute, not both. `role="status"` already implies
    // `aria-live="polite"` — the explicit attribute beside it is belt and
    // braces, not a second fact — so demanding the pair would fail a
    // behaviour-preserving edit while reporting it as "the cursor has nowhere
    // to announce", naming a defect that is not there. Same reasoning as the
    // tabindex paragraph in the header: assert the property, not one spelling
    // of it.
    render(<GraphPage />);
    const regions = document.querySelectorAll(
      '[role="status"], [aria-live="polite"]',
    );
    expect(
      regions.length,
      "no polite live region on the graph page — the keyboard cursor has nowhere to announce " +
        "the node it lands on (DW-595)",
    ).toBeGreaterThanOrEqual(1);
    // Outside the canvas, or `role="img"` prunes it from the accessibility
    // tree along with the rest of the subtree and it announces to no one.
    expect(
      [...regions].some((region) => region.closest("canvas") === null),
      "every live region on the page is INSIDE the <canvas>, where role=\"img\" prunes it from " +
        "the accessibility tree (DW-595)",
    ).toBe(true);
  });
});
