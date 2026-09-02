import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { PreviewColumn } from "@/components/workbench/PreviewColumn";
import { SourcesTree } from "@/components/workbench/SourcesTree";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { SETTINGS_LABEL } from "@/lib/workbench-settings";
import { SPLIT_NARROW_QUERY } from "@/lib/workbench-split";
import {
  WORKBENCH_SOURCES_SCROLL_KEY,
  readStoredSourcesScroll,
  writeStoredSourcesScroll,
} from "@/lib/workbench-state";
import {
  SOURCES_WINDOW_INITIAL,
  SOURCES_WINDOW_STEP,
  buildFileTree,
} from "@/lib/workbench-tree";
import type { WikiRecord } from "@/lib/wikis";
import { setMediaQuery } from "@/test/dom-helpers";

/**
 * The two scroll surfaces the DW-206/208/416/521/524 pass left out, MOUNTED.
 *
 * Neither `SourcesTree` nor `PreviewColumn` had a single mounted case for its
 * scroll memory before this file, which is the reason both were left behind in
 * the first place: `SourcesTree`'s persist effect could be DELETED OUTRIGHT and
 * every suite in the repo would stay green, and `PreviewColumn` had no effect to
 * delete at all. Source scans cannot stand in here — the offset a restore
 * assigns, the event a cleanup flushes and the echo a clamp dispatches are all
 * facts about a live DOM node.
 *
 * WHY THE TWO HALVES REMEMBER DIFFERENTLY. `Workbench` renders `SourcesTree` as
 * `mode === "sources" && …` inside a `settingsOpen ? null : …` branch, so a mode
 * switch AND a Settings visit both genuinely UNMOUNT it — its memory has to
 * outlive the component, which is what puts it in localStorage and what makes
 * the flushing cleanup the whole of DW-519's second half. `PreviewColumn`
 * survives the same visit MOUNTED (DW-412, so its unsaved draft survives), so
 * its two offsets live in REFS: DW-520's scope is the visit, not FR-8, and no
 * localStorage key is invented for them.
 *
 * COVERAGE LIMIT, inherited from every mounted scroll case in this directory:
 * jsdom runs no layout engine, so `scrollTop` never moves on its own. The
 * browser's own `scrollTop = 0` on a `display: none` box and the clamp it
 * applies to an assignment past a box's maximum are both DECLARED here — the
 * `Object.defineProperty` stand-in `workbench-split-wiring.test.tsx` and
 * `settings-canvas-persistence.test.tsx` already use. What that buys is the
 * component's REACTION to those facts, and nothing more.
 */

// ONE stable router object, the shell-mounting idiom this directory uses: several
// components key effects on the router identity, and a fresh literal per call
// would rebuild them on every re-render.
const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

/** Two leaves under `raw/sources/` — enough for `.wb-sources-tree` to render. */
const SOURCE_FILES = buildFileTree([
  "raw/sources/alpha.md",
  "raw/sources/beta.md",
]);

const WIKI: WikiRecord = {
  id: "wiki-1",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/** A working set with a row the Preview can dock against. */
const TREE_DATA: WorkbenchData = {
  wikis: [WIKI],
  currentWikiId: WIKI.id,
  registryUnavailable: false,
  knowledge: [
    {
      id: "note",
      label: "Note",
      count: 2,
      pages: [
        { slug: "alpha", title: "Alpha", type: "note" },
        { slug: "beta", title: "Beta", type: "note" },
      ],
    },
  ],
  knowledgeUnavailable: false,
  files: [],
  filesUnavailable: false,
  filesTruncated: false,
  dataVersion: 0,
  readOnly: false,
};

/** The same working set with Sources on it, for the mode-switch cases. */
const SOURCES_DATA: WorkbenchData = { ...TREE_DATA, files: SOURCE_FILES };

/** What `/api/workbench/preview` answers for the row these cases pick. */
const PREVIEW_PAYLOAD = {
  name: "Alpha",
  path: "wiki/alpha.md",
  slug: "alpha",
  format: "markdown" as const,
  body: "# Alpha",
  truncated: false,
  editable: true,
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  window.localStorage.clear();
  // jsdom's session history outlives `cleanup()`, and the shell mirrors its mode
  // into `?mode=` — so each case starts on a bare `/` rather than on whatever
  // mode the last one left in the URL.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/workbench/preview")
      ? ({ ok: true, status: 200, json: async () => PREVIEW_PAYLOAD } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
});

/** Let a pending `requestAnimationFrame` callback run. */
async function flushFrame() {
  await act(async () => {
    await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
  });
}

// ---------------------------------------------------------------------------
// DW-519 — the Sources tree
// ---------------------------------------------------------------------------

/**
 * The component alone, which is how `Workbench` treats it: a mode switch or a
 * Settings visit destroys this subtree, so nothing about the surrounding shell
 * is part of what these cases are about.
 */
function tree(overrides: Partial<ComponentProps<typeof SourcesTree>> = {}) {
  return (
    <SourcesTree
      files={SOURCE_FILES}
      hasWiki
      selection={null}
      onSelect={() => {}}
      {...overrides}
    />
  );
}

function renderTree(
  overrides: Partial<ComponentProps<typeof SourcesTree>> = {},
) {
  return render(tree(overrides));
}

function sourcesPanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wb-sources-tree");
}

function sourcesBody(): HTMLElement {
  const node = document.querySelector<HTMLElement>(".wb-sources-tree");
  if (!node) throw new Error(".wb-sources-tree is not rendered");
  return node;
}

/** Scroll the panel and hand the browser's `scroll` event to the component. */
async function scrollSources(panel: HTMLElement, offset: number) {
  panel.scrollTop = offset;
  await act(async () => {
    panel.dispatchEvent(new Event("scroll"));
  });
}

describe("SourcesTree scroll memory (DW-519)", () => {
  it("flushes the offset captured in the frame before the unmount", async () => {
    // The named defect. The persist effect coalesces through
    // `requestAnimationFrame`, and its cleanup used to cancel a pending frame
    // WITHOUT writing what it was going to write — so a scroll in the last frame
    // before the mode switch or the Settings visit that unmounts this component
    // was simply lost. The offset is captured at the scroll EVENT, which is what
    // lets the cleanup flush it: a node on its way out cannot be read.
    const view = renderTree();
    const panel = sourcesBody();

    await act(async () => {
      panel.scrollTop = 240;
      panel.dispatchEvent(new Event("scroll"));
      // No frame between the event and the unmount — the whole point.
      view.unmount();
    });

    expect(readStoredSourcesScroll().wide).toBe(240);
  });

  it("flushes nothing when no scroll is pending", () => {
    // The other side of the same cleanup: an unmount that follows no scroll must
    // not invent a write. A cleanup that flushed unconditionally would store the
    // `-1` sentinel — or a 0 nobody chose — over the offset the owner left in a
    // previous session.
    const view = renderTree();
    view.unmount();
    expect(window.localStorage.getItem(WORKBENCH_SOURCES_SCROLL_KEY)).toBeNull();
  });

  it("gives each side of the 900px breakpoint its own offset", async () => {
    // DW-206's argument, on DW-519's surface. `.wb-sources-tree` has two scroll
    // RANGES, not one, and a single stored number restored into the other is
    // CLAMPED by the browser — the clamp fires a `scroll`, the persist writes it
    // back, and one crossing destroys the desktop offset.
    writeStoredSourcesScroll("wide", 300);
    writeStoredSourcesScroll("narrow", 40);
    renderTree();
    const panel = sourcesBody();
    expect(panel.scrollTop).toBe(300);

    await act(async () => {
      setMediaQuery(SPLIT_NARROW_QUERY, true);
    });
    expect(panel.scrollTop).toBe(40);

    // …and a scroll recorded THERE cannot reach the wide band.
    await scrollSources(panel, 90);
    await flushFrame();
    expect(readStoredSourcesScroll()).toEqual({ wide: 300, narrow: 90 });

    // Back across, and the desktop offset is exactly where it was left.
    await act(async () => {
      setMediaQuery(SPLIT_NARROW_QUERY, false);
    });
    expect(panel.scrollTop).toBe(300);
  });

  it("migrates a pre-DW-519 bare number into the wide band", async () => {
    // Every build before this one wrote a bare integer STRING under this key.
    // Read as the WIDE band's offset — the range only the desktop layout has,
    // and the one it was almost certainly recorded in — while the narrow band
    // starts at the top rather than inheriting a range it does not share.
    window.localStorage.setItem(WORKBENCH_SOURCES_SCROLL_KEY, "120");
    expect(readStoredSourcesScroll()).toEqual({ wide: 120, narrow: 0 });

    renderTree();
    const panel = sourcesBody();
    expect(panel.scrollTop).toBe(120);

    // The first write NORMALISES the key rather than leaving the next read to
    // keep migrating it.
    await scrollSources(panel, 200);
    await flushFrame();
    expect(
      JSON.parse(window.localStorage.getItem(WORKBENCH_SOURCES_SCROLL_KEY) ?? "null"),
    ).toEqual({ wide: 200, narrow: 0 });
  });

  it("degrades any other stored value to zeros", () => {
    window.localStorage.setItem(WORKBENCH_SOURCES_SCROLL_KEY, "not-json");
    expect(readStoredSourcesScroll()).toEqual({ wide: 0, narrow: 0 });

    window.localStorage.setItem(WORKBENCH_SOURCES_SCROLL_KEY, JSON.stringify([12]));
    expect(readStoredSourcesScroll()).toEqual({ wide: 0, narrow: 0 });

    window.localStorage.setItem(
      WORKBENCH_SOURCES_SCROLL_KEY,
      JSON.stringify({ wide: -4, narrow: "40" }),
    );
    expect(readStoredSourcesScroll()).toEqual({ wide: 0, narrow: 0 });
  });

  it("does not write the browser's clamp back over the stored offset (DW-521)", async () => {
    // The restore ASSIGNS an offset; the browser CLAMPS it to what the box can
    // currently reach and dispatches a `scroll` for the assignment at the next
    // rendering update — after the listener is attached. Recorded, that echo
    // replaces the offset the owner left with the maximum of a tree whose rows
    // have not all been windowed in yet.
    writeStoredSourcesScroll("wide", 900);
    renderTree();
    const panel = sourcesBody();

    // A SHORTER BOX, stated rather than laid out.
    let value = 0;
    Object.defineProperty(panel, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = Math.min(next, 200);
      },
    });

    // Re-key the restore the way a breakpoint crossing does — out and back.
    await act(async () => {
      setMediaQuery(SPLIT_NARROW_QUERY, true);
    });
    await act(async () => {
      setMediaQuery(SPLIT_NARROW_QUERY, false);
    });

    // The pixels went where the box allows…
    expect(panel.scrollTop).toBe(200);

    // …and the echo the browser dispatches for that assignment is DROPPED, so
    // the stored offset survives to the visit that can reach it.
    await act(async () => {
      panel.dispatchEvent(new Event("scroll"));
    });
    await flushFrame();
    expect(readStoredSourcesScroll().wide).toBe(900);

    // The arm is spent, so the owner's next GENUINE scroll is recorded exactly
    // as it was before any of this — a suppression that latched would leave the
    // tree unable to remember its offset for the rest of the session.
    Reflect.deleteProperty(panel, "scrollTop");
    await scrollSources(panel, 150);
    await flushFrame();
    expect(readStoredSourcesScroll().wide).toBe(150);
  });

  it("restores once the panel EXISTS, not only on the commit that mounted it", async () => {
    // The ordinary path. `.wb-sources-tree` is not rendered at all until the
    // shell has files, so the restore's first run finds `bodyRef.current` null —
    // and the commit that grows a panel moves neither `band` nor anything else
    // the effect would otherwise watch. Without the panel's existence in the
    // key the offset is never applied, while the persist side recovers on
    // `leafCount` and goes on RECORDING one: the tree remembers and never
    // returns.
    writeStoredSourcesScroll("wide", 300);
    const view = render(tree({ files: [] }));
    expect(sourcesPanel()).toBeNull();

    view.rerender(tree({ files: SOURCE_FILES }));
    expect(sourcesBody().scrollTop).toBe(300);
  });

  it("attaches the persist side to a panel a late `hasWiki` brought on screen", async () => {
    // The half `leafCount` cannot cover: the tree is derived from `files` alone,
    // so a Wiki arriving does not move it. With only `[leafCount, band]` in the
    // key the listener is never attached to the panel that just appeared, and
    // the tree cannot remember its offset for the rest of the session.
    writeStoredSourcesScroll("wide", 40);
    const view = render(tree({ hasWiki: false }));
    expect(sourcesPanel()).toBeNull();

    view.rerender(tree({ hasWiki: true }));
    const panel = sourcesBody();
    expect(panel.scrollTop).toBe(40);

    await scrollSources(panel, 210);
    await flushFrame();
    expect(readStoredSourcesScroll().wide).toBe(210);
  });

  it("still grows the window when the restored offset lands at the bottom", async () => {
    // The echo suppresses the WRITE, not the POSITION. A restore that lands at
    // the bottom of the current window fires exactly one `scroll` — its own echo
    // — and if that event returns before the growth check the list refuses to
    // continue until the owner scrolls away and back. The other growth effect
    // cannot cover it: that one only fires while the panel does NOT overflow.
    const many = buildFileTree(
      Array.from({ length: 200 }, (_, i) => `raw/sources/f${String(i).padStart(3, "0")}.md`),
    );
    // DECLARED metrics: jsdom runs no layout, so both read 0 and every scroll
    // would look like the bottom — including the ones that must not grow
    // anything. `configurable`, and removed again below, so nothing else in the
    // run inherits them.
    Object.defineProperty(HTMLElement.prototype, "clientHeight", {
      configurable: true,
      get: () => 100,
    });
    Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get: () => 1000,
    });
    try {
      // 900 + 100 >= 1000 - 48: at the bottom of what is rendered.
      writeStoredSourcesScroll("wide", 900);
      renderTree({ files: many });
      const panel = sourcesBody();
      expect(panel.scrollTop).toBe(900);
      expect(document.querySelectorAll(".wb-tree-row")).toHaveLength(
        SOURCES_WINDOW_INITIAL,
      );

      // The browser's own `scroll` for the restore's assignment — the echo.
      await act(async () => {
        panel.dispatchEvent(new Event("scroll"));
      });
      expect(document.querySelectorAll(".wb-tree-row")).toHaveLength(
        SOURCES_WINDOW_INITIAL + SOURCES_WINDOW_STEP,
      );

      // …and it is still an echo: the offset was not re-recorded.
      await flushFrame();
      expect(readStoredSourcesScroll().wide).toBe(900);
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, "clientHeight");
      Reflect.deleteProperty(HTMLElement.prototype, "scrollHeight");
    }
  });

  it("flushes the offset on the unmount a Settings visit actually causes", async () => {
    // DW-519's whole justification, driven through the real shell rather than
    // through `view.unmount()`: `Workbench` renders this component as
    // `mode === "sources" && …` inside a `settingsOpen ? null : …` branch, so
    // opening Settings genuinely DESTROYS it. The scroll and the visit land in
    // one act with no frame between them, which is the frame the old cleanup
    // threw away.
    await renderShell(SOURCES_DATA);
    const rail = within(document.querySelector(".wb-rail") as HTMLElement);
    fireEvent.click(rail.getByRole("button", { name: "Sources" }));
    await act(async () => {});

    const panel = sourcesPanel() as HTMLElement;
    expect(panel).not.toBeNull();

    await act(async () => {
      panel.scrollTop = 260;
      panel.dispatchEvent(new Event("scroll"));
      fireEvent.click(rail.getByRole("button", { name: SETTINGS_LABEL }));
    });

    // Destroyed, not withdrawn — which is why the memory has to be in storage.
    expect(sourcesPanel()).toBeNull();
    expect(readStoredSourcesScroll().wide).toBe(260);
  });

  it("records the owner's scroll after a restore that moved nothing", async () => {
    // The case a boolean latch gets wrong: the arm outlives a restore that fires
    // no `scroll` at all, and a latch would still be set when the owner's next
    // genuine scroll arrived and would swallow it. Comparing against the VALUE
    // makes the stale arm harmless.
    writeStoredSourcesScroll("wide", 120);
    renderTree();
    const panel = sourcesBody();
    expect(panel.scrollTop).toBe(120);

    await scrollSources(panel, 260);
    await flushFrame();
    expect(readStoredSourcesScroll().wide).toBe(260);
  });
});

// ---------------------------------------------------------------------------
// DW-520 — the Preview column's two scroll boxes
// ---------------------------------------------------------------------------

/**
 * The assembled shell, as `page.tsx` composes it — the Settings round trip is a
 * shell transition, so the column has to be reached through it.
 */
async function renderShell(data: WorkbenchData = TREE_DATA) {
  const view = render(
    <KeyboardShortcutsProvider>
      <WorkbenchDataProvider value={data}>
        <Workbench>
          <WikiWorkbench />
        </Workbench>
      </WorkbenchDataProvider>
    </KeyboardShortcutsProvider>,
  );
  await act(async () => {});
  return view;
}

/**
 * Both boxes, read from the DOM rather than the a11y tree: a query that
 * respected `hidden` could not tell "withdrawn" apart from "unmounted", which is
 * the distinction these cases turn on.
 */
function previewColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wb-preview");
}

function previewBody(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wb-preview-body");
}

async function toggleSettings() {
  fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
  await act(async () => {});
}

describe("PreviewColumn scroll memory (DW-520)", () => {
  it("brings both boxes back where the owner left them across a Settings visit", async () => {
    // `.wb-preview` and `.wb-preview-body` are BOTH `overflow: auto`, and
    // `.wb-preview[hidden] { display: none }` discards a scroll box — so the
    // visit DW-416 made free for the canvas still dropped the owner at the top
    // of both of these.
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});

    const aside = previewColumn() as HTMLElement;
    const body = previewBody() as HTMLElement;
    expect(aside).not.toBeNull();
    expect(body).not.toBeNull();

    aside.scrollTop = 150;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });
    body.scrollTop = 320;
    await act(async () => {
      body.dispatchEvent(new Event("scroll"));
    });

    await toggleSettings();
    expect(aside.hasAttribute("hidden")).toBe(true);
    // Standing in for the browser's own reset on a `display: none` box.
    aside.scrollTop = 0;
    body.scrollTop = 0;

    await toggleSettings();

    // The SAME two nodes — withdrawn, not rebuilt — at the same two offsets.
    expect(previewColumn()).toBe(aside);
    expect(previewBody()).toBe(body);
    expect(aside.hasAttribute("hidden")).toBe(false);
    expect(aside.scrollTop).toBe(150);
    expect(body.scrollTop).toBe(320);

    // In REFS, not in storage: DW-520's scope is the visit, not FR-8's
    // cross-session restore, so the round trip invents no key.
    expect(
      Object.keys(window.localStorage).filter((key) =>
        key.toLowerCase().includes("preview"),
      ),
    ).toEqual([]);

    // …and the memory keeps tracking: a scroll after the visit REPLACES it,
    // rather than the first offset latching for the rest of the session.
    aside.scrollTop = 20;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });
    body.scrollTop = 60;
    await act(async () => {
      body.dispatchEvent(new Event("scroll"));
    });
    await toggleSettings();
    aside.scrollTop = 0;
    body.scrollTop = 0;
    await toggleSettings();
    expect(aside.scrollTop).toBe(20);
    expect(body.scrollTop).toBe(60);
  });

  it("records a body that rendered after the restore effect ran", async () => {
    // `scroll` does NOT bubble, so the persist side is one CAPTURE-phase
    // listener on the stable `<aside>` rather than one listener per box: the
    // column mounts loading, with no `.wb-preview-body` in the tree at all, and
    // the body div appears only when the payload lands. A per-element listener
    // attached in the `[hidden]`-keyed effect would never see that node.
    await renderShell();

    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    // Committed, effects run — and the read has not resolved, so there is no
    // body box for the effect to have found.
    expect(previewColumn()).not.toBeNull();
    expect(previewBody()).toBeNull();

    await act(async () => {});
    const aside = previewColumn() as HTMLElement;
    const body = previewBody() as HTMLElement;
    expect(body).not.toBeNull();

    body.scrollTop = 275;
    await act(async () => {
      body.dispatchEvent(new Event("scroll"));
    });

    await toggleSettings();
    body.scrollTop = 0;
    await toggleSettings();

    expect(previewBody()).toBe(body);
    expect(body.scrollTop).toBe(275);
    // The `<aside>` was never scrolled, so nothing was recorded for it and
    // nothing is assigned to it.
    expect(aside.scrollTop).toBe(0);
  });

  it("does not write the browser's clamp back over a box's offset (DW-521)", async () => {
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});
    const aside = previewColumn() as HTMLElement;

    aside.scrollTop = 300;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });

    await toggleSettings();

    // A SHORTER BOX, stated rather than laid out. It starts at 0, which is the
    // browser's own reset.
    let value = 0;
    Object.defineProperty(aside, "scrollTop", {
      configurable: true,
      get: () => value,
      set: (next: number) => {
        value = Math.min(next, 200);
      },
    });

    await toggleSettings();
    expect(aside.scrollTop).toBe(200);
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });

    // The content finishes filling in and the box can reach the offset again.
    await toggleSettings();
    Reflect.deleteProperty(aside, "scrollTop");
    aside.scrollTop = 0;
    await toggleSettings();
    // The owner's OWN offset, not the clamp that briefly stood in for it.
    expect(aside.scrollTop).toBe(300);

    // …and the arm is spent, so a genuine scroll after the restore is recorded
    // exactly as it was before any of this.
    aside.scrollTop = 80;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });
    await toggleSettings();
    aside.scrollTop = 0;
    await toggleSettings();
    expect(aside.scrollTop).toBe(80);
  });

  it("does not hand a new row the offsets of the one before it", async () => {
    // `PreviewColumn` renders `PreviewPane` with NO key, so picking another row
    // keeps the same instance — and the restore runs on `hidden` alone. Without
    // clearing the offsets when the pick changes, a row the owner never scrolled
    // is dragged to wherever they left the row before it on the next Settings
    // round trip.
    await renderShell();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});

    const aside = previewColumn() as HTMLElement;
    const bodyA = previewBody() as HTMLElement;
    aside.scrollTop = 190;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });
    bodyA.scrollTop = 280;
    await act(async () => {
      bodyA.dispatchEvent(new Event("scroll"));
    });

    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await act(async () => {});
    const bodyB = previewBody() as HTMLElement;
    expect(bodyB).not.toBeNull();

    await toggleSettings();
    // The browser's own reset on both boxes.
    aside.scrollTop = 0;
    bodyB.scrollTop = 0;
    await toggleSettings();

    // Nothing recorded for THIS row, so nothing assigned to it.
    expect(aside.scrollTop).toBe(0);
    expect(bodyB.scrollTop).toBe(0);
  });

  it("restores nothing when the body branch is not rendered on return", async () => {
    // `.wb-preview-body` exists only on the text branch of `body()`. A row that
    // comes back 404 — or as media, or unreadable — replaces it, so the restore
    // finds no node: it must assign nothing and throw nothing, and the box that
    // does come back starts at the top.
    const base = {
      selection: { kind: "page", slug: "alpha" } as const,
      knowledge: [],
      files: [],
      onOpenPage: () => {},
      onDirtyChange: () => {},
      id: "wb-preview",
    };
    const view = render(<PreviewColumn {...base} dataVersion={0} />);
    await act(async () => {});

    const aside = previewColumn() as HTMLElement;
    const body = previewBody() as HTMLElement;
    expect(body).not.toBeNull();
    body.scrollTop = 275;
    await act(async () => {
      body.dispatchEvent(new Event("scroll"));
    });

    // The row is gone on the next read, and the 404 sentence REPLACES the body.
    fetchMock.mockImplementation(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as unknown as Response,
    );
    view.rerender(<PreviewColumn {...base} dataVersion={1} />);
    await act(async () => {});
    expect(previewBody()).toBeNull();

    // A withdrawal and a return with nothing to restore.
    view.rerender(<PreviewColumn {...base} dataVersion={1} hidden />);
    await act(async () => {});
    view.rerender(<PreviewColumn {...base} dataVersion={1} />);
    await act(async () => {});

    expect(previewBody()).toBeNull();
    // The `<aside>` was never scrolled either, so it is left where it was.
    expect(aside.scrollTop).toBe(0);
  });

  it("assigns nothing to a column that mounted already withdrawn", async () => {
    // Nothing recorded means nothing assigned: the box starts where the browser
    // left it rather than being dragged to a 0 nobody chose. Rendered directly
    // because the shell only docks this column for a row the owner picked, and
    // picking one is not reachable while Settings is showing.
    const props = {
      selection: { kind: "page", slug: "alpha" } as const,
      knowledge: [],
      files: [],
      onOpenPage: () => {},
      dataVersion: 0,
      onDirtyChange: () => {},
      id: "wb-preview",
    };
    const view = render(<PreviewColumn {...props} hidden />);
    await act(async () => {});

    const aside = previewColumn() as HTMLElement;
    expect(aside.hasAttribute("hidden")).toBe(true);
    // Where the browser happens to have left it.
    aside.scrollTop = 64;

    view.rerender(<PreviewColumn {...props} hidden={false} />);
    await act(async () => {});
    expect(previewColumn()).toBe(aside);
    expect(aside.scrollTop).toBe(64);
    expect(window.localStorage.length).toBe(0);

    // …and the FIRST restore happens once it has been on screen: the offset it
    // is scrolled to now is the one the next withdrawal hands back.
    aside.scrollTop = 130;
    await act(async () => {
      aside.dispatchEvent(new Event("scroll"));
    });
    view.rerender(<PreviewColumn {...props} hidden />);
    await act(async () => {});
    aside.scrollTop = 0;
    view.rerender(<PreviewColumn {...props} hidden={false} />);
    await act(async () => {});
    expect(aside.scrollTop).toBe(130);
  });
});
