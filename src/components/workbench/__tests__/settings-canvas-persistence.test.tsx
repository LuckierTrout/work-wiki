import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { CANVAS_ID } from "@/components/workbench/ModeCanvas";
import { SETTINGS_LABEL } from "@/lib/workbench-settings";
import {
  PREVIEW_EDIT_CONFIRM_LABEL,
  PREVIEW_EDIT_COPY,
} from "@/lib/workbench-preview";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The mode canvas SURVIVES opening Settings (DW-373), MOUNTED — and so, since
 * DW-412, do both columns beside it.
 *
 * `Workbench` used to render `SettingsCanvas` INSTEAD of `ModeCanvas`, so
 * reaching Settings — from the rail control or from `g s` — unmounted the whole
 * mode canvas and the Wiki subtree inside it, destroying an open Create Wiki
 * dialog, the name the owner had typed into it and the error it was showing.
 * Coming back rebuilt an empty card. That is the exact loss DW-26 removed for
 * mode switches, reintroduced one level up by Settings.
 *
 * The fix is DW-26's, applied to the SECTION rather than to the subtree inside
 * it: the mode canvas stays rendered and goes behind `hidden`. Hiding is not
 * closing, and that distinction is the whole design — `CreateWikiDialog` resets
 * its fields when `open` goes false, so flipping `open` to hide the dialog would
 * discard the very draft this preserves.
 *
 * `SettingsCanvas` is the one that still comes and goes: it mounts on open and
 * UNMOUNTS on close, because that unmount IS its own draft's discard.
 *
 * THE SAME MOVE, TWO COLUMNS OVER (DW-412). Opening Settings also gated
 * `PreviewColumn` off — destroying whatever unsaved markdown its editor was
 * holding — and rendered `SettingsNav` INSTEAD of `TreePanel`, which unmounted
 * the panel and with it the group and directory disclosures the owner had
 * collapsed (`closed` is that component's own state). Both are withdrawn with
 * `hidden` now instead, and the shell keeps exactly one `#wb-canvas` through it.
 *
 * AND THE TRANSITION HAS A FOCUS CONTRACT (DW-413). Opening Settings used to
 * move focus nowhere at all, so a keyboard user standing in the canvas that had
 * just gone `display: none` was dropped on `<body>` with the whole shell to Tab
 * back through. It lands on the Settings section now, from both openers.
 *
 * COVERAGE LIMIT, inherited from `wiki-canvas-persistence.test.tsx`: jsdom has
 * no layout engine and applies no user-agent stylesheet, so `hidden` here is an
 * ATTRIBUTE and nothing more — nothing mounted below can see a pixel. What it
 * can see is the contract the attribute carries (the a11y tree, via
 * testing-library's `hidden`-aware queries) and the document state a hidden
 * dialog must not be holding (`document.body.style.overflow`, the Tab trap).
 * The `display: none` that makes it a visual withdrawal is pinned in
 * `globals.css` and read from there by the last case.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them on every
// re-render. `push` is spied so its ABSENCE stays observable — `g s` must not
// navigate (DW-62).
const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

const DATA: WorkbenchData = {
  wikis: [],
  currentWikiId: null,
  registryUnavailable: false,
  knowledge: [],
  knowledgeUnavailable: false,
  files: [],
  filesUnavailable: false,
  filesTruncated: false,
  dataVersion: 0,
  readOnly: false,
};

const CREATE_CONFLICT = "A wiki with that name already exists.";

const WIKI: WikiRecord = {
  id: "wiki-1",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * A working set with a TREE in it, for the two columns beside the canvas.
 *
 * {@link DATA} is deliberately empty — that is what puts `WikiWorkbench`'s
 * empty state and its `Create Wiki` opener on screen, which every DW-373 case
 * above is built on. A Preview cannot dock against it and a Knowledge group
 * cannot be collapsed in it, so the DW-412 cases take this one instead.
 */
const TREE_DATA: WorkbenchData = {
  ...DATA,
  wikis: [WIKI],
  currentWikiId: WIKI.id,
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
};

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
  // into `?mode=` — so each test starts on a bare `/` rather than on whatever
  // mode the last one left in the URL, which `initialMode` would restore.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  // `useSidecarStatus` probes the loopback port at mount, the card's create
  // POSTs, the Settings surface reads its payload, and a docked Preview reads
  // the picked row's bytes. One stub answers all four; only the create's answer
  // and the Preview's are ever asserted on, and the Preview's is routed by URL
  // because its body is what the editor is seeded from.
  fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/workbench/preview")
      ? ({
          ok: true,
          status: 200,
          json: async () => PREVIEW_PAYLOAD,
        } as unknown as Response)
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

/**
 * The assembled shell, as `page.tsx` composes it, inside the app's real
 * dispatcher — `ClientProviders` wraps it that way, and `g s` reaches nothing
 * without it.
 */
async function renderShell(data: WorkbenchData = DATA) {
  const view = render(
    <KeyboardShortcutsProvider>
      <WorkbenchDataProvider value={data}>
        <Workbench>
          <WikiWorkbench />
        </Workbench>
      </WorkbenchDataProvider>
    </KeyboardShortcutsProvider>,
  );
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

/** A refreshed server render — the same tree with a new provider payload. */
async function refreshShell(
  view: Awaited<ReturnType<typeof renderShell>>,
  data: WorkbenchData,
) {
  view.rerender(
    <KeyboardShortcutsProvider>
      <WorkbenchDataProvider value={data}>
        <Workbench>
          <WikiWorkbench />
        </Workbench>
      </WorkbenchDataProvider>
    </KeyboardShortcutsProvider>,
  );
  await act(async () => {});
}

/** A rail control, by its accessible name. */
function rail(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/** Focus a rail control and click it, the way an owner switching surfaces does. */
function clickRail(label: string): HTMLButtonElement {
  const control = rail(label);
  control.focus();
  fireEvent.click(control);
  return control;
}

/**
 * Type a key sequence at the document, which is where the dispatcher listens.
 *
 * `document.body` rather than any control: `isInputElement` suppresses the
 * shortcut inside form fields, so aiming these at the focused dialog's name
 * field would be testing the suppression instead of the dispatch.
 */
async function press(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(document.body, { key });
  }
  await act(async () => {});
}

/**
 * The two ways in, driven identically.
 *
 * Every case below runs against both, because the preservation is the SHELL's
 * render and not either control's doing — a fix wired into one path only would
 * pass a suite that drove the other.
 *
 * CLOSING is the rail control in both — see {@link closeSettings} for why that
 * one control is the closer these cases drive.
 */
const OPENERS = [
  {
    name: "the rail control",
    open: async () => {
      clickRail(SETTINGS_LABEL);
      await act(async () => {});
      expect(router.push).not.toHaveBeenCalled();
    },
  },
  {
    name: "g s",
    open: async () => {
      await press("g", "s");
      // Every case below reasons about ONE mounted shell. If the keystroke fell
      // through to `/settings` instead of the in-shell action (DW-62), the shell
      // would have been torn down and rebuilt — and these cases would report
      // "unmounted" for a reason that has nothing to do with DW-373. This is the
      // only path that could navigate, so this is where the spy earns its place.
      expect(router.push).not.toHaveBeenCalled();
    },
  },
] as const;

/**
 * Close Settings with the rail control.
 *
 * Not the only thing that closes it — `applyMode` calls `setSettingsOpen(false)`,
 * so every mode pick closes it too — but the only thing that TOGGLES it, which
 * is what these cases need: a mode pick would change the mode as well and leave
 * the round trip proving something else. `g s` is no closer either: it reads
 * "go to Settings" and OPENS rather than toggles (DW-62), which is why one
 * closer serves both paths. That asymmetry is `settings-shortcut.test.tsx`'s
 * subject, not this file's.
 */
async function closeSettings() {
  clickRail(SETTINGS_LABEL);
  await act(async () => {});
}

/** Is the in-shell Settings surface showing? The helper `settings-shortcut` uses. */
function settingsShowing(): boolean {
  return document.querySelector(".wb-set-pad") !== null;
}

/**
 * The Create Wiki dialog's name field, found WITHOUT the a11y tree.
 *
 * `getByLabelText` skips `hidden` subtrees, which is what the visible cases rely
 * on — so the hidden cases have to reach the node another way or they could not
 * tell "removed from the a11y tree" apart from "unmounted", which is the one
 * distinction this file exists for.
 */
function nameFieldNode(): HTMLInputElement | null {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return dialog?.querySelector("input") ?? null;
}

/**
 * The error the refused create left on the card, read from the DOM not the a11y
 * tree — and scoped to the mode canvas, because `SettingsCanvas` renders an
 * alert of its own whenever its read fails.
 */
function alertNode(): HTMLElement | null {
  return modeCanvas()?.querySelector('[role="alert"]') ?? null;
}

/** The mode canvas section — the `.wb-canvas` that is NOT the Settings one. */
function modeCanvas(): HTMLElement | null {
  const sections = Array.from(document.querySelectorAll<HTMLElement>(".wb-canvas"));
  return sections.find((section) => section.querySelector(".wb-set-pad") === null) ?? null;
}

/**
 * The two columns beside the canvas, read from the DOM rather than the a11y
 * tree — for the same reason {@link nameFieldNode} is: a query that respected
 * `hidden` could not tell "withdrawn" apart from "unmounted", which is the one
 * distinction these cases exist for.
 */
function previewColumn(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wb-preview");
}

function treePanel(): HTMLElement | null {
  return document.querySelector<HTMLElement>(".wb-tree-panel");
}

/** The Preview editor's `<textarea>`, by node, so its IDENTITY can be compared. */
function editorNode(): HTMLTextAreaElement | null {
  return document.querySelector<HTMLTextAreaElement>(".wb-preview-textarea");
}

/**
 * Dock the Preview on a row and get its editor open, holding typed markdown.
 *
 * The editor is opened through its real confirm gate rather than by seeding
 * state, because what is being preserved is the gate's outcome: `editing`,
 * `draft` and the dirty report all live in `PreviewColumn` and are exactly what
 * an unmount discards.
 */
async function openPreviewEditorWith(text: string): Promise<HTMLTextAreaElement> {
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
  fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }));
  await act(async () => {});
  const editor = screen.getByRole("textbox") as HTMLTextAreaElement;
  fireEvent.change(editor, { target: { value: text } });
  expect(editor.value).toBe(text);
  return editor;
}

/** The Knowledge group's disclosure button. Its accessible name carries the count. */
function knowledgeGroup(): HTMLButtonElement {
  return screen.getByRole("button", { name: /^Note/ }) as HTMLButtonElement;
}

/**
 * Open Create Wiki from the empty state and type a name into it.
 *
 * The opener is FOCUSED before it is clicked, which is what a pointer or
 * keyboard activation actually does — `fireEvent.click` alone leaves
 * `document.activeElement` on `<body>`, so `useDialogA11y` would record the body
 * as the opener.
 */
function openCreateWith(name: string): HTMLButtonElement {
  const opener = screen.getByRole("button", { name: "Create Wiki" }) as HTMLButtonElement;
  opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText("Wiki name"), { target: { value: name } });
  return opener;
}

/**
 * Open Create Wiki, type a name and get a REAL error onto the card.
 *
 * The error has to be refused by a create rather than handed in as a prop,
 * because it lives in `WikiWorkbench`'s state while the name lives in
 * `CreateWikiDialog`'s — a fixture that only checked the name would pass against
 * a card that was rebuilt from scratch with the dialog reopened.
 *
 * Routed by URL, not queued with `mockResolvedValueOnce`: `useSidecarStatus`
 * probes the loopback port at mount, so a one-shot answer is spent on the probe
 * and the create sees the default `{}` — which fails for a different reason and
 * would let these pass against the wrong sentence.
 */
async function openCreateWithRefusedName(name: string): Promise<HTMLButtonElement> {
  fetchMock.mockImplementation(async (url: unknown) =>
    String(url) === "/api/wikis"
      ? ({
          ok: false,
          status: 409,
          json: async () => ({ error: CREATE_CONFLICT }),
        } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
  );
  const opener = openCreateWith(name);
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe(CREATE_CONFLICT);
  return opener;
}

describe.each(OPENERS)(
  "an open Create Wiki dialog survives Settings, opened via $name (DW-373)",
  ({ open }) => {
    it("keeps the typed name and the shown error across Settings and back", async () => {
      await renderShell();
      await openCreateWithRefusedName("Quarterly review");

      await open();
      expect(settingsShowing()).toBe(true);
      await closeSettings();
      expect(settingsShowing()).toBe(false);

      // Same dialog, same draft, same failure — not a fresh one seeded with the
      // template's default name.
      expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();
      expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
        "Quarterly review",
      );
      expect(screen.getByRole("alert").textContent).toBe(CREATE_CONFLICT);
    });

    it("is HIDDEN rather than unmounted while Settings is showing", async () => {
      await renderShell();
      await openCreateWithRefusedName("Quarterly review");

      await open();

      // Out of the accessibility tree: testing-library's default queries respect
      // `hidden`, so a dialog behind it is unreachable by role and by label —
      // the same thing a screen reader and a Tab press see.
      expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
      // By ROLE, not by label: `queryByLabelText` walks the DOM and knows
      // nothing about the accessibility tree, so it finds a hidden field and
      // would report this as a failure whichever way the fix went.
      expect(screen.queryByRole("textbox", { name: "Wiki name" })).toBeNull();
      expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
      // The refused create's message specifically: `SettingsCanvas` renders an
      // alert of its own here (the stubbed payload is not a settings body), so
      // "no alert at all" would be asserting the wrong thing.
      expect(screen.queryAllByRole("alert").map((node) => node.textContent)).not.toContain(
        CREATE_CONFLICT,
      );

      // …but still in the DOCUMENT, holding the draft AND the error. This is
      // what tells hiding apart from the unmount that was the defect: an
      // unmounted dialog has no node to find at all.
      expect(nameFieldNode()?.value).toBe("Quarterly review");
      expect(alertNode()?.textContent).toBe(CREATE_CONFLICT);

      // And the attribute that does it, on the SECTION the stylesheet's rule
      // names — not on the dialog, which must stay `open`.
      const section = modeCanvas();
      expect(section?.hasAttribute("hidden")).toBe(true);
      expect(section?.contains(nameFieldNode())).toBe(true);
      // The hidden section holds neither of the two things that must be unique.
      expect(section?.hasAttribute("id")).toBe(false);
      expect(section?.hasAttribute("tabindex")).toBe(false);
    });

    it("holds neither the body scroll lock nor the Tab trap while hidden", async () => {
      await renderShell();
      openCreateWith("Quarterly review");
      // The lock is real while the dialog is on screen — a positive control, so
      // the negative below cannot pass because the lock was never taken.
      expect(document.body.style.overflow).toBe("hidden");

      await open();

      // `hidden` removes the pixels and the a11y tree entry, and NOTHING the
      // dialog did to the document: the scroll lock and the capture-phase Tab
      // listener both outlive it unless the hook stands down.
      expect(document.body.style.overflow).toBe("");

      // Tab is not trapped. The trap is a capture-phase listener that calls
      // `preventDefault` and pulls focus back into the dialog; armed over a
      // hidden surface, the keyboard user is stuck on a canvas they cannot see —
      // here, unable to Tab through Settings.
      const railButton = rail("Graph");
      railButton.focus();
      const tab = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      railButton.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      expect(document.activeElement).toBe(railButton);

      // …and closing Settings re-arms both. The trap is driven from OUTSIDE the
      // dialog, which is the branch that pulls a drifted focus back in — a Tab
      // pressed from inside would only wrap at the last item and prove nothing
      // here.
      await closeSettings();
      expect(document.body.style.overflow).toBe("hidden");
      const outside = rail("Graph");
      outside.focus();
      const trapped = new KeyboardEvent("keydown", {
        key: "Tab",
        bubbles: true,
        cancelable: true,
      });
      outside.dispatchEvent(trapped);
      expect(trapped.defaultPrevented).toBe(true);
      expect(
        screen
          .getByRole("dialog", { name: "Create Wiki" })
          .contains(document.activeElement),
      ).toBe(true);
    });

    it("takes the keyboard to the Settings section (DW-413)", async () => {
      // Opening Settings used to move focus NOWHERE. The canvas the owner was
      // standing in goes `display: none` in the same commit, so a real browser
      // blurs whatever held focus inside it and the keyboard user lands on
      // `<body>` — with the rail and the settings nav to Tab through before
      // reaching the surface they just asked for. Both openers move it now, and
      // to the same place: the destination is the shell's, not either control's.
      await renderShell();
      openCreateWith("Quarterly review");
      const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
      expect(document.activeElement).toBe(dialog);

      await open();

      // The SETTINGS section, identified the way the skip link identifies it —
      // `ModeCanvas` gives `CANVAS_ID` and the landing tab index up while
      // hidden, which is exactly what makes this node able to receive focus.
      const landed = document.activeElement as HTMLElement;
      expect(landed).toBe(document.getElementById(CANVAS_ID));
      expect(landed.querySelector(".wb-set-pad")).not.toBeNull();
      expect(landed.getAttribute("tabindex")).toBe("-1");
      // Not into the subtree that just went off screen, which is the other
      // failure this replaces: jsdom does not blur through an ancestor `hidden`
      // the way a browser does, so a restore aimed at the dialog's opener would
      // land here rather than being the silent no-op it is in a browser.
      expect(modeCanvas()?.contains(landed)).toBe(false);
    });

    it("does not move focus when Settings CLOSES", async () => {
      // One direction only. The rail control the owner pressed is what closed
      // Settings and already holds the keyboard; moving it again would take
      // them off the control they are standing on. (`g s` cannot close Settings
      // at all — DW-62 — which is why one closer serves both rows.)
      await renderShell();
      await open();

      const closer = clickRail(SETTINGS_LABEL);
      await act(async () => {});

      expect(settingsShowing()).toBe(false);
      expect(document.activeElement).toBe(closer);
    });

    it("keeps the Preview editor's unsaved markdown across Settings and back", async () => {
      // The DW-412 headline. `previewOpen` was `shouldDockPreview(…) &&
      // !settingsOpen` and gated the MOUNT, so a Settings visit unmounted the
      // column and took the draft with it — no confirm, no announcement, no way
      // back. The dock rule alone decides the mount now.
      await renderShell(TREE_DATA);
      const editor = await openPreviewEditorWith("# Alpha, half rewritten");

      await open();
      expect(settingsShowing()).toBe(true);
      // Withdrawn, not unmounted: out of the accessibility tree while the node
      // and its text are still in the document.
      expect(previewColumn()?.hasAttribute("hidden")).toBe(true);
      expect(screen.queryByRole("textbox")).toBeNull();
      expect(editorNode()?.value).toBe("# Alpha, half rewritten");

      await closeSettings();

      // The SAME node, which is what tells "kept" apart from "rebuilt with the
      // same bytes": a remounted column would refetch and render `# Alpha`, the
      // body the route answers with, and the owner's edits would be gone.
      expect(editorNode()).toBe(editor);
      expect(editor.value).toBe("# Alpha, half rewritten");
      expect(screen.getByRole("textbox")).toBe(editor);
      expect(previewColumn()?.hasAttribute("hidden")).toBe(false);
    });

    it("stands the Preview's open confirm down while the column is withdrawn", async () => {
      // The second half of the withdrawal, and the half `hidden` cannot do on
      // its own: the attribute takes the pixels, the accessibility tree and the
      // tab order, and nothing the dialog did to the DOCUMENT. The column
      // publishes `visible={false}` through `SurfaceVisibilityProvider` for
      // exactly this, the way the mode canvas already does.
      await renderShell(TREE_DATA);
      fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
      await act(async () => {});
      fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
      // A positive control, so the negative below cannot pass because the lock
      // was never taken at all.
      expect(document.body.style.overflow).toBe("hidden");

      await open();

      expect(document.body.style.overflow).toBe("");
      // Stood down, NOT closed: `ConfirmDialog` renders nothing when `open` goes
      // false, so a node still in the document is what tells the two apart.
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(previewColumn()?.querySelector('[role="dialog"][aria-modal="true"]')).not.toBeNull();

      // …and coming back re-arms it.
      await closeSettings();
      expect(document.body.style.overflow).toBe("hidden");
      expect(screen.getByRole("dialog")).toBeTruthy();
    });

    it("keeps a collapsed Knowledge group collapsed across Settings and back", async () => {
      // Which groups and directories are closed is `TreePanel`'s own `closed`
      // state, and the left column used to render `SettingsNav` INSTEAD of the
      // panel — so every Settings visit re-opened the whole tree.
      await renderShell(TREE_DATA);
      const panel = treePanel();
      fireEvent.click(knowledgeGroup());
      await act(async () => {});
      expect(knowledgeGroup().getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();

      await open();
      expect(treePanel()?.hasAttribute("hidden")).toBe(true);
      await closeSettings();

      // Same panel node, same disclosure. A remount would restore the default,
      // which is every group OPEN — so "Alpha is back on screen" is exactly the
      // defect, not the fix.
      expect(treePanel()).toBe(panel);
      expect(knowledgeGroup().getAttribute("aria-expanded")).toBe("false");
      expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    });

    it("drops the non-Wiki stub label from the left column too", async () => {
      // The matrix row is "ANY mode, Settings open", and the case below can only
      // speak for Wiki: `.wb-left-surface` renders solely in the OTHER modes, so
      // asserting its absence there passes whatever the guard says. Verified —
      // deleting the `settingsOpen ? null :` branch leaves that case green.
      await renderShell(TREE_DATA);
      clickRail("Chat");
      await act(async () => {});
      // The positive control: the stub is genuinely on screen before Settings.
      expect(document.querySelector(".wb-left-surface")?.textContent).toBe("Chat");

      await open();

      // Dropped rather than hidden — one label with nothing behind it holds no
      // state to lose, and a second surface name under the settings nav would
      // describe a column that is not on screen.
      expect(document.querySelector(".wb-left-surface")).toBeNull();
      expect(screen.getByRole("navigation", { name: "Settings categories" })).toBeTruthy();
      expect(
        document.getElementById("wb-left-column")?.getAttribute("aria-label"),
      ).toBe(`${SETTINGS_LABEL} panel`);

      // …and it comes back on close, which is the other half of dropping it:
      // a guard that removed it for good would leave Chat's column unlabelled.
      await closeSettings();
      expect(document.querySelector(".wb-left-surface")?.textContent).toBe("Chat");
    });

    it("leaves the settings nav as the only reachable content of the left column", async () => {
      await renderShell(TREE_DATA);

      await open();

      // The nav is what a reader and a Tab press find in the column…
      expect(screen.getByRole("navigation", { name: "Settings categories" })).toBeTruthy();
      // …and the tree is not, by role or by label, while both of its tabs and
      // every row are still in the document under the withdrawn panel.
      expect(screen.queryByRole("tab", { name: "Knowledge" })).toBeNull();
      expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
      expect(treePanel()?.querySelectorAll('[role="tab"]')).toHaveLength(2);
      // No stub label either — it holds nothing, so it is dropped rather than
      // hidden, and a second sentence under the settings nav would be a label
      // for a surface that is not on screen.
      expect(document.querySelector(".wb-left-surface")).toBeNull();
      // And the column says which surface it is.
      expect(
        document.getElementById("wb-left-column")?.getAttribute("aria-label"),
      ).toBe(`${SETTINGS_LABEL} panel`);
    });

    it("does not pull focus into the hidden canvas when the dialog closes there", async () => {
      // DW-414's real trigger, driven through the shell rather than the hook.
      //
      // `WikiWorkbench` resets `createOpen` whenever the ACTIVE WIKI moves
      // (`[currentWikiId, currentId]`), and a refreshed server render can land
      // that while Settings is showing — so the dialog closes inside a canvas
      // that is behind `hidden`, with its recorded opener withdrawn along with
      // it. The restore has to refuse: focusing a `display: none` node is a
      // silent no-op in a browser that leaves the keyboard on `<body>`, and in
      // jsdom it really does move focus into content nobody can reach, which is
      // what makes the refusal observable at all.
      const view = await renderShell({ ...DATA, wikis: [WIKI] });
      openCreateWith("Quarterly review");
      const canvas = modeCanvas();
      expect(canvas?.contains(nameFieldNode())).toBe(true);

      await open();
      const landed = document.activeElement;
      expect(landed).toBe(document.getElementById(CANVAS_ID));

      // The refreshed render that moves the active Wiki under the withdrawn
      // canvas. Nothing about it touches Settings.
      await refreshShell(view, { ...DATA, wikis: [WIKI], currentWikiId: WIKI.id });

      // The dialog really did close — otherwise there is nothing to refuse and
      // nothing to release.
      expect(nameFieldNode()).toBeNull();
      expect(modeCanvas()?.querySelector('[role="dialog"]')).toBeNull();
      // …and focus never left the surface the owner is actually on.
      expect(document.activeElement).toBe(landed);
      expect(settingsShowing()).toBe(true);
      expect(modeCanvas()?.contains(document.activeElement)).toBe(false);

      // WHAT ACTUALLY LEAKED, and the half that is only visible one cycle
      // later. `armed` was already false when the dialog closed, so no effect
      // re-ran and no restore was attempted at all — what the close left behind
      // is the OPENER CAPTURE. Held, the next open records nothing, and the
      // close after that aims at the button the first dialog was opened from,
      // which the intervening renders detached: focus would land on
      // `WikiWorkbench`'s fallback heading instead of on the control the owner
      // is standing on.
      await refreshShell(view, { ...DATA, wikis: [WIKI] });
      await closeSettings();
      const reopened = openCreateWith("Second draft");
      expect(reopened.isConnected).toBe(true);

      fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
      await act(async () => {});

      expect(document.activeElement).toBe(reopened);
      expect(document.activeElement).not.toBe(
        screen.getByRole("heading", { name: "Wiki" }),
      );
    });

    it("keeps exactly one #wb-canvas, on the Settings section", async () => {
      // `CANVAS_ID` is the skip link's target (`SiteChrome` renders
      // `<a href="#wb-canvas">`), and keeping the mode canvas mounted is exactly
      // the change that could grow a second section answering to it — which
      // would be a duplicate id and leave the browser to pick a bypass target.
      await renderShell();
      await open();

      const targets = document.querySelectorAll("#wb-canvas");
      expect(targets).toHaveLength(1);
      expect(targets[0].querySelector(".wb-set-pad")).not.toBeNull();
      expect(targets[0].getAttribute("tabindex")).toBe("-1");
      // Both sections are present — that IS the fix — and only one is the target.
      expect(document.querySelectorAll(".wb-canvas")).toHaveLength(2);
      // And the landing place is unambiguous too.
      expect(document.querySelectorAll(".wb-canvas[tabindex]")).toHaveLength(1);
    });

    it("leaves exactly one node on the shell's headingId, in a mode with no Wiki surface", async () => {
      // `SettingsCanvas` renders `<h2 id={headingId}>` and so does `ModeCanvas`'s
      // stub branch, off the SAME `useId` — so the stub must not render behind
      // the hidden canvas or the document carries a duplicate id and the
      // Settings section's `aria-labelledby` resolves to whichever came first.
      await renderShell();
      clickRail("Chat");
      await act(async () => {});
      expect(screen.getAllByRole("heading", { name: "Chat" })).toHaveLength(1);

      await open();

      const target = document.querySelector("#wb-canvas") as HTMLElement;
      const headingId = target.getAttribute("aria-labelledby") ?? "";
      expect(headingId).not.toBe("");
      expect(document.querySelectorAll(`[id="${headingId}"]`)).toHaveLength(1);
      // The stub branch is gone from the DOM entirely — it holds no state to
      // lose, which is why it is skipped rather than hidden.
      expect(document.querySelector(".wb-canvas[hidden] .wb-surface-title")).toBeNull();
      // One reachable surface heading, and it is Settings'.
      expect(screen.queryByRole("heading", { name: "Chat" })).toBeNull();
      expect(document.getElementById(headingId)?.textContent).toBe(
        screen.getAllByRole("heading", { level: 2 })[0]?.textContent,
      );

      // …and the stub branch RE-RENDERS on close, which is the other half of
      // skipping it while hidden: it is dropped rather than merely hidden, so a
      // guard that removed it for good would leave Chat a blank canvas with no
      // heading, no empty-state sentence and nothing for the section to be
      // labelled by.
      await closeSettings();
      expect(screen.getAllByRole("heading", { name: "Chat" })).toHaveLength(1);
      const back = document.querySelector("#wb-canvas") as HTMLElement;
      expect(back.querySelector(".wb-surface-title")?.textContent).toBe("Chat");
      expect(back.querySelector(".wb-empty")).not.toBeNull();
      // The heading it points at is the stub's own, on the same `headingId`
      // `SettingsCanvas` had just given back — and it is still the only node
      // carrying it.
      expect(back.getAttribute("aria-labelledby")).toBe(headingId);
      expect(document.querySelectorAll(`[id="${headingId}"]`)).toHaveLength(1);
    });

    it("puts the Wiki canvas back on screen when Settings closes", async () => {
      // The round trip for a mode that has no dialog open: the subtree comes
      // back reachable, and the section takes its id, tab index and label again.
      const { container } = await renderShell();
      await open();
      await closeSettings();

      expect(container.querySelectorAll("#wb-canvas")).toHaveLength(1);
      expect(container.querySelectorAll(".wb-canvas")).toHaveLength(1);
      const canvas = container.querySelector("#wb-canvas") as HTMLElement;
      expect(canvas.hasAttribute("hidden")).toBe(false);
      // The tab index is read, not assumed. It is what makes the skip link's
      // target able to RECEIVE the focus the bypass sends it, and it is now
      // conditional — dropping it would leave every other case here green while
      // `#wb-canvas` quietly became unfocusable in the ordinary,
      // Settings-closed state.
      expect(canvas.getAttribute("tabindex")).toBe("-1");
      expect(canvas.getAttribute("aria-labelledby")).toBe("wiki-workbench-heading");
      expect(screen.getAllByRole("heading", { name: "Wiki" })).toHaveLength(1);
    });
  },
);

describe("a global shortcut does not fire from inside a modal (DW-413)", () => {
  it("ignores g s typed in the Create Wiki dialog", async () => {
    // `aria-modal="true"` is a promise that the rest of the page is inert. A
    // navigation key that changed the surface underneath would break exactly
    // that promise — and would leave a modal holding an unsaved name open over
    // Settings, with its Tab trap still armed.
    await renderShell();
    openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    // Aimed at the dialog CONTAINER, not the name field: `isInputElement`
    // already suppresses the shortcut inside a `<input>`, so a press typed there
    // would pass whichever way this went. The container is focusable, is where
    // `useDialogA11y` puts focus on open, and is not a form control.
    expect(document.activeElement).toBe(dialog);

    fireEvent.keyDown(dialog, { key: "g" });
    fireEvent.keyDown(dialog, { key: "s" });
    await act(async () => {});

    // Nothing dispatched: no surface change on this shell, and no navigation
    // off it either.
    expect(settingsShowing()).toBe(false);
    expect(router.push).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBe(dialog);

    // …and the suppression is about WHERE the press came from, not about the
    // dialog being open: the same sequence at the document still works.
    await press("g", "s");
    expect(settingsShowing()).toBe(true);
  });
});

describe("the stylesheet backs the attribute (DW-373)", () => {
  it("hides the canvas section with a rule the layout cannot defeat", async () => {
    // jsdom loads no stylesheet and applies no user-agent sheet, so nothing
    // above can see a pixel — `hidden` is an attribute there and the a11y-tree
    // half is all the mounted assertions reach. The `display: none` that makes
    // it a visual withdrawal is a UA default that ANY author rule setting
    // `display` on the same element beats, and `.wb-canvas` already carries
    // author `grid-column`, `overflow` and `background` — one `display` added to
    // that block would put the withdrawn canvas back under Settings. So the rule
    // is stated in `globals.css`, with the attribute in its selector, and read
    // here from the real file rather than restated.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(/\.wb-canvas\[hidden\] \{\s*display: none;\s*\}/);

    // Outside every media query. The `@media` block further down re-points
    // `.wb-canvas` to `grid-column: 1`, so a withdrawal stated inside a width
    // query would hold at some widths and not others — and wherever it missed,
    // the hidden canvas would render underneath Settings.
    const before = css
      .slice(0, css.indexOf(".wb-canvas[hidden] {"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const depth =
      (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it("hides the two columns the same way (DW-412)", async () => {
    // Both blocks already declare `display: flex` — `.wb-preview` so it can
    // stack a header over a scrolling body, `.wb-tree-panel` so it can be the
    // left column's growing child — and an author `display` beats the
    // user-agent sheet's `hidden` default outright. Without a rule naming the
    // attribute, each withdrawn column would simply stay on screen: the Preview
    // in an implicit fourth grid track beside Settings, the tree above the
    // settings nav. So the same read-back the canvas gets, for the same reason.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    for (const selector of [".wb-preview[hidden]", ".wb-tree-panel[hidden]"]) {
      const rule = new RegExp(
        `${selector.replace(/[.[\]]/g, "\\$&")} \\{\\s*display: none;\\s*\\}`,
      );
      expect(css).toMatch(rule);

      // Outside every media query, and this one is not hypothetical either:
      // the stacking block re-points `.wb-preview` to `grid-column: 1`, so a
      // withdrawal stated inside a width query would hold at some widths and
      // not others.
      const before = css
        .slice(0, css.indexOf(`${selector} {`))
        .replace(/\/\*[\s\S]*?\*\//g, "");
      const depth =
        (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
      expect(depth).toBe(0);
    }
  });
});
