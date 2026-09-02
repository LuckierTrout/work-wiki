import { beforeEach, describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_LOADING_COPY,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_BAR_COPY,
  SETTINGS_SAVE_COPY,
  SETTINGS_MODEL_INHERIT_COPY,
  SETTINGS_SAVING_NOTE_COPY,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  SETTINGS_API_ENABLE_LABEL,
  SETTINGS_API_UNAUTH_LABEL,
  SETTINGS_API_TOKEN_COPY_COPY,
  SETTINGS_API_TOKEN_GENERATE_COPY,
} from "@/lib/workbench-api-mcp-settings";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import {
  announcedFor,
  installSettingsFetchMock,
  settingsPayload,
} from "./settings-harness";

/**
 * The save window, MOUNTED (DW-67/DW-626).
 *
 * `save` captures `draftRef.current` on entry and then awaits up to TWO
 * `REQUEST_TIMEOUT_MS` requests — the DW-555 recovery read, then the PUT — after
 * which a landed save re-seeds the whole draft from the answered payload. So
 * anything typed between the click and the answer is neither sent nor kept, and
 * before this nothing on the surface said so: every field keyed its refusal off
 * `readOnly`/`envPinned` alone, so the form went on accepting keystrokes it was
 * about to drop.
 *
 * `workbench-settings.test.ts` scans the source for the predicate's spelling and
 * its counts, which is the right tool for "did every control get wired" and the
 * wrong one for the claim the fix actually makes: that an owner typing into a
 * saving form loses nothing silently. That is a claim about a WINDOW — a state
 * that exists only between two awaits — and only a mounted surface driving a
 * real, held PUT can be inside it.
 */

const fetchMock = installSettingsFetchMock();

/** The write precondition this file's reads carry, in the store's own shape. */
const SEEDED = "s1:11111111111111112222222222222222";

function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload({ version: SEEDED, ...overrides });
}

/** What `GET`/`PUT /api/settings` answers on success. */
function served(stored: WorkbenchSettingsPayload) {
  return { ok: true, status: 200, json: async () => ({ workbench: stored }) } as Response;
}

/** What the route answers when it refuses the patch. */
function refused(message: string) {
  return { ok: false, status: 400, json: async () => ({ error: message }) } as Response;
}

/**
 * A promise the test releases by hand.
 *
 * The in-flight state is otherwise not observable: a mock that resolves on its
 * own settles inside the same tick as the click, so "the form is inert" would be
 * true or false depending on microtask ordering. Holding the answer makes the
 * window a place the assertions can stand in.
 */
function gate(): { held: Promise<void>; release: () => void } {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { held, release };
}

/**
 * Route by URL, and answer `/api/settings` from a per-call queue.
 *
 * The API + MCP category probes the loopback door from its own effect, so URL
 * routing is what keeps those three calls out of the settings queue — the same
 * shape `settings-api-mcp-pane.test.tsx` uses, for the same reason.
 */
function installRoutes(answers: Array<() => unknown | Promise<unknown>>): void {
  let call = 0;
  fetchMock.mockImplementation(async (url: string) => {
    const target = String(url);
    if (target.includes("/api/v1/loopback-settings")) {
      return { ok: true, status: 200, json: async () => ({ token: null }) } as Response;
    }
    // No sidecar: the probe swallows this itself, and this file is not about it.
    if (target.includes("/api/v1/")) throw new TypeError("Failed to fetch");
    const answer = answers[Math.min(call, answers.length - 1)];
    call += 1;
    return (await answer()) as Response;
  });
}

/** Every `/api/settings` call so far, mount read included. */
function settingsCalls(): Array<[string, RequestInit | undefined]> {
  return fetchMock.mock.calls.filter(([url]) =>
    String(url).includes("/api/settings"),
  ) as Array<[string, RequestInit | undefined]>;
}

/** The `workbench` patch of the nth `/api/settings` call. */
function patchOf(call: number): Record<string, unknown> {
  const [, init] = settingsCalls()[call];
  return (JSON.parse(String(init?.body)) as { workbench: Record<string, unknown> })
    .workbench;
}

async function mount(
  category: "llm-models" | "embeddings" | "api-mcp",
  answers: Array<() => unknown | Promise<unknown>>,
) {
  installRoutes(answers);
  render(<SettingsCanvas category={category} headingId="wb-set-heading" />);
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
}

const chatModel = () => screen.getByLabelText("Chat model") as HTMLInputElement;
const chatProvider = () => screen.getByLabelText("Chat provider") as HTMLSelectElement;
const customKey = () => screen.getByLabelText("Custom API key") as HTMLInputElement;
const removeButton = () => screen.getByRole("button", { name: "Remove" });
const saveButton = () => screen.getByRole("button", { name: SETTINGS_SAVE_COPY });
const barNote = () => screen.getByText(SETTINGS_SAVING_NOTE_COPY);

beforeEach(() => {
  // The door token is cached module-wide by `loopback-client`, so the API + MCP
  // case would otherwise run against whatever a previous test left there.
  clearLoopbackDoorToken();
});

describe("the Settings form is inert while a save is in flight (DW-67/DW-626)", () => {
  it("freezes every editable control from the click until the PUT settles", async () => {
    const put = gate();
    await mount("llm-models", [
      () => served(payload({ hasCustomApiKey: true })),
      async () => {
        await put.held;
        return served(payload({ chatModel: "gpt-4o-mini", hasCustomApiKey: true }));
      },
    ]);

    // One edit, so Save is reachable at all.
    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(saveButton());

    // TEXT boxes go `readOnly` — never `disabled`, so the value stays reachable
    // and readable while the request is out.
    expect(chatModel().readOnly).toBe(true);
    expect(customKey().readOnly).toBe(true);
    // SELECTS and `.wb-set-action` buttons carry `aria-disabled`, which keeps
    // them in the tab order so the sentence below can actually be heard.
    expect(chatProvider().getAttribute("aria-disabled")).toBe("true");
    expect(removeButton().getAttribute("aria-disabled")).toBe("true");
    // …and none of them is natively disabled, which would take it out of the
    // tab order and take the announcement with it.
    expect(chatProvider().hasAttribute("disabled")).toBe(false);
    expect(removeButton().hasAttribute("disabled")).toBe(false);

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
  });

  it("stays inert through the DW-555 recovery read on a versionless payload", async () => {
    // The window the freeze is most easily got wrong: `setSaving(true)` runs
    // before the recovery read, so a predicate keyed on anything narrower than
    // `saving` would leave this leg — a whole `REQUEST_TIMEOUT_MS` of it — open.
    const recovery = gate();
    const put = gate();
    await mount("llm-models", [
      () => served(payload({ version: undefined })),
      async () => {
        await recovery.held;
        return served(payload({ version: "s1:33333333333333334444444444444444" }));
      },
      async () => {
        await put.held;
        return served(payload({ chatModel: "gpt-4o-mini" }));
      },
    ]);

    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(saveButton());

    // The recovery read is OUT and the PUT has not been made — this is the leg
    // under test, not the PUT's.
    await waitFor(() => expect(settingsCalls()).toHaveLength(2));
    expect(settingsCalls()[1][1]?.method).toBeUndefined();
    expect(chatModel().readOnly).toBe(true);
    expect(chatProvider().getAttribute("aria-disabled")).toBe("true");
    expect(barNote().textContent).toBe(SETTINGS_SAVING_NOTE_COPY);

    recovery.release();
    await waitFor(() => expect(settingsCalls()).toHaveLength(3));
    // Still inert across the hand-off — the freeze is one window, not two.
    expect(chatModel().readOnly).toBe(true);

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    // TWO calls for that save and no more: the recovery read and the PUT. A
    // third would be a re-seed that threw away the owner's unsaved edits.
    expect(settingsCalls()).toHaveLength(3);
  });

  it("commits nothing typed during the window, and sends none of it", async () => {
    const put = gate();
    await mount("llm-models", [
      () => served(payload({ hasCustomApiKey: true })),
      async () => {
        await put.held;
        return served(payload({ chatModel: "gpt-4o-mini", hasCustomApiKey: true }));
      },
    ]);

    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(saveButton());

    // jsdom does not stop a programmatic change event at a `readOnly` box or an
    // `aria-disabled` select, which is exactly why every handler guards as well
    // as every attribute. Without the guard these three would all commit.
    fireEvent.change(chatModel(), { target: { value: "typed-during-the-save" } });
    fireEvent.change(chatProvider(), { target: { value: "google" } });
    fireEvent.change(customKey(), { target: { value: "sk-typed-during-the-save" } });
    fireEvent.click(removeButton());

    expect(chatModel().value).toBe("gpt-4o-mini");
    expect(chatProvider().value).toBe("openai");
    expect(customKey().value).toBe("");

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());

    // …and none of it reached the wire. The body was built from the draft as it
    // stood at the click, which is the whole reason the freeze exists.
    const sent = patchOf(1);
    expect(sent.chatModel).toBe("gpt-4o-mini");
    expect(sent.chatProvider).toBe("openai");
    // An untouched secret is omitted entirely — a `Remove` the freeze refused
    // must not arrive as a deletion.
    expect(sent).not.toHaveProperty("customApiKey");
  });

  it("announces WHY, on the control the owner is standing on", async () => {
    const put = gate();
    await mount("llm-models", [
      () => served(payload({ hasCustomApiKey: true })),
      async () => {
        await put.held;
        return served(payload({ chatModel: "gpt-4o-mini", hasCustomApiKey: true }));
      },
    ]);

    // Before the click the bar says the standing promise, and a hintless box and
    // the `Remove` button both have nothing to announce at all.
    expect(screen.getByText(SETTINGS_SAVE_BAR_COPY)).toBeTruthy();
    expect(chatModel().getAttribute("aria-describedby")).toBeNull();
    expect(removeButton().getAttribute("aria-describedby")).toBeNull();

    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(saveButton());

    // The hintless text row: the in-flight sentence is the WHOLE description,
    // because there is nothing to append it to.
    expect(announcedFor(chatModel())).toBe(SETTINGS_SAVING_NOTE_COPY);
    // The provider picker: its own hint FIRST, then the reason it refuses —
    // `aria-describedby` is a list, so the freeze appends rather than replaces.
    const announced = announcedFor(chatProvider());
    expect(announced).toContain(SETTINGS_MODEL_INHERIT_COPY);
    expect(announced).toContain(SETTINGS_SAVING_NOTE_COPY);
    // The `Remove` button: the refusal and NOTHING else. It has no description
    // of its own and must not borrow the box's — "A key is stored." belongs to
    // the field beside it, and repeating it here would read the same sentence
    // twice for one row.
    expect(announcedFor(removeButton())).toBe(SETTINGS_SAVING_NOTE_COPY);
    // Not the standing promise, and not the read-only sentence: this deployment
    // is writable, it is merely busy.
    expect(screen.queryByText(SETTINGS_SAVE_BAR_COPY)).toBeNull();

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(screen.getByText(SETTINGS_SAVE_BAR_COPY)).toBeTruthy();
    expect(removeButton().getAttribute("aria-describedby")).toBeNull();
  });

  it("hands the whole form back when the save LANDS", async () => {
    const put = gate();
    await mount("llm-models", [
      () => served(payload({ hasCustomApiKey: true })),
      async () => {
        await put.held;
        return served(payload({ chatModel: "gpt-4o-mini", hasCustomApiKey: true }));
      },
    ]);

    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.click(saveButton());
    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());

    // NO `aria-disabled` at all, not `aria-disabled="false"`: the stylesheet's
    // refused face keys off the attribute's presence, so a stray one would leave
    // the surface dimmed after every save.
    expect(chatProvider().hasAttribute("aria-disabled")).toBe(false);
    expect(removeButton().hasAttribute("aria-disabled")).toBe(false);
    expect(chatModel().readOnly).toBe(false);
    expect(customKey().readOnly).toBe(false);
    expect(chatModel().getAttribute("aria-describedby")).toBeNull();

    // …and the draft is re-seeded from the ANSWERED payload, so it takes edits
    // again rather than merely looking as though it would.
    fireEvent.change(chatModel(), { target: { value: "gpt-4.1" } });
    expect(chatModel().value).toBe("gpt-4.1");
  });

  it("hands the whole form back when the save is REFUSED, with every edit still on screen", async () => {
    const REFUSAL = "Settings could not be saved: the model id is not recognised.";
    const put = gate();
    await mount("llm-models", [
      () => served(payload()),
      async () => {
        await put.held;
        return refused(REFUSAL);
      },
    ]);

    fireEvent.change(chatModel(), { target: { value: "gpt-4o-mini" } });
    fireEvent.change(chatProvider(), { target: { value: "google" } });
    fireEvent.click(saveButton());
    put.release();
    await waitFor(() => expect(screen.getByText(REFUSAL)).toBeTruthy());

    // A refused save must never be the thing that loses an edit — and it must
    // not be the thing that leaves the form frozen either.
    expect(chatModel().value).toBe("gpt-4o-mini");
    expect(chatProvider().value).toBe("google");
    expect(chatModel().readOnly).toBe(false);
    expect(chatProvider().hasAttribute("aria-disabled")).toBe(false);
    expect(screen.getByText(SETTINGS_SAVE_BAR_COPY)).toBeTruthy();

    fireEvent.change(chatModel(), { target: { value: "gpt-4.1" } });
    expect(chatModel().value).toBe("gpt-4.1");
  });

  it("freezes the two COMPOUND predicates, which no other mounted case reaches", async () => {
    // `vectorRefused` and the two `editRefused || envPinned` selects are the
    // only refusals on this surface that are not the plain `editRefused ||
    // undefined` shape, and until this case they were pinned by source text
    // alone — reverting `vectorRefused` to its read-only half passed every
    // mounted test in the repository. Intake's keep-parsed checkbox and
    // MinerU's two controls ARE that plain shape, already covered by the chat
    // provider picker above, so they are deliberately not repeated here.
    //
    // The legs are all MET on purpose: with any of them missing the switch is
    // refused for its own reason and the freeze would be invisible behind it.
    const stored = payload({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      hasEmbeddingApiKey: true,
    });
    const put = gate();
    await mount("embeddings", [
      () => served(stored),
      async () => {
        await put.held;
        return served({ ...stored, embeddingBaseUrl: "https://o/v2" });
      },
    ]);

    const vectorSwitch = () =>
      screen.getByLabelText("Enable vector search") as HTMLInputElement;
    const providerSelect = () =>
      screen.getByLabelText("Embedding provider") as HTMLSelectElement;
    const endpoint = () => screen.getByLabelText("Embedding endpoint") as HTMLInputElement;

    // Interactive BEFORE the click, so what follows is the freeze and not the
    // gate. The dirtying edit is the endpoint, which leaves both controls under
    // test exactly where the store put them.
    expect(vectorSwitch().hasAttribute("aria-disabled")).toBe(false);
    expect(providerSelect().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.change(endpoint(), { target: { value: "https://o/v2" } });
    fireEvent.click(saveButton());

    expect(vectorSwitch().getAttribute("aria-disabled")).toBe("true");
    expect(providerSelect().getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(vectorSwitch())).toContain(SETTINGS_SAVING_NOTE_COPY);
    expect(announcedFor(providerSelect())).toContain(SETTINGS_SAVING_NOTE_COPY);

    // …and both commit nothing. The switch is the interesting one: turning it
    // OFF is always allowed by `vectorRefused`'s own terms, so only the freeze
    // can be what refuses this.
    fireEvent.click(vectorSwitch());
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(vectorSwitch().checked).toBe(false);
    expect(providerSelect().value).toBe("openai");

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(vectorSwitch().hasAttribute("aria-disabled")).toBe(false);
    expect(providerSelect().hasAttribute("aria-disabled")).toBe(false);
    fireEvent.click(vectorSwitch());
    expect(vectorSwitch().checked).toBe(true);
  });

  it("freezes the API + MCP pane on the same term, not a second one", async () => {
    // The pane owns no draft and no save: its controls edit the canvas's draft
    // and ride the canvas's one PUT, so an edit here during the window is
    // dropped exactly as it is anywhere else. It takes the canvas's refusal as a
    // prop precisely so it cannot disagree with the sentence it announces.
    const put = gate();
    await mount("api-mcp", [
      () => served(payload({ apiEnabled: true })),
      async () => {
        await put.held;
        return served(payload({ apiEnabled: true, allowUnauthenticated: true }));
      },
    ]);

    const apiSwitch = () =>
      screen.getByLabelText(SETTINGS_API_ENABLE_LABEL) as HTMLInputElement;
    const unauthSwitch = () =>
      screen.getByLabelText(SETTINGS_API_UNAUTH_LABEL) as HTMLInputElement;
    const generate = () =>
      screen.getByRole("button", { name: SETTINGS_API_TOKEN_GENERATE_COPY });

    // The dirtying edit is the UNAUTHENTICATED switch rather than the door
    // itself: shutting the door unmounts the whole block below it, taking the
    // Generate button — one of the three controls under test — off screen.
    fireEvent.click(unauthSwitch());
    expect(unauthSwitch().checked).toBe(true);
    fireEvent.click(saveButton());

    expect(apiSwitch().getAttribute("aria-disabled")).toBe("true");
    expect(unauthSwitch().getAttribute("aria-disabled")).toBe("true");
    expect(generate().getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(apiSwitch())).toContain(SETTINGS_SAVING_NOTE_COPY);
    expect(announcedFor(unauthSwitch())).toContain(SETTINGS_SAVING_NOTE_COPY);
    expect(announcedFor(generate())).toContain(SETTINGS_SAVING_NOTE_COPY);

    // Neither switch commits, and neither does the Generate button — a token
    // minted here would be shown once and then discarded by the re-seed, which
    // is the one promise this pane's copy makes about it.
    fireEvent.click(apiSwitch());
    fireEvent.click(unauthSwitch());
    fireEvent.click(generate());
    expect(apiSwitch().checked).toBe(true);
    expect(unauthSwitch().checked).toBe(true);
    expect(screen.queryByRole("button", { name: SETTINGS_API_TOKEN_COPY_COPY })).toBeNull();

    put.release();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(apiSwitch().hasAttribute("aria-disabled")).toBe(false);
    expect(generate().hasAttribute("aria-disabled")).toBe(false);
    // …and the pane takes edits again, rather than merely looking as though it
    // would: it is the canvas's `saving` that lifted, not a state of its own.
    fireEvent.click(apiSwitch());
    expect(apiSwitch().checked).toBe(false);
  });
});
