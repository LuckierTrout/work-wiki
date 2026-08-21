import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_CANCEL_COPY,
  PREVIEW_DISCARD_CONFIRM_LABEL,
  PREVIEW_EDIT_COPY,
  PREVIEW_HISTORY_COPY,
  PREVIEW_HISTORY_EMPTY_COPY,
  PREVIEW_HISTORY_FAILED_COPY,
  PREVIEW_HISTORY_HIDE_COPY,
  PREVIEW_HISTORY_LOADING_COPY,
  PREVIEW_HISTORY_READ_ONLY_COPY,
  PREVIEW_HISTORY_REVERTED_COPY,
  PREVIEW_HISTORY_REVERTING_COPY,
  PREVIEW_HISTORY_REVERT_CONFIRM_LABEL,
  PREVIEW_HISTORY_REVERT_CONFIRM_TITLE,
  PREVIEW_HISTORY_REVERT_COPY,
  PREVIEW_HISTORY_REVERT_FAILED_COPY,
  PREVIEW_HISTORY_VIEW_COPY,
  PREVIEW_SAVE_COPY,
  artifactRevisionDate,
  artifactRevisionLabel,
  artifactRevisionSize,
} from "@/lib/workbench-preview";
import { announcementSentence } from "@/lib/live-region";
import { subscribeDataVersionCheck } from "@/lib/workbench-data-version";
import { buildFileTree } from "@/lib/workbench-tree";

/**
 * DW-214 — the Workbench's History panel, on a mounted shell.
 *
 * `GET/POST /api/workbench/artifact/revisions` shipped with DW-59 and had NO
 * CLIENT: the recovery path for the one executable artifact an owner can edit
 * existed only as a route, so nothing in the running app could list, view or
 * revert a Schema revision. This suite is what pins that it is reachable, and
 * that the four rules a rewrite would most easily drop still hold.
 *
 * Every DECISION behind it is a pure function with its own node-project test
 * (`previewHistoryTarget`, the three fetch helpers, the copy) — what only a
 * mounted column can show is that the component ASKS: that the panel is absent
 * where the derivation says `null`, that the expand fires exactly one listing,
 * that the revert is confirm-gated and re-lists, and that a read-only
 * deployment refuses BEFORE the dialog rather than after the 403 (DW-149).
 *
 * The harness is `preview-announcements.test.tsx`': one stable router, a
 * `WorkbenchDataProvider` around the real shell, and a `fetch` stub that routes
 * the preview read to a fixture. The revisions route is routed here too, by
 * VERB and by whether the URL carries `?timestamp=`, which is exactly how the
 * route itself tells its three answers apart.
 */

const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const WIKI_ID = "wiki-1";

const KNOWLEDGE = [
  {
    id: "note",
    label: "Note",
    count: 1,
    pages: [{ slug: "alpha", title: "Alpha", type: "note" }],
  },
];

const FILES = buildFileTree(["wiki/alpha.md", "raw/", "raw/x.md"]);

/**
 * A SECOND knowledge row, for the one case that needs the owner to move from
 * one row to another rather than to undock. The preview fixture answers the
 * Schema for every row, so both carry a History panel.
 */
const KNOWLEDGE_TWO = [
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

const TWO_ROWS: WorkbenchData = { ...DATA, knowledge: KNOWLEDGE_TWO };

/**
 * The Schema payload, which is what makes the panel exist at all: an
 * `artifact`, no `slug`. Answered by FIXTURE rather than by URL — every
 * derivation under test reads the payload, not the selection, so a click on any
 * tree row puts the Schema on screen.
 */
function schemaPayload() {
  return {
    name: "schema.md",
    path: "schema.md",
    artifact: "schema.md" as const,
    format: "markdown" as const,
    body: "## Page conventions\n\ncurrent",
    truncated: false,
    editable: true,
    version: "w1s:1-aaaaaaaabbbbbbbb",
  };
}

/** …and a PAGE payload, which must produce no panel at all. */
function pagePayload() {
  return {
    name: "Alpha",
    path: "wiki/alpha.md",
    slug: "alpha",
    format: "markdown" as const,
    body: "# Alpha",
    truncated: false,
    editable: true,
    version: "w1:1-aaaaaaaabbbbbbbb",
  };
}

const NEWER = {
  timestamp: 1_700_000_002_000,
  date: new Date(1_700_000_002_000).toISOString(),
  file: "schema.md",
  sizeBytes: 42,
  author: "yuanhao",
  reason: "replaced by the Reading Scenario Template",
};
const OLDER = {
  timestamp: 1_700_000_001_000,
  date: new Date(1_700_000_001_000).toISOString(),
  file: "schema.md",
  sizeBytes: 31,
};

/** The entry a landed SAVE adds — `writeWikiArtifact` snapshots what it replaces. */
const SAVED_BY_EDIT = {
  timestamp: 1_700_000_003_000,
  date: new Date(1_700_000_003_000).toISOString(),
  file: "schema.md",
  sizeBytes: 55,
  author: "yuanhao",
  reason: "the bytes the owner's own save replaced",
};

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

/** A response the test resolves by hand, for the in-flight races below. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
function refusal(status: number, error: string) {
  return { ok: false, status, json: async () => ({ error }) };
}

/** What the next read of each kind should answer. Reassigned per test. */
let previewAnswer: () => unknown = () => ok(schemaPayload());
let listAnswer: () => unknown = () => ok({ revisions: [NEWER, OLDER] });
let viewAnswer: () => unknown = () => ok({ content: "## Page conventions\n\nold bytes" });
let revertAnswer: () => unknown = () => ok({ ok: true, version: "w1s:2-cccccccc" });
/**
 * The Schema WRITE — `PUT /api/workbench/artifact` — which used to fall through
 * to the catch-all 200 and so could only ever land. DW-376 needs the other
 * answers: a save whose outcome nobody knows still owes this panel a cache
 * invalidation, because a save that DID land added an entry.
 */
let writeAnswer: () => unknown = () => ok({ ok: true, version: "w1s:2-dddddddd" });

/** Every revisions request the stub was asked for, in order. */
let revisionCalls: { url: string; method: string; signal?: AbortSignal }[] = [];

beforeEach(() => {
  window.localStorage.clear();
  window.history.replaceState(null, "", "/");
  revisionCalls = [];
  previewAnswer = () => ok(schemaPayload());
  listAnswer = () => ok({ revisions: [NEWER, OLDER] });
  viewAnswer = () => ok({ content: "## Page conventions\n\nold bytes" });
  revertAnswer = () => ok({ ok: true, version: "w1s:2-cccccccc" });
  writeAnswer = () => ok({ ok: true, version: "w1s:2-dddddddd" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: { method?: string; signal?: AbortSignal }) => {
      const href = String(url);
      const method = init?.method ?? "GET";
      if (href.includes("/api/workbench/artifact/revisions")) {
        revisionCalls.push({ url: href, method, signal: init?.signal });
        // The same three answers the route itself distinguishes: POST is the
        // revert, `?timestamp=` is one entry, and everything else is the list.
        const result =
          method === "POST"
            ? revertAnswer()
            : href.includes("timestamp=")
              ? viewAnswer()
              : listAnswer();
        if (result instanceof Error) throw result;
        return result as unknown as Response;
      }
      if (href.includes("/api/workbench/preview")) {
        const result = previewAnswer();
        if (result instanceof Error) throw result;
        return result as unknown as Response;
      }
      // AFTER the `/revisions` branch above, which is a longer prefix of the
      // same path: the Schema write is `/api/workbench/artifact` with no suffix.
      if (href.includes("/api/workbench/artifact")) {
        const result = writeAnswer();
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
  // FIRST, for the reason `preview-announcements.test.tsx` gives: vitest runs
  // `afterEach` in reverse registration order, so this unmounts the tree while
  // `fetch` is still stubbed.
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
  await act(async () => {});
  return view;
}

/** Dock the Preview on a row, then settle its first read. */
async function dock() {
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  await act(async () => {});
}

function historyToggle(): HTMLElement | null {
  return screen.queryByRole("button", { name: PREVIEW_HISTORY_COPY });
}

/** Expand the panel and settle the listing it fires. */
async function expandHistory() {
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_COPY }));
  await act(async () => {});
}

function listings(): number {
  return revisionCalls.filter((call) => call.method === "GET" && !call.url.includes("timestamp="))
    .length;
}

/** The rendered rows' meta lines, in DOM order. */
function rowLabels(): string[] {
  return [...document.querySelectorAll(".wb-preview-history-meta")].map(
    (node) => node.textContent ?? "",
  );
}

/** What the COLUMN's own polite region is reading, repeat mark stripped. */
function columnAnnounced(): string {
  return announcementSentence(
    document.querySelector('.wb-preview .wb-sr-only[aria-live="polite"]')?.textContent ?? "",
  );
}

/**
 * Leave the editor, discarding whatever is in it.
 *
 * The History panel is withdrawn while `editing` — `previewHistoryTarget` says
 * so, because a revert under an open draft would replace the bytes it is
 * holding — so a test that wants to LOOK at the list after a save has to close
 * the editor first. A dirty draft is gated by the discard confirm (DW-36).
 */
async function closeEditor() {
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_CANCEL_COPY }));
  await act(async () => {});
  const discard = screen.queryByRole("button", { name: PREVIEW_DISCARD_CONFIRM_LABEL });
  if (discard) {
    fireEvent.click(discard);
    await act(async () => {});
  }
}

function revertButtons(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>(".wb-preview-history-actions button")].filter(
    (node) =>
      node.textContent === PREVIEW_HISTORY_REVERT_COPY ||
      node.textContent === PREVIEW_HISTORY_REVERTING_COPY,
  );
}

describe("the panel exists exactly where previewHistoryTarget says (DW-214)", () => {
  it("offers History for the Schema", async () => {
    await renderShell();
    await dock();
    expect(historyToggle()).toBeTruthy();
    // Collapsed, and no request until it is asked for: history is a recovery
    // path, not something a reader asked to see.
    expect(historyToggle()?.getAttribute("aria-expanded")).toBe("false");
    expect(revisionCalls).toEqual([]);
  });

  it("offers NO History for a page row", async () => {
    // A page has its own history surface (`RevisionHistory`), and it is not
    // this route: `?path=` only takes `EDITABLE_ARTIFACT_FILES`.
    previewAnswer = () => ok(pagePayload());
    await renderShell();
    await dock();
    expect(historyToggle()).toBeNull();
    expect(revisionCalls).toEqual([]);
  });

  it("offers NO History for a 404, whose payload deliberately survives", async () => {
    const view = await renderShell();
    await dock();
    expect(historyToggle()).toBeTruthy();
    // …with the revert gate OPEN, which is the state that used to survive the
    // 404: the panel unmounted and the modal went on standing over `This file
    // couldn’t be loaded.`, its `Restore this version` inert because
    // `confirmRevert`'s `file` was now `null`, and its focus restore pointing
    // at a button that no longer existed.
    await expandHistory();
    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    expect(screen.getByRole("dialog")).toBeTruthy();

    previewAnswer = () => refusal(404, "Not found.");
    view.rerender(
      <WorkbenchDataProvider value={{ ...DATA, dataVersion: 1 }}>
        <Workbench>
          <p>canvas</p>
        </Workbench>
      </WorkbenchDataProvider>,
    );
    await act(async () => {});

    // DW-181's rule, applied to this panel: a 404 keeps the last payload, so
    // asked about the payload alone the panel would go on offering to revert a
    // row the route says is not there.
    expect(historyToggle()).toBeNull();
    // …and the gate goes with it, rather than being left standing and inert.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(
      screen.queryByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    ).toBeNull();
  });

  it("takes the panel away while the editor is open, and gives it back on cancel", async () => {
    // The load-bearing refusal. A revert under an open draft replaces the bytes
    // the draft is measured against — and the version the editor is holding —
    // so the owner's own Save would come back as a conflict they caused by
    // pressing a button in this panel.
    await renderShell();
    await dock();
    await expandHistory();
    expect(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});

    expect(screen.getByRole("textbox")).toBeTruthy();
    expect(historyToggle()).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(historyToggle()).toBeTruthy();
  });

  it("drops the list when the owner picks another row", async () => {
    // A revision list belongs to the file it was fetched for. Left standing, it
    // would offer to revert the previous row's Schema from under the new row's
    // header — and `revisions !== null` would stop the expand re-fetching.
    await renderShell();
    await dock();
    await expandHistory();
    expect(listings()).toBe(1);

    // Re-clicking undocks; clicking again docks on a fresh read.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});
    await dock();

    expect(historyToggle()?.getAttribute("aria-expanded")).toBe("false");
    await expandHistory();
    expect(listings()).toBe(2);
  });
});

describe("expanding lists the revisions, once", () => {
  it("fires exactly one listing however often it is toggled", async () => {
    await renderShell();
    await dock();

    await expandHistory();
    expect(listings()).toBe(1);
    // NEWEST FIRST, asserted as ORDER rather than as presence: the route lists
    // it that way, the copy says so, and two fixtures matched by presence alone
    // pass just as well reversed.
    expect(rowLabels()).toHaveLength(2);
    expect(rowLabels()[0]).toContain(artifactRevisionDate(NEWER));
    expect(rowLabels()[1]).toContain(artifactRevisionDate(OLDER));
    expect(rowLabels()[0]).toContain("replaced by the Reading Scenario Template");
    // …and the older, unattributed one carries neither optional field rather
    // than printing them empty.
    expect(rowLabels()[1]).toBe(
      `${artifactRevisionDate(OLDER)} · ${artifactRevisionSize(OLDER)}`,
    );
    expect(screen.getByText(/replaced by the Reading Scenario Template/)).toBeTruthy();
    expect(screen.getByText(new RegExp(artifactRevisionSize(NEWER)))).toBeTruthy();
    expect(screen.getByText(/yuanhao/)).toBeTruthy();
    expect(historyToggle()?.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(historyToggle()!);
    await act(async () => {});
    fireEvent.click(historyToggle()!);
    await act(async () => {});
    // Collapsing and re-expanding is not a second read: the rows are already
    // held, and re-requesting them would put a fetch behind every toggle.
    expect(listings()).toBe(1);
  });

  it("says an EMPTY history is empty, rather than showing a failure", async () => {
    listAnswer = () => ok({ revisions: [] });
    await renderShell();
    await dock();
    await expandHistory();

    expect(screen.getByText(PREVIEW_HISTORY_EMPTY_COPY)).toBeTruthy();
    expect(screen.queryByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })).toBeNull();
    expect(screen.queryByText(PREVIEW_HISTORY_FAILED_COPY)).toBeNull();
  });

  it("shows the SERVER's sentence when the listing is refused", async () => {
    listAnswer = () => refusal(403, "Only the workspace owner can edit the Schema.");
    await renderShell();
    await dock();
    await expandHistory();

    expect(screen.getByRole("alert").textContent).toBe(
      "Only the workspace owner can edit the Schema.",
    );
    // …and NOT the empty-history note, which would claim nothing was saved.
    expect(screen.queryByText(PREVIEW_HISTORY_EMPTY_COPY)).toBeNull();
  });

  it("retries the listing on the next expand after a failure", async () => {
    // A failed listing leaves the rows unheld, so the panel is not stuck
    // reporting an outage that is over.
    listAnswer = () => refusal(500, "");
    await renderShell();
    await dock();
    await expandHistory();
    expect(screen.getByRole("alert").textContent).toBe(PREVIEW_HISTORY_FAILED_COPY);

    fireEvent.click(historyToggle()!);
    await act(async () => {});
    listAnswer = () => ok({ revisions: [NEWER] });
    await expandHistory();

    expect(listings()).toBe(2);
    expect(screen.getByText(/replaced by the Reading Scenario Template/)).toBeTruthy();
  });
});

describe("viewing one revision toggles", () => {
  it("shows the bytes, then hides them when pressed again", async () => {
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })[0]);
    await act(async () => {});

    expect(document.querySelector(".wb-preview-history-content")?.textContent).toBe(
      "## Page conventions\n\nold bytes",
    );
    // The control says what pressing it does NOW.
    const hide = screen.getByRole("button", { name: PREVIEW_HISTORY_HIDE_COPY });
    expect(hide.getAttribute("aria-expanded")).toBe("true");

    fireEvent.click(hide);
    await act(async () => {});
    expect(document.querySelector(".wb-preview-history-content")).toBeNull();
    // A toggle-off is not a second read.
    expect(revisionCalls.filter((call) => call.url.includes("timestamp=")).length).toBe(1);
  });

  it("closes the view and says why when the read is refused", async () => {
    viewAnswer = () => refusal(404, "revision not found: 1700000002000");
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })[0]);
    await act(async () => {});

    // Closed rather than standing empty: an expanded entry showing nothing is
    // indistinguishable from a revision that is genuinely empty.
    expect(document.querySelector(".wb-preview-history-content")).toBeNull();
    expect(screen.queryByRole("button", { name: PREVIEW_HISTORY_HIDE_COPY })).toBeNull();
    expect(screen.getByRole("alert").textContent).toBe("revision not found: 1700000002000");
  });
});

describe("revert is confirm-gated, then re-lists", () => {
  it("asks first, and writes nothing until the dialog is confirmed", async () => {
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
    await act(async () => {});

    expect(screen.getByRole("dialog")).toBeTruthy();
    expect(screen.getByText(PREVIEW_HISTORY_REVERT_CONFIRM_TITLE)).toBeTruthy();
    // Nothing has been written: the POST is the confirm's, not the button's.
    expect(revisionCalls.some((call) => call.method === "POST")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(revisionCalls.some((call) => call.method === "POST")).toBe(false);
  });

  it("posts the revert, nudges the refresh signal, and re-lists", async () => {
    const checks = vi.fn();
    const unsubscribe = subscribeDataVersionCheck(checks);
    try {
      await renderShell();
      await dock();
      await expandHistory();
      const before = checks.mock.calls.length;

      fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
      await act(async () => {});
      listAnswer = () => ok({ revisions: [NEWER, OLDER, { ...NEWER, timestamp: 1_700_000_003_000, reason: "reverted" }] });
      fireEvent.click(
        screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
      );
      await act(async () => {});

      const post = revisionCalls.find((call) => call.method === "POST");
      expect(post?.url).toBe("/api/workbench/artifact/revisions?path=schema.md");
      // The dialog is gone and the panel is still open.
      expect(screen.queryByRole("dialog")).toBeNull();
      // The SAME signal a landed save fires: the body refetches through the
      // column's one fetch effect, never through a second read of this panel's.
      expect(checks.mock.calls.length).toBeGreaterThan(before);
      // …and the list is re-read, because the revert added an entry.
      expect(listings()).toBe(2);
      expect(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })).toHaveLength(3);
    } finally {
      unsubscribe();
    }
  });

  it("keeps the panel open holding the server's sentence when the revert fails", async () => {
    revertAnswer = () => refusal(400, "The Schema must keep a Page conventions section.");
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
    await act(async () => {});

    expect(screen.getByRole("alert").textContent).toBe(
      "The Schema must keep a Page conventions section.",
    );
    // Nothing landed, so nothing is re-listed.
    expect(listings()).toBe(1);
    expect(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })).toHaveLength(2);
  });

  it("never has two overlays open at once (UX-DR17)", async () => {
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
    await act(async () => {});
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByText(PREVIEW_HISTORY_REVERT_CONFIRM_TITLE)).toBeTruthy();
  });
});

describe("a read-only deployment refuses BEFORE the confirm (DW-149)", () => {
  const READ_ONLY: WorkbenchData = { ...DATA, readOnly: true };

  it("still lists — history is a read the route answers either way", async () => {
    await renderShell(READ_ONLY);
    await dock();
    await expandHistory();

    expect(listings()).toBe(1);
    expect(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })).toHaveLength(2);
    // Hiding the list would tell the owner nothing except that they cannot look.
    expect(screen.getByText(PREVIEW_HISTORY_READ_ONLY_COPY)).toBeTruthy();
  });

  it("opens no dialog and sends no request when Revert is pressed", async () => {
    await renderShell(READ_ONLY);
    await dock();
    await expandHistory();

    const revert = screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0];
    // In the tab order and pointed at the sentence that explains it — the
    // `RevisionItem` idiom: `aria-disabled`, never `disabled`, so a reader can
    // reach the explanation rather than meeting a control that is simply gone.
    expect(revert.getAttribute("aria-disabled")).toBe("true");
    const describedBy = revert.getAttribute("aria-describedby");
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy!)?.textContent).toBe(
      PREVIEW_HISTORY_READ_ONLY_COPY,
    );

    fireEvent.click(revert);
    await act(async () => {});

    // A dialog the owner has to answer is the harm, and the answer changes
    // nothing: the route's 403 is the backstop, not the refusal they meet.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(revisionCalls.some((call) => call.method === "POST")).toBe(false);
  });

  it("still lets an entry be VIEWED — reading is not writing", async () => {
    await renderShell(READ_ONLY);
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })[0]);
    await act(async () => {});

    expect(document.querySelector(".wb-preview-history-content")?.textContent).toBe(
      "## Page conventions\n\nold bytes",
    );
  });
});

describe("a request that lands late never lands on the wrong row (DW-214)", () => {
  it("drops a listing that resolves after the owner picked another row", async () => {
    // The race: the reset block sets `revisions` back to `null`, then the old
    // row's listing resolves and latches ITS history under the new row's
    // header — and because the expand-once rule keys off `revisions !== null`,
    // the new row would then never fetch its own.
    const slow = deferred<unknown>();
    listAnswer = () => slow.promise;
    await renderShell();
    await dock();

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_COPY }));
    await act(async () => {});
    expect(screen.getByText(PREVIEW_HISTORY_LOADING_COPY)).toBeTruthy();

    // Leave the row and come back: `plan.reset` runs, and the token moves.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});
    await dock();

    // …and only NOW does the abandoned listing answer, with two rows.
    listAnswer = () => ok({ revisions: [OLDER] });
    await act(async () => {
      slow.resolve(ok({ revisions: [NEWER, OLDER] }));
    });

    // It did not latch. The panel is collapsed and unfetched, so expanding
    // fetches THIS row's answer — one row, not the abandoned two.
    expect(historyToggle()?.getAttribute("aria-expanded")).toBe("false");
    await expandHistory();
    expect(rowLabels()).toHaveLength(1);
    expect(rowLabels()[0]).toContain(artifactRevisionDate(OLDER));
  });

  it("gives every request a deadline, so a hung one cannot strand the panel", async () => {
    // `finally` cannot rescue a promise that never settles: without a deadline
    // a hung listing leaves `Loading earlier versions…` standing for the rest
    // of the session, a hung view freezes its row, and a hung revert disables
    // every Revert control with no way back but a reload. What a mount can
    // observe is that the column ARMS one on all three — the helpers' end of
    // the contract is `workbench-preview.test.ts`'.
    await renderShell();
    await dock();
    await expandHistory();
    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })[0]);
    await act(async () => {});
    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    );
    await act(async () => {});

    const kinds = new Set(
      revisionCalls.map((call) =>
        call.method === "POST" ? "revert" : call.url.includes("timestamp=") ? "view" : "list",
      ),
    );
    expect([...kinds].sort()).toEqual(["list", "revert", "view"]);
    for (const call of revisionCalls) {
      expect(call.signal, `${call.method} ${call.url}`).toBeInstanceOf(AbortSignal);
    }
  });
});

describe("a landed save adds a revision, so the panel re-lists (DW-214)", () => {
  it("re-reads the list after Save and shows the entry the save created", async () => {
    await renderShell();
    await dock();
    await expandHistory();
    expect(listings()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "## Page conventions\n\nrewritten" },
    });
    // What the route would list once the save's own snapshot has landed.
    listAnswer = () => ok({ revisions: [SAVED_BY_EDIT, NEWER, OLDER] });
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    // Without this the panel silently omitted the version the owner is most
    // likely to want back — and collapse/re-expand did not fetch it either.
    expect(listings()).toBe(2);
    expect(rowLabels()).toHaveLength(3);
    expect(rowLabels()[0]).toContain("the bytes the owner's own save replaced");
  });

  it("invalidates rather than re-reads when the panel is CLOSED", async () => {
    await renderShell();
    await dock();
    await expandHistory();
    fireEvent.click(historyToggle()!);
    await act(async () => {});
    expect(listings()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "## Page conventions\n\nrewritten" },
    });
    listAnswer = () => ok({ revisions: [SAVED_BY_EDIT, NEWER, OLDER] });
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    // No request for a panel nobody is looking at…
    expect(listings()).toBe(1);
    // …but the cache is dropped, so the next expand does not serve a stale list.
    await expandHistory();
    expect(listings()).toBe(2);
    expect(rowLabels()).toHaveLength(3);
  });
});

/**
 * DW-376 on this panel: the write whose OUTCOME NOBODY KNOWS.
 *
 * `workbench-preview.test.ts` executes both clients and asserts they answer
 * `{ unconfirmed: true }`. What only a mounted shell can show is what the PANEL
 * does with it — and here that is the whole deliverable, because a landed write
 * snapshots the bytes it replaces (DW-59), so the cached list is one entry short
 * and the expand-once rule (`revisions !== null`) never refetches it on its own.
 * The owner, sent by the sentence to "check what the screen shows", would be
 * looking at a list missing exactly the entry they want back.
 */
describe("a write nothing came back from still reconciles the panel (DW-376)", () => {
  const UNCONFIRMED: ReadonlyArray<readonly [string, () => unknown]> = [
    // A proxy's page, which is NOT the route's verdict and is never relayed.
    ["a gateway that gave up", () => refusal(502, "<html>Bad Gateway</html>")],
    ["a dropped connection", () => new TypeError("Failed to fetch")],
  ];

  for (const [label, answer] of UNCONFIRMED) {
    it(`re-lists, nudges dataVersion and KEEPS the sentence after ${label}`, async () => {
      const checks = vi.fn();
      const unsubscribe = subscribeDataVersionCheck(checks);
      try {
        revertAnswer = answer;
        await renderShell();
        await dock();
        await expandHistory();
        expect(listings()).toBe(1);
        const before = checks.mock.calls.length;

        fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
        await act(async () => {});
        // What the route would list if the revert DID land — which is the case
        // this branch exists for, and the one the panel cannot rule out.
        listAnswer = () =>
          ok({ revisions: [{ ...SAVED_BY_EDIT, reason: "reverted" }, NEWER, OLDER] });
        fireEvent.click(
          screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
        );
        await act(async () => {});

        // The list is re-read: the revert may have added an entry, and the list
        // is the only place this panel can find out whether it did.
        expect(listings()).toBe(2);
        expect(rowLabels()).toHaveLength(3);
        // …and the shell is asked to re-check `dataVersion`, which is how the
        // body, the tree and the header learn about bytes nobody confirmed.
        expect(checks.mock.calls.length).toBeGreaterThan(before);

        // THE ordering trap. `loadRevisions` clears `historyError` on entry, so
        // a sentence set before the re-list would be silently wiped by the very
        // reconciliation that was supposed to help. The sentence that SURVIVES
        // must be the unknown-outcome one.
        const alert = screen.getByRole("alert");
        expect(alert.textContent).toContain("outcome is unknown");
        expect(alert.textContent).toContain("revert the Schema");
        // Never `This Schema couldn’t be reverted.` — it says nothing was
        // written, which is the one claim nobody is in a position to make.
        expect(alert.textContent).not.toBe(PREVIEW_HISTORY_REVERT_FAILED_COPY);
        expect(alert.textContent).not.toContain("Bad Gateway");
        expect(alert.textContent).not.toContain("Failed to fetch");
        // And NOT the success announcement: `Reverted.` says it happened.
        expect(columnAnnounced()).not.toBe(PREVIEW_HISTORY_REVERTED_COPY);
      } finally {
        unsubscribe();
      }
    });

    it(`invalidates the cached list after a SAVE answered by ${label}`, async () => {
      // The save half of the same fact, and the one the panel is quietest
      // about: an unconfirmed Schema save that in fact landed leaves this list
      // one entry short, and collapse/re-expand would not fetch it either.
      writeAnswer = answer;
      await renderShell();
      await dock();
      await expandHistory();
      expect(listings()).toBe(1);

      fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
      fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
      await act(async () => {});
      fireEvent.change(screen.getByRole("textbox"), {
        target: { value: "## Page conventions\n\nrewritten" },
      });
      listAnswer = () => ok({ revisions: [SAVED_BY_EDIT, NEWER, OLDER] });
      fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
      await act(async () => {});

      // The re-list fires even though the panel is hidden behind the open
      // editor: `refreshHistory` keys off whether the owner has EXPANDED it, not
      // off whether it happens to be rendered right now.
      expect(listings()).toBe(2);
      // The editor stays open holding the text, with the unknown-outcome
      // sentence beside it — the panel reconciling is not the save succeeding.
      expect(screen.getByRole("textbox")).toBeTruthy();
      expect(screen.getByText(/outcome is unknown/)).toBeTruthy();

      // …and when the owner does go and look, the entry a landed save would
      // have created is there, with no further request needed.
      await closeEditor();
      expect(listings()).toBe(2);
      expect(rowLabels()).toHaveLength(3);
      expect(rowLabels()[0]).toContain("the bytes the owner's own save replaced");
    });
  }

  it("drops the cache rather than fetching when the panel is CLOSED", async () => {
    // `refreshHistory`, not `loadRevisions`: an unconfirmed save must cost no
    // request the owner did not ask for, and must still not serve a stale list
    // on the next expand.
    writeAnswer = () => refusal(504, "");
    await renderShell();
    await dock();
    await expandHistory();
    fireEvent.click(historyToggle()!);
    await act(async () => {});
    expect(listings()).toBe(1);

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "## Page conventions\n\nrewritten" },
    });
    listAnswer = () => ok({ revisions: [SAVED_BY_EDIT, NEWER, OLDER] });
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    // No request for a panel nobody is looking at…
    expect(listings()).toBe(1);
    // …but the cache is dropped, so the next expand fetches rather than serving
    // a list that is missing the entry a landed save would have created.
    await closeEditor();
    await expandHistory();
    expect(listings()).toBe(2);
    expect(rowLabels()).toHaveLength(3);
  });

  it("leaves NO revert sentence behind when the owner re-points the panel mid-re-list", async () => {
    // The token has to be read again on the FAR side of the re-list's await.
    // The owner can pick another row while it is in flight, and the reset that
    // follows a pick bumps `revertRequestRef` precisely so a straggler cannot
    // write into a panel that has been re-pointed. Without the second check the
    // PREVIOUS row's revert message sits waiting inside the NEW row's History,
    // which is why the pick here moves to a different row rather than undocking:
    // an undock-and-redock resets the column twice and would clear the message
    // whether the guard exists or not.
    const slowList = deferred<unknown>();
    revertAnswer = () => refusal(502, "");
    await renderShell(TWO_ROWS);
    await dock();
    await expandHistory();

    fireEvent.click(screen.getAllByRole("button", { name: PREVIEW_HISTORY_REVERT_COPY })[0]);
    await act(async () => {});
    // The re-list this revert fires never settles until the row has moved.
    listAnswer = () => slowList.promise;
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }));
    await act(async () => {});
    // It is genuinely in flight: nothing has come back for it yet.
    expect(listings()).toBe(2);

    // …and the owner moves to ANOTHER row, which re-points the whole column.
    fireEvent.click(screen.getByRole("button", { name: "Beta" }));
    await act(async () => {});

    // Beta's own History is expanded and settled FIRST. This is what makes the
    // leak observable at all: `historyError` renders only inside an OPEN panel,
    // and `loadRevisions` clears it on entry — so a straggler landing before
    // this expand would be wiped by the expand's own listing, and the test would
    // pass with or without the guard.
    listAnswer = () => ok({ revisions: [NEWER, OLDER] });
    await expandHistory();
    expect(screen.queryByRole("alert")).toBeNull();

    // ONLY NOW does the straggling re-list answer, into a panel that is open and
    // is about another file. Without the second token read, Alpha's revert
    // sentence appears here — inside Beta's History, about a write Beta's file
    // was never part of.
    slowList.resolve(ok({ revisions: [NEWER, OLDER] }));
    await act(async () => {});

    expect(screen.queryByText(/outcome is unknown/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("a revert in flight is scoped, guarded and announced (DW-214)", () => {
  it("marks only the row being written, and disables the rest without lying about them", async () => {
    const slow = deferred<unknown>();
    revertAnswer = () => slow.promise;
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    );
    await act(async () => {});

    const [first, second] = revertButtons();
    // The row actually being written says so; the other one does not claim to
    // be busy and does not carry the label of a write it is not running.
    expect(first.textContent).toBe(PREVIEW_HISTORY_REVERTING_COPY);
    expect(first.getAttribute("aria-busy")).toBe("true");
    expect(second.textContent).toBe(PREVIEW_HISTORY_REVERT_COPY);
    expect(second.getAttribute("aria-busy")).toBeNull();
    // Both are still disabled: a SECOND concurrent write is what that prevents.
    expect((second as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      slow.resolve(ok({ ok: true }));
    });
    expect(revertButtons()[0].textContent).toBe(PREVIEW_HISTORY_REVERT_COPY);
  });

  it("withholds Edit while the revert is in flight", async () => {
    // Revert → Confirm → Edit → Confirm used to seed the editor from the
    // PRE-REVERT bytes and version, so when the revert landed the owner's own
    // Save came back as a conflict they caused from this panel.
    const slow = deferred<unknown>();
    revertAnswer = () => slow.promise;
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    );
    await act(async () => {});

    const edit = screen.getByRole("button", { name: PREVIEW_EDIT_COPY }) as HTMLButtonElement;
    expect(edit.disabled).toBe(true);
    // …and the action refuses too, not only the affordance: driven through the
    // gate the button would open, no editor is seeded.
    fireEvent.click(edit);
    await act(async () => {});
    expect(screen.queryByRole("textbox")).toBeNull();

    await act(async () => {
      slow.resolve(ok({ ok: true }));
    });
    expect(
      (screen.getByRole("button", { name: PREVIEW_EDIT_COPY }) as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  it("puts focus somewhere real when the gate closes into the write", async () => {
    // `useDialogA11y` restores to the OPENER when it is still connected — and
    // it is, now disabled — so `.focus()` is a no-op and `fallbackFocusRef` is
    // never reached. Focus would sit on `<body>` for the whole write.
    const slow = deferred<unknown>();
    revertAnswer = () => slow.promise;
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    );
    await act(async () => {});

    expect(document.activeElement).not.toBe(document.body);
    expect(document.activeElement).toBe(historyToggle());

    await act(async () => {
      slow.resolve(ok({ ok: true }));
    });
  });

  it("announces the restore, which is the one success this panel can produce", async () => {
    await renderShell();
    await dock();
    await expandHistory();
    expect(columnAnnounced()).toBe("");

    fireEvent.click(revertButtons()[0]);
    await act(async () => {});
    fireEvent.click(
      screen.getByRole("button", { name: PREVIEW_HISTORY_REVERT_CONFIRM_LABEL }),
    );
    await act(async () => {});

    // Every failure here is a `role="alert"`; the destructive SUCCESS used to
    // be the one outcome a reader was told nothing about.
    expect(columnAnnounced()).toBe(PREVIEW_HISTORY_REVERTED_COPY);
  });
});

describe("the gate names the version, and the panel is reachable by keyboard", () => {
  it("says WHICH entry Restore would restore", async () => {
    await renderShell();
    await dock();
    await expandHistory();

    fireEvent.click(revertButtons()[1]);
    await act(async () => {});

    const dialog = screen.getByRole("dialog");
    // The OLDER row was pressed, so the OLDER row is what the sentence names —
    // in a column of identical Revert buttons this is the only thing that says
    // which one opened it.
    expect(dialog.textContent).toContain(artifactRevisionLabel(OLDER));
    expect(dialog.textContent).not.toContain(artifactRevisionLabel(NEWER));
  });

  it("gives both scrolling regions focus and a name, and points View at what it opens", async () => {
    await renderShell();
    await dock();
    await expandHistory();

    const panel = document.querySelector<HTMLElement>(".wb-preview-history-panel")!;
    // A scrollable box with no focusable descendant cannot be scrolled by
    // keyboard alone (WCAG 2.1.1), and an unnamed one is announced as nothing.
    expect(panel.getAttribute("tabindex")).toBe("0");
    expect(panel.getAttribute("aria-label")).toBe(PREVIEW_HISTORY_COPY);

    const view = screen.getAllByRole("button", { name: PREVIEW_HISTORY_VIEW_COPY })[0];
    expect(view.getAttribute("aria-expanded")).toBe("false");
    // Collapsed, it controls nothing — an `aria-controls` resolving to no
    // element is worse than none.
    expect(view.getAttribute("aria-controls")).toBeNull();

    fireEvent.click(view);
    await act(async () => {});

    const opened = screen.getByRole("button", { name: PREVIEW_HISTORY_HIDE_COPY });
    const controls = opened.getAttribute("aria-controls");
    expect(controls).toBeTruthy();
    const pre = document.getElementById(controls!)!;
    expect(pre.tagName).toBe("PRE");
    expect(pre.getAttribute("tabindex")).toBe("0");
    expect(pre.getAttribute("aria-label")).toBe(artifactRevisionDate(NEWER));
  });
});
