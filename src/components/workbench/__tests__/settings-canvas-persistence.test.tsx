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
import { SETTINGS_LABEL } from "@/lib/workbench-settings";

/**
 * The mode canvas SURVIVES opening Settings (DW-373), MOUNTED.
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
  // POSTs, and the Settings surface reads its payload. One stub answers all
  // three; only the create's answer is ever asserted on.
  fetchMock = vi.fn(
    async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
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
    /** A click focuses the control it lands on; that is the click, not the hide. */
    focusAfterOpen: () => rail(SETTINGS_LABEL) as Element,
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
    /** A keystroke aimed at the document moves focus nowhere at all. */
    focusAfterOpen: (before: Element) => before,
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
  ({ open, focusAfterOpen }) => {
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

    it("does not move focus when it hides the canvas", async () => {
      // HIDING must not move focus. Only the control the owner used may move it,
      // and only to itself — nothing here may "restore" focus to the recorded
      // opener, which is inside the subtree that just went off screen.
      await renderShell();
      openCreateWith("Quarterly review");
      const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
      expect(document.activeElement).toBe(dialog);

      await open();

      // Exactly what each path itself does and nothing more: clicking the rail
      // control focuses that button, `g s` touches focus not at all. (jsdom does
      // not blur through an ancestor `hidden` the way a browser does, which is
      // what leaves the keystroke case observable at all.)
      expect(document.activeElement).toBe(focusAfterOpen(dialog));
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
});
