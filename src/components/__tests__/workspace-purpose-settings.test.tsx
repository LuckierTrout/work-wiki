import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { fireVisibilityChange } from "../../../vitest.setup.dom";
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

/**
 * The wiki the owner switches to IN ANOTHER TAB — a different id AND a
 * different name, so a recheck that adopted only half the answer (the name for
 * the intro, say, but not the id the next save is conditioned on) is a failure
 * here rather than a passing sample.
 */
const OTHER_WIKI = { id: "00000000-0000-4000-8000-000000000002", name: "Beta Lab" };

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

/** A promise this test resolves by hand, so it can act while a request is open. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settleIt) => {
    resolve = settleIt;
  });
  return { promise, resolve };
}

/** `fetch` for the MOUNT load, held open until the returned gate is resolved. */
function stubPendingGet(): { resolve: (value: Response) => void } {
  const gate = deferred<Response>();
  fetchMock = vi.fn(() => gate.promise);
  vi.stubGlobal("fetch", fetchMock);
  return gate;
}

/**
 * Let everything that was going to happen, happen.
 *
 * `await Promise.resolve()` is ONE microtask, and every negative assertion here
 * ("no second request was issued") is only as strong as the settling in front
 * of it — a request two awaits deep would pass that check while doing exactly
 * what the case forbids. A macrotask turn inside `act` drains the microtask
 * queue and flushes the React work it produced.
 */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

/**
 * The render on screen has been MIRRORED into what a recheck reads.
 *
 * A rendered answer and the recheck's view of it are not the same moment, and
 * the gap between them is what DW-325 was (a case that failed under full-suite
 * load and passed on re-run). `standDown` — the flag every visibility recheck
 * reads first — reaches `screenRef` through a PASSIVE effect (the `screenRef`
 * mirror effect in `WorkspacePurposeSettings.tsx`), so the surface can already
 * show a settled load while the mirror still holds the loading render's `true`.
 * A recheck fired in that window returns at `load`'s `standDown` guard: no GET,
 * no state change, and an assertion that can only fail by timing out — saying
 * "the badge never moved" rather than "the recheck never started".
 *
 * Cases that fire an `act`-wrapped event between the mount and the recheck
 * (a `fireEvent.change`, a `fireEvent.click`) flush the mirror as a side effect
 * and never saw this. Cases that go straight from a mount wait to a
 * `visibilitychange` or a `focus` need the barrier stated out loud, which is
 * what this is.
 *
 * Separate from {@link formReady} because the mount wait is not always the
 * fieldset: a form that answered "no wiki", or one whose load failed, settles
 * on a badge instead — same mirror, different thing to wait for first.
 */
async function mirrored(): Promise<void> {
  await settle();
}

/** The mount load has landed AND the render it produced has been mirrored. */
async function formReady(): Promise<void> {
  await waitFor(() => expect(formFieldset().disabled).toBe(false));
  await mirrored();
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

/** The load-failed state's way out of itself (DW-142). */
function tryAgainButton(): HTMLButtonElement {
  return screen.getByRole("button", { name: "Try again" }) as HTMLButtonElement;
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

  it("issues no PUT at all after a failed load, so there is no precondition to get wrong", async () => {
    // THIS CASE USED TO PIN THE 428 PATH from this surface: a form whose load
    // failed sent no `If-Match`, so the route answered "could not be checked"
    // rather than "changed somewhere else". It cannot pin that any more, and
    // the reason is the fix rather than a lost assertion — a failed load leaves
    // no wiki, and `save()` now early-returns on `!wiki` (DW-301), so the
    // request is refused here instead of being sent and rejected there.
    //
    // The no-version-therefore-no-precondition rule is still pinned, by the
    // case below it: a save that answers no version leaves the next one
    // unconditioned. The 428 the route answers for it lives in
    // `workspace-profile-routes.test.ts`.
    stubGet({ error: "Storage is unavailable." }, { ok: false, status: 500 });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());

    // Driven the way a non-form caller would — through the submit handler the
    // button points at, which `aria-disabled` does not stop.
    fireEvent.submit(saveButton().closest("form")!);

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
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

describe("a save that settles too late speaks for nobody (DW-320)", () => {
  /**
   * `save()` was the one path in this file with NO post-await guard.
   *
   * `load` has carried both halves for a while — `cancelledRef` for "this
   * component is gone" and `answerSeqRef` for "something newer already owns the
   * form" — and every one of its state writes sits behind them. The write path
   * had neither, so a PUT settling after the form unmounted wrote into a dead
   * tree, and the OLDER of two overlapping saves could land last and put its
   * stale profile, its stale version and its own confirmation on screen over
   * the newer one. The version is the half that outlives the render: the next
   * save is conditioned on it, so adopting the wrong one turns the following
   * save into a 412 for a change the owner made themselves.
   */
  it("adopts only the NEWEST save when an older one settles last", async () => {
    const older: WorkspaceProfile = { ...PROFILE, purpose: "First attempt." };
    const newer: WorkspaceProfile = { ...PROFILE, purpose: "Second attempt." };
    const newerVersion = objectVersion(newer);
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    // Two PUTs in flight at once. `fireEvent.submit` drives the handler
    // directly, which is what a second Enter in a field does — the disabled
    // fieldset is a rendering decision, not the gate.
    //
    // The form node is held rather than re-queried, because `saveButton()`
    // matches on the accessible name and the submit control is relabelled
    // "Saving…" for the length of the first request.
    const form = saveButton().closest("form")!;
    const first = deferred<Response>();
    fetchMock.mockImplementationOnce(() => first.promise);
    fireEvent.submit(form);
    await settle();

    const second = deferred<Response>();
    fetchMock.mockImplementationOnce(() => second.promise);
    fireEvent.submit(form);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(3);

    // The newer one answers first…
    second.resolve(
      answer({ profile: newer, wiki: OTHER_WIKI, version: newerVersion }),
    );
    await waitFor(() => expect(purposeField().value).toBe("Second attempt."));

    // …and the older one lands afterwards, carrying a different profile, a
    // different wiki and a different version. Every one of them must be dropped.
    first.resolve(
      answer({ profile: older, wiki: WIKI, version: objectVersion(older) }),
    );
    await settle();

    expect(purposeField().value).toBe("Second attempt.");
    expect(screen.getByText(/This purpose belongs to “Beta Lab”\./)).toBeTruthy();
    expect(screen.getByRole("status").textContent).toContain(
      "Workspace Purpose saved for “Beta Lab”",
    );
    // The version is the half a rendered assertion cannot see, so it is read
    // off the NEXT save's precondition: the older answer's version must not be
    // what the following PUT is conditioned on.
    fetchMock.mockResolvedValueOnce(
      answer({ profile: newer, wiki: OTHER_WIKI, version: newerVersion }),
    );
    fireEvent.submit(form);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(sentIfMatch(fetchMock.mock.calls[3])).toBe(formatIfMatch(newerVersion));
  });

  it("does not clear `saving` from a superseded run", async () => {
    // `finally` runs on the superseded path too — `return` inside `try` does not
    // skip it — so the guard has to be inside the block rather than relying on
    // an early exit above it. Without it the older save lifts the gate over a
    // PUT that is still in flight, and the owner can submit a third one into it.
    const first = deferred<Response>();
    const second = deferred<Response>();
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    const form = saveButton().closest("form")!;
    fetchMock.mockImplementationOnce(() => first.promise);
    fireEvent.submit(form);
    await settle();
    fetchMock.mockImplementationOnce(() => second.promise);
    fireEvent.submit(form);
    await settle();

    // The OLDER one settles while the newer is still open.
    first.resolve(answer({ profile: PROFILE, wiki: WIKI, version: VERSION }));
    await settle();

    // Read off `form` rather than through `formFieldset()`/`saveButton()`: both
    // find the fieldset by the submit control's ACCESSIBLE NAME, and the button
    // is relabelled "Saving…" for exactly the state under test here.
    const fieldset = form.querySelector("fieldset") as HTMLFieldSetElement;
    const submit = form.querySelector('button[type="submit"]') as HTMLButtonElement;
    expect(fieldset.disabled).toBe(true);
    expect(submit.textContent).toBe("Saving…");

    second.resolve(answer({ profile: PROFILE, wiki: WIKI, version: VERSION }));
    await waitFor(() => expect(fieldset.disabled).toBe(false));
  });

  it("clears `saving` even when a recheck moves the ANSWER token underneath it", async () => {
    // THE STRANDING CASE. `saving` is cleared in `save()`'s `finally`, and
    // nothing else clears it — so whatever gates that line owns whether this
    // form is ever editable again.
    //
    // Gated on the ANSWER token it would not survive a recheck, because `load`
    // bumps that token in every mode. The recheck is supposed to stand down
    // while a save is in flight, but the flag it reads lives in `screenRef`,
    // which an EFFECT writes — so there is a real window after `setSaving(true)`
    // in which one can still start. That window is entered here deterministically
    // by firing `visibilitychange` from inside the PUT's own `fetch`, which runs
    // in the submit handler's call stack before React has committed anything.
    //
    // The answer being dropped is expected and is NOT what this case is about:
    // the form must simply not be left disabled with the button on "Saving…"
    // for the rest of the session.
    const gate = deferred<Response>();
    let interrupted = false;
    render(<WorkspacePurposeSettings />);
    // This case's premise is that the recheck IS allowed to start, so the
    // mirror has to be real before the PUT fires one. See `formReady`.
    await formReady();

    fetchMock.mockImplementation((url: unknown, init?: RequestInit) => {
      if (init?.method === "PUT" && !interrupted) {
        interrupted = true;
        // Still inside the submit handler: `setSaving(true)` has been called,
        // React has committed nothing, and `screenRef.current.standDown` is
        // therefore the stale `false` a recheck is allowed to start on.
        fireVisibilityChange("hidden");
        fireVisibilityChange("visible");
        return gate.promise;
      }
      return Promise.resolve(
        answer({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }),
      );
    });

    fireEvent.submit(saveButton().closest("form")!);
    await settle();
    // The recheck really did start — otherwise this case proves nothing at all.
    expect(interrupted).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => !init || !("method" in init)).length)
      .toBeGreaterThanOrEqual(2);

    gate.resolve(answer({ profile: PROFILE, wiki: WIKI, version: VERSION }));
    await settle();

    // The form comes back. Before the save token existed this stayed disabled
    // forever, with no message and no way for the owner to try again.
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    expect(saveButton().textContent).not.toBe("Saving…");
  });

  it("writes nothing when the PUT resolves after the form unmounts", async () => {
    // COVERAGE LIMIT, and the reason `workspace-purpose-save-guard.test.ts`
    // exists: React silently discards a state update aimed at an unmounted
    // tree, so "the write did not happen" is not something a mounted assertion
    // can distinguish from "the write happened and went nowhere". What this
    // case CAN hold is that the late answer is handled at all — no rejection
    // escapes into the run, and nothing from the torn-down form comes back —
    // and the scan holds that the guard is spelled.
    const gate = deferred<Response>();
    const { unmount } = render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockImplementationOnce(() => gate.promise);
    fireEvent.submit(saveButton().closest("form")!);
    await settle();

    unmount();
    gate.resolve(
      answer({
        profile: { ...PROFILE, purpose: "Landed after the unmount." },
        wiki: OTHER_WIKI,
        version: objectVersion(PROFILE),
      }),
    );
    await settle();

    expect(screen.queryByText("Landed after the unmount.")).toBeNull();
    expect(screen.queryByRole("status")).toBeNull();
    expect(document.querySelector("fieldset")).toBeNull();
  });
});

describe("with no wiki, and with a failed load", () => {
  /**
   * The wiki-less body is READABLE (DW-301). `disabled` on the `<fieldset>`
   * took every descendant out of the tab order, so the profile the route still
   * answers — text the owner is entitled to read — was displayed and
   * unreachable by keyboard and by screen reader. Exactly the DW-191 defect,
   * one leg later. Each control refuses for itself instead, pointing at the
   * intro paragraph for the reason.
   */
  it("says a wiki is needed, keeps the body reachable, and collects no edits", async () => {
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
    // Not shut: the gate is `loading || saving` now, and neither holds.
    expect(formFieldset().disabled).toBe(false);
    expect(formFieldset().contains(purposeField())).toBe(true);
    expect(purposeField().readOnly).toBe(true);
    expect(purposeField().hasAttribute("disabled")).toBe(false);
    purposeField().focus();
    expect(document.activeElement).toBe(purposeField());
    // Every refused control resolves an ON-SCREEN sentence, and it is the intro
    // paragraph — the one place that tells "no wiki" apart from "the load
    // failed" — rather than a second copy of the same claim.
    for (const control of [purposeField(), scenarioSelect(), draftButton(), saveButton()]) {
      expect(describedByText(control)).toContain("Create a wiki first");
    }
    for (const control of [scenarioSelect(), draftButton(), saveButton()]) {
      expect(control.getAttribute("aria-disabled")).toBe("true");
      expect(control.hasAttribute("disabled")).toBe(false);
    }
    // And a way out of the state, which is `/` — the only place a wiki is
    // created (DW-142).
    const link = screen.getByRole("link", { name: "Create a wiki" });
    expect(link.getAttribute("href")).toBe("/");
  });

  it("issues no PUT when a wiki-less form is submitted by any route", async () => {
    stubGet({
      profile: emptyWorkspaceProfile(),
      readOnly: false,
      wiki: null,
      version: objectVersion(emptyWorkspaceProfile()),
    });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(badge()).toBe("no wiki"));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // `aria-disabled` does NOT stop activation, so the early return in `save()`
    // is the whole refusal — and submitting the form bypasses the button
    // entirely, which is the route a keyboard Enter takes.
    fireEvent.submit(saveButton().closest("form")!);
    fireEvent.click(saveButton());

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Workspace Purpose saved/)).toBeNull();
  });

  it("refuses the scenario picker and the draft button without shutting them", async () => {
    stubGet({
      profile: { ...PROFILE, purpose: "Owned by no wiki." },
      readOnly: false,
      wiki: null,
      version: VERSION,
    });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(badge()).toBe("no wiki"));

    fireEvent.change(scenarioSelect(), { target: { value: "research" } });
    expect(scenarioSelect().value).toBe("business");

    // The template would paint over the values the route answered for READING,
    // which is the whole point of keeping them on screen.
    fireEvent.click(draftButton());
    expect(purposeField().value).toBe("Owned by no wiki.");
    expect(screen.queryByText(/template loaded as a draft/)).toBeNull();
  });

  it("never dates a wiki-less body as this wiki's save, whatever it carries", async () => {
    // THE CLIENT'S OWN GUARD, not a claim about what the route sends. It used
    // to be both: with no wiki the route answered the retired tenant-global
    // profile so the owner could SEE it, and this case pinned that body. DW-137
    // removed that read, so no route response reaches the client this way any
    // more — but the guard is what the component owes regardless of who
    // composes the body, because "Last saved …" would date a save that no wiki
    // owns and this form cannot repeat.
    stubGet({
      profile: {
        ...PROFILE,
        purpose: "Populated, but owned by no wiki.",
        updatedAt: "2026-01-02T00:00:00.000Z",
      },
      readOnly: false,
      wiki: null,
      version: VERSION,
    });
    render(<WorkspacePurposeSettings />);

    await waitFor(() => expect(badge()).toBe("no wiki"));
    expect(purposeField().value).toBe("Populated, but owned by no wiki.");
    expect(screen.queryByText(/^Last saved /)).toBeNull();
    expect(purposeField().readOnly).toBe(true);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
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
    // Announced, not merely rendered: nothing else on this surface says the
    // load failed (DW-142).
    expect(screen.getByRole("alert").textContent).toContain(
      "Storage is unavailable.",
    );
    // The failed state offers the retry, and NOT the create link — which would
    // be the registry claim the intro just refused to make.
    expect(tryAgainButton()).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Create a wiki" })).toBeNull();
    // Refused, but reachable — same contract as the wiki-less body.
    expect(formFieldset().disabled).toBe(false);
    expect(saveButton().getAttribute("aria-disabled")).toBe("true");
    expect(describedByText(saveButton())).toContain(
      "The active wiki couldn’t be loaded",
    );
  });
});

describe("the failed load is not a dead end (DW-142)", () => {
  beforeEach(() => {
    stubGet({ error: "Storage is unavailable." }, { ok: false, status: 500 });
  });

  it("clears the failure and seeds the form when Try again succeeds", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }),
    );
    fireEvent.click(tryAgainButton());

    await waitFor(() =>
      expect(
        screen.getByText(/This purpose belongs to “Acme Ops”\./),
      ).toBeTruthy(),
    );
    expect(badge()).toBe("not configured");
    expect(screen.queryByText("Storage is unavailable.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    // Editable again, all the way down: the retry re-seeds the same state the
    // mount does, because it is the same function.
    expect(purposeField().readOnly).toBe(false);
    expect(purposeField().hasAttribute("aria-describedby")).toBe(false);
    expect(saveButton().hasAttribute("aria-disabled")).toBe(false);

    // And the version it re-seeded is the one the retry's answer named.
    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: WIKI, version: VERSION }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sentIfMatch(fetchMock.mock.calls[2])).toBe(formatIfMatch(VERSION));
  });

  it("keeps Try again mounted and focused for the length of its own request", async () => {
    // `loadFailed` is cleared the moment the attempt starts, so a button
    // rendered on that alone unmounts under the finger that pressed it and
    // drops keyboard focus to `<body>` — on the one change whose subject is
    // reachability.
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());

    const gate = deferred<Response>();
    fetchMock.mockImplementationOnce(() => gate.promise);
    tryAgainButton().focus();
    fireEvent.click(tryAgainButton());
    await settle();

    // Still there, still holding focus, and saying what it is doing.
    const retrying = screen.getByRole("button", { name: "Trying again…" });
    expect(document.activeElement).toBe(retrying);
    // `aria-disabled`, not `disabled`: disabling the focused element is what
    // moves focus to `<body>`, which is the harm this case exists to catch.
    expect(retrying.hasAttribute("disabled")).toBe(false);
    expect(retrying.getAttribute("aria-disabled")).toBe("true");

    // And a second press while it is running issues no second request.
    fireEvent.click(retrying);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    gate.resolve(
      answer({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }),
    );
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    expect(screen.queryByRole("button", { name: "Trying again…" })).toBeNull();
  });

  it("re-arms the same failed state when the retry fails too", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());

    fetchMock.mockResolvedValueOnce(
      answer({ error: "Storage is still unavailable." }, { ok: false, status: 500 }),
    );
    fireEvent.click(tryAgainButton());

    await waitFor(() =>
      expect(screen.getByText("Storage is still unavailable.")).toBeTruthy(),
    );
    expect(badge()).toBe("unavailable");
    expect(tryAgainButton()).toBeTruthy();
    // The intro still refuses to claim the registry is empty.
    expect(screen.queryByText(/Create a wiki first/)).toBeNull();
  });
});

describe("the form re-reads the active wiki when the tab comes back (DW-136)", () => {
  /** Hidden, then visible — the switch is made in ANOTHER tab. */
  function returnToTab() {
    fireVisibilityChange("hidden");
    fireVisibilityChange("visible");
  }

  it("leaves an unsaved draft alone when the wiki has not changed", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fireEvent.change(purposeField(), {
      target: { value: "Minutes of work the owner must not lose." },
    });

    // The SAME wiki, but a different profile and version behind it: if the
    // recheck adopted anything at all, both the draft and the precondition
    // would move here.
    const moved = { ...PROFILE, purpose: "Someone else’s bytes." };
    fetchMock.mockResolvedValueOnce(
      answer({
        profile: moved,
        readOnly: false,
        wiki: WIKI,
        version: objectVersion(moved),
      }),
    );
    returnToTab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    expect(purposeField().value).toBe(
      "Minutes of work the owner must not lose.",
    );
    expect(screen.queryByText(/active wiki changed/)).toBeNull();
    expect(badge()).toBe("not configured");

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: WIKI, version: VERSION }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sentIfMatch(fetchMock.mock.calls[2])).toBe(formatIfMatch(VERSION));
  });

  it("re-seeds from the new wiki, and the next save carries its id and version", async () => {
    const otherProfile: WorkspaceProfile = {
      ...PROFILE,
      purpose: "Beta Lab’s own purpose.",
      updatedAt: "2026-08-02T09:00:00.000Z",
    };
    const otherVersion = objectVersion(otherProfile);
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    fireEvent.change(purposeField(), { target: { value: "A draft for Acme." } });

    fetchMock.mockResolvedValueOnce(
      answer({
        profile: otherProfile,
        readOnly: false,
        wiki: OTHER_WIKI,
        version: otherVersion,
      }),
    );
    returnToTab();

    await waitFor(() =>
      expect(
        screen.getByText(/This purpose belongs to “Beta Lab”\./),
      ).toBeTruthy(),
    );
    // The draft is gone — stated, not silent, which is the trade the recheck
    // makes: keeping it on screen under a new wiki's name is the mislabelling.
    expect(purposeField().value).toBe("Beta Lab’s own purpose.");
    expect(screen.getByRole("alert").textContent).toContain(
      "The active wiki changed to “Beta Lab”",
    );
    // And nothing of Acme's survives the swap: this receipt is Beta Lab's.
    expect(badge()).toBe("active");
    expect(screen.getByText(/^Last saved /)).toBeTruthy();

    fetchMock.mockResolvedValueOnce(
      answer({ profile: otherProfile, wiki: OTHER_WIKI, version: otherVersion }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    const [, init] = fetchMock.mock.calls[2] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).wikiId).toBe(OTHER_WIKI.id);
    expect(sentIfMatch(fetchMock.mock.calls[2])).toBe(formatIfMatch(otherVersion));
  });

  it("changes nothing when the recheck itself fails", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    fireEvent.change(purposeField(), { target: { value: "Still here." } });

    fetchMock.mockResolvedValueOnce(
      answer({ error: "Storage is unavailable." }, { ok: false, status: 500 }),
    );
    returnToTab();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));

    // A background read nobody asked for must not take a loaded, editable form
    // away from the owner.
    expect(purposeField().value).toBe("Still here.");
    expect(badge()).toBe("not configured");
    expect(screen.queryByText("Storage is unavailable.")).toBeNull();
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
    expect(formFieldset().disabled).toBe(false);

    // And the version it was holding is untouched, so the next save is still
    // conditioned on the read it was seeded from.
    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: WIKI, version: VERSION }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sentIfMatch(fetchMock.mock.calls[2])).toBe(formatIfMatch(VERSION));
  });

  it("re-reads on a window focus, for two side-by-side windows", async () => {
    // `visibilitychange` never fires when BOTH windows are on screen — the
    // Workbench in one and this form in the other — which is exactly the
    // arrangement that leaves this form naming a wiki that is no longer active.
    const otherProfile: WorkspaceProfile = { ...PROFILE, purpose: "Beta Lab’s own." };
    render(<WorkspacePurposeSettings />);
    await formReady();

    fetchMock.mockResolvedValueOnce(
      answer({
        profile: otherProfile,
        readOnly: false,
        wiki: OTHER_WIKI,
        version: objectVersion(otherProfile),
      }),
    );
    window.dispatchEvent(new Event("focus"));

    await waitFor(() =>
      expect(screen.getByText(/This purpose belongs to “Beta Lab”\./)).toBeTruthy(),
    );
    expect(purposeField().value).toBe("Beta Lab’s own.");
  });

  it("says plainly what changed, and claims no loss, when nothing was edited", async () => {
    // A red alert asserting discarded work over a background switch that
    // discarded nothing is the same mislabelling with the sign flipped — and it
    // trains the owner to ignore the banner that will one day be telling the
    // truth.
    const otherProfile: WorkspaceProfile = { ...PROFILE, purpose: "Beta Lab’s own." };
    render(<WorkspacePurposeSettings />);
    await formReady();

    fetchMock.mockResolvedValueOnce(
      answer({
        profile: otherProfile,
        readOnly: false,
        wiki: OTHER_WIKI,
        version: objectVersion(otherProfile),
      }),
    );
    returnToTab();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "The active wiki changed to “Beta Lab”",
      ),
    );
    expect(screen.queryByText(/discarded/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("counts a scenario draft as unsaved work, and says so when it goes", async () => {
    // The template writes every field through the same seeding path a server
    // answer uses. If that path re-baselined "unchanged", a loaded draft would
    // be discarded silently while the banner reported a clean switch.
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    fireEvent.click(draftButton());
    await waitFor(() =>
      expect(screen.getByText(/template loaded as a draft/)).toBeTruthy(),
    );

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, readOnly: false, wiki: OTHER_WIKI, version: VERSION }),
    );
    returnToTab();

    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Your unsaved edits to the previous wiki were discarded",
      ),
    );
  });

  it("does not call a first wiki a change from a previous one", async () => {
    stubGet({
      profile: emptyWorkspaceProfile(),
      readOnly: false,
      wiki: null,
      version: objectVersion(emptyWorkspaceProfile()),
    });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(badge()).toBe("no wiki"));
    await mirrored();

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }),
    );
    returnToTab();

    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "This workspace now has an active wiki, “Acme Ops”",
      ),
    );
    // Nothing "changed to" a wiki from a wiki that never existed, and nothing
    // was discarded — a wiki-less form collects no edits to lose.
    expect(screen.queryByText(/The active wiki changed to/)).toBeNull();
    expect(screen.queryByText(/discarded/)).toBeNull();
    expect(purposeField().readOnly).toBe(false);
  });

  it("adopts a recheck that answers no wiki at all", async () => {
    render(<WorkspacePurposeSettings />);
    // DW-325 — the first half of this case's old race; see `formReady`.
    await formReady();

    fetchMock.mockResolvedValueOnce(
      answer({
        profile: emptyWorkspaceProfile(),
        readOnly: false,
        wiki: null,
        version: objectVersion(emptyWorkspaceProfile()),
      }),
    );
    returnToTab();

    // SECOND: the adoption is deterministic once the recheck has started, so
    // there is nothing here for a wall-clock budget to wait on — the old
    // `waitFor(badge() === "no wiki")` could only ever expire under load, and
    // when it did it said "no wiki" and not WHY. Assert the round trip in the
    // two steps it actually has: the request went out, then its answer landed.
    await settle();
    expect(
      fetchMock.mock.calls.length,
      "the recheck never issued its GET — it stood down instead of re-reading",
    ).toBe(2);

    await settle();
    expect(badge()).toBe("no wiki");
    expect(screen.getByRole("status").textContent).toContain(
      "The active wiki is gone, so there is nothing to edit here now.",
    );
    // Refused, but readable and reachable — the same contract as a mount that
    // answered no wiki.
    expect(formFieldset().disabled).toBe(false);
    expect(purposeField().readOnly).toBe(true);
    expect(describedByText(saveButton())).toContain("Create a wiki first");
    expect(screen.queryByText(/^Last saved /)).toBeNull();

    fireEvent.submit(saveButton().closest("form")!);
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not start while the mount GET is still pending", async () => {
    const gate = stubPendingGet();
    render(<WorkspacePurposeSettings />);

    returnToTab();
    await settle();
    // One GET, not two: the mount's own answer is about to arrive, and a
    // recheck comparing against a wiki id no render has been seeded with yet
    // would announce a change nobody made.
    expect(fetchMock).toHaveBeenCalledTimes(1);

    gate.resolve(
      answer({ profile: PROFILE, readOnly: false, wiki: WIKI, version: VERSION }),
    );
    await waitFor(() => expect(formFieldset().disabled).toBe(false));
    expect(screen.queryByText(/active wiki/)).not.toBeNull();
    expect(screen.queryByText(/The active wiki changed/)).toBeNull();
  });

  it("does not start while a save is still pending", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    const gate = deferred<Response>();
    fetchMock.mockImplementationOnce(() => gate.promise);
    fireEvent.submit(saveButton().closest("form")!);
    await settle();

    returnToTab();
    await settle();
    // The GET and the PUT, and nothing else: the write in flight owns which
    // wiki this form ends up describing.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    gate.resolve(answer({ profile: PROFILE, wiki: WIKI, version: VERSION }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Workspace Purpose saved",
      ),
    );
  });

  it("abandons a recheck that was already in flight when the owner saved", async () => {
    // The window the stand-down check cannot see: the recheck STARTED legally,
    // and the save began during its round trip. Adopting the answer afterwards
    // overwrites what was just written and replaces the confirmation with an
    // alert about a switch the owner never made.
    const saved: WorkspaceProfile = { ...PROFILE, purpose: "Saved by the owner." };
    render(<WorkspacePurposeSettings />);
    await formReady();

    const gate = deferred<Response>();
    fetchMock.mockImplementationOnce(() => gate.promise);
    returnToTab();
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(
      answer({ profile: saved, wiki: WIKI, version: objectVersion(saved) }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Workspace Purpose saved",
      ),
    );

    // …and only NOW does the recheck's GET come back, carrying another wiki.
    gate.resolve(
      answer({
        profile: { ...PROFILE, purpose: "Beta Lab’s own." },
        readOnly: false,
        wiki: OTHER_WIKI,
        version: objectVersion(PROFILE),
      }),
    );
    await settle();

    expect(purposeField().value).toBe("Saved by the owner.");
    expect(screen.getByText(/This purpose belongs to “Acme Ops”\./)).toBeTruthy();
    expect(screen.queryByText(/The active wiki changed/)).toBeNull();
    expect(screen.getByRole("status").textContent).toContain(
      "Workspace Purpose saved",
    );
  });

  it("runs one recheck at a time, however fast the tab is switched", async () => {
    render(<WorkspacePurposeSettings />);
    await formReady();

    const gate = deferred<Response>();
    fetchMock.mockImplementationOnce(() => gate.promise);
    returnToTab();
    returnToTab();
    window.dispatchEvent(new Event("focus"));
    await settle();

    // Two overlapping GETs would both compare the same pre-adopt snapshot, so
    // both could adopt and both could announce.
    expect(fetchMock).toHaveBeenCalledTimes(2);

    gate.resolve(
      answer({ profile: PROFILE, readOnly: false, wiki: OTHER_WIKI, version: VERSION }),
    );
    await waitFor(() =>
      expect(screen.getByText(/This purpose belongs to “Beta Lab”\./)).toBeTruthy(),
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("stands down while the failure surface is up, so Try again owns recovery", async () => {
    stubGet({ error: "Storage is unavailable." }, { ok: false, status: 500 });
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(screen.getByText("unavailable")).toBeTruthy());
    await mirrored();

    returnToTab();
    await settle();

    // No second GET: a recheck here would adopt a wiki as though it had
    // "changed" from the nothing a failed load left behind, announcing a switch
    // that never happened while `unavailable` stood over a seeded form.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(tryAgainButton()).toBeTruthy();
  });

  it("stops listening once the form unmounts", async () => {
    const { unmount } = render(<WorkspacePurposeSettings />);
    await formReady();

    unmount();
    fireVisibilityChange("hidden");
    fireVisibilityChange("visible");
    window.dispatchEvent(new Event("focus"));

    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("read-only AND wiki-less at once", () => {
  // Both refusals are reachable together and neither is a special case of the
  // other, so every stub in the two suites above holds one of them constant —
  // which leaves the composed state, the one the `describedBy` join exists for,
  // rendered by nothing.
  beforeEach(() => {
    stubGet({ profile: PROFILE, readOnly: true, wiki: null, version: VERSION });
  });

  it("states BOTH reasons on every refused control", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(badge()).toBe("no wiki"));

    for (const control of [purposeField(), scenarioSelect(), draftButton(), saveButton()]) {
      const described = describedByText(control);
      // A control that named one of the two would be describing half of why it
      // will not run, and the owner would fix the half they were told about.
      expect(described).toContain(WORKSPACE_PURPOSE_READ_ONLY_COPY);
      expect(described).toContain("Create a wiki first");
      expect((control.getAttribute("aria-describedby") ?? "").split(/\s+/)).toHaveLength(2);
    }
    expect(purposeField().readOnly).toBe(true);
    expect(formFieldset().disabled).toBe(false);
  });

  it("offers no Create a wiki link on a deployment that refuses creation", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(badge()).toBe("no wiki"));

    // `POST /api/wikis` answers 403 here, so the link would send the owner to
    // `/` for something that surface has already refused. The amber sentence is
    // the answer they actually need.
    expect(screen.queryByRole("link", { name: "Create a wiki" })).toBeNull();
    expect(screen.getByText(WORKSPACE_PURPOSE_READ_ONLY_COPY)).toBeTruthy();
    // Still stated, just not as an invitation.
    expect(screen.getByText(/Create a wiki first/)).toBeTruthy();
  });
});

describe("the feedback banner announces itself", () => {
  it("is a polite status for a confirmation and an alert for a refusal", async () => {
    render(<WorkspacePurposeSettings />);
    await waitFor(() => expect(formFieldset().disabled).toBe(false));

    fetchMock.mockResolvedValueOnce(
      answer({ profile: PROFILE, wiki: WIKI, version: VERSION }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toContain(
        "Workspace Purpose saved",
      ),
    );

    fetchMock.mockResolvedValueOnce(
      answer({ error: WRITE_CONFLICT_COPY }, { ok: false, status: 412 }),
    );
    fireEvent.submit(saveButton().closest("form")!);
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        WRITE_CONFLICT_COPY,
      ),
    );
    expect(screen.queryByRole("status")).toBeNull();
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

    // The gate the fieldset still carries is `loading || saving` — and neither
    // holds here, so nothing on this form reports `disabled`.
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
