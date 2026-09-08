import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import {
  WORKERS_AI_EMBEDDING_MODEL_IDS,
  WORKERS_AI_MODEL_PREFIX,
  embeddingProviderLabel,
} from "@/lib/providers";
import {
  SETTINGS_KEY_ABSENT_COPY,
  SETTINGS_KEY_STORED_COPY,
  SETTINGS_READ_ONLY_COPY,
  SETTINGS_VECTOR_BINDING_ENV_NOTE,
  SETTINGS_VECTOR_BINDING_NOTE,
  SETTINGS_VECTOR_ENV_MODEL_NOTE,
  SETTINGS_VECTOR_HINT_COPY,
  SETTINGS_VECTOR_PROVIDER_COPY,
  SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
  settingsEnvOverrideCopy,
  settingsEnvProviderInvalidCopy,
  settingsEnvProviderPinCopy,
  type WorkbenchSettingsPayload,
} from "@/lib/workbench-settings";
import {
  announcedFor,
  installSettingsFetchMock,
  mountSettings,
  settingsPayload,
} from "@/test/settings-harness";

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

/**
 * The stored settings this file asserts against: the shared fixture, on Workers
 * with the vector-capable provider selected.
 *
 * Every case here selects `workers-ai`, and without `hasWorkersAiBinding` the
 * gate would refuse for a SECOND reason (DW-225) — which would change every
 * sentence asserted below and leave nothing here about the namespace at all.
 * The binding leg has its own cases at the end, which override it back off.
 *
 * AND IT SUBSTITUTES (DW-335). The base config is `workers-ai` holding the
 * shared fixture's OpenAI id, which is precisely the pair
 * `resolveEmbeddingModelName` replaces: the provider resolves (explicit
 * selection, binding present), the stored id is not a Workers AI embedding
 * model, so the resolver drops it for `@cf/baai/bge-m3` and
 * `embeddingModelAnswer` reports `overridden: true` with that in effect. The
 * fixture inherited the harness's `false`/`null` default instead, so exact
 * equality on the MODEL row pinned a description the wire never serves. Call
 * sites whose overrides remove the substitution spread {@link NOTHING_EMBEDS}
 * or {@link servesAsSet} below, whichever their own config implies.
 *
 * TWO fixtures are exempt, both of them payloads `getWorkbenchSettings` cannot
 * mint. The half-wired note guard states its own `overridden`/`inEffect` pair,
 * because that incoherence IS the case. The pin-beats-invalid guard does not:
 * it inherits the base pair, and that pair is NOT the answer its own config
 * implies — a `google` pin over `text-embedding-3-small` substitutes nothing,
 * so the truthful pair there is `servesAsSet("text-embedding-3-small")`. Nor is
 * the inherited pair inert: it reaches `SettingsCanvas.tsx:567` like any other,
 * and the substitution note really does render in that mount. What is true is
 * only that no assertion in that case reads the model row — every one of them
 * is about the provider select or the vector switch. It is left alone because
 * that fixture is out of scope here, not because the pair is right.
 */
function payload(overrides: Partial<WorkbenchSettingsPayload> = {}): WorkbenchSettingsPayload {
  return settingsPayload({
    embeddingProvider: "workers-ai",
    hasWorkersAiBinding: true,
    // Workers AI cannot serve `text-embedding-3-small`, so the resolver
    // substitutes its own default and the GET body says so (DW-335).
    embeddingModelOverridden: true,
    embeddingModelInEffect: "@cf/baai/bge-m3",
    ...overrides,
  });
}

/**
 * `overridden: false` because NOTHING EMBEDS — spread AFTER the overrides that
 * make the base pair untrue.
 *
 * `resolveEmbeddingProvider` returned `null`, so there is no provider to resolve
 * a model from and `inEffect` is genuinely absent: a stored `workers-ai` with
 * the binding off (the override is refused rather than falling through), an
 * `EMBEDDING_PROVIDER` the `isEmbeddingProvider` filter threw away, or a
 * deployment that has chosen nothing and holds no vendor key to auto-detect
 * from. This is the `embeddingSupport: false` story, and `embeddingModelAnswer`
 * reports `overridden: false` for it because `inEffect` is `null` — not because
 * anything agrees.
 */
const NOTHING_EMBEDS = {
  embeddingModelOverridden: false,
  embeddingModelInEffect: null,
} as const satisfies Partial<WorkbenchSettingsPayload>;

/**
 * `overridden: false` because the provider SERVES THE ID IT HOLDS — the other
 * way to be false, and the one that still names a model.
 *
 * A provider DOES resolve here, and `embeddingModelMatchesProvider` approves the
 * id it is handed, so `resolveEmbeddingModelName` returns that id unchanged and
 * `inEffect === model`. `embeddingModelAnswer`'s rule
 * (`overridden = model !== null && inEffect !== null && inEffect !== model`)
 * then answers `false` on the THIRD clause rather than the second — which is a
 * different deployment from {@link NOTHING_EMBEDS} even though the surface
 * renders both identically, because `SettingsCanvas.tsx:567` guards on
 * `overridden` first and never reaches the name.
 *
 * Spelled out rather than folded into a single "no substitution" pair because
 * that fold is the very class of drift DW-335 exists to remove: a fixture
 * claiming nothing is in effect, over a config where something plainly is.
 *
 * The DW-312 case "says NOTHING when nothing is overridden" writes this same
 * pair out by hand instead of calling this, because that pair IS its subject —
 * so the two are one convention stated twice, not two conventions.
 */
function servesAsSet(model: string): Partial<WorkbenchSettingsPayload> {
  return { embeddingModelOverridden: false, embeddingModelInEffect: model };
}

const fetchMock = installSettingsFetchMock();

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
function mount(stored: WorkbenchSettingsPayload) {
  return mountSettings("embeddings", stored);
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

/**
 * The substitution sentence, typed out for the same reason every other sentence
 * in this file is: the point of a mounted assertion is the string a screen
 * reader announces, and building it by calling the copy function would assert
 * only that the component calls the function.
 *
 * It names "the model that is set" rather than "the model above", because on
 * THIS surface the box beside it is empty whenever `EMBEDDING_MODEL` owns the
 * value — which is exactly the state one of the DW-312 cases below mounts.
 *
 * At MODULE scope rather than inside the DW-312 block (DW-335): the base fixture
 * substitutes, so the two exact-equality assertions in the DW-223 block above
 * carry this sentence too and would otherwise need a second copy of it.
 */
function substituted(model: string): string {
  return `Not in effect. This deployment embeds with ${model} — the embedding provider cannot serve the model that is set, so it uses its own default instead. Vectors are tagged with the model that produced them, so an index built with a different model needs rebuilding.`;
}

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
        // It substitutes in this direction too, with the OTHER default
        // (DW-335): OpenAI resolves — explicit selection, key stored — and
        // cannot serve a `@cf/` id, so `resolveEmbeddingModelName` falls back to
        // OpenAI's own default rather than to the Workers AI one the base names.
        embeddingModelOverridden: true,
        embeddingModelInEffect: "text-embedding-3-small",
      }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(OUT_OF_NAMESPACE);
    // And the model row names the OTHER default (DW-335). This is the only case
    // here that mirrors the substitution as well as the refusal: every Workers
    // AI fixture resolves to `@cf/baai/bge-m3`, so a note built from a hardcoded
    // Workers AI id rather than from the payload would pass everywhere else in
    // this file and only be wrong here.
    expect(
      announcedFor(screen.getByLabelText("Embedding model") as HTMLInputElement),
    ).toBe(`${OUT_OF_NAMESPACE} ${substituted("text-embedding-3-small")}`);
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
    // A MATCHING id, so the resolver hands it straight back and nothing is
    // substituted (DW-335) — the base pair would claim otherwise. It is still
    // IN EFFECT, though, which is why this is `servesAsSet` and not
    // `NOTHING_EMBEDS`.
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", ...servesAsSet("@cf/baai/bge-m3") }),
    );
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
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        vectorSearchEnabled: true,
        ...servesAsSet("@cf/baai/bge-m3"),
      }),
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
    // TWO sentences, because this config really does substitute (DW-335): the
    // gate's complaint about the id in the box, then what the server resolved
    // instead. The base fixture is `workers-ai` holding an OpenAI id, which is
    // exactly the pair the resolver replaces — a single-sentence pin here
    // described a payload `GET /api/settings` would never serve.
    expect(announcedFor(modelInput())).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${substituted("@cf/baai/bge-m3")}`,
    );
    // The `EMBEDDING_MODEL` note is NOT here — no variable is set, and this row
    // is about the value it edits.
    expect(announcedFor(modelInput())).not.toContain("EMBEDDING_MODEL");
  });

  it("describes an ENV-owned mismatch beside the env sentence, without marking it", async () => {
    // `EMBEDDING_MODEL` wins over the box in every feeder, so the box holds
    // nothing wrong — marking it would point the owner at a control that cannot
    // fix it. The complaint still has to be readable ON the row that is about
    // the model, which is what the description carries.
    //
    // SAME DEPLOYMENT as the DW-312 case "rides BESIDE the env sentence and the
    // gate complaint, not instead of them" — since the base gained the
    // substitution pair (DW-335) the two payloads are identical. Neither is
    // redundant: this one bounds the row with `toContain`, so it goes on holding
    // whatever else the row grows; that one owns the THIRD sentence and asserts
    // the note by name. Deleting either would drop a claim the other never makes.
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
    // NOTHING is substituted here, and that is load-bearing for the assertion
    // below rather than mere tidiness (DW-335): a matching id is what the
    // resolver returns unchanged, so the row genuinely has no third sentence.
    await mount(
      payload({ embeddingModel: "@cf/baai/bge-m3", ...servesAsSet("@cf/baai/bge-m3") }),
    );
    expect(modelInput().getAttribute("aria-invalid")).toBeNull();
    // No hint at all: with no env override and no complaint there is nothing for
    // this row to describe.
    expect(modelInput().getAttribute("aria-describedby")).toBeNull();
  });

  it("says nothing while the provider is still unchosen", async () => {
    // The gate has exactly one leg here — "an embedding provider" — and it is
    // not this row's. A model complaint before a provider is picked would be a
    // complaint about a rule that has not been reached.
    //
    // The BINDING goes off with it (DW-335). With nothing chosen and the binding
    // ON, `resolveEmbeddingProvider`'s auto-detect leg lands on `workers-ai`,
    // which cannot serve the stored OpenAI id — so the row WOULD carry the
    // substitution note and the `aria-describedby` assertion below would be
    // asserting about a payload the wire never serves. That state is a real one
    // and it already has an owner: the DW-312 case "appears with NO provider
    // selected". Here the binding is off, nothing auto-detects, no vendor key is
    // stored, so nothing embeds at all and the row is genuinely silent.
    await mount(
      payload({
        embeddingProvider: null,
        hasWorkersAiBinding: false,
        ...NOTHING_EMBEDS,
      }),
    );
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
    //
    // THREE sentences in the order the component joins them (DW-335): the row's
    // own description is `[env, gate, substitution]`, and `describedBy` APPENDS
    // the bar note after all of it — so the substitution this base fixture
    // really produces sits BETWEEN the complaint and the read-only sentence, not
    // after them.
    expect(announcedFor(modelInput())).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${substituted("@cf/baai/bge-m3")} ${SETTINGS_READ_ONLY_COPY}`,
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
        // Stored `openai` with a key resolves to OpenAI, which serves this id
        // as-is — so the config the owner starts from substitutes nothing, and
        // the id it holds is the one in effect.
        ...servesAsSet("text-embedding-3-small"),
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

  it("goes QUIET the moment the model box moves, and comes back when it is put back (DW-337)", async () => {
    // The freshness bug. The note is payload-derived — it states what the SERVER
    // resolved, which the browser cannot compute — while the two sentences
    // beside it on this row are draft-derived. So an owner correcting the model
    // read "This deployment embeds with @cf/baai/bge-m3" in the present tense,
    // about a value they had already replaced, sitting immediately after a
    // complaint that HAD moved with their edit. Two freshness contracts on one
    // row, and no way to tell which sentence belonged to which.
    await mount(
      payload({
        embeddingModel: "text-embedding-3-small",
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    expect(announcedFor(modelInput())).toContain(substituted("@cf/baai/bge-m3"));

    // Another id the gate still complains about, so the row keeps a
    // draft-derived sentence for the note's absence to be visible against.
    fireEvent.change(modelInput(), { target: { value: "text-embedding-3-large" } });
    await waitFor(() => expect(modelInput().value).toBe("text-embedding-3-large"));
    // Withheld — the server has not seen this id, so nothing here can say what
    // it would resolve to.
    expect(announcedFor(modelInput())).not.toContain("Not in effect.");
    expect(announcedFor(modelInput())).not.toContain("This deployment embeds with");
    // …while the DRAFT-derived half of the row is untouched: the gate's
    // complaint about the id now in the box is exactly the sentence that has to
    // survive, because it is the one the owner is acting on.
    expect(announcedFor(modelInput())).toContain(UNSUPPORTED_WORKERS_MODEL);

    // Put back, and the note returns without a save — the comparison is against
    // the draft the payload would seed, so "typed and undone" is clean.
    fireEvent.change(modelInput(), { target: { value: "text-embedding-3-small" } });
    await waitFor(() =>
      expect(announcedFor(modelInput())).toContain(substituted("@cf/baai/bge-m3")),
    );
  });

  it("KEEPS the note while EMBEDDING_MODEL owns the model, however the box is edited", async () => {
    // The limit of the suppression rule, and the reason it has one.
    // `embeddingModelAnswer` takes the env override in preference to the stored
    // model, so with the variable set this box is not what resolves — the
    // substitution the server reported stays true whatever is typed here, and
    // going quiet would withhold a still-true fact while the owner edits a
    // control that is not in play. The box is still editable (it writes the
    // store, which applies once the variable is unset), so the edit is real; it
    // is only the note's subject that the env has taken over.
    await mount(
      payload({
        embeddingModel: null,
        envEmbeddingModel: "text-embedding-3-small",
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    expect(announcedFor(modelInput())).toContain(substituted("@cf/baai/bge-m3"));

    fireEvent.change(modelInput(), { target: { value: "text-embedding-3-large" } });
    await waitFor(() => expect(modelInput().value).toBe("text-embedding-3-large"));
    // Still announced, beside the env sentence that explains why this box is not
    // the one the note is about.
    expect(announcedFor(modelInput())).toContain(substituted("@cf/baai/bge-m3"));
    expect(announcedFor(modelInput())).toContain(
      settingsEnvOverrideCopy("model", "text-embedding-3-small"),
    );
  });

  it("goes quiet on the PROVIDER select too, with the env sentence still on the row", async () => {
    // The other half of the resolver's input. Moving the vendor changes what
    // "in effect" would mean just as surely as retyping the id does — and this
    // is the case where the env sentence is on the row as well, so it can be
    // seen surviving while the note goes.
    await mount(
      payload({
        embeddingModel: null,
        envEmbeddingModel: "text-embedding-3-small",
        embeddingModelOverridden: true,
        embeddingModelInEffect: "@cf/baai/bge-m3",
      }),
    );
    expect(announcedFor(modelInput())).toContain(substituted("@cf/baai/bge-m3"));

    const select = screen.getByLabelText("Embedding provider") as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "openai" } });
    await waitFor(() => expect(select.value).toBe("openai"));

    const announced = announcedFor(modelInput());
    expect(announced).not.toContain("Not in effect.");
    // The env sentence is draft-independent and stays put; the gate's complaint
    // is draft-derived and has moved WITH the selection rather than vanishing.
    expect(announced).toContain(
      settingsEnvOverrideCopy("model", "text-embedding-3-small"),
    );
    // …and the gate's complaint moved WITH the selection rather than surviving
    // as the note did: it no longer names the Workers AI catalog, because
    // Workers AI is no longer what the draft selects.
    expect(announced).not.toContain(WORKERS_AI_MODEL_PREFIX);
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
    //
    // …and because it is missing, NOTHING embeds (DW-335):
    // `resolveEmbeddingProvider` refuses a `workers-ai` override without the
    // binding rather than falling through, so there is no provider to substitute
    // a default from — the `embeddingSupport: false` story, not an override one.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: false,
        ...NOTHING_EMBEDS,
      }),
    );
    const checkbox = screen.getByLabelText("Enable vector search") as HTMLInputElement;
    expect(checkbox.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(checkbox)).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // The model row is silent — the id is not what is wrong. Silent ENTIRELY:
    // with no provider resolving there is no substitution either (DW-335), so
    // the row carries no description at all rather than merely no mark.
    expect(
      (screen.getByLabelText("Embedding model") as HTMLInputElement).getAttribute(
        "aria-invalid",
      ),
    ).toBeNull();
    expect(
      (screen.getByLabelText("Embedding model") as HTMLInputElement).getAttribute(
        "aria-describedby",
      ),
    ).toBeNull();
    fireEvent.click(checkbox);
    await waitFor(() => expect(checkbox.checked).toBe(false));
    expectNoSaveAttempted();
  });

  it("allows the same selection where the binding exists", async () => {
    // Resolves, and the id MATCHES — so nothing is substituted and that id is
    // what embeds.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: true,
        ...servesAsSet("@cf/baai/bge-m3"),
      }),
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
    // Nothing resolves without the binding, so nothing embeds and nothing is
    // substituted.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: false,
        ...NOTHING_EMBEDS,
      }),
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
        // The env override is refused for the same missing binding, so nothing
        // embeds and nothing is substituted.
        ...NOTHING_EMBEDS,
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(settingsEnvProviderPinCopy("workers-ai"));
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
        // `EMBEDDING_PROVIDER` wins in the resolver too, and `workers-ai`
        // without the binding resolves to nothing — the stored OpenAI leg is
        // never reached, so nothing embeds and no default is substituted from
        // either vendor.
        ...NOTHING_EMBEDS,
      }),
    );
    // The control still reports what a save would write…
    expect(providerSelect().value).toBe("openai");
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    // …while its description names the provider the gate is actually reading,
    // and the leg that provider is missing.
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(settingsEnvProviderPinCopy("workers-ai"));
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
    // Resolves, and the id MATCHES — so nothing is substituted and that id is
    // what embeds.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: true,
        ...servesAsSet("@cf/baai/bge-m3"),
      }),
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
        // Pure absence resolves to nothing, and with no model set there would be
        // nothing for a substitution to be a substitution FOR.
        ...NOTHING_EMBEDS,
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
        // Stored `openai` with a key resolves, and OpenAI serves this id as-is —
        // so it is both set and in effect.
        ...servesAsSet("text-embedding-3-small"),
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();

    fireEvent.change(providerSelect(), { target: { value: "workers-ai" } });

    await waitFor(() =>
      expect(providerSelect().getAttribute("aria-invalid")).toBe("true"),
    );
    expect(announcedFor(providerSelect())).toContain(SETTINGS_VECTOR_BINDING_NOTE);
  });

  it("PINS the select under a valid env override, without disabling it (DW-398)", async () => {
    // `EMBEDDING_PROVIDER` wins in every feeder, so moving this box cannot
    // change which vendor embeds — but the move is NOT inert:
    // `settingsDraftAfterEmbeddingProvider` blanks the stored endpoint and key,
    // and the save deletes both. Under a pin that is a destructive edit with no
    // upside, so the row takes the same `aria-disabled` treatment
    // `researchProviderRow` applies.
    //
    // The env provider here is `google` rather than a keyless one on purpose:
    // it is a vendor that would ACTUALLY read the stored credential through
    // `embeddingApiKeyFor`, so the pair below is exactly what an unpinned move
    // would destroy — which is the hazard the pin exists for.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        envEmbeddingProvider: "google",
        hasWorkersAiBinding: false,
        // The pin resolves to `google`, which reads the stored credential — and
        // Google serves `text-embedding-3-small` as far as
        // `embeddingModelMatchesProvider` is concerned (the only thing it
        // refuses off Workers AI is a `@cf/` id), so the id stands, nothing is
        // substituted, and that id is what embeds.
        ...servesAsSet("text-embedding-3-small"),
      }),
    );
    // `aria-disabled`, never `disabled`: announced as unavailable and still
    // reachable by keyboard, which is the convention `providerRow` owns.
    expect(providerSelect().getAttribute("aria-disabled")).toBe("true");
    expect(providerSelect().disabled).toBe(false);
    // Still the STORED value — the box edits the store, which is what applies
    // the moment the variable is unset (DW-281).
    expect(providerSelect().value).toBe("openai");
    // …and the hint still says WHICH provider the environment forces.
    expect(announcedFor(providerSelect())).toContain(
      settingsEnvProviderPinCopy("google"),
    );

    fireEvent.change(providerSelect(), { target: { value: "workers-ai" } });

    // The draft never moved, so BOTH halves of the credential the env-selected
    // vendor reads are still there — the endpoint and the key. Asserting only
    // the endpoint would leave the key, which is the half that cannot be
    // retyped from memory, untested.
    await waitFor(() => expect(providerSelect().value).toBe("openai"));
    expect((screen.getByLabelText("Embedding endpoint") as HTMLInputElement).value).toBe(
      "https://embed.example",
    );
    expect(announcedFor(screen.getByLabelText("Embedding API key"))).toContain(
      SETTINGS_KEY_STORED_COPY,
    );
    expectNoSaveAttempted();
  });

  it("DESCRIBES a junk EMBEDDING_PROVIDER without pinning the select (DW-508)", async () => {
    // The state that used to produce NO owner-visible signal at all: the
    // payload's filtered `envEmbeddingProvider` is `null` for an unsupported
    // value, so the row rendered exactly as it does with no variable set —
    // while `resolveEmbeddingProvider` refused the override and nothing
    // embedded. The invalid sentence is the whole signal.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        envEmbeddingProvider: null,
        envEmbeddingProviderInvalid: "deepseek",
        hasWorkersAiBinding: false,
        // The refusal does NOT fall through to the store, so nothing embeds —
        // which is the whole point of the case, and is also why there is no
        // provider left to substitute a default from.
        ...NOTHING_EMBEDS,
      }),
    );
    const announced = announcedFor(providerSelect());
    // The rejected value is QUOTED — a typo is invisible otherwise — and the
    // remedy points at the environment, the only place it can be fixed.
    expect(announced).toContain(settingsEnvProviderInvalidCopy("deepseek"));
    expect(announced).toContain("deepseek");
    // NOT the pinned sentence, and not the standing one: exactly one of the
    // three arms renders.
    expect(announced).not.toContain(settingsEnvProviderPinCopy("deepseek"));
    expect(announced).not.toContain(SETTINGS_VECTOR_PROVIDER_COPY);
    // Editable and unmarked. The store is what applies the moment the variable
    // is corrected, so pinning here would lock the owner out of the only field
    // that will matter next (DW-398's boundary), and `aria-invalid` would blame
    // a select holding a perfectly good value.
    expect(providerSelect().getAttribute("aria-disabled")).toBeNull();
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    expect(providerSelect().value).toBe("openai");

    // …and the SWITCH is the opposite answer on the same deployment (DW-552).
    // This is the surface the ledger's first symptom was seen at: the select
    // stays open because the store is what applies once the variable is fixed,
    // but the vector rule re-JOINS the invalid value and reads `deepseek`, so
    // the switch is refused. It used to read as satisfiable here — every leg met
    // by the stored OpenAI config — while the route stored `true` and nothing
    // embedded.
    const vectorSwitch = screen.getByLabelText(
      "Enable vector search",
    ) as HTMLInputElement;
    expect(vectorSwitch.getAttribute("aria-disabled")).toBe("true");
    expect(announcedFor(vectorSwitch)).toBe(
      "Vector search needs an embedding provider before it can be turned on. " +
        SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
    );
    // The variable is named at most ONCE PER DESCRIPTION (DW-636). Twice on the
    // SCREEN is the design — the checkbox carries the note because it has no row
    // of its own, and the row carries `settingsEnvProviderInvalidCopy` because
    // the checkbox cannot quote the rejected value. What is ruled out is one
    // hint saying `EMBEDDING_PROVIDER` twice, which is what appending the note
    // to this row's own complaint would do.
    expect(announced).not.toContain(SETTINGS_VECTOR_PROVIDER_ENV_NOTE);
    // Split rather than `match`: a `String.match` with no hit answers `null` and
    // fails as an opaque TypeError, where this fails with the count.
    expect(announced.split("EMBEDDING_PROVIDER")).toHaveLength(2);
    // CLICKED, not merely inspected: "the owner cannot turn it on" is a claim
    // about the handler, and `aria-disabled` alone would pass even if `onChange`
    // stopped consulting the refusal.
    fireEvent.click(vectorSwitch);
    await waitFor(() => expect(vectorSwitch.checked).toBe(false));
    expectNoSaveAttempted();

    // The select, meanwhile, still writes — the two answers coexist, which is
    // the whole point of keeping the PIN and the RULE separate reads.
    fireEvent.change(providerSelect(), { target: { value: "google" } });

    await waitFor(() => expect(providerSelect().value).toBe("google"));
  });

  it("lets the PIN win over an invalid value if a payload ever carries both", async () => {
    // `getWorkbenchSettings` cannot mint this pair — the invalid string is
    // precisely what the `isEmbeddingProvider` filter threw away, so it is
    // non-null only where the filtered field is `null`. But the payload is a
    // WIRE type, and the unguarded read announced "Nothing will embed until the
    // environment is corrected" beside a select the pin had just disabled: an
    // instruction about a control the owner cannot touch, which is the one
    // combination worth ruling out in code rather than in a comment.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        envEmbeddingProvider: "google",
        envEmbeddingProviderInvalid: "deepseek",
        hasWorkersAiBinding: false,
      }),
    );
    const announced = announcedFor(providerSelect());
    // The PIN's sentence, because the pin is what the controls are rendering.
    expect(announced).toContain(settingsEnvProviderPinCopy("google"));
    expect(announced).not.toContain(settingsEnvProviderInvalidCopy("deepseek"));
    expect(announced).not.toContain("deepseek");
    expect(providerSelect().getAttribute("aria-disabled")).toBe("true");
    // …and the RULE takes the pin too, not the invalid twin (DW-552): with
    // `google` winning, every leg is met and the switch is offered. Had the
    // ordering gone the other way, this deployment would render a refused switch
    // beside a select pinned to a perfectly good vendor.
    const vectorSwitch = screen.getByLabelText(
      "Enable vector search",
    ) as HTMLInputElement;
    expect(vectorSwitch.getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(vectorSwitch)).not.toContain("needs an embedding provider");
  });

  it("leaves an UNPINNED select editable, still applying the three-field rule", async () => {
    // The unchanged half: with no env override the select writes, and moving it
    // to another vendor blanks the endpoint and the key that belonged to the
    // one being left behind (DW-69/DW-72). Both halves again, in the other
    // direction — the pin above is only meaningful because this is what it is
    // holding back.
    await mount(
      payload({
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://embed.example",
        hasEmbeddingApiKey: true,
        envEmbeddingProvider: null,
        // Stored `openai` with a key resolves, and OpenAI serves this id as-is —
        // so it is both set and in effect.
        ...servesAsSet("text-embedding-3-small"),
      }),
    );
    expect(providerSelect().getAttribute("aria-disabled")).toBeNull();
    expect(announcedFor(screen.getByLabelText("Embedding API key"))).toContain(
      SETTINGS_KEY_STORED_COPY,
    );

    fireEvent.change(providerSelect(), { target: { value: "google" } });

    await waitFor(() => expect(providerSelect().value).toBe("google"));
    expect((screen.getByLabelText("Embedding endpoint") as HTMLInputElement).value).toBe(
      "",
    );
    expect(announcedFor(screen.getByLabelText("Embedding API key"))).toContain(
      SETTINGS_KEY_ABSENT_COPY,
    );
  });

  it("describes without marking on a read-only deployment", async () => {
    // The same suppression `textRow` applies: `YOPEDIA_READONLY` makes every
    // control here unfixable, so only the MARK is withheld.
    await mount(
      payload({
        embeddingModel: "@cf/baai/bge-m3",
        hasWorkersAiBinding: false,
        readOnly: true,
        // Nothing resolves without the binding, so nothing embeds and nothing is
        // substituted.
        ...NOTHING_EMBEDS,
      }),
    );
    expect(providerSelect().getAttribute("aria-invalid")).toBeNull();
    const announced = announcedFor(providerSelect());
    expect(announced).toContain(BINDING_REFUSAL);
    expect(announced).toContain(SETTINGS_READ_ONLY_COPY);
  });
});
