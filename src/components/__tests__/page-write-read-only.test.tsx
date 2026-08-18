import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  DELETE_PAGE_READ_ONLY_COPY,
  DeletePageButton,
} from "@/components/DeletePageButton";
import { EDIT_PAGE_READ_ONLY_COPY, WikiEditor } from "@/components/WikiEditor";

/**
 * The two page-write affordances OUTSIDE the Workbench shell, mounted
 * (DW-37, DW-149).
 *
 * `PUT`/`PATCH`/`DELETE /api/wiki/[slug]` refuse on a read-only deployment.
 * Before these gates existed both surfaces succeeded, so neither had a reason
 * to ask — and adding the gates without them is precisely the harm DW-149
 * names: the owner accepts "Delete this page? This cannot be undone.", or
 * rewrites an entire page, and meets the 403 only afterwards.
 *
 * Every assertion is made on the outermost surface: what is on screen, whether
 * `window.confirm` was ever raised, and what requests were issued. A component
 * that kept the prop but wired it past the confirm fails here.
 */

const { router } = vi.hoisted(() => ({
  router: { refresh: vi.fn(), push: vi.fn() },
}));
vi.mock("next/navigation", () => ({ useRouter: () => router }));

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  router.refresh.mockClear();
  router.push.mockClear();
  fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response);
  // Defaults to ACCEPTING, so a missing gate shows up as a request rather than
  // as a dialog nobody answered.
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", confirmMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while the globals are still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("Delete page, on a read-only deployment", () => {
  it("refuses before the confirm, and says why", () => {
    render(<DeletePageButton slug="alpha" readOnly />);
    const button = screen.getByRole("button", { name: "Delete this wiki page" });

    // `disabled` would take the control out of the tab order, so the owner
    // could neither reach it nor be told why it will not run.
    expect((button as HTMLButtonElement).disabled).toBe(false);
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);

    fireEvent.click(button);

    // The dialog is the harm: answering it changes nothing, and its wording
    // ("This cannot be undone") is a promise the deployment cannot keep.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(router.push).not.toHaveBeenCalled();

    const note = screen.getByText(DELETE_PAGE_READ_ONLY_COPY);
    expect(note.getAttribute("role")).toBeNull();
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(note);
  });

  it("deletes as before on a writable deployment", async () => {
    render(<DeletePageButton slug="alpha" />);
    const button = screen.getByRole("button", { name: "Delete this wiki page" });
    expect(button.hasAttribute("aria-disabled")).toBe(false);
    expect(screen.queryByText(DELETE_PAGE_READ_ONLY_COPY)).toBeNull();

    fireEvent.click(button);

    expect(confirmMock).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha");
    expect(init.method).toBe("DELETE");
  });

  it("still asks, and still writes nothing, when the owner declines", () => {
    // The pre-existing behaviour, pinned so the new early return cannot be
    // mistaken for the one that already handled a cancelled confirm.
    confirmMock.mockReturnValue(false);
    render(<DeletePageButton slug="alpha" />);

    fireEvent.click(screen.getByRole("button", { name: "Delete this wiki page" }));

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Edit page, on a read-only deployment", () => {
  function mountEditor(props: { readOnly?: boolean } = {}) {
    return render(
      <WikiEditor
        slug="alpha"
        tenant="alice"
        initialContent={"# Alpha\n\noriginal body\n"}
        {...props}
      />,
    );
  }

  function save(): HTMLButtonElement {
    return screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
  }

  it("says so before the owner starts typing, not after they finish", () => {
    mountEditor({ readOnly: true });
    const note = screen.getByText(EDIT_PAGE_READ_ONLY_COPY);
    // ABOVE the fields: the harm is a whole page rewritten before the refusal
    // arrives, so meeting it beside a dimmed Save at the bottom is too late.
    const textarea = screen.getByLabelText(/Markdown/);
    expect(
      note.compareDocumentPosition(textarea) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(note.getAttribute("role")).toBeNull();
  });

  it("keeps Save focusable before a single keystroke", () => {
    // The state an owner who reads the sentence and types nothing stays in.
    // `disabled={busy || !dirty}` would hold here, taking the button out of
    // the tab order and making its `aria-describedby` unreachable — the DW-65
    // defect, on the control whose refusal the sentence explains.
    mountEditor({ readOnly: true });
    const button = save();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(
      screen.getByText(EDIT_PAGE_READ_ONLY_COPY),
    );
  });

  it("still disables Save on an untouched writable page", () => {
    // The transient guard the read-only branch must not have loosened.
    mountEditor();
    expect(save().hasAttribute("disabled")).toBe(true);
  });

  it("keeps Save focusable, marks it aria-disabled, and issues no request", async () => {
    mountEditor({ readOnly: true });
    const textarea = screen.getByLabelText(/Markdown/);
    fireEvent.change(textarea, { target: { value: "# Alpha\n\nrewritten\n" } });

    const button = save();
    expect(button.hasAttribute("disabled")).toBe(false);
    expect(button.getAttribute("aria-disabled")).toBe("true");
    button.focus();
    expect(document.activeElement).toBe(button);
    expect(document.getElementById(button.getAttribute("aria-describedby")!)).toBe(
      screen.getByText(EDIT_PAGE_READ_ONLY_COPY),
    );

    fireEvent.click(button);

    // Neither the PUT nor the PATCH.
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
    expect(router.push).not.toHaveBeenCalled();
  });

  it("refuses a submit that reaches past the button, as Enter in a field does", async () => {
    // `aria-disabled` does not stop a form submitting, which is exactly why the
    // guard lives in the handler rather than only on the control.
    const { container } = mountEditor({ readOnly: true });
    fireEvent.change(screen.getByLabelText(/Markdown/), {
      target: { value: "# Alpha\n\nrewritten\n" },
    });

    fireEvent.submit(container.querySelector("form")!);

    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });

  it("saves as before on a writable deployment", async () => {
    mountEditor();
    expect(screen.queryByText(EDIT_PAGE_READ_ONLY_COPY)).toBeNull();
    expect(save().hasAttribute("aria-disabled")).toBe(false);

    fireEvent.change(screen.getByLabelText(/Markdown/), {
      target: { value: "# Alpha\n\nrewritten\n" },
    });
    fireEvent.click(save());

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/wiki/alpha");
    expect(init.method).toBe("PUT");
  });
});
