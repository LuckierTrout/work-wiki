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
} from "@/lib/workbench-settings";
import { workbenchMode } from "@/lib/workbench-modes";

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
 * IT DOES NOT PRESERVE THE MODE CANVAS, and no case here claims it does.
 * `Workbench` swaps `ModeCanvas` out for `SettingsCanvas` while Settings is
 * open, so opening Settings unmounts the Wiki subtree — dialog and draft
 * included — whichever control opens it. That is the rail control's behaviour
 * too; DW-26's subtree survival covers MODE SWITCHES, which is where
 * `wiki-canvas-persistence.test.tsx` drives it.
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

describe("g s on the mounted Workbench (DW-62)", () => {
  it("opens the in-shell Settings surface and announces it, without navigating", async () => {
    await renderShell();
    expect(settingsShowing()).toBe(false);

    await press("g", "s");

    expect(settingsShowing()).toBe(true);
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

  it("leaves the surface open on a second press", async () => {
    // `g s` reads "go to Settings" — that is its description in `SHORTCUTS` and
    // in the help overlay — so it OPENS rather than toggles. The rail control is
    // the one that toggles, because it renders an active state and therefore
    // reads as something that can be switched off; a key naming a destination
    // carries no such state, and a second press that closed the surface would
    // be a shortcut that undoes itself.
    await renderShell();

    await press("g", "s");
    await press("g", "s");

    expect(settingsShowing()).toBe(true);
    expect(currentRailItem()).toBe(SETTINGS_LABEL);
    // Still the Settings sentence — the region carries a repeat mark rather
    // than a different announcement, and `announced()` strips it.
    expect(announced()).toBe(SETTINGS_ANNOUNCEMENT);
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
