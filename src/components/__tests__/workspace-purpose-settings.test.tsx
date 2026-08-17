import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkspacePurposeSettings } from "@/components/WorkspacePurposeSettings";
import { emptyWorkspaceProfile, type WorkspaceProfile } from "@/lib/workspace-profile";

/**
 * The Workspace Purpose form, MOUNTED.
 *
 * The Purpose is stored PER WIKI now, so this form is always editing one wiki's
 * profile — and everything that follows from that (naming the wiki, refusing to
 * collect edits when there is none, telling "no wiki" apart from "the load
 * failed") is state the source scan in `create-wiki-ui.test.ts` cannot see. Each
 * assertion here is made on the rendered surface and on what was requested.
 */

const WIKI = { id: "00000000-0000-4000-8000-000000000001", name: "Acme Ops" };

const PROFILE: WorkspaceProfile = {
  ...emptyWorkspaceProfile(),
  scenario: "business",
  purpose: "Track decisions.",
};

/** The subset of `Response` the component's `request` helper reads. */
function answer(body: unknown, { ok = true, status = 200 } = {}) {
  return { ok, status, json: async () => body } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

function stubGet(body: unknown, options?: { ok?: boolean; status?: number }) {
  fetchMock = vi.fn(async () => answer(body, options));
  vi.stubGlobal("fetch", fetchMock);
}

beforeEach(() => {
  stubGet({ profile: PROFILE, readOnly: false, wiki: WIKI });
});

afterEach(() => {
  // FIRST, for the reason `create-wiki-flow.test.tsx` documents: the setup
  // file's `cleanup()` runs last, after `fetch` has been unstubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/** `toBeDisabled` is a jest-dom matcher and this repo installs no jest-dom. */
function saveButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Save Workspace Purpose",
  }) as HTMLButtonElement;
}

/**
 * The form's `<fieldset>`, which is what actually carries the gate.
 *
 * Read HERE and not on the textarea: jsdom's `HTMLTextAreaElement.disabled`
 * reflects only the element's OWN attribute, so a control inside a disabled
 * fieldset reads `false` and an assertion on it would pass in every state —
 * including the broken one where the form collects edits with no wiki.
 */
function formFieldset(): HTMLFieldSetElement {
  return saveButton().closest("fieldset") as HTMLFieldSetElement;
}

/**
 * The status receipt, read as an ELEMENT rather than by its text.
 *
 * `getByText("active", { exact: false })` does not reach this badge: it matches
 * the intro paragraph ("…switching the active wiki…"), so it passes in every
 * state — including the one where a wiki with nothing saved reports `active`.
 * The badge is the only place the form says whether this wiki's purpose exists,
 * so it is asserted on its own node, exactly.
 */
function badge(): string {
  return document.querySelector("span.receipt")?.textContent?.trim() ?? "";
}

/** The purpose textarea, to prove the gate covers the inputs and not just the button. */
function purposeField(): HTMLTextAreaElement {
  return screen.getByPlaceholderText(
    "What should this workspace help you understand, remember, or accomplish?",
  ) as HTMLTextAreaElement;
}

describe("the form names the wiki whose purpose it is showing", () => {
  it("names the active wiki and enables editing", async () => {
    render(<WorkspacePurposeSettings />);

    await waitFor(() =>
      expect(
        screen.getByText(/This purpose belongs to “Acme Ops”\./),
      ).toBeTruthy(),
    );
    // Nothing has been saved for this wiki — `PROFILE` carries no `updatedAt` —
    // so the receipt must say so rather than claiming a live purpose.
    expect(badge()).toBe("not configured");
    expect(formFieldset().disabled).toBe(false);
    expect(saveButton().disabled).toBe(false);
    expect(purposeField().value).toBe("Track decisions.");
  });

  it("reports a saved purpose as active, with its last-saved receipt", async () => {
    stubGet({
      profile: { ...PROFILE, updatedAt: "2026-08-01T10:00:00.000Z" },
      readOnly: false,
      wiki: WIKI,
    });
    render(<WorkspacePurposeSettings />);

    await waitFor(() => expect(badge()).toBe("active"));
    expect(screen.getByText(/^Last saved /)).toBeTruthy();
  });

  it("sends the loaded wiki id with the save, so a switch cannot redirect it", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: { ...WIKI, name: "Renamed" } }),
    );
    fireEvent.submit(saveButton().closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(init.method).toBe("PUT");
    expect(JSON.parse(String(init.body)).wikiId).toBe(WIKI.id);
    // The confirmation names the wiki the SERVER says it wrote, not the one the
    // form last believed in.
    await waitFor(() =>
      expect(
        screen.getByText(/Workspace Purpose saved for “Renamed”\./),
      ).toBeTruthy(),
    );
  });

  it("surfaces a refused save instead of reporting success", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer(
        { error: "The active wiki changed since this form was loaded — reload." },
        { ok: false, status: 400 },
      ),
    );
    fireEvent.submit(saveButton().closest("form")!);

    await waitFor(() =>
      expect(screen.getByText(/The active wiki changed/)).toBeTruthy(),
    );
    expect(screen.queryByText(/Workspace Purpose saved/)).toBeNull();
  });
});

describe("with no wiki, and with a failed load", () => {
  it("says a wiki is needed and collects no edits", async () => {
    stubGet({ profile: emptyWorkspaceProfile(), readOnly: false, wiki: null });
    render(<WorkspacePurposeSettings />);

    await waitFor(() =>
      expect(screen.getByText(/Create a wiki first/)).toBeTruthy(),
    );
    expect(screen.getByText("no wiki")).toBeTruthy();
    // Disabled all the way down: a form that accepted keystrokes here would be
    // collecting edits the route refuses with a 400. The fieldset is what
    // carries it, and the textarea is inside it.
    expect(formFieldset().disabled).toBe(true);
    expect(formFieldset().contains(purposeField())).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("shows a legacy tenant-wide purpose without dating it as this wiki's save", async () => {
    // The one state an existing owner actually upgrades into: a hand-authored
    // `tenants/<t>/workspace-profile.json` and no wiki yet. The route answers
    // its fields read-only so they can be SEEN, but "Last saved …" would date a
    // save that no wiki owns and this disabled form cannot repeat.
    stubGet({
      profile: {
        ...PROFILE,
        purpose: "Written before there were wikis.",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      readOnly: false,
      wiki: null,
    });
    render(<WorkspacePurposeSettings />);

    await waitFor(() => expect(badge()).toBe("no wiki"));
    expect(purposeField().value).toBe("Written before there were wikis.");
    expect(screen.queryByText(/^Last saved /)).toBeNull();
    expect(formFieldset().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });

  it("does not claim a missing wiki when the load itself failed", async () => {
    // "Create a wiki first" is a claim about the registry, and a rejected GET
    // never got to make it — the same distinction WikiWorkbench draws with
    // `unavailable`.
    stubGet({ error: "Storage is unavailable." }, { ok: false, status: 500 });
    render(<WorkspacePurposeSettings />);

    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());
    expect(screen.getByText(/The active wiki couldn’t be loaded/)).toBeTruthy();
    expect(screen.queryByText(/Create a wiki first/)).toBeNull();
    expect(screen.getByText("Storage is unavailable.")).toBeTruthy();
    expect(formFieldset().disabled).toBe(true);
    expect(saveButton().disabled).toBe(true);
  });
});
