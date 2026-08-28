import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  NAMES_TERMS_READ_ONLY_COPY,
  NamesTermsSettings,
} from "@/components/NamesTermsSettings";

/**
 * Names & Terms on a read-only deployment, MOUNTED (DW-386).
 *
 * `POST /api/names-terms` and `PUT`/`DELETE /api/names-terms/[id]` have refused
 * since DW-294, and `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` since
 * DW-385 — but the surface in front of them carried no `readOnly` term at all.
 * Submit looked live over a 403, and **Remove** opened a `window.confirm`
 * ("Remove “X” from Names & Terms?") onto one, which is the DW-265 shape: a
 * destructive dialog answered onto a refusal.
 *
 * The flag arrives as a PROP — `/settings` already read it from
 * `GET /api/settings` — so these cases hand it down the way the page does.
 * Every assertion is on the outermost surface: what is on screen, whether
 * `window.confirm` was raised, and what requests went out.
 */

const ENTRY = {
  id: "nt-1",
  kind: "person" as const,
  canonical: "Christian Lee",
  aliases: ["Chris"],
  description: "",
  email: "",
  role: "",
  organization: "",
  guidance: "",
};

let fetchMock: ReturnType<typeof vi.fn>;
let confirmMock: ReturnType<typeof vi.fn>;

function stubFetch() {
  fetchMock = vi.fn(async () => {
    return {
      ok: true,
      status: 200,
      // `entries` answers the mount GET; `entry` answers the writable case's
      // POST, and is a DIFFERENT row so the saved list holds two distinct ids.
      json: async () => ({
        entries: [ENTRY],
        entry: { ...ENTRY, id: "nt-2", canonical: "Ada Lovelace" },
      }),
    } as unknown as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
}

/** Requests that were not the mount GET. */
function writeCalls(): unknown[][] {
  return fetchMock.mock.calls.filter((call) => {
    const method = (call[1] as RequestInit | undefined)?.method;
    return method !== undefined && method !== "GET";
  });
}

function submitButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Remember this" }) as HTMLButtonElement;
}

/**
 * The first row's Remove. `getAll` rather than `get`: the writable case saves a
 * second entry before pressing it, and which row is removed is not what any of
 * these cases are about.
 */
function removeButton(): HTMLButtonElement {
  return screen.getAllByRole("button", { name: "Remove" })[0] as HTMLButtonElement;
}

function editorForm(): HTMLFormElement {
  const form = document.getElementById("names-terms-editor");
  if (!form) throw new Error("the editor form is not rendered");
  return form as HTMLFormElement;
}

/** The sentence a control names, read OFF the control rather than guessed. */
function announcedFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const node = document.getElementById(id);
      expect(node, id).not.toBeNull();
      return node!.textContent ?? "";
    })
    .join(" ");
}

beforeEach(() => {
  // Defaults to ACCEPTING, so a missing gate shows up as a DELETE request
  // rather than as a dialog nobody answered.
  confirmMock = vi.fn(() => true);
  vi.stubGlobal("confirm", confirmMock);
  stubFetch();
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one and would unmount with the
  // globals still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

describe("Names & Terms refuses on a read-only deployment", () => {
  it("states the refusal and describes both refused controls with it", async () => {
    render(<NamesTermsSettings readOnly />);

    await screen.findByText(NAMES_TERMS_READ_ONLY_COPY);
    await screen.findByRole("button", { name: "Remove" });

    expect(announcedFor(submitButton())).toContain(NAMES_TERMS_READ_ONLY_COPY);
    expect(announcedFor(removeButton())).toContain(NAMES_TERMS_READ_ONLY_COPY);
  });

  it("keeps the refused controls in the tab order", async () => {
    render(<NamesTermsSettings readOnly />);
    await screen.findByRole("button", { name: "Remove" });

    // `aria-disabled`, never `disabled`: a disabled button carries no
    // description and cannot be reached, so the sentence beside it would never
    // be announced (the DW-191/DW-299 defect).
    for (const control of [submitButton(), removeButton()]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
    }
  });

  it("sends nothing when the form is submitted", async () => {
    render(<NamesTermsSettings readOnly />);
    await screen.findByText(NAMES_TERMS_READ_ONLY_COPY);

    fireEvent.click(submitButton());
    fireEvent.submit(editorForm());

    expect(writeCalls()).toEqual([]);
  });

  it("opens no confirm and sends no DELETE when Remove is pressed", async () => {
    render(<NamesTermsSettings readOnly />);
    await screen.findByRole("button", { name: "Remove" });

    fireEvent.click(removeButton());

    // The refusal lands BEFORE the dialog, which is the whole point: a confirm
    // in front of a 403 asks the owner to approve something they were never
    // offered.
    expect(confirmMock).not.toHaveBeenCalled();
    expect(writeCalls()).toEqual([]);
  });

  it("leaves the stored entries readable and the filter working", async () => {
    // A read-only deployment still lets the owner READ the dictionary — the
    // property the fieldset defect used to destroy.
    render(<NamesTermsSettings readOnly />);
    await screen.findByText("Christian Lee");

    const filter = screen.getByRole("combobox", { name: "Filter Names & Terms" });
    // The filter writes NOTHING — it narrows a list already on screen — so it
    // is not refused.
    expect(filter.hasAttribute("aria-disabled")).toBe(false);
    fireEvent.change(filter, { target: { value: "acronym" } });
    expect(screen.queryByText("Christian Lee")).toBeNull();
  });

  it("names ITS OWN door's sentence and nothing else", async () => {
    // ONE control, ONE door, ONE sentence. `/settings` renders a read-only
    // banner a few nodes above stating what `PUT /api/settings` answers — the
    // provider form's refusal — and these controls stand in front of
    // `/api/names-terms`. Composing the two would announce a route's refusal
    // beside controls that route has nothing to do with, which is the DW-387
    // defect wearing the opposite sign.
    render(<NamesTermsSettings readOnly />);
    const note = await screen.findByText(NAMES_TERMS_READ_ONLY_COPY);

    for (const control of [submitButton(), removeButton()]) {
      const ids = control.getAttribute("aria-describedby")!.split(" ");
      expect(ids).toEqual([note.id]);
    }
  });

  it("refuses the Type select's edit itself, not just its look", async () => {
    // `aria-disabled` dims a <select> but does NOT stop it moving, and this
    // handler is destructive beyond the field: leaving "person" wipes role,
    // organization and email. Marked-but-live is the failure this case exists
    // for — every attribute assertion above would pass without the guard.
    render(<NamesTermsSettings readOnly />);
    await screen.findByText(NAMES_TERMS_READ_ONLY_COPY);

    const kind = screen.getAllByRole("combobox")[0] as HTMLSelectElement;
    expect(kind.getAttribute("aria-disabled")).toBe("true");
    // The person-only fields are on screen because the draft is a person.
    expect(screen.getByPlaceholderText("Product owner")).toBeTruthy();

    fireEvent.change(kind, { target: { value: "acronym" } });

    // Neither the select's own value nor the fields its change would have
    // wiped moved at all.
    expect(kind.value).toBe("person");
    expect(screen.getByPlaceholderText("Product owner")).toBeTruthy();
  });
});

describe("Names & Terms is unchanged on a writable deployment", () => {
  it("says nothing, refuses nothing, and still saves and removes", async () => {
    // The control case. Without it every assertion above would also pass
    // against a section that had simply stopped working.
    render(<NamesTermsSettings />);
    await screen.findByRole("button", { name: "Remove" });

    expect(screen.queryByText(NAMES_TERMS_READ_ONLY_COPY)).toBeNull();
    for (const control of [submitButton(), removeButton()]) {
      expect(control.hasAttribute("aria-disabled")).toBe(false);
      expect(control.getAttribute("aria-describedby")).toBeNull();
    }

    fireEvent.change(
      screen.getByPlaceholderText("Christian Lee"),
      { target: { value: "Ada Lovelace" } },
    );
    fireEvent.submit(editorForm());
    await waitFor(() => expect(writeCalls().length).toBeGreaterThan(0));
    expect(String(writeCalls()[0][0])).toBe("/api/names-terms");

    fireEvent.click(removeButton());
    expect(confirmMock).toHaveBeenCalled();
    await waitFor(() =>
      expect(
        writeCalls().some(
          (call) => (call[1] as RequestInit).method === "DELETE",
        ),
      ).toBe(true),
    );
  });

  it("leaves the text boxes editable", async () => {
    render(<NamesTermsSettings />);
    await screen.findByRole("button", { name: "Remove" });

    const canonical = screen.getByPlaceholderText("Christian Lee") as HTMLInputElement;
    expect(canonical.readOnly).toBe(false);
  });
});
