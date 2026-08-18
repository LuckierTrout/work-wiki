import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { SplitHandle } from "@/components/workbench/SplitHandle";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { SPLIT_NARROW_QUERY } from "@/lib/workbench-split";
import { buildFileTree } from "@/lib/workbench-tree";
import {
  readStoredTreeScroll,
  writeStoredCollapsed,
  writeStoredSelection,
  writeStoredTreeScroll,
} from "@/lib/workbench-state";
import { setMediaQuery } from "../../../../vitest.setup.dom";

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
 * COVERAGE LIMIT: the separators are not observable THROUGH THE SHELL here.
 * `Workbench` measures `getBoundingClientRect()` to decide whether it has been
 * measured at all, jsdom answers 0 for every box, so `showSplitHandle` is false
 * and neither `<SplitHandle>` mounts. That is why the IDS are the half worth
 * pinning against the mounted shell: what the separator names has to exist, and
 * whether the separator is on screen is a layout question this environment
 * cannot answer. The control's OWN half — the attribute it emits and the x it
 * forwards — is executed at the bottom of this file, rendered directly, where no
 * measurement is involved.
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
    // encode a shape the read path would reject.
    writeStoredTreeScroll("knowledge", 120);
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

  it("leaves the persist side live on the force-shown tree", async () => {
    // The other half of the restore: an offset that comes back but is never
    // updated sends the owner to where they were two visits ago. Note what this
    // does NOT pin — with no layout engine the listener's attachment does not
    // depend on the transition at all, so this is the persist PATH surviving the
    // re-run, not the dependency. The dependency is the test above. Whether the
    // recording stops again on widening is a `display: none` question, and
    // `getClientRects()` answering for every attached element is exactly why
    // jsdom cannot be asked it.
    writeStoredTreeScroll("knowledge", 120);
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
    expect(readStoredTreeScroll().knowledge).toBe(240);
  });
});

/**
 * …and the separator itself, rendered directly.
 *
 * The shell cannot mount one here (see COVERAGE LIMIT above), but `SplitHandle`
 * needs no shell: it takes no geometry, reads no context and holds no state, so
 * literal props are a faithful mount. That matters because both of DW-44's and
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
