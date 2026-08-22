import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useRef, useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import {
  WorkbenchDataProvider,
  type WorkbenchData,
} from "@/components/workbench/WorkbenchData";
import { useDialogA11y } from "@/hooks/useDialogA11y";
import { SurfaceVisibilityProvider } from "@/hooks/useSurfaceVisibility";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The shared modal-dialog behaviour, MOUNTED (DW-105).
 *
 * Every branch of `useDialogA11y` is about something only a live document can
 * answer: which node holds focus, whether a keypress was prevented, what
 * `document.body.style.overflow` says, and whether a second overlay level would
 * have heard the same Esc. A source scan can see that `stopPropagation` is
 * spelled and cannot see that it fires before anything else on `document`.
 *
 * So the hook is driven through its REAL consumers — `ConfirmDialog` for the
 * trap and the carve-out, `WikiWorkbench` for the one case where the opener is
 * gone by the time the dialog closes — plus one bare harness for the single
 * branch no real dialog can reach (a dialog with nothing focusable inside it).
 */

// ONE stable router object: `WikiWorkbench` calls `useRouter()`, and a fresh
// literal per render would rebuild every effect keyed on the router identity.
const { router } = vi.hoisted(() => ({ router: { refresh: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const refresh = router.refresh;

const WIKI: WikiRecord = {
  id: "wiki 1/2",
  name: "Acme",
  scenario: "business",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

/**
 * `WikiWorkbench` takes no props (DW-174) — its wikis arrive through the
 * provider, the same seam `page.tsx` uses.
 */
function workbenchData(
  wikis: readonly WikiRecord[],
  currentWikiId: string | null,
): WorkbenchData {
  return {
    wikis,
    currentWikiId,
    registryUnavailable: false,
    knowledge: [],
    knowledgeUnavailable: false,
    files: [],
    filesUnavailable: false,
    filesTruncated: false,
    dataVersion: 0,
    readOnly: false,
  };
}

/** The subset of `Response` the shared `send` helper reads — `status` included. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  refresh.mockClear();
  fetchMock = vi.fn(async () => answer({ wiki: WIKI }));
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed — and runs the hook's own teardown,
  // which is what restores the scroll lock below.
  cleanup();
  vi.unstubAllGlobals();
  // The lock is the document's, not a component's, so a suite that left one on
  // would leak it into every file that runs after this one.
  document.body.style.overflow = "";
});

/**
 * A `ConfirmDialog` shaped like the real template confirm — a `<select>` for
 * the Esc carve-out, and two extra body buttons so the tab order has an
 * interior rather than just two wrap points that are also the only members.
 *
 * The opener stays mounted (nothing here unmounts it), which is the ordinary
 * close path; the unmounted-opener case is the `WikiWorkbench` test below.
 */
function TemplateHost() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Change template
      </button>
      {/* Reachable only by walking OUT of the dialog, which is the move the
          trap exists to refuse. */}
      <button type="button">Behind the overlay</button>
      <ConfirmDialog
        open={open}
        title="Change Scenario Template"
        confirmLabel="Overwrite"
        cancelLabel="Cancel"
        onConfirm={() => {}}
        onCancel={() => setOpen(false)}
        body={
          <>
            <label htmlFor="a11y-host-scenario">Scenario Template</label>
            <select id="a11y-host-scenario" defaultValue="business">
              <option value="business">Business</option>
              <option value="research">Research</option>
            </select>
            <button type="button">Learn more</button>
            <button type="button">Preview changes</button>
          </>
        }
      />
    </>
  );
}

/**
 * The harness for the branches no real dialog can reach.
 *
 * Two of them: a dialog with nothing focusable inside, and the hook's OWN
 * `busy` refusal. `onDismiss` here closes unconditionally — both real consumers
 * additionally guard inside their `cancel` (`ConfirmDialog.tsx:54`,
 * `CreateWikiDialog.tsx:58`), so against either of them a hook that had lost
 * its `busyRef` check would still look like it worked. Here the refusal can
 * come from nowhere but the hook.
 */
function BareHost({ busy = false }: { busy?: boolean }) {
  const [open, setOpen] = useState(true);
  const { dialogRef } = useDialogA11y({ open, busy, onDismiss: () => setOpen(false) });
  if (!open) return null;
  return (
    <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Bare" tabIndex={-1}>
      <p>Nothing in here can hold focus.</p>
    </div>
  );
}

/**
 * A dialog on a surface that can go OFF SCREEN (DW-414).
 *
 * The shape every withdrawn surface in this shell has: the `hidden` attribute
 * on the surface element, and the same boolean published through
 * {@link SurfaceVisibilityProvider} so the hook knows to stand its document
 * work down. The dialog and its opener stay MOUNTED inside it — that is the
 * whole point of the withdrawal — which is precisely what makes an opener
 * "still connected but unreachable" possible at all.
 *
 * Two openers, because the case this exists for is only observable across two
 * open/close cycles: a capture leaked by the first aims the second's close at
 * the wrong control.
 */
function WithdrawnHost({
  hidden = false,
  open = false,
  withFallback = false,
}: {
  hidden?: boolean;
  open?: boolean;
  /**
   * Give the dialog a `fallbackFocusRef` aimed at a landmark INSIDE the
   * withdrawn surface — the shape every real caller has, since a fallback is by
   * definition a place near the opener.
   */
  withFallback?: boolean;
}) {
  const fallbackRef = useRef<HTMLElement | null>(null);
  return (
    <section hidden={hidden} data-testid="surface">
      <h2 ref={fallbackRef as React.RefObject<HTMLHeadingElement>} tabIndex={-1}>
        Surface heading
      </h2>
      <button type="button">First opener</button>
      <button type="button">Second opener</button>
      <SurfaceVisibilityProvider visible={!hidden}>
        <ConfirmDialog
          open={open}
          title="Withdrawn"
          body="Nothing here is reachable while the surface is off screen."
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          onConfirm={() => {}}
          onCancel={() => {}}
          fallbackFocusRef={withFallback ? fallbackRef : undefined}
        />
      </SurfaceVisibilityProvider>
    </section>
  );
}

/**
 * Open the host dialog from a button that a keyboard user is actually ON.
 *
 * `fireEvent.click` does not focus in jsdom, and the hook restores focus to
 * whatever was active when the dialog opened — so without the explicit
 * `focus()` "restored to the opener" would be satisfied by `<body>`.
 */
function openTemplate() {
  render(<TemplateHost />);
  const opener = screen.getByRole("button", { name: "Change template" });
  opener.focus();
  fireEvent.click(opener);
  const dialog = screen.getByRole("dialog", { name: "Change Scenario Template" });
  return { opener, dialog };
}

/**
 * Press Tab from wherever focus currently is, and report whether the hook
 * PREVENTED the browser's own move.
 *
 * Where focus lands is only half the trap. jsdom moves focus for nobody on a
 * synthetic keydown, so an assertion about `document.activeElement` is
 * satisfied by the handler's explicit `focus()` call alone. A real browser,
 * given an unprevented press, honours that `focus()` and then walks on to the
 * next control in source order — out of the dialog, onto the page behind the
 * backdrop. `fireEvent`'s return value (`false` when a cancelable event was
 * prevented) is the only place that half is observable here.
 */
function pressTab({ shiftKey = false } = {}): { prevented: boolean } {
  const from = (document.activeElement as HTMLElement | null) ?? document.body;
  return { prevented: !fireEvent.keyDown(from, { key: "Tab", shiftKey }) };
}

function focusablesOf(dialog: HTMLElement): HTMLElement[] {
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  );
}

describe("opening and closing", () => {
  it("takes focus to the dialog container so the title is announced first", () => {
    const { dialog } = openTemplate();

    // The container, NOT the first button: landing on Overwrite would announce
    // a destructive action before the sentence explaining it.
    expect(document.activeElement).toBe(dialog);
  });

  it("locks background scroll while open and restores what was there before", () => {
    // Not "" — a page that was already scroll-locked by something else must get
    // ITS value back, and restoring to "" would pass against a default.
    document.body.style.overflow = "scroll";
    openTemplate();

    expect(document.body.style.overflow).toBe("hidden");

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.body.style.overflow).toBe("scroll");
  });

  it("returns focus to the opener when the opener is still mounted", () => {
    const { opener } = openTemplate();
    expect(document.activeElement).not.toBe(opener);

    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

    expect(opener.isConnected).toBe(true);
    expect(document.activeElement).toBe(opener);
  });

  it("lands focus on the fallback when the action unmounted the opener", async () => {
    // Confirming Create Wiki replaces the empty state that owns the opening
    // button, so the opener is detached by close time. Focusing a detached node
    // is a silent no-op that drops the keyboard user on <body> — the whole
    // reason `fallbackFocusRef` exists.
    //
    // The card is no longer optimistic (DW-174): what replaces the empty state
    // is the SERVER render `router.refresh()` asks for, so the spy has to stand
    // in for it. Delivering the new working set from the refresh — rather than
    // after it — is what really happens, and it is what puts the unmount in the
    // same commit as the dialog's close, which is the case this test is about.
    const view = render(
      <WorkbenchDataProvider value={workbenchData([], null)}>
        <WikiWorkbench />
      </WorkbenchDataProvider>,
    );
    refresh.mockImplementationOnce(() => {
      view.rerender(
        <WorkbenchDataProvider value={workbenchData([WIKI], WIKI.id)}>
          <WikiWorkbench />
        </WorkbenchDataProvider>,
      );
    });
    const opener = screen.getByRole("button", { name: "Create Wiki" });
    opener.focus();
    fireEvent.click(opener);

    fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(opener.isConnected).toBe(false);
    const heading = screen.getByRole("heading", { name: "Wiki" });
    // The restore is the dialog effect's CLEANUP — a passive effect, which
    // React runs in a task scheduled AFTER the commit that removed the dialog.
    // This close is driven by a settled fetch rather than by the click, so it
    // happens outside `act` and the two land in separate turns: "the dialog is
    // gone" becomes observable strictly before focus has moved. Reading
    // `activeElement` immediately after the wait above therefore catches
    // `<body>` whenever the scheduler is busy enough to slip a poll between
    // them (a parallel `--project dom` run is enough). Waiting for the focus
    // itself is the SAME assertion made where the behaviour actually finishes:
    // focus that never lands on the heading still fails here.
    await waitFor(() => expect(document.activeElement).toBe(heading));
    expect(refresh).toHaveBeenCalledTimes(1);
  });
});

describe("a surface that goes off screen (DW-414)", () => {
  it("refuses a restore whose target is inside a withdrawn subtree", async () => {
    // The commit where the close and the withdrawal land together. `openRef`
    // already reads `false` by teardown time, so the hook does NOT take its
    // "hidden, not closed" early return — it reaches the restore, with an
    // opener that is still connected and inside `[hidden]`.
    //
    // In a browser focusing that node is a silent no-op that drops the keyboard
    // on `<body>`; jsdom has no layout engine, so the move really happens —
    // which is exactly what makes the refusal observable here at all.
    const view = render(<WithdrawnHost />);
    const opener = screen.getByRole("button", { name: "First opener" });
    opener.focus();
    view.rerender(<WithdrawnHost open />);
    expect(document.activeElement).toBe(screen.getByRole("dialog", { name: "Withdrawn" }));

    view.rerender(<WithdrawnHost hidden />);

    expect(screen.queryByRole("dialog", { name: "Withdrawn" })).toBeNull();
    expect(opener.isConnected).toBe(true);
    // Not pulled into the hidden subtree, and not sent anywhere else either:
    // the owner is standing on whatever surface replaced this one, and a dialog
    // they cannot see closing is not a reason to move them.
    expect(screen.getByTestId("surface").contains(document.activeElement)).toBe(false);
  });

  it("refuses the FALLBACK too when it is inside the withdrawn subtree", async () => {
    // The other arm of the same branch. A fallback is by definition a landmark
    // near the opener, so a withdrawn surface withdraws both — and "the opener
    // is unreachable, use the fallback" would send the keyboard into exactly
    // the content the first check just refused.
    //
    // The opener is detached on purpose, which is what makes the fallback the
    // only candidate left: with the opener still connected the first arm would
    // answer and this branch would never be reached.
    const view = render(<WithdrawnHost withFallback />);
    const opener = screen.getByRole("button", { name: "First opener" });
    opener.focus();
    view.rerender(<WithdrawnHost withFallback open />);
    // Detach the opener the way a landed action does — the `WikiWorkbench` case
    // above, where confirming replaces the empty state that held the button.
    opener.remove();
    expect(opener.isConnected).toBe(false);

    view.rerender(<WithdrawnHost withFallback hidden />);

    expect(screen.queryByRole("dialog", { name: "Withdrawn" })).toBeNull();
    const heading = screen.getByTestId("surface").querySelector("h2");
    expect(heading?.isConnected).toBe(true);
    expect(document.activeElement).not.toBe(heading);
    expect(screen.getByTestId("surface").contains(document.activeElement)).toBe(false);
  });

  it("releases the opener capture when the dialog closes off screen", async () => {
    // The leak the ledger's DW-414 is really about. While the surface is
    // withdrawn `armed` is already false, so a close in that window re-runs no
    // effect at all and the teardown never fires — `openerRecordedRef` stays
    // set, the NEXT open skips recording its own opener, and the close after
    // that aims the keyboard at the previous dialog's control.
    const view = render(<WithdrawnHost />);
    const first = screen.getByRole("button", { name: "First opener" });
    first.focus();
    view.rerender(<WithdrawnHost open />);
    // Hidden while still OPEN: the capture is deliberately kept here, so that
    // coming back on screen and closing normally still returns focus to the
    // control that opened it.
    view.rerender(<WithdrawnHost open hidden />);
    // …and now it closes, out of sight. This is the window the effect never
    // re-runs in.
    view.rerender(<WithdrawnHost hidden />);

    // A second cycle, from a DIFFERENT control, back on screen.
    view.rerender(<WithdrawnHost />);
    const second = screen.getByRole("button", { name: "Second opener" });
    second.focus();
    view.rerender(<WithdrawnHost open />);
    view.rerender(<WithdrawnHost />);

    // Its own opener, not the one the leaked capture was still holding.
    expect(document.activeElement).toBe(second);
    expect(document.activeElement).not.toBe(first);
  });
});

describe("Escape", () => {
  it("dismisses exactly one overlay level", () => {
    // UX-DR17: modals never stack, so a second listener on `document` must not
    // also hear this press. The hook's listener is registered in the CAPTURE
    // phase precisely so it can stop the event before anything bubbling does.
    const bubbled = vi.fn();
    document.addEventListener("keydown", bubbled);
    try {
      const { dialog } = openTemplate();

      const notPrevented = fireEvent.keyDown(dialog, { key: "Escape" });

      expect(notPrevented).toBe(false);
      expect(screen.queryByRole("dialog")).toBeNull();
      expect(bubbled).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener("keydown", bubbled);
    }
  });

  it("declines to dismiss while the caller is busy, and takes Esc once it is not", () => {
    // A dismissal mid-request would leave the write in flight with nothing on
    // screen to report its outcome. The refusal is the hook's, not a consumer's
    // — see `BareHost`.
    const view = render(<BareHost busy />);
    const dialog = screen.getByRole("dialog", { name: "Bare" });

    const notPrevented = fireEvent.keyDown(dialog, { key: "Escape" });

    // Still prevented and still stopped: `busy` suppresses the DISMISSAL, not
    // the swallow — the press must not fall through to a second overlay level
    // just because this one is refusing it.
    expect(notPrevented).toBe(false);
    expect(screen.getByRole("dialog", { name: "Bare" })).toBeTruthy();

    // Same component in the same position, so `open` survives the rerender.
    view.rerender(<BareHost busy={false} />);
    fireEvent.keyDown(screen.getByRole("dialog", { name: "Bare" }), { key: "Escape" });

    expect(screen.queryByRole("dialog", { name: "Bare" })).toBeNull();
  });

  it("leaves the dialog alone when the press came from a native <select>", () => {
    // An open dropdown swallows Esc to close ITSELF. Dismissing the dialog on
    // the same press would close two things at once, and the owner would lose
    // the form because they cancelled a menu.
    openTemplate();
    const select = screen.getByLabelText("Scenario Template");

    const notPrevented = fireEvent.keyDown(select, { key: "Escape" });

    // Not merely "ignored": the event is left UNPREVENTED, which is what lets
    // the browser's own dropdown dismissal proceed. A dismiss that happened to
    // be skipped would still have called preventDefault above it.
    expect(notPrevented).toBe(true);
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();
  });
});

describe("the Tab trap", () => {
  it("wraps forward off the last control to the first", () => {
    const { dialog } = openTemplate();
    const items = focusablesOf(dialog);
    const [first] = items;
    const last = items[items.length - 1];
    expect(last).toBe(screen.getByRole("button", { name: "Overwrite" }));
    last.focus();

    const { prevented } = pressTab();

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(first);
  });

  it("wraps backward off the first control to the last", () => {
    const { dialog } = openTemplate();
    const items = focusablesOf(dialog);
    const [first] = items;
    const last = items[items.length - 1];
    expect(first).toBe(screen.getByLabelText("Scenario Template"));
    first.focus();

    const { prevented } = pressTab({ shiftKey: true });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(last);
  });

  it("wraps backward off the container, where focus starts", () => {
    // The very first Shift+Tab a keyboard user presses arrives with focus on
    // the dialog itself, which is neither inside-and-first nor outside. Without
    // this branch that press would walk straight out of the overlay.
    const { dialog } = openTemplate();
    expect(document.activeElement).toBe(dialog);
    const items = focusablesOf(dialog);

    const { prevented } = pressTab({ shiftKey: true });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("pulls focus back in when it has drifted behind the overlay", () => {
    const { dialog } = openTemplate();
    const items = focusablesOf(dialog);
    const outside = screen.getByRole("button", { name: "Behind the overlay" });
    outside.focus();
    expect(dialog.contains(document.activeElement)).toBe(false);

    const { prevented } = pressTab();

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(items[0]);
  });

  it("pulls focus back to the LAST control when the drifted press is Shift+Tab", () => {
    const { dialog } = openTemplate();
    const items = focusablesOf(dialog);
    screen.getByRole("button", { name: "Behind the overlay" }).focus();

    const { prevented } = pressTab({ shiftKey: true });

    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(items[items.length - 1]);
  });

  it("keeps focus on the container when nothing inside can hold it", () => {
    render(<BareHost />);
    const dialog = screen.getByRole("dialog", { name: "Bare" });
    expect(focusablesOf(dialog)).toHaveLength(0);
    expect(document.activeElement).toBe(dialog);

    const { prevented } = pressTab();

    // Prevented, or Tab escapes to the page the overlay has made unclickable.
    expect(prevented).toBe(true);
    expect(document.activeElement).toBe(dialog);
  });
});
