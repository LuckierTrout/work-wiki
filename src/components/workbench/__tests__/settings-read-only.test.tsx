import { describe, expect, it } from "vitest";
import { cleanup, render, screen, waitFor, fireEvent } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_REMOVE_COPY,
  SETTINGS_KEY_REMOVE_PENDING_COPY,
  SETTINGS_KEY_STORED_COPY,
  SETTINGS_KEY_UNDO_COPY,
  SETTINGS_MODEL_INHERIT_COPY,
  SETTINGS_LOADING_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_COPY,
  SETTINGS_SAVE_FAILED_COPY,
  SETTINGS_TIMEOUT_HINT_COPY,
  settingsEnvKeyCopy,
  settingsEnvOverrideCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import { embeddingProviderLabel } from "@/lib/providers";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
} from "@/lib/write-precondition";
import {
  announcedFor,
  installSettingsFetchMock,
  mountSettings,
  settingsPayload,
} from "./settings-harness";

/**
 * The Settings controls a read-only deployment refuses, MOUNTED (DW-37, DW-65).
 *
 * `workbench-settings.test.ts` reads this component's source, which is the right
 * tool for "is `disabled` gone" and the wrong one for the claim that actually
 * matters: that a keyboard user on a read-only deployment can still REACH the
 * provider pickers and READ what this deployment is running on. `disabled` takes
 * a control out of the tab order, and no source scan can observe a tab order —
 * so the two assertions below are made against the rendered DOM: focus lands,
 * and an activation changes nothing while the control still shows the stored
 * value.
 */

/**
 * The stored settings this file asserts against: the shared fixture, plus the
 * two facts that make it a READ-ONLY deployment carrying a stored key.
 *
 * `readOnly` is what every case here is about. `hasEmbeddingApiKey` is on so the
 * Embedding key row has a STORED key to refuse to remove — with the shared
 * base's `false` the row would show the absent state and there would be nothing
 * for read-only to protect.
 */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload({ hasEmbeddingApiKey: true, readOnly: true, ...overrides });
}

const fetchMock = installSettingsFetchMock();

/**
 * Mount one category and let the single on-mount read settle.
 *
 * `external-sources` is here for the THIRD key row (DW-307): Custom lives under
 * `llm-models` and Embedding under `embeddings`, so Firecrawl is the only one of
 * the three that no category already reached.
 */
function mount(
  category: "llm-models" | "embeddings" | "external-sources",
  stored: WorkbenchSettingsPayload,
) {
  return mountSettings(category, stored);
}

describe("a read-only deployment (DW-37, DW-65)", () => {
  it("keeps the provider pickers focusable and reporting what is stored", async () => {
    await mount("llm-models", payload());
    for (const [label, value] of [
      ["Chat provider", "openai"],
      ["Ingest provider", "anthropic"],
    ] as const) {
      const select = screen.getByLabelText(label) as HTMLSelectElement;
      // `disabled` is the bug: it takes the control out of the tab order, so the
      // owner cannot reach it and cannot read which provider is configured.
      expect(select.disabled).toBe(false);
      expect(select.hasAttribute("disabled")).toBe(false);
      expect(select.getAttribute("aria-disabled")).toBe("true");
      select.focus();
      expect(document.activeElement).toBe(select);
      expect(select.value).toBe(value);
    }
  });

  it("announces WHY each refused control refuses, without losing its own hint", async () => {
    // `aria-disabled` on its own announces "dimmed" and nothing more, and
    // `SETTINGS_READ_ONLY_COPY` used to sit unassociated in the save bar — so a
    // keyboard user reached a picker that would not move and was told nothing
    // about the deployment. The sentence is APPENDED to each control's own hint
    // rather than replacing it: the hint still explains what the field means.
    await mount("llm-models", payload());
    for (const label of ["Chat provider", "Ingest provider"] as const) {
      const select = screen.getByLabelText(label);
      const announced = announcedFor(select);
      expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
      expect(announced).toContain(SETTINGS_MODEL_INHERIT_COPY);
    }
  });

  it("appends the sentence to a TEXT row that has a hint of its own (DW-280)", async () => {
    // `textRow` hardcoded `aria-describedby={hint ? hintId : undefined}`, so
    // none of the seven text rows ever announced the refusal the two provider
    // pickers and the vector switch already carried. A keyboard user reached a
    // box that would not accept a keystroke and was told only what the field
    // means.
    await mount("llm-models", payload());
    const timeout = screen.getByLabelText("LLM timeout (seconds)") as HTMLInputElement;
    expect(timeout.readOnly).toBe(true);
    const announced = announcedFor(timeout);
    // The hint is KEPT, not replaced: the accepted range is still the only place
    // the bounds are stated at all.
    expect(announced).toContain(SETTINGS_TIMEOUT_HINT_COPY);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("makes the sentence the WHOLE description of a hintless text row (DW-280)", async () => {
    // The rows the old ternary dropped entirely: with no hint there was nothing
    // to append to, so the attribute was omitted and the refusal went unsaid.
    // `describedBy` answers for them too.
    await mount("llm-models", payload());
    const chatModel = screen.getByLabelText("Chat model") as HTMLInputElement;
    expect(chatModel.readOnly).toBe(true);
    expect(announcedFor(chatModel)).toBe(SETTINGS_READ_ONLY_COPY);
  });

  it("leaves a hintless text row with NO description on a writable deployment", async () => {
    // The other half of the same rule: `undefined` in and nothing refused gives
    // `undefined` back, so a box with nothing to say still emits no attribute
    // rather than pointing at the save bar's ordinary standing sentence.
    await mount("llm-models", payload({ readOnly: false }));
    expect(
      screen.getByLabelText("Chat model").getAttribute("aria-describedby"),
    ).toBeNull();
    // …while a hinted row still carries its own hint alone.
    const announced = announcedFor(screen.getByLabelText("LLM timeout (seconds)"));
    expect(announced).toBe(SETTINGS_TIMEOUT_HINT_COPY);
  });

  it("keeps the description to the control's own hint on a writable deployment", async () => {
    await mount("llm-models", payload({ readOnly: false }));
    const announced = announcedFor(screen.getByLabelText("Chat provider"));
    expect(announced).toContain(SETTINGS_MODEL_INHERIT_COPY);
    // The save bar is showing the ordinary standing sentence here, and pointing
    // a control at it would announce "unsaved edits do not apply" as though it
    // were a constraint on the picker.
    expect(announced).not.toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("appends the sentence to a KEY row that has no stored key (DW-307)", async () => {
    // The row DW-280 left behind, on the reasoning that a `readOnly` box has no
    // refusal to announce. `readOnly` is a property of the BOX and says nothing
    // about the deployment, and this row's only other affordance — Remove — is
    // taken off the page under `stored.readOnly` rather than refused in place.
    // What was perceived here was a box that would not take a keystroke, next to
    // a button that had vanished, described only as "No key is stored."
    await mount("llm-models", payload({ hasCustomApiKey: false }));
    const key = screen.getByLabelText("Custom API key") as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    // Still focusable: `readOnly` keeps a box in the tab order, which is the
    // only reason its description is ever announced at all.
    key.focus();
    expect(document.activeElement).toBe(key);
    const announced = announcedFor(key);
    // The hint is KEPT, not replaced — for a field that renders nothing, "No key
    // is stored." is the only thing distinguishing it from a filled one.
    expect(announced).toContain(SETTINGS_KEY_ABSENT_COPY);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });

  it("keeps the env-key hint beside BOTH sentences on a stored key (DW-307)", async () => {
    // Three things in one description, in the row's own order: what the box
    // holds, what the environment already supplies for the SELECTED provider,
    // and why nothing here can be changed.
    await mount(
      "embeddings",
      payload({ hasEmbeddingApiKey: true, envEmbeddingApiKeyProviders: ["openai"] }),
    );
    const key = screen.getByLabelText("Embedding API key") as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    // Read out WHOLE rather than as three independent `toContain`s, which would
    // pass on any permutation — and the order is the claim: the row's own hint
    // first, the deployment-wide sentence appended last.
    expect(announcedFor(key)).toBe(
      `${SETTINGS_KEY_STORED_COPY} ${settingsEnvKeyCopy(embeddingProviderLabel("openai"))} ${SETTINGS_READ_ONLY_COPY}`,
    );
    // A key IS stored, so the only thing keeping Remove off the page is the
    // read-only deployment — the vanished affordance the sentence stands in for.
    expect(screen.queryByRole("button", { name: SETTINGS_KEY_REMOVE_COPY })).toBeNull();
  });

  it("answers for the THIRD key row too, on its own category (DW-307)", async () => {
    // Firecrawl is the one of the three that no other case here reaches, and it
    // is the plainest of them: no env-key hint, no vector rule, nothing but the
    // row's own state and the deployment's. `secretRow` is one builder, so this
    // is the pin that the fix landed on the BUILDER rather than on two of its
    // three call sites.
    await mount("external-sources", payload({ hasFirecrawlApiKey: false }));
    const key = screen.getByLabelText("Firecrawl API key") as HTMLInputElement;
    expect(key.readOnly).toBe(true);
    expect(announcedFor(key)).toBe(
      `${SETTINGS_KEY_ABSENT_COPY} ${SETTINGS_READ_ONLY_COPY}`,
    );
    // …and with a key stored, the same append beside the other hint, with the
    // Remove button off the page.
    cleanup();
    await mount("external-sources", payload({ hasFirecrawlApiKey: true }));
    expect(announcedFor(screen.getByLabelText("Firecrawl API key"))).toBe(
      `${SETTINGS_KEY_STORED_COPY} ${SETTINGS_READ_ONLY_COPY}`,
    );
    expect(screen.queryByRole("button", { name: SETTINGS_KEY_REMOVE_COPY })).toBeNull();
  });

  it("leaves a KEY row announcing its hint alone on a writable deployment", async () => {
    // The other half: nothing refused, so nothing appended, and the affordance
    // the read-only sentence stands in for is back on the page.
    await mount("embeddings", payload({ readOnly: false, hasEmbeddingApiKey: true }));
    const key = screen.getByLabelText("Embedding API key") as HTMLInputElement;
    expect(key.readOnly).toBe(false);
    const announced = announcedFor(key);
    expect(announced).toBe(SETTINGS_KEY_STORED_COPY);
    expect(announced).not.toContain(SETTINGS_READ_ONLY_COPY);
    expect(screen.getByRole("button", { name: SETTINGS_KEY_REMOVE_COPY })).toBeTruthy();
  });

  it("says only the removal sentence while a removal is pending", async () => {
    // The third hint state, and the one place `readOnly` on this box means
    // something other than the deployment: a key queued for deletion takes no
    // keystrokes, on a deployment that refuses nothing. Unchanged by DW-307.
    await mount("embeddings", payload({ readOnly: false, hasEmbeddingApiKey: true }));
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_KEY_REMOVE_COPY }));
    const key = screen.getByLabelText("Embedding API key") as HTMLInputElement;
    await waitFor(() => expect(key.readOnly).toBe(true));
    expect(announcedFor(key)).toBe(SETTINGS_KEY_REMOVE_PENDING_COPY);
    expect(screen.getByRole("button", { name: SETTINGS_KEY_UNDO_COPY })).toBeTruthy();
  });

  it("refuses a provider change and puts the picker back", async () => {
    await mount("llm-models", payload());
    const select = screen.getByLabelText("Chat provider") as HTMLSelectElement;

    fireEvent.change(select, { target: { value: "google" } });

    // The claim worth pinning: the picker still reports what is STORED. The
    // handler commits nothing and React re-applies the controlled value, so it
    // never sits on a provider the draft never took — which would make the next
    // save of some other field read as though the owner had chosen it.
    await waitFor(() => expect(select.value).toBe("openai"));
    // The read is the only request this surface has made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("keeps the vector switch focusable, described, and unchanged by a click", async () => {
    await mount("embeddings", payload());
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);
    // The reason is wired as the control's own description, which only a
    // focusable control can ever have announced — and the announced text has to
    // NAME the refusal, not merely be non-empty. `aria-describedby` is a
    // space-separated list, so every id is resolved and joined the way a screen
    // reader would read them.
    expect(announcedFor(checkbox)).toContain(SETTINGS_READ_ONLY_COPY);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses the vector switch on the OTHER half of its predicate too", async () => {
    // Not read-only — the provider simply cannot support vector search yet. Same
    // convention, because the same argument applies: the hint that names the
    // missing legs is this control's `aria-describedby`, and a `disabled`
    // control is never focused, so that description was never announced.
    await mount(
      "embeddings",
      payload({ readOnly: false, embeddingProvider: null, embeddingModel: null }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.hasAttribute("disabled")).toBe(false);
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    checkbox.focus();
    expect(document.activeElement).toBe(checkbox);

    fireEvent.click(checkbox);

    await waitFor(() => expect(checkbox.checked).toBe(false));
  });

  it("qualifies the SWITCHED-ON sentence on a deployment that refuses everything", async () => {
    // The composition of the two things this change adds, and the one place they
    // could contradict each other: the switch is on with a leg unmet, so the
    // hint names turning it off as the available action — on a deployment where
    // nothing can be turned off at all. The read-only sentence is what makes
    // that honest, and it only rides here because the switch routes its
    // description through `describedBy`. Without the pin, the two features are
    // correct apart and misleading together.
    await mount(
      "embeddings",
      // `openai` with a stored key and NO endpoint: exactly one unmet leg, so
      // the sentence below stays about the composition rather than the legs.
      payload({ vectorSearchEnabled: true, embeddingBaseUrl: null }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    const announced = announcedFor(checkbox);
    expect(announced).toContain(
      "Vector search is switched on, but it needs an endpoint before it can run. Turn it off, or supply what is missing.",
    );
    // …and the sentence that says the offered action is not available here.
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
    // The old wording is the regression: "before it can be turned on" beside a
    // box that is visibly ticked.
    expect(announced).not.toContain("before it can be turned on");

    // Read-only wins over the always-allow-turning-off rule, so the click
    // commits nothing and the box stays where the store put it.
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("leaves every control interactive on a writable deployment", async () => {
    await mount("embeddings", payload({ readOnly: false, vectorSearchEnabled: true }));
    const select = screen.getByLabelText("Embedding provider") as HTMLSelectElement;
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // No stray `aria-disabled="false"`: the stylesheet's refused face keys off
    // the attribute's presence, so a writable deployment must not carry it.
    expect(select.hasAttribute("aria-disabled")).toBe(false);
    expect(checkbox.hasAttribute("aria-disabled")).toBe(false);

    fireEvent.change(select, { target: { value: "ollama" } });
    await waitFor(() => expect(select.value).toBe("ollama"));

    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
  });
});

// ---------------------------------------------------------------------------
// The write precondition on the Settings canvas (DW-63)
// ---------------------------------------------------------------------------
//
// DW-63 is specifically about TWO surfaces writing one `AppConfig`, and the
// only thing standing between them is one header built from a field of the
// payload the draft was seeded from. `workbench-settings.test.ts` executes
// `saveWorkbenchSettings` with a stubbed fetch and scans this component's
// source; neither can see the seam between the two — that the version the
// canvas SENDS is the one the read it is showing came with, and that a landed
// save re-seeds it so the next one is not refused as a conflict with itself.

describe("the Settings canvas sends the version it was seeded with (DW-63)", () => {
  const SEEDED = "s1:11111111111111112222222222222222";
  const LANDED = "s1:33333333333333334444444444444444";

  /** Mount writable, with one response per call rather than one for all. */
  async function mountWritable(responses: Array<() => unknown>) {
    let call = 0;
    fetchMock.mockImplementation(async () => {
      const next = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return next() as Response;
    });
    render(<SettingsCanvas category="llm-models" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  }

  function read(version: string) {
    return () => ({
      ok: true,
      status: 200,
      json: async () => ({ workbench: payload({ readOnly: false, version }) }),
    });
  }

  function saved(version: string) {
    return () => ({
      ok: true,
      status: 200,
      json: async () => ({
        saved: true,
        version,
        workbench: payload({ readOnly: false, version, chatModel: "gpt-4.1" }),
      }),
    });
  }

  function typeChatModel(value: string) {
    fireEvent.change(screen.getByLabelText("Chat model"), { target: { value } });
  }

  function ifMatchOf(call: number): string | undefined {
    const [, init] = fetchMock.mock.calls[call] as [string, RequestInit];
    return ((init.headers ?? {}) as Record<string, string>)["If-Match"];
  }

  it("puts the seeded payload's version on the save, and adopts the answered one", async () => {
    await mountWritable([read(SEEDED), saved(LANDED), saved(LANDED)]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());

    // Call 0 is the read; call 1 is the save.
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, put] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(put.method).toBe("PUT");
    expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

    // A second edit and save WITHOUT a reload rides the version the first save
    // answered — the existing `setPayload(result.payload)` re-seed is what
    // carries it, and this is the only place that can observe it.
    typeChatModel("gpt-4.1-mini");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(ifMatchOf(2)).toBe(`"${LANDED}"`);
  });

  it("CLEARS the version when a landed save answers without one (DW-199)", async () => {
    // The convention `PreviewColumn` already spells for this seam: what the
    // surface knows after a versionless 200 is "the current version is
    // unknown". Sending nothing gets the 428, which claims only that the save
    // could not be checked — true. Re-sending the version this very save
    // superseded can only ever be refused, and refused with the 412: a flat
    // statement that the save was not applied, blamed on a change made
    // somewhere else, when the change is this owner's own save one moment
    // earlier. Neither can clobber, so the tie goes to the honest refusal.
    const versionless = () => ({
      ok: true,
      status: 200,
      json: async () => ({
        saved: true,
        workbench: (() => {
          const { version: _dropped, ...rest } = payload({
            readOnly: false,
            chatModel: "gpt-4.1",
          });
          return rest;
        })(),
      }),
    });
    await mountWritable([
      read(SEEDED),
      versionless,
      () => ({
        ok: false,
        status: 428,
        json: async () => ({ error: WRITE_PRECONDITION_REQUIRED_COPY }),
      }),
    ]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
    expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

    // The NEXT save carries no `If-Match` at all…
    typeChatModel("gpt-4.1-mini");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(ifMatchOf(2)).toBeUndefined();

    // …and is refused with the 428 sentence, with every edit still on screen.
    await waitFor(() =>
      expect(screen.getByText(WRITE_PRECONDITION_REQUIRED_COPY)).toBeTruthy(),
    );
    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe(
      "gpt-4.1-mini",
    );
  });

  it("still RENDERS a load that carries no version at all", async () => {
    // A payload without one is accepted rather than turned into an
    // indistinguishable load failure that takes the whole canvas off screen.
    const { version: _dropped, ...withoutVersion } = payload({ readOnly: false });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ workbench: withoutVersion }),
    } as unknown as Response);
    render(<SettingsCanvas category="llm-models" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());

    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe("gpt-4o");
    // …and a save from it carries NO `If-Match`, which the route answers 428
    // with the draft still on screen — never an unconditional write.
    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(ifMatchOf(1)).toBeUndefined();
  });

  /**
   * DW-376: the save whose OUTCOME NOBODY KNOWS, on this surface.
   *
   * `workbench-settings.test.ts` executes the client and asserts the returned
   * shape. What it cannot see is the seam this describe exists for: that the
   * canvas ACTS on `unconfirmed` by clearing the version it is holding, and
   * that the next save therefore carries no `If-Match`. That reconciliation is
   * the whole of this surface's response — there is no re-read here that does
   * not throw away every unsaved edit — so it has to be executed.
   *
   * The 2xx BODY READ has two sides, and they part company here (DW-408,
   * DW-427). A body read that DIES mid-stream is unconfirmed and gets the
   * unknown-outcome sentence, so it belongs in this table and is a row in it. A
   * 2xx whose body simply yields no payload is `unreadable` instead: the status
   * line arrived, so that sentence would be a lie — but the held version is
   * just as untrustworthy, which is why the two end at the same reconciliation.
   * That half is deliberately NOT a row here, because the sentence assertions
   * below would be wrong for it; it gets its own table immediately after.
   */
  const UNCONFIRMED: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "a gateway that gave up",
      () => ({
        ok: false,
        status: 504,
        // A proxy's page, which is NOT the route's verdict and is not relayed.
        json: async () => ({ error: "<html>Gateway Timeout</html>" }),
      }),
    ],
    [
      "a dropped connection",
      () => {
        throw new TypeError("Failed to fetch");
      },
    ],
    [
      "a 200 whose body read died mid-stream",
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new TypeError("Failed to fetch");
        },
      }),
    ],
  ];

  for (const [label, unconfirmed] of UNCONFIRMED) {
    it(`keeps every edit and drops the stale If-Match after ${label} (DW-376)`, async () => {
      await mountWritable([
        read(SEEDED),
        unconfirmed,
        () => ({
          ok: false,
          status: 428,
          json: async () => ({ error: WRITE_PRECONDITION_REQUIRED_COPY }),
        }),
      ]);

      typeChatModel("gpt-4.1");
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

      // The sentence: the outcome is UNKNOWN, not "settings couldn't be saved".
      // The patch may be stored, and this surface is in no position to say it is
      // not — nor to relay a proxy's HTML or a transport's `Failed to fetch`.
      const alert = await screen.findByText(/outcome is unknown/);
      expect(alert.textContent).toContain("save these settings");
      expect(screen.queryByText(SETTINGS_SAVE_FAILED_COPY)).toBeNull();
      expect(screen.queryByText(/Gateway Timeout/)).toBeNull();
      expect(screen.queryByText(/Failed to fetch/)).toBeNull();
      expect(screen.queryByText(SETTINGS_SAVED_COPY)).toBeNull();

      // Every edit survives — a save that may have landed must never be the
      // thing that loses it, and there is no re-seed from a server that never
      // answered.
      expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe(
        "gpt-4.1",
      );
      expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

      // THE reconciliation. If the save landed, the stored config has moved past
      // the version this canvas is holding, so that version is the one thing on
      // screen that can now be a lie. The next save carries NONE — refused as
      // the 428, which claims only that the save could not be checked, and is
      // true — rather than the superseded one, which could only ever be refused
      // as the 412: a flat "your save was not applied", blamed on a change made
      // somewhere else, when the change may be this owner's own save.
      typeChatModel("gpt-4.1-mini");
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(ifMatchOf(2)).toBeUndefined();
      await waitFor(() =>
        expect(screen.getByText(WRITE_PRECONDITION_REQUIRED_COPY)).toBeTruthy(),
      );
      expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe(
        "gpt-4.1-mini",
      );
    });
  }

  /**
   * The other side of that table, and the seam `workbench-settings.test.ts`
   * cannot reach (DW-428).
   *
   * BOTH producers of `unreadable` are driven here, because both are newly
   * changed canvas behaviour and the client suite only pins the returned value.
   * A body that would not PARSE and a body that parses to something with no
   * `workbench` in it are one branch and one verdict in the client — but they
   * are two different things a route or a proxy can do, and until this change
   * BOTH of them left the canvas holding its version. Covering only the parse
   * failure would reproduce, for the widened half, exactly the gap DW-428
   * exists to close.
   */
  const UNREADABLE: ReadonlyArray<readonly [string, () => unknown]> = [
    [
      "a body that would not parse",
      () => ({
        ok: true,
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON");
        },
      }),
    ],
    [
      "a body that parsed to no payload at all",
      () => ({ ok: true, status: 200, json: async () => ({ saved: true }) }),
    ],
  ];

  for (const [label, unreadable] of UNREADABLE) {
    it(`drops the stale If-Match after a 2xx with ${label} (DW-428)`, async () => {
      // A 2xx from something sitting in front of the route is no proof the route
      // did NOT run, so the held version may already have been superseded.
      // Keeping it risks a 412 on the next save — a flat "your save was not
      // applied", blamed on a change made somewhere else, when the change would
      // be this owner's own. Sending nothing gets the 428, which claims only
      // that the save could not be checked, and is true either way.
      await mountWritable([
        read(SEEDED),
        unreadable,
        () => ({
          ok: false,
          status: 428,
          json: async () => ({ error: WRITE_PRECONDITION_REQUIRED_COPY }),
        }),
      ]);

      typeChatModel("gpt-4.1");
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

      // The status line ARRIVED, so the unknown-outcome sentence stays off this
      // branch — and a 2xx carrying no payload is not a landed save either.
      await waitFor(() => expect(screen.getByText(SETTINGS_SAVE_FAILED_COPY)).toBeTruthy());
      expect(screen.queryByText(/outcome is unknown/)).toBeNull();
      expect(screen.queryByText(SETTINGS_SAVED_COPY)).toBeNull();
      // …and nothing off the unusable body reaches the owner, whichever way it
      // was unusable.
      expect(screen.queryByText(/not valid JSON|"saved"/)).toBeNull();
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
      expect(ifMatchOf(1)).toBe(`"${SEEDED}"`);

      // THE reconciliation: the next save carries NONE, and is refused with the
      // 428 sentence rather than a conflict one, with every edit still on screen.
      typeChatModel("gpt-4.1-mini");
      fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
      await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
      expect(ifMatchOf(2)).toBeUndefined();
      await waitFor(() =>
        expect(screen.getByText(WRITE_PRECONDITION_REQUIRED_COPY)).toBeTruthy(),
      );
      expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe(
        "gpt-4.1-mini",
      );
    });
  }

  it("KEEPS the version when this route's own 503 refuses the save", async () => {
    // The edge the status set turns on. `PUT /api/settings` answers 503 when the
    // store cannot be read, and refuses BEFORE merging — so nothing was written,
    // the version the canvas holds is still current, and throwing it away would
    // send the next save into a needless 428 on the strength of a refusal that
    // arrived intact.
    await mountWritable([
      read(SEEDED),
      () => ({
        ok: false,
        status: 503,
        json: async () => ({ error: "The settings store could not be read." }),
      }),
      saved(LANDED),
    ]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() =>
      expect(screen.getByText("The settings store could not be read.")).toBeTruthy(),
    );
    expect(screen.queryByText(/outcome is unknown/)).toBeNull();

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(ifMatchOf(2)).toBe(`"${SEEDED}"`);
  });

  it("keeps every edit on screen and shows the SERVER's conflict sentence", async () => {
    await mountWritable([
      read(SEEDED),
      () => ({
        ok: false,
        status: 412,
        json: async () => ({ error: WRITE_CONFLICT_COPY }),
      }),
    ]);

    typeChatModel("gpt-4.1");
    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

    await waitFor(() => expect(screen.getByText(WRITE_CONFLICT_COPY)).toBeTruthy());
    // A refused save must never be the thing that loses the edit.
    expect((screen.getByLabelText("Chat model") as HTMLInputElement).value).toBe("gpt-4.1");
    expect(screen.queryByText(SETTINGS_SAVED_COPY)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The Custom endpoint says what the environment overrides it with (DW-71)
// ---------------------------------------------------------------------------

describe("the Custom base URL row announces LLM_CUSTOM_BASE_URL (DW-71)", () => {
  it("names the variable and its value, while the box still shows the STORE", async () => {
    // `getCustomBaseUrl()` takes the variable ahead of the store, and the box
    // shows the store — so without the sentence an owner types an endpoint into
    // a field, saves successfully, and nothing reaches the provider.
    await mount(
      "llm-models",
      payload({
        readOnly: false,
        customBaseUrl: "https://saved.example/v1",
        envCustomBaseUrl: "https://env.example/v1",
      }),
    );

    const box = screen.getByLabelText("Custom base URL") as HTMLInputElement;
    // The STORED value, still editable: it is what a save moves and what applies
    // the moment the variable is unset.
    expect(box.value).toBe("https://saved.example/v1");
    expect(box.readOnly).toBe(false);
    expect(box.hasAttribute("disabled")).toBe(false);
    // DESCRIBED, never MARKED — an env override is not a wrong value in the box.
    expect(box.getAttribute("aria-invalid")).toBeNull();

    const announced = announcedFor(box);
    expect(announced).toContain(
      settingsEnvOverrideCopy("customBaseUrl", "https://env.example/v1"),
    );
    expect(announced).toContain("LLM_CUSTOM_BASE_URL");
    expect(announced).toContain("https://env.example/v1");
  });

  it("says NOTHING when the variable is unset", async () => {
    // The row's description is exactly what it was before this shipped: a
    // sentence about a variable nobody set would send the owner to a shell with
    // nothing to change.
    const { container } = await mount(
      "llm-models",
      payload({ readOnly: false, customBaseUrl: "https://saved.example/v1" }),
    );

    const box = screen.getByLabelText("Custom base URL") as HTMLInputElement;
    expect(box.value).toBe("https://saved.example/v1");
    expect(box.getAttribute("aria-describedby")).toBeNull();
    expect(container.textContent).not.toContain("LLM_CUSTOM_BASE_URL");
  });

  it("rides ALONGSIDE the read-only sentence rather than replacing it", async () => {
    // Two different facts about the same box: one says the environment wins, the
    // other says this deployment will not take the edit at all. `describedBy`
    // appends, so a screen reader gets both.
    await mount(
      "llm-models",
      payload({
        customBaseUrl: "https://saved.example/v1",
        envCustomBaseUrl: "https://env.example/v1",
      }),
    );

    const announced = announcedFor(screen.getByLabelText("Custom base URL"));
    expect(announced).toContain(
      settingsEnvOverrideCopy("customBaseUrl", "https://env.example/v1"),
    );
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });
});
