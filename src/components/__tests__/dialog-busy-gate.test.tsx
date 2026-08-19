import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WikiWorkbench } from "@/components/WikiWorkbench";
import { CREATABLE_SCENARIOS } from "@/lib/wiki-scenarios";
import type { WikiRecord } from "@/lib/wikis";

/**
 * The in-flight gate on both dialogs, MOUNTED (DW-107).
 *
 * Nothing in the suite clicked a destructive confirm TWICE, so deleting
 * `disabled={busy}` from `ConfirmDialog` would double-apply a template
 * overwrite — two POSTs that each rewrite purpose.md, Schema and the Workspace
 * Purpose — with every other test still green. The only way to observe that is
 * to hold the first request open and press again, which is what the deferred
 * `fetch` below is for.
 *
 * The dialogs are driven from the real `WikiWorkbench` rather than mounted
 * bare: `busy` is that component's state, and a test that passed the prop in
 * itself would pin the dialog's rendering of a flag rather than the gate.
 */

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

/** The subset of `Response` `WikiWorkbench.send` reads — `status` included. */
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
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** `toBeDisabled` is a jest-dom matcher and this repo installs no jest-dom. */
function button(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

/** The overlay that owns the backdrop dismissal — the dialog's own parent. */
function backdropOf(dialog: HTMLElement): HTMLElement {
  return dialog.parentElement as HTMLElement;
}

/**
 * Arm a `fetch` whose promise this test resolves BY HAND, so a second press
 * lands while the first request is still in flight. `mockImplementationOnce`,
 * so a later call in the same test falls back to the settling default and a
 * missing gate shows up as a second call rather than as a hang.
 */
function deferNextRequest(): { release: (value: Response) => void } {
  let release!: (value: Response) => void;
  fetchMock.mockImplementationOnce(
    () =>
      new Promise<Response>((resolve) => {
        release = resolve;
      }),
  );
  return { release: (value) => release(value) };
}

/** Open the template confirm, pick a different template, and start the POST. */
function startOverwrite() {
  const { release } = deferNextRequest();
  render(<WikiWorkbench initialWikis={[WIKI]} initialCurrentId={WIKI.id} />);
  fireEvent.click(button("Change template"));
  fireEvent.change(screen.getByLabelText("Scenario Template"), {
    target: { value: "research" },
  });
  fireEvent.click(button("Overwrite"));
  // The confirm's accessible NAME changes while busy, so re-querying
  // "Overwrite" would throw instead of asserting.
  const confirm = button("Working…");
  const dialog = screen.getByRole("dialog", { name: "Change Scenario Template" });
  return { confirm, dialog, release };
}

/** Open Create Wiki from the empty state and start the POST. */
function startCreate() {
  const { release } = deferNextRequest();
  render(<WikiWorkbench initialWikis={[]} initialCurrentId={null} />);
  fireEvent.click(button("Create Wiki"));
  const dialog = screen.getByRole("dialog", { name: "Create Wiki" });
  const form = dialog.querySelector("form") as HTMLFormElement;
  fireEvent.click(button("Create"));
  const submit = button("Creating…");
  return { submit, dialog, form, release };
}

describe("the Overwrite confirm", () => {
  it("issues exactly ONE template POST when it is pressed twice", async () => {
    const { confirm, release } = startOverwrite();

    // The second press, on the very control the owner sees. Without
    // `disabled={busy}` this reaches `applyTemplate` again and the wiki's
    // purpose.md, Schema and Workspace Purpose are rewritten a second time.
    fireEvent.click(confirm);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(confirm.disabled).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/wikis/wiki%201%2F2/template");

    await act(async () => {
      release(answer({ wiki: WIKI }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("refuses Cancel, Esc and the backdrop until the write settles", async () => {
    const { dialog, release } = startOverwrite();

    // Cancel first: it is `disabled={busy}`, so the press is a no-op the owner
    // can see coming rather than a half-applied overwrite they cannot.
    expect(button("Cancel").disabled).toBe(true);
    fireEvent.click(button("Cancel"));
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();

    // Esc reaches no button at all, so this is a second, independent refusal:
    // `ConfirmDialog.cancel` returns early while busy, and `useDialogA11y`
    // declines to call `onDismiss` for the same reason. Only the second of
    // those is observable from here — the hook's own branch is pinned by
    // `useDialogA11y.test.tsx`'s bare harness, which dismisses unconditionally.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();

    // The backdrop dismiss is `onMouseDown` on the overlay — a `click` would
    // never reach it, so this is the event that has to be refused.
    fireEvent.mouseDown(backdropOf(dialog));
    expect(screen.getByRole("dialog", { name: "Change Scenario Template" })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(answer({ wiki: WIKI }));
    });

    // A SUCCESS unmounts the overlay, so this says nothing about the gate
    // lifting — that claim needs a failure, and is the test below.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unlocks the dialog when the write FAILS, rather than stranding it", async () => {
    // The overlay stays open on failure, so every control the gate locked has
    // to come back. Without `applyTemplate`'s `finally { setBusy(false) }` the
    // owner is left looking at the message with a dead Cancel, a refused Esc, a
    // refused backdrop and no way out of the dialog but a page reload.
    const { dialog, release } = startOverwrite();

    await act(async () => {
      release(answer({ error: "Template write failed." }, { ok: false, status: 409 }));
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("Template write failed.");
    expect(dialog.contains(alert)).toBe(true);
    // The confirm is readable and pressable again, under its own name.
    expect(screen.queryByRole("button", { name: "Working…" })).toBeNull();
    const confirm = button("Overwrite");
    expect(confirm.disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);

    // A retry really reaches the route a second time rather than being
    // swallowed by a `busy` that never cleared. Answered with another failure
    // so the dialog is still there for the dismissal below.
    fetchMock.mockResolvedValueOnce(
      answer({ error: "Template write failed." }, { ok: false, status: 409 }),
    );
    fireEvent.click(confirm);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button("Overwrite").disabled).toBe(false));

    // …and Esc, refused a moment ago, dismisses the overlay again.
    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("the Create submit", () => {
  it("issues exactly ONE create POST when it is submitted twice", async () => {
    const { submit, form, release } = startCreate();

    // Both ways in: the button the owner presses, and the form submission a
    // keyboard user reaches with Enter — which is why `submit()` carries its
    // own `if (busy) return` beside the button's `disabled`.
    fireEvent.click(submit);
    fireEvent.submit(form);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(submit.disabled).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/wikis");

    await act(async () => {
      release(answer({ wiki: WIKI }));
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("dialog")).toBeNull();
    // One wiki seeded, not two.
    expect(screen.getByText(WIKI.name)).toBeTruthy();
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it("locks the name, the scenario cards, Cancel and Esc while it is in flight", async () => {
    const { dialog, release } = startCreate();

    // Editing either one mid-flight would leave the dialog describing an input
    // the request in front of it was never given.
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).disabled).toBe(true);
    const cards = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    );
    expect(cards).toHaveLength(CREATABLE_SCENARIOS.length);
    expect(cards.every((card) => card.disabled)).toBe(true);

    expect(button("Cancel").disabled).toBe(true);
    fireEvent.click(button("Cancel"));
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();

    fireEvent.mouseDown(backdropOf(dialog));
    expect(screen.getByRole("dialog", { name: "Create Wiki" })).toBeTruthy();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release(answer({ wiki: WIKI }));
    });

    // A SUCCESS unmounts the overlay; the gate LIFTING is the test below.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("unlocks the dialog when the create FAILS, rather than stranding it", async () => {
    // Without `create()`'s `finally { setBusy(false) }` the owner is left on a
    // dialog that has told them what went wrong and refuses every way out of
    // it — including the name field they would have to edit to fix it.
    const { dialog, form, release } = startCreate();

    await act(async () => {
      release(
        answer(
          { error: "A wiki with that name already exists." },
          { ok: false, status: 409 },
        ),
      );
    });

    const alert = screen.getByRole("alert");
    expect(alert.textContent).toBe("A wiki with that name already exists.");
    expect(dialog.contains(alert)).toBe(true);
    expect(screen.queryByRole("button", { name: "Creating…" })).toBeNull();
    expect(button("Create").disabled).toBe(false);
    expect(button("Cancel").disabled).toBe(false);
    expect((screen.getByLabelText("Wiki name") as HTMLInputElement).disabled).toBe(false);
    const cards = Array.from(
      dialog.querySelectorAll<HTMLButtonElement>("button[aria-pressed]"),
    );
    expect(cards).toHaveLength(CREATABLE_SCENARIOS.length);
    expect(cards.some((card) => card.disabled)).toBe(false);

    // The keyboard path back in — the one `submit`'s own `if (busy) return`
    // was refusing a moment ago. Answered with another failure so the dialog is
    // still there for the dismissal below.
    fetchMock.mockResolvedValueOnce(
      answer(
        { error: "A wiki with that name already exists." },
        { ok: false, status: 409 },
      ),
    );
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(button("Create").disabled).toBe(false));

    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByText("No wiki yet.")).toBeTruthy();
  });
});
