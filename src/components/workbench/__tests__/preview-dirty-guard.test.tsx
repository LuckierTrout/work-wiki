import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  PREVIEW_CLOSED_COPY,
  PREVIEW_DISCARD_CONFIRM_LABEL,
  PREVIEW_DISCARD_CONFIRM_TITLE,
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_EDIT_COPY,
  PREVIEW_KEEP_EDITING_COPY,
  PREVIEW_SAVE_COPY,
} from "@/lib/workbench-preview";
import { WRITE_CONFLICT_COPY } from "@/lib/write-precondition";
import { buildFileTree } from "@/lib/workbench-tree";
import {
  WORKBENCH_TREE_TAB_KEY,
  writeStoredSelection,
  writeStoredTreeTab,
} from "@/lib/workbench-state";

/**
 * DW-36 and DW-46 — the two ways the tree selection mishandled a pick, observed
 * on a mounted shell.
 *
 * Both are only visible here. The DECISIONS are pure functions with node tests
 * of their own (`previewDraftDirty`, `selectionTab`, `restorableSelection` in
 * `workbench-preview.test.ts` and `workbench-split.test.ts`); what no node suite
 * can show is that the shell actually HOLDS the pick at the moment it is made —
 * a held pick is a selection that did not move, an editor that still has its
 * text, and a row that still carries `aria-current`, none of which exists
 * outside a rendered tree.
 *
 * The harness is `preview-announcements.test.tsx`'s, deliberately: one fetch
 * stub routing `/api/workbench/preview` to a reassignable `answer`, and an
 * `afterEach` that unmounts BEFORE the globals are restored.
 */

// ONE stable router object — several components key effects on its identity.
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

/** What the route answers for a readable, editable page. */
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

let answer: () => unknown = () => ({
  ok: true,
  status: 200,
  json: async () => payload("Alpha", "# Alpha"),
});

beforeEach(() => {
  window.localStorage.clear();
  answer = () => ({
    ok: true,
    status: 200,
    json: async () => payload("Alpha", "# Alpha"),
  });
  // The sidecar probe shares this global with the Preview read; only the preview
  // URL is routed to `answer`, so the probe stays off the network and its
  // setState settles inside `act`.
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const href = String(url);
      if (href.includes("/api/workbench/preview")) {
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
  // file's own `cleanup()` lands after this. Unmounting here tears the tree down
  // while `fetch` is still stubbed.
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

function row(name: string): HTMLElement {
  return screen.getByRole("button", { name });
}

/** The SHELL's polite region — the child combinator excludes the column's own. */
function announced(): string {
  const regions = document.querySelectorAll('.wb-shell > .wb-sr-only[aria-live="polite"]');
  return regions[regions.length - 1]?.textContent ?? "";
}

function preview(): HTMLElement | null {
  return screen.queryByRole("complementary", { name: "Preview" });
}

function editor(): HTMLTextAreaElement | null {
  return screen.queryByRole("textbox") as HTMLTextAreaElement | null;
}

/** Which tree row, if any, is marked current. */
function currentRow(): string | null {
  return document.querySelector(".wb-tree-row[aria-current='true']")?.textContent ?? null;
}

function dialog(): HTMLElement | null {
  return screen.queryByRole("dialog");
}

/** Open the confirm-gated editor on the docked row and type into it. */
async function typeIntoEditor(text: string) {
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
  await act(async () => {});
  const textarea = editor();
  expect(textarea).toBeTruthy();
  fireEvent.change(textarea!, { target: { value: text } });
  await act(async () => {});
}

describe("a pick made while the editor is dirty is held (DW-36)", () => {
  it("changes nothing at all and opens the discard confirm", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# Alpha, rewritten by hand");
    const said = announced();

    fireEvent.click(row("Beta"));
    await act(async () => {});

    // THE bug: the column's fetch effect calls `setEditing(false)` on every new
    // pick, so one stray click used to destroy the draft with nothing said.
    expect(editor()?.value).toBe("# Alpha, rewritten by hand");
    // The selection did not move — the old row is still the marked one, and the
    // Preview is still describing it.
    expect(currentRow()).toBe("Alpha");
    expect(preview()).toBeTruthy();
    // A held pick is not an event: nothing is announced, because nothing
    // happened yet.
    expect(announced()).toBe(said);
    // …and the loss is named on screen.
    expect(dialog()).toBeTruthy();
    expect(screen.getByText(PREVIEW_DISCARD_CONFIRM_TITLE)).toBeTruthy();
  });

  it("applies the held pick when the owner discards", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# scratch");

    fireEvent.click(row("Beta"));
    await act(async () => {});
    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Beta", "# Beta"),
    });
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_DISCARD_CONFIRM_LABEL }));
    await act(async () => {});

    expect(dialog()).toBeNull();
    // The pick the owner made, applied exactly as an unguarded one would be.
    expect(currentRow()).toBe("Beta");
    expect(announced()).toBe("Preview, Beta");
    // The editor is gone — that is what "discard" bought — and the new row's
    // bytes are on screen.
    expect(editor()).toBeNull();
    expect(document.querySelector(".wb-preview-body")?.textContent).toContain("Beta");
  });

  it("keeps the draft, the row and the silence when the owner cancels", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# still mine");
    const said = announced();

    fireEvent.click(row("Beta"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_KEEP_EDITING_COPY }));
    await act(async () => {});

    expect(dialog()).toBeNull();
    expect(editor()?.value).toBe("# still mine");
    expect(currentRow()).toBe("Alpha");
    expect(announced()).toBe(said);
  });

  it("cancels on Esc too, and never stacks a second overlay", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# still mine");

    fireEvent.click(row("Beta"));
    await act(async () => {});
    // Exactly ONE overlay at every moment (UX-DR17): the discard gate opens only
    // while the editor is open, and the column's own edit gate is reachable only
    // from an `Edit` button that renders `canEdit && !editing`.
    expect(screen.getAllByRole("dialog")).toHaveLength(1);

    fireEvent.keyDown(document, { key: "Escape" });
    await act(async () => {});

    expect(dialog()).toBeNull();
    expect(editor()?.value).toBe("# still mine");
    expect(currentRow()).toBe("Alpha");
  });

  it("holds a re-pick of the row already showing, which would undock", async () => {
    // The case a guard written as "is this a DIFFERENT row?" lets straight
    // through: re-picking deselects, which unmounts the column and takes the
    // editor with it — the same loss by another route.
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# about to vanish");

    fireEvent.click(row("Alpha"));
    await act(async () => {});

    expect(dialog()).toBeTruthy();
    expect(preview()).toBeTruthy();
    expect(editor()?.value).toBe("# about to vanish");

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_DISCARD_CONFIRM_LABEL }));
    await act(async () => {});

    expect(preview()).toBeNull();
    expect(currentRow()).toBeNull();
    expect(announced()).toBe(PREVIEW_CLOSED_COPY);
  });

  it("does not gate a pick made with the editor open but untouched", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
    await act(async () => {});
    expect(editor()).toBeTruthy();

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => payload("Beta", "# Beta"),
    });
    fireEvent.click(row("Beta"));
    await act(async () => {});

    // Nothing was typed, so nothing is at stake and a confirm would be a click
    // charged for no reason.
    expect(dialog()).toBeNull();
    expect(currentRow()).toBe("Beta");
    expect(announced()).toBe("Preview, Beta");
  });

  it("does not gate a pick made with no editor at all", async () => {
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    fireEvent.click(row("Beta"));
    await act(async () => {});

    expect(dialog()).toBeNull();
    expect(currentRow()).toBe("Beta");
  });

  it("stops gating once the column that held the draft is gone", async () => {
    // A tab switch undocks the Preview and unmounts the editor with it. A shell
    // still holding `true` would then gate the NEXT pick — on another tab,
    // against a textarea that no longer exists — behind a confirm nobody could
    // explain.
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# unsaved");

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await act(async () => {});
    expect(preview()).toBeNull();

    answer = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        name: "x.md",
        path: "raw/x.md",
        format: "markdown" as const,
        body: "# x",
        truncated: false,
        editable: false,
      }),
    });
    fireEvent.click(row("x.md"));
    await act(async () => {});

    expect(dialog()).toBeNull();
    expect(preview()).toBeTruthy();
    expect(currentRow()).toBe("x.md");
  });
});

describe("a restored row lands on the tab that can mark it (DW-46)", () => {
  it("corrects a stored page paired with a stored Files tab", async () => {
    // `wikilinkSelection` produces this pairing on purpose: a link followed on
    // the Files tab whose `wiki/<slug>.md` node is absent resolves to a PAGE
    // row. Stored and restored verbatim, the Preview described a row the showing
    // tree could not mark — and the mount effect's restore signature then armed
    // the reset effect's guard so nothing would ever clear it.
    writeStoredTreeTab("files");
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });

    await renderShell();

    // The tab was corrected to the one whose tree contains the row…
    expect(screen.getByRole("tab", { name: "Knowledge" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
      "false",
    );
    // …the row is restored AND visibly current…
    expect(preview()).toBeTruthy();
    expect(currentRow()).toBe("Alpha");
    // …and silently, because a restore is not a change the owner made.
    expect(announced()).toBe("");
  });

  it("re-arms the reset effect, so a later tab switch still undocks", async () => {
    // The half that fails invisibly: armed with the STORED tab, the signature
    // the guard waits for never arrives, so the guard returns forever and the
    // reset effect stops clearing for the rest of the session.
    writeStoredTreeTab("files");
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    await renderShell();
    expect(preview()).toBeTruthy();

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    await act(async () => {});

    expect(preview()).toBeNull();
    expect(currentRow()).toBeNull();
  });

  it("leaves the tab alone when the stored pair already agrees", async () => {
    writeStoredTreeTab("files");
    writeStoredSelection(WIKI_ID, { kind: "file", path: "raw/x.md" });

    await renderShell();

    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(preview()).toBeTruthy();
    expect(currentRow()).toBe("x.md");
  });

  it("does not write the correction down over the owner's tab choice", async () => {
    // The correction is a pure function of the restored row, so a reload
    // reproduces it. Persisted, it would silently replace the tab the owner last
    // chose with one they never picked — and the next session would open on it
    // even after the stored row was gone.
    writeStoredTreeTab("files");
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    const stored = window.localStorage.getItem(WORKBENCH_TREE_TAB_KEY);

    await renderShell();

    expect(window.localStorage.getItem(WORKBENCH_TREE_TAB_KEY)).toBe(stored);
  });

  it("restores nothing, and touches no tab, when the row is gone", async () => {
    writeStoredTreeTab("files");
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "ghost" });

    await renderShell();

    expect(preview()).toBeNull();
    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
      "true",
    );
  });
});

// ---------------------------------------------------------------------------
// A REFUSED save keeps the draft too (DW-38, DW-51)
// ---------------------------------------------------------------------------
//
// The same property DW-36 protects from a stray tree click, protected from the
// other direction: the server saying no. `savePreviewBody`'s "resolve, do not
// throw" contract and the sentence-relaying rule are executed in
// `workbench-preview.test.ts`; what only a mounted shell can show is that the
// textarea still HOLDS the owner's text afterwards, with the server's sentence
// beside it rather than in place of it.

describe("a save the write precondition refuses (DW-38, DW-51)", () => {
  const SEEDED_VERSION = "w1:8-0123456789abcdef";

  /** The preview read carries a version; the write answers 412 with the copy. */
  function stubConflict(writes: Array<{ url: string; headers: Record<string, string> }>) {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string> }) => {
        const href = String(url);
        if (href.includes("/api/workbench/preview")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...payload("Alpha", "# Alpha"), version: SEEDED_VERSION }),
          } as unknown as Response;
        }
        if (href.includes("/api/wiki/")) {
          writes.push({ url: href, headers: init?.headers ?? {} });
          return {
            ok: false,
            status: 412,
            json: async () => ({ error: WRITE_CONFLICT_COPY }),
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
  }

  it("keeps the owner's text on screen and shows the SERVER's sentence beside it", async () => {
    const writes: Array<{ url: string; headers: Record<string, string> }> = [];
    stubConflict(writes);
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# Alpha, rewritten by hand");

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    // The whole point: a refused save is not the thing that loses the draft.
    expect(editor()?.value).toBe("# Alpha, rewritten by hand");
    // …and the sentence is the SERVER's, relayed verbatim — the column types no
    // conflict wording of its own.
    expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy();
    // The editor is still open, so the owner can copy their text out.
    expect(screen.getByRole("button", { name: PREVIEW_SAVE_COPY })).toBeTruthy();
  });

  it("lets the owner save AGAIN without a reload — the second save is not stale", async () => {
    // A tiny store that enforces the precondition exactly as the route does, so
    // "the second save succeeded" is evidence rather than a stub being lenient:
    // a column that kept sending the version it was first seeded with would be
    // refused here, which is the state this criterion exists to rule out.
    let stored = { body: "# Alpha", version: SEEDED_VERSION };
    const outcomes: number[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
        const href = String(url);
        if (href.includes("/api/workbench/preview")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ ...payload("Alpha", stored.body), version: stored.version }),
          } as unknown as Response;
        }
        if (href.includes("/api/wiki/")) {
          const sent = init?.headers?.["If-Match"];
          if (sent !== `"${stored.version}"`) {
            outcomes.push(412);
            return {
              ok: false,
              status: 412,
              json: async () => ({ error: WRITE_CONFLICT_COPY }),
            } as unknown as Response;
          }
          const content = JSON.parse(init?.body ?? "{}").content as string;
          stored = { body: content, version: `${SEEDED_VERSION}-${outcomes.length}` };
          outcomes.push(200);
          return {
            ok: true,
            status: 200,
            json: async () => ({ slug: "alpha", version: stored.version }),
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
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});

    await typeIntoEditor("# Alpha, first");
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});
    // The editor closed on a landed save, so this is a genuine second round.
    expect(editor()).toBeNull();

    await typeIntoEditor("# Alpha, second");
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    expect(outcomes).toEqual([200, 200]);
    expect(stored.body).toBe("# Alpha, second");
    // No conflict sentence anywhere: the second save was not refused.
    expect(screen.queryByText(WRITE_CONFLICT_COPY)).toBeNull();
    expect(editor()).toBeNull();
  });

  it("sent the version the editor was SEEDED with", async () => {
    const writes: Array<{ url: string; headers: Record<string, string> }> = [];
    stubConflict(writes);
    await renderShell();
    fireEvent.click(row("Alpha"));
    await act(async () => {});
    await typeIntoEditor("# Alpha, rewritten by hand");

    fireEvent.click(screen.getByRole("button", { name: PREVIEW_SAVE_COPY }));
    await act(async () => {});

    expect(writes).toHaveLength(1);
    expect(writes[0].url).toContain("/api/wiki/alpha");
    expect(writes[0].headers["If-Match"]).toBe(`"${SEEDED_VERSION}"`);
  });
});
