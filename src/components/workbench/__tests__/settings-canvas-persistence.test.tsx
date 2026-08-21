import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  SETTINGS_LABEL,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The mode canvas SURVIVES a trip through Settings (DW-373), MOUNTED.
 *
 * `Workbench` used to render `settingsOpen ? <SettingsCanvas/> : <ModeCanvas/>`,
 * so opening Settings — by the rail control or by `g s` — unmounted the whole
 * mode canvas and with it the Wiki subtree: an open Create Wiki dialog, the name
 * the owner had typed into it and the error it was showing. Coming back built an
 * empty card. DW-26 bought that subtree survival for MODE SWITCHES only, and
 * Settings was the door it did not cover.
 *
 * The fix is the same withdrawal DW-26 already uses one level down: both
 * canvases mount, and the mode one goes behind `hidden`. Nothing a source scan
 * can see — the defect is what React does to a subtree that stops being
 * rendered — so the cases below are driven on the live document, across a real
 * click and a real keystroke.
 *
 * Hiding is not closing, and that distinction is the whole design.
 * `CreateWikiDialog` resets its fields when `open` goes false, so flipping
 * `open` to hide the dialog would discard the very draft this preserves.
 *
 * WHAT IS PRESERVED IS THE MODE CANVAS AND ITS SUBTREE, and that is the whole
 * of it. Three other things do not survive the trip, each on purpose and none of
 * them this fix's business:
 *
 * - the Settings draft, which is discarded on the way OUT. `SettingsCanvas` is
 *   still rendered CONDITIONALLY, so closing Settings unmounts it — the whole of
 *   "unsaved edits do not apply and are discarded on leave". A case below drives
 *   exactly that, so a future attempt to keep the Settings surface mounted too
 *   fails here rather than in a hand test;
 * - the docked Preview column, and with it an in-progress Preview markdown edit.
 *   `previewOpen` is `shouldDockPreview(mode, selection) && !settingsOpen`,
 *   untouched by DW-373: a docked Preview beside the settings nav would describe
 *   a tree row the owner cannot point at. The silent discard is a deferral
 *   `Workbench.tsx` records at the selection guard, not something this fix
 *   closes;
 * - the left column's trees, which `SettingsNav` takes the column from
 *   (UX-DR14).
 *
 * COVERAGE LIMIT: jsdom has no layout engine, and no stylesheet is in the
 * document unless a case puts one there — so in every case but the last,
 * `hidden` is an ATTRIBUTE and nothing more. What those cases can observe is the
 * contract the attribute carries (the a11y tree, via testing-library's
 * `hidden`-aware queries) and the document state a hidden dialog must not be
 * holding (`document.body.style.overflow`, the Tab trap), which is precisely the
 * half `hidden` does NOT deliver on its own. The last case covers the other
 * half by injecting the real rules and reading the cascade back.
 *
 * AND THE DOM SCROLL OFFSET IS NOT COMPONENT STATE. `.wb-canvas` is the scroll
 * container (`overflow: auto`) and it is the element `display: none` collapses,
 * so a Wiki canvas the owner had scrolled comes back from Settings at the top.
 * React state survives the trip; a scroll position is not React state. Not a
 * regression — the old code unmounted the section outright and lost it too — and
 * restoring it is out of scope here, but nothing below should be read as a claim
 * that the surface comes back pixel-identical.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity. `push` is spied precisely so its ABSENCE is observable — the
// `g s` case is about a keystroke that must reach Settings without navigating.
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

/** The stored settings, as `GET /api/settings` serves them. */
const STORED: WorkbenchSettingsPayload = {
  version: "s1:00000000000000000000000000000000",
  chatProvider: "openai",
  chatModel: "gpt-4o",
  ingestProvider: "anthropic",
  ingestModel: "claude-sonnet-4-20250514",
  customBaseUrl: null,
  hasCustomApiKey: false,
  llmTimeoutSeconds: null,
  vectorSearchEnabled: false,
  embeddingProvider: "openai",
  embeddingModel: "text-embedding-3-small",
  embeddingBaseUrl: null,
  hasEmbeddingApiKey: true,
  embeddingModelInEffect: null,
  embeddingModelOverridden: false,
  envEmbeddingProvider: null,
  envEmbeddingModel: null,
  envCustomBaseUrl: null,
  envEmbeddingApiKeyProviders: [],
  hasWorkersAiBinding: false,
  firecrawlBaseUrl: null,
  hasFirecrawlApiKey: false,
  language: "English",
  readOnly: false,
};

const DUPLICATE_NAME_COPY = "A wiki with that name already exists.";

let fetchMock: ReturnType<typeof vi.fn>;
/** Stylesheets a case put in the document, torn down with the tree below. */
let injected: HTMLStyleElement[] = [];

/**
 * Every rule in `globals.css` whose selector names the canvas SECTION class.
 *
 * `.wb-canvas` as a whole token, so `.wb-canvas-mode`, `.wb-canvas-pad` and
 * `.wb-canvas-preview-note` — three different elements — stay out of it. Rules
 * are collected at EVERY nesting depth and injected flat, so a `display` handed
 * to this class from inside an `@media` block is caught here rather than at a
 * width nobody tested. Flattening drops the condition, which is deliberate: a
 * `display` on this class cannot be width-scoped and still leave the withdrawal
 * intact at the widths it covers.
 *
 * WHAT THIS DOES NOT SEE, because the case it backs is named for the cascade: a
 * rule reaching the section any other way — `.wb-shell > section`, a bare
 * `section`, a `[hidden] { display: revert }` reset, a utility class — or one
 * from any stylesheet other than `globals.css`, the only file read. The guard
 * covers the shape a competing rule would plausibly take in THIS stylesheet,
 * which is the shape the triage that prompted it found; it is not a proof that
 * nothing in the cascade can reach the element.
 *
 * The pattern reads "a run with no braces in it, then a braced body with no
 * braces in it" — a declaration block holds no `{`, which is what separates one
 * from the `@media` wrapper around it.
 */
function canvasRules(css: string): string[] {
  const stripped = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const rules: string[] = [];
  for (const match of stripped.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    // Whatever follows the previous rule's closing brace is this one's selector.
    const selector = (match[1].split("}").pop() ?? "").trim();
    if (!selector || selector.startsWith("@")) continue;
    if (!/\.wb-canvas(?![\w-])/.test(selector)) continue;
    rules.push(`${selector} { ${match[2].trim()} }`);
  }
  return rules;
}

/** Put rules in the document, remembered so `afterEach` can drop them again. */
function injectCss(rules: string): void {
  const style = document.createElement("style");
  style.textContent = rules;
  document.head.appendChild(style);
  injected.push(style);
}

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  window.localStorage.clear();
  // jsdom's session history outlives `cleanup()`, and the shell mirrors its mode
  // into `?mode=` — so each test starts on a bare `/` rather than on whatever
  // mode the last one left in the URL, which `initialMode` would restore.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  // ONE stub for three callers, routed by URL rather than queued: the sidecar
  // probe fires at mount, `SettingsCanvas` reads on every open, and the card
  // POSTs its create. A one-shot answer would be spent on whichever fired first.
  fetchMock = vi.fn(async (url: unknown) => {
    const href = String(url);
    if (href.startsWith("/api/settings")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ workbench: STORED }),
      } as unknown as Response;
    }
    if (href === "/api/wikis") {
      // A REAL error, refused by the route rather than typed into a prop: the
      // sentence lives in `WikiWorkbench`'s state and the name lives in
      // `CreateWikiDialog`'s, so a fixture that only checked the name would pass
      // against a card rebuilt from scratch with the dialog reopened.
      return {
        ok: false,
        status: 409,
        json: async () => ({ error: DUPLICATE_NAME_COPY }),
      } as unknown as Response;
    }
    return { ok: true, status: 200, json: async () => ({}) } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  document.body.style.overflow = "";
  // `cleanup()` unmounts the tree; nothing else removes a `<style>` from the
  // head, and a stylesheet left behind would silently style the next case.
  for (const style of injected) style.remove();
  injected = [];
});

/**
 * The assembled shell, exactly as `page.tsx` composes it, inside the app's real
 * shortcut dispatcher — which is what lets the `g s` case below drive the same
 * mounted tree as the rail cases.
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

/** Open (or close) Settings the way the rail does, and let the read settle. */
async function toggleSettings(): Promise<HTMLButtonElement> {
  const control = clickRail(SETTINGS_LABEL);
  await act(async () => {});
  return control;
}

/**
 * The Create Wiki dialog's name field, found WITHOUT the a11y tree.
 *
 * `getByLabelText` skips `hidden` subtrees, which is exactly what the visible
 * cases rely on — so the hidden cases have to reach the node another way or they
 * could not tell "removed from the a11y tree" apart from "unmounted", which is
 * the one distinction this file exists for.
 */
function nameFieldNode(): HTMLInputElement | null {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return dialog?.querySelector("input") ?? null;
}

/** The canvas section that is SHOWING — the one carrying the skip-link target. */
function showingCanvas(): HTMLElement | null {
  return document.querySelector("#wb-canvas");
}

/** Is the in-shell Settings surface on screen? */
function settingsShowing(): boolean {
  return document.querySelector(".wb-set-pad") !== null;
}

/**
 * Open Create Wiki from the empty state, type a name, and drive a refused create
 * so the card is holding a real error.
 *
 * The opener is FOCUSED before it is clicked, which is what a pointer or a
 * keyboard activation actually does — `fireEvent.click` alone leaves
 * `document.activeElement` on `<body>`, so `useDialogA11y` would record the body
 * as the opener and every focus assertion below would be about nothing.
 */
async function openCreateWithError(name: string): Promise<HTMLButtonElement> {
  const opener = screen.getByRole("button", { name: "Create Wiki" }) as HTMLButtonElement;
  opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText("Wiki name"), { target: { value: name } });
  fireEvent.click(screen.getByRole("button", { name: "Create" }));
  await act(async () => {});
  expect(screen.getByRole("alert").textContent).toBe(DUPLICATE_NAME_COPY);
  return opener;
}

describe("an open Create Wiki dialog survives a trip through Settings (DW-373)", () => {
  it("keeps the typed name and the shown error across the rail's Settings control", async () => {
    await renderShell();
    await openCreateWithError("Quarterly review");

    await toggleSettings();
    expect(settingsShowing()).toBe(true);
    await toggleSettings();
    expect(settingsShowing()).toBe(false);

    // Same dialog, same draft, same failure — not a fresh one seeded with the
    // template's default name.
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      "Quarterly review",
    );
    expect(screen.getByRole("alert").textContent).toBe(DUPLICATE_NAME_COPY);
  });

  it("keeps it across `g s` too, without navigating", async () => {
    // The keyboard door. `g s` reaches the same one piece of shell state, so a
    // fix that only covered the rail control would still destroy the draft for
    // anyone who never touches the pointer — and `push` is spied so the route
    // change DW-62 removed cannot creep back in under this change.
    await renderShell();
    await openCreateWithError("Quarterly review");

    fireEvent.keyDown(document.body, { key: "g" });
    fireEvent.keyDown(document.body, { key: "s" });
    await act(async () => {});

    expect(settingsShowing()).toBe(true);
    expect(router.push).not.toHaveBeenCalled();
    // Still in the document behind `hidden`, holding the draft.
    expect(nameFieldNode()?.value).toBe("Quarterly review");

    // `g s` OPENS rather than toggles, so the rail control is the way back.
    await toggleSettings();
    expect(settingsShowing()).toBe(false);
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      "Quarterly review",
    );
    expect(screen.getByRole("alert").textContent).toBe(DUPLICATE_NAME_COPY);
  });

  it("is HIDDEN rather than unmounted while Settings is showing", async () => {
    await renderShell();
    await openCreateWithError("Quarterly review");

    await toggleSettings();

    // Out of the accessibility tree: testing-library's default queries respect
    // `hidden`, so a dialog behind it is unreachable by role and by label — the
    // same thing a screen reader and a Tab press see.
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    // By ROLE, not by label: `queryByLabelText` walks the DOM and knows nothing
    // about the accessibility tree, so it finds a hidden field and would report
    // this as a failure whichever way the fix went.
    expect(screen.queryByRole("textbox", { name: "Wiki name" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    // …but still in the DOCUMENT, holding the draft. This is what tells hiding
    // apart from the unmount that was the defect: an unmounted dialog has no
    // node to find at all.
    expect(nameFieldNode()?.value).toBe("Quarterly review");
    // And the attribute that does it is on the CANVAS SECTION this time, one
    // level up from `.wb-canvas-mode` — a wrapper cannot hide the element that
    // contains it, and the section is what Settings used to replace.
    const sections = Array.from(document.querySelectorAll("section.wb-canvas"));
    expect(sections).toHaveLength(2);
    const hiddenSection = sections.find((section) => section.hasAttribute("hidden"));
    expect(hiddenSection).toBeTruthy();
    expect(hiddenSection?.contains(nameFieldNode())).toBe(true);
    // The dialog itself is untouched — closing it would reset its fields, which
    // is the draft this preserves.
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeTruthy();
  });

  it("holds neither the body scroll lock nor the Tab trap while hidden", async () => {
    await renderShell();
    await openCreateWithError("Quarterly review");
    // The lock is real while the dialog is on screen — a positive control, so
    // the negative below cannot pass because the lock was never taken.
    expect(document.body.style.overflow).toBe("hidden");

    await toggleSettings();

    // `hidden` removes the pixels, the a11y tree entry and the tab-order entry,
    // and NOTHING that the dialog did to the document: the scroll lock and the
    // capture-phase Tab listener both outlive it unless the surface publishes
    // its visibility and the hook stands down.
    expect(document.body.style.overflow).toBe("");

    // Tab is not trapped. The trap is a capture-phase listener that calls
    // `preventDefault` and pulls focus back into the dialog; with it armed over
    // a hidden canvas, the keyboard user is stuck on a surface they cannot see.
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

    // Esc is stood down with them, and it is the one input that could undo this
    // whole change: `useDialogA11y` answers it by calling `onDismiss`, and a
    // dismissed `CreateWikiDialog` resets its fields — so a live handler over a
    // canvas nobody can see would wipe the draft the owner still expects to
    // find. It shares the `armed` gate with the two above TODAY, which is
    // exactly why it is worth pinning separately: splitting it back onto `open`
    // alone is a one-line change that leaves every other case here green.
    const escape = new KeyboardEvent("keydown", {
      key: "Escape",
      bubbles: true,
      cancelable: true,
    });
    railButton.dispatchEvent(escape);
    expect(escape.defaultPrevented).toBe(false);
    expect(nameFieldNode()?.value).toBe("Quarterly review");

    // …and coming back re-arms all three. The scroll lock is read off the
    // document; the trap is re-dispatched rather than assumed, because "both"
    // was previously claimed by a comment and checked in one half.
    await toggleSettings();
    expect(document.body.style.overflow).toBe("hidden");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    expect(document.activeElement).toBe(dialog);
    // Shift+Tab off the container is the branch the trap answers by pulling
    // focus to the LAST focusable inside it — a plain Tab from the container
    // is a no-op in an armed trap too, so it could not tell the two apart.
    const trapped = new KeyboardEvent("keydown", {
      key: "Tab",
      shiftKey: true,
      bubbles: true,
      cancelable: true,
    });
    dialog.dispatchEvent(trapped);
    expect(trapped.defaultPrevented).toBe(true);
  });

  it("does not move focus when it hides the canvas", async () => {
    // DW-26's rule, at this door. The owner put focus on the rail control
    // themselves, and the recorded opener is inside the subtree that just went
    // off screen — "restoring" to it would push the keyboard into hidden
    // content.
    await renderShell();
    await openCreateWithError("Quarterly review");
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Create Wiki" }),
    );

    const control = await toggleSettings();
    expect(document.activeElement).toBe(control);

    // RE-SHOWING focuses the dialog again, exactly as opening it did.
    await toggleSettings();
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Create Wiki" }),
    );
  });

  it("never puts a second #wb-canvas on the page, in any mode", async () => {
    // `CANVAS_ID` is the skip link's target (`SiteChrome` renders
    // `<a href="#wb-canvas">`), and mounting two canvases at once is exactly the
    // change that could have given it two — which would leave the browser to
    // pick, and could land the bypass on the canvas nobody can see.
    await renderShell();

    for (const mode of ["Wiki", "Chat", "Graph"]) {
      clickRail(mode);
      await act(async () => {});

      await toggleSettings();
      expect(settingsShowing()).toBe(true);
      expect(document.querySelectorAll("#wb-canvas")).toHaveLength(1);
      expect(document.querySelectorAll(".wb-canvas")).toHaveLength(2);
      // The id and the landing place belong to the canvas that is SHOWING.
      expect(showingCanvas()?.querySelector(".wb-set-pad")).toBeTruthy();
      expect(showingCanvas()?.hasAttribute("hidden")).toBe(false);
      expect(document.querySelectorAll('.wb-canvas[tabindex="-1"]')).toHaveLength(1);
      expect(document.querySelector('.wb-canvas[tabindex="-1"]')).toBe(showingCanvas());
      // …and it is FIRST in document order, which is the invariant
      // `document.querySelector(".wb-canvas")` rests on — an idiom several
      // suites already use to mean "the canvas the owner is looking at".
      // Swapping the two JSX blocks changes nothing else and breaks only this.
      expect(document.querySelector(".wb-canvas")).toBe(showingCanvas());

      await toggleSettings();
      expect(document.querySelectorAll(".wb-canvas")).toHaveLength(1);
      expect(showingCanvas()?.hasAttribute("hidden")).toBe(false);
    }
  });

  it("hands the canvas back in ONE commit when the rail switches mode out of Settings", async () => {
    // `applyMode` calls `setSettingsOpen(false)` and `setModeState(next)`
    // together, so a single transition unmounts `SettingsCanvas`, un-hides this
    // section, moves `CANVAS_ID` and the tab index back onto it AND flips the
    // mode branch — all in one render. Every other case here drives the two
    // halves separately, which is the one arrangement that cannot observe them
    // landing at once: an id handed over mid-commit, or a section that un-hides
    // while the surface it was hidden for is still mounted, would show up
    // nowhere else.
    await renderShell();
    await openCreateWithError("Quarterly review");
    await toggleSettings();
    expect(settingsShowing()).toBe(true);

    clickRail("Chat");
    await act(async () => {});

    // Settings is gone — picking a mode is a way out of it, not a thing it
    // survives — and the canvas that is left is the only one.
    expect(settingsShowing()).toBe(false);
    expect(document.querySelectorAll(".wb-canvas")).toHaveLength(1);
    expect(document.querySelectorAll("#wb-canvas")).toHaveLength(1);
    expect(document.querySelectorAll('.wb-canvas[tabindex="-1"]')).toHaveLength(1);
    expect(document.querySelector('.wb-canvas[tabindex="-1"]')).toBe(showingCanvas());
    expect(showingCanvas()?.hasAttribute("hidden")).toBe(false);
    expect(screen.getByRole("heading", { name: "Chat" })).toBeTruthy();

    // The draft changed which attribute is hiding it — `.wb-canvas-mode[hidden]`
    // now, DW-26's, instead of the section's — and nothing else. Unreachable by
    // role, still in the document, still holding the name.
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    expect(nameFieldNode()?.value).toBe("Quarterly review");
    expect(
      document.querySelector(".wb-canvas-mode")?.hasAttribute("hidden"),
    ).toBe(true);

    clickRail("Wiki");
    await act(async () => {});
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      "Quarterly review",
    );
    expect(screen.getByRole("alert").textContent).toBe(DUPLICATE_NAME_COPY);
  });

  it("gives the two canvases separate heading ids", async () => {
    // `ModeCanvas`'s stub branch renders `<h2 id={headingId}>` for every
    // non-Wiki mode and `SettingsCanvas`'s frame renders one too. Sharing the
    // shell's single `useId` was safe only while the two could never mount
    // together; with both in the document it is a duplicate id, and each
    // canvas's `aria-labelledby` would resolve to whichever came first.
    await renderShell();
    clickRail("Chat");
    await act(async () => {});
    await toggleSettings();

    // Asked of EACH canvas rather than of the document: a document-wide count
    // of `h2[id]` is satisfied by one canvas that renders two headings and one
    // that renders none — and none is the shape a regression takes here, since
    // dropping the second `useId` along with the heading it names makes a
    // duplicate id impossible too, which is the very thing being pinned.
    //
    // The mode canvas legitimately holds more than one `<h2 id>`: its own stub
    // heading for the non-Wiki mode, plus `WikiWorkbench`'s, which stays in the
    // tree behind `.wb-canvas-mode[hidden]` (DW-26). So the assertion is on the
    // heading each section NAMES ITSELF BY, not on how many it contains.
    const sections = Array.from(document.querySelectorAll("section.wb-canvas"));
    expect(sections).toHaveLength(2);
    const ids = sections.map((section) => {
      // `aria-labelledby` is asserted non-empty first: `CSS.escape("")` builds
      // the selector `"#"`, which throws a SyntaxError rather than failing with
      // a readable message.
      const labelledBy = section.getAttribute("aria-labelledby") ?? "";
      expect(labelledBy).not.toBe("");
      const heading = section.querySelector(`#${CSS.escape(labelledBy)}`);
      // Inside its OWN section, and a heading — not resolved across the
      // document to the other canvas's, which is exactly what a shared id did.
      expect(heading?.tagName).toBe("H2");
      return labelledBy;
    });
    // Unique across the DOCUMENT, which is where an id collision is resolved —
    // not merely across the two ids collected above.
    expect(new Set(ids).size).toBe(2);
    for (const id of ids) {
      expect(document.querySelectorAll(`#${CSS.escape(id)}`)).toHaveLength(1);
    }
  });

  it("still discards an unsaved Settings edit on leave", async () => {
    // The other half of the contract, and the reason `SettingsCanvas` stays
    // CONDITIONAL while `ModeCanvas` became unconditional: leaving the surface
    // UNMOUNTS it, and that unmount is the whole of "unsaved edits do not apply
    // and are discarded on leave". Keeping it mounted behind `hidden` too would
    // be the obvious symmetry and would break exactly this.
    await renderShell();
    await toggleSettings();
    fireEvent.click(screen.getByRole("button", { name: "LLM Models" }));
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    const model = () => screen.getByLabelText("Chat model") as HTMLInputElement;
    expect(model().value).toBe(STORED.chatModel);
    fireEvent.change(model(), { target: { value: "an-unsaved-edit" } });
    expect(model().value).toBe("an-unsaved-edit");

    await toggleSettings();
    expect(settingsShowing()).toBe(false);
    await toggleSettings();
    await waitFor(() => expect(screen.queryByText("Loading…")).toBeNull());

    // The category is shell state and survives; the DRAFT is not and does not.
    expect(model().value).toBe(STORED.chatModel);
  });

  it("withdraws the hidden canvas through the real cascade, not just the attribute", async () => {
    // The `display: none` that turns the attribute into a visual withdrawal is a
    // user-agent default that ANY author rule setting `display` on the same
    // element beats, and `.wb-canvas` sets no `display` of its own — so it is
    // one restyle from being defeated, and with two canvases stacked in one grid
    // cell that restyle puts the hidden one back on top of Settings. Hence the
    // rule is STATED in `globals.css`, with the attribute in its selector.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(/\.wb-canvas\[hidden\] \{\s*display: none;\s*\}/);
    // Outside every media query: the canvas is hidden at all three widths
    // whenever Settings is showing. A rule wrapped in `@media (min-width: …)`
    // would put it — dialog, draft and all — back on screen wherever it missed.
    const before = css
      .slice(0, css.indexOf(".wb-canvas[hidden] {"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const depth =
      (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);

    // …AND IT HAS TO WIN, which the two assertions above cannot see. Stating
    // the rule only settles a tie: `.wb-canvas[hidden]` is specificity (0,2,0),
    // and a later descendant rule of a shape this very stylesheet already uses —
    // `.wb-shell[data-settings="true"] .wb-canvas { display: … }`, cf.
    // `.wb-shell[data-collapsed="true"][data-settings="true"] .wb-left` — is
    // (0,3,0) and beats it outright, with both the regex and the brace-depth
    // check still passing. So the real rules go into the document and the
    // CASCADE is read back off the live shell, which is the only thing that can
    // tell "the rule exists" from "the rule decides".
    injectCss(canvasRules(css).join("\n"));
    await renderShell();
    await toggleSettings();

    const sections = Array.from(
      document.querySelectorAll<HTMLElement>("section.wb-canvas"),
    );
    expect(sections).toHaveLength(2);
    const hiddenSection = sections.find((section) => section.hasAttribute("hidden"));
    expect(hiddenSection).toBeTruthy();
    expect(getComputedStyle(hiddenSection!).display).toBe("none");
    // The positive control: the assertion above must be failing to find pixels
    // because THIS canvas has them, not because the injected sheet hides
    // everything it touches.
    expect(getComputedStyle(showingCanvas()!).display).not.toBe("none");
  });
});
