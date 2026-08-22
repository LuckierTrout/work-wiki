import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { SPLIT_WIDE_QUERY } from "@/lib/workbench-split";
import {
  PREVIEW_CLOSED_COPY,
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_EDIT_CONFIRM_TITLE,
  PREVIEW_EDIT_COPY,
  PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE,
  PREVIEW_FAILED_COPY,
  PREVIEW_REMOVED_COPY,
  PREVIEW_RETRY_COPY,
  PREVIEW_RETRYING_COPY,
  PREVIEW_STALE_ANNOUNCEMENT_COPY,
  PREVIEW_UNREACHABLE_COPY,
  PREVIEW_UPDATED_COPY,
  previewDockAnnouncement,
} from "@/lib/workbench-preview";
import { LIVE_REGION_REPEAT_MARK, announcementSentence } from "@/lib/live-region";
import { buildFileTree } from "@/lib/workbench-tree";
import { writeStoredSelection } from "@/lib/workbench-state";
import { setMediaQuery } from "../../../../vitest.setup.dom";

/**
 * DW-34, DW-50, DW-53 and DW-54 — everything the docked Preview does WITHOUT
 * being asked, observed on a mounted shell.
 *
 * These four are one suite because they are one failure: the Preview changes
 * what it is showing and does not say so. It docks and undocks silently, swaps
 * a body underneath a reader silently, keeps a selection alive after the row
 * has left the tree, and reports a dropped packet as a deleted page. Every
 * DECISION behind them is a pure function with its own node-project test
 * (`workbench-preview.test.ts`, `workbench-tree.test.ts`); what only a mounted
 * tree can show is that the shell and the column actually ASK, at the moment
 * the change happens, and that the sentence lands in a region a screen reader
 * is listening to.
 *
 * COVERAGE LIMIT: jsdom has no layout engine, so "the column is now on screen"
 * is not observable here — the narrow-width case pins that the shell asks the
 * platform to scroll, and `globals.css` is what leaves it somewhere to scroll
 * to. That half is a rule in the stylesheet, argued in its own comment.
 */

// ONE stable router object, for the reason `workbench-mode-url.test.tsx` gives:
// several components key effects on the router identity. Nothing under test
// calls it — `DataVersionWatcher` owns the only refresh in the shell.
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

/** The Files tab's rows, for the layout-change cases. */
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

/** What the route answers for a readable page. */
function payload(name: string, body: string) {
  return {
    name,
    path: `wiki/${name.toLowerCase()}.md`,
    slug: name.toLowerCase(),
    format: "markdown" as const,
    body,
    truncated: false,
    editable: true,
  };
}

/**
 * …and what it answers for the Wiki's Schema (Story 1.8), which is editable and
 * is NOT a page: no `slug`, an `artifact` instead, and its own confirm copy.
 *
 * Handed back for whatever row the test picked — the stub answers by fixture,
 * not by URL, and every derivation under test reads the PAYLOAD rather than the
 * selection. That is enough to put the Schema's gate on screen, which is the
 * only thing these cases need it for.
 */
function schemaPayload() {
  return {
    name: "schema.md",
    path: "schema.md",
    artifact: "schema.md" as const,
    format: "markdown" as const,
    body: "# Schema",
    truncated: false,
    editable: true,
  };
}

/**
 * What the next preview read should do. Reassigned per test rather than
 * re-stubbed, so a rerender that triggers a second read picks up the new
 * behaviour without the fixture having to know when the read happens.
 */
let answer: () => unknown = () => ({
  ok: true,
  status: 200,
  json: async () => payload("Alpha", "# Alpha"),
});

/** Every preview URL this stub was asked for, in order. */
let reads: string[] = [];

beforeEach(() => {
  window.localStorage.clear();
  // …and the URL, which is jsdom state shared by every test in this file. The
  // shell seeds its mode from `?mode=` at mount and `selectMode` pushes an
  // entry, so a case that switches modes would otherwise hand every case after
  // it a shell that opens on some other surface — with no tree rows in it.
  window.history.replaceState(null, "", "/");
  reads = [];
  answer = () => ({
    ok: true,
    status: 200,
    json: async () => payload("Alpha", "# Alpha"),
  });
  // Two consumers share this global: `useSidecarStatus` probes the loopback
  // port at mount, and `PreviewColumn` reads a docked row's bytes. An
  // affirmative default keeps the probe off the network and lets its setState
  // settle inside `act`; only the preview URL is routed to `answer`.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/workbench/preview")) {
        reads.push(href);
        const result = answer();
        if (result instanceof Error) throw result;
        return result as unknown as Response;
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
  // file's own `cleanup()` lands after this. Unmounting here tears the tree
  // down while `fetch` is still stubbed and the spies are still installed.
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
  // Flush the sidecar probe AND the Preview's first read before any assertion.
  await act(async () => {});
  return view;
}

/** Re-render with a new provider payload — a refreshed server render. */
async function refresh(
  view: Awaited<ReturnType<typeof renderShell>>,
  data: WorkbenchData,
) {
  view.rerender(
    <WorkbenchDataProvider value={data}>
      <Workbench>
        <p>canvas</p>
      </Workbench>
    </WorkbenchDataProvider>,
  );
  await act(async () => {});
}

/**
 * What the SHELL's polite live region says.
 *
 * The CHILD combinator is what excludes the Preview's own polite region (DW-50):
 * that one is a GRANDchild, inside the `<aside>`, and sits earlier in DOM order,
 * so an unscoped `querySelector` would silently read it in every test here —
 * which is all of them. `[length - 1]` then covers a second announcer added as
 * a direct child of the shell; the shell's own is the final one.
 */
function announcedRaw(): string {
  const regions = document.querySelectorAll('.wb-shell > .wb-sr-only[aria-live="polite"]');
  return regions[regions.length - 1]?.textContent ?? "";
}

/** …and what the COLUMN's own region says, likewise verbatim. */
function columnAnnouncedRaw(): string {
  return (
    document.querySelector('.wb-preview .wb-sr-only[aria-live="polite"]')?.textContent ?? ""
  );
}

/**
 * The SENTENCE either region is reading — the repeat mark stripped (DW-182).
 *
 * A region that has to say the same thing twice carries an invisible mark on
 * the second write, because an identical string is what a screen reader cannot
 * tell from no write at all. That mark is not spoken, so every assertion about
 * what a reader HEARS compares against copy through here; the two `…Raw`
 * readers above are for the assertions about what the region DID, which is
 * exactly "its text changed".
 */
function announced(): string {
  return announcementSentence(announcedRaw());
}

function columnAnnounced(): string {
  return announcementSentence(columnAnnouncedRaw());
}

function preview(): HTMLElement | null {
  return screen.queryByRole("complementary", { name: "Preview" });
}

/**
 * What the rendered BODY says.
 *
 * Scoped rather than `getByText`: `Alpha` is the tree row's label, the column
 * header's name AND the `# Alpha` heading in the bytes, so an unscoped query
 * matches three nodes — and, worse, would still match two of them after the
 * body had been replaced by a failure sentence.
 */
function previewBodyText(): string {
  return document.querySelector(".wb-preview-body")?.textContent ?? "";
}

function row(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

describe("docking and undocking announce themselves (DW-34)", () => {
  it("names the row the Preview just docked on", async () => {
    await renderShell();
    expect(preview()).toBeNull();
    expect(announced()).toBe("");

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    expect(preview()).toBeTruthy();
    // A dock is a layout change with no focus move and no route change, so
    // without this a click on a tree row produces nothing a screen reader can
    // perceive: a panel simply exists somewhere below.
    expect(announced()).toBe(previewDockAnnouncement("Alpha"));
    expect(announced()).toBe("Preview, Alpha");
  });

  it("says the column closed when the owner re-clicks the same row", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    expect(preview()).toBeNull();
    // No name in it: the column is gone, and naming what it used to show reads
    // as a report that something opened.
    expect(announced()).toBe(PREVIEW_CLOSED_COPY);
  });

  it("announces the new row when a wikilink is followed", async () => {
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "See [[beta]] and [[alpha]]."),
    });
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(announced()).toBe("Preview, Alpha");

    // A link to the page ALREADY showing: React bails out on the identical
    // selection, so there is no dock to report, and `Preview, Alpha` spoken
    // again would tell the owner something happened when nothing did.
    //
    // Something ELSE has to have spoken in between, or this assertion cannot
    // fail: writing `Preview, Alpha` over `Preview, Alpha` is indistinguishable
    // from not writing at all, and an unguarded `setAnnouncement` in `openPage`
    // passed a bare re-read of the region. The Settings round trip leaves the
    // region holding its own sentence, so a spurious dock announcement is
    // visible here as the region changing.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {});
    const betweenSaid = announced();
    expect(betweenSaid).not.toBe("Preview, Alpha");

    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await act(async () => {});
    expect(announced()).toBe(betweenSaid);

    fireEvent.click(screen.getByRole("button", { name: "beta" }));
    await act(async () => {});
    expect(announced()).toBe("Preview, Beta");
  });

  it("stays silent when the mount restore docks the column", async () => {
    // Restoring state is not a change the owner made — the rule the mode
    // restore already documents. Announcing it would report a dock on every
    // single page load.
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    await renderShell();

    expect(preview()).toBeTruthy();
    expect(announced()).toBe("");
    expect(columnAnnounced()).toBe("");
    // The same rule for the other half of the report: the narrow-width reveal
    // answers a PICK. Fired on the restore, every page load below 900px would
    // open already scrolled past the tree and the canvas to the bottom row —
    // a movement the owner did not ask for, on a viewport where it costs them
    // the whole rest of the shell.
    expect(scroll).not.toHaveBeenCalled();
  });

  it("keeps the reset effect's frozen dependencies", async () => {
    // Story 1.4 froze `[mode, currentWikiId, treeTab]`, and DW-53's
    // reconciliation is a SEPARATE effect for exactly that reason. Observed
    // rather than grepped: a tab change still undocks, and it does so without
    // the removal sentence, which is what would happen if the trees had joined
    // the reset effect's array.
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await act(async () => {});

    expect(preview()).toBeNull();
    expect(announced()).not.toBe(PREVIEW_REMOVED_COPY);
  });
});

describe("a docked column below 900px is reachable (DW-34)", () => {
  it("scrolls the column into view at the narrow breakpoint", async () => {
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");
    // The shim defaults to the NARROW viewport, which is the width at which the
    // Preview is a stacked fourth row rather than a fourth column.
    await renderShell();
    expect(scroll).not.toHaveBeenCalled();

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    expect(preview()).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    // The column itself, not the shell or the tree row — a scroll that revealed
    // the canvas would leave the owner exactly where the bug left them.
    expect(scroll.mock.instances[0]).toBe(preview());
  });

  it("scrolls again when a DIFFERENT row is picked into an open column", async () => {
    // Keyed on the dock alone, this was the same "a tap appeared to do nothing"
    // symptom DW-34 exists to end, left unfixed for the common case: once a
    // Preview is open at this width it is below the fold, so picking a second
    // row changes content the owner cannot see and nothing moves.
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    fireEvent.click(row("Beta"));
    await act(async () => {});

    expect(preview()).toBeTruthy();
    expect(scroll).toHaveBeenCalled();
    expect(scroll.mock.instances[0]).toBe(preview());
  });

  it("does not scroll for a wikilink that lands on the row already showing", async () => {
    // `openPage` returns the SAME selection object when React should bail out,
    // so the reveal's dependency does not move either — nothing changed on
    // screen, and a scroll would be motion reporting a no-op.
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "See [[alpha]]."),
    });
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    fireEvent.click(screen.getByRole("button", { name: "alpha" }));
    await act(async () => {});

    expect(scroll).not.toHaveBeenCalled();
  });

  it("does not scroll when the column is already a column", async () => {
    await renderShell();
    // `matchMedia(SPLIT_WIDE_QUERY)` has been observed by the shell's own breakpoint
    // effect, so the shim will accept the move.
    act(() => setMediaQuery(SPLIT_WIDE_QUERY, true));
    const scroll = vi.spyOn(Element.prototype, "scrollIntoView");

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    expect(preview()).toBeTruthy();
    // The wide layout already has it on screen; scrolling would move a shell
    // that does not scroll and jump the canvas for nothing.
    expect(scroll).not.toHaveBeenCalled();
  });

  it("docks anyway when the platform has no scrollIntoView", async () => {
    const original = Element.prototype.scrollIntoView;
    // @ts-expect-error — deleting a DOM method is exactly the platform this
    // guards against: a few embedded webviews ship without it.
    delete Element.prototype.scrollIntoView;
    try {
      await renderShell();
      fireEvent.click(row("Alpha"));
      await act(async () => {});

      expect(preview()).toBeTruthy();
      expect(announced()).toBe("Preview, Alpha");
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});

describe("a row deleted elsewhere closes the column (DW-53)", () => {
  it("undocks and says why when the refreshed tree drops the row", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(preview()).toBeTruthy();

    // Another actor deleted the page; the watcher re-ran the server render and
    // the refreshed trees simply no longer contain it.
    await refresh(view, {
      ...DATA,
      dataVersion: 1,
      knowledge: [{ id: "note", label: "Note", count: 1, pages: [KNOWLEDGE[0].pages[1]] }],
    });

    expect(preview()).toBeNull();
    // …and no visible row is left carrying `aria-current`, which is the state
    // the selection used to be stranded in.
    expect(document.querySelector(".wb-tree-row[aria-current='true']")).toBeNull();
    expect(announced()).toBe(PREVIEW_REMOVED_COPY);
  });

  it("keeps the selection when the trees could not be read", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    // A failed index read hands the trees down EMPTY. Read as a deletion, one
    // bad minute on the server would close the Preview and announce a removal.
    await refresh(view, {
      ...DATA,
      dataVersion: 1,
      knowledge: [],
      knowledgeUnavailable: true,
    });

    expect(preview()).toBeTruthy();
    expect(announced()).toBe("Preview, Alpha");
  });

  it("keeps a FILE pick when the walk could not be read", async () => {
    // The flag is matched to the selection's own KIND, so this needs a file
    // selection to mean anything: run against the page pick above, a refresh
    // carrying `filesUnavailable` leaves the knowledge tree whole, and the pick
    // survives because the page is still in it — the assertion passes without
    // the flag ever being consulted.
    const view = await renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await act(async () => {});
    fireEvent.click(row("x.md"));
    await act(async () => {});
    expect(preview()).toBeTruthy();

    await refresh(view, {
      ...DATA,
      dataVersion: 1,
      files: [],
      filesUnavailable: true,
    });

    expect(preview()).toBeTruthy();
    expect(announced()).not.toBe(PREVIEW_REMOVED_COPY);
  });

  it("reconciles on the FIRST refresh after a layout change", async () => {
    // The bug this pins, and it silently defeats DW-53 after any tab, mode or
    // Wiki change: the effect records the layout signature it last ran against,
    // and it is the ONLY writer of that record. Keyed on the trees alone, a tab
    // switch moves the layout without re-running it — so the record goes stale,
    // and the next refresh (a genuinely different commit) compares against a
    // signature from before the switch, concludes the layout just moved, and
    // stands down. The row stayed docked until a SECOND refresh arrived.
    const view = await renderShell();
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await act(async () => {});
    fireEvent.click(row("x.md"));
    await act(async () => {});
    expect(preview()).toBeTruthy();

    // ONE refresh, with the file dropped from the walk.
    await refresh(view, {
      ...DATA,
      dataVersion: 1,
      files: buildFileTree(["wiki/alpha.md", "raw/"]),
    });

    expect(preview()).toBeNull();
    expect(announced()).toBe(PREVIEW_REMOVED_COPY);
  });

  it("clears the stale pick without speaking while Settings is open", async () => {
    // Settings takes the left column, so the shell holds a live selection with
    // `previewOpen === false` for as long as it is open. Announcing the removal
    // of a column the owner cannot see reports the disappearance of something
    // that was never on screen.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {});
    expect(preview()).toBeNull();
    const settingsSaid = announced();

    await refresh(view, {
      ...DATA,
      dataVersion: 1,
      knowledge: [{ id: "note", label: "Note", count: 1, pages: [KNOWLEDGE[0].pages[1]] }],
    });

    expect(announced()).toBe(settingsSaid);
    expect(announced()).not.toBe(PREVIEW_REMOVED_COPY);
    // …but the pick is still CLEARED, or closing Settings would dock a column
    // onto a row that no longer exists.
    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    await act(async () => {});
    expect(preview()).toBeNull();
  });

  it("leaves a layout change to the reset effect, silently", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    // A Wiki switch and a refreshed render land in the same commit. The reset
    // effect owns the clear; announcing a REMOVAL here would report a deletion
    // that did not happen.
    await refresh(view, { ...DATA, dataVersion: 1, currentWikiId: "wiki-2", knowledge: [] });

    expect(preview()).toBeNull();
    expect(announced()).not.toBe(PREVIEW_REMOVED_COPY);
  });
});

describe("a silent same-row refresh announces itself (DW-50)", () => {
  it("says the Preview updated when the bytes changed underneath", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(columnAnnounced()).toBe("");

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha rewritten"),
    });
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(screen.getByText("Alpha rewritten")).toBeTruthy();
    // The COLUMN's region, not the shell's: the shell reports which surface is
    // showing, and a body swap does not change that.
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);
    expect(announced()).toBe("Preview, Alpha");
  });

  it("says nothing when the same bytes come back", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    // A bump fires for every write in the system, most of them about some other
    // page. Announcing each one makes the region chatter at a reader whose
    // screen did not change.
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(columnAnnounced()).toBe("");
  });

  it("says nothing on the read a fresh pick makes", async () => {
    await renderShell();

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    // The dock announcement already reported this event once.
    expect(announced()).toBe("Preview, Alpha");
    expect(columnAnnounced()).toBe("");
  });

  it("does not carry one row's update sentence onto the next row", async () => {
    // The reset path clears this region, and the only case that EXPOSES the
    // clearing is a pick whose own read fails: on a successful pick the `ok`
    // branch writes the region again and hides a missing reset. Left over, the
    // column would assert `Preview updated` beside a body reading
    // `This file couldn’t be loaded.` — a sentence about the row before this one.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha rewritten"),
    });
    await refresh(view, { ...DATA, dataVersion: 1 });
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);

    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    fireEvent.click(row("Beta"));
    await act(async () => {});

    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
    expect(columnAnnounced()).toBe("");
  });
});

describe("gone is not the same as unreachable (DW-54)", () => {
  it("replaces the body on a 404, with no stale strip", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(previewBodyText()).toContain("Alpha");

    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    await refresh(view, { ...DATA, dataVersion: 1 });

    // A page another actor deleted must not keep rendering as if it were there.
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_RETRY_COPY })).toBeNull();
  });

  it("keeps the last-good bytes when the read cannot be reached", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });

    // THE bug DW-54 is: a dropped packet used to replace the page the owner was
    // reading with `This file couldn’t be loaded.` and never heal.
    expect(previewBodyText()).toContain("Alpha");
    expect(screen.queryByText(PREVIEW_FAILED_COPY)).toBeNull();
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(screen.getByRole("button", { name: PREVIEW_RETRY_COPY })).toBeTruthy();
    // Muted chrome, never an alert: nothing was lost and nothing was deleted.
    expect(document.querySelector(".wb-preview-stale [role='alert']")).toBeNull();
    // ABOVE the bytes, because it is a statement ABOUT them. Rendered below,
    // the same sentence reads as a footnote to a page a reader has already
    // finished — and every other assertion here is a text query, which would
    // not notice the strip moving.
    const strip = document.querySelector(".wb-preview-stale");
    const body = document.querySelector(".wb-preview-body");
    expect(strip).toBeTruthy();
    expect(body).toBeTruthy();
    expect(strip!.compareDocumentPosition(body!) & Node.DOCUMENT_POSITION_FOLLOWING).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("does the same for a 5xx and for a 200 that is not a payload", async () => {
    // The other two members of the old `failed`. A 502 from a proxy hiccup and
    // an interstitial on a 200 are both reads that did not land, and neither is
    // evidence that the row was removed.
    const good = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha"),
    });
    for (const failure of [
      () => ({ ok: false, status: 500, json: async () => ({}) }),
      () => ({ ok: true, status: 200, json: async () => ({ nope: true }) }),
    ]) {
      // Reset BOTH fixtures per case: the loop body outlives `beforeEach`, so
      // the previous case's failure would otherwise be what the fresh pick's
      // own read gets — and a column with no last-good bytes cannot keep any.
      answer = good;
      window.localStorage.clear();
      const view = await renderShell();
      fireEvent.click(row("Alpha"));
      await act(async () => {});
      expect(preview()).toBeTruthy();

      answer = failure;
      await refresh(view, { ...DATA, dataVersion: 1 });

      expect(previewBodyText()).toContain("Alpha");
      expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
      cleanup();
      window.localStorage.clear();
    }
  });

  it("heals on the next read that already happens, with no retry timer", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    const attempts = reads.length;

    // No auto-retry and no polling loop: the strip clears on the next read the
    // shell was going to make anyway.
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha again"),
    });
    await refresh(view, { ...DATA, dataVersion: 2 });

    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    expect(screen.getByText("Alpha again")).toBeTruthy();
    // Exactly one more read — the one the bump caused, not a timer's.
    expect(reads.length).toBe(attempts + 1);
  });

  it("re-reads the same row when Retry is pressed", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    const attempts = reads.length;

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha recovered"),
    });
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_RETRY_COPY }));
    await act(async () => {});

    expect(reads.length).toBe(attempts + 1);
    // The SAME row, not whatever the shell last rendered.
    expect(reads[reads.length - 1]).toContain("kind=page&slug=alpha");
    expect(screen.getByText("Alpha recovered")).toBeTruthy();
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
  });

  it("withdraws the strip while the editor is open, rather than offering a dead Retry", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    expect(screen.getByRole("button", { name: PREVIEW_RETRY_COPY })).toBeTruthy();
    const attempts = reads.length;

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});

    // `previewFetchPlan` answers `fetch: false` for every run while the editor
    // is open, so `Retry` here would be a control that silently does nothing on
    // every press — and the sentence beside it describes a refresh that cannot
    // be attempted.
    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_RETRY_COPY })).toBeNull();
    expect(reads.length).toBe(attempts);

    // …and closing the editor lets the deferred read happen, which is what
    // decides whether the strip comes back. It does, because the read still
    // cannot land.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(reads.length).toBe(attempts + 1);
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
  });

  it("leaves the strip standing when the retry fails too", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_RETRY_COPY }));
    await act(async () => {});

    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(previewBodyText()).toContain("Alpha");
  });

  it("still shows the one sentence when a FRESH pick fails either way", async () => {
    // Unchanged from today, and deliberately so: with no payload held there are
    // no last-good bytes to keep, and a `Retry` beside the failure sentence
    // would promise to restore bytes the column never had.
    for (const failure of [
      () => ({ ok: false, status: 404, json: async () => ({}) }),
      () => new TypeError("network down"),
    ]) {
      answer = failure;
      await renderShell();
      fireEvent.click(row("Alpha"));
      await act(async () => {});

      expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
      expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
      expect(screen.queryByRole("button", { name: PREVIEW_RETRY_COPY })).toBeNull();
      cleanup();
      // The pick OUTLIVES the tree: the shell persists it, so without this the
      // next render restores the row and the click below toggles it back off.
      window.localStorage.clear();
    }
  });
});

describe("a 404 takes the Edit affordance with the body (DW-181)", () => {
  it("withdraws Edit on a refresh that answers 404, and restores it when the row answers again", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(screen.getByRole("button", { name: PREVIEW_EDIT_COPY })).toBeTruthy();

    // THE bug. The `gone` branch KEEPS the last payload on purpose (DW-54), so
    // asked about the payload alone `canEditPreview` stays true: the header
    // went on offering `Edit` over a body the 404 had already replaced, and
    // `save()`'s guard — comparing against that same kept payload — passed and
    // posted to a row the server said was not there.
    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: PREVIEW_EDIT_COPY })).toBeNull();

    // …and the gate is a READ of current state, not a latch: the row answering
    // again brings the control back with the bytes.
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha restored"),
    });
    await refresh(view, { ...DATA, dataVersion: 2 });

    expect(screen.getByText("Alpha restored")).toBeTruthy();
    expect(screen.getByRole("button", { name: PREVIEW_EDIT_COPY })).toBeTruthy();
  });

  it("keeps Edit when a refresh answers 200 with different bytes", async () => {
    // The gate closes on `gone` and on nothing else. A same-row refresh that
    // simply changed the file is the ordinary case, and withdrawing the editor
    // for it would make every write in the system take `Edit` away.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha rewritten"),
    });
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(screen.getByText("Alpha rewritten")).toBeTruthy();
    expect(screen.getByRole("button", { name: PREVIEW_EDIT_COPY })).toBeTruthy();
  });

  it("takes an OPEN confirm gate with it, rather than re-wording it", async () => {
    // `Edit` unmounts on the 404's render, but the dialog it opened would go on
    // standing — and its sentences come from the same derivation, which now
    // answers `null`. `previewEditCopy(null)` is the PAGE copy, so the Schema's
    // gate would silently re-title itself to "Edit this page?" mid-read and
    // offer to open an editor with nowhere at all to save to.
    answer = () => ({ ok: true, status: 200, json: async () => schemaPayload() });
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    expect(screen.getByText(PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE)).toBeTruthy();

    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    await refresh(view, { ...DATA, dataVersion: 1 });

    // Gone, not re-worded: no dialog at all, and above all not the page's gate
    // standing where the Schema's was.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL })).toBeNull();
    expect(screen.queryByText(PREVIEW_EDIT_SCHEMA_CONFIRM_TITLE)).toBeNull();
    expect(screen.queryByText(PREVIEW_EDIT_CONFIRM_TITLE)).toBeNull();
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
  });

  it("leaves no way to reach the editor around the withdrawn control", async () => {
    // Belt and braces on the same path: even if a dialog somehow survived,
    // `startEditing` asks the SAME derivation again, so a confirm press seeds
    // no editor. Driven through the handler the dialog would call.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    expect(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL })).toBeTruthy();

    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_EDIT_COPY })).toBeNull();
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
  });
});

describe("a region that has to repeat itself is still heard (DW-182)", () => {
  it("changes the column's region on a SECOND body swap reading the same sentence", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha two"),
    });
    await refresh(view, { ...DATA, dataVersion: 1 });
    const first = columnAnnouncedRaw();
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha three"),
    });
    await refresh(view, { ...DATA, dataVersion: 2 });
    const second = columnAnnouncedRaw();

    expect(screen.getByText("Alpha three")).toBeTruthy();
    // THE bug: most assistive tech announces a live region on CHANGE, so
    // writing `Preview updated` over `Preview updated` is indistinguishable
    // from not writing at all — two consecutive silent refreshes reported as
    // one, and the second body swap went unmentioned.
    expect(second).not.toBe(first);
    expect(second).toBe(first + LIVE_REGION_REPEAT_MARK);
    // …while the sentence a reader HEARS is unchanged: the mark is invisible
    // and unspoken.
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);
    // And it alternates rather than accumulating — a third swap takes it off
    // again, so the region never grows a tail of marks.
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha four"),
    });
    await refresh(view, { ...DATA, dataVersion: 3 });
    expect(columnAnnouncedRaw()).toBe(first);
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);
  });

  it("changes the SHELL's region when the owner re-picks the same surface", async () => {
    // The shell's region reports which surface is showing, and `selectMode`
    // announces the label whether or not the mode moved. Re-pressing the rail
    // item already current therefore reads the SAME sentence a second time —
    // and before this the region did not move, so nothing was heard at all.
    await renderShell();
    const chat = () => screen.getByRole("button", { name: "Chat" });

    fireEvent.click(chat());
    await act(async () => {});
    const first = announcedRaw();
    expect(announced()).toBe("Chat");

    fireEvent.click(chat());
    await act(async () => {});

    expect(announced()).toBe("Chat");
    expect(announcedRaw()).not.toBe(first);
    expect(announcedRaw()).toBe(first + LIVE_REGION_REPEAT_MARK);
  });

  it("never marks a CLEARED region — silence is silence", async () => {
    // The reset path writes `""` rather than going through the repeat
    // mechanism: a lone mark is still a content change, and some
    // implementations read that as an empty utterance on every fresh pick.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha rewritten"),
    });
    await refresh(view, { ...DATA, dataVersion: 1 });
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);

    answer = () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) });
    fireEvent.click(row("Beta"));
    await act(async () => {});

    expect(columnAnnouncedRaw()).toBe("");
  });
});

describe("an unreachable refresh eventually says so (DW-183)", () => {
  it("stays silent for one blip and announces the second in a row", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(columnAnnouncedRaw()).toBe("");

    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });

    // The strip shows and the region stays empty: one failed read heals on the
    // next read that already happens, and a sentence for it would land in a
    // reader's ear for a condition that was over before they heard it.
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(columnAnnouncedRaw()).toBe("");

    await refresh(view, { ...DATA, dataVersion: 2 });

    // Two in a row means the self-healing did not happen, so a reader who
    // cannot see the strip is now reading bytes with no way of knowing they
    // are stale. Polite, in the column's OWN region beside `Preview updated` —
    // never an alert, because nothing was lost.
    expect(columnAnnounced()).toBe(PREVIEW_STALE_ANNOUNCEMENT_COPY);
    expect(document.querySelector('.wb-preview [role="alert"]')).toBeNull();

    // …and said ONCE per run, not on every bump for as long as the outage runs.
    const said = columnAnnouncedRaw();
    await refresh(view, { ...DATA, dataVersion: 3 });
    expect(columnAnnouncedRaw()).toBe(said);
    await refresh(view, { ...DATA, dataVersion: 4 });
    expect(columnAnnouncedRaw()).toBe(said);
  });

  it("starts the run over once a read lands again", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    await refresh(view, { ...DATA, dataVersion: 2 });
    expect(columnAnnounced()).toBe(PREVIEW_STALE_ANNOUNCEMENT_COPY);

    // A read that LANDS ends the run — the strip is gone and the bytes on
    // screen are current again.
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Alpha", "# Alpha healed"),
    });
    await refresh(view, { ...DATA, dataVersion: 3 });
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    // The healed read swapped the body, so the region reports THAT — and this
    // is the exact value the blip below must leave untouched.
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);
    const healed = columnAnnouncedRaw();

    // …so the NEXT single blip is a first blip again, and silent. Asserted as
    // "the region did not move at all", not as "it does not read the stale
    // sentence": the region holds `Preview updated` here, so a `not.toBe`
    // against the stale copy would pass for almost any regression.
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 4 });
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(columnAnnouncedRaw()).toBe(healed);
    expect(columnAnnounced()).toBe(PREVIEW_UPDATED_COPY);
  });

  it("says nothing about a last version for a row that never loaded one", async () => {
    // The strip needs last-good bytes, and this row has none: its very FIRST
    // read failed, so the body is `This file couldn’t be loaded.` and
    // `previewStaleNotice` shows no strip. Gated on the failure run alone, the
    // second consecutive failure still reaches the threshold and the region
    // says "showing the last version that loaded" over a body saying nothing
    // loaded — a sentence contradicting the screen, with the strip absent.
    answer = () => new TypeError("network down");
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    expect(columnAnnouncedRaw()).toBe("");

    // The second consecutive failure — a bump, so the run is NOT reset.
    await refresh(view, { ...DATA, dataVersion: 1 });

    expect(screen.getByText(PREVIEW_FAILED_COPY)).toBeTruthy();
    expect(screen.queryByText(PREVIEW_UNREACHABLE_COPY)).toBeNull();
    expect(columnAnnouncedRaw()).toBe("");

    // …and it stays silent however long the run gets, so this cannot be
    // satisfied by moving the threshold rather than by asking about the bytes.
    await refresh(view, { ...DATA, dataVersion: 2 });
    await refresh(view, { ...DATA, dataVersion: 3 });
    expect(columnAnnouncedRaw()).toBe("");
  });

  it("does not carry a failure run across a pick", async () => {
    // The run belongs to the row it was counted for. Carried over, one earlier
    // failure elsewhere would make the new row's FIRST blip announce.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    expect(columnAnnouncedRaw()).toBe("");

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Beta", "# Beta"),
    });
    fireEvent.click(row("Beta"));
    await act(async () => {});

    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 2 });

    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(columnAnnouncedRaw()).toBe("");
  });
});

describe("Retry reports that it is working (DW-184)", () => {
  it("is aria-busy, disabled and relabelled while the read is in flight", async () => {
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });

    const idle = screen.getByRole("button", {
      name: PREVIEW_RETRY_COPY,
    }) as HTMLButtonElement;
    expect(idle.getAttribute("aria-busy")).toBe("false");
    expect(idle.disabled).toBe(false);

    // A read that has not settled. Held open deliberately: the whole defect is
    // that the window between the press and the answer looked exactly like a
    // control that does nothing.
    const settle: Array<(value: unknown) => void> = [];
    answer = () => new Promise<unknown>((resolve) => settle.push(resolve));
    fireEvent.click(idle);
    await act(async () => {});

    const busy = screen.getByRole("button", {
      name: PREVIEW_RETRYING_COPY,
    }) as HTMLButtonElement;
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(busy.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: PREVIEW_RETRY_COPY })).toBeNull();
    // The strip's SENTENCE does not move: the bytes below are still the last
    // ones that loaded, which is exactly what it says. Only the control reports.
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    expect(previewBodyText()).toContain("Alpha");

    await act(async () => {
      for (const resolve of settle) resolve({ ok: false, status: 500, json: async () => ({}) });
    });

    // It settled unreachable AGAIN, so the strip stays — and the control is
    // pressable again rather than stuck reporting a read that is over.
    expect(screen.getByText(PREVIEW_UNREACHABLE_COPY)).toBeTruthy();
    const recovered = screen.getByRole("button", {
      name: PREVIEW_RETRY_COPY,
    }) as HTMLButtonElement;
    expect(recovered.getAttribute("aria-busy")).toBe("false");
    expect(recovered.disabled).toBe(false);
  });

  it("issues exactly one read while it is busy, however many times it is pressed", async () => {
    // `disabled` is not decoration: a second press bumps the nonce again, which
    // re-runs the effect and ABORTS the read the first press started.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });
    const attempts = reads.length;

    const settle: Array<(value: unknown) => void> = [];
    answer = () => new Promise<unknown>((resolve) => settle.push(resolve));
    const retry = screen.getByRole("button", { name: PREVIEW_RETRY_COPY });
    fireEvent.click(retry);
    await act(async () => {});
    fireEvent.click(retry);
    fireEvent.click(retry);
    await act(async () => {});

    expect(reads.length).toBe(attempts + 1);

    await act(async () => {
      for (const resolve of settle) resolve({ ok: false, status: 500, json: async () => ({}) });
    });
    expect(
      (screen.getByRole("button", { name: PREVIEW_RETRY_COPY }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });

  it("clears the busy flag when a pick lands while a retry is in flight", async () => {
    // The reset path owns everything that belonged to the previous row. Left
    // set, the flag would come back with the next strip and disable a control
    // for a read that settled minutes ago.
    const view = await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 1 });

    const settle: Array<(value: unknown) => void> = [];
    answer = () => new Promise<unknown>((resolve) => settle.push(resolve));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_RETRY_COPY }));
    await act(async () => {});
    expect(screen.getByRole("button", { name: PREVIEW_RETRYING_COPY })).toBeTruthy();

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Beta", "# Beta"),
    });
    fireEvent.click(row("Beta"));
    await act(async () => {});
    for (const resolve of settle) resolve({ ok: false, status: 500, json: async () => ({}) });
    await act(async () => {});

    expect(previewBodyText()).toContain("Beta");
    answer = () => new TypeError("network down");
    await refresh(view, { ...DATA, dataVersion: 2 });
    const back = screen.getByRole("button", {
      name: PREVIEW_RETRY_COPY,
    }) as HTMLButtonElement;
    expect(back.disabled).toBe(false);
  });
});
