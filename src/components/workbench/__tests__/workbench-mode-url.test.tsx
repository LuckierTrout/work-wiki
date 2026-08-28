import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import {
  readStoredMode,
  writeStoredMode,
  writeStoredSelection,
} from "@/lib/workbench-state";
import { announcementSentence } from "@/lib/live-region";
import { CANVAS_ID } from "@/components/workbench/ModeCanvas";
import {
  DEFAULT_SETTINGS_CATEGORY,
  SETTINGS_LABEL,
  settingsAnnouncement,
  settingsCategory,
} from "@/lib/workbench-settings";

/**
 * DW-27 / DW-167 — the active surface mirrored into the URL, MOUNTED.
 *
 * The mode goes into `?mode=` and an open Settings surface into `?settings=1`,
 * alongside it rather than instead of it — so a copied link reopens Settings
 * over the canvas it was opened from, and Back on the first entry of a session
 * closes the surface instead of leaving the app with an unsaved Settings draft
 * in it. The keyboard follows the canvas in both directions (DW-423): a
 * traversal has no control holding it, so `#wb-canvas` has to catch it.
 *
 * `workbench-url.test.ts` executes the URL rules and `workbench-chrome.test.ts`
 * reads the shell as text — between them they can see that `pushState` is
 * spelled and that `initialMode` answers correctly, and neither can see whether
 * the browser's address bar actually moves, whether Back returns to the previous
 * mode, or whether any of it costs the shell a remount. Those are the behaviours
 * here, observed on a real (jsdom) session history.
 *
 * COVERAGE LIMIT, and it is the one claim in this feature no test can reach:
 * Next 15 PATCHES `history.pushState`/`replaceState` into its router, and that
 * patch is what makes these calls shallow routing rather than a URL the router
 * disagrees with. It is installed by the router this file mocks away, so what
 * runs below is jsdom's raw history. "No remount" is therefore verified as React
 * keeping the tree (same rail node by identity, sidecar probe not re-run), not
 * as App Router behaviour on a `force-dynamic` route — that half is argued from
 * the Next docs in `Workbench.tsx`'s header and confirmed in a browser, never
 * here.
 */

// ONE stable router object: several components in this shell key effects on
// the router identity, and a fresh literal per call would rebuild them on
// every re-render. Nothing under test calls it — that is the point of the ban —
// but `next/navigation` is unavailable outside a Next render otherwise.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
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

/** The Wiki a restored selection has to still belong to. */
const WIKI_ID = "wiki-1";

/**
 * A working set with a row in it, for the restore-signature case.
 *
 * The empty fixture above cannot reach that path at all: `restorableSelection`
 * declines on a null `currentWikiId`, so no signature is ever recorded and the
 * reset effect's guard is never executed.
 */
const LOADED: WorkbenchData = {
  ...DATA,
  currentWikiId: WIKI_ID,
  knowledge: [
    {
      id: "note",
      label: "Note",
      count: 1,
      pages: [{ slug: "alpha", title: "Alpha", type: "note" }],
    },
  ],
};

beforeEach(() => {
  // jsdom's session history outlives `cleanup()`, so each test starts on
  // whatever entry the last one left the cursor on. The push lands the cursor
  // back on the TAIL — a test that ended on Back would otherwise leave forward
  // entries for the next `pushState` to prune, and `history.length` would move
  // by something other than +1. The replace then puts the URL back to a bare
  // `/` without adding a second entry.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  window.localStorage.clear();
  // `useSidecarStatus` probes the loopback port at mount. An affirmative answer
  // keeps the probe off the network and lets the resulting setState settle
  // inside `act`. It is also the remount detector below: the probe runs once
  // per mount.
  // `PreviewColumn` reads a docked row's bytes through the same global, so the
  // stub answers both shapes rather than only the probe's `ok`.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({}),
          text: async () => "",
        }) as unknown as Response,
    ),
  );
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this block. Unmounting here tears
  // the tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
  // The degrade cases spy on `window.history` itself. `restoreMocks` is not set
  // in `vitest.config.ts`, so without this a throwing `replaceState` would
  // outlive its own test and take the NEXT file's `beforeEach` reset with it.
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
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

/** The rail button for a mode, by its accessible name. */
function railItem(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/** Which rail control the rail marks as the surface on screen, if any. */
function current(): string | null {
  const marked = document.querySelector("nav.wb-rail [aria-current='page']");
  return marked?.getAttribute("aria-label") ?? null;
}

/**
 * What the SHELL's polite live region currently says.
 *
 * Scoped to `.wb-sr-only`, not to the first `[aria-live="polite"]` in the
 * document: `SettingsCanvas` renders its own polite status span, and it sits
 * EARLIER in DOM order than the shell's announcer. An unscoped query therefore
 * reads the Settings status whenever Settings is open — silently measuring a
 * different region in exactly the cases (a traversal with Settings open) where
 * this helper is load-bearing.
 *
 * Two mechanisms, two different regions:
 *
 * - the CHILD combinator excludes `PreviewColumn`'s own polite `.wb-sr-only`
 *   (DW-50), which is a GRANDchild — inside the `<aside>` — and sits earlier in
 *   DOM order, so a class-only query would read it in every test that docks a
 *   Preview;
 * - `[length - 1]` covers the remaining case, a second announcer added as a
 *   direct child of the shell. The shell's is the final one, and taking the
 *   last match keeps this reading it rather than whatever is inserted above.
 *
 * The text goes through `announcementSentence`, because a region that has to
 * say the same thing twice carries an invisible repeat mark on the second write
 * (DW-182). The mark is not spoken, so every assertion here is about the
 * SENTENCE; read verbatim, the first repeated announcement anywhere in the
 * shell would fail a case in this file on a one-character diff nobody can see.
 */
function announced(): string {
  const regions = document.querySelectorAll('.wb-shell > .wb-sr-only[aria-live="polite"]');
  return announcementSentence(regions[regions.length - 1]?.textContent ?? "");
}

/** Is the in-shell Settings surface showing? */
function settingsShowing(): boolean {
  return document.querySelector(".wb-set-pad") !== null;
}

/** The section currently answering to `#wb-canvas` — the shell's landing site. */
function landingSite(): HTMLElement | null {
  return document.getElementById(CANVAS_ID);
}

/** The announcement the Settings surface produces, from the module that owns it. */
const SETTINGS_ANNOUNCEMENT = settingsAnnouncement(
  settingsCategory(DEFAULT_SETTINGS_CATEGORY).label,
);

/** How long to wait for a traversal jsdom may never perform. */
const POPSTATE_TIMEOUT_MS = 1000;

/**
 * Traverse the session history and let the `popstate` land.
 *
 * jsdom queues traversal on its own event loop and fires `popstate` some tasks
 * later — a `setTimeout(0)` is NOT enough, and the assertion would then run
 * against the pre-traversal tree and pass for the wrong reason on a shell that
 * ignores `popstate` entirely. So this waits for the event itself, inside `act`
 * so the handler's `setState` is flushed before the caller looks at the DOM.
 *
 * The timeout is a deadline, not a fallback: without it a shell that never
 * traverses would hang the run instead of failing it.
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
      // Registered AFTER the shell's own listener, so React has already been
      // handed the state change by the time this resolves.
      window.addEventListener("popstate", onPop, { once: true });
      go();
    });
  });
}

describe("Workbench mode ↔ URL", () => {
  it("lets a deep link beat the stored mode, silently", async () => {
    window.history.replaceState(null, "", "/?mode=chat");
    writeStoredMode("wiki");

    await renderShell();

    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?mode=chat");
    // Restoring a mode on load is not a change the owner made. Announcing it
    // would report a mode switch that never happened, on every deep link.
    expect(announced()).toBe("");
    // …and the link WRITES ITSELF DOWN, silently. Without this the owner's next
    // visit to a bare `/` drops them back into the mode they were in before
    // they followed the link — "what is on screen" and "what a param-less
    // reload restores" would have diverged the moment the link was opened.
    expect(readStoredMode()).toBe("chat");
  });

  it("seeds the URL from storage on load without adding a history entry", async () => {
    writeStoredMode("lint");
    const before = window.history.length;

    await renderShell();

    expect(current()).toBe("Lint");
    // Every entry the shell owns names its mode explicitly, so Back never lands
    // on one whose mode is implied.
    expect(window.location.search).toBe("?mode=lint");
    // `replaceState`, not `pushState`: the owner's Back button must still leave
    // the app on the first press.
    expect(window.history.length).toBe(before);
  });

  it("rewrites a normalizable query once on load, adding no entry", async () => {
    // `surfaceHref` rebuilds the query with `URLSearchParams.toString()`, which
    // re-encodes rather than echoing: `%20` becomes `+`. So on a URL like this
    // the seed's `seeded !== locationHref` comparison is true from the encoding
    // ALONE, even though `mode` was already correct — the rewrite is real and
    // this is what bounds it to a cosmetic one-off. The pure suite proves the
    // string; only a mounted case can prove the owner's Back button does not
    // pay for it.
    window.history.replaceState(null, "", "/?q=a%20b&mode=chat");
    const before = window.history.length;

    await renderShell();

    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?q=a+b&mode=chat");
    expect(window.history.length).toBe(before);
    // Re-encoded, not lost: the value still parses back to what it came in as.
    expect(new URLSearchParams(window.location.search).get("q")).toBe("a b");
  });

  it("corrects an unknown value rather than rendering no active mode", async () => {
    window.history.replaceState(null, "", "/?mode=nope");
    writeStoredMode("graph");

    await renderShell();

    expect(current()).toBe("Graph");
    expect(window.location.search).toBe("?mode=graph");
  });

  it("pushes one entry on a mode switch, without remounting the shell", async () => {
    await renderShell();
    expect(current()).toBe("Wiki");
    const rail = screen.getByRole("navigation", { name: "Modes" });
    const before = window.history.length;
    const probes = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls.length;

    fireEvent.click(railItem("Chat"));

    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?mode=chat");
    expect(window.history.length).toBe(before + 1);
    // The whole reason this is `pushState` and not `router.push`: the route
    // segment is never re-rendered, so nothing above the mode panel unmounts.
    // Same rail node, and the sidecar probe did not run a second time.
    expect(screen.getByRole("navigation", { name: "Modes" })).toBe(rail);
    expect((globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(probes);
    expect(announced()).toBe("Chat");
    // The URL is layered ON the storage restore, never a replacement for it: a
    // reload with no param at all must still land on Chat.
    expect(readStoredMode()).toBe("chat");
  });

  it("keeps other params when it writes the mode", async () => {
    window.history.replaceState(null, "", "/?wiki=abc&mode=wiki");

    await renderShell();
    expect(window.location.search).toBe("?wiki=abc&mode=wiki");

    fireEvent.click(railItem("Search"));

    expect(window.location.search).toBe("?wiki=abc&mode=search");
  });

  it("returns to the previous mode on Back, and to the later one on Forward", async () => {
    await renderShell();
    fireEvent.click(railItem("Chat"));
    expect(current()).toBe("Chat");

    await traverse(() => window.history.back());

    expect(window.location.search).toBe("?mode=wiki");
    expect(current()).toBe("Wiki");
    // A traversal IS a change the owner made, so unlike the restore on load it
    // announces the surface it lands on.
    expect(announced()).toBe("Wiki");
    // A traversal moves storage too, for the same reason every other path does.
    expect(readStoredMode()).toBe("wiki");
    // No navigation left the page: the shell is the same mounted tree.
    expect(screen.getByText("canvas")).toBeTruthy();

    await traverse(() => window.history.forward());

    expect(window.location.search).toBe("?mode=chat");
    expect(current()).toBe("Chat");
  });

  it("closes Settings on Back, and leaves the mode the entry names", async () => {
    // Settings is a SURFACE over a mode, so the entry that carries it names the
    // mode underneath as well — which is what gives closing it somewhere to
    // land. Before DW-167 the surface was in no entry at all, so this Back went
    // straight past it to the previous MODE and the owner lost two steps for
    // one press.
    await renderShell();
    fireEvent.click(railItem("Chat"));
    fireEvent.click(railItem(SETTINGS_LABEL));
    expect(current()).toBe(SETTINGS_LABEL);
    expect(window.location.search).toBe("?mode=chat&settings=1");

    await traverse(() => window.history.back());

    expect(settingsShowing()).toBe(false);
    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?mode=chat");
    // A traversal IS a change the owner made, so it announces the surface it
    // lands on — here the mode the entry names, not the one two steps back.
    expect(announced()).toBe("Chat");
    // DW-423: the canvas swapped with no control holding the keyboard, so the
    // landing site has to catch it or the owner is dropped on `<body>`.
    expect(document.activeElement).toBe(landingSite());
    expect(landingSite()?.querySelector(".wb-set-pad")).toBeNull();

    await traverse(() => window.history.forward());

    // …and Forward puts it back, announcement and keyboard included.
    expect(settingsShowing()).toBe(true);
    expect(current()).toBe(SETTINGS_LABEL);
    expect(window.location.search).toBe("?mode=chat&settings=1");
    expect(announced()).toBe(SETTINGS_ANNOUNCEMENT);
    expect(document.activeElement).toBe(landingSite());
  });

  it("restores an open Settings surface from a deep link, silently", async () => {
    // The copied-link case, and the whole of Settings' persistence: there is no
    // stored Settings preference and there must not be one, so the param is the
    // only thing that can bring the surface back.
    window.history.replaceState(null, "", "/?mode=chat&settings=1");
    writeStoredMode("wiki");
    const before = window.history.length;
    const resting = document.activeElement;

    await renderShell();

    expect(settingsShowing()).toBe(true);
    expect(current()).toBe(SETTINGS_LABEL);
    expect(window.location.search).toBe("?mode=chat&settings=1");
    // A restore is not a change the owner made: no entry, nothing announced,
    // and the keyboard left exactly where the visitor had it.
    expect(window.history.length).toBe(before);
    expect(announced()).toBe("");
    expect(document.activeElement).toBe(resting);
    // …and the mode UNDERNEATH the surface came back with it, which is what
    // closing Settings then reveals. A `mode=settings` spelling could not have
    // carried this.
    expect(readStoredMode()).toBe("chat");
    fireEvent.click(railItem(SETTINGS_LABEL));
    expect(current()).toBe("Chat");
  });

  it("honours a settings flag that carries no mode, and seeds the mode beside it", async () => {
    // The two params are read independently: the flag comes straight from the
    // URL, the mode falls back to storage when the URL names none. So a
    // hand-shortened link still opens the surface it asked for, over the canvas
    // the owner last used rather than over nothing — and the seed's one
    // `replaceState` writes the mode in beside the flag, so the FIRST entry of
    // the session names a whole surface and Back has no half-named entry to
    // land on.
    window.history.replaceState(null, "", "/?settings=1");
    writeStoredMode("lint");
    const before = window.history.length;

    await renderShell();

    expect(settingsShowing()).toBe(true);
    expect(current()).toBe(SETTINGS_LABEL);
    expect(window.location.search).toBe("?settings=1&mode=lint");
    // Still a restore: normalized in place, with nothing announced and no entry.
    expect(window.history.length).toBe(before);
    expect(announced()).toBe("");

    // …and the mode it seeded is the one the surface is open OVER.
    fireEvent.click(railItem(SETTINGS_LABEL));

    expect(current()).toBe("Lint");
    expect(window.location.search).toBe("?mode=lint");
  });

  it("pushes one entry when Settings opens from the rail, and lands the keyboard", async () => {
    await renderShell();
    const before = window.history.length;

    const opener = railItem(SETTINGS_LABEL);
    opener.focus();
    fireEvent.click(opener);
    await act(async () => {});

    expect(settingsShowing()).toBe(true);
    expect(window.location.search).toBe("?mode=wiki&settings=1");
    // Exactly one — the press is a step the owner can undo, and no more than a
    // step.
    expect(window.history.length).toBe(before + 1);
    expect(document.activeElement).toBe(landingSite());

    // …and Back on the FIRST entry of the session closes the surface rather
    // than leaving the app holding an unsaved Settings draft (DW-167).
    await traverse(() => window.history.back());

    expect(settingsShowing()).toBe(false);
    expect(current()).toBe("Wiki");
    expect(announced()).toBe("Wiki");
    expect(document.activeElement).toBe(landingSite());
    // Nothing navigated: the shell is the same mounted tree.
    expect(screen.getByText("canvas")).toBeTruthy();
  });

  it("drops the flag and adds an entry when the rail control CLOSES Settings", async () => {
    await renderShell();
    fireEvent.click(railItem(SETTINGS_LABEL));
    const before = window.history.length;

    const closer = railItem(SETTINGS_LABEL);
    closer.focus();
    fireEvent.click(closer);
    await act(async () => {});

    expect(settingsShowing()).toBe(false);
    // DELETED, not written off: the closed surface has one URL, which is what
    // makes the skip-the-write comparison meaningful.
    expect(window.location.search).toBe("?mode=wiki");
    expect(window.history.length).toBe(before + 1);
    // The keyboard stays on the control that was pressed — it is what closed
    // the surface and it already holds focus.
    expect(document.activeElement).toBe(closer);
  });

  it("moves no focus on a traversal that only changes the mode", async () => {
    // The other half of the nonce's policy. The canvas the owner was standing
    // in is still the canvas on screen, so a focus move here would take the
    // keyboard off whatever they were using to traverse.
    await renderShell();
    fireEvent.click(railItem("Chat"));
    const resting = railItem("Graph");
    resting.focus();

    await traverse(() => window.history.back());

    expect(current()).toBe("Wiki");
    expect(announced()).toBe("Wiki");
    expect(document.activeElement).toBe(resting);
  });

  it("adds no entry when the surface already showing is clicked again", async () => {
    // Nothing about the URL moved, so there is nothing to undo: an entry here
    // would be one Back has to swallow before it can reach the mode the owner
    // came from. The guard is a comparison against the href the shell WOULD
    // write, so it covers both params at once.
    await renderShell();
    fireEvent.click(railItem("Chat"));
    const before = window.history.length;

    fireEvent.click(railItem("Chat"));

    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?mode=chat");
    expect(window.history.length).toBe(before);

    await traverse(() => window.history.back());

    expect(current()).toBe("Wiki");
  });

  it("closes Settings and adds one entry when a MODE is picked from it", async () => {
    // Picking a mode with Settings open is a return to a canvas, and since
    // DW-167 the URL says so — the flag really is dropped, so the press is a
    // step Back can undo, exactly as the rail's own Settings control is.
    await renderShell();
    fireEvent.click(railItem("Chat"));
    fireEvent.click(railItem(SETTINGS_LABEL));
    const before = window.history.length;

    fireEvent.click(railItem("Chat"));

    expect(settingsShowing()).toBe(false);
    expect(current()).toBe("Chat");
    expect(window.location.search).toBe("?mode=chat");
    expect(window.history.length).toBe(before + 1);

    await traverse(() => window.history.back());

    expect(settingsShowing()).toBe(true);
  });

  it("leaves everything alone on a traversal that does not move the mode", async () => {
    await renderShell();
    fireEvent.click(railItem("Settings"));
    expect(current()).toBe("Settings");
    const settingsAnnouncement = announced();
    const resting = railItem("Graph");
    resting.focus();
    // The skip link `SiteChrome` renders on this route is an
    // `<a href="#wb-canvas">`, and following it pushes a fragment entry that
    // carries the SAME query — mode and Settings flag both. Back from there is
    // a traversal the shell did not author and in which no surface changed.
    window.history.pushState(null, "", "/?mode=wiki&settings=1#wb-canvas");

    await traverse(() => window.history.back());

    // Handing this to the surface-change path would close Settings — which is
    // what DISCARDS the draft `SettingsCanvas` is holding — rewrite storage, and
    // announce a surface switch that never happened. Widening the guard to the
    // PAIR (DW-167) is what keeps that true now that the flag is in the URL.
    expect(current()).toBe(SETTINGS_LABEL);
    expect(announced()).toBe(settingsAnnouncement);
    expect(readStoredMode()).toBe("wiki");
    expect(window.location.search).toBe("?mode=wiki&settings=1");
    // …and the keyboard did not move either: nothing swapped.
    expect(document.activeElement).toBe(resting);
  });

  it("restores a stored row on a deep link whose mode is not the stored one", async () => {
    // The restore signature is built from the EFFECTIVE mode, and this is the
    // only session where the effective mode and the stored one differ. Built
    // from the stored mode instead, the signature would never match the layout
    // the shell is actually in — so the reset effect's guard would return
    // forever, and the Preview would go on describing a row that is no longer
    // in the tree on screen. Every existing assertion stays green through that.
    writeStoredMode("lint");
    writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
    window.history.replaceState(null, "", "/?mode=wiki");

    await renderShell(LOADED);

    // The URL beat the stored `lint`, and the row survived its own restore.
    expect(current()).toBe("Wiki");
    expect(screen.getByRole("complementary", { name: "Preview" })).toBeTruthy();

    // …and the guard cleared, so the NEXT layout change undocks as it always
    // has. Left pending, this click would change nothing.
    fireEvent.click(screen.getByRole("tab", { name: "Files" }));

    expect(screen.queryByRole("complementary", { name: "Preview" })).toBeNull();
  });

  it("puts the mode and the Settings surface in the URL, and nothing else", async () => {
    // The URL carries exactly two things. The tree tab, the collapse flag, the
    // selection and the column widths are browser-local view preferences with
    // nothing to link to, and putting any of them here would make every tab
    // click a history entry the owner has to Back through.
    await renderShell(LOADED);
    const search = window.location.search;
    const length = window.history.length;

    fireEvent.click(screen.getByRole("tab", { name: "Files" }));
    fireEvent.click(railItem("Collapse left column"));

    expect(screen.getByRole("tab", { name: "Files" }).getAttribute("aria-selected")).toBe(
      "true",
    );
    expect(window.location.search).toBe(search);
    expect(window.history.length).toBe(length);

    // Settings IS in it (DW-167) — ALONGSIDE the mode rather than as a mode
    // value, so the canvas underneath is still named and closing the surface
    // reveals it. The rail marks it `aria-current` exactly as it marks a mode,
    // and that resemblance is the reason the param has to be a separate one.
    fireEvent.click(railItem(SETTINGS_LABEL));

    expect(window.location.search).toBe(`${search}&settings=1`);
    expect(window.history.length).toBe(length + 1);

    // …and it comes back off, deleted rather than set to a falsy value.
    fireEvent.click(railItem(SETTINGS_LABEL));

    expect(window.location.search).toBe(search);
    expect(window.history.length).toBe(length + 2);
  });

  /**
   * The two history calls are wrapped in `catch {}` because a sandboxed or
   * opaque-origin document throws `SecurityError`, and Safari throws again after
   * ~100 calls in 30 seconds. Nothing observed those guards: jsdom's history
   * never throws, so BOTH could be deleted — or the mount one widened to wrap
   * the whole effect — with every suite in the repo still green. The contract
   * they encode is that a history failure costs the linkable URL and NOTHING
   * else, which is only checkable by making the call fail.
   */
  describe("when the History API refuses", () => {
    it("still finishes mounting, restored row and all", async () => {
      writeStoredSelection(WIKI_ID, { kind: "page", slug: "alpha" });
      vi.spyOn(window.history, "replaceState").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });

      await renderShell(LOADED);

      // The seed sits BEFORE the selection restore and `setMounted(true)`, so a
      // guard around the whole effect would take the docked Preview and the
      // inline width vars with it — a layout bug with no visible connection to
      // the URL.
      expect(screen.getByRole("complementary", { name: "Preview" })).toBeTruthy();
      expect(document.querySelector(".wb-shell")?.getAttribute("data-mounted")).toBe(
        "true",
      );
      expect(current()).toBe("Wiki");
    });

    it("still switches mode on a rail click, losing only the URL", async () => {
      await renderShell();
      vi.spyOn(window.history, "pushState").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });

      // The state assertions below CANNOT see this failure on their own:
      // `applyMode` runs before the push, so the mode, the storage write and the
      // announcement all land whether or not the throw is caught — React just
      // rethrows the escaped error asynchronously, out of band, and every
      // assertion here still passes. Catching what escapes is the only thing
      // that tells the two apart.
      const escaped: unknown[] = [];
      const onError = (event: ErrorEvent) => {
        event.preventDefault();
        escaped.push(event.error);
      };
      window.addEventListener("error", onError);
      try {
        fireEvent.click(railItem("Chat"));
        await act(async () => {});
      } finally {
        window.removeEventListener("error", onError);
      }

      // In the app an escape here leaves the click handler and lands in
      // `app/error.tsx` — the whole shell replaced by an error screen because a
      // URL could not be written.
      expect(escaped).toHaveLength(0);
      // `applyMode` ran FIRST and is outside the try, so the switch, the storage
      // write and the announcement all survive. Only the linkable URL is lost.
      expect(current()).toBe("Chat");
      expect(announced()).toBe("Chat");
      expect(readStoredMode()).toBe("chat");
    });

    it("still opens Settings and still lands the keyboard on it", async () => {
      // The surface change, the announcement and the focus move all sit OUTSIDE
      // the try, and the focus bump specifically comes before the push — so a
      // history refusal costs the linkable URL and cannot cost DW-413's landing.
      await renderShell();
      vi.spyOn(window.history, "pushState").mockImplementation(() => {
        throw new DOMException("blocked", "SecurityError");
      });

      const escaped: unknown[] = [];
      const onError = (event: ErrorEvent) => {
        event.preventDefault();
        escaped.push(event.error);
      };
      window.addEventListener("error", onError);
      try {
        fireEvent.click(railItem(SETTINGS_LABEL));
        await act(async () => {});
      } finally {
        window.removeEventListener("error", onError);
      }

      expect(escaped).toHaveLength(0);
      expect(settingsShowing()).toBe(true);
      expect(announced()).toBe(SETTINGS_ANNOUNCEMENT);
      expect(document.activeElement).toBe(landingSite());
      // Only the URL is lost — the flag never made it in.
      expect(window.location.search).toBe("?mode=wiki");
    });
  });
});
