import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { embeddingProviderLabel } from "@/lib/providers";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_REMOVE_COPY,
  SETTINGS_KEY_REMOVE_PENDING_COPY,
  SETTINGS_KEY_STORED_COPY,
  SETTINGS_KEY_UNDO_COPY,
  SETTINGS_LOADING_COPY,
  SETTINGS_SAVED_COPY,
  SETTINGS_SAVE_COPY,
  SETTINGS_ENV_PROVIDER_PIN_CODE,
  settingsEnvProviderPinRefusalCopy,
  validateWorkbenchSettingsPatch,
  type WorkbenchSettingsPayload,
  type WorkbenchSettingsStored,
} from "@/lib/workbench-settings";
import {
  announcedFor,
  installSettingsFetchMock,
  mountSettings,
  mountSettingsQueue,
  patchOf,
  settingsPayload,
} from "@/test/settings-harness";

/**
 * Clear on switch, MOUNTED (DW-69/DW-72).
 *
 * `workbench-settings.test.ts` pins the pure rules — `embeddingProviderChanged`,
 * `settingsDraftAfterEmbeddingProvider`, `draftEmbeddingKeyStored` — which is
 * the right tool for "what does the rule say" and the wrong one for the claim
 * the spec's acceptance criterion actually makes: that an owner LOOKING at the
 * surface is told the truth about what the save will store. Between the two
 * sits the component's wiring — whether the select applies the rule at all, and
 * which predicate reaches `secretRow`'s hint and its `Remove` button — and a
 * node suite reading source cannot observe either.
 */

/**
 * The stored settings this file asserts against: the shared fixture, as a
 * deployment already CONFIGURED for OpenAI — its endpoint and its credential.
 *
 * Both deltas are the subject: what clearing on switch has to clear. The shared
 * base has no endpoint and no stored key, which would leave nothing to clear.
 * The `version` is a stamp in the store's own `s1:` scheme (`newConfigVersion`
 * in `src/lib/config.ts`), distinct from the base's only so that a save answer
 * below can move it; nothing here reads it.
 */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload({
    version: "s1:22222222222222222222222222222222",
    embeddingBaseUrl: "https://o/v1",
    hasEmbeddingApiKey: true,
    ...overrides,
  });
}

// Registers the `fetch` stub and the `cleanup()`-first teardown. The DW-553
// describe at the bottom drives one response per call and reads the PUT bodies
// back, so the mock it returns IS held.
const fetchMock = installSettingsFetchMock();

/** Mount the embeddings category and let the single on-mount read settle. */
function mount(stored: WorkbenchSettingsPayload) {
  return mountSettings("embeddings", stored);
}

const providerSelect = () =>
  screen.getByLabelText("Embedding provider") as HTMLSelectElement;
const endpointBox = () => screen.getByLabelText("Embedding endpoint") as HTMLInputElement;
const keyBox = () => screen.getByLabelText("Embedding API key") as HTMLInputElement;

describe("the embeddings surface clears the vendor pair on a switch (DW-69/DW-72)", () => {
  it("blanks the endpoint and stops claiming a key when Google is picked", async () => {
    await mount(payload());

    // BEFORE: the surface describes the OpenAI configuration it loaded.
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();

    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(providerSelect().value).toBe("google");

    // AFTER: what the surface shows is what the save will store. The endpoint
    // box is empty, so `settingsSaveBody` sends `null` rather than writing
    // OpenAI's URL back into the store the clear just emptied.
    expect(endpointBox().value).toBe("");
    // The hint is the state, for a field that shows nothing: "A key is stored."
    // beside a key the very next save deletes is the misreport DW-69 names.
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
    expect(announcedFor(keyBox())).not.toContain(SETTINGS_KEY_STORED_COPY);
    // …and `Remove` goes with it: there is nothing left for it to remove.
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).toBeNull();
    // The key field is back to UNTOUCHED rather than pending removal, so a
    // credential typed for Google before saving still rides.
    expect(keyBox().value).toBe("");
    expect(keyBox().readOnly).toBe(false);
  });

  it("leaves both boxes alone when the SAME provider is re-selected", async () => {
    await mount(payload());
    // A marker the rule would DESTROY if it ran: the assertion below cannot pass
    // vacuously, because "the endpoint still reads `https://o/v1`" was already
    // true at mount. `fireEvent` flushes React's state update synchronously, so
    // these are asserted with no `waitFor` — a `waitFor` would happily observe
    // the pre-clear frame and call it a pass.
    fireEvent.change(endpointBox(), { target: { value: "https://o/v1/edited" } });
    expect(endpointBox().value).toBe("https://o/v1/edited");

    // The every-save re-send is the ordinary case, so "same value" must be a
    // no-op on both boxes.
    fireEvent.change(providerSelect(), { target: { value: "openai" } });

    expect(endpointBox().value).toBe("https://o/v1/edited");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();
  });

  it("clears on the way to auto-detect as well", async () => {
    await mount(payload());
    fireEvent.change(providerSelect(), { target: { value: "" } });
    expect(endpointBox().value).toBe("");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
  });

  it("RESTORES the stored endpoint across a switch and BACK within one draft", async () => {
    await mount(payload());
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(endpointBox().value).toBe("");

    fireEvent.change(providerSelect(), { target: { value: "openai" } });

    // Back on the STORED vendor, whose endpoint and key the store never moved
    // away from — so the surface shows what a reload would show. Left blank, the
    // next save would send `embeddingBaseUrl: null` and DELETE a stored endpoint
    // for a provider that never net-moved.
    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    // The key half already behaved this way; the endpoint half now matches it.
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();
  });

  it("cancels a pending REMOVE when the vendor moves", async () => {
    await mount(payload());
    // The owner presses Remove: the row goes to its removal-pending state and
    // the box turns read-only, with `Undo` as the only way back.
    fireEvent.click(screen.getByText(SETTINGS_KEY_REMOVE_COPY));
    expect(keyBox().readOnly).toBe(true);
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_REMOVE_PENDING_COPY);

    fireEvent.change(providerSelect(), { target: { value: "google" } });

    // The pending Remove was about the PREVIOUS vendor's key, and that key is
    // being dropped by the store anyway. Left standing it would ride as
    // `embeddingApiKey: null` — and it would strand the row: `Undo` is gated on
    // the key still counting for the selected vendor, which it no longer does,
    // so the box would stay read-only with no control to release it.
    expect(keyBox().readOnly).toBe(false);
    expect(announcedFor(keyBox())).not.toContain(SETTINGS_KEY_REMOVE_PENDING_COPY);
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
    expect(screen.queryByText(SETTINGS_KEY_UNDO_COPY)).toBeNull();
  });

  it("discards a key TYPED for the vendor being left behind", async () => {
    await mount(payload());
    fireEvent.change(keyBox(), { target: { value: "sk-typed-for-openai" } });
    expect(keyBox().value).toBe("sk-typed-for-openai");

    fireEvent.change(providerSelect(), { target: { value: "google" } });

    // A credential typed while OpenAI was selected must not be carried into a
    // save that stores it for Google.
    expect(keyBox().value).toBe("");
  });

  it("offers the vendor whose label the switch is about", async () => {
    // Belt-and-braces on the harness rather than on the rule: a renamed option
    // value would make every `fireEvent.change` above a silent no-op.
    await mount(payload());
    const options = [...providerSelect().options].map((option) => option.value);
    expect(options).toContain("google");
    expect(screen.getByText(embeddingProviderLabel("google"))).not.toBeNull();
  });

  it("does not touch the select at all on a READ-ONLY deployment", async () => {
    await mount(payload({ readOnly: true }));
    // The read-only guard returns BEFORE the rule runs. Asserted synchronously
    // and on the SELECT's own value, which is the thing that would differ: the
    // endpoint reading `https://o/v1` is true at mount either way, so it alone
    // would pass whether or not the guard held.
    fireEvent.change(providerSelect(), { target: { value: "google" } });

    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
  });
});

// ---------------------------------------------------------------------------
// A way forward after the env pin refuses the move (DW-553)
// ---------------------------------------------------------------------------
//
// `workbench-settings.test.ts` runs the two rules — that the sentence is
// recognised by exact equality over the closed set, and that the re-seed puts
// the three embedding legs back. What it cannot see is the seam: that the
// canvas ASKS on a refused save, and that the retry it makes possible is
// therefore no longer the move the route refuses. Both halves are only
// observable from a mounted surface driving two real PUTs.
//
// The motivating case is a STALE TAB: this payload was read before
// `EMBEDDING_PROVIDER` was set, so it carries `envEmbeddingProvider: null`, the
// select is not pinned, and the surface has no way to know until the route
// answers. That is exactly why the recovery has to be driven by the refusal.

/**
 * ONE DRAFT, ONE SENTENCE — the ledger's composition, MOUNTED (DW-330).
 *
 * The node suite pins the two halves as pure functions, which cannot see the
 * thing DW-330 is actually about: the checkbox's own SELECTOR
 * (`vectorAllowed ? … : values.vectorSearchEnabled ? vectorInactive :
 * vectorBlocked`) and the save bar, rendered together, from one draft, at one
 * moment. That composition is what the ledger describes — "the checkbox hint
 * reads … while the 400 that lands in the save bar a few rows below reads …" —
 * and only a mounted surface driving a real PUT can put both strings on screen
 * to compare.
 *
 * The stub does not TYPE the refusal: it runs `validateWorkbenchSettingsPatch`
 * over the patch the surface actually sent, which is the route's own rule. A
 * hand-written 400 body would assert only that this file and the component
 * agree with each other.
 */
describe("the ticked box and the refused save say ONE thing (DW-330)", () => {
  /** The store BEFORE the save: every OpenAI leg met, switch off. */
  const BASELINE: WorkbenchSettingsStored = {
    vectorSearchEnabled: false,
    embeddingProvider: "openai",
    embeddingBaseUrl: "https://o/v1",
    embeddingModel: "text-embedding-3-small",
    hasEmbeddingApiKey: true,
    envEmbeddingProvider: null,
    envEmbeddingProviderInvalid: null,
    envEmbeddingModel: null,
    envEmbeddingApiKeyProviders: [],
    hasWorkersAiBinding: false,
  };

  it("answers the ticked box and the save bar with the same sentence", async () => {
    let call = 0;
    fetchMock.mockImplementation(async (_url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ workbench: payload() }),
        } as unknown as Response;
      }
      // What the ROUTE does with the body this surface sent: apply the patch
      // over the baseline, then run the one gate over both views.
      const patch = (
        JSON.parse(String(init?.body)) as { workbench: Record<string, unknown> }
      ).workbench;
      const merged: WorkbenchSettingsStored = {
        ...BASELINE,
        vectorSearchEnabled: patch.vectorSearchEnabled === true,
        embeddingBaseUrl:
          patch.embeddingBaseUrl === undefined
            ? BASELINE.embeddingBaseUrl
            : (patch.embeddingBaseUrl as string | null),
      };
      const verdict = validateWorkbenchSettingsPatch(patch, merged, BASELINE);
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: verdict.ok ? "" : verdict.error }),
      } as unknown as Response;
    });
    render(<SettingsCanvas category="embeddings" headingId="wb-set-heading" />);
    await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());

    // The reachable path the ledger names: the legs are met, so the box takes
    // the tick — and THEN a leg is moved into an unmet state in the same draft.
    const vectorSwitch = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    fireEvent.click(vectorSwitch);
    expect(vectorSwitch.checked).toBe(true);
    fireEvent.change(endpointBox(), { target: { value: "" } });

    // The CHECKBOX's half, off the rendered description.
    const hint = announcedFor(vectorSwitch);
    expect(hint).toContain("Vector search is switched on, but it needs");

    fireEvent.click(screen.getByRole("button", { name: SETTINGS_SAVE_COPY }));

    // …and the SAVE BAR's half, a few rows below, at the same moment. Before
    // DW-330 this said "…before it can be turned on" beside that ticked box.
    await waitFor(() => expect(screen.getByText(hint)).toBeTruthy());
    expect(screen.queryByText(/before it can be turned on/)).toBeNull();
    // Both are on screen together: the hint is still the checkbox's own
    // description, so the match is not one sentence replacing the other.
    expect(announcedFor(vectorSwitch)).toBe(hint);
  });
});

describe("the embeddings surface recovers from the env-pin refusal (DW-553)", () => {
  /** The sentence the route mints from its own `EMBEDDING_PROVIDER`. */
  const PINNED = settingsEnvProviderPinRefusalCopy("workers-ai");

  /** The stale tab's read: OpenAI stored, and NO pin visible to the browser. */
  const staleRead = () => ({
    ok: true,
    status: 200,
    json: async () => ({ workbench: payload({ envEmbeddingProvider: null }) }),
  });

  const refusal = () => ({
    ok: false,
    status: 400,
    json: async () => ({ error: PINNED }),
  });

  const modelBox = () => screen.getByLabelText("Embedding model") as HTMLInputElement;
  const saveButton = () => screen.getByRole("button", { name: SETTINGS_SAVE_COPY });

  it("re-seeds the three embedding legs and keeps every other edit", async () => {
    await mountSettingsQueue("embeddings", [staleRead, refusal]);

    // The owner moves the vendor — and edits something else, which is what
    // keeps Save reachable after the re-seed cleans the embedding legs.
    fireEvent.change(modelBox(), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect(providerSelect().value).toBe("google");
    expect(endpointBox().value).toBe("");

    fireEvent.click(saveButton());

    // The SERVER's sentence, unchanged and unparaphrased.
    await waitFor(() => expect(screen.getByText(PINNED)).toBeTruthy());
    expect(screen.queryByText(SETTINGS_SAVED_COPY)).toBeNull();

    // …and the way forward: all three embedding legs read the STORE again, so
    // the surface no longer describes a save the route will refuse.
    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(screen.queryByText(SETTINGS_KEY_REMOVE_COPY)).not.toBeNull();
    expect(keyBox().value).toBe("");

    // A refused save is never the thing that loses an edit: the unrelated one
    // stands, and it is what leaves the draft dirty.
    expect(modelBox().value).toBe("text-embedding-3-large");
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
  });

  it("recovers from the CODE alone, whatever the sentence says (DW-628)", async () => {
    // The seam the wire code exists to remove. This body's sentence is one the
    // closed-set equality cannot match — a reworded pin, which is precisely the
    // drift the sentence match fails closed on — so the ONLY thing that can
    // drive the re-seed here is `code`. Before DW-628 this owner was stuck:
    // every retry re-sent the identical refused move for the rest of the
    // session.
    const REWORDED = "The embedding provider is fixed by this deployment.";
    await mountSettingsQueue("embeddings", [
      staleRead,
      () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: REWORDED, code: SETTINGS_ENV_PROVIDER_PIN_CODE }),
      }),
    ]);

    fireEvent.change(modelBox(), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(providerSelect(), { target: { value: "google" } });

    fireEvent.click(saveButton());

    // The SERVER's words, whatever they are — the code decides the recovery, it
    // never decides the sentence.
    await waitFor(() => expect(screen.getByText(REWORDED)).toBeTruthy());
    // …and all three embedding legs read the STORE again, exactly as they do
    // off the sentence match above.
    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);
    expect(modelBox().value).toBe("text-embedding-3-large");
  });

  it("makes the RETRY a request the pin does not refuse", async () => {
    await mountSettingsQueue("embeddings", [
      staleRead,
      refusal,
      () => ({
        ok: true,
        status: 200,
        json: async () => ({
          saved: true,
          workbench: payload({
            envEmbeddingProvider: null,
            embeddingModel: "text-embedding-3-large",
            version: "s1:33333333333333333333333333333333",
          }),
        }),
      }),
    ]);

    fireEvent.change(modelBox(), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(PINNED)).toBeTruthy());

    // Call 0 is the read, call 1 the refused move: it really did carry the
    // move, so the retry below is not passing vacuously.
    expect(patchOf(1).embeddingProvider).toBe("google");
    expect(patchOf(1).embeddingBaseUrl).toBeNull();

    fireEvent.click(saveButton());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

    // The retry carries the STORED vendor and its endpoint, so
    // `embeddingProviderChanged` sees no move and the route's pin never fires —
    // while the edit the owner actually still wants rides along.
    expect(patchOf(2).embeddingProvider).toBe("openai");
    expect(patchOf(2).embeddingBaseUrl).toBe("https://o/v1");
    expect(patchOf(2).embeddingModel).toBe("text-embedding-3-large");
    // UNTOUCHED, not a pretend Remove: nothing rides that could delete the
    // pinned vendor's own credential.
    expect(patchOf(2).embeddingApiKey).toBeUndefined();
    await waitFor(() => expect(screen.getByText(SETTINGS_SAVED_COPY)).toBeTruthy());
  });

  it("ends CLEAN when the refused move was the owner's only edit", async () => {
    // The other cases here carry a second, unrelated edit, which is what keeps
    // Save reachable afterwards. This is the case without one, and its ending
    // is different by design: the re-seed puts the three legs back where the
    // payload has them, so the draft now EQUALS the payload, `settingsDirty`
    // answers false and Save goes disabled.
    //
    // That is the correct terminal state, not a dead end. The owner's only edit
    // was one the environment forbids; it has been undone, and the route's
    // sentence on screen says why. There is genuinely nothing left to save, and
    // a Save button live over a draft identical to the store would only offer
    // to re-send the request that was just refused.
    await mountSettingsQueue("embeddings", [staleRead, refusal]);

    fireEvent.change(providerSelect(), { target: { value: "google" } });
    expect((saveButton() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(saveButton());

    await waitFor(() => expect(screen.getByText(PINNED)).toBeTruthy());
    expect(providerSelect().value).toBe("openai");
    expect(endpointBox().value).toBe("https://o/v1");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_STORED_COPY);

    // Nothing left to save, and the explanation still on screen.
    await waitFor(() => expect((saveButton() as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByText(PINNED)).toBeTruthy();
    // …and no further request was provoked by the re-seed itself.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("leaves the embedding legs ALONE on any other refusal", async () => {
    // The recognition is exact equality over the closed set, so a refusal about
    // anything else — here the 412 conflict — must not re-seed a thing.
    await mountSettingsQueue("embeddings", [
      staleRead,
      () => ({
        ok: false,
        status: 412,
        json: async () => ({ error: "Someone else changed these settings." }),
      }),
    ]);

    fireEvent.change(providerSelect(), { target: { value: "google" } });
    fireEvent.click(saveButton());

    await waitFor(() =>
      expect(screen.getByText("Someone else changed these settings.")).toBeTruthy(),
    );
    expect(providerSelect().value).toBe("google");
    expect(endpointBox().value).toBe("");
    expect(announcedFor(keyBox())).toContain(SETTINGS_KEY_ABSENT_COPY);
  });

  it("does not adopt the pinned vendor into the payload it was served", async () => {
    // The refusal names `EMBEDDING_PROVIDER=workers-ai`, and the surface must
    // NOT write that into the store state it is holding: it was not served it,
    // and inventing it would pin the select and change every vector sentence on
    // the strength of a 400 body. The next READ is what corrects the tab.
    await mountSettingsQueue("embeddings", [staleRead, refusal]);

    fireEvent.change(modelBox(), { target: { value: "text-embedding-3-large" } });
    fireEvent.change(providerSelect(), { target: { value: "google" } });
    fireEvent.click(saveButton());
    await waitFor(() => expect(screen.getByText(PINNED)).toBeTruthy());

    // Still editable, and still on the STORED vendor rather than the pinned one.
    expect(providerSelect().hasAttribute("aria-disabled")).toBe(false);
    expect(providerSelect().value).toBe("openai");
    fireEvent.change(providerSelect(), { target: { value: "ollama" } });
    expect(providerSelect().value).toBe("ollama");
  });
});
