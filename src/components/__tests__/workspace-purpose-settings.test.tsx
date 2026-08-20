import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import {
  WORKSPACE_PURPOSE_READ_ONLY_COPY,
  WorkspacePurposeSettings,
} from "@/components/WorkspacePurposeSettings";
import { emptyWorkspaceProfile, type WorkspaceProfile } from "@/lib/workspace-profile";
import {
  formatIfMatch,
  IF_MATCH_HEADER,
  objectVersion,
  WRITE_CONFLICT_COPY,
} from "@/lib/write-precondition";

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

/**
 * The version the route publishes beside {@link PROFILE}.
 *
 * Derived HERE only to spell the fixture — the component must never compute
 * one; it carries back whatever the response named. `objectVersion` is used so
 * the stub is a real response shape rather than a literal that would keep
 * passing if the route's scheme changed underneath it.
 */
const VERSION = objectVersion(PROFILE);

/** What the form's PUT actually sent as its precondition, or undefined. */
function sentIfMatch(call: unknown[]): string | undefined {
  const init = call[1] as RequestInit | undefined;
  return (init?.headers as Record<string, string> | undefined)?.[IF_MATCH_HEADER];
}

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
  stubGet({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION });
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

/** The scenario picker — the one control on this form with no `readonly`. */
function scenarioSelect(): HTMLSelectElement {
  return screen.getByRole("combobox") as HTMLSelectElement;
}

function draftButton(): HTMLButtonElement {
  return screen.getByRole("button", {
    name: "Load scenario draft",
  }) as HTMLButtonElement;
}

/**
 * Whether `element`'s `aria-describedby` reaches a node holding `text`.
 *
 * Resolved through the DOM rather than compared as a string: the attribute takes
 * a space-separated LIST of ids, and an assertion on the raw value would pass
 * against an id nothing renders — which is precisely the failure mode of
 * pointing a refused control at a sentence that is not on screen.
 */
function describedByText(element: Element): string {
  return (element.getAttribute("aria-describedby") ?? "")
    .split(/\s+/)
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent?.trim() ?? "")
    .join(" ");
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
      version: VERSION,
    });
    render(<WorkspacePurposeSettings />);

    await waitFor(() => expect(badge()).toBe("active"));
    expect(screen.getByText(/^Last saved /)).toBeTruthy();
  });

  it("sends the loaded wiki id with the save, so a switch cannot redirect it", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer({
        profile: PROFILE,
        wiki: { ...WIKI, name: "Renamed" },
        version: VERSION,
      }),
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

describe("the form carries the version it was seeded with (DW-145)", () => {
  it("sends the GET's version as If-Match, formatted as a strong validator", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: WIKI, version: VERSION }),
    );
    fireEvent.submit(saveButton().closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Quoted, because a header this form spelled itself is one `parseIfMatch`
    // reads as ABSENT — which is the guard being skipped by malforming it.
    expect(sentIfMatch(fetchMock.mock.calls[1])).toBe(formatIfMatch(VERSION));
  });

  it("adopts the version the PUT answered, so a second save is not refused", async () => {
    // The whole reason the PUT publishes one. Without adopting it, the owner's
    // second save in a session is conditioned on the profile they LOADED and is
    // refused 412 for the change they just made themselves.
    const written = { ...PROFILE, purpose: "Saved once." };
    const secondVersion = objectVersion(written);
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer({ profile: written, wiki: WIKI, version: secondVersion }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(
      answer({ profile: written, wiki: WIKI, version: secondVersion }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(sentIfMatch(fetchMock.mock.calls[1])).toBe(formatIfMatch(VERSION));
    expect(sentIfMatch(fetchMock.mock.calls[2])).toBe(
      formatIfMatch(secondVersion),
    );
  });

  it("sends NO precondition after a failed load, so the refusal is the truthful one", async () => {
    // WHAT THIS PINS, EXACTLY: that a form whose load failed sends no
    // precondition, so the route answers the truthful 428 — "could not be
    // checked" — rather than 412, "changed somewhere else", for a change nobody
    // made. That is the reasoning `useSettings.fetchSettings` applies.
    //
    // WHAT IT DOES NOT PIN: the `setVersion(null)` in the component's `.catch`.
    // This component loads exactly ONCE, at mount, and the state already starts
    // `null`, so deleting that line would leave this case green. The clear is
    // defensive against a refetch this component does not yet perform, and it
    // becomes load-bearing — and observable — the moment one is added. Nothing
    // is added to production code to make it observable today.
    stubGet({ error: "Storage is unavailable." }, { ok: false, status: 500 });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());

    // The fieldset is shut with no wiki, so the PUT is driven the way a
    // non-form caller would — through the submit handler the button points at.
    fetchMock.mockResolvedValueOnce(answer({ profile: PROFILE, wiki: null }));
    fireEvent.submit(saveButton().closest("form")!);

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(sentIfMatch(fetchMock.mock.calls[1])).toBeUndefined();
  });

  it("sends no precondition again once a save answered none", async () => {
    // A PUT that publishes no version leaves the client knowing nothing, and
    // "nothing" has to mean 428 on the next save rather than the superseded
    // version it was holding — which the store no longer has.
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(answer({ profile: PROFILE, wiki: WIKI }));
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    fetchMock.mockResolvedValueOnce(answer({ profile: PROFILE, wiki: WIKI }));
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    expect(sentIfMatch(fetchMock.mock.calls[2])).toBeUndefined();
  });

  it("shows the conflict sentence verbatim and keeps the draft on screen", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fireEvent.change(purposeField(), {
      target: { value: "Minutes of work the owner must not lose." },
    });

    fetchMock.mockResolvedValueOnce(
      answer({ error: WRITE_CONFLICT_COPY }, { ok: false, status: 412 }),
    );
    fireEvent.submit(saveButton().closest("form")!);

    // Relayed through the existing `request` helper and the existing feedback
    // banner — no sentence is typed at a render site.
    await waitFor(() =>
      expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy(),
    );
    expect(screen.queryByText(/Workspace Purpose saved/)).toBeNull();
    // "Your text is still here" has to be TRUE.
    expect(purposeField().value).toBe(
      "Minutes of work the owner must not lose.",
    );
  });
});

describe("with no wiki, and with a failed load", () => {
  it("says a wiki is needed and collects no edits", async () => {
    stubGet({
      profile: emptyWorkspaceProfile(),
      readOnly: false,
      wiki: null,
      version: objectVersion(emptyWorkspaceProfile()),
    });
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
      version: VERSION,
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

describe("on a read-only deployment the form refuses without going silent", () => {
  /**
   * The whole point of the case (DW-191). `disabled` on the `<fieldset>` took
   * every descendant out of the tab order, so a keyboard or screen-reader owner
   * could not READ the stored Workspace Purpose at all — the form refused by
   * hiding itself. Read-only means read-only, not hidden.
   */
  beforeEach(() => {
    stubGet({ profile: PROFILE, readOnly: true, wiki: WIKI, version: VERSION });
  });

  it("keeps every stored value readable and in the tab order", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(purposeField().value).toBe("Track decisions."));

    // The gate the fieldset still carries is `loading || saving || !wiki` — and
    // none of those hold here, so nothing on this form reports `disabled`.
    expect(formFieldset().disabled).toBe(false);
    expect(formFieldset().hasAttribute("disabled")).toBe(false);
    expect(purposeField().readOnly).toBe(true);
    expect(purposeField().disabled).toBe(false);
    // Reachable, not merely undisabled.
    purposeField().focus();
    expect(document.activeElement).toBe(purposeField());

    // Every other text field, so a `readOnly` added to one box and forgotten on
    // the next four is a failure rather than a passing sample.
    for (const placeholder of [
      "One question per line",
      "One boundary per line",
      "One exclusion per line",
      "English",
      "How should work-wiki organize, qualify, and connect generated knowledge?",
    ]) {
      const field = screen.getByPlaceholderText(placeholder) as
        | HTMLInputElement
        | HTMLTextAreaElement;
      expect(field.readOnly, placeholder).toBe(true);
      expect(field.hasAttribute("disabled"), placeholder).toBe(false);
      expect(describedByText(field), placeholder).toContain(
        WORKSPACE_PURPOSE_READ_ONLY_COPY,
      );
    }
  });

  it("marks the picker and both buttons aria-disabled rather than disabled", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(purposeField().value).toBe("Track decisions."));

    // A <select> has no `readonly`, so the picker takes the attribute instead —
    // and `disabled` would take the scenario this wiki runs on out of reach.
    for (const control of [scenarioSelect(), draftButton(), saveButton()]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
      // "dimmed" and nothing else is what an `aria-disabled` control announces
      // without this: the sentence IS the refusal.
      expect(describedByText(control)).toContain(WORKSPACE_PURPOSE_READ_ONLY_COPY);
    }
    expect(screen.getByText(WORKSPACE_PURPOSE_READ_ONLY_COPY)).toBeTruthy();
  });

  it("issues no PUT when the owner submits anyway", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(purposeField().value).toBe("Track decisions."));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fireEvent.submit(saveButton().closest("form")!);

    // Still just the GET — and no feedback banner, because nothing happened.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Workspace Purpose saved/)).toBeNull();
    expect(saveButton().textContent).toBe("Save Workspace Purpose");
  });

  it("does not overwrite the stored purpose with a scenario draft", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(purposeField().value).toBe("Track decisions."));

    fireEvent.click(draftButton());

    // The refusal has to land BEFORE the state change: the owner came here to
    // read a purpose they cannot save back, and a template draft painted over
    // it destroys the only copy on screen.
    expect(purposeField().value).toBe("Track decisions.");
    expect(screen.queryByText(/template loaded as a draft/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses a change fired on the scenario picker", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(purposeField().value).toBe("Track decisions."));
    expect(scenarioSelect().value).toBe("business");

    // `aria-disabled` does NOT stop interaction — the early return in the
    // handler is the only thing refusing this control, and without this case
    // deleting that guard leaves the whole suite green while the picker moves
    // off the scenario the wiki is actually running on.
    fireEvent.change(scenarioSelect(), { target: { value: "research" } });

    expect(scenarioSelect().value).toBe("business");
    expect(screen.queryByText(/template loaded as a draft/)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps Load scenario draft reachable when the scenario has no template", async () => {
    // Read-only AND `custom`, which is reachable: `!selectedTemplate` is value
    // state and would otherwise win, taking the button — and the only
    // `aria-describedby` pointer to the refusal — out of the tab order. That is
    // the harm this change removes, so the deployment state has to outrank it.
    stubGet({
      profile: { ...PROFILE, scenario: "custom" },
      readOnly: true,
      wiki: WIKI,
      version: VERSION,
    });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(scenarioSelect().value).toBe("custom"));

    const draft = draftButton();
    expect(draft.hasAttribute("disabled")).toBe(false);
    expect(draft.getAttribute("aria-disabled")).toBe("true");
    draft.focus();
    expect(document.activeElement).toBe(draft);
    expect(describedByText(draft)).toContain(WORKSPACE_PURPOSE_READ_ONLY_COPY);

    fireEvent.click(draft);
    expect(purposeField().value).toBe("Track decisions.");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("still disables Load scenario draft with no template on a writable deployment", async () => {
    // The value-state leg is unchanged where it is the only one in play.
    stubGet({
      profile: { ...PROFILE, scenario: "custom" },
      readOnly: false,
      wiki: WIKI,
      version: VERSION,
    });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(scenarioSelect().value).toBe("custom"));

    expect(draftButton().disabled).toBe(true);
  });

  it("leaves a writable deployment exactly as it was", async () => {
    stubGet({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    expect(screen.queryByText(WORKSPACE_PURPOSE_READ_ONLY_COPY)).toBeNull();
    expect(purposeField().readOnly).toBe(false);
    expect(purposeField().hasAttribute("aria-describedby")).toBe(false);
    expect(scenarioSelect().hasAttribute("aria-disabled")).toBe(false);
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);

    fireEvent.click(draftButton());
    await waitFor(() =>
      expect(screen.getByText(/template loaded as a draft/)).toBeTruthy(),
    );
  });
});
