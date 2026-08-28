import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SplitHandle } from "@/components/workbench/SplitHandle";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  SPLIT_NARROW_QUERY,
  SPLIT_PREVIEW_LABEL,
  SPLIT_TREE_LABEL,
} from "@/lib/workbench-split";
import { SETTINGS_LABEL } from "@/lib/workbench-settings";
import { buildFileTree } from "@/lib/workbench-tree";
import {
  readStoredTreeScroll,
  writeStoredCollapsed,
  writeStoredSelection,
  writeStoredSplitWidths,
  writeStoredTreeScroll,
} from "@/lib/workbench-state";
import { setElementRect, setMediaQuery } from "@/test/dom-helpers";

/**
 * DW-44/45/47's two headline behaviours, MOUNTED — the halves `workbench-split.
 * test.ts` can only match as source text.
 *
 * That suite executes every number and greps every wiring, which is the right
 * shape for geometry: `vitest.config.ts`'s `node` project cannot mount a
 * component, so a bound typed into a handler would otherwise be invisible. But
 * two of this work's claims are about the DOCUMENT rather than about a number,
 * and a `toContain` on source text cannot see either of them:
 *
 *  - `aria-controls` is only ever a string to TypeScript. Moving `id={LEFT_ID}`
 *    onto an inner wrapper, or dropping `id={PREVIEW_ID}` from the
 *    `<PreviewColumn>` mount, leaves every scan green with both references
 *    dangling — and a dangling `aria-controls` is the thing both docblocks argue
 *    is worse than none.
 *  - DW-47's restore can ship inert. Wired exactly as written — the
 *    `matchMedia(SPLIT_NARROW_QUERY)` call, the guard, the
 *    `[tab, collapsed, narrow]` dep key — the effect can still restore nothing,
 *    and all three assertions still match.
 *
 * THE WIDTH IS DECLARED, NOT MEASURED. jsdom runs no layout, so an unaided
 * mount reports `shellWidth === 0` and `isSplitMeasured` short-circuits every
 * width-derived decision before it can be made. `setElementRect(".wb-shell",
 * { width })` from `vitest.setup.dom.ts` states the box the shell reports, and
 * it is stated BEFORE `render()` because the measure effect runs at mount —
 * there is no element to hand a width to until after the decision under test has
 * already been taken. What that buys is the shell's REACTION to a width, and
 * nothing more: a declared box is a fact the test asserted, so these cases can
 * never catch a CSS or layout mistake. The geometry itself — every bound, the
 * clamp, pointer-x → width — stays executed as rules in `workbench-split.test.
 * ts` against the real stylesheet.
 *
 * The control's OWN half — the attribute it emits and the x it forwards — is
 * executed at the bottom of this file, rendered directly, where no width is
 * involved at all.
 */

// ONE stable router object, for the reason `workbench-mode-url.test.tsx` gives:
// several components in this shell key effects on the router identity.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const WIKI_ID = "wiki-1";

const KNOWLEDGE = [
  {
    id: "note",
    label: "Note",
    count: 2,
    pages: [
      { slug: "alpha", title: "Alpha", type: "note" },
      { slug: "beta", title: "Beta", type: "note" },
    ],
  },
];

const FILES = buildFileTree(["wiki/alpha.md", "raw/", "raw/x.md"]);

const DATA: WorkbenchData = {
  wikis: [],
  currentWikiId: WIKI_ID,
  registryUnavailable: false,
  knowledge: KNOWLEDGE,
  knowledgeUnavailable: false,
  files: FILES,
  filesUnavailable: false,
  filesTruncated: false,
  dataVersion: 0,
  readOnly: false,
};

beforeEach(() => {
  window.localStorage.clear();
  // Two consumers share this global: `useSidecarStatus` probes the loopback port
  // at mount, and `PreviewColumn` reads a docked row's bytes. An affirmative
  // default keeps both off the network and lets their setState settle in `act`.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/workbench/preview")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            name: "Alpha",
            path: "wiki/alpha.md",
            slug: "alpha",
            format: "markdown" as const,
            body: "# Alpha",
            truncated: false,
            editable: true,
          }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({}),
        text: async () => "",
      } as unknown as Response;
    }),
  );
});

afterEach(() => {
  // FIRST: vitest runs `afterEach` in reverse registration order, so the setup
  // file's own `cleanup()` lands after this. Unmounting here tears the tree down
  // while `fetch` is still stubbed and the spies are still installed.
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderShell(data: WorkbenchData = DATA) {
  const view = render(
    <WorkbenchDataProvider value={data}>
      <Workbench>
        <p>canvas</p>
      </Workbench>
    </WorkbenchDataProvider>,
  );
  // Flush the sidecar probe, the mount restores and any Preview read before any
  // assertion.
  await act(async () => {});
  return view;
}

function treeBody(): HTMLElement {
  const panel = document.querySelector<HTMLElement>(".wb-tree-body");
  expect(panel).not.toBeNull();
  return panel as HTMLElement;
}

describe("every aria-controls the shell writes resolves to a real element (DW-45)", () => {
  it("names the left column the tree separator resizes", async () => {
    await renderShell();
    // The literal id, deliberately: `LEFT_ID` is module-private to
    // `Workbench.tsx`, so restating it here is what makes the test fail if the
    // attribute and the element ever stop naming the same string. The rail's
    // collapse chevron points at this id too, and has since Story 1.3.
    const left = document.getElementById("wb-left-column");
    expect(left).not.toBeNull();
    // …and it is the COLUMN, not an inner wrapper that happens to be in it.
    expect(left?.classList.contains("wb-left")).toBe(true);
  });

  it("names the docked Preview aside the Preview separator resizes", async () => {
    // The `<aside>` exists only while the Preview is docked, which is the same
    // condition `showSplitHandle("preview", …)` reports — so this is also the
    // proof that the id is there for exactly as long as the separator that
    // points at it. A stored selection docks it without a click.
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    await renderShell();
    const aside = document.getElementById("wb-preview-column");
    expect(aside).not.toBeNull();
    // The same element the accessibility tree exposes as the Preview: an id on
    // some other node would resolve and still name the wrong thing.
    expect(aside).toBe(screen.getByRole("complementary", { name: "Preview" }));
    expect(aside?.tagName).toBe("ASIDE");
  });

  it("has no dangling Preview id while the Preview is closed", async () => {
    // The other half of the pairing: no `<aside>`, no separator, no id — rather
    // than an id parked on something permanent that would make the assertion
    // above pass whatever the shell did with the Preview.
    await renderShell();
    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
    expect(document.getElementById("wb-preview-column")).toBeNull();
  });
});

function shellElement(): HTMLElement {
  const element = document.querySelector<HTMLElement>(".wb-shell");
  expect(element).not.toBeNull();
  return element as HTMLElement;
}

function separator(label: string): HTMLElement {
  return screen.getByRole("separator", { name: label });
}

/**
 * The decisions the shell makes FROM its width, mounted (DW-113).
 *
 * Every number below is `workbench-split.test.ts`'s rule applied to the width
 * this file declares, restated as a literal on purpose: the arithmetic is spelt
 * out in each comment so a case that goes red names which rule moved, rather
 * than re-deriving the expectation from the same functions it is checking.
 *
 * Shell arithmetic, once: the frame minus the 48px rail minus the 320px canvas
 * floor minus whatever the OTHER side column is taking is the room a column may
 * grow into, never below its own 200px floor.
 */
describe("the shell's width-derived decisions, mounted (DW-113)", () => {
  it("measures at mount, so the grid gets the widths and both separators exist", async () => {
    // A stored selection docks the Preview without a click, so both dividers are
    // in scope at once.
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    // BEFORE `render()`: the measure effect runs at mount, and a width declared
    // afterwards could only ever reach the resize path.
    setElementRect(".wb-shell", { width: 1400 });
    await renderShell();

    // The defaults survive 1400px untouched — `splitStyleVars` returns
    // `undefined` until the shell is BOTH mounted and measured, so these two
    // properties existing at all is the measurement arriving.
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("280px");
    expect(shellElement().style.getPropertyValue("--wb-preview")).toBe("360px");

    // `showSplitHandle` gates on `mounted && isSplitMeasured`, so a separator
    // EXISTING is the same proof from the other side.
    const tree = separator(SPLIT_TREE_LABEL);
    const preview = separator(SPLIT_PREVIEW_LABEL);
    expect(tree.getAttribute("aria-valuenow")).toBe("280");
    expect(preview.getAttribute("aria-valuenow")).toBe("360");
    // 1400 − 48 − 320 − 360(preview) = 672 for the tree;
    // 1400 − 48 − 320 − 280(tree)    = 752 for the Preview.
    expect(tree.getAttribute("aria-valuemax")).toBe("672");
    expect(preview.getAttribute("aria-valuemax")).toBe("752");
  });

  it("re-measures on a window resize, so the layout follows the frame", async () => {
    // A stored tree wide enough that the two frames disagree about it: at 1400
    // it fits as stored, at 700 it cannot.
    writeStoredSplitWidths({ tree: 600, preview: 360 });
    setElementRect(".wb-shell", { width: 1400 });
    await renderShell();

    // Preview closed, so the tree's room is 1400 − 48 − 320 = 1032 and 600 fits.
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("600px");
    expect(separator(SPLIT_TREE_LABEL).getAttribute("aria-valuemax")).toBe("1032");

    // The frame narrows, then the browser says so. Both halves are needed: the
    // declaration alone changes what the shell WOULD measure, and the event
    // alone re-measures the width it already had.
    setElementRect(".wb-shell", { width: 700 });
    await act(async () => {
      window.dispatchEvent(new Event("resize"));
    });

    // 700 − 48 − 320 = 332, and the stored 600 is clamped down to it. Delete
    // `window.addEventListener("resize", measure)` from `Workbench.tsx` and this
    // stays at 600px / 1032 — the frame moved and the layout did not.
    //
    // NOT a claim that a divider is usable at 700px: a real browser hides both
    // handles below 1200px, and `showSplitHandle` carries no breakpoint on
    // purpose (`workbench-split.ts` says why — the 900–1199px block pins both
    // side columns in CSS, and a width comparison here would be a second,
    // drifting copy of it). jsdom applies no stylesheet, so the element is still
    // in the tree and its ARIA range is still the shell's own answer, which is
    // the only thing asserted.
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("332px");
    const tree = separator(SPLIT_TREE_LABEL);
    expect(tree.getAttribute("aria-valuenow")).toBe("332");
    expect(tree.getAttribute("aria-valuemax")).toBe("332");
  });

  it("shrinks the TREE first when neither preferred width fits", async () => {
    // The clamp's ORDER is the whole content of the decision, and it is only
    // visible when both preferences are too large for the frame at once.
    writeStoredSplitWidths({ tree: 600, preview: 600 });
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    setElementRect(".wb-shell", { width: 1000 });
    await renderShell();

    // Tree first, against the UNCLAMPED preview: 1000 − 48 − 320 − 600 = 32,
    // floored at the 200px minimum, so the tree gives up 400px.
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("200px");
    // Preview second, against the ALREADY-CLAMPED tree: 1000 − 48 − 320 − 200 =
    // 432, so the Preview gives up only 168px. Clamped in the other order the
    // Preview would be the one pinned to its floor.
    expect(shellElement().style.getPropertyValue("--wb-preview")).toBe("432px");

    // …and the range each separator ANNOUNCES agrees with the width it was
    // clamped to. A handle that announced the floors as its range while the
    // column rendered at something else is the exact lie `isSplitMeasured`
    // exists to prevent, and it is invisible to a source scan.
    const tree = separator(SPLIT_TREE_LABEL);
    expect(tree.getAttribute("aria-valuenow")).toBe("200");
    expect(tree.getAttribute("aria-valuemin")).toBe("200");
    // Degenerate on purpose: at this frame there is no room for the tree to
    // grow into, so min === max rather than a negative track.
    expect(tree.getAttribute("aria-valuemax")).toBe("200");

    const preview = separator(SPLIT_PREVIEW_LABEL);
    expect(preview.getAttribute("aria-valuenow")).toBe("432");
    expect(preview.getAttribute("aria-valuemax")).toBe("432");
  });

  it("renders no Preview separator while the Preview is closed", async () => {
    setElementRect(".wb-shell", { width: 1400 });
    await renderShell();

    // Measured — so the absence below is the dock rule, not the width being
    // unknown. Without this line the case would pass on an unmeasured shell,
    // where NEITHER separator exists.
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("280px");
    // `queryByRole` on both halves, deliberately: `separator()` wraps
    // `getByRole`, which THROWS on a miss, so wrapping it in `not.toBeNull()`
    // would assert nothing it does not already assert by not throwing.
    expect(screen.queryByRole("separator", { name: SPLIT_TREE_LABEL })).not.toBeNull();
    expect(screen.queryByRole("separator", { name: SPLIT_PREVIEW_LABEL })).toBeNull();
    // With the Preview closed its width is not the tree's constraint:
    // 1400 − 48 − 320 = 1032, where the docked case above reported 672.
    expect(separator(SPLIT_TREE_LABEL).getAttribute("aria-valuemax")).toBe("1032");
  });

  it("leaves an undeclared shell exactly as jsdom reports it", async () => {
    // The other half of the harness's contract, and the reason every suite
    // written before it is unaffected: with no declaration the shell measures 0,
    // `isSplitMeasured` is false, and the shell writes no custom property and
    // mounts no separator — which is precisely what the cases above had to
    // declare a width to escape.
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    await renderShell();
    expect(shellElement().style.getPropertyValue("--wb-tree")).toBe("");
    expect(screen.queryByRole("separator", { name: SPLIT_TREE_LABEL })).toBeNull();
    expect(screen.queryByRole("separator", { name: SPLIT_PREVIEW_LABEL })).toBeNull();
  });
});

/**
 * The harness's own contract, asserted where it is used rather than as a second
 * file about the setup file.
 *
 * The cases above are what a declaration BUYS. These are the three things it
 * must not cost: an element nobody declared for still reports what jsdom
 * reports, a declaration matching nothing changes nothing, and no declaration
 * outlives the test that made it. Without the last one every suite in the `dom`
 * project would inherit whatever width the file before it happened to state.
 */
/**
 * …and the harness underneath, which nothing else in the repo pins.
 *
 * `vitest.setup.dom.ts` is not under `src/`, so every case above is only as true
 * as the shim it rests on — and the two rules most easily simplified away
 * (visibility still gates `getClientRects`, and the LAST matching declaration
 * wins) are exactly the two the shell's own cases cannot distinguish: the resize
 * case re-declares the SAME key, and the shell declares nothing hidden. Each
 * case below fails a plausible rewrite of the shim.
 */
describe("the declared-rect harness itself", () => {
  function probe(): HTMLElement {
    render(<div className="probe" data-testid="probe" />);
    return screen.getByTestId("probe");
  }

  it("answers the declared box through all three reads", () => {
    setElementRect(".probe", { width: 640, height: 48, left: 12, top: 34 });
    const element = probe();

    const box = element.getBoundingClientRect();
    expect(box.width).toBe(640);
    expect(box.height).toBe(48);
    expect(box.left).toBe(12);
    expect(box.top).toBe(34);

    expect(element.offsetWidth).toBe(640);

    const rects = element.getClientRects();
    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBe(640);
    expect(rects[0].top).toBe(34);

    // `height` and `top` ride the RECT alone. There is no `offsetHeight` shim
    // and no caller for one, so a test that declares a height and then reads
    // the offset accessor gets jsdom's 0 — pinned here rather than left for a
    // reader to assume the symmetry that is not there.
    expect(element.offsetHeight).toBe(0);
  });

  it("leaves an undeclared element exactly as jsdom reports it", () => {
    const element = probe();
    expect(element.getBoundingClientRect().width).toBe(0);
    expect(element.offsetWidth).toBe(0);
    // The fixed 1x1 placeholder every suite written before this harness saw,
    // which is what the sheet's `getClientRects().length > 0` Tab filter reads.
    const rects = element.getClientRects();
    expect(rects).toHaveLength(1);
    expect(rects[0].width).toBe(1);
  });

  it("keeps a hidden element out of getClientRects even with a box declared", () => {
    // Visibility gates the LIST, not the rect — and letting a declared box win
    // over `displayHidden` would put the rail's hidden collapse chevron back
    // into the sheet's Tab cycle, which is the regression
    // `workbench-sheet.test.tsx` exists to catch. Both ways `displayHidden` can
    // actually see, since jsdom applies no stylesheet.
    setElementRect(".probe", { width: 640 });
    render(
      <>
        <div className="probe" data-testid="by-attribute" hidden />
        <div className="probe" data-testid="by-inline-style" style={{ display: "none" }} />
      </>,
    );
    for (const id of ["by-attribute", "by-inline-style"]) {
      const element = screen.getByTestId(id);
      expect(element.getClientRects()).toHaveLength(0);
      // …while the box itself is still the declared one: the two reads answer
      // different questions, and only one of them is about being on screen.
      expect(element.getBoundingClientRect().width).toBe(640);
    }
  });

  it("resolves two overlapping selectors to the LAST one declared", () => {
    // Order, not specificity: `.probe` is the narrower selector and wins here
    // only because it was declared second.
    setElementRect("div", { width: 100 });
    setElementRect(".probe", { width: 200 });
    expect(probe().getBoundingClientRect().width).toBe(200);
  });

  it("gives the opposite answer in the opposite order", () => {
    // The half that fails if `declaredRect` ever stops at the first match: the
    // broader selector was declared last, so the broader selector wins.
    setElementRect(".probe", { width: 200 });
    setElementRect("div", { width: 100 });
    expect(probe().getBoundingClientRect().width).toBe(100);
  });

  it("treats a re-declared selector as the newest statement, not the oldest", () => {
    // `Map.set` on an existing key keeps its ORIGINAL position, so without the
    // delete-then-set in `setElementRect` the stale `div` declaration would
    // still be last in iteration order and answer 300.
    setElementRect(".probe", { width: 100 });
    setElementRect("div", { width: 300 });
    setElementRect(".probe", { width: 200 });
    expect(probe().getBoundingClientRect().width).toBe(200);
  });

  it("hands out a copy, so a caller cannot rewrite the registry", () => {
    // `DOMRect`'s fields are writable and every matching element would otherwise
    // share one instance — a component that normalised a box in place would
    // silently change what the NEXT element measures.
    setElementRect(".probe", { width: 640 });
    const element = probe();
    const box = element.getBoundingClientRect();
    box.width = 1;
    expect(element.getBoundingClientRect().width).toBe(640);
  });

  it("ignores a declaration whose selector matches nothing", () => {
    // Inert by design, and the reason the harness has no equivalent of
    // `setMediaQuery`'s `observed` guard: `matches()` is asked per element per
    // call, so a selector that happens to match nothing in one case is not an
    // authoring mistake the registry could detect at declaration time.
    setElementRect(".nothing-matches-this", { width: 500 });
    const element = probe();
    expect(element.getBoundingClientRect().width).toBe(0);
    expect(element.offsetWidth).toBe(0);
    expect(element.getClientRects()[0].width).toBe(1);
  });

  it("refuses a selector the engine cannot parse, at declaration time", () => {
    // Left to `matches()`, this `SyntaxError` would surface from an unrelated
    // element's box read in the middle of a render, with nothing in the stack
    // pointing at the typo.
    expect(() => setElementRect(":::nope", { width: 100 })).toThrow(
      /valid CSS selector/,
    );
  });

  it("has forgotten every declaration the previous tests made", () => {
    // ORDER-DEPENDENT on purpose, and the only way to observe the reset: every
    // case above declares `.probe`, most of them at 640px. Drop
    // `resetElementRects()` from `vitest.setup.dom.ts`'s `afterEach` and this
    // reads one of those widths — the leak every other file in the `dom`
    // project would silently inherit.
    const element = probe();
    expect(element.getBoundingClientRect().width).toBe(0);
    expect(element.offsetWidth).toBe(0);
  });
});

describe("crossing the stacking breakpoint re-runs the tree's scroll memory (DW-47)", () => {
  /**
   * jsdom has no layout engine, so `treeBodyShowing`'s
   * `getClientRects().length > 0` answers true for every attached element and
   * the stylesheet's force-show rule is not what is under test here. What IS
   * under test is the only thing that changed: the `narrow` dependency. Without
   * it neither effect re-runs when the query moves, and both assertions below
   * fail while every source scan in `workbench-split.test.ts` still matches.
   */
  it("restores the stored offset when the viewport narrows, with no tab switch", async () => {
    // Through the accessor the component itself uses, so the fixture cannot
    // encode a shape the read path would reject. The offset restored on the way
    // in is the NARROW band's, because that is the layout being entered
    // (DW-206) — the wide band's own value is the case below.
    writeStoredTreeScroll("knowledge", "narrow", 120);
    // The DW-47 scenario exactly: collapsed on a desktop, then narrowed.
    writeStoredCollapsed(true);
    await renderShell();

    const panel = treeBody();
    // Somewhere else — standing in for the `scrollTop = 0` a browser hands back
    // when it shows a column it had been hiding.
    panel.scrollTop = 0;
    expect(panel.scrollTop).toBe(0);

    await act(async () => setMediaQuery(SPLIT_NARROW_QUERY, true));
    expect(panel.scrollTop).toBe(120);
  });

  it("restores the band's OWN offset across the breakpoint, either way (DW-206)", async () => {
    // The bug this replaces: one offset per tab shared across 900px. Crossing
    // into the narrow layout restored the DESKTOP offset, `globals.css`'s 40vh
    // cap made the browser clamp it, the clamp fired a `scroll`, and the persist
    // wrote the clamp back over the wide value — so widening again landed the
    // tree somewhere it had never been.
    writeStoredTreeScroll("knowledge", "wide", 900);
    writeStoredTreeScroll("knowledge", "narrow", 220);
    await renderShell();

    const panel = treeBody();
    expect(panel.scrollTop).toBe(900);

    await act(async () => setMediaQuery(SPLIT_NARROW_QUERY, true));
    // Its own range, not the desktop one the browser would have clamped.
    expect(panel.scrollTop).toBe(220);

    // …and a scroll recorded HERE is recorded in this band alone. Standing in
    // for that clamp: the narrow layout can hold nothing like 900.
    panel.scrollTop = 260;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(readStoredTreeScroll().knowledge).toEqual({ wide: 900, narrow: 260 });

    // Widening lands back on the offset the desktop layout actually held.
    await act(async () => setMediaQuery(SPLIT_NARROW_QUERY, false));
    expect(panel.scrollTop).toBe(900);
  });

  it("flushes an offset scrolled in the frame before a re-key (DW-208)", async () => {
    // The persist effect coalesced through `requestAnimationFrame` and its
    // cleanup CANCELLED the pending frame without flushing it — so a scroll in
    // the last frame before a tab switch, a collapse, a breakpoint crossing or a
    // Settings visit was simply lost, and the restore that followed re-applied a
    // one-frame-stale offset.
    //
    // No frame is allowed to run between the scroll and the re-key: the whole
    // point is the write the frame never got to make.
    await renderShell();
    const panel = treeBody();

    panel.scrollTop = 320;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      // The re-key, in the same act: `narrow` moves, so both effects tear down
      // and rebuild before any animation frame callback can fire.
      setMediaQuery(SPLIT_NARROW_QUERY, true);
    });

    // Written for the band the panel was IN when the scroll happened, from the
    // value captured at the event — not a `scrollTop` re-read from a panel React
    // has already committed over.
    expect(readStoredTreeScroll().knowledge.wide).toBe(320);
  });

  it("flushes the pending offset for the OLD tab when the tab switches (DW-208)", async () => {
    // The same lost write, reached by the transition it was first noticed on.
    // `tab` is in both effects' key, so a switch tears the persist effect down
    // between the `scroll` and the frame it queued — and the restore that runs
    // immediately after would otherwise re-apply a one-frame-stale offset the
    // next time the owner came back to this tab.
    await renderShell();
    const panel = treeBody();

    panel.scrollTop = 180;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      // The switch, in the same act: no animation frame callback can run
      // between the two, which is the whole premise.
      fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    });

    // Recorded against KNOWLEDGE, the tab the scroll happened on — not against
    // Files, and not dropped.
    expect(readStoredTreeScroll().knowledge.wide).toBe(180);
    expect(readStoredTreeScroll().files.wide).toBe(0);
  });

  it("flushes the pending offset when the panel is WITHDRAWN mid-frame (DW-208)", async () => {
    // The third transition into the same lost write: a Settings visit withdraws
    // the panel behind `hidden` between the `scroll` and the frame it queued.
    //
    // COVERAGE LIMIT, and it is the reason the value is captured at the scroll
    // event rather than re-read in the cleanup. In a browser React has already
    // committed `hidden` by the time the cleanup runs, so a `scrollTop` re-read
    // there answers 0 by the platform's own rules and the flush would faithfully
    // store the top of a tree the owner had scrolled down. jsdom has no layout
    // engine, so it keeps reporting 260 — verified: a cleanup that re-reads the
    // element passes this case. What this pins is that the write HAPPENS at all;
    // that it reads the right number is an argument the comment in `TreePanel`
    // makes, not one this environment can execute.
    await renderShell();
    const panel = treeBody();

    panel.scrollTop = 260;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      // Settings withdraws the whole left column's panel behind `hidden`.
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    });

    expect(document.querySelector(".wb-tree-panel")?.hasAttribute("hidden")).toBe(true);
    expect(readStoredTreeScroll().knowledge.wide).toBe(260);

    // Settings is closed again before this case ends: the shell keeps its open
    // state in the URL, and jsdom's `location` outlives `cleanup()` — a visit
    // left open here would mount the NEXT case with the tree panel already
    // withdrawn, and its persist assertions would fail for a reason that has
    // nothing to do with what it is testing.
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    });
    expect(document.querySelector(".wb-tree-panel")?.hasAttribute("hidden")).toBe(false);
  });

  it("leaves the persist side live on the force-shown tree", async () => {
    // The other half of the restore: an offset that comes back but is never
    // updated sends the owner to where they were two visits ago. Note what this
    // does NOT pin — with no layout engine the listener's attachment does not
    // depend on the transition at all, so this is the persist PATH surviving the
    // re-run, not the dependency. The dependency is the test above. Whether the
    // recording stops again on widening is a `display: none` question, and
    // `getClientRects()` answering for every attached element is exactly why
    // jsdom cannot be asked it.
    writeStoredTreeScroll("knowledge", "wide", 120);
    writeStoredCollapsed(true);
    await renderShell();
    const panel = treeBody();

    await act(async () => setMediaQuery(SPLIT_NARROW_QUERY, true));

    // A scroll on the force-shown tree is remembered, coalesced through one
    // animation frame.
    panel.scrollTop = 240;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    // In the NARROW band, which is the layout the tree is force-shown in here.
    expect(readStoredTreeScroll().knowledge.narrow).toBe(240);
  });
});

describe("a Settings visit gives the tree's scroll memory back too", () => {
  /**
   * The same shape as the DW-47 pair above, reached a third way.
   *
   * The panel survives a Settings visit MOUNTED now, behind `hidden` — which
   * means nothing unmounts and remounts to re-run the restore, and a browser
   * has meanwhile reset `scrollTop` to 0 on the way back in. So `hidden` has to
   * be in the effect's key. Without it the mounted suite stays entirely green
   * and the only thing left pinning the dependency is a dep-array regex in
   * `workbench-split.test.ts` — a scan that matches the shape of the fix rather
   * than its effect.
   */
  it("re-applies the stored offset when Settings hands the column back", async () => {
    writeStoredTreeScroll("knowledge", "wide", 120);
    await renderShell();
    const panel = treeBody();
    expect(panel.scrollTop).toBe(120);

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    await act(async () => {});
    // Withdrawn, not unmounted — the premise. A remount would restore the
    // offset by accident, and this case would pass with the dependency gone.
    expect(document.querySelector(".wb-tree-panel")?.hasAttribute("hidden")).toBe(true);
    expect(treeBody()).toBe(panel);

    // Standing in for the `scrollTop = 0` a browser hands back when it shows an
    // element it had been hiding, exactly as the DW-47 case above does: jsdom
    // has no layout engine, so nothing here resets it on its own.
    panel.scrollTop = 0;

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    await act(async () => {});

    expect(document.querySelector(".wb-tree-panel")?.hasAttribute("hidden")).toBe(false);
    expect(panel.scrollTop).toBe(120);
  });

  it("leaves the persist side live on the panel Settings gave back", async () => {
    // The other half, and the reason the persist effect takes the same key: any
    // tab, collapse or width change DURING the visit re-runs it against a panel
    // with no client rects, so it attaches nothing — and without `hidden` it
    // never runs again, leaving the tree unable to remember its offset for the
    // rest of the session.
    writeStoredTreeScroll("knowledge", "wide", 120);
    await renderShell();
    const panel = treeBody();

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    await act(async () => {});

    panel.scrollTop = 240;
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
      await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
    });
    expect(readStoredTreeScroll().knowledge.wide).toBe(240);
  });
});

/**
 * …and the separator itself, rendered directly.
 *
 * The shell mounts one above, at a declared width — but `SplitHandle` needs no
 * shell at all: it takes no geometry, reads no context and holds no state, so
 * literal props are a faithful mount, and the press below needs no width to be
 * declared for it to be true. That matters because both of DW-44's and
 * DW-45's control-side claims were otherwise pinned only as source text in
 * `workbench-split.test.ts` — `aria-controls={controls}` and `onStart(event.
 * clientX)` are strings to a `toContain`, and neither scan can tell whether React
 * emits the attribute or whether the press's x survives the handler. These two
 * execute the component.
 */
describe("the separator control itself (DW-44/45)", () => {
  // jsdom 30 ships no pointer-capture methods at all (not even as no-ops), and
  // the handler calls `setPointerCapture` before it forwards the press. Stubbed
  // here rather than in `vitest.setup.dom.ts` because this is the only suite
  // that presses a separator, and a global stub would quietly hand every other
  // suite a capture API the browser's own bookkeeping does not match.
  const CAPTURE = ["setPointerCapture", "hasPointerCapture", "releasePointerCapture"] as const;
  beforeAll(() => {
    for (const method of CAPTURE) {
      (Element.prototype as unknown as Record<string, unknown>)[method] = () => true;
    }
  });
  afterAll(() => {
    for (const method of CAPTURE) {
      delete (Element.prototype as unknown as Record<string, unknown>)[method];
    }
  });

  const PROPS = {
    id: "tree" as const,
    label: "Resize the left column",
    value: 280,
    min: 200,
    max: 900,
    controls: "some-panel-id",
    onStart: () => {},
    onMove: () => {},
    onEnd: () => {},
    onKey: () => false,
  };

  it("emits aria-controls naming the pane it resizes", () => {
    render(<SplitHandle {...PROPS} />);
    const separator = screen.getByRole("separator", { name: PROPS.label });
    // The ATTRIBUTE, off the rendered node — the scan in `workbench-split.test.
    // ts` matches the JSX text and would stay green for an attribute React never
    // emits, or one moved onto a wrapper the accessibility tree does not reach.
    expect(separator.getAttribute("aria-controls")).toBe(PROPS.controls);
    // The axis, for the same reason: `separator`'s ARIA default is HORIZONTAL,
    // so a dropped orientation announces a vertical resize as a horizontal one
    // while `aria-valuenow` keeps describing width.
    expect(separator.getAttribute("aria-orientation")).toBe("vertical");
  });

  it("hands the press's viewport x to the shell (DW-44)", () => {
    const onStart = vi.fn();
    render(<SplitHandle {...PROPS} onStart={onStart} />);
    const separator = screen.getByRole("separator", { name: PROPS.label });
    // `isPrimary` explicitly: jsdom leaves it `false` by default, and
    // `isPrimarySplitPress` requires it — a real mouse or first touch always
    // reports `true`, and the flag is what keeps a second finger mid-pinch from
    // starting a drag. jsdom implements pointer capture as bookkeeping only,
    // which is all the handler asks of it.
    fireEvent.pointerDown(separator, {
      button: 0,
      isPrimary: true,
      pointerId: 1,
      clientX: 137,
    });
    // Not `toHaveBeenCalled` — the WHOLE point of the DW-44 signature change is
    // that the x arrives. `onStart()` with no argument passes every source scan
    // in `workbench-split.test.ts` and leaves `grabRef` at 0, which is the
    // 24px-snap-on-first-move regression the grab offset exists to prevent.
    expect(onStart).toHaveBeenCalledWith(137);
  });

  it("ignores a secondary press, so no grab is measured for it", () => {
    const onStart = vi.fn();
    render(<SplitHandle {...PROPS} onStart={onStart} />);
    const separator = screen.getByRole("separator", { name: PROPS.label });
    fireEvent.pointerDown(separator, {
      button: 2,
      isPrimary: true,
      pointerId: 1,
      clientX: 137,
    });
    expect(onStart).not.toHaveBeenCalled();
  });
});
