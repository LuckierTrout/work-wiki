import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SettingsCanvas } from "@/components/workbench/SettingsCanvas";
import {
  WORKERS_AI_EMBEDDING_MODEL_IDS,
  WORKERS_AI_MODEL_PREFIX,
  embeddingProviderLabel,
} from "@/lib/providers";
import {
  SETTINGS_LOADING_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_VECTOR_BINDING_ENV_NOTE,
  SETTINGS_VECTOR_BINDING_NOTE,
  SETTINGS_VECTOR_ENV_MODEL_NOTE,
  SETTINGS_VECTOR_HINT_COPY,
  SETTINGS_VECTOR_PROVIDER_COPY,
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
    // No substitution by default (DW-312), so every case written before the
    // pair existed announces exactly what it announced then — the cases that
    // are ABOUT the substitution opt in by overriding both fields.
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
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
const UNSUPPORTED_WORKERS_MODEL = `Vector search needs a supported Cloudflare Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) before it can be turned on.`;
const OUT_OF_NAMESPACE =
  "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.";
/**
 * The same legs, said to a switch that is already ON (DW-279). Typed out for the
 * same reason the refusal above is: the point of a mounted assertion is the
 * string a screen reader announces. It speaks about the SETTINGS, not about the
 * running deployment — the component selects it from draft-derived terms, which
 * cannot know what the stored config is doing.
 */
const ON_BUT_INACTIVE = `Vector search is switched on, but it needs a supported Cloudflare Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) before it can run. Turn it off, or supply what is missing.`;

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
    // "working" — but said as the state the surface is actually IN (DW-279).
    // "before it can be turned on" beside a ticked box describes some other
    // deployment, and left the owner no way to tell whether the feature is
    // running. It is not: `getVectorSearchSettings` intersects the stored flag
    // with this same predicate.
    expect(announcedFor(checkbox)).toBe(ON_BUT_INACTIVE);
    expect(announcedFor(checkbox)).not.toContain("before it can be turned on");
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
    // The phrase is DERIVED the way the copy is (DW-222): typed out, this guard
    // stopped guarding the moment the provider name changed, because a
    // reintroduced pre-DW-220 sentence would name the provider the new way.
    expect(announced).not.toContain(
      `in the ${embeddingProviderLabel("workers-ai")} ${WORKERS_AI_MODEL_PREFIX} namespace`,
    );
    expect(announced).toContain("@cf/baai/bge-m3");
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
  });

  it("names the provider in the refusal exactly as the PICKER above it does (DW-222)", async () => {
    // Every other parity assertion lives at the module seam, where both sides
    // resolve through the same `embeddingProviderLabel` call and so cannot
    // disagree by construction. This one compares RENDERED to RENDERED — the
    // option text a screen reader reads out of the select against the sentence
    // it reads out of the switch two rows below — which is the surface the
    // intent is actually about.
    await mount(payload());
    const select = screen.getByLabelText("Embedding provider") as HTMLSelectElement;
    const option = Array.from(select.options).find((o) => o.value === "workers-ai");
    expect(option).toBeDefined();
    const pickerName = option!.textContent ?? "";
    // A blank option would make the containment check below pass vacuously.
    expect(pickerName.trim().length).toBeGreaterThan(0);
    const announced = announcedFor(
      screen.getByLabelText("Enable vector search") as HTMLInputElement,
    );
    // The refusal is one that NAMES the provider, and it names it with the
    // picker's own string, character for character.
    expect(announced).toContain(pickerName);
    // And it does not ALSO carry a second name for the same selection.
    expect(announced.replaceAll(pickerName, "«provider»")).not.toMatch(/workers[\s-]?ai/i);
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

  it("keeps the ordinary hint on a switch that is ON with every leg met", async () => {
    // The other side of the DW-279 split. A checked box is NOT what selects the
    // switched-on-but-unmet sentence — an unmet leg is — so a working deployment
    // must still read the standing hint. Ordering the component's ternary the
    // other way round would announce "it needs … before it can run" over a
    // vector search that is running, which is the more damaging of the two
    // mistakes.
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", vectorSearchEnabled: true }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.checked).toBe(true);
    expect(checkbox.getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(checkbox)).toBe(SETTINGS_VECTOR_HINT_COPY);
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
    // The complaint AND the reason the box will not move (DW-280): `textRow`
    // routes its description through `describedBy`, so a read-only deployment
    // appends the save bar's sentence here the same way it does on the provider
    // pickers, rather than leaving the box announcing a complaint with no
    // explanation of why it cannot be acted on.
    expect(announcedFor(modelInput())).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_READ_ONLY_COPY}`,
    );
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

describe("the MODEL ROW says what this deployment actually embeds with (DW-312)", () => {
  function modelInput(): HTMLInputElement {
    return screen.getByLabelText("Embedding model") as HTMLInputElement;
  }

  /**
   * The substitution sentence, typed out for the same reason every other
   * sentence in this file is: the point of a mounted assertion is the string a
   * screen reader announces, and building it by calling the copy function would
   * assert only that the component calls the function.
   *
   * It names "the model that is set" rather than "the model above", because on
   * THIS surface the box beside it is empty whenever `EMBEDDING_MODEL` owns the
   * value — which is exactly the state the second case below mounts.
   */
  function substituted(model: string): string {
    return `Not in effect. This deployment embeds with ${model} — the embedding provider cannot serve the model that is set, so it uses its own default instead. Vectors are tagged with the model that produced them, so an index built with a different model needs rebuilding.`;
  }

  it("announces the substitution on the model row, naming the model IN EFFECT", async () => {
    await mount(
      payload({
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    const announced = announcedFor(modelInput());
    expect(announced).toContain(substituted("@cf/baai/bge-m3"));
    // The gate's own complaint is still here and still the only reason the box
    // is marked — the note rides beside it without changing the mark. (The
    // no-provider case below is the one that isolates "described, never marked":
    // there the gate produces nothing and the note stands alone, unmarked.)
    expect(announced).toContain(UNSUPPORTED_WORKERS_MODEL);
    // And the box is still editable: a substitution is not a refusal.
    expect(modelInput().readOnly).toBe(false);
  });

  it("rides BESIDE the env sentence and the gate complaint, not instead of them", async () => {
    // Three different questions on one row: where the value comes from, why the
    // switch will not turn on, and what is embedding right now. All three can be
    // true at once, and each is the model row's own description.
    await mount(
      payload({
        embeddingModel: null,
        envEmbeddingModel: "text-embedding-3-small",
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    // The box is EMPTY — the env owns the value — which is why the note cannot
    // point at "the model above".
    expect(modelInput().value).toBe("");
    const announced = announcedFor(modelInput());
    expect(announced).toContain(
      settingsEnvOverrideCopy("model", "text-embedding-3-small"),
    );
    expect(announced).toContain(UNSUPPORTED_WORKERS_MODEL);
    expect(announced).toContain(substituted("@cf/baai/bge-m3"));
    // An env-owned mismatch is still described-but-unmarked; the note does not
    // change that.
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
  });

  it("appears with NO provider selected, where the gate says nothing at all", async () => {
    // The state the canvas MODEL ROW was silent about. `vectorSearchFieldIssue`
    // returns the provider leg early and produces no model complaint, so before
    // this the row had nothing to say — while the deployment was quietly
    // embedding with something other than the id in the box.
    //
    // A COHERENT payload: nothing is chosen in Settings, the server
    // auto-detected Workers AI, and Workers AI cannot serve the stored OpenAI
    // id — so the id is set, something else is in effect, and they differ,
    // which is exactly what `embeddingModelAnswer` requires before it reports
    // `overridden`.
    await mount(
      payload({
        embeddingProvider: null,
        embeddingModel: "text-embedding-3-small",
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    // The note stands ALONE here — no env sentence, no gate complaint — which
    // is what isolates "described, never marked": the row is announced and the
    // box carries no `aria-invalid` at all.
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    expect(announcedFor(modelInput())).toBe(substituted("@cf/baai/bge-m3"));
  });

  it("says NOTHING when nothing is overridden", async () => {
    // The default fixture answer, pinned explicitly: a row with no complaint and
    // no substitution carries no description at all.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        embeddingModelInEffect: "@cf/baai/bge-m3",
        embeddingModelOverridden: false,
      }),
    );
    expect(modelInput().getAttribute("aria-describedby")).toBeNull();
  });

  it("WITHHOLDS the note on a half-wired payload", async () => {
    // Guarded on BOTH fields, exactly as the `/settings` sibling guards the same
    // note: a sentence with a hole where the model name goes is worse than no
    // sentence.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        embeddingModelOverridden: true,
        embeddingModelInEffect: null,
      }),
    );
    expect(modelInput().getAttribute("aria-describedby")).toBeNull();
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

describe("the PROVIDER SELECT carries the binding complaint (DW-277, DW-281)", () => {
  /**
   * The control the binding leg belongs to. Nothing on this surface binds `ai`
   * in `wrangler.jsonc`, so the leg has no control of its own — but choosing a
   * different embedding provider drops it entirely, which makes this select the
   * one place the complaint can be acted on. Which span reaches which control is
   * exactly what a node suite cannot observe.
   */
  function providerSelect(): HTMLSelectElement {
    return screen.getByLabelText("Embedding provider") as HTMLSelectElement;
  }

  const BINDING_REFUSAL =
    "Vector search needs the Cloudflare AI binding before it can be turned on.";

  it("marks and describes a STORED workers-ai selection with no binding", async () => {
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", hasWorkersAiBinding: false }),
    );
    // The select holds the value that is wrong for this deployment, and it is
    // the control that can move it — so it is the control that is marked.
    expect(providerSelect().value).toBe("workers-ai");
    expect(providerSelect().getAttribute("aria-invalid")).toBe("true");
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(BINDING_REFUSAL);
    // The NOTE rides here rather than only on the checkbox, because on this
    // control it names precisely what the control does.
    expect(announced).toContain(SETTINGS_VECTOR_BINDING_NOTE);
    // The row's standing hint is kept, not replaced.
    expect(announced).toContain(SETTINGS_VECTOR_PROVIDER_COPY);
  });

  it("describes but does NOT mark an EMBEDDING_PROVIDER-owned selection, and swaps the note", async () => {
    // The variable wins over the select in every feeder, so "choose another
    // embedding provider" is advice this control cannot follow — and marking it
    // "wrong, fix it" points at a control that cannot fix it (DW-281).
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: false,
        envEmbeddingProvider: "workers-ai",
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(settingsEnvOverrideCopy("provider", "workers-ai"));
    expect(announced).toContain(BINDING_REFUSAL);
    expect(announced).toContain(SETTINGS_VECTOR_BINDING_ENV_NOTE);
    expect(announced).toContain(
      "unset EMBEDDING_PROVIDER to choose another embedding provider",
    );
    // NOT the stored note's unconditional form, which this select cannot act on.
    expect(announced).not.toContain("or choose another embedding provider");
  });

  it("renders the STORED selection while describing the env one (DW-281)", async () => {
    // The state the env-override convention actually produces, and the only one
    // where the two can be told apart: the box edits the STORE, and the store is
    // what applies once the variable is unset — so the select goes on showing
    // OpenAI while the gate, and the sentence, are about `workers-ai`. Marking
    // the select here would point at a value that is not the one being refused.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "@cf/baai/bge-m3",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        envEmbeddingProvider: "workers-ai",
        hasWorkersAiBinding: false,
      }),
    );
    // The control still reports what a save would write…
    expect(providerSelect().value).toBe("openai");
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    // …while its description names the provider the gate is actually reading,
    // and the leg that provider is missing.
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(settingsEnvOverrideCopy("provider", "workers-ai"));
    expect(announced).toContain(BINDING_REFUSAL);
    expect(announced).toContain(SETTINGS_VECTOR_BINDING_ENV_NOTE);
    // The checkbox agrees — one rule, and the env provider is what both halves
    // of it read.
    expect(announcedFor(screen.getByLabelText("Enable vector search"))).toBe(
      `${BINDING_REFUSAL} ${SETTINGS_VECTOR_BINDING_ENV_NOTE}`,
    );
    // The stored `@cf/` id is not complained about: it is the right id FOR the
    // provider the environment forces, which is the one the gate reads.
    expect(
      (screen.getByLabelText("Embedding model") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBeNull();
  });

  it("says nothing about the binding once it exists", async () => {
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", hasWorkersAiBinding: true }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(providerSelect());
    expect(announced).toBe(SETTINGS_VECTOR_PROVIDER_COPY);
    expect(announced).not.toContain("Cloudflare AI binding");
  });

  it("stays silent for a leg that is pure ABSENCE", async () => {
    // A fresh deployment: no provider, no model, no endpoint, no key. Nothing
    // holds a wrong value, so nothing is marked and no row repeats the one
    // sentence the checkbox already carries.
    await mount(
      payload({
        embeddingProvider: null,
        embeddingModel: null,
        hasWorkersAiBinding: false,
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    expect(announcedFor(providerSelect())).toBe(SETTINGS_VECTOR_PROVIDER_COPY);
    expect(
      (screen.getByLabelText("Embedding model") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBeNull();
    expect(
      screen.getByLabelText("Embedding endpoint").getAttribute("aria-describedby"),
    ).toBeNull();
    expect(announcedFor(screen.getByLabelText("Enable vector search"))).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
  });

  it("marks the select the moment the deployment's binding is the missing leg", async () => {
    // The mirror of the model row's "the provider moved under it" case: here the
    // owner moves the provider TO the one this runtime cannot serve, and the
    // control they just touched is the one that reports it.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        hasWorkersAiBinding: false,
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(providerSelect(), { target: { value: "workers-ai" } });

    await waitFor(() =>
      expect(providerSelect().getAttribute("aria-invalid")).toBe("true"),
    );
    expect(announcedFor(providerSelect())).toContain(SETTINGS_VECTOR_BINDING_NOTE);
  });

  it("describes without marking on a read-only deployment", async () => {
    // The same suppression `textRow` applies: `YOPEDIA_READONLY` makes every
    // control here unfixable, so only the MARK is withheld.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: false,
        readOnly: true,
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(BINDING_REFUSAL);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });
});
