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
 * WHICH OPENER A CASE CAN USE IS ITSELF A CONTRACT (DW-426, DW-511). With an
 * `aria-modal` dialog open, NEITHER in-shell control is available: `g s` is
 * refused anywhere inside such a dialog, and the dialog's `fixed inset-0
 * z-[120]` backdrop covers the rail, which carries no `z-index` of its own. So
 * a case that opens one first reaches Settings by BACK — browser chrome, which
 * no modal covers or traps — and those live in their own block below, while the
 * parameterised block keeps only the cases both in-shell controls can genuinely
 * reach. See {@link OPENERS}, {@link press} and {@link openFromHistory}.
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
 *
 * WHICH MAKES THIS UNSOUND OVER AN OPEN MODAL (DW-426). `isInModalDialog`
 * suppresses the shortcut anywhere inside `[role="dialog"][aria-modal="true"]`
 * (`useKeyboardShortcuts.ts`), and `useDialogA11y` puts focus in the dialog and
 * traps Tab there — so with one open, a real keyboard user has NO way to put
 * the keyboard on `<body>` and press this. A press dispatched from here anyway
 * pins a path that cannot be taken, and the fix it defends could be reverted
 * without the suite noticing. Every case that holds an open modal therefore
 * reaches Settings by BACK instead — the rail is no more available than `g s`
 * is while a backdrop is on screen (DW-511); see {@link openFromHistory}.
 *
 * ONE CASE DOES PRESS IT WITH A DIALOG MOUNTED, on purpose: the last lines of
 * "a global shortcut does not fire from inside a modal (DW-413)" fire `g s` from
 * `document.body` while the Create Wiki dialog is still open, and expect it to
 * WORK. That is the positive control for the suppression itself — it proves the
 * refusal is about where the press CAME FROM and not about a dialog merely being
 * open — so it is asserting the dispatcher's rule rather than pinning an owner's
 * path, and the carve-out is the point of the case.
 */
async function press(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(document.body, { key });
  }
  await act(async () => {});
}

/**
 * The two ways in, driven identically — for every case that can be reached BOTH
 * ways.
 *
 * The parameterised cases run against both, because the preservation is the
 * SHELL's render and not either control's doing — a fix wired into one path only
 * would pass a suite that drove the other.
 *
 * WHAT IS NOT PARAMETERISED, and why (DW-426, DW-511): a case that opens an
 * `aria-modal` dialog first can drive NEITHER of these. `isInModalDialog` stops
 * the dispatcher for any press inside such a dialog, and the dialog holds focus
 * and traps Tab — so there is no keystroke a browser keyboard user could reach
 * the surface with while one is open. The rail is no better off: the dialog's
 * root is `fixed inset-0 z-[120]` over the whole viewport and `.wb-rail`
 * declares no `z-index` at desktop widths, so a pointer aimed at the Settings
 * control lands on the backdrop. Those cases live in their own block below,
 * with the same assertions, and reach the surface by BACK; parameterising them
 * meant firing `g s` at `document.body` — and, until DW-511, clicking a rail
 * control no pointer could hit — pinning paths the product deliberately
 * refuses. See {@link openFromHistory}.
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

/**
 * Leave ONE Settings entry in the session history, behind the current one — the
 * entry {@link openFromHistory} traverses back onto.
 *
 * Two rail presses. `Workbench`'s `toggleSettings` pushes on BOTH edges, so the
 * first press opens Settings and pushes `?mode=wiki&settings=1` and the second
 * closes it and pushes `?mode=wiki` again: the RENDER ends exactly where it
 * started — mode canvas on screen, nothing withdrawn, `SettingsCanvas`
 * unmounted — with a Settings entry one step back.
 *
 * TWO SIDE EFFECTS IT DOES LEAVE, neither of which any case here reads. The
 * visit mounts and unmounts `SettingsCanvas`, which spends one extra
 * `fetchMock` call on the settings payload — no case asserts a call count, and
 * `openCreateWithRefusedName` routes its answer by URL rather than queueing a
 * one-shot, so nothing is consumed out from under it. And the second press
 * leaves the keyboard on the rail's Settings control rather than on `<body>`:
 * harmless because every dialog opener in this file (`openCreateWith`, and the
 * Preview's own row and confirm clicks) focuses its own control before clicking
 * it, so `useDialogA11y` still records the opener a real activation would.
 *
 * IT MUST RUN BEFORE ANY DIALOG IS OPENED, and that ordering is the whole
 * reason this is a second helper rather than one call. The rail is reachable
 * only while no dialog backdrop is on screen: once `CreateWikiDialog` or
 * `ConfirmDialog` mounts, its `fixed inset-0 z-[120] … bg-black/40` root covers
 * the whole viewport — the rail declares no `z-index` of its own — and
 * `useDialogA11y` traps Tab inside the dialog, so neither a pointer nor a
 * keyboard could reach these two presses. Seeding first is the one ordering in
 * which every press this file makes is a press a real owner could make.
 */
async function seedSettingsEntry() {
  // The ordering, CHECKED rather than documented (DW-511). jsdom does no
  // hit-testing, so a future call placed after `openCreateWith(...)` would click
  // straight through a live overlay and report green — which is the exact defect
  // this entry was filed against. A comment cannot stop that; this can.
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

  // The href to come back to, read rather than restated, so this helper stays
  // usable from any mode rather than hard-coding Wiki's.
  const before = window.location.search;
  const depth = window.history.length;

  clickRail(SETTINGS_LABEL);
  await act(async () => {});
  expect(settingsShowing()).toBe(true);
  // THE ENTRY, not just the surface. `pushSurface` swallows `SecurityError` and
  // writes nothing when the href is unchanged, and jsdom's session history
  // outlives `cleanup()` — `beforeEach` only rewrites the CURRENT entry — so a
  // silently unseeded run would send `openFromHistory` back onto a PREVIOUS
  // TEST's entry, which in this file usually is a `settings=1` one. It would
  // then show Settings and report green having proved nothing.
  expect(new URLSearchParams(window.location.search).get("settings")).toBe("1");

  clickRail(SETTINGS_LABEL);
  await act(async () => {});
  expect(settingsShowing()).toBe(false);
  // Back on the pre-seed href, with the flag deleted rather than set to a falsy
  // spelling (`surfaceHref` removes the param; `readSettingsFromSearch` accepts
  // only `settings=1`).
  expect(new URLSearchParams(window.location.search).get("settings")).toBeNull();
  expect(window.location.search).toBe(before);
  // …and both presses really PUSHED. Two distinct hrefs could still be one
  // entry if either write were replaced or dropped, and the depth is the only
  // thing that can tell that apart from a seeded stack.
  expect(window.history.length).toBe(depth + 2);
  expect(router.push).not.toHaveBeenCalled();
}

/**
 * Reach Settings by BACK — the opener that stays available with a modal dialog
 * open (DW-511).
 *
 * It is browser chrome, and a modal covers and traps only the page: the
 * backdrop that hides the rail from the pointer and the Tab trap that holds the
 * keyboard both stop at the document, so Back is still there. The traversal
 * lands on the entry {@link seedSettingsEntry} left behind, and `Workbench`'s
 * `popstate` listener re-applies `settings=true` (DW-167).
 *
 * It also bumps `canvasFocusNonce`, sending the keyboard to `#wb-canvas`
 * (DW-423) — but that is now CONDITIONAL, not a consequence of the flag having
 * moved on its own. DW-759 samples the regions the transition withdraws;
 * here the Create Wiki dialog holding focus renders inside the mode canvas.
 * Persistent controls keep their focus. Same surface and same withdrawal either
 * in-shell control produces, by the one route this state leaves open.
 */
async function openFromHistory() {
  await traverse(() => window.history.back());
  // The ENTRY it landed on carries the flag — not merely "Settings is showing",
  // which a stale entry left by an earlier test in this file would also produce.
  // This is the far half of the seed's own history assertions.
  expect(new URLSearchParams(window.location.search).get("settings")).toBe("1");
  expect(settingsShowing()).toBe(true);
  expect(router.push).not.toHaveBeenCalled();
}

/** How long to wait for a traversal jsdom may never perform. */
const POPSTATE_TIMEOUT_MS = 1000;

/**
 * Traverse the session history and let the `popstate` land.
 *
 * The same helper `workbench-mode-url.test.tsx` documents in full: jsdom queues
 * traversal on its own event loop and fires `popstate` some tasks later, so a
 * `setTimeout(0)` would let the assertion run against the pre-traversal tree and
 * pass for the wrong reason. The timeout is a deadline, not a fallback.
 */
async function traverse(go: () => void) {
  await act(async () => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        window.removeEventListener("popstate", onPop);
        reject(new Error(`no popstate within ${POPSTATE_TIMEOUT_MS}ms`));
      }, POPSTATE_TIMEOUT_MS);
      function onPop() {
        clearTimeout(timer);
        resolve();
      }
      window.addEventListener("popstate", onPop, { once: true });
      go();
    });
  });
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
  "the shell survives Settings, opened via $name (DW-373)",
  ({ open }) => {
    it("takes the keyboard to the Settings section (DW-413)", async () => {
      // Opening Settings used to move focus NOWHERE. The canvas the owner was
      // standing in goes `display: none` in the same commit, so a real browser
      // blurs whatever held focus inside it and the keyboard user lands on
      // `<body>` — with the rail and the settings nav to Tab through before
      // reaching the surface they just asked for. Both openers move it now, and
      // to the same place: the destination is the shell's, not either control's.
      //
      // The keyboard starts on a NON-MODAL control inside the mode canvas, not
      // in an open Create Wiki dialog (DW-426). The dialog is `aria-modal`, and
      // `isInModalDialog` stops the dispatcher before `g s` reaches anything —
      // so a row that opened one and then pressed the key from `document.body`
      // pinned a path no browser keyboard user can take. The empty state's own
      // opener is the same starting point minus the modal: a focusable control
      // that goes `display: none` under the withdrawn canvas, which is the whole
      // reason the keyboard has to be caught.
      await renderShell();
      const standing = screen.getByRole("button", {
        name: "Create Wiki",
      }) as HTMLButtonElement;
      standing.focus();
      expect(document.activeElement).toBe(standing);
      expect(modeCanvas()?.contains(standing)).toBe(true);

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
      // the way a browser does, so focus left where it was would still read as
      // "inside the mode canvas" here rather than as the `<body>` it becomes in
      // a browser.
      expect(modeCanvas()?.contains(landed)).toBe(false);
      expect(landed).not.toBe(standing);
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
      const view = await renderShell(TREE_DATA);
      const editor = await openPreviewEditorWith("# Alpha, half rewritten");

      await open();
      expect(settingsShowing()).toBe(true);
      await refreshShell(view, { ...TREE_DATA, dataVersion: 1 });
      await refreshShell(view, { ...TREE_DATA, dataVersion: 2 });
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

    it("brings the canvas back at the offset it was scrolled to (DW-416)", async () => {
      // `.wb-canvas` is the mode canvas's SCROLL CONTAINER (`overflow: auto` in
      // `globals.css`) and `display: none` DISCARDS a scroll box — so the visit
      // that costs nothing still dropped the owner at the top of a long canvas.
      // The section survives the visit mounted, which is exactly why the offset
      // can live in a ref: nothing has to cross a reload, and no new localStorage
      // key is invented for it.
      //
      // PARAMETERISED, unlike the cases below it used to sit among (DW-511): it
      // opens no dialog, so nothing covers the rail and nothing refuses `g s` —
      // both openers are genuinely available to it, and the offset is the
      // shell's memory rather than either control's doing.
      await renderShell();
      const canvas = modeCanvas();
      expect(canvas).not.toBeNull();
      const section = canvas as HTMLElement;
      section.scrollTop = 300;
      await act(async () => {
        section.dispatchEvent(new Event("scroll"));
      });

      await open();
      expect(settingsShowing()).toBe(true);
      expect(section.hasAttribute("hidden")).toBe(true);
      // Standing in for the browser's own `scrollTop = 0` on a `display: none`
      // box, exactly as the tree cases in `workbench-split-wiring.test.tsx` do:
      // jsdom has no layout engine, so nothing resets it here on its own.
      section.scrollTop = 0;

      await closeSettings();

      // The SAME node — withdrawn, not rebuilt — back where the owner left it.
      expect(modeCanvas()).toBe(section);
      expect(section.hasAttribute("hidden")).toBe(false);
      expect(section.scrollTop).toBe(300);
      // In a REF, not in storage: DW-416's scope is the visit, not FR-8's
      // cross-session restore, so the round trip invents no key for the canvas.
      expect(
        Object.keys(window.localStorage).filter((key) => key.includes("canvas")),
      ).toEqual([]);

      // …and the memory keeps tracking: a scroll after the visit REPLACES it,
      // rather than the first offset latching for the rest of the session.
      section.scrollTop = 80;
      await act(async () => {
        section.dispatchEvent(new Event("scroll"));
      });
      await open();
      section.scrollTop = 0;
      await closeSettings();
      expect(section.scrollTop).toBe(80);
    });

    it("keeps the owner's offset when the restore is clamped (DW-521)", async () => {
      // The restore ASSIGNS an offset; the browser CLAMPS it to what the box
      // can currently reach and dispatches a `scroll` for that assignment at
      // the next rendering update — after the listener the effect attaches on
      // the line below it. Recorded, that echo replaces the offset the owner
      // left with the clamp, and the canvas forgets where it was every time it
      // comes back before its content has finished filling in.
      //
      // The `TreePanel` case in `workbench-split-wiring.test.tsx` is this one,
      // one column over. Both halves need executing: the suppression can be
      // deleted from EITHER component with the other's case still green.
      await renderShell();
      const canvas = modeCanvas();
      expect(canvas).not.toBeNull();
      const section = canvas as HTMLElement;

      // Where the owner actually left it, recorded the ordinary way.
      section.scrollTop = 300;
      await act(async () => {
        section.dispatchEvent(new Event("scroll"));
      });

      await open();
      expect(section.hasAttribute("hidden")).toBe(true);

      // A SHORTER BOX, stated rather than laid out — jsdom runs no layout, so
      // the clamp has to be declared the way this file's `scrollTop = 0`
      // stand-ins declare the browser's own reset. It starts at 0, which is
      // that reset.
      let value = 0;
      Object.defineProperty(section, "scrollTop", {
        configurable: true,
        get: () => value,
        set: (next: number) => {
          value = Math.min(next, 200);
        },
      });

      await closeSettings();
      // The pixels went where the box allows…
      expect(section.scrollTop).toBe(200);
      // …and the echo the browser dispatches for that assignment is DROPPED.
      await act(async () => {
        section.dispatchEvent(new Event("scroll"));
      });

      // The content finishes filling in and the box can reach the offset again.
      await open();
      Reflect.deleteProperty(section, "scrollTop");
      section.scrollTop = 0;
      await closeSettings();
      // The owner's OWN offset, not the clamp that briefly stood in for it.
      expect(section.scrollTop).toBe(300);

      // …and the arm is spent, so a genuine scroll after the restore is
      // recorded exactly as it was before any of this.
      section.scrollTop = 80;
      await act(async () => {
        section.dispatchEvent(new Event("scroll"));
      });
      await open();
      section.scrollTop = 0;
      await closeSettings();
      expect(section.scrollTop).toBe(80);
    });

    it("restores the DOCUMENT's offset where the document is what scrolls (DW-523)", async () => {
      // `.wb-canvas` is not unconditionally the scroll container. Below the
      // stacking breakpoint with a Preview docked, `globals.css` releases
      // `.wb-shell`'s clamp (`height: auto`, `overflow: visible`) so the
      // Preview's fourth row is reachable at all — and the canvas row then
      // resolves to its CONTENT rather than scrolling inside its own
      // `overflow: auto`, which leaves the DOCUMENT as the thing that moves. A
      // restore that only ever reads and writes the section reads 0, writes 0,
      // and hands the owner the top of the page at that width, with the DW-416
      // case above still green.
      //
      // The overflow is DECLARED, not laid out — jsdom runs no layout, so
      // `documentElement` reports `scrollHeight === clientHeight === 0` and the
      // canvas is the default. Declaring it here is what puts the component on
      // the other branch, exactly as `setElementRect` declares the shell's box
      // for the split cases.
      const root = document.documentElement;
      Object.defineProperty(root, "scrollHeight", { configurable: true, value: 4000 });
      Object.defineProperty(root, "clientHeight", { configurable: true, value: 800 });
      try {
        // The page is ALREADY somewhere when the shell mounts — the browser's
        // own scroll restoration, a `#hash` landing, a reload part-way down.
        root.scrollTop = 555;

        await renderShell();
        const canvas = modeCanvas();
        expect(canvas).not.toBeNull();
        const section = canvas as HTMLElement;

        // THE FIRST MOUNT WRITES NOTHING. Nothing has gone off screen yet, so
        // there is no offset to restore — and on this branch the scroller is
        // the PAGE, so a mount that wrote its "starting" 0 into it would throw
        // the owner to the top of the document and destroy all three of those.
        // That is why the ref starts `null` rather than 0.
        expect(root.scrollTop).toBe(555);

        // The section's own `scrollTop` is watched rather than assumed: on this
        // branch nothing may read or write it, and a restore that quietly kept
        // touching it would leave every assertion below satisfiable by accident.
        let canvasWrites = 0;
        let canvasValue = 0;
        Object.defineProperty(section, "scrollTop", {
          configurable: true,
          get: () => canvasValue,
          set: (next: number) => {
            canvasWrites += 1;
            canvasValue = next;
          },
        });

        // The owner scrolls the PAGE. A viewport scroll is dispatched at
        // `Document` and does not bubble from `documentElement`, which is why
        // the listener has to be on the document at all.
        root.scrollTop = 300;
        await act(async () => {
          document.dispatchEvent(new Event("scroll"));
        });

        await open();
        expect(settingsShowing()).toBe(true);
        expect(section.hasAttribute("hidden")).toBe(true);
        // Standing in for the reset a browser performs on the way out.
        root.scrollTop = 0;

        await closeSettings();

        expect(modeCanvas()).toBe(section);
        expect(section.hasAttribute("hidden")).toBe(false);
        expect((document.scrollingElement ?? root).scrollTop).toBe(300);
        // …and the canvas was never the thing being restored.
        expect(canvasWrites).toBe(0);

        // THE LISTENER GOES ON RECORDING AFTER THE RESTORE. The restore arms an
        // echo on this branch too, and an arm that latched — or a listener the
        // re-run failed to re-attach to the document — would leave the page
        // stuck at the first offset for the rest of the session, with every
        // assertion above still green.
        root.scrollTop = 620;
        await act(async () => {
          document.dispatchEvent(new Event("scroll"));
        });
        await open();
        root.scrollTop = 0;
        await closeSettings();
        expect((document.scrollingElement ?? root).scrollTop).toBe(620);
        expect(canvasWrites).toBe(0);
      } finally {
        // The declarations are own properties on a node the whole run shares —
        // left in place they would put every later case on the document branch.
        Reflect.deleteProperty(root, "scrollHeight");
        Reflect.deleteProperty(root, "clientHeight");
        root.scrollTop = 0;
      }
    });
  },
);

/**
 * The same preservation, reached by BACK — the one opener a held modal leaves
 * available (DW-373, DW-511).
 *
 * Every case here has an `aria-modal` dialog open when Settings is reached: the
 * Create Wiki dialog, or the Preview editor's confirm. That state refuses BOTH
 * in-shell controls, for two independent reasons.
 *
 * THE KEYBOARD HALF (DW-426). `isInModalDialog` suppresses every global
 * shortcut fired inside `[role="dialog"][aria-modal="true"]`, and
 * `useDialogA11y` puts focus in the dialog and traps Tab there — so there is no
 * place a keyboard owner can stand from which `g s` would be read. The block
 * "a global shortcut does not fire from inside a modal (DW-413)" pins that.
 *
 * THE POINTER HALF (DW-511). `CreateWikiDialog` and `ConfirmDialog` render
 * their roots as `fixed inset-0 z-[120] … bg-black/40` — a full-viewport
 * backdrop over the entire shell. `.wb-rail` declares NO `z-index` at desktop
 * widths and `z-index: 40` in the narrow block, and `.wb-shell` is
 * `position: relative` with no `z-index`, so it opens no stacking context that
 * could rescue the rail: a pointer aimed at the rail's Settings control lands
 * on the backdrop. These cases clicked it anyway until this entry and passed
 * only because jsdom does no hit-testing — the exact pointer twin of the `g s`
 * path DW-426 retired. The block "the rail is not an opener while a dialog
 * backdrop is on screen (DW-511)" pins that one executably, so the correction
 * cannot rot back into prose.
 *
 * SO THE OPENER IS BROWSER CHROME, which a modal neither covers nor traps.
 * {@link seedSettingsEntry} leaves a Settings entry one step back BEFORE any
 * dialog is opened — while the rail is still reachable — and
 * {@link openFromHistory} traverses Back onto it. The entry exists because
 * DW-167 gave the surface an address; the traversal reproduces the same
 * withdrawal and the same focus landing either in-shell control produces.
 *
 * THE RAIL IS STILL THE CLOSER, and that press really is reachable: by then
 * Settings is showing and the canvas (or the Preview column) holding the dialog
 * is `hidden`, which `globals.css` backs with `display: none !important` — so
 * the backdrop paints nothing, the scroll lock is released and the Tab trap is
 * stood down. Nothing is over the rail at that moment, which is why these cases
 * close with {@link closeSettings}.
 *
 * The DW-373 / DW-412 / DW-414 coverage they carry is unchanged — this is how
 * the state is REACHED, not what is checked — and is not weakened by dropping
 * the in-shell openers: what those cases are about is the SHELL's render, which
 * the parameterised block above still exercises through both controls.
 */
describe("a dialog-holding canvas survives Settings, reached by BACK (DW-373)", () => {
  it("keeps the typed name and the shown error across Settings and back", async () => {
    await renderShell();
    await seedSettingsEntry();
    await openCreateWithRefusedName("Quarterly review");

    await openFromHistory();
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
    await seedSettingsEntry();
    await openCreateWithRefusedName("Quarterly review");

    await openFromHistory();

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
    await seedSettingsEntry();
    openCreateWith("Quarterly review");
    // The lock is real while the dialog is on screen — a positive control, so
    // the negative below cannot pass because the lock was never taken.
    expect(document.body.style.overflow).toBe("hidden");

    await openFromHistory();

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

  it("stands the Preview's open confirm down while the column is withdrawn", async () => {
    // The second half of the withdrawal, and the half `hidden` cannot do on
    // its own: the attribute takes the pixels, the accessibility tree and the
    // tab order, and nothing the dialog did to the DOCUMENT. The column
    // publishes `visible={false}` through `SurfaceVisibilityProvider` for
    // exactly this, the way the mode canvas already does.
    await renderShell(TREE_DATA);
    await seedSettingsEntry();
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    // A positive control, so the negative below cannot pass because the lock
    // was never taken at all.
    expect(document.body.style.overflow).toBe("hidden");

    await openFromHistory();

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
    await seedSettingsEntry();
    openCreateWith("Quarterly review");
    const canvas = modeCanvas();
    expect(canvas?.contains(nameFieldNode())).toBe(true);

    await openFromHistory();
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

  it("leaves the keyboard in the re-armed dialog when BACK reveals its canvas", async () => {
    // The traversal twin of "does not move focus when Settings CLOSES", and the
    // one case where the shell's landing site and a modal want the same
    // keyboard.
    //
    // Back out of Settings is a canvas swap with no control holding the
    // keyboard, so the shell moves focus to `#wb-canvas` (DW-423). But the same
    // commit un-hides the mode canvas, which re-arms `useDialogA11y`: it focuses
    // the dialog container and re-arms the Tab trap. `useDialogA11y` is a CHILD
    // effect and runs first, so an unguarded shell move lands afterwards and
    // leaves the keyboard OUTSIDE an `aria-modal` dialog that is trapping Tab —
    // a keyboard user who can neither operate the canvas they are on nor Tab off
    // it. The dialog wins: it is the thing claiming the page is inert.
    await renderShell();
    await seedSettingsEntry();
    const opener = openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    expect(document.activeElement).toBe(dialog);

    // Into Settings, where the move DOES happen — the dialog is withdrawn under
    // the hidden canvas, so it is holding nothing. This is the positive control
    // that stops the guard from being "never move focus at all".
    await openFromHistory();
    expect(settingsShowing()).toBe(true);
    expect(document.activeElement).toBe(document.getElementById(CANVAS_ID));

    // Out again the same way, which is what this case is named for: the second
    // DW-759: SettingsNav is outside the canvas and disappears on Back too.
    const categoryRow = document.querySelector<HTMLButtonElement>(".wb-set-nav button");
    expect(categoryRow).not.toBeNull();
    categoryRow!.focus();
    expect(document.activeElement).toBe(categoryRow);

    // Back lands on the mount-seeded `?mode=wiki` entry, closing Settings and
    // un-hiding the canvas in one commit.
    await traverse(() => window.history.back());

    // The surface really did close — otherwise there is nothing to compete for.
    expect(settingsShowing()).toBe(false);
    const revealed = screen.getByRole("dialog", { name: "Create Wiki" });
    expect(revealed).toBe(dialog);
    // …and the keyboard is in the dialog, not on the section behind it.
    expect(document.activeElement).toBe(dialog);
    expect(document.activeElement).not.toBe(document.getElementById(CANVAS_ID));
    // The trap is armed, which is what makes the section behind it the wrong
    // place to be standing.
    expect(document.body.style.overflow).toBe("hidden");
    // …and the draft survived the round trip, dialog and opener both.
    expect(nameFieldNode()?.value).toBe("Quarterly review");
    expect(opener.isConnected).toBe(true);
  });
});

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

/**
 * The pointer twin of the block above (DW-511).
 *
 * `g s` being refused inside a modal is asserted; the rail being unreachable
 * there was only ever PROSE, and prose is what let six cases open Settings with
 * `fireEvent.click(rail(SETTINGS_LABEL))` over a live backdrop for as long as
 * they did — green because jsdom does no hit-testing, and describing a path no
 * owner has.
 *
 * COVERAGE LIMIT, and it is the file header's own: jsdom has no layout engine
 * and no hit-testing, so nothing here can observe the stacking directly — no
 * assertion in this repo can watch a click land on the backdrop instead of on
 * the rail. What IS pinned is the two facts the unreachability is composed of,
 * either of which a restyle could remove without another test noticing:
 *
 *   1. every dialog root is a FULL-VIEWPORT backdrop at a stated level —
 *      `fixed inset-0 z-[120]`, read from the components' own class lists, for
 *      `CreateWikiDialog` AND `ConfirmDialog`, the two that hold the cases
 *      above — and the rail is not inside it; and
 *   2. every rule in `globals.css` whose selector names the rail family sits
 *      BELOW that level, `.wb-rail-item` (the control the old rows actually
 *      clicked) included, with `.wb-shell` opening no stacking context that
 *      could lift them from outside those rules.
 *
 * Plus one piece of behaviour jsdom CAN give: the overlay's own `onMouseDown`
 * cancels the dialog, so a pointer press on it is observably intercepted by the
 * backdrop rather than passing through to whatever is underneath.
 *
 * AND THE SUITE NOW FORBIDS LIFTING THE RAIL, deliberately. The last loop below
 * fails the moment any rail rule reaches the backdrop's level — which is one of
 * the two remedies DW-511 itself offered and the codebase declined. Lifting the
 * rail would make it pointer-operable while `aria-modal="true"` and
 * `useDialogA11y`'s Tab trap still declare the page inert: the same
 * pointer/keyboard asymmetry this entry exists to remove, inverted. A future
 * author who wants that has to change those contracts too, not just the
 * stylesheet — and this case is where they will be told so.
 */
describe("the rail is not an opener while a dialog backdrop is on screen (DW-511)", () => {
  /**
   * The overlay a dialog renders itself inside, and the two things that make it
   * cover the rail: it is fixed to the whole viewport, and the rail is not in
   * it. Returns the level it claims, read from the class rather than restated,
   * so the stylesheet comparison stays honest if the overlay is ever
   * re-levelled.
   */
  function backdropLevelOver(dialog: HTMLElement): number {
    // The dialog node's PARENT — both components render the backdrop and centre
    // the panel inside it.
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.classList.contains("fixed")).toBe(true);
    expect(overlay.classList.contains("inset-0")).toBe(true);

    // The rail is on screen and NOT inside the overlay: nothing about the
    // backdrop leaves a hole for the control the old rows were clicking.
    const railControl = rail(SETTINGS_LABEL);
    expect(railControl.isConnected).toBe(true);
    expect(overlay.contains(railControl)).toBe(false);
    expect(overlay.querySelector(".wb-rail")).toBeNull();

    const level = Number(/(?:^|\s)z-\[(\d+)\]/.exec(overlay.className)?.[1]);
    // A level that will not parse is a failure here, not a skipped comparison:
    // everything below is stated relative to this number.
    expect(Number.isFinite(level)).toBe(true);
    return level;
  }

  /**
   * Every DECLARATION block in the stylesheet, as `{ selector, body }`.
   *
   * `[^{}]*` on both halves is what makes this read only the innermost blocks:
   * an `@media` wrapper's body holds a `{`, so it never matches, and the rules
   * nested inside it do — which is exactly what is wanted, since the narrow
   * rail rule lives in one. Comments are stripped first so a brace inside prose
   * cannot split a rule.
   */
  function declarationBlocks(css: string): { selector: string; body: string }[] {
    const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
    return Array.from(stripped.matchAll(/([^{}]*)\{([^{}]*)\}/g), (match) => ({
      selector: match[1].trim(),
      body: match[2],
    }));
  }

  /**
   * Does a selector name this class? Word-bounded, so `.wb-rail` does not match
   * `.wb-rail-item` — and, unlike a `\.wb-rail\s*\{` scan, this reads the whole
   * SELECTOR rather than requiring the class to be the last thing before the
   * brace. `.wb-rail:hover`, `.wb-rail[data-x]`, `.wb-shell > .wb-rail` and a
   * grouped `.wb-rail, .x { … }` all count, which is the point: any of them
   * could carry the level that undoes this.
   */
  function names(selector: string, className: string): boolean {
    return new RegExp(`\\.${className}(?![\\w-])`).test(selector);
  }

  async function stylesheet(): Promise<string> {
    return readFile(path.resolve(__dirname, "../../../app/globals.css"), "utf8");
  }

  it("covers the rail with the Create Wiki dialog's overlay, and intercepts the pointer", async () => {
    await renderShell();
    openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });

    expect(backdropLevelOver(dialog)).toBeGreaterThan(0);

    // The one piece of BEHAVIOURAL evidence jsdom can give that the backdrop is
    // what a pointer aimed past the panel lands on: the overlay's own
    // `onMouseDown` fires only when the press targets the overlay ITSELF, and
    // it cancels the dialog. A press that had reached the rail underneath would
    // have left this dialog open.
    const overlay = dialog.parentElement as HTMLElement;
    fireEvent.mouseDown(overlay);
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    expect(settingsShowing()).toBe(false);
  });

  it("covers the rail with the Preview confirm's overlay too (ConfirmDialog)", async () => {
    // The OTHER backdrop, and not a hypothetical one: "stands the Preview's
    // open confirm down while the column is withdrawn" is held by this
    // component, so a restyle of `ConfirmDialog` alone would make that case's
    // opener reachable again while every Create Wiki assertion stayed green.
    await renderShell(TREE_DATA);
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: PREVIEW_EDIT_COPY }));
    const confirm = screen.getByRole("dialog");
    expect(
      screen.getByRole("button", { name: PREVIEW_EDIT_CONFIRM_LABEL }),
    ).toBeTruthy();

    expect(backdropLevelOver(confirm)).toBeGreaterThan(0);
  });

  it("keeps every .wb-rail and .wb-rail-item rule below the backdrop's level", async () => {
    await renderShell();
    openCreateWith("Quarterly review");
    const backdropZ = backdropLevelOver(
      screen.getByRole("dialog", { name: "Create Wiki" }),
    );

    const css = await stylesheet();
    const blocks = declarationBlocks(css);
    // The whole rail FAMILY, not just the two class names: `.wb-rail-item--active`
    // could carry a level of its own, and a control lifted by a modifier is
    // exactly as reachable as one lifted by its base rule.
    const railFamily = blocks.filter((rule) => /\.wb-rail[\w-]*/.test(rule.selector));

    // Picked by CONTENT, never by ordinal — the family holds a dozen rules and
    // an insertion anywhere above would silently re-point a positional index.
    const railRules = railFamily.filter((rule) => names(rule.selector, "wb-rail"));
    const base = railRules.find((rule) => /grid-column:\s*1;/.test(rule.body));
    expect(base).toBeDefined();
    expect(base?.body).not.toMatch(/z-index/);
    const narrow = railRules.find((rule) => /position:\s*fixed;/.test(rule.body));
    expect(narrow).toBeDefined();
    expect(narrow?.body).toMatch(/z-index:\s*40;/);

    // The CONTROL the old rows were clicking, which is a `.wb-rail-item` and
    // not the rail itself: give this one a level above the backdrop and it
    // outranks the overlay while every `.wb-rail` assertion above still passes.
    const itemRules = railFamily.filter((rule) => names(rule.selector, "wb-rail-item"));
    const item = itemRules.find((rule) => /position:\s*relative;/.test(rule.body));
    expect(item).toBeDefined();
    expect(item?.body).not.toMatch(/z-index/);

    // `.wb-shell` opens no stacking context either, so nothing OUTSIDE these
    // rules can lift them as a group. Only the two properties that would do it
    // by themselves are checked: `transform`, `filter` and `contain` also
    // create one, but this is the shell's shared base rule and any of the three
    // could arrive for an unrelated reason — a pin that broke on those would be
    // asserting layout policy rather than this entry's contract.
    const shellBase = blocks
      .filter((rule) => rule.selector === ".wb-shell")
      .find((rule) => /position:\s*relative;/.test(rule.body));
    expect(shellBase).toBeDefined();
    expect(shellBase?.body).not.toMatch(/z-index/);
    expect(shellBase?.body).not.toMatch(/isolation/);

    // THE ASSERTION THIS BLOCK EXISTS FOR. Every `z-index` any rail-family rule
    // declares — `matchAll`, because a fallback followed by an override would
    // otherwise be judged on the losing declaration — is below the backdrop.
    let declared = 0;
    for (const rule of railFamily) {
      for (const [, raw] of rule.body.matchAll(/z-index:\s*([^;}]+)/g)) {
        declared += 1;
        const level = Number(raw.trim());
        if (!Number.isFinite(level)) {
          // Loud, not skipped: a `var(…)` or `calc(…)` level cannot be compared
          // here, and silently passing over it would leave the rail lifted with
          // this case still green.
          throw new Error(
            `\`${rule.selector}\` declares \`z-index: ${raw.trim()}\`, which this ` +
              `scan cannot compare against the backdrop's ${backdropZ}. Resolve it ` +
              `by hand — an unreadable level is not a level below the backdrop.`,
          );
        }
        expect(level).toBeLessThan(backdropZ);
      }
    }
    // Not vacuous: the narrow block's 40 is a real declaration, so a scan that
    // matched nothing at all would be a broken extraction rather than a clean
    // stylesheet.
    expect(declared).toBeGreaterThan(0);
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
    //
    // `!important` is the half that holds the withdrawal against every normal
    // author declaration (DW-415) — the floor, not the selector's specificity,
    // as the rule's own comment argues. Asserted here so a restyle cannot
    // quietly drop it; that it wins the live cascade is
    // `hidden-withdrawal-cascade.test.tsx`.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.wb-canvas\[hidden\] \{\s*display: none !important;\s*\}/,
    );

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
    // settings nav. So the same read-back the canvas gets, for the same reason —
    // including the `!important` floor (DW-415), which is what keeps either
    // column withdrawn against every normal author declaration.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    for (const selector of [".wb-preview[hidden]", ".wb-tree-panel[hidden]"]) {
      const rule = new RegExp(
        `${selector.replace(/[.[\]]/g, "\\$&")} \\{\\s*display: none !important;\\s*\\}`,
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
