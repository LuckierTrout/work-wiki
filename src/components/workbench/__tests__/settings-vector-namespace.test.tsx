import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import { WORKERS_AI_EMBEDDING_MODEL_IDS } from "@/lib/providers";
import {
  SETTINGS_LOADING_COPY,
  SETTINGS_VECTOR_BINDING_NOTE,
  SETTINGS_VECTOR_ENV_MODEL_NOTE,
  SETTINGS_VECTOR_HINT_COPY,
  settingsEnvOverrideCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";

/**
 * The DW-73 namespace refusal, MOUNTED.
 *
 * `workbench-settings.test.ts` pins the sentence at the library seam, which is
 * the right tool for "what does the predicate say" and the wrong one for the
 * claim the spec's acceptance criterion actually makes: that an owner LOOKING
 * at the vector switch is told about the namespace. Between the two sits the
 * component's own wiring — which of `vectorAllowed`/`vectorBlocked` reaches the
 * hint span, and whether that span is the checkbox's `aria-describedby` — and a
 * node suite reading source cannot observe either. So the assertions below are
 * made against the rendered DOM, on the text a screen reader would announce.
 */

/** The stored settings, as `GET /api/settings` serves them. */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return {
    version: "w1:2-0000000000000000",
    chatProvider: "openai",
    chatModel: "gpt-4o",
    ingestProvider: "anthropic",
    ingestModel: "claude-sonnet-4-20250514",
    customBaseUrl: null,
    hasCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: "workers-ai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envEmbeddingApiKeyProviders: [],
    // ON Workers. Every case in this file selects `workers-ai`, and without the
    // binding the gate would refuse for a SECOND reason (DW-225) — which would
    // change every sentence asserted below and leave nothing here about the
    // namespace at all. The binding leg has its own cases at the end.
    hasWorkersAiBinding: true,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    language: "English",
    readOnly: false,
    ...overrides,
  };
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmounting here tears the
  // tree down while `fetch` is still stubbed.
  cleanup();
  vi.unstubAllGlobals();
});

/**
 * What a screen reader would actually read out for a control: every id in its
 * `aria-describedby` list, resolved and joined. A single `getElementById` over
 * the whole attribute silently returns null the moment a second id is appended,
 * which would make an assertion on the description pass vacuously.
 */
function announcedFor(control: HTMLElement): string {
  const ids = (control.getAttribute("aria-describedby") ?? "").split(/\s+/).filter(Boolean);
  expect(ids.length).toBeGreaterThan(0);
  return ids
    .map((id) => {
      const target = document.getElementById(id);
      expect(target).not.toBeNull();
      return target!.textContent ?? "";
    })
    .join(" ");
}

/**
 * No PUT was attempted — the only `fetch` so far is the surface's single
 * on-mount read.
 *
 * The refusal is enforced in `onChange` (`SettingsCanvas.tsx:503-506`), which
 * returns early rather than calling `set`, so nothing this file clicks should
 * ever reach the network. Save is a separate button here, so this is a
 * belt-and-braces pin rather than the primary assertion: `checked` is bound to
 * the DRAFT (`checked={values.vectorSearchEnabled}`), so a handler that stopped
 * consulting `vectorRefused` would already flip `checked` above. What this adds
 * is the guarantee that a refused control never writes — the property that would
 * matter if the switch ever gained an autosave.
 */
function expectNoSaveAttempted(): void {
  expect(fetchMock).toHaveBeenCalledTimes(1);
}

/** Mount the embeddings category and let the single on-mount read settle. */
async function mount(stored: WorkbenchSettingsPayload) {
  fetchMock.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => ({ workbench: stored }),
  } as unknown as Response);
  const view = render(<SettingsCanvas category="embeddings" headingId="wb-set-heading" />);
  await waitFor(() => expect(screen.queryByText(SETTINGS_LOADING_COPY)).toBeNull());
  return view;
}

/**
 * The sentence SHAPE is typed out — the point of a mounted assertion is the
 * string a screen reader announces, so building it by calling the copy function
 * would assert only that the component calls the function. The ID LIST is
 * derived from the catalog, because a stale literal there is a silent hole: add
 * a supported model and this expectation would go on naming the old four while
 * the surface named five.
 */
const UNSUPPORTED_WORKERS_MODEL = `Vector search needs a supported Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) before it can be turned on.`;
const OUT_OF_NAMESPACE =
  "Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.";

describe("the vector switch announces the NAMESPACE refusal (DW-73)", () => {
  it("describes a Workers AI selection holding an OpenAI model id", async () => {
    await mount(payload());
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // Refused: the owner cannot turn it on, and the reason travels WITH the
    // control rather than sitting unassociated beside it.
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(UNSUPPORTED_WORKERS_MODEL);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
    // The old sentence is the regression this guards: "needs a model" beside a
    // model box that visibly holds one sent the owner nowhere.
    expect(announcedFor(checkbox)).not.toContain("needs a model before");
  });

  it("describes the MIRROR case — an OpenAI selection holding a Workers AI id", async () => {
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "@cf/baai/bge-m3",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
      }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(OUT_OF_NAMESPACE);
    // Clicked, not merely inspected: "the owner cannot turn it on" is a claim
    // about the HANDLER, and asserting `aria-disabled` alone would leave this
    // direction passing even if `onChange` stopped consulting `vectorRefused`.
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
  });

  it("leaves an ALREADY-ON switch checked, refused, and turn-off-able", async () => {
    // The state the deployment documentation is about, and the most confusing
    // one this change produces: the payload serves the STORED flag rather than
    // the intersected one (`config.ts:652-656`), so the switch renders CHECKED
    // while the gate refuses the combination underneath it.
    await mount(payload({ vectorSearchEnabled: true }));
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    // NOT `aria-disabled`, which is deliberate rather than an oversight:
    // `vectorRefused` is `stored.readOnly || (!vectorAllowed &&
    // !values.vectorSearchEnabled)` (`SettingsCanvas.tsx:237-238`), and this
    // payload is writable — so a switch that is already on stays operable. An
    // owner must be able to undo a switch whose legs have since gone missing,
    // and marking it disabled here would strand them with a control they cannot
    // turn off.
    expect(checkbox.getAttribute("aria-disabled")).toBeNull();
    // The refusal is still what gets announced, so "checked" never reads as
    // "working".
    expect(announcedFor(checkbox)).toBe(UNSUPPORTED_WORKERS_MODEL);
    // Off is allowed...
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    // ...and the door closes behind it: with the flag now off, the same
    // mismatch refuses the way back on.
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expect(announcedFor(checkbox)).toBe(UNSUPPORTED_WORKERS_MODEL);
    // Neither the allowed turn-OFF nor the refused turn-back-ON went near the
    // network: this surface saves from its own button, never from the switch.
    expectNoSaveAttempted();
  });

  it("refuses a @cf/ id that Workers AI cannot EMBED with (DW-220)", async () => {
    // The most misleading state the old sentence produced: the owner typed a
    // real Cloudflare id, inside the namespace the refusal named, and the switch
    // still would not turn on. The rendered sentence now lists what to type.
    await mount(payload({ embeddingModel: "@cf/llava-hf/llava-1.5-7b-hf" }));
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    const announced = announcedFor(checkbox);
    expect(announced).toBe(UNSUPPORTED_WORKERS_MODEL);
    // Specifically: it does not tell the owner to do what they have already done.
    expect(announced).not.toContain("in the Workers AI @cf/ namespace");
    expect(announced).toContain("@cf/baai/bge-m3");
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
  });

  it("shows the ordinary hint once the id matches the provider", async () => {
    await mount(payload({ embeddingModel: "@cf/baai/bge-m3" }));
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    // Workers AI carries its own transport, so a matching id is the WHOLE gate:
    // no endpoint, no key, and no refusal.
    expect(checkbox.getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(checkbox)).toBe(SETTINGS_VECTOR_HINT_COPY);
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(true));
  });
});

describe("the MODEL INPUT carries its own complaint (DW-223)", () => {
  /**
   * The box the refusal is about. Announced through the same resolver the
   * checkbox uses, because "the model field says so" is a claim about which span
   * is wired to which control — the one thing a node suite cannot observe.
   */
  function modelInput(): HTMLInputElement {
    return screen.getByLabelText("Embedding model") as HTMLInputElement;
  }

  it("marks the box invalid and describes it when the STORE holds the wrong id", async () => {
    await mount(payload());
    // The value in the box IS the wrong one, so the box is what is marked.
    expect(modelInput().value).toBe("text-embedding-3-small");
    expect(modelInput().getAttribute("aria-invalid")).toBe("true");
    expect(announcedFor(modelInput())).toBe(UNSUPPORTED_WORKERS_MODEL);
    // The `EMBEDDING_MODEL` note is NOT here — no variable is set, and this row
    // is about the value it edits.
    expect(announcedFor(modelInput())).not.toContain("EMBEDDING_MODEL");
  });

  it("describes an ENV-owned mismatch beside the env sentence, without marking it", async () => {
    // `EMBEDDING_MODEL` wins over the box in every feeder, so the box holds
    // nothing wrong — marking it would point the owner at a control that cannot
    // fix it. The complaint still has to be readable ON the row that is about
    // the model, which is what the description carries.
    await mount(
      payload({ embeddingModel: null, envEmbeddingModel: "text-embedding-3-small" }),
    );
    expect(modelInput().value).toBe("");
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(modelInput());
    expect(announced).toContain(
      settingsEnvOverrideCopy("model", "text-embedding-3-small"),
    );
    expect(announced).toContain(UNSUPPORTED_WORKERS_MODEL);
    // And the variable is named where the refusal is: on the checkbox.
    const checkbox = screen.getByLabelText("Enable vector search");
    expect(announcedFor(checkbox)).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
  });

  it("says nothing at all when the id matches the provider", async () => {
    await mount(payload({ embeddingModel: "@cf/baai/bge-m3" }));
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    // No hint at all: with no env override and no complaint there is nothing for
    // this row to describe.
    expect(modelInput().getAttribute("aria-describedby")).toBeNull();
  });

  it("says nothing while the provider is still unchosen", async () => {
    // The gate has exactly one leg here — "an embedding provider" — and it is
    // not this row's. A model complaint before a provider is picked would be a
    // complaint about a rule that has not been reached.
    await mount(payload({ embeddingProvider: null }));
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    expect(modelInput().getAttribute("aria-describedby")).toBeNull();
    expect(announcedFor(screen.getByLabelText("Enable vector search"))).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
  });

  it("describes but does NOT mark on a read-only deployment", async () => {
    // `YOPEDIA_READONLY` makes every box on this surface unfixable, which is the
    // same dead end that leaves an env-owned mismatch described-but-unmarked:
    // `aria-invalid` tells the owner "this field is wrong, fix it" about a field
    // they cannot fix. The reason still has to be announced, so only the MARK is
    // withheld.
    await mount(payload({ readOnly: true }));
    expect(modelInput().value).toBe("text-embedding-3-small");
    expect(modelInput().readOnly).toBe(true);
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    expect(announcedFor(modelInput())).toBe(UNSUPPORTED_WORKERS_MODEL);
  });

  it("marks the box the moment the PROVIDER select moves under it", async () => {
    // The ordinary way into this state, and the reason the complaint could not
    // stay on the checkbox alone: the owner changes a control that touches
    // neither the model box nor the switch, and the model they saved months ago
    // is suddenly the wrong one.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
      }),
    );
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(screen.getByLabelText("Embedding provider"), {
      target: { value: "workers-ai" },
    });

    await waitFor(() =>
      expect(modelInput().getAttribute("aria-invalid")).toBe("true"),
    );
    expect(announcedFor(modelInput())).toBe(UNSUPPORTED_WORKERS_MODEL);
    // The box still holds what the owner stored — the complaint describes it,
    // it does not rewrite it.
    expect(modelInput().value).toBe("text-embedding-3-small");
  });
});

describe("the vector switch names the Cloudflare AI binding (DW-225)", () => {
  it("refuses a Workers AI selection off the Workers runtime", async () => {
    // Nothing about the stored config is wrong: the provider is explicit and
    // the id is supported. What is missing is the runtime the provider needs.
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", hasWorkersAiBinding: false }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // The model row is silent — the id is not what is wrong.
    expect(
      (screen.getByLabelText("Embedding model") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBeNull();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
  });

  it("allows the same selection where the binding exists", async () => {
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", hasWorkersAiBinding: true }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(checkbox)).toBe(SETTINGS_VECTOR_HINT_COPY);
  });
});
