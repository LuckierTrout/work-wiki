import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { KeyboardShortcutsProvider } from "@/hooks/useKeyboardShortcuts";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { announcementSentence } from "@/lib/live-region";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_LABEL,
  settingsAnnouncement,
  settingsCategory,
  type SettingsCategoryId,
} from "@/lib/workbench-settings";
import { workbenchMode } from "@/lib/workbench-modes";
import { CANVAS_ID } from "@/components/workbench/ModeCanvas";

/**
 * `g s` opens Settings ON THE MOUNTED SHELL (DW-62).
 *
 * The shortcut used to `router.push("/settings")` unconditionally, which
 * unmounts the SHELL — the rail, the left column, the Knowledge and Files
 * trees, the Preview, the canvas — and lands the owner on a flat page holding
 * none of them, to reach a surface the rail control opens in place. What the
 * action buys is that route change, and the cases below are written against
 * exactly that: the key reaches the surface, announces it the way the rail
 * does, and navigates nowhere.
 *
 * IT ALSO PRESERVES THE MODE CANVAS (DW-373), but no case here proves it.
 * `Workbench` used to swap `ModeCanvas` out for `SettingsCanvas`, so opening
 * Settings unmounted the Wiki subtree — dialog and draft included — whichever
 * control opened it; the shell now keeps that canvas mounted behind `hidden`.
 * The preservation is the RENDER's, identical for the key and the rail control,
 * and it is driven from `settings-canvas-persistence.test.tsx` rather than
 * restated here, where the subject is the keystroke: through BOTH controls in
 * that file's parameterised block, and — for the half that holds an open
 * `aria-modal` dialog, the "dialog and draft" clause above — by BACK, because
 * with a backdrop over the rail and a Tab trap armed, NEITHER control is
 * reachable to open it with (DW-426, DW-511).
 * DW-26's mode-switch half lives in `wiki-canvas-persistence.test.tsx`.
 *
 * `keyboard-shortcuts.test.ts` executes the matcher and can see that `g s`
 * carries an action id; only a mounted shell can see the rest.
 *
 * The route is NOT retired (DW-61). It is the fallback the last case here
 * drives: with no shell mounted nothing has claimed the action, and the
 * dispatcher pushes `/settings` exactly as before.
 */

// ONE stable router object — several components key effects on its identity.
// `push` is spied precisely so its ABSENCE is observable: this whole change is
// about a keystroke that must not navigate.
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

/** The announcement the rail's Settings control produces, from its own owner. */
const SETTINGS_ANNOUNCEMENT = settingsAnnouncement(
  settingsCategory(DEFAULT_SETTINGS_CATEGORY).label,
);

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  window.localStorage.clear();
  // jsdom's session history outlives `cleanup()`, and the shell mirrors its
  // mode into `?mode=` — so each test starts on a bare `/`.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  // `useSidecarStatus` probes the loopback port at mount.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    ),
  );
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block.
  cleanup();
  vi.unstubAllGlobals();
});

/** The shell inside the app's real dispatcher, as `ClientProviders` wraps it. */
async function renderShell() {
  const view = render(
    <KeyboardShortcutsProvider>
      <WorkbenchDataProvider value={DATA}>
        <Workbench>
          <p>canvas</p>
        </Workbench>
      </WorkbenchDataProvider>
    </KeyboardShortcutsProvider>,
  );
  await act(async () => {});
  return view;
}

/**
 * Type a key sequence at the document, which is where the dispatcher listens.
 *
 * `document.body` rather than any control: `isInputElement` suppresses the
 * shortcut inside form fields, so aiming these at a focused button would be
 * testing the suppression instead of the dispatch.
 */
async function press(...keys: string[]) {
  for (const key of keys) {
    fireEvent.keyDown(document.body, { key });
  }
  await act(async () => {});
}

/**
 * What the SHELL's polite live region says, sentence only.
 *
 * Scoped to a direct child of `.wb-shell` and taking the LAST match, for the
 * reasons `workbench-mode-url.test.tsx` documents in full: `SettingsCanvas`
 * renders its own polite status EARLIER in DOM order, and `PreviewColumn`
 * renders another as a grandchild. And the sentence is read through
 * `announcementSentence`, because a region asked to say the same thing twice
 * carries an invisible repeat mark the second time (DW-182) — which is exactly
 * what the double-press case below produces.
 */
function announced(): string {
  const regions = document.querySelectorAll('.wb-shell > .wb-sr-only[aria-live="polite"]');
  return announcementSentence(regions[regions.length - 1]?.textContent ?? "");
}

/** Which rail control the rail marks as the surface on screen, if any. */
function currentRailItem(): string | null {
  const marked = document.querySelector("nav.wb-rail [aria-current='page']");
  return marked?.getAttribute("aria-label") ?? null;
}

/** Is the in-shell Settings surface the canvas is showing? */
function settingsShowing(): boolean {
  return document.querySelector(".wb-set-pad") !== null;
}

/** A pane that is NOT the default, so the omit-at-default rule is observable. */
const OTHER_CATEGORY: SettingsCategoryId = "embeddings";

/** The Settings nav row for a pane, by the label the vocabulary gives it. */
function paneRow(id: SettingsCategoryId): HTMLButtonElement {
  return screen.getByRole("button", {
    name: settingsCategory(id).label,
  }) as HTMLButtonElement;
}

/** Which pane the Settings nav marks as showing, if any. */
function currentPane(): string | null {
  const marked = document.querySelector("nav.wb-set-nav [aria-current='page']");
  return marked?.textContent ?? null;
}

describe("g s on the mounted Workbench (DW-62)", () => {
  it("opens the in-shell Settings surface, mirrors it into the URL, and does not navigate", async () => {
    await renderShell();
    expect(settingsShowing()).toBe(false);
    const before = window.history.length;

    await press("g", "s");

    expect(settingsShowing()).toBe(true);
    // The key writes the URL, exactly as the rail control does (DW-167) — one
    // shared push helper, so there is no second spelling of "open Settings"
    // that reaches a different address. Pinned HERE rather than left to the
    // second-press case: that one asserts `history.length` is UNCHANGED, which a
    // first press that wrote nothing at all satisfies just as well, so without
    // this the whole URL half of `g s` could be deleted with the suite green.
    expect(window.location.search).toBe("?mode=wiki&settings=1");
    expect(window.history.length).toBe(before + 1);
    // The rail marks Settings as the surface on screen, exactly as its own
    // control does — the keystroke and the click reach one piece of state.
    expect(currentRailItem()).toBe(SETTINGS_LABEL);
    // The same announcement the rail path produces, sourced from the module
    // that owns it rather than retyped.
    expect(announced()).toBe(SETTINGS_ANNOUNCEMENT);
    // THE point of the change: the shell is still mounted, because nothing
    // navigated.
    expect(router.push).not.toHaveBeenCalled();
    expect(document.querySelector("nav.wb-rail")).not.toBeNull();
  });

  it("leaves the surface open on a second press, and takes the keyboard back to it", async () => {
    // `g s` reads "go to Settings" — that is its description in `SHORTCUTS` and
    // in the help overlay — so it OPENS rather than toggles. The rail control is
    // the one that toggles, because it renders an active state and therefore
    // reads as something that can be switched off; a key naming a destination
    // carries no such state, and a second press that closed the surface would
    // be a shortcut that undoes itself.
    //
    // "Go to" is a promise about the KEYBOARD, though, and that is the half
    // DW-425 was missing. The focus move used to be keyed on `settingsOpen`, so
    // the effect had no change to observe on a second press: the surface was
    // announced again and the keyboard stayed wherever it had drifted to — a
    // shortcut that says it went somewhere and did not. A nonce bumped on every
    // press is what makes the destination reachable twice.
    await renderShell();

    await press("g", "s");
    expect(document.activeElement).toBe(document.getElementById(CANVAS_ID));

    // The keyboard drifts off the surface — an Escape, a click on chrome, a
    // blur. `<body>` is where a browser leaves it, and it is where the
    // dispatcher listens, so the second press really is reachable from here.
    (document.activeElement as HTMLElement).blur();
    expect(document.activeElement).toBe(document.body);
    const before = window.history.length;

    await press("g", "s");

    expect(settingsShowing()).toBe(true);
    expect(currentRailItem()).toBe(SETTINGS_LABEL);
    // Still the Settings sentence — the region carries a repeat mark rather
    // than a different announcement, and `announced()` strips it.
    expect(announced()).toBe(SETTINGS_ANNOUNCEMENT);
    // …and the keyboard is where the announcement says it is.
    expect(document.activeElement).toBe(document.getElementById(CANVAS_ID));
    // No SECOND entry, though: the surface is already in the URL, so the href
    // this press would write is the one already showing and nothing is pushed.
    // An entry per repeat would be a Back the owner has to press twice.
    expect(window.history.length).toBe(before);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("keeps the owner on the pane they were reading, and still adds no entry", async () => {
    // DW-514 on the KEYBOARD route. `openSettings` hands `pushSurface` the pane
    // the shell is actually on, and every other case in this file presses `g s`
    // from the DEFAULT pane — where `surfaceHref(loc, mode, true, general)` and
    // `surfaceHref(loc, mode, true, DEFAULT_SETTINGS_CATEGORY)` are the same
    // string, so none of them can see which one was passed.
    //
    // Replace that argument with the constant and TWO things ship at once, with
    // this file otherwise green: the URL silently drops the pane the owner was
    // reading — DW-514's headline bug, arriving through the shortcut instead of
    // through a copied link — and the href the press would write stops matching
    // the one already showing, so a repeat press pushes a redundant entry the
    // owner has to Back through.
    await renderShell();
    await press("g", "s");
    fireEvent.click(paneRow(OTHER_CATEGORY));
    await act(async () => {});
    expect(window.location.search).toBe("?mode=wiki&settings=1&category=embeddings");
    (document.activeElement as HTMLElement | null)?.blur();
    const before = window.history.length;

    await press("g", "s");

    // "Go to Settings" means the surface, not a pane of it: the key names a
    // destination and the owner is already standing in it.
    expect(settingsShowing()).toBe(true);
    expect(currentPane()).toBe(settingsCategory(OTHER_CATEGORY).label);
    expect(window.location.search).toBe("?mode=wiki&settings=1&category=embeddings");
    // Same rule as the repeat press above — the href this press would write is
    // the one already showing, so nothing is pushed.
    expect(window.history.length).toBe(before);
    // …and the keyboard still lands where the announcement says it does.
    expect(document.activeElement).toBe(document.getElementById(CANVAS_ID));
    expect(announced()).toBe(
      settingsAnnouncement(settingsCategory(OTHER_CATEGORY).label),
    );
    expect(router.push).not.toHaveBeenCalled();
  });

  it("hands the surface back to the rail control, which still toggles it shut", async () => {
    // One piece of state, two ways in: a keystroke that opened a second,
    // parallel surface would leave the rail control closing something the
    // keyboard never opened.
    await renderShell();
    await press("g", "s");

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_LABEL }));
    await act(async () => {});

    expect(settingsShowing()).toBe(false);
    // Closing announces the mode the owner lands back on, which is what the
    // rail's own toggle does.
    expect(announced()).toBe(workbenchMode("wiki").label);
    expect(router.push).not.toHaveBeenCalled();
  });

  it("still navigates to /settings on a page with no Workbench mounted", async () => {
    // The fallback, and the reason `route` survives beside `action`. Nothing has
    // claimed `open-settings` here, so the dispatcher takes the route — which is
    // what keeps the shortcut working on `/ingest`, `/query` and every other
    // page, and why `/settings` is not retired (DW-61).
    render(
      <KeyboardShortcutsProvider>
        <p>a page with no shell</p>
      </KeyboardShortcutsProvider>,
    );

    await press("g", "s");

    expect(router.push).toHaveBeenCalledWith("/settings");
  });

  it("releases the action when the shell goes away, so the route comes back", async () => {
    // The claim is held for the LIFETIME of the shell. Left registered after it
    // went away, `g s` would run a handler on a dead tree and the owner would
    // press it on the next page to no effect at all.
    //
    // The shell is swapped out UNDER the provider rather than unmounted with
    // it: tearing the dispatcher down too would leave no listener at all, so a
    // route that never fired would pass this case for the wrong reason.
    function App({ shell }: { shell: boolean }) {
      return (
        <KeyboardShortcutsProvider>
          {shell ? (
            <WorkbenchDataProvider value={DATA}>
              <Workbench>
                <p>canvas</p>
              </Workbench>
            </WorkbenchDataProvider>
          ) : (
            <p>a page with no shell</p>
          )}
        </KeyboardShortcutsProvider>
      );
    }
    const { rerender } = render(<App shell />);
    await act(async () => {});
    await press("g", "s");
    expect(router.push).not.toHaveBeenCalled();

    rerender(<App shell={false} />);
    await act(async () => {});
    await press("g", "s");

    expect(router.push).toHaveBeenCalledWith("/settings");
  });
});
