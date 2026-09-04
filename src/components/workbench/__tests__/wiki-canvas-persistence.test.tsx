import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { Workbench } from "@/components/workbench/Workbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The Wiki canvas SURVIVES a mode switch (DW-26), MOUNTED.
 *
 * `ModeCanvas` used to return the Wiki subtree OR a stub subtree, so leaving
 * Wiki destroyed `WikiWorkbench` — and with it an open Create Wiki dialog, the
 * name the owner had typed into it and the error it was showing. Coming back
 * built an empty card. Nothing a source scan can see: the defect is what React
 * does to a subtree that stops being rendered, so every assertion here is made
 * on the live document across a mode switch a real owner could perform.
 *
 * WHICH SWITCH THAT IS depends on what is on screen (DW-581). With a dialog
 * open the rail is not an opener — see the DW-26 block's own header — so the
 * cases that hold one leave by BACK, and come back on the rail once the dialog
 * is withdrawn and the backdrop is gone.
 *
 * Hiding is not closing, and that distinction is the whole design.
 * `CreateWikiDialog` resets its fields when `open` goes false, so flipping
 * `open` to hide the dialog would discard the very draft this preserves — the
 * subtree stays open and goes behind `hidden` instead.
 *
 * COVERAGE LIMIT: jsdom has no layout engine and applies no user-agent
 * stylesheet, so `hidden` here is an ATTRIBUTE and nothing more — nothing in
 * this file can observe pixels. What it can observe is the contract the
 * attribute carries (the a11y tree, via testing-library's `hidden`-aware
 * queries) and the document state a hidden dialog must not be holding
 * (`document.body.style.overflow`, the Tab trap), which is precisely the half
 * `hidden` does NOT deliver on its own. The `display: none` rule that backs it
 * is pinned in `globals.css` and read there by the assertion at the end.
 */

// ONE stable router object: several components in this shell key effects on the
// router identity, and a fresh literal per call would rebuild them on every
// re-render.
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

/** An id percent-encoding CHANGES, matching the other Wiki suites. */
const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  router.refresh.mockClear();
  window.localStorage.clear();
  // jsdom's session history outlives `cleanup()`, and `selectMode` writes
  // `?mode=` into it — so each test starts on a bare `/` rather than on
  // whatever mode the last one left in the URL, which `initialMode` would
  // otherwise restore.
  window.history.pushState(null, "", "/");
  window.history.replaceState(null, "", "/");
  // `useSidecarStatus` probes the loopback port at mount; the card's create
  // POSTs. One stub answers both, and no assertion here reads it.
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

/** The assembled shell, exactly as `page.tsx` composes it. */
async function renderShell(data: WorkbenchData = DATA) {
  const view = render(
    <WorkbenchDataProvider value={data}>
      <Workbench>
        <WikiWorkbench />
      </Workbench>
    </WorkbenchDataProvider>,
  );
  // Flush the sidecar probe's promise chain before any assertion runs.
  await act(async () => {});
  return view;
}

/** A rail control, by its accessible name. */
function rail(label: string): HTMLButtonElement {
  return screen.getByRole("button", { name: label }) as HTMLButtonElement;
}

/**
 * The Create Wiki dialog's name field, found WITHOUT the a11y tree.
 *
 * `getByLabelText` skips `hidden` subtrees, which is exactly what the visible
 * cases below rely on — so the hidden cases have to reach the node another way
 * or they could not tell "removed from the a11y tree" apart from "unmounted",
 * which is the one distinction this file exists for.
 */
function nameFieldNode(): HTMLInputElement | null {
  const dialog = document.querySelector('[role="dialog"][aria-modal="true"]');
  return dialog?.querySelector("input") ?? null;
}

/**
 * Open Create Wiki from the empty state and type a name into it.
 *
 * The opener is FOCUSED before it is clicked, which is what a pointer or
 * keyboard activation actually does — `fireEvent.click` alone leaves
 * `document.activeElement` on `<body>`, so `useDialogA11y` would record the
 * body as the opener and every focus-restore assertion below would be about
 * nothing.
 */
function openCreateWith(name: string): HTMLButtonElement {
  const opener = screen.getByRole("button", { name: "Create Wiki" }) as HTMLButtonElement;
  opener.focus();
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText("Wiki name"), { target: { value: name } });
  return opener;
}

/** Focus a rail control and click it, the way an owner switching surfaces does. */
function clickRail(label: string): HTMLButtonElement {
  const control = rail(label);
  control.focus();
  fireEvent.click(control);
  return control;
}

/** How long to wait for a traversal jsdom may never perform. */
const POPSTATE_TIMEOUT_MS = 1000;

/**
 * Traverse the session history and let the `popstate` land.
 *
 * The same helper `workbench-mode-url.test.tsx` documents in full (and
 * `settings-canvas-persistence.test.tsx` keeps its own copy of): jsdom queues
 * traversal on its own event loop and fires `popstate` some tasks later, so a
 * `setTimeout(0)` would let the assertion run against the pre-traversal tree and
 * pass for the wrong reason on a shell that ignores `popstate` entirely. The
 * timeout is a deadline, not a fallback — without it a shell that never
 * traverses would hang the run instead of failing it.
 *
 * COPIED, not imported — the third copy in this repo, after
 * `workbench-mode-url.test.tsx`'s original and the one
 * `settings-canvas-persistence.test.tsx` took from it. Per-suite duplication
 * with a docblock pointing at the fullest copy is this repo's convention for
 * test scaffolding: a shared helper module would put the one thing each suite
 * most needs to read out of the file that reads it.
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

/** The mode named by the entry the browser is currently standing on. */
function urlMode(): string | null {
  return new URLSearchParams(window.location.search).get("mode");
}

/**
 * Leave ONE Chat entry in the session history, behind the current one — the
 * entry {@link showChat} traverses back onto.
 *
 * Two rail presses. `selectMode` is `applyMode` + `pushSurface`, and
 * `pushSurface` writes an entry whenever the href moves, so pressing Chat
 * pushes `?mode=chat` and pressing Wiki pushes `?mode=wiki` again: the RENDER
 * ends exactly where it started — Wiki on screen, nothing withdrawn — with a
 * Chat entry one step back.
 *
 * IT MUST RUN BEFORE ANY DIALOG IS OPENED, and that ordering is the whole
 * reason this exists (DW-581). The rail is reachable only while no backdrop is
 * on screen: once `CreateWikiDialog` mounts, its `fixed inset-0 z-[120]
 * … bg-black/40` root covers the whole viewport — the rail declares no
 * `z-index` of its own — and `useDialogA11y` traps Tab inside the dialog, so
 * neither a pointer nor a keyboard could reach these two presses. Seeding first
 * is the one ordering in which every press this file makes is a press a real
 * owner could make.
 *
 * The keyboard is left on the rail's Wiki control rather than on `<body>`,
 * which is harmless here because `openCreateWith` focuses its own opener before
 * clicking it — so `useDialogA11y` still records the opener a real activation
 * would.
 */
async function seedChatEntry() {
  // The ordering, CHECKED rather than documented. jsdom does no hit-testing, so
  // a future call placed after `openCreateWith(...)` would click straight
  // through a live overlay and report green — which is the exact defect this is
  // filed against. A comment cannot stop that; this can.
  expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

  const before = window.location.search;
  const depth = window.history.length;

  clickRail("Chat");
  await act(async () => {});
  // THE ENTRY, not just the surface. `pushSurface` swallows `SecurityError` and
  // writes nothing when the href is unchanged, and jsdom's session history
  // outlives `cleanup()` — `beforeEach` pushes one `/` entry and rewrites it,
  // which puts a known entry on TOP of the previous test's stack rather than
  // clearing it. So a silently unseeded run would send `showChat` back past
  // that `/` and onto a PREVIOUS TEST's `?mode=` entry, where it could land on
  // Chat and report green having proved nothing.
  expect(urlMode()).toBe("chat");

  clickRail("Wiki");
  await act(async () => {});
  expect(urlMode()).toBe("wiki");
  expect(window.location.search).toBe(before);
  // …and both presses really PUSHED. Two distinct hrefs could still be one
  // entry if either write were replaced or dropped, and the depth is the only
  // thing that can tell that apart from a seeded stack.
  expect(window.history.length).toBe(depth + 2);
}

/**
 * Press the rail to come back to Wiki — the hop that IS reachable (DW-581).
 *
 * The outbound direction is guarded by {@link seedChatEntry}'s dialog-null
 * assertion, and this is the same guard pointed the other way, for the same
 * reason: jsdom does no hit-testing, so "no backdrop is over the rail by now"
 * is a claim a comment cannot keep. Two facts make the press reachable, and
 * both are checked immediately before it is made — the mode canvas is
 * WITHDRAWN, and every modal still mounted is inside that withdrawal rather
 * than painting a `fixed inset-0` layer over the viewport. A dialog left
 * reachable by role here would be a dialog whose overlay is still on screen.
 *
 * The dialog is deliberately still IN THE DOCUMENT — that is the whole of
 * DW-26 — so the check is "withdrawn", not "gone".
 */
function returnToWikiOnRail(): HTMLButtonElement {
  const wrapper = document.querySelector(".wb-canvas-mode");
  expect(wrapper?.hasAttribute("hidden")).toBe(true);
  // Out of the accessibility tree, which is how a `hidden` ancestor reads to
  // testing-library's role queries — and to a screen reader and a Tab press.
  expect(screen.queryByRole("dialog")).toBeNull();
  const modal = document.querySelector('[role="dialog"][aria-modal="true"]');
  // Still mounted (holding its draft), and inside the withdrawn subtree.
  expect(modal).not.toBeNull();
  expect(modal?.closest("[hidden]")).not.toBeNull();
  return clickRail("Wiki");
}

/**
 * Reach Chat by BACK — the opener that stays available with a modal dialog open
 * (DW-581, the pointer rule DW-511 established one suite over).
 *
 * Back is browser chrome, and a modal covers and traps only the page: the
 * backdrop that hides the rail from the pointer and the Tab trap that holds the
 * keyboard both stop at the document. The traversal lands on the entry
 * {@link seedChatEntry} left behind, and `Workbench`'s `popstate` listener
 * re-applies the mode.
 *
 * IT MOVES NO FOCUS, by design: the listener bumps `canvasFocusNonce` only when
 * the SETTINGS flag moves, so a mode-only traversal leaves the keyboard exactly
 * where the owner had it — which is what makes "hiding must not move focus"
 * observable across it.
 */
async function showChat() {
  await traverse(() => window.history.back());
  // The ENTRY it landed on names Chat — not merely "Chat is showing", which a
  // stale entry left by an earlier test would also produce. This is the far
  // half of the seed's own history assertions.
  expect(urlMode()).toBe("chat");
  expect(screen.getByRole("heading", { name: "Chat" })).toBeTruthy();
}

/**
 * WITH A DIALOG OPEN, BACK IS THE OPENER — not the rail (DW-581).
 *
 * The four cases below hold a live Create Wiki dialog while they leave Wiki,
 * and they used to leave it by clicking the rail. No owner can make that press.
 * The dialog renders itself inside a `fixed inset-0 z-[120] … bg-black/40`
 * root that covers the whole viewport, and the rail declares no `z-index` of
 * its own, so a pointer aimed at a rail control lands on the backdrop — whose
 * `onMouseDown` cancels the dialog, discarding the very draft these cases exist
 * to preserve. The keyboard has no route either: `aria-modal="true"` declares
 * the rest of the page inert, and `useDialogA11y`'s capture-phase Tab trap
 * pulls focus back inside on every press. jsdom does no hit-testing, so the old
 * rows reported green while describing a path that does not exist — the same
 * defect DW-511 removed from `settings-canvas-persistence.test.tsx`.
 *
 * Back is browser chrome. A modal covers and traps the PAGE; it neither paints
 * over the browser's own controls nor holds the keyboard out of them. So each
 * case seeds a Chat entry with two rail presses BEFORE any dialog is open —
 * {@link seedChatEntry}, which asserts that ordering rather than trusting it —
 * and then leaves by {@link showChat}.
 *
 * THE RAIL IS STILL THE RETURN CONTROL, and that press is reachable. By then
 * the mode is Chat, `.wb-canvas-mode` is `hidden`, the dialog is inside that
 * withdrawn subtree, `useDialogA11y` has stood down and no overlay is painted
 * anywhere — so `clickRail("Wiki")` is exactly what a real owner does. It is
 * also the only press that carries the re-arm assertions: a traversal moves no
 * focus, so coming back by Back would leave nothing for the re-showing dialog
 * to take back.
 *
 * The refusal itself is pinned executably by the last case in this block.
 */
describe("an open Create Wiki dialog survives a mode switch (DW-26)", () => {
  it("keeps the typed name and the shown error across Chat and back", async () => {
    // The error has to be REAL — set by a refused create rather than typed into
    // a prop — because it lives in `WikiWorkbench`'s state and the name lives in
    // `CreateWikiDialog`'s. A fixture that only checked the name would pass
    // against a card that was rebuilt from scratch with the dialog reopened.
    // Routed by URL, not queued with `mockResolvedValueOnce`: `useSidecarStatus`
    // probes the loopback port at mount, so a one-shot answer is spent on the
    // probe and the create sees the default `{}` — which fails for a different
    // reason and would let this pass against the wrong sentence.
    fetchMock.mockImplementation(async (url: unknown) =>
      String(url) === "/api/wikis"
        ? ({
            ok: false,
            status: 409,
            json: async () => ({ error: "A wiki with that name already exists." }),
          } as unknown as Response)
        : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
    );
    await renderShell();
    // Seeded BEFORE the dialog opens: with a backdrop on screen the rail is not
    // an opener, so the Chat entry has to exist by then (DW-581).
    await seedChatEntry();
    openCreateWith("Quarterly review");
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe(
      "A wiki with that name already exists.",
    );

    // OUT by Back — the one route a modal leaves open — and BACK IN on the
    // rail, whose reachability `returnToWikiOnRail` checks rather than asserts
    // in prose.
    await showChat();
    returnToWikiOnRail();
    await act(async () => {});

    // Same dialog, same draft, same failure — not a fresh one seeded with the
    // template's default name.
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).value).toBe(
      "Quarterly review",
    );
    expect(screen.getByRole("alert").textContent).toBe(
      "A wiki with that name already exists.",
    );
  });

  it("is HIDDEN rather than unmounted while another mode is showing", async () => {
    await renderShell();
    await seedChatEntry();
    openCreateWith("Quarterly review");

    await showChat();

    // Out of the accessibility tree: testing-library's default queries respect
    // `hidden`, so a dialog behind it is unreachable by role and by label — the
    // same thing a screen reader and a Tab press see.
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    // By ROLE, not by label: `queryByLabelText` walks the DOM and knows nothing
    // about the accessibility tree, so it finds a hidden field and would report
    // this as a failure whichever way the fix went. The role queries are the
    // ones that resolve `hidden` up the ancestor chain.
    expect(screen.queryByRole("textbox", { name: "Wiki name" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Create" })).toBeNull();
    // …but still in the DOCUMENT, holding the draft. This is what tells hiding
    // apart from the unmount that was the defect: an unmounted dialog has no
    // node to find at all.
    expect(nameFieldNode()?.value).toBe("Quarterly review");
    // And the attribute that does it, on the wrapper the stylesheet's rule
    // names — not on the dialog, which must stay `open`.
    const wrapper = document.querySelector(".wb-canvas-mode");
    expect(wrapper?.hasAttribute("hidden")).toBe(true);
    expect(wrapper?.contains(nameFieldNode())).toBe(true);
  });

  it("holds neither the body scroll lock nor the Tab trap while hidden", async () => {
    await renderShell();
    await seedChatEntry();
    openCreateWith("Quarterly review");
    // The lock is real while the dialog is on screen — a positive control, so
    // the negative below cannot pass because the lock was never taken.
    expect(document.body.style.overflow).toBe("hidden");

    await showChat();

    // `hidden` removes the pixels and the a11y tree entry, and NOTHING that the
    // dialog did to the document: the scroll lock and the capture-phase Tab
    // listener both outlive it unless the hook stands down.
    expect(document.body.style.overflow).toBe("");

    // Tab is not trapped. The trap is a capture-phase listener that calls
    // `preventDefault` and pulls focus back into the dialog; with it armed over
    // a hidden surface, the keyboard user is stuck on a canvas they cannot see.
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

    // …and coming back re-arms both. The RAIL, because by here it is reachable —
    // and `returnToWikiOnRail` checks that rather than assuming it.
    returnToWikiOnRail();
    await act(async () => {});
    expect(document.body.style.overflow).toBe("hidden");
  });

  it("keeps the opener across the hide, so closing lands where the owner left it", async () => {
    // The focus round trip, end to end. The hook re-arms when the surface comes
    // back, and its arming branch reads `document.activeElement` — which at that
    // moment is the rail control the owner just clicked, not the button that
    // opened the dialog. Recapturing there is silent: the dialog looks right,
    // the draft is intact, and closing it drops the keyboard on the rail.
    await renderShell();
    await seedChatEntry();
    const opener = openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
    // Opening focuses the dialog container, so the title is announced before
    // the button cluster.
    expect(document.activeElement).toBe(dialog);

    // HIDING must not move focus, and across a traversal that is an IDENTITY:
    // `popstate` bumps `canvasFocusNonce` only when the SETTINGS flag moves, so
    // a mode-only Back moves nothing and the keyboard stays exactly where the
    // owner left it. The teardown that runs as the surface goes off screen is
    // where that could break — it must recognise a HIDE (the dialog is still
    // open) and return before restoring, because the recorded opener is inside
    // the subtree that just went away.
    const before = document.activeElement;
    await showChat();
    expect(document.activeElement).toBe(before);
    // …and specifically NOT dragged back to the opener, which is now sitting in
    // hidden content. That is the failure this case exists to catch, and it is
    // stated separately because "unchanged" alone would also hold if focus had
    // never been on anything else.
    expect(document.activeElement).not.toBe(opener);
    // FIDELITY LIMIT, and it is about jsdom rather than about the shell. What
    // `before` holds here is the dialog container, which the traversal has just
    // put inside the `[hidden]` subtree — and jsdom applies no stylesheet, so
    // the `.wb-canvas-mode[hidden] { display: none !important }` rule this same
    // file reads from `globals.css` further down never runs and the node stays
    // focusable. A real browser would drop the keyboard to `<body>` at that
    // moment. The assertion above is therefore a statement about what the SHELL
    // does across the hide — NOTHING: no restore, no nonce bump, no `.focus()`
    // anywhere — and not a claim that a browser strands the owner on a node
    // they cannot see. Where focus ends up is the browser's to decide; that the
    // shell does not decide it is what is pinned.

    // RE-SHOWING focuses the dialog again, exactly as opening it did — and this
    // hop stays on the RAIL, which is reachable now that the canvas is
    // withdrawn and nothing is painted over it. That matters for what is being
    // asserted: `clickRail` puts the keyboard on the rail control before the
    // click, so the focus below is something the re-arming hook has to TAKE
    // BACK, not something it inherited. Coming back by Back instead would move
    // no focus at all and leave this assertion true of the traversal rather than
    // of the hook. (The taking-back happens inside `fireEvent.click`'s own `act`
    // flush, so the rail never holds focus across a statement boundary here —
    // `document.activeElement` is only ever read once the effects have run.)
    returnToWikiOnRail();
    await act(async () => {});
    expect(document.activeElement).toBe(
      screen.getByRole("dialog", { name: "Create Wiki" }),
    );

    // …and CLOSING returns focus to the control that opened the dialog — still
    // mounted, because this card is not optimistic — rather than to the rail
    // button that merely hid it.
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    expect(document.activeElement).toBe(opener);
  });

  it("leaves the keyboard on a pressed mode rail control, with no dialog open", async () => {
    // THE POSITIVE CONTROL for the traversal above (DW-581) — and the assertion
    // the re-route would otherwise have deleted from this repo outright.
    //
    // The four cases above used to leave Wiki on the rail and assert the
    // keyboard stayed on the pressed control. That press is unreachable with a
    // backdrop on screen, so it is gone from them; the CONTRACT it carried is
    // not about dialogs at all. A click MOVES the keyboard and leaves it on
    // what was clicked; Back moves nothing, because `popstate` bumps
    // `canvasFocusNonce` only when the SETTINGS flag moves. Both halves have to
    // hold for the replacement to be sound, and only the second one is stated
    // elsewhere: `workbench-mode-url.test.tsx` pins the keyboard on a pressed
    // rail control for the Settings-CLOSE direction only, and its mode-only
    // traversal case asserts the no-move policy on purpose.
    //
    // NO DIALOG IS OPEN, which is exactly what makes this press one an owner
    // can make — and the reason this case can hold the assertion the dialog
    // cases no longer can.
    await renderShell();
    expect(document.querySelector('[role="dialog"][aria-modal="true"]')).toBeNull();

    const chat = clickRail("Chat");
    await act(async () => {});

    expect(urlMode()).toBe("chat");
    expect(document.activeElement).toBe(chat);
  });

  it("covers the rail with the dialog's own backdrop, which eats the pointer", async () => {
    // WHY THE FOUR CASES ABOVE LEAVE BY BACK (DW-581), stated executably.
    //
    // Prose did not stop this file from clicking a rail control through a live
    // overlay for as long as it did, and it will not stop the next author
    // either. So the two facts the refusal is composed of are asserted here:
    // the dialog's root is a full-viewport layer at a stated level, and the rail
    // is not inside it. Read from the component's own class list rather than
    // restated, so a re-levelling cannot pass by agreeing with a copy.
    //
    // COVERAGE LIMIT, and it is this file's own: jsdom has no layout engine and
    // no hit-testing, so nothing here can watch a click land on the backdrop
    // instead of on the rail. The other half of the composition — that every
    // rule in `globals.css` naming the rail family sits BELOW this level, with
    // `.wb-shell` opening no stacking context that could lift them — is scanned
    // in full by `settings-canvas-persistence.test.tsx`'s
    // "the rail is not an opener while a dialog backdrop is on screen (DW-511)"
    // block. It is cross-referenced rather than duplicated: one stylesheet, one
    // scan, and a second copy would be a second thing to keep in step.
    await renderShell();
    openCreateWith("Quarterly review");
    const dialog = screen.getByRole("dialog", { name: "Create Wiki" });

    // The dialog node's PARENT is the backdrop — the component centres the panel
    // inside it.
    const overlay = dialog.parentElement as HTMLElement;
    expect(overlay.classList.contains("fixed")).toBe(true);
    expect(overlay.classList.contains("inset-0")).toBe(true);
    const level = Number(/(?:^|\s)z-\[(\d+)\]/.exec(overlay.className)?.[1]);
    // A level that will not parse is a FAILURE here, not a skipped comparison:
    // an overlay with no stated level is an overlay whose covering is a
    // guess.
    expect(Number.isFinite(level)).toBe(true);
    expect(level).toBeGreaterThan(0);

    // The rail is on screen and NOT inside the overlay: the backdrop leaves no
    // hole for the control the old rows were clicking.
    const chatRail = rail("Chat");
    expect(chatRail.isConnected).toBe(true);
    expect(overlay.contains(chatRail)).toBe(false);
    expect(overlay.querySelector(".wb-rail")).toBeNull();

    // The one piece of BEHAVIOUR jsdom can give: the overlay's own `onMouseDown`
    // fires only when the press targets the overlay ITSELF, and it cancels the
    // dialog. A press that had reached the rail underneath would have switched
    // the mode and left this dialog open — instead the draft is gone and Wiki is
    // still the surface on screen, which is what a real pointer aimed at the
    // rail would actually have cost the owner.
    fireEvent.mouseDown(overlay);
    await act(async () => {});
    expect(screen.queryByRole("dialog", { name: "Create Wiki" })).toBeNull();
    expect(urlMode()).toBe("wiki");
    expect(screen.getByRole("heading", { name: "Wiki" })).toBeTruthy();
  });

  it("never puts a second #wb-canvas on the page, in any mode", async () => {
    // `CANVAS_ID` is the skip link's target (`SiteChrome` renders
    // `<a href="#wb-canvas">`), and rendering the Wiki subtree in every mode is
    // exactly the change that could have grown a second section to hold it —
    // which would give the link two targets and leave the browser to pick.
    const { container } = await renderShell();

    for (const mode of ["Wiki", "Chat", "Graph", "Wiki"]) {
      fireEvent.click(rail(mode));
      await act(async () => {});
      expect(container.querySelectorAll("#wb-canvas")).toHaveLength(1);
      expect(container.querySelectorAll(".wb-canvas")).toHaveLength(1);
    }
  });

  it("shows exactly one surface heading at a time", async () => {
    // The stub subtree stays UNMOUNTED under Wiki: it holds no state to lose,
    // and rendering it would put a second "Wiki" heading in the document beside
    // the card's own — the reason only one of the two branches is conditional.
    await renderShell({ ...DATA, wikis: [WIKI], currentWikiId: WIKI.id });

    expect(screen.getAllByRole("heading", { name: "Wiki" })).toHaveLength(1);

    fireEvent.click(rail("Chat"));
    await act(async () => {});
    // The Wiki heading went off screen with its subtree; Chat's is the only one
    // a reader can reach.
    expect(screen.queryByRole("heading", { name: "Wiki" })).toBeNull();
    expect(screen.getAllByRole("heading", { name: "Chat" })).toHaveLength(1);
  });

  it("backs the attribute with a stylesheet rule the layout cannot defeat", async () => {
    // jsdom loads no stylesheet and applies no user-agent sheet, so nothing
    // ABOVE can see a pixel — `hidden` is an attribute here and the a11y-tree
    // half is all the mounted assertions reach. The `display: none` that makes
    // it a visual withdrawal is a UA default that ANY author rule setting
    // `display` on the same element beats, and this wrapper sits deep inside a
    // grid where such a rule is one restyle away. So the rule is stated in
    // `globals.css`, with the attribute in its selector, and read here from the
    // real file rather than restated.
    //
    // `!important` is required, not incidental (DW-415): the floor, not the
    // selector's specificity, is what holds the withdrawal against every normal
    // author declaration — argued in full at the rule itself. Asserted here so
    // a later restyle cannot quietly drop it; that it WINS the cascade, rather
    // than merely appearing in the file, is `hidden-withdrawal-cascade.test.tsx`.
    const css = await readFile(
      path.resolve(__dirname, "../../../app/globals.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.wb-canvas-mode\[hidden\] \{\s*display: none !important;\s*\}/,
    );
    // Outside every media query: the subtree is withdrawn at all three widths.
    // A rule wrapped in `@media (min-width: …)` would put the hidden canvas —
    // dialog, draft and all — back on screen wherever the wrapper missed.
    const before = css
      .slice(0, css.indexOf(".wb-canvas-mode[hidden] {"))
      .replace(/\/\*[\s\S]*?\*\//g, "");
    const depth =
      (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
    expect(depth).toBe(0);
  });

  it("labels the canvas with whichever heading is actually on screen", async () => {
    // `aria-labelledby` pointing at a hidden node names the section after
    // something no reader can reach. It has to move with the branch.
    const { container } = await renderShell();
    const canvas = () => container.querySelector("#wb-canvas") as HTMLElement;

    expect(canvas().getAttribute("aria-labelledby")).toBe("wiki-workbench-heading");

    fireEvent.click(rail("Chat"));
    await act(async () => {});
    const labelledBy = canvas().getAttribute("aria-labelledby");
    expect(labelledBy).not.toBe("wiki-workbench-heading");
    expect(document.getElementById(labelledBy ?? "")?.textContent).toBe("Chat");
  });
});
