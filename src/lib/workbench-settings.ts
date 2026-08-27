/**
 * The Workbench Settings surface's vocabulary and every decision it makes.
 *
 * Pure and client-safe, the same posture as `workbench-modes.ts` (vocabulary +
 * copy) and `workbench-preview.ts` (decisions + one fetch/save client taking an
 * injectable `fetchImpl`): the route imports it on the server, `SettingsCanvas`
 * imports it in the browser, and the node suite EXECUTES it.
 *
 * That last part is the whole reason the module exists. That suite is vitest's
 * `node` project (`environment: "node"`, `*.test.ts`) — it mounts nothing and
 * loads no testing-library — so any rule that lives inside a React effect can
 * only ever be grepped for there. "Which categories exist", "may vector search
 * be enabled", "what does Save actually send", and "which sentence does a
 * rejected save show" are exactly the rules a rewrite keeps the wording of
 * while changing the behaviour, so all four are functions here rather than
 * branches typed into JSX.
 *
 * It restates no provider list: {@link PROVIDER_INFO} and
 * {@link EMBEDDING_PROVIDERS} come from `providers.ts`, which is already
 * client-safe by its own header comment.
 */

import {
  EMBEDDING_PROVIDERS,
  PROVIDER_INFO,
  WORKERS_AI_MODEL_PREFIX,
  WORKERS_AI_EMBEDDING_MODEL_IDS,
  embeddingModelMatchesProvider,
  embeddingProviderLabel,
  isEmbeddingProvider,
  VALID_PROVIDERS,
} from "./providers";
import type { EmbeddingProvider, ProviderValue } from "./providers";
import {
  LOOPBACK_BASE_URL,
  LOOPBACK_TOKEN_ENV,
  type LoopbackTokenSource,
} from "./v1-contract";
import {
  refusedWriteFailure,
  thrownWriteFailure,
  unconfirmedCause,
} from "./workbench-request";
import { IF_MATCH_HEADER, formatIfMatch } from "./write-precondition";

// ---------------------------------------------------------------------------
// The category vocabulary
// ---------------------------------------------------------------------------

export type SettingsCategoryId =
  | "general"
  | "llm-models"
  | "embeddings"
  | "intake"
  | "mineru"
  | "external-sources"
  | "api-mcp"
  | "interface"
  | "about";

export interface SettingsCategory {
  id: SettingsCategoryId;
  /** Nav row text, the detail heading, and the half of the announcement that moves. */
  label: string;
  /**
   * The one muted sentence a category with no fields yet shows, or `null` when
   * the category has controls. A listed-but-unbuilt category renders exactly one
   * sentence — no illustration, no emoji, no encouragement (UX-DR15 / UX-DR23) —
   * because a nav row that rendered nothing would be a dead link, and one that
   * rendered a stub would be a lie about what works.
   */
  pending: string | null;
}

/**
 * Nav order, top → bottom. EVERY category carries content now: Story 1.9 built
 * six, Epic 7's Stories 7.5 / 7.2 built Intake and MinerU PDF, and Story 8.1
 * built API + MCP — which was the last `pending` one.
 *
 * `pending` STAYS in the type and in {@link SettingsCategory}. It is the rule
 * for a listed-but-unbuilt category (one muted sentence, no stub), and deleting
 * the mechanism because nothing uses it today would mean the next category
 * added ahead of its controls either renders nothing (a dead nav row) or
 * renders a stub (a lie about what works).
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "general", label: "General", pending: null },
  { id: "llm-models", label: "LLM Models", pending: null },
  { id: "embeddings", label: "Embeddings", pending: null },
  { id: "intake", label: "Intake", pending: null },
  { id: "mineru", label: "MinerU PDF", pending: null },
  { id: "external-sources", label: "External Sources", pending: null },
  // Story 8.1. The sentence this used to carry — "Local API and MCP settings
  // arrive with the sidecar." — was true for exactly as long as the pane had no
  // enable switch, no token and no copyable MCP config. It has all three now,
  // so keeping the sentence would be the lie in the other direction.
  { id: "api-mcp", label: "API + MCP", pending: null },
  { id: "interface", label: "Interface", pending: null },
  { id: "about", label: "About", pending: null },
] as const;

export const DEFAULT_SETTINGS_CATEGORY: SettingsCategoryId = "general";

export function settingsCategory(id: SettingsCategoryId): SettingsCategory {
  // The union guarantees a hit; the fallback keeps the return type honest.
  return SETTINGS_CATEGORIES.find((category) => category.id === id) ?? SETTINGS_CATEGORIES[0];
}

/**
 * What the shell's live region says when Settings opens or the category moves
 * (EXPERIENCE.md:175 — a surface change announces the surface name).
 */
export function settingsAnnouncement(label: string): string {
  return `Settings, ${label}`;
}

// ---------------------------------------------------------------------------
// Copy — every user-visible sentence the surface can show
// ---------------------------------------------------------------------------

/** The rail control and the surface's own name. */
export const SETTINGS_LABEL = "Settings";

/**
 * WHICH Settings surface a sentence is being written for (DW-327, DW-329).
 *
 * There are two, and they are not the same shape. `"workbench"` is the
 * {@link SETTINGS_CATEGORIES} surface, which renders a control for every field
 * this module knows about — the DEFAULT everywhere, so nothing that does not
 * ask for the other one changes. `"flat"` is the legacy `/settings` page, which
 * renders the primary provider/model pair and the embedding MODEL box and
 * nothing else: no embedding provider, no embedding endpoint, no embedding key,
 * and no vector switch.
 *
 * It selects only WHICH SENTENCE a state produces, never WHETHER that state is
 * a refusal — {@link canEnableVectorSearch} stays the one rule both surfaces
 * answer identically. A sentence that told the owner of the flat page to flip a
 * switch that page does not render would name an action they cannot take from
 * where they are standing, which is the same dead end DW-303 closed for the
 * legs.
 */
export type SettingsSurface = "workbench" | "flat";

/**
 * "Workbench Settings → LLM Models" — where a sentence rendered on the FLAT
 * page sends an owner, which is a different surface from the one they are on.
 *
 * NAMED IN FULL, and that is the whole point. `SETTINGS_CATEGORIES` is the nav
 * of the Workbench's `SettingsCanvas` and exists nowhere else: the app's own
 * "Settings" nav row (`src/components/NavHeader.tsx:197`, `:322`) routes to
 * `/settings`, the legacy flat page, whose `<h1>` also reads "Settings". So a
 * bare "Settings → LLM Models" rendered on `/settings` reads as a path INSIDE
 * the page the owner is already standing on — a dead end of exactly the kind
 * DW-329 exists to close, rather than a way out of one. The surface word is
 * what disambiguates the two.
 *
 * Only that word is typed. The CATEGORY half stays derived from
 * {@link settingsCategory}, so the nav row, the detail heading and every
 * pointer at that category remain the same one string and renaming a category
 * cannot leave a sentence naming something the nav no longer shows.
 *
 * `src/lib/llm.ts` keeps its shorter "Settings → LLM Models" and now composes it
 * HERE (DW-369), by passing {@link SETTINGS_LABEL} as `surfaceLabel`. The
 * SURFACE half still differs on purpose — those are RUNTIME errors, raised from
 * the LLM call rather than rendered on a Settings page, so the ambiguity the
 * full name resolves does not arise there and the two are deliberately not the
 * same string. The CATEGORY half is no longer hand-typed anywhere: llm.ts used
 * to spell "LLM Models" in five throw sites, so renaming the category left five
 * runtime messages naming a nav row that no longer exists. A label parameter
 * rather than a second exported function, because the two forms differ in
 * exactly one leading word and splitting them would reintroduce the drift this
 * helper exists to prevent.
 *
 * `surfaceLabel` defaults to {@link WORKBENCH_SETTINGS_LABEL}, which is declared
 * BELOW this function: a default parameter is evaluated at call time, and the
 * only module-level call (`SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY`) runs after that
 * declaration.
 */
export function settingsPointer(
  id: SettingsCategoryId,
  surfaceLabel: string = WORKBENCH_SETTINGS_LABEL,
): string {
  return `${surfaceLabel} → ${settingsCategory(id).label}`;
}

/**
 * The OTHER Settings surface, by the name the flat page has to call it.
 *
 * Composed from {@link SETTINGS_LABEL} rather than spelled out, so the two
 * surfaces cannot end up with different words for "Settings".
 */
const WORKBENCH_SETTINGS_LABEL = `Workbench ${SETTINGS_LABEL}`;

/** The sticky save bar's standing sentence (UX-DR14 / `epic-1-context.md:53`). */
export const SETTINGS_SAVE_BAR_COPY = "Changes apply after saving";

export const SETTINGS_SAVE_COPY = "Save";
export const SETTINGS_SAVING_COPY = "Saving…";
export const SETTINGS_LOADING_COPY = "Loading…";

/**
 * The read failed or was refused. Deliberately identical for "gated out" and
 * "absent": the route answers a non-owner with the same 404 it answers a missing
 * resource with, so the surface must not be able to tell the owner which it was.
 */
export const SETTINGS_LOAD_FAILED_COPY = "Settings couldn’t be loaded.";

/**
 * The save was refused or never landed. Used only as the FALLBACK — a sentence
 * the server supplied is always preferred, because only the server knows whether
 * it was a 403, a 404 or a validation refusal. A THROWN error never reaches the
 * owner: `Failed to fetch` and `signal timed out` are transport vocabulary that
 * no Copy table contains and that names the mechanism rather than the failure.
 */
export const SETTINGS_SAVE_FAILED_COPY = "Settings couldn’t be saved.";

/**
 * The ACTION phrase, for the one sentence `workbench-request` composes when the
 * save's outcome is unknown (DW-376).
 *
 * A phrase and not a sentence: the fallback above and the unknown-outcome
 * sentence are two renderings of one fact, and passing both from the surface is
 * where they would start to disagree. The fallback claims the save did NOT
 * land, which is exactly the claim an unknown outcome cannot make.
 */
export const SETTINGS_SAVE_ACTION = "save these settings";

/** The polite status line after a landed save. */
export const SETTINGS_SAVED_COPY = "Settings saved.";

/** `YOPEDIA_READONLY=1`: the store refuses writes deployment-wide. */
export const SETTINGS_READ_ONLY_COPY =
  "Settings are read-only in this deployment.";

/** Secret fields: what the owner sees instead of a key, and how to drop one. */
export const SETTINGS_KEY_STORED_COPY = "A key is stored.";
export const SETTINGS_KEY_ABSENT_COPY = "No key is stored.";
export const SETTINGS_KEY_REMOVE_COPY = "Remove";
export const SETTINGS_KEY_REMOVE_PENDING_COPY = "The stored key is removed on save.";
export const SETTINGS_KEY_UNDO_COPY = "Keep the stored key";
/**
 * A password field that shows nothing cannot tell "leave it alone" from "delete
 * it", so the placeholder says which of the two an empty box means.
 */
export const SETTINGS_KEY_PLACEHOLDER = "Leave blank to keep the stored key";

/** General points at the Schema editor; it writes nothing itself (DW-58). */
export const SETTINGS_GENERAL_SCHEMA_COPY =
  "Edit this Wiki’s Schema from the Files tab in the Wiki mode — select schema.md and press Edit.";

/** The one workload-inheritance sentence, shown under both model pickers. */
export const SETTINGS_MODEL_INHERIT_COPY =
  "Leave the provider unset to inherit the primary provider and model.";

/** The Custom provider needs an endpoint before it can be constructed. */
export const SETTINGS_CUSTOM_ENDPOINT_COPY =
  "Custom uses an OpenAI-compatible endpoint. Set the base URL and the API key below.";

/**
 * The same fact, said on the surface that has no such fields (DW-61).
 *
 * The flat `/settings` page offers `Custom` in its provider picker and renders
 * neither a base URL nor an API key anywhere, so a save made there stored a
 * provider `src/lib/llm.ts` then refused to construct — three runtime errors
 * pointing at fields the owner had just failed to find. The picker keeps the
 * option (the flat page is where the primary provider is chosen, and removing
 * it would make an already-stored `custom` unrepresentable in its own picker);
 * what changes is that the page now says WHERE the other two halves live,
 * instead of only saying so once the next LLM call has already failed.
 *
 * "below" becomes the pointer, and the pointer is the SAME destination
 * `src/lib/llm.ts:287-301` names — one place to go, whichever half of the
 * product told you to go there. It DESCRIBES: no `aria-invalid`, and the save
 * is not blocked (the DW-274 override note's convention).
 */
export const SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY = `Custom uses an OpenAI-compatible endpoint. Set the base URL and the API key in ${settingsPointer("llm-models")}.`;

/**
 * The ONE name this module gives `workers-ai` (DW-222).
 *
 * The picker renders `embeddingProviderLabel(option)`, so a refusal that typed
 * the name instead described the same selection under a second name on the same
 * screen. Deriving it means the two cannot drift.
 */
const WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai");

/**
 * Shown when the control is ENABLED. When it is not, the sentence is
 * {@link vectorSearchMissingCopy}'s, which names the legs the SELECTED provider
 * is actually missing — Ollama and Workers AI supply their own transport, so
 * demanding an endpoint and a key from them would send the owner looking for a
 * credential that does not exist.
 */
export const SETTINGS_VECTOR_HINT_COPY =
  "Vector search is off by default. Keyword search works without it.";

/**
 * Why the embedding provider is not optional here even though embeddings
 * themselves auto-detect one. See {@link canEnableVectorSearch}.
 */
export const SETTINGS_VECTOR_PROVIDER_COPY =
  "Vector search needs the embedding provider chosen explicitly, not auto-detected.";

/**
 * The second sentence of a model refusal the ENVIRONMENT owns (DW-218).
 *
 * `EMBEDDING_MODEL` wins over anything typed or stored in all three feeders, so
 * a refusal that named only the namespace sent the owner to a box whose value
 * the gate never reads: they type a supported `@cf/` id, save successfully, and
 * the switch still will not turn on. Naming the VARIABLE is the only form of
 * this sentence an owner can act on. It NAMES the Embedding model box rather
 * than saying "here", because it rides on the CHECKBOX's sentence rather than on
 * the model field's — the model row already carries
 * {@link settingsEnvOverrideCopy} saying where that value comes from, and "here"
 * read from the checkbox would point at the checkbox.
 */
export const SETTINGS_VECTOR_ENV_MODEL_NOTE =
  "That value comes from EMBEDDING_MODEL, so a model typed in the Embedding model box cannot lift this until that variable is unset.";

/**
 * The second sentence of the Workers AI BINDING refusal (DW-225).
 *
 * `workers-ai` is self-transporting — it needs no endpoint and no key — but the
 * transport it carries is the Cloudflare `AI` binding, which exists only on the
 * Workers runtime. Off Workers `resolveEmbeddingProvider` returns `null` for
 * it forever, so a switch the gate let the owner turn on would embed nothing,
 * silently, on every Docker deployment. The sentence names the binding and the
 * two ways out.
 */
export const SETTINGS_VECTOR_BINDING_NOTE = `${WORKERS_AI_LABEL} embeds through the Cloudflare AI binding, which exists only on the Workers runtime — bind ai in wrangler.jsonc, or choose another embedding provider.`;

/**
 * The same refusal where `EMBEDDING_PROVIDER` owns the selection (DW-281).
 *
 * {@link SETTINGS_VECTOR_BINDING_NOTE}'s second way out — "choose another
 * embedding provider" — is advice the owner CANNOT follow when the environment
 * forces `workers-ai`: every feeder takes `EMBEDDING_PROVIDER` ahead of the
 * stored selection, so a different provider picked in the box changes nothing
 * and the switch stays refused. Worse, this note rides on the provider SELECT
 * itself, so the sentence would be telling the control to do the one thing it
 * cannot. Naming the VARIABLE is what turns that way out back into an action:
 * unset it FIRST, and then the select works again.
 *
 * What the sentence deliberately does NOT do is explain that the variable wins
 * over the box — {@link settingsEnvOverrideCopy} says exactly that, and it is
 * already the provider row's standing hint, so the two ride on the same control
 * and the owner would hear one fact twice. That is the same duplication the
 * `"model"` exception in {@link vectorSearchFieldIssue} exists to prevent.
 */
export const SETTINGS_VECTOR_BINDING_ENV_NOTE = `${WORKERS_AI_LABEL} embeds through the Cloudflare AI binding, which exists only on the Workers runtime — bind ai in wrangler.jsonc, or unset EMBEDDING_PROVIDER to choose another embedding provider.`;

/**
 * The environment's overrides, said out loud.
 *
 * `EMBEDDING_PROVIDER`, `EMBEDDING_MODEL` and `LLM_CUSTOM_BASE_URL` win at
 * runtime and a save cannot move them, so without these an owner reads an EMPTY
 * box beside a control that is somehow already satisfied, types a value into it,
 * saves successfully, and nothing changes. The FREE-TEXT boxes this rides on —
 * `model` and `customBaseUrl` — are not disabled, because their stored value is
 * still what applies if the variable is ever unset and typing it now is a
 * useful thing to do; so for them the sentence has to carry the whole
 * explanation on its own.
 *
 * The `provider` kind is where that stops being true, and it is a boundary
 * rather than a retraction: the embedding PROVIDER select is `aria-disabled`
 * under its pin (DW-398). Editing it is not "store a value that waits its turn"
 * — `settingsDraftAfterEmbeddingProvider` also blanks the stored embedding
 * endpoint and key, and the save then deletes them, so under an
 * `EMBEDDING_PROVIDER` pin an edit that cannot change which vendor embeds can
 * still destroy the credential that vendor is using. The sentence stays that
 * row's hint either way: pinned or not, it is still the only thing that says
 * the variable wins.
 *
 * ONE sentence for all three (DW-71). The endpoint's story is the embedding
 * model's story with a different variable name: `getCustomBaseUrl()` takes
 * `LLM_CUSTOM_BASE_URL` ahead of the store exactly as the embedding resolvers
 * take `EMBEDDING_MODEL`, and the Custom base URL box shows the STORE. A second
 * wording for the same fact would be two sentences to keep in step.
 */
const ENV_OVERRIDE_VARIABLES = {
  provider: "EMBEDDING_PROVIDER",
  model: "EMBEDDING_MODEL",
  customBaseUrl: "LLM_CUSTOM_BASE_URL",
} as const;

export function settingsEnvOverrideCopy(
  kind: keyof typeof ENV_OVERRIDE_VARIABLES,
  value: string,
): string {
  const variable = ENV_OVERRIDE_VARIABLES[kind];
  return `The environment sets ${variable}=${value}, and that wins at runtime. What you save here applies only once that variable is unset.`;
}

/**
 * Why an Ollama endpoint was thrown away — ONE sentence per source (DW-402).
 *
 * `getOllamaBaseUrl` refuses a value that is not an absolute `http(s)` URL and
 * falls through to nothing, which is the honest resolution but a SILENT one:
 * the only trace was a `logger.warn` line, so an owner who set
 * `OLLAMA_BASE_URL=localhost:11434` read "no provider configured" beside a help
 * panel advertising that very variable, and the settings page showed an empty
 * endpoint box beside a `none` badge. Nothing on either surface said the value
 * had been seen and rejected.
 *
 * So the sentence is a VALUE, minted here and used THREE ways: as the
 * `warnOnceAbout` message, as `ProviderInfo.ollamaBaseUrlIssue` (the env leg)
 * and as `EffectiveSettings.ollamaBaseUrlIssue` (the full ladder). One wording
 * for the log and for both screens is what stops the server operator's line and
 * the owner's line from drifting into two different explanations of one fact —
 * the same reason {@link settingsEnvOverrideCopy} is one function for three
 * variables.
 *
 * It lives HERE, not in `config.ts`, because two of the three readers are
 * client components: this module is client-safe by its own header comment and
 * `config.ts` is not, so importing the other way round would drag the config
 * store into the browser bundle.
 *
 * WHAT TO SET INSTEAD is part of the sentence. "Not an absolute http(s) URL" is
 * the rule, not the remedy, and the value that fails it is nearly always one
 * scheme short — so the sentence shows the shape that would have been accepted
 * rather than leaving the owner to infer it.
 *
 * THE EXAMPLE TRACKS `ProviderForm`'s PLACEHOLDER, which is the box this
 * sentence renders directly beneath, and `README.md`'s provider table, which
 * documents the same variable. Showing `http://localhost:11434` beside a field
 * prompting `http://localhost:11434/api` would make the remedy and the example
 * disagree about the path, on one screen, for one setting — so if that
 * placeholder ever changes, this changes with it.
 */
export function ollamaBaseUrlRefusedCopy(
  source: "env" | "config",
  value: string,
): string {
  // The two sources are two different things to fix and the wording says which:
  // the env leg names the VARIABLE, the store leg says "stored". Never both —
  // `config.test.ts` partitions the warn lines on exactly those two tokens.
  return source === "env"
    ? `OLLAMA_BASE_URL is not an absolute http(s) URL (${value}), so it is ignored — set it to a full address such as http://localhost:11434/api.`
    : `The stored Ollama endpoint is not an absolute http(s) URL (${value}), so it is ignored — save a full address such as http://localhost:11434/api.`;
}

/**
 * What this deployment is EMBEDDING with, when that is not the model that is set
 * (DW-274, DW-312).
 *
 * A DERIVED-SERVER fact, unlike everything else on this row: the environment
 * sentence above says where a value came from, {@link vectorSearchFieldIssue}
 * says why the vector switch will not turn on, and this says what the embed path
 * is doing right now. All three can be true at once and each is a different
 * question, so this composes with them rather than replacing either.
 *
 * NOT shared verbatim with `EmbeddingSettings.tsx`, which says the same thing on
 * the flat `/settings` page. That one is JSX — a `<p>` beneath the field, with
 * the model name in a `<span className="font-mono">` — and it can say "the model
 * above" because it sits directly under a box that always shows the value it
 * means. Here the sentence is a plain string joined into the row's own
 * `aria-describedby` hint, after whatever else that hint already carries, and
 * the box beside it shows the STORED model, which is EMPTY whenever
 * `EMBEDDING_MODEL` owns the value. So this wording names "the model that is
 * set" rather than pointing at a control, and carries no markup at all. Two
 * surfaces, one fact, two sentences shaped for where they are read.
 */
export function settingsModelSubstitutedCopy(modelInEffect: string): string {
  return (
    `Not in effect. This deployment embeds with ${modelInEffect} — the ` +
    "embedding provider cannot serve the model that is set, so it uses its own " +
    "default instead. Vectors are tagged with the model that produced them, so " +
    "an index built with a different model needs rebuilding."
  );
}

/** Said where a key comes from the environment rather than from this store. */
export function settingsEnvKeyCopy(providerName: string): string {
  return `${providerName} supplies its API key from the environment; nothing needs to be stored here.`;
}

/**
 * External Sources: the optional Capture credential.
 *
 * REWORDED for Epic 6. It used to say the key was "stored for Deep Research",
 * which is now false in a way that matters: Deep Research searches through
 * Tavily / SerpApi / SearXNG (AD-18) and Firecrawl is not one of them, so an
 * owner who stored only a Firecrawl key and read that sentence would believe
 * Deep Research was configured and get a visible start refusal instead.
 */
export const SETTINGS_FIRECRAWL_COPY =
  "Firecrawl is an optional Capture credential for fetching pages; it is not a Deep Research search provider.";

// ---------------------------------------------------------------------------
// Deep Research providers (Epic 6 / AD-18)
// ---------------------------------------------------------------------------

/**
 * The three selectable Deep Research search providers, in select order.
 *
 * Firecrawl is deliberately absent — see {@link SETTINGS_FIRECRAWL_COPY}. The
 * vocabulary lives HERE rather than in `research-providers.ts` because this
 * module is client-safe and `SettingsCanvas` renders the select; the kernel
 * module imports the type back from here so there is one list, not two.
 */
export const RESEARCH_PROVIDERS = ["tavily", "serpapi", "searxng"] as const;

export type ResearchProviderId = (typeof RESEARCH_PROVIDERS)[number];

/** Tavily out of the box (`epic-6-context.md:23`). */
export const DEFAULT_RESEARCH_PROVIDER: ResearchProviderId = "tavily";

export function isResearchProviderId(value: unknown): value is ResearchProviderId {
  return (
    typeof value === "string" &&
    (RESEARCH_PROVIDERS as readonly string[]).includes(value)
  );
}

const RESEARCH_PROVIDER_LABELS: Record<ResearchProviderId, string> = {
  tavily: "Tavily",
  serpapi: "SerpApi",
  searxng: "SearXNG",
};

export function researchProviderLabel(provider: ResearchProviderId): string {
  return RESEARCH_PROVIDER_LABELS[provider];
}

/** SerpApi's default engine — today's hardcoded value, now editable. */
export const DEFAULT_SERPAPI_ENGINE = "google";

export const SETTINGS_RESEARCH_COPY =
  "Deep Research searches with one provider at a time. Missing credentials for the selected provider fail the run visibly — no other provider is used in its place.";

export const SETTINGS_RESEARCH_PROVIDER_LABEL = "Deep Research provider";

export const SETTINGS_INVALID_RESEARCH_PROVIDER_COPY =
  "Choose Tavily, SerpApi, or SearXNG as the Deep Research provider.";

/**
 * Said beside the select when the SELECTED provider carries no credential.
 *
 * A sentence rather than a disabled option: the owner may be selecting the
 * provider precisely so they can then paste its key, and a select that refuses
 * the row it is about to configure is a dead end.
 */
export function researchProviderUnconfiguredCopy(
  provider: ResearchProviderId,
): string {
  const needed =
    provider === "searxng"
      ? "an instance URL"
      : "an API key";
  return `${researchProviderLabel(provider)} has no ${needed} yet, so Deep Research cannot start. Supply it below.`;
}

// ---------------------------------------------------------------------------
// Intake and MinerU PDF (Stories 7.5 / 7.2)
// ---------------------------------------------------------------------------

/**
 * How PDFs the built-in extractor cannot read are handled.
 *
 * The vocabulary lives HERE, in the client-safe module, for the same reason
 * {@link RESEARCH_PROVIDERS} does: `SettingsCanvas` renders the select in the
 * browser, and `extract-settings.ts` — which reads the stored value through
 * `loadConfig` and therefore cannot be imported by a browser bundle — imports
 * the type and the list back from here. One list, not two.
 *
 * ORDERED PRIVATE-FIRST on purpose: `local` keeps documents on the machine,
 * `cloud` does not.
 */
export type MinerUMode = "off" | "local" | "cloud" | "pipeline";

export const MINERU_MODES: readonly MinerUMode[] = [
  "off",
  "local",
  "cloud",
  "pipeline",
];

export function isMinerUMode(value: unknown): value is MinerUMode {
  return MINERU_MODES.includes(value as MinerUMode);
}

/**
 * The mode a first enablement lands on.
 *
 * NOT `cloud`: the owner who has just ticked the box has not yet been asked
 * whether their documents may leave the machine, so the answer cannot be
 * "yes" by default.
 */
export const MINERU_FIRST_MODE: MinerUMode = "local";

/** Where a local MinerU install listens when the owner has not said otherwise. */
export const MINERU_DEFAULT_LOCAL_BASE_URL = "http://127.0.0.1:8000";

/**
 * The warning beside a Cloud (or Pipeline) selection, in orange, BEFORE Save
 * applies it.
 *
 * One constant so the pane and the test read the same sentence: the point of
 * the warning is that it is the same words every time the owner meets this
 * choice.
 */
export const MINERU_CLOUD_WARNING_COPY =
  "Cloud mode uploads documents to MinerU. They leave this machine.";

/**
 * Does this mode send documents off the machine?
 *
 * ONLY `cloud`. `pipeline` was treated as leaving too, on the assumption that a
 * MinerU-hosted mode was hiding behind the name — but the implementation says
 * otherwise: `sidecar/mineru.mjs` sends `local` and `pipeline` to the SAME
 * `POST /file_parse` on the owner's own MinerU server, differing only in the
 * `backend` form field. Warning about an upload that does not happen is not the
 * safe direction it looks like: an owner who is shown the orange sentence for a
 * loopback request learns that the sentence does not mean what it says, and
 * then discounts it on the one mode where it is true.
 */
export function mineruLeavesMachine(mode: MinerUMode): boolean {
  return mode === "cloud";
}

/**
 * What the Intake pane says about the inbound address, in its two states.
 *
 * INBOUND-ADDRESS ONLY, and the copy says so. This door is a Cloudflare Email
 * Routing Worker forwarding to `POST /api/email/ingest`; it is not a connected
 * mailbox, and an owner who read "email" here and went looking for an IMAP
 * login would be looking for something this build deliberately does not have.
 */
export const SETTINGS_INTAKE_EMAIL_COPY =
  "Mail sent to this address becomes Sources. It is a forwarding address, not a connected mailbox — nothing is read from your inbox.";
export const SETTINGS_INTAKE_EMAIL_UNSET_COPY =
  "No inbound address is configured yet.";
export const SETTINGS_INTAKE_EMAIL_DISABLED_COPY =
  "Inbound email is switched off, so mail sent to this address is refused.";
export const SETTINGS_INTAKE_EMAIL_LABEL = "Inbound address";
export const SETTINGS_INTAKE_COPY_ADDRESS = "Copy";
export const SETTINGS_INTAKE_COPIED_COPY = "Address copied.";

/**
 * The heading over the accepted-format grid, and the sentence under it.
 *
 * The grid itself is derived from {@link INTAKE_FORMAT_GROUPS} rather than
 * typed here — a hand-written list of formats beside a programmatic door is
 * exactly the prose/inventory drift `prose-inventory-parity.test.ts` exists to
 * catch, and this pane is the most tempting place in the app to write one.
 */
export const SETTINGS_INTAKE_FORMATS_HEADING = "Accepted files";
/**
 * THE THREE DOORS DO NOT ACCEPT THE SAME THINGS, and the sentence has to say
 * so. It used to read "dropped on the Workbench, mailed in, or posted to the
 * API" over a grid that includes images, video and audio — none of which the
 * other two doors take: both gate on `isSupportedDocument`, whose allowlist is
 * `DOCUMENT_FORMATS`, and a mailed PNG is silently counted as a skipped
 * attachment. An owner reading the old sentence would have concluded their
 * mail was lost.
 */
export const SETTINGS_INTAKE_FORMATS_COPY =
  "Anything on this list can be dropped on the Workbench. Email and the API take the document formats only — images, video and audio arrive by drop.";

/**
 * What Intake says about Plaud (Story 7.6).
 *
 * THE UPLOAD IS THE WHOLE DOOR in this build, and the sentence says so rather
 * than leaving the absence to be discovered. Story 7.6 asked for a connected
 * account that lists and pulls recordings; Plaud publishes no account-level
 * API for that — their own help centre says there is no public API, and the
 * documented OAuth on `docs.plaud.ai` belongs to Plaud Embedded, a partner
 * device/transcription platform with no "list my recordings" or "get my
 * transcript" endpoint. The endpoints the community MCP servers use are
 * undocumented internal web-app routes.
 *
 * Naming that here is the honest half. The dishonest half would have been a
 * Connect button wired to a guessed contract: it would ask an owner for real
 * credentials, and it would break the first time an internal route moved.
 */
export const SETTINGS_INTAKE_PLAUD_COPY =
  "Plaud recordings arrive by upload — pick them with the Plaud button beside Sources, and they stay meeting-eligible for Todo Candidates. Connecting a Plaud account to list and pull recordings is not available: Plaud publishes no account API for it.";

/** The `raw/parsed/` checkbox from the Intake mock. */
export const SETTINGS_INTAKE_KEEP_PARSED_LABEL = "Keep extracted Markdown";
export const SETTINGS_INTAKE_KEEP_PARSED_COPY =
  "Also writes each extractor’s Markdown under raw/parsed/. The Source itself is kept either way.";

/** The MinerU pane's standing explanation, above the mode control. */
export const SETTINGS_MINERU_COPY =
  "The built-in PDF extractor always runs first. MinerU is an optional second pass for PDFs it cannot read — scanned pages, dense tables, complex layouts.";

export const SETTINGS_INVALID_MINERU_MODE_COPY =
  "Choose Off, Local API, Cloud, or Pipeline for MinerU.";

export const SETTINGS_MINERU_ENABLE_LABEL = "Use MinerU for PDFs";
export const SETTINGS_MINERU_MODE_LABEL = "Mode";
export const SETTINGS_MINERU_BASE_URL_LABEL = "Local API base URL";
export const SETTINGS_MINERU_KEY_LABEL = "MinerU API key";

export const SETTINGS_MINERU_OFF_COPY =
  "MinerU is off. A PDF the built-in extractor cannot read fails visibly and keeps its bytes.";
/** Covers Pipeline too — both post to the same local MinerU server. */
export const SETTINGS_MINERU_LOCAL_COPY =
  "Local API and Pipeline both post to your own MinerU server. Documents stay on this machine.";
export const SETTINGS_MINERU_KEY_COPY =
  "Cloud authenticates with a MinerU token.";

/** Human labels for the four modes, in select order. */
export function mineruModeLabel(mode: MinerUMode): string {
  switch (mode) {
    case "off":
      return "Off";
    case "local":
      return "Local API";
    case "cloud":
      return "Cloud";
    case "pipeline":
      return "Pipeline";
  }
}

/**
 * The modes the select offers once MinerU is enabled.
 *
 * `off` is NOT among them: the checkbox is what turns the feature off, and a
 * select that also carried `Off` would give the pane two controls for one
 * state that could disagree with each other on screen.
 */
export const MINERU_ENABLED_MODES: readonly MinerUMode[] = [
  "local",
  "cloud",
  "pipeline",
];

// ---------------------------------------------------------------------------
// API + MCP (Stories 8.1 / 8.3 / 8.4 / 8.6)
// ---------------------------------------------------------------------------

/**
 * The pane's standing sentence. It names the BIND, because that is the fact an
 * owner is entitled to before they turn a network door on: loopback only, this
 * machine only, nothing on the LAN.
 */
export const SETTINGS_API_COPY = `Agents on this machine reach the wiki at ${LOOPBACK_BASE_URL}. The door binds loopback only — never the LAN — and stays shut until you open it.`;

export const SETTINGS_API_ENABLE_LABEL = "Enable the local API";
export const SETTINGS_API_ENABLE_COPY =
  "Off, every data route answers 503 and only /health responds.";
export const SETTINGS_API_ENABLED_COPY =
  "On, agents may read this wiki over the loopback port.";

export const SETTINGS_API_UNAUTH_LABEL = "Allow unauthenticated local access";

/**
 * The ORANGE one. Unauthenticated access is a real option — a machine with one
 * human on it is the deployment this product is for — but it is not the default
 * and it is not silent: anything that can open a socket to loopback can then
 * read the whole wiki, and on a shared machine that includes other people's
 * processes and every browser page's `fetch`.
 *
 * Shown on the DRAFT, before Save, for the same reason
 * {@link MINERU_CLOUD_WARNING_COPY} is: a warning that arrives only once the
 * setting has applied is a warning about something that already happened.
 */
export const SETTINGS_API_UNAUTH_WARNING_COPY =
  "Any process on this machine could then read the whole wiki without a token. Leave this off unless you are the only user of this computer.";

export const SETTINGS_API_UNAUTH_OFF_COPY =
  "Callers must send the token. This is the recommended setting.";

export const SETTINGS_API_BASE_URL_LABEL = "Base URL";
export const SETTINGS_API_OPEN_HEALTH_COPY = "Open /health";
export const SETTINGS_API_TOKEN_LABEL = "API token";
export const SETTINGS_API_TOKEN_GENERATE_COPY = "Generate";
export const SETTINGS_API_TOKEN_SHOW_COPY = "Show";
export const SETTINGS_API_TOKEN_HIDE_COPY = "Hide";
export const SETTINGS_API_TOKEN_COPY_COPY = "Copy";
export const SETTINGS_API_COPIED_COPY = "Copied.";

/**
 * A token, masked.
 *
 * Shown by DEFAULT rather than revealed by default: this pane can be open on a
 * shared screen or in a screen recording, and the one interaction that must
 * work — Copy — does not need the characters visible. The last four ride so the
 * owner can tell a freshly generated token from one they already pasted
 * somewhere, which is the only thing eyes are useful for here.
 */
export function maskToken(token: string): string {
  if (token.length <= 4) return "•".repeat(token.length);
  return `${"•".repeat(Math.min(24, token.length - 4))}${token.slice(-4)}`;
}

/**
 * A generated token is shown ONCE, in the draft, and then never again.
 *
 * `GET /api/settings` answers a presence boolean — the same AD-23 rule the three
 * provider credentials follow — so after Save there is nothing on the server
 * this surface could render. Saying so is the difference between an owner
 * copying the token now and an owner discovering next week that they cannot.
 */
export const SETTINGS_API_TOKEN_NEW_COPY =
  "Copy this token now — it is stored on save and never shown again.";
export const SETTINGS_API_TOKEN_STORED_COPY = "A token is stored.";
export const SETTINGS_API_TOKEN_ABSENT_COPY =
  "No token is stored. Generate one, or allow unauthenticated access.";

/**
 * `LLM_WIKI_API_TOKEN` is set, so Generate cannot change what callers send.
 *
 * The same env-wins convention as {@link settingsEnvOverrideCopy}, named
 * separately because this pane has no editable box for the value: there is
 * nothing here the variable is "winning over" except the Generate button, and
 * the sentence has to say that or the button looks broken.
 */
export const SETTINGS_API_TOKEN_ENV_COPY = `${LOOPBACK_TOKEN_ENV} is set and is the token callers must send. Generating one here stores a value nothing will check until that variable is unset.`;

export const SETTINGS_API_MCP_HEADING = "MCP";
export const SETTINGS_API_MCP_COPY =
  "Paste this into an MCP client on this machine. The token travels in the environment, never in the URL.";
export const SETTINGS_API_MCP_COPY_COPY = "Copy MCP config";

export const SETTINGS_API_SKILL_HEADING = "Agent Skill";
export const SETTINGS_API_SKILL_COPY =
  "Install the branded pack so an agent probes health first, defaults to the current Wiki, and cites the paths it read.";
export const SETTINGS_API_SKILL_COPY_COPY = "Copy install command";

/** The MCP server name is a FROZEN identifier — see `AGENTS.md`. */
export const LOOPBACK_MCP_SERVER_NAME = "yopedia";

/** Where the stock loopback wrap lives, relative to the repo root. */
export const LOOPBACK_MCP_ENTRY = "sidecar/mcp.mjs";

/** The in-repo branded Agent Skill pack (Story 8.4). */
export const WORK_WIKI_SKILL_DIR = "skills/work-wiki";

/**
 * The copyable MCP client config.
 *
 * A local **stdio** client spawning {@link LOOPBACK_MCP_ENTRY}, not an HTTP URL
 * with a token in it: this pane is the one place the owner ever sees the
 * credential, and a config that inlined it into a URL would put it into shell
 * history, into a screenshot, and into whatever file the client writes. The
 * token rides in `env` instead, under the one variable name the door reads.
 *
 * `PASTE_YOUR_TOKEN` is a PLACEHOLDER whenever the caller has no plaintext
 * token in hand, because the server never serves the stored value back — see
 * {@link SETTINGS_API_TOKEN_NEW_COPY}. The one moment it IS substituted is
 * right after Generate, which is exactly the moment the config is useful.
 */
export function resolveLoopbackMcpEntry(explicit?: string | null): string {
  if (
    typeof explicit === "string" &&
    (explicit.startsWith("/") || /^[A-Za-z]:[\\/]/.test(explicit))
  ) {
    return explicit;
  }
  const cwd =
    typeof process !== "undefined" && typeof process.cwd === "function"
      ? process.cwd()
      : "";
  if (!cwd) return LOOPBACK_MCP_ENTRY;
  const sep = cwd.includes("\\") ? "\\" : "/";
  return `${cwd.replace(/[\\/]+$/, "")}${sep}${LOOPBACK_MCP_ENTRY.split("/").join(sep)}`;
}

export function loopbackMcpConfig(
  token: string | null,
  entry?: string | null,
): string {
  const value = token !== null && token.length > 0 ? token : "PASTE_YOUR_TOKEN";
  return JSON.stringify(
    {
      mcpServers: {
        [LOOPBACK_MCP_SERVER_NAME]: {
          command: "node",
          args: [resolveLoopbackMcpEntry(entry)],
          env: { [LOOPBACK_TOKEN_ENV]: value },
        },
      },
    },
    null,
    2,
  );
}

/**
 * The install command for the branded pack.
 *
 * A COPY, not a fetch: the pack is in this repo, so installing it is putting
 * the directory where the agent looks. Anything that downloaded it would be a
 * second source of truth for the same files.
 */
export function brandedSkillInstallCommand(): string {
  return `cp -R ${WORK_WIKI_SKILL_DIR} ~/.claude/skills/work-wiki`;
}

/** Interface: English only, no picker (`epic-1-context.md:29`). */
export const SETTINGS_LANGUAGE_LABEL = "Language";
export const SETTINGS_LANGUAGE_VALUE = "English";
export const SETTINGS_LANGUAGE_COPY = "This build is English only.";

// ---------------------------------------------------------------------------
// The wire shape
// ---------------------------------------------------------------------------

/**
 * ONE settings API. Story 1.9's fields ride under ONE nested `workbench` key on
 * both sides of the route the store already has — the flat legacy fields keep
 * their exact current wire shape, so `/settings` and `useSettings` keep working
 * untouched.
 */
export const SETTINGS_ROUTE = "/api/settings";

/**
 * What `GET /api/settings` serves under `workbench`.
 *
 * NO KEY IS EVER HERE. `customApiKey`, `embeddingApiKey` and `firecrawlApiKey`
 * are accepted by `PUT` and answered by three `has*ApiKey` booleans — AD-23 puts
 * the keys in the kernel store, it does not put them back on the browser's
 * screen. A field carrying a stored key would defeat the whole discipline, so
 * the suite asserts the serialized body contains none.
 */
export interface WorkbenchSettingsPayload {
  /**
   * The WRITE PRECONDITION for the stored `AppConfig` these values came out of
   * (DW-63) — the OPAQUE TOKEN `saveConfig` stamped into the config, never a
   * hash of it, so nothing derived from the three stored API keys reaches this
   * payload (see `readConfig` in `src/lib/config.ts`).
   *
   * OPTIONAL, and absence DEGRADES rather than fails (DW-199). The route always
   * sends one, so a payload without it means something between the route and
   * the browser dropped it — and the cost of the two answers is wildly
   * asymmetric. Refusing the payload takes the whole canvas off screen and
   * loses every unsaved edit on it, for a field the surface only needs at Save.
   * Accepting it renders the settings, and the surface CLEARS the version it
   * was holding rather than carrying a superseded one forward: the next save is
   * then refused with the 428 sentence — "this could not be checked", which is
   * what is actually true — and the draft stays. That is `PreviewColumn`'s
   * convention for the same seam. Nothing here can clobber either way: no
   * version means no unconditional write, because `checkWritePrecondition` has
   * no such branch. This matches `isPreviewPayload`, which tolerates the same
   * absence.
   */
  version?: string;
  chatProvider: ProviderValue | null;
  chatModel: string | null;
  ingestProvider: ProviderValue | null;
  ingestModel: string | null;
  customBaseUrl: string | null;
  hasCustomApiKey: boolean;
  /** `null` means "no deadline", which is today's behaviour exactly. */
  llmTimeoutSeconds: number | null;
  /**
   * The owner's STORED decision — never the effective one.
   *
   * `getVectorSearchSettings().enabled` intersects this with the predicate for
   * CONSUMERS, but the editing surface must see what the store holds: the save
   * body always carries this field, so serving the intersected value would let
   * an unrelated edit (a timeout, say) silently rewrite a stored `true` to
   * `false` the moment one leg was momentarily missing.
   */
  vectorSearchEnabled: boolean;
  /**
   * The EXISTING config keys, as STORED — these are what the owner edits.
   * There is one embedding model, in one place.
   */
  embeddingProvider: EmbeddingProvider | null;
  embeddingModel: string | null;
  embeddingBaseUrl: string | null;
  hasEmbeddingApiKey: boolean;
  /**
   * The model this deployment ACTUALLY embeds with (DW-274, DW-312).
   *
   * NOT editable and NOT a second embedding-model field: the row still edits
   * `embeddingModel` above, and this only says what the resolver does with it.
   * The server is the only place that can answer it — the rule is
   * `embeddingModelMatchesProvider` applied over the env and the store together,
   * inside `embeddings.ts`, which this client-safe module must not import — so
   * the answer is SERVED rather than derived in the browser. `null` when
   * nothing embeds at all, which is a different story from a substitution and
   * is why the canvas guards on both fields rather than on the flag alone.
   */
  embeddingModelInEffect: string | null;
  /**
   * Is the model above being SUBSTITUTED on the embed path? (DW-274, DW-312)
   *
   * True only when a model is set, something is in effect, and they differ.
   * False when nothing is set (nothing to override) and false when nothing
   * embeds. Served rather than derived for the same reason as the field above,
   * and served to THIS surface as well as to the flat `/settings` page because
   * one deployment answering the same question two ways on two Settings screens
   * is the gap DW-312 names. It is one boolean about the runtime and names
   * nothing.
   */
  embeddingModelOverridden: boolean;
  /**
   * The ENVIRONMENT's overrides, which a save cannot change and which win at
   * runtime.
   *
   * They are served separately from the stored fields above so the client can
   * feed {@link canEnableVectorSearch} exactly what the route feeds it. Folding
   * them into `embeddingModel` instead would either show an env value in an
   * editable box (and persist it on the next save) or leave the checkbox
   * permanently disabled saying "needs a model" for a model that is configured —
   * which is precisely the client/server disagreement the "one rule, two
   * callers" claim exists to rule out. No value here is a secret.
   */
  envEmbeddingProvider: EmbeddingProvider | null;
  envEmbeddingModel: string | null;
  /**
   * `LLM_CUSTOM_BASE_URL`, when the deployment sets it (DW-71).
   *
   * It rides APART from the editable `customBaseUrl` above for the same reason
   * `envEmbeddingModel` rides apart from `embeddingModel`: `getCustomBaseUrl()`
   * takes the variable ahead of the store, so the two are different facts and
   * the box has to keep showing the STORED one — that is the value a save moves
   * and the value that applies the moment the variable is unset. Folding the env
   * value into the box would show an unsaveable string in an editable control
   * and persist it on the next save; leaving it out entirely is what let an
   * owner type an endpoint, save it successfully, and change nothing.
   *
   * Not a secret: an endpoint is not a credential, and `LLM_CUSTOM_API_KEY` is
   * still reported as the `hasCustomApiKey` boolean and nothing else.
   */
  envCustomBaseUrl: string | null;
  /**
   * WHICH providers the environment carries an embedding credential for, not
   * whether it carries one at all: `OPENAI_API_KEY` is not a Google key, and a
   * flat boolean let the gate pass on a credential the embed step would then
   * resolve to `null`.
   */
  envEmbeddingApiKeyProviders: string[];
  /**
   * Can this DEPLOYMENT reach the Cloudflare `AI` binding? (DW-225)
   *
   * A RUNTIME fact, not a stored one, and the browser has no way to ask: it is
   * `getWorkersAiBinding() !== null`, read once per request by the route and
   * served here so the browser's half of the vector rule sees exactly what the
   * route's half sees. Without it the switch turns on for a `workers-ai`
   * deployment where `resolveEmbeddingProvider` always returns `null` — a switch
   * that reads as on and embeds nothing, on every Docker deployment. It is not a
   * secret and names nothing: it is one boolean about the runtime.
   */
  hasWorkersAiBinding: boolean;
  firecrawlBaseUrl: string | null;
  hasFirecrawlApiKey: boolean;
  /**
   * The STORED Deep Research provider — `null` means nothing was chosen, which
   * reads as {@link DEFAULT_RESEARCH_PROVIDER} everywhere it is resolved.
   *
   * Stored and env ride APART for the same reason the embedding pair does:
   * `RESEARCH_PROVIDER` wins at run time, so folding it into this box would
   * show an unsaveable value in an editable control and persist it on the next
   * save.
   */
  researchProvider: ResearchProviderId | null;
  envResearchProvider: ResearchProviderId | null;
  envResearchProviderInvalid?: string | null;
  hasTavilyApiKey: boolean;
  hasSerpApiKey: boolean;
  serpApiEngine: string | null;
  searxngBaseUrl: string | null;
  envSearxngBaseUrl: string | null;
  searxngCategories: string | null;
  /**
   * WHICH research providers the ENVIRONMENT already carries a credential for.
   *
   * A list rather than a boolean, on the `envEmbeddingApiKeyProviders`
   * argument: `TAVILY_API_KEY` is not a SerpApi key, and a flat boolean would
   * let the surface report a provider as configured when the selected one is
   * not. `Remove` is never offered for a key on this list — the route cannot
   * delete an environment variable.
   */
  envResearchProviders: ResearchProviderId[];
  /**
   * The inbound-email address Intake shows for copying, and whether the door is
   * switched on (Story 7.5).
   *
   * SERVED, not stored here: the value lives in `email-ingest.ts`'s own index,
   * which the inbound Worker's route and the legacy `/settings` page already
   * read. Minting a second copy of it under `AppConfig` would be a second
   * config store for one address — the exact fork `.yoyo/learnings.md` records
   * — so the route loads it and passes it through, and this pane renders it
   * read-only rather than editing it.
   */
  inboundEmailAddress: string | null;
  inboundEmailEnabled: boolean;
  /** Keep the extractor's Markdown under `raw/parsed/` beside the bytes. */
  intakeKeepParsed: boolean;
  /**
   * The stored MinerU mode. `off` is both the default and what an unreadable
   * stored value resolves to — see `extract-settings.ts`.
   */
  mineruMode: MinerUMode;
  mineruLocalBaseUrl: string | null;
  /** Whether a Cloud/Pipeline credential is stored. Never the key (AD-23). */
  hasMinerUApiKey: boolean;
  /**
   * The loopback door's four facts (Story 8.1).
   *
   * NO TOKEN IS EVER HERE, on exactly the AD-23 rule the three provider keys
   * follow: `hasLoopbackApiToken` is a presence boolean and `loopbackTokenSource`
   * says WHERE the value in effect came from, which is the one thing the pane
   * cannot derive — `LLM_WIKI_API_TOKEN` wins over the store, so a surface
   * without this field would keep offering Generate as if pressing it changed
   * what callers must send.
   *
   * `authRequired` is not among them because it is DERIVED — "the API is on and
   * unauth is off" — and serving it as a fifth field would let the two disagree
   * on screen.
   */
  apiEnabled: boolean;
  allowUnauthenticated: boolean;
  hasLoopbackApiToken: boolean;
  loopbackTokenSource: LoopbackTokenSource;
  /** Absolute `sidecar/mcp.mjs` for a client whose cwd is not the repo. */
  loopbackMcpEntry?: string;
  /** Fixed. There is no locale picker anywhere in this surface. */
  language: typeof SETTINGS_LANGUAGE_VALUE;
  /** `YOPEDIA_READONLY=1`: the save bar refuses before the route has to. */
  readOnly: boolean;
}

/**
 * Everything the payload carries EXCEPT the write precondition.
 *
 * `getWorkbenchSettings()` builds the values from the config cache; only the
 * route holds the stored TOKEN, and it serves that same one string at the top
 * level and here (DW-63). Splitting the type is what keeps the resolver unable
 * to invent a second version that would have to agree with the route's.
 */
export type WorkbenchSettingsValues = Omit<WorkbenchSettingsPayload, "version">;

/**
 * What `PUT /api/settings` accepts under `workbench`.
 *
 * Every field is optional and ABSENT means "leave it alone". `null` and `""`
 * both clear. The three secrets are the reason that distinction has to be exact:
 * a save that quietly cleared a key the owner never touched would be the worst
 * outcome on this surface.
 */
export interface WorkbenchSettingsPatch {
  chatProvider?: string | null;
  chatModel?: string | null;
  ingestProvider?: string | null;
  ingestModel?: string | null;
  customBaseUrl?: string | null;
  customApiKey?: string | null;
  /**
   * Deliberately wider than `number | null`.
   *
   * The box is text, and `Number("abc")` is `NaN` — which `JSON.stringify`
   * serialises as `null`, i.e. as "clear the deadline", so a typo would have
   * silently deleted a configured timeout and reported success.
   * {@link settingsSaveBody} sends the RAW string in that case so
   * {@link validateWorkbenchSettingsPatch} refuses it with a sentence, which is
   * the only honest outcome.
   */
  llmTimeoutSeconds?: number | string | null;
  vectorSearchEnabled?: boolean;
  embeddingProvider?: string | null;
  embeddingModel?: string | null;
  embeddingBaseUrl?: string | null;
  embeddingApiKey?: string | null;
  firecrawlBaseUrl?: string | null;
  firecrawlApiKey?: string | null;
  researchProvider?: string | null;
  tavilyApiKey?: string | null;
  serpApiKey?: string | null;
  serpApiEngine?: string | null;
  searxngBaseUrl?: string | null;
  searxngCategories?: string | null;
  intakeKeepParsed?: boolean;
  mineruMode?: string | null;
  mineruLocalBaseUrl?: string | null;
  /** Three-state exactly like the other secrets: absent keeps, `null` removes. */
  mineruApiKey?: string | null;
  apiEnabled?: boolean;
  allowUnauthenticated?: boolean;
  /**
   * A freshly generated loopback token, three-state like the other secrets:
   * absent KEEPS what is stored, `null` (or `""`) REMOVES it.
   *
   * The surface only ever sends a value it just minted with
   * {@link newLoopbackApiToken}; there is no box to type one into, because a
   * hand-typed credential the owner cannot read back is a credential they will
   * lose.
   */
  loopbackApiToken?: string | null;
  /**
   * Skill enablement DECISIONS, id → boolean (Story 8.6).
   *
   * A PATCH of the map, not a replacement: the sidecar scans the filesystem and
   * the kernel stores only what the owner decided, so a full replacement sent by
   * a surface that had scanned a stale list would silently drop a decision about
   * a Skill it had not seen yet. Merged key-by-key in
   * {@link WorkbenchSettingsStored}'s writer.
   */
  skillEnablement?: Record<string, boolean>;
}

/**
 * Is this parsed body actually a {@link WorkbenchSettingsPayload}?
 *
 * A 200 is not a promise about shape — an interstitial or a proxy can put valid
 * JSON on one — and the canvas seeds a draft from these fields during render,
 * where a non-string throws and takes the surface down instead of showing the
 * one sentence a failed read is supposed to show.
 */
export function isWorkbenchSettingsPayload(
  value: unknown,
): value is WorkbenchSettingsPayload {
  if (!value || typeof value !== "object") return false;
  const payload = value as Record<string, unknown>;
  const nullableString = (key: string) =>
    payload[key] === null || typeof payload[key] === "string";
  return (
    // The precondition the next save sends back — checked only for TYPE when
    // present (DW-199). Absent, `null` (the same absence spelled by a
    // serializer) and `""` are all accepted: the surface renders, its version
    // goes to "unknown", and a save with none is refused with the 428 sentence
    // while the draft stays on screen. What is refused is a NUMBER or an object
    // — something that would be sent back as `If-Match` and answered with a
    // conflict the owner cannot explain. See
    // {@link WorkbenchSettingsPayload.version}.
    (payload.version === undefined ||
      payload.version === null ||
      typeof payload.version === "string") &&
    nullableString("chatProvider") &&
    nullableString("chatModel") &&
    nullableString("ingestProvider") &&
    nullableString("ingestModel") &&
    nullableString("customBaseUrl") &&
    nullableString("embeddingProvider") &&
    nullableString("embeddingModel") &&
    nullableString("embeddingBaseUrl") &&
    nullableString("firecrawlBaseUrl") &&
    nullableString("serpApiEngine") &&
    nullableString("searxngBaseUrl") &&
    nullableString("envSearxngBaseUrl") &&
    (payload.envResearchProviderInvalid === undefined || nullableString("envResearchProviderInvalid")) &&
    nullableString("searxngCategories") &&
    // The two provider names are checked against the LIST, not merely for
    // being strings: an unknown id would seed the select with a value it has
    // no option for, and the box would then read as a provider this build
    // cannot search with. `null` is a real state (nothing chosen → Tavily).
    (payload.researchProvider === null ||
      isResearchProviderId(payload.researchProvider)) &&
    (payload.envResearchProvider === null ||
      isResearchProviderId(payload.envResearchProvider)) &&
    nullableString("envEmbeddingProvider") &&
    nullableString("envEmbeddingModel") &&
    nullableString("envCustomBaseUrl") &&
    // REQUIRED, on the same argument `hasWorkersAiBinding` is required on
    // (DW-312): the substitution note is guarded on BOTH of these, and neither
    // absence has a safe reading. Defaulting the flag to `false` would silence
    // a substitution that IS running — the one thing the note exists to say —
    // and defaulting it to `true` would announce one that is not. `null` is
    // accepted for the model name because it is a real state (nothing embeds),
    // but `undefined` is not: it means the payload is not one.
    nullableString("embeddingModelInEffect") &&
    (payload.llmTimeoutSeconds === null ||
      typeof payload.llmTimeoutSeconds === "number") &&
    typeof payload.vectorSearchEnabled === "boolean" &&
    typeof payload.hasCustomApiKey === "boolean" &&
    typeof payload.hasEmbeddingApiKey === "boolean" &&
    typeof payload.embeddingModelOverridden === "boolean" &&
    // REQUIRED as a boolean, unlike `version`: this one feeds the vector rule,
    // and a missing value has no safe reading. Defaulting it to `true` would
    // enable the switch on a deployment with no binding; defaulting it to
    // `false` would refuse `workers-ai` on Workers itself. The route always
    // sends it, so absence means the payload is not one.
    typeof payload.hasWorkersAiBinding === "boolean" &&
    Array.isArray(payload.envEmbeddingApiKeyProviders) &&
    payload.envEmbeddingApiKeyProviders.every((p) => typeof p === "string") &&
    typeof payload.hasFirecrawlApiKey === "boolean" &&
    typeof payload.hasTavilyApiKey === "boolean" &&
    typeof payload.hasSerpApiKey === "boolean" &&
    Array.isArray(payload.envResearchProviders) &&
    payload.envResearchProviders.every(isResearchProviderId) &&
    typeof payload.readOnly === "boolean" &&
    // Epic 7's two panes. The mode is checked against the LIST on the same
    // argument the provider names are: an unknown value would seed a select
    // with no matching option, and the pane would then read as a MinerU mode
    // this build cannot run. The three booleans are required for the reason
    // `hasWorkersAiBinding` is — `intakeKeepParsed` and `inboundEmailEnabled`
    // both have consequences in both directions, so neither absence has a safe
    // default.
    nullableString("inboundEmailAddress") &&
    typeof payload.inboundEmailEnabled === "boolean" &&
    typeof payload.intakeKeepParsed === "boolean" &&
    isMinerUMode(payload.mineruMode) &&
    nullableString("mineruLocalBaseUrl") &&
    typeof payload.hasMinerUApiKey === "boolean" &&
    // Epic 8's pane. All four are REQUIRED, on the `hasWorkersAiBinding`
    // argument and harder: these describe a NETWORK DOOR, and every absence has
    // a reading that is worse than refusing the payload. Defaulting `apiEnabled`
    // to `true` would draw an open door that is shut; defaulting
    // `allowUnauthenticated` to `false` would hide the orange warning on a
    // deployment that IS unauthenticated. There is no safe guess about a door.
    typeof payload.apiEnabled === "boolean" &&
    typeof payload.allowUnauthenticated === "boolean" &&
    typeof payload.hasLoopbackApiToken === "boolean" &&
    (payload.loopbackTokenSource === "env" ||
      payload.loopbackTokenSource === "store" ||
      payload.loopbackTokenSource === "none") &&
    payload.language === SETTINGS_LANGUAGE_VALUE
  );
}

/** Narrows a whole GET/PUT body to one carrying a usable `workbench` object. */
export function workbenchSettingsFrom(value: unknown): WorkbenchSettingsPayload | null {
  if (!value || typeof value !== "object") return null;
  const candidate = (value as Record<string, unknown>).workbench;
  return isWorkbenchSettingsPayload(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// The vector-search predicate — ONE rule, two callers
// ---------------------------------------------------------------------------

/** What the merged store looks like to the vector predicate and the validator. */
export interface VectorSearchInputs {
  /** The EXPLICIT embedding provider — never an auto-detected one. */
  provider: string | null;
  baseUrl: string | null;
  model: string | null;
  hasKey: boolean;
  /**
   * WHERE {@link model} came from, which decides who can act on a mismatch
   * (DW-218/DW-223).
   *
   * `"env"` means `EMBEDDING_MODEL` supplied it — every feeder takes that
   * override ahead of anything typed or stored, so the editable box is NOT the
   * thing that is wrong and typing into it changes nothing. `"stored"` means the
   * value is the one the box edits. The refusal appends
   * {@link SETTINGS_VECTOR_ENV_MODEL_NOTE} for the first and marks the input
   * `aria-invalid` only for the second.
   *
   * No default: a constructor that forgot it would silently claim the box is at
   * fault for a value the owner cannot reach from here.
   */
  modelOrigin: "env" | "stored";
  /**
   * WHERE {@link provider} came from — the same question {@link modelOrigin}
   * asks about the model, for the same reason (DW-281).
   *
   * `"env"` means `EMBEDDING_PROVIDER` supplied it, and every feeder takes that
   * override ahead of the stored selection, so the Embedding provider select is
   * NOT the thing that is wrong and choosing another provider in it changes
   * nothing. `"stored"` means the value is the one that select edits. The
   * binding refusal picks {@link SETTINGS_VECTOR_BINDING_ENV_NOTE} for the
   * first and {@link SETTINGS_VECTOR_BINDING_NOTE} for the second, and
   * {@link vectorSearchFieldIssue} marks the select `aria-invalid` only for the
   * second.
   *
   * No default, for the same reason {@link modelOrigin} has none: a constructor
   * that forgot it would silently claim the select is at fault for a value the
   * owner cannot reach from here.
   */
  providerOrigin: "env" | "stored";
  /**
   * Can this deployment reach the Cloudflare `AI` binding? (DW-225)
   *
   * TRI-STATE, and the third state is load-bearing. `null` means "not knowable
   * here" — `getVectorSearchSettings()` runs inside `config.ts`, which cannot
   * import `embeddings.ts` without a cycle — and the binding leg is NOT applied,
   * which is exactly today's answer for that caller. The route reads
   * `getWorkersAiBinding() !== null` once per request and the browser receives
   * the boolean on the payload, so both halves of the one rule see the same
   * fact.
   */
  hasWorkersAiBinding: boolean | null;
}

/**
 * Embedding providers that carry their own transport and need no credential.
 *
 * `embeddings.ts` documents both as keyless (`embeddingApiKeyFor` returns `null`
 * for them by design): `ollama` reaches its server through `getOllamaBaseUrl()`
 * and `workers-ai` through the Cloudflare `AI` binding. Demanding an endpoint
 * and a key from either would make vector search UNREACHABLE for half the
 * supported providers, and would store an endpoint no code path reads.
 */
const SELF_TRANSPORTING_EMBEDDING_PROVIDERS: ReadonlySet<string> = new Set([
  "ollama",
  "workers-ai",
]);

/**
 * FR-56's "cannot turn on without endpoint + key + model", read against the
 * provider that will actually do the embedding.
 *
 * The client disables the control with it; the route re-runs it over the MERGED
 * config before writing. Two callers, one rule — and because the store's default
 * is `false`, "vector search defaults off" is a property of the kernel rather
 * than of a component that happens to render unchecked.
 *
 * Three legs, one of them new:
 *
 *  - An EXPLICIT embedding provider is required. `resolveEmbeddingProvider`'s
 *    auto-detect branch consults env vars only, so without this leg an owner
 *    could satisfy endpoint + model + stored key, turn vector search on, and
 *    still resolve no embedding provider at all — a switch that reads as on and
 *    embeds nothing.
 *  - The MODEL is always required, for every provider, and the selected provider
 *    must be able to SERVE it — {@link embeddingModelMatchesProvider}, the same
 *    predicate `embeddings.ts`'s `resolveEmbeddingModelName` uses to decide
 *    whether to honour a model id or drop it for the provider default. Its two
 *    legs are asymmetric: under `workers-ai` the id must be one of the supported
 *    Cloudflare embedding models (CATALOG membership, so an in-namespace id the
 *    binding cannot serve is refused here rather than at `ai.run()` — DW-220),
 *    and under every other provider it must simply sit OUTSIDE the `@cf/`
 *    namespace. Without this leg the gate would accept a mismatch the resolver
 *    then overrides, embedding with a model the owner never chose (DW-73).
 *  - The KEY and the ENDPOINT are required only where the provider does not
 *    supply them itself (see {@link SELF_TRANSPORTING_EMBEDDING_PROVIDERS}).
 *  - The BINDING, for `workers-ai` only: being self-transporting means the
 *    Cloudflare `AI` binding IS its transport, and off the Workers runtime there
 *    is no such binding — `resolveEmbeddingProvider` returns `null` forever, so
 *    the switch would read as on and embed nothing (DW-225). Applied only when
 *    the caller actually knows; see
 *    {@link VectorSearchInputs.hasWorkersAiBinding}.
 *
 * What this deliberately does NOT do is teach `hasEmbeddingSupport()` about it.
 * Story 2.9 owns the ingest embed step and Story 3.4 the search merge; moving
 * those here would rewrite `embeddings.test.ts` on behalf of two unwritten
 * stories.
 */
export function canEnableVectorSearch(v: VectorSearchInputs): boolean {
  return vectorSearchMissingLegs(v).length === 0;
}

/** Which control an unmet leg is about. See {@link VectorSearchLeg}. */
export type VectorSearchLegField =
  | "provider"
  | "endpoint"
  | "model"
  | "key"
  | "binding";

/**
 * One unmet leg, as the thing that is missing plus who owns it.
 *
 * A bare `string[]` could only ever produce ONE sentence, announced on ONE
 * control — which is how the model complaint ended up as the vector checkbox's
 * description while the embedding-model input that holds the wrong value carried
 * nothing at all (DW-223). The `field` is what lets a second surface — the model
 * row — ask for its own leg, and the `note` is what lets a refusal name the
 * thing that OWNS it (`EMBEDDING_MODEL`, the Cloudflare `AI` binding) rather
 * than only the shape the value should have had.
 */
export interface VectorSearchLeg {
  /** The control this leg is about. */
  field: VectorSearchLegField;
  /** The noun phrase the refusal sentence lists, in leg order. */
  phrase: string;
  /**
   * A second sentence naming what owns the problem, when the phrase alone
   * cannot be acted on. Appended to the refusal, never substituted for it.
   */
  note?: string;
}

/** Which legs are unmet, in the order the sentence names them. */
function vectorSearchMissingLegs(v: VectorSearchInputs): VectorSearchLeg[] {
  if (!v.provider || !isEmbeddingProvider(v.provider)) {
    return [{ field: "provider", phrase: "an embedding provider" }];
  }
  const missing: VectorSearchLeg[] = [];
  if (!SELF_TRANSPORTING_EMBEDDING_PROVIDERS.has(v.provider) && !v.baseUrl) {
    missing.push({ field: "endpoint", phrase: "an endpoint" });
  }
  if (!v.model) {
    missing.push({ field: "model", phrase: "a model" });
  } else if (!embeddingModelMatchesProvider(v.provider, v.model)) {
    // The SAME predicate `resolveEmbeddingModelName` applies, so the gate cannot
    // refuse a combination the resolver would have honoured, or accept one it
    // would silently override.
    missing.push({
      field: "model",
      phrase:
        v.provider === "workers-ai"
          ? // NAMING the ids, not the namespace (DW-220): "in the @cf/ namespace"
            // is wrong advice for `@cf/llava-hf/llava-1.5-7b-hf`, which already is
            // — and which `ai.run()` refuses. The list comes from the catalog, so
            // adding a model to the table adds it to this sentence.
            `a supported ${WORKERS_AI_LABEL} model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")})`
          : `a model id outside the ${WORKERS_AI_LABEL} ${WORKERS_AI_MODEL_PREFIX} namespace`,
      // Only when the environment owns the value: naming the variable is what
      // makes the sentence actionable, and saying it for a STORED mismatch would
      // send the owner to a variable that is not set (DW-218).
      ...(v.modelOrigin === "env" ? { note: SETTINGS_VECTOR_ENV_MODEL_NOTE } : {}),
    });
  }
  if (!SELF_TRANSPORTING_EMBEDDING_PROVIDERS.has(v.provider) && !v.hasKey) {
    missing.push({ field: "key", phrase: "an API key" });
  }
  // The transport leg for the one provider whose transport is a RUNTIME fact
  // rather than a stored value (DW-225). `SELF_TRANSPORTING_EMBEDDING_PROVIDERS`
  // exempts `workers-ai` from the endpoint and the key precisely because the
  // binding supplies both — so where the binding is absent, nothing is left.
  // `null` is "not knowable here" and applies nothing: see
  // {@link VectorSearchInputs.hasWorkersAiBinding}.
  if (v.provider === "workers-ai" && v.hasWorkersAiBinding === false) {
    missing.push({
      field: "binding",
      phrase: "the Cloudflare AI binding",
      // Which of the two ways out the owner can actually take depends on WHO
      // owns the selection: with `EMBEDDING_PROVIDER` set, "choose another
      // embedding provider" names an action the provider select cannot perform
      // (DW-281).
      note:
        v.providerOrigin === "env"
          ? SETTINGS_VECTOR_BINDING_ENV_NOTE
          : SETTINGS_VECTOR_BINDING_NOTE,
    });
  }
  return missing;
}

/**
 * What is missing, as one sentence, for the provider actually selected. A
 * refusal that only said "no" would leave the owner to guess which field the
 * route was unhappy about — and one that demanded a key from Ollama would send
 * them looking for a credential that does not exist.
 */
export function vectorSearchMissingCopy(v: VectorSearchInputs): string {
  const missing = vectorSearchMissingLegs(v);
  if (missing.length === 0) return "";
  return withLegNotes(vectorSearchLegSentence(missing), missing);
}

/**
 * The trailing ACTION clause of {@link vectorSearchInactiveCopy}, per surface.
 *
 * The only thing the two frames differ by, kept as a table rather than as a
 * ternary inside the template so that the shared half of the sentence exists
 * exactly once and cannot drift between them. A surface added to
 * {@link SettingsSurface} without a clause here is a type error.
 */
const VECTOR_INACTIVE_ACTION = {
  // The Workbench renders the switch beside this sentence, so the action is
  // simply the switch.
  workbench: "Turn it off, or supply what is missing.",
  // `/settings` renders no switch, so naming one would be advice this surface
  // cannot carry out. The pointer names the OTHER surface in full — see
  // {@link settingsPointer} — because "Settings" alone is the page the owner is
  // already on.
  flat: `Supply what is missing, or turn the switch off in ${settingsPointer("embeddings")}.`,
} satisfies Record<SettingsSurface, string>;

/**
 * What a switch that is already SWITCHED ON, over legs that are unmet, has to
 * say (DW-279).
 *
 * The surface renders the box CHECKED — the payload serves the stored flag, and
 * the draft carries whatever the owner has done to it since — and beside it
 * {@link vectorSearchMissingCopy} said "before it can be turned ON", describing
 * a state the surface is visibly not in. The owner reads a ticked box and a
 * sentence about turning it on, and cannot tell what the box is even claiming.
 *
 * The sentence acknowledges the switch and then says what the inputs it was
 * handed still need — not what the deployment is doing. TWO callers now say it,
 * over different inputs, and the wording holds for both precisely because it
 * makes no claim about the running deployment:
 *
 *   - The Embeddings surface, beside the checkbox (DW-279). Every term that
 *     surface computes is DRAFT-derived, so an unsaved provider change would
 *     make any claim about the running deployment false while the stored config
 *     goes on working. Here the sentence is about the settings AS THEY NOW STAND
 *     on screen; the save bar's standing sentence is the one place unsaved edits
 *     are qualified, and it is already announced on this control.
 *   - {@link validateWorkbenchSettingsPatch}, as a REFUSED SAVE's error string
 *     (DW-308), chosen when `baseline` held the flag on. The inputs are the
 *     post-merge config the request asked for — what the store WOULD hold had
 *     the save landed — so "switched on" is the flag the store already holds and
 *     "it needs …" is what the requested config would still be missing. Nothing
 *     is written, so the running deployment is unchanged either way, which is
 *     what keeps the same words honest here. The consumer need not be a browser:
 *     any client of `PUT /api/settings` reads this string as the 400 body, and
 *     it is self-contained — it names the unmet legs and the action (turning the
 *     switch off) without depending on a save bar or on anything else rendered
 *     beside it.
 *
 * Same legs, same notes, same order as the refusal — only the frame changes,
 * and the action the owner actually has here (turning it off) is the one named.
 *
 * …which is why `surface` exists (DW-329). "Turn it off" is an instruction only
 * an owner who can SEE the switch can follow, and the flat `/settings` page
 * renders no vector control at all — so the sentence it shows, and the sentence
 * the route hands back when a flat body is refused, say where the switch lives
 * instead of telling the owner to flip one that is not there. Everything else
 * is byte-identical between the two: the legs, their order, their notes and
 * whether there is a sentence at all. The parameter DEFAULTS to the Workbench
 * surface, so `SettingsCanvas` and every nested-body refusal are untouched.
 */
export function vectorSearchInactiveCopy(
  v: VectorSearchInputs,
  surface: SettingsSurface = "workbench",
): string {
  const missing = vectorSearchMissingLegs(v);
  if (missing.length === 0) return "";
  return withLegNotes(
    `Vector search is switched on, but it needs ${vectorSearchLegList(missing)} before it can run. ${VECTOR_INACTIVE_ACTION[surface]}`,
    missing,
  );
}

/** One sentence plus every leg's note, in leg order, blanks dropped. */
function withLegNotes(sentence: string, legs: readonly VectorSearchLeg[]): string {
  return [sentence, ...legs.map((leg) => leg.note)]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" ");
}

/**
 * The legs as a noun-phrase LIST, split out of {@link vectorSearchLegSentence}
 * so the on-but-inactive sentence names exactly the same things in exactly the
 * same order without restating how a list is punctuated.
 */
function vectorSearchLegList(legs: readonly VectorSearchLeg[]): string {
  const phrases = legs.map((leg) => leg.phrase);
  return phrases.length === 1
    ? phrases[0]
    : `${phrases.slice(0, -1).join(", ")} and ${phrases[phrases.length - 1]}`;
}

/** The one refusal sentence, without any leg's note. */
function vectorSearchLegSentence(legs: readonly VectorSearchLeg[]): string {
  return `Vector search needs ${vectorSearchLegList(legs)} before it can be turned on.`;
}

/** A control on the Embeddings surface that a leg can be ABOUT. */
export type VectorSearchControl = "provider" | "endpoint" | "model" | "key";

/**
 * Which CONTROL an unmet leg reaches.
 *
 * Every leg but one maps to its namesake. The `binding` leg has no control of
 * its own — nothing on this surface binds `ai` in `wrangler.jsonc` — so it maps
 * to the PROVIDER select, which is the only thing here that can move it: a
 * different embedding provider drops the leg entirely (DW-277).
 *
 * At most one leg reaches any control: the provider leg returns early from
 * {@link vectorSearchMissingLegs} and so excludes the binding leg, and the
 * model leg is produced once.
 */
const VECTOR_LEG_CONTROL = {
  provider: "provider",
  endpoint: "endpoint",
  model: "model",
  key: "key",
  binding: "provider",
} satisfies Record<VectorSearchLegField, VectorSearchControl>;

/**
 * Which vector legs a LEGACY FLAT body could have moved — the legs a refusal
 * aimed at that surface is allowed to name (DW-303).
 *
 * The flat `/settings` page renders exactly ONE control the vector rule reads —
 * the embedding model. There is no embedding-provider select, no embedding
 * endpoint box and no embedding API-key box anywhere on it; the Workbench owns
 * all three. So a refusal naming the endpoint or the key gives an owner on that
 * page nothing to do, and {@link validateWorkbenchSettingsPatch} uses this set
 * to suppress exactly those.
 *
 * PRESENCE, not value: a key the body carries is a move this request makes,
 * whatever it moves the field TO — `null` (a clear) moves the leg just as a new
 * id does. That is the API contract rather than a description of what the page
 * sends; `useSettings` sends `embeddingModel` only when its box is non-empty and
 * never sends `embeddingProvider` at all, so the provider half here serves
 * direct API callers.
 *
 * Derived from {@link VECTOR_LEG_CONTROL} rather than hand-listed, which is why
 * `embeddingProvider` claims the `binding` leg as well: the binding leg has no
 * control of its own and maps to the provider select, so a body that can move
 * the provider can move the binding leg too.
 */
export function flatMovableVectorLegs(body: {
  embeddingProvider?: unknown;
  embeddingModel?: unknown;
}): ReadonlySet<VectorSearchLegField> {
  const legs = new Set<VectorSearchLegField>();
  const claim = (control: VectorSearchControl): void => {
    for (const [field, owner] of Object.entries(VECTOR_LEG_CONTROL) as Array<
      [VectorSearchLegField, VectorSearchControl]
    >) {
      if (owner === control) legs.add(field);
    }
  };
  if (body.embeddingProvider !== undefined) claim("provider");
  if (body.embeddingModel !== undefined) claim("model");
  return legs;
}

/** Does this control hold a value at all? See {@link vectorSearchFieldIssue}. */
function vectorControlHasValue(v: VectorSearchInputs, control: VectorSearchControl): boolean {
  switch (control) {
    case "provider":
      return Boolean(v.provider);
    case "endpoint":
      return Boolean(v.baseUrl);
    case "model":
      return Boolean(v.model);
    case "key":
      return v.hasKey;
  }
}

/**
 * WHO owns this control's value — the environment, or the store this edits.
 *
 * A `switch` with NO default, like {@link vectorControlHasValue} above and for a
 * sharper reason: `"stored"` is the answer that MARKS a control `aria-invalid`,
 * so a control added to {@link VectorSearchControl} and quietly caught by a
 * fallback would inherit "the owner is at fault" for a value they may not own.
 * Exhaustiveness makes that a compile error instead.
 */
function vectorControlOrigin(
  v: VectorSearchInputs,
  control: VectorSearchControl,
): "env" | "stored" {
  switch (control) {
    case "provider":
      return v.providerOrigin;
    case "model":
      return v.modelOrigin;
    case "endpoint":
    case "key":
      // Neither can produce an issue at all — both legs are pure presence tests,
      // so `vectorSearchFieldIssue` has already returned `null` before it asks.
      // The arms exist so the switch stays exhaustive, not because they are
      // reachable through a real issue.
      return "stored";
  }
}

/**
 * What ONE refusable control has to say about its own value, or `null` when it
 * has nothing (DW-223, DW-277).
 *
 * The refusal used to be announced only as the vector checkbox's
 * `aria-describedby`, while the control holding the wrong value carried no
 * description and no `aria-invalid` — and the ordinary way into that state is
 * changing the PROVIDER select, which touches neither the model box nor the
 * switch. So each leg is offered separately here, to the control that OWNS it
 * per {@link VECTOR_LEG_CONTROL}.
 *
 * ABSENCE IS NOT AN ISSUE. A control holding nothing holds no WRONG value, so a
 * bare "needs a model" / "needs an endpoint" / "needs an API key" / "needs an
 * embedding provider" leg produces no issue at all and the checkbox's one
 * sentence carries it — otherwise a fresh deployment would render three boxes
 * each repeating a leg already listed once. That silence is the rule's answer,
 * not an omission: the endpoint and key legs are pure presence tests, so those
 * two controls never produce an issue, and the provider select's standing
 * {@link SETTINGS_VECTOR_PROVIDER_COPY} hint is already the complaint for an
 * unset provider.
 *
 * `copy` is the leg's sentence plus the leg's NOTE, which names what owns the
 * problem and rides on the owning control — except for `"model"`, whose row
 * already carries {@link settingsEnvOverrideCopy} about the very same variable
 * and would only repeat it.
 *
 * `invalid` is true only when the CONTROL'S OWN value is the wrong one — an
 * origin of `"stored"`. An env-owned value is described without being marked,
 * because marking a control the owner cannot fix from here is a dead end.
 */
export function vectorSearchFieldIssue(
  v: VectorSearchInputs,
  control: VectorSearchControl,
): { copy: string; invalid: boolean } | null {
  if (!vectorControlHasValue(v, control)) return null;
  const leg = vectorSearchMissingLegs(v).find(
    (entry) => VECTOR_LEG_CONTROL[entry.field] === control,
  );
  if (!leg) return null;
  return {
    copy:
      control === "model"
        ? vectorSearchLegSentence([leg])
        : withLegNotes(vectorSearchLegSentence([leg]), [leg]),
    invalid: vectorControlOrigin(v, control) === "stored",
  };
}

// ---------------------------------------------------------------------------
// Validation — re-run server-side over the merged config
// ---------------------------------------------------------------------------

/** Timeout bounds, in seconds. Integer only; `null` means no deadline. */
export const LLM_TIMEOUT_MIN_SECONDS = 5;
export const LLM_TIMEOUT_MAX_SECONDS = 3600;

const PROVIDER_LIST = PROVIDER_INFO.map((p) => p.value).join(", ");

export const SETTINGS_INVALID_PROVIDER_COPY = `A provider must be one of: ${PROVIDER_LIST}.`;
export const SETTINGS_INVALID_EMBEDDING_PROVIDER_COPY = `An embedding provider must be one of: ${EMBEDDING_PROVIDERS.join(", ")}.`;
export const SETTINGS_INVALID_MODEL_COPY = "A model must be a non-empty name.";
export const SETTINGS_INVALID_URL_COPY =
  "A base URL must be an absolute http or https address.";
export const SETTINGS_INVALID_TIMEOUT_COPY = `The LLM timeout must be a whole number of seconds between ${LLM_TIMEOUT_MIN_SECONDS} and ${LLM_TIMEOUT_MAX_SECONDS}.`;
/**
 * The field's own hint. Both numerals are derived from the constants rather than
 * typed, so the sentence cannot outlive the range it describes.
 */
export const SETTINGS_TIMEOUT_HINT_COPY = `Leave blank for no deadline. ${LLM_TIMEOUT_MIN_SECONDS}–${LLM_TIMEOUT_MAX_SECONDS} seconds.`;
export const SETTINGS_INVALID_BODY_COPY = "Settings must be sent as an object.";
export const SETTINGS_INVALID_SECRET_COPY = "An API key must be text.";
export const SETTINGS_INVALID_FLAG_COPY = "Vector search must be on or off.";
export const SETTINGS_INVALID_API_FLAG_COPY =
  "The local API switches must be on or off.";
export const SETTINGS_INVALID_SKILL_MAP_COPY =
  "Skill enablement must be a map of skill id to on or off.";

/**
 * The floor for a stored loopback token.
 *
 * 24 characters — comfortably under {@link newLoopbackApiToken}'s 48 and well
 * over anything a human would invent. It is a FLOOR, not a format: the door
 * compares bytes, so a token from a password manager is as good as a generated
 * one, and pinning a shape would refuse it.
 */
export const MIN_LOOPBACK_TOKEN_LENGTH = 24;

export const SETTINGS_WEAK_API_TOKEN_COPY = `An API token must be at least ${MIN_LOOPBACK_TOKEN_LENGTH} characters. Use Generate.`;

/**
 * Absolute `http`/`https` only.
 *
 * A relative URL would be resolved against whatever host the SERVER happens to
 * run on, which is never what an owner typing an endpoint means — and `file:`
 * or `data:` would point the provider SDK at the deployment's own filesystem.
 */
export function isAbsoluteHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:";
}

export type WorkbenchSettingsValidation =
  | { ok: true; patch: WorkbenchSettingsPatch }
  | { ok: false; error: string };

/**
 * The stored state a patch is merged onto, as far as validation cares.
 *
 * The CONFIG fields are the ones a patch can move; the ENV fields are the ones
 * it cannot and which win at runtime. Keeping them apart is what lets the merge
 * below produce exactly the inputs the client produces from the payload — a
 * single "effective model" field would make `{ embeddingModel: null }` look like
 * a clear to the route and like nothing at all to the browser.
 */
export interface WorkbenchSettingsStored {
  vectorSearchEnabled: boolean;
  embeddingProvider: string | null;
  embeddingBaseUrl: string | null;
  embeddingModel: string | null;
  hasEmbeddingApiKey: boolean;
  envEmbeddingProvider: string | null;
  envEmbeddingModel: string | null;
  /** See {@link WorkbenchSettingsPayload.envEmbeddingApiKeyProviders}. */
  envEmbeddingApiKeyProviders: string[];
  /**
   * The RUNTIME half — see {@link WorkbenchSettingsPayload.hasWorkersAiBinding}.
   *
   * Two-state here, where {@link VectorSearchInputs} is tri-state: the route
   * knows the answer, so there is no "not knowable" for this caller to spell.
   */
  hasWorkersAiBinding: boolean;
}

/**
 * Validate one `workbench` patch, including the vector rule over the MERGE.
 *
 * Returns the patch rather than a bare `true` so the caller cannot forget to use
 * the narrowed value, and one sentence rather than a field list because the
 * surface shows the server's sentence verbatim.
 *
 * `stored` is what the patch is MERGED ONTO — for the route, the post-legacy-merge
 * config, so an `embeddingModel` set by the flat field in the same request counts
 * toward the gate. `baseline` is what the store held BEFORE the request, and it
 * exists only to answer "did this request move anything the rule reads" (DW-219).
 * The two differ exactly when a body carries both a flat legacy field and a
 * `workbench` key: with one argument the flat move would be baked into BOTH
 * sides of the comparison and would compare equal to itself, skipping the very
 * gate the flat field was supposed to have entered. It defaults to `stored`, so
 * a caller with no legacy path — every caller but the route — is unchanged.
 *
 * `baseline` has a SECOND job (DW-308): it picks which sentence a refusal
 * carries. A request that turns the switch ON gets "…before it can be turned
 * on"; a request against a switch the store already had ON gets the switched-on
 * frame, because the save bar renders the refusal beside a box the payload
 * still shows ticked. It decides WHICH sentence only — never WHETHER the gate
 * refuses, which stays {@link canEnableVectorSearch} alone.
 *
 * `actionableLegs` is the set of vector legs the REQUESTING SURFACE can move —
 * see {@link flatMovableVectorLegs} and the vector rule below. Omitted (the
 * default) means "this surface reaches every control", which is today's
 * behaviour and what every caller but the flat-only route path wants. An EMPTY
 * set is its opposite, not its equal: it says the surface can move nothing, so
 * only a configuration this request BROKE can produce a refusal.
 */
export function validateWorkbenchSettingsPatch(
  value: unknown,
  stored: WorkbenchSettingsStored,
  baseline: WorkbenchSettingsStored = stored,
  actionableLegs?: ReadonlySet<VectorSearchLegField>,
): WorkbenchSettingsValidation {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, error: SETTINGS_INVALID_BODY_COPY };
  }
  const patch = value as Record<string, unknown>;

  for (const key of ["chatProvider", "ingestProvider"] as const) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !VALID_PROVIDERS.has(raw)) {
      return { ok: false, error: SETTINGS_INVALID_PROVIDER_COPY };
    }
  }

  {
    const raw = patch.embeddingProvider;
    if (!(raw === undefined || raw === null || raw === "")) {
      if (typeof raw !== "string" || !isEmbeddingProvider(raw)) {
        return { ok: false, error: SETTINGS_INVALID_EMBEDDING_PROVIDER_COPY };
      }
    }
  }

  for (const key of ["chatModel", "ingestModel", "embeddingModel"] as const) {
    const raw = patch[key];
    // `null` is how a model is UNSET, and it is what `settingsSaveBody` sends
    // for a box the owner emptied. A blank STRING is refused instead: a model is
    // a name, "" is not one, and accepting it would make "clear this" and "I
    // typed nothing" the same request — which is exactly the ambiguity the
    // secrets' three states exist to avoid elsewhere.
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, error: SETTINGS_INVALID_MODEL_COPY };
    }
  }

  for (const key of [
    "customBaseUrl",
    "embeddingBaseUrl",
    "firecrawlBaseUrl",
    // The SearXNG instance is an endpoint like any other, and it rides the same
    // absolute-http rule for the same reason: a relative value would be
    // resolved against whatever host the deployment runs on, so a research run
    // would search the deployment instead of the web.
    "searxngBaseUrl",
    // MinerU's Local API is reached by the SIDECAR, on the owner's machine —
    // so a relative value would be resolved against nothing at all there. Same
    // rule, same sentence.
    "mineruLocalBaseUrl",
  ] as const) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !isAbsoluteHttpUrl(raw.trim())) {
      return { ok: false, error: SETTINGS_INVALID_URL_COPY };
    }
  }

  {
    const raw = patch.mineruMode;
    // `null` and `""` read as `off`, which is the fail-closed default. An
    // unrecognised mode is REFUSED rather than coerced: coercion would let a
    // typo silently switch a configured extractor off, and storing it would
    // leave the select showing a mode with no option row.
    if (!(raw === undefined || raw === null || raw === "")) {
      if (!isMinerUMode(raw)) {
        return { ok: false, error: SETTINGS_INVALID_MINERU_MODE_COPY };
      }
    }
  }

  if (patch.intakeKeepParsed !== undefined && typeof patch.intakeKeepParsed !== "boolean") {
    return { ok: false, error: SETTINGS_INVALID_BODY_COPY };
  }

  for (const key of [
    "customApiKey",
    "embeddingApiKey",
    "firecrawlApiKey",
    "tavilyApiKey",
    "serpApiKey",
    "mineruApiKey",
  ] as const) {
    const raw = patch[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      return { ok: false, error: SETTINGS_INVALID_SECRET_COPY };
    }
  }

  {
    const raw = patch.researchProvider;
    // `null` and `""` both mean "no stored choice", which resolves to the
    // default. Anything else has to be one of the three this build can search
    // with — storing an unknown name would leave the select showing a provider
    // with no option row and every run refusing.
    if (!(raw === undefined || raw === null || raw === "")) {
      if (!isResearchProviderId(raw)) {
        return { ok: false, error: SETTINGS_INVALID_RESEARCH_PROVIDER_COPY };
      }
    }
  }

  for (const key of ["serpApiEngine", "searxngCategories"] as const) {
    const raw = patch[key];
    // Free text with no vocabulary to check against: SerpApi adds engines and
    // a SearXNG instance defines its own categories, so an allowlist here would
    // refuse a value the owner's instance accepts. `null` clears; a blank
    // string is refused for the same reason a blank model name is — "clear
    // this" and "I typed nothing" must not be the same request.
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || raw.trim().length === 0) {
      return { ok: false, error: SETTINGS_INVALID_MODEL_COPY };
    }
  }

  {
    const raw = patch.llmTimeoutSeconds;
    // `null` is the ONLY way to clear the deadline — `settingsSaveBody` sends it
    // for an emptied box. `""` is refused with the rest of the non-numbers,
    // because `applyWorkbenchSettings` ignores any string it is handed: letting
    // `""` through would answer 200 for a request that changed nothing, which is
    // the same silent no-op the raw-string path exists to prevent.
    if (!(raw === undefined || raw === null)) {
      if (
        typeof raw !== "number" ||
        !Number.isInteger(raw) ||
        raw < LLM_TIMEOUT_MIN_SECONDS ||
        raw > LLM_TIMEOUT_MAX_SECONDS
      ) {
        return { ok: false, error: SETTINGS_INVALID_TIMEOUT_COPY };
      }
    }
  }

  {
    const raw = patch.vectorSearchEnabled;
    if (raw !== undefined && typeof raw !== "boolean") {
      return { ok: false, error: SETTINGS_INVALID_FLAG_COPY };
    }
  }

  // Epic 8's door. Two switches, one secret and one map — checked HERE rather
  // than in the route so the browser and the route refuse the same body with the
  // same sentence, which is this module's whole reason for existing.
  for (const key of ["apiEnabled", "allowUnauthenticated"] as const) {
    const raw = patch[key];
    if (raw !== undefined && typeof raw !== "boolean") {
      return { ok: false, error: SETTINGS_INVALID_API_FLAG_COPY };
    }
  }

  {
    const raw = patch.loopbackApiToken;
    // Three-state like the other secrets: absent keeps, `null` removes. A blank
    // string is accepted as a REMOVE rather than refused, because unlike a model
    // name there is no box here for a human to leave empty by accident — the
    // only writer is Generate, and `""` can only be a serializer's `null`.
    if (!(raw === undefined || raw === null)) {
      if (typeof raw !== "string") {
        return { ok: false, error: SETTINGS_INVALID_SECRET_COPY };
      }
      if (raw.trim().length > 0 && raw.trim().length < MIN_LOOPBACK_TOKEN_LENGTH) {
        // A short token is refused rather than stored. This credential guards
        // read access to the entire wiki over a port anything on the machine can
        // reach, and a four-character one is worse than none: it reads as
        // protection on the pane while being trivially guessable.
        return { ok: false, error: SETTINGS_WEAK_API_TOKEN_COPY };
      }
    }
  }

  {
    const raw = patch.skillEnablement;
    if (raw !== undefined) {
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { ok: false, error: SETTINGS_INVALID_SKILL_MAP_COPY };
      }
      for (const [id, on] of Object.entries(raw as Record<string, unknown>)) {
        if (id.length === 0 || typeof on !== "boolean") {
          return { ok: false, error: SETTINGS_INVALID_SKILL_MAP_COPY };
        }
      }
    }
  }

  // The vector rule, evaluated over what the store will hold AFTER this patch
  // lands — an endpoint set in the same request counts, and a key already in the
  // store counts. The client disables the control with the same predicate; this
  // is what makes it a rule rather than a disabled button.
  //
  // But only for a patch that actually MOVES something the rule reads (DW-219).
  // `settingsSaveBody` sends `vectorSearchEnabled`, `embeddingProvider`,
  // `embeddingModel` and `embeddingBaseUrl` on EVERY save, so re-running the
  // whole rule whenever the merged flag is on answered 400 to a chat-model or
  // timeout edit on any deployment already storing a mismatch — a surface the
  // owner cannot leave, since the refusal names a field their edit never
  // touched. "Touched" therefore cannot be read as key PRESENCE; it is a VALUE
  // comparison of the merged inputs against the stored-only ones.
  //
  // Little escapes through the skip: `getVectorSearchSettings()` still
  // intersects the stored flag with this same predicate, so a stored mismatch of
  // PROVIDER, ENDPOINT, MODEL or KEY still reads as OFF to every consumer.
  //
  // The BINDING leg is the one exception, and it is deliberate rather than a
  // hole. `getVectorSearchSettings()` passes `hasWorkersAiBinding: null` because
  // it cannot know (see {@link VectorSearchInputs.hasWorkersAiBinding}), so a
  // stored `workers-ai` flag on a deployment with no binding still reads as ON
  // there. Nothing embeds on the strength of it: `resolveEmbeddingProvider`
  // returns `null` with no binding, so the embed path refuses independently —
  // which is exactly the disagreement the leg exists to report on the SURFACE,
  // where the owner can act on it.
  const enabled =
    typeof patch.vectorSearchEnabled === "boolean"
      ? patch.vectorSearchEnabled
      : stored.vectorSearchEnabled;
  if (enabled) {
    const merged = mergedVectorInputs(patch as WorkbenchSettingsPatch, stored);
    // What the store held BEFORE this request — `baseline`, not `stored`, so a
    // flat legacy field moved earlier in the same request is a MOVE rather than
    // part of the unchanged background. See the parameter's note.
    const current = mergedVectorInputs({}, baseline);
    const turningOn = !baseline.vectorSearchEnabled;
    if (
      (turningOn || !vectorInputsEqual(current, merged)) &&
      !canEnableVectorSearch(merged)
    ) {
      // A refusal has to be one the requesting surface can DO something about
      // (DW-303). The flat `/settings` page renders no embedding endpoint and no
      // embedding key, so an owner editing the embedding model on a deployment
      // whose stored config was already missing both used to be told to supply
      // two boxes that do not exist there — and had no way to land the edit.
      //
      // Two questions, and the refusal survives either one:
      //
      //   - `canEnableVectorSearch(current)` — it WORKED before this request, so
      //     this request broke it. That is always the request's business, and it
      //     is what keeps DW-217 shut: switching `embeddingProvider` from
      //     `ollama` to `openai` leaves the endpoint and key legs unmet even
      //     though no flat field can supply either, and silently switching
      //     effective vector search off is exactly the outcome the gate exists
      //     to prevent.
      //   - some unmet leg is one `actionableLegs` names, so the sentence points
      //     at a control the surface actually shows.
      //
      // "Did this request break it" is asked about the CONFIGURATION, never by
      // diffing leg SETS. `vectorSearchMissingLegs` early-returns the provider
      // leg ALONE when the provider is absent or invalid — the remaining
      // questions cannot be asked until a provider is chosen — so an
      // already-broken baseline reports `[provider]` while the merge reports the
      // legs that were hidden behind it, and a set diff reads every one of those
      // as newly unmet. `canEnableVectorSearch` cannot be distorted that way.
      //
      // `turningOn` is exempt: a request that switches the flag ON is asking for
      // vector search, and every leg is then its business.
      //
      // A FLAG rather than an early `ok: true`, so this function keeps ONE
      // success exit. A second one here is harmless only for as long as nothing
      // follows the vector rule — and the next check appended below it would be
      // silently skipped for every scoped request.
      let suppressed = false;
      if (actionableLegs && !turningOn) {
        const brokeIt = canEnableVectorSearch(current);
        suppressed =
          !brokeIt &&
          !vectorSearchMissingLegs(merged).some((leg) => actionableLegs.has(leg.field));
      }
      if (!suppressed) {
        return {
          ok: false,
          // Same legs, same notes, same order — only the FRAME differs, and it
          // is the same question the client asks of its checkbox (DW-308).
          // `vectorSearchMissingCopy` says "…before it can be turned on", which
          // is exactly right for a request asking to turn the switch on and
          // describes a state the surface is visibly not in when the switch was
          // ALREADY on: the save bar would land that sentence beside a still-
          // ticked box, which is the mismatch DW-279 closed on the client half.
          //
          // `baseline.vectorSearchEnabled` — the flag as the store held it
          // BEFORE the request, already computed as `turningOn` — is the
          // server's analogue of the ticked box the client reads. The POST-merge
          // `enabled` would be useless: the gate only runs inside `if (enabled)`,
          // so it is always `true` here and the missing frame would become
          // unreachable.
          //
          // Which SENTENCE, never WHETHER: `canEnableVectorSearch` stays the one
          // rule both callers answer identically about whether a situation is
          // refused at all.
          //
          // …and the switched-on frame asks a SECOND question, off the same one
          // fact the fourth argument already carries (DW-329). "Turn it off" is
          // an action only a surface that renders the switch can offer, and a
          // scoped request is by definition one from the flat `/settings` page,
          // which renders none — so it gets the frame that says where the
          // switch lives. `actionableLegs === undefined` is the whole test:
          // absent means a surface reaching every control, present means the
          // flat page. No second parameter, because there is no second fact.
          //
          // `turningOn` is exempt from this too, and for the same reason it is
          // exempt from the scoping above: `vectorSearchMissingCopy` says
          // "…before it can be turned on", which is what a request ASKING to
          // turn the switch on is about, and which names no action at all.
          error: turningOn
            ? vectorSearchMissingCopy(merged)
            : vectorSearchInactiveCopy(
                merged,
                actionableLegs === undefined ? "workbench" : "flat",
              ),
        };
      }
    }
  }

  return { ok: true, patch: patch as WorkbenchSettingsPatch };
}

/**
 * Every key of {@link VectorSearchInputs}, as a value.
 *
 * `satisfies Record<keyof VectorSearchInputs, true>` is what makes this
 * EXHAUSTIVE: a field added to the interface without being added here is a type
 * error, where a plain `Array<keyof VectorSearchInputs>` would have accepted any
 * subset and let a new input be silently skipped by the comparison below.
 */
const VECTOR_INPUT_KEYS = {
  provider: true,
  baseUrl: true,
  model: true,
  hasKey: true,
  modelOrigin: true,
  providerOrigin: true,
  hasWorkersAiBinding: true,
} satisfies Record<keyof VectorSearchInputs, true>;

/**
 * Does this request leave every input the vector rule reads exactly where it
 * was?
 *
 * Field by field over {@link VECTOR_INPUT_KEYS}. Three of those fields cannot
 * differ between the two sides TODAY — no patch can move `modelOrigin`,
 * `providerOrigin` or `hasWorkersAiBinding`, which come from the environment and
 * the runtime — so they are compared for completeness rather than because they
 * vary. That is the point of the exhaustive list: the day one of them becomes
 * patchable, this comparison already reads it.
 */
function vectorInputsEqual(a: VectorSearchInputs, b: VectorSearchInputs): boolean {
  return (Object.keys(VECTOR_INPUT_KEYS) as Array<keyof VectorSearchInputs>).every(
    (key) => a[key] === b[key],
  );
}

/**
 * Did the stored embedding provider MOVE? (DW-69/DW-72)
 *
 * The ONE definition of "switched", imported by every writer of the field:
 * `applyWorkbenchSettings` (the `workbench` merge), the flat legacy branch of
 * `PUT /api/settings`, {@link mergedVectorInputs} and the Workbench draft. A
 * second copy is how the browser and the route drift apart, and a drift here
 * means one of them keeps handing OpenAI's secret to Google.
 *
 * A VALUE comparison, never presence: `settingsSaveBody` sends
 * `embeddingProvider` on EVERY save, so "the field is in the body" says nothing
 * at all about whether the vendor changed. Both sides are trim-normalised
 * first, so `"openai"`, `" openai "` and `"openai"` are one value, and `""`,
 * `"   "` and `null` are all "nothing selected" — the auto-detect rung, which
 * is a real move away from a named vendor and must clear like any other.
 */
export function embeddingProviderChanged(
  previous: string | null,
  next: string | null,
): boolean {
  const normalise = (value: string | null): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  return normalise(previous) !== normalise(next);
}

/**
 * What the vector legs look like once `patch` lands on `stored`.
 *
 * Module-private: the ONE public expression of this rule is
 * {@link canEnableVectorSearch}, and this is the route's half of feeding it.
 * The browser's half is {@link draftVectorInputs}, and the two are written to
 * produce identical answers for identical situations — env override wins, then
 * the patch, then what is stored.
 */
function mergedVectorInputs(
  patch: WorkbenchSettingsPatch,
  stored: WorkbenchSettingsStored,
): VectorSearchInputs {
  const resolve = (
    next: string | null | undefined,
    current: string | null,
  ): string | null => {
    if (next === undefined) return current;
    if (next === null) return null;
    const trimmed = next.trim();
    return trimmed.length > 0 ? trimmed : null;
  };
  // What the STORE will hold for the provider once this patch lands — the env
  // override is deliberately NOT read here, because a variable no save can move
  // cannot be what a save switched. The gate's `provider` below still takes the
  // override; this local answers a different question.
  const storedProviderAfter = resolve(patch.embeddingProvider, stored.embeddingProvider);
  // …and whether that is a MOVE (DW-69/DW-72). `applyWorkbenchSettings` drops
  // the stored key and the stored endpoint on exactly this condition, so the
  // gate has to judge the config that will EXIST after the write. Counting them
  // here would wave through a vector switch the route then refuses to honour —
  // and the two legs it waved through belong to the previous vendor.
  const switched = embeddingProviderChanged(stored.embeddingProvider, storedProviderAfter);
  const provider = stored.envEmbeddingProvider ?? storedProviderAfter;
  const key = patch.embeddingApiKey;
  const hasKey =
    // An env credential counts only for the vendor it belongs to — and it is
    // the NEW vendor's env key that counts, which this line already reads
    // because `provider` above is the post-patch value.
    (provider !== null && stored.envEmbeddingApiKeyProviders.includes(provider)) ||
    (key === undefined
      ? // The stored key stops counting across a switch: it is about to be
        // deleted. A key supplied in THIS request still counts (the branch
        // below), which is what lets one save both switch vendor and land the
        // new credential.
        !switched && stored.hasEmbeddingApiKey
      : typeof key === "string" && key.trim().length > 0);
  return {
    provider,
    // Same reading for the endpoint: across a switch the patch is the only
    // source, so a request that switches vendor without naming an endpoint sees
    // `null` rather than the old vendor's URL.
    baseUrl: resolve(patch.embeddingBaseUrl, switched ? null : stored.embeddingBaseUrl),
    model: stored.envEmbeddingModel ?? resolve(patch.embeddingModel, stored.embeddingModel),
    hasKey,
    // The same `??` the line above spells, read as a question about ORIGIN: the
    // env override wins, so when there is one the model box is not what the gate
    // is looking at.
    modelOrigin: stored.envEmbeddingModel !== null ? "env" : "stored",
    // The `??` on the `provider` line above, read the same way: with
    // `EMBEDDING_PROVIDER` set, the select is not what the gate is looking at
    // and "choose another provider" is advice it cannot follow (DW-281).
    providerOrigin: stored.envEmbeddingProvider !== null ? "env" : "stored",
    // A runtime fact no patch can move — it arrives on `stored` from the route.
    hasWorkersAiBinding: stored.hasWorkersAiBinding,
  };
}

// ---------------------------------------------------------------------------
// The draft — what the surface holds while the owner is typing
// ---------------------------------------------------------------------------

/**
 * The editable mirror of a {@link WorkbenchSettingsPayload}.
 *
 * Every non-secret field is a plain string (or a boolean), because that is what
 * an `<input>`/`<select>` gives back and converting at the boundary rather than
 * on every keystroke keeps a half-typed number from being rejected mid-word.
 *
 * The three SECRETS are `string | null` and carry three states:
 *   - `""`   the owner has not touched it — omitted from the save body entirely
 *   - a string  replace the stored key with this
 *   - `null` the owner pressed Remove — sent as `null`, which the merge deletes
 *
 * A password input that shows nothing cannot tell "leave it alone" from "delete
 * it", and a save that quietly cleared a key nobody touched would be the worst
 * outcome on this surface. {@link settingsSaveBody} is where that lives, and it
 * is a pure function the suite executes.
 */
export interface SettingsDraft {
  chatProvider: string;
  chatModel: string;
  ingestProvider: string;
  ingestModel: string;
  customBaseUrl: string;
  customApiKey: string | null;
  llmTimeoutSeconds: string;
  vectorSearchEnabled: boolean;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingBaseUrl: string;
  embeddingApiKey: string | null;
  firecrawlBaseUrl: string;
  firecrawlApiKey: string | null;
  /**
   * The Deep Research provider select. `""` is "nothing chosen", which reads as
   * {@link DEFAULT_RESEARCH_PROVIDER} — the same `""`-means-unset convention the
   * other selects on this surface use.
   */
  researchProvider: string;
  tavilyApiKey: string | null;
  serpApiKey: string | null;
  serpApiEngine: string;
  searxngBaseUrl: string;
  searxngCategories: string;
  intakeKeepParsed: boolean;
  /**
   * The mode the pane is EDITING, `off` included.
   *
   * One field rather than a boolean plus a mode: the checkbox and the select
   * are two controls over this single value, and storing them separately is
   * how a surface ends up rendering "enabled" beside a mode of `off`.
   */
  mineruMode: MinerUMode;
  mineruLocalBaseUrl: string;
  mineruApiKey: string | null;
  apiEnabled: boolean;
  allowUnauthenticated: boolean;
  /**
   * A token the owner just GENERATED, in the same three states as the secrets
   * above — {@link SECRET_UNTOUCHED} for "leave the stored one alone", a string
   * for "store this", `null` for "remove it".
   *
   * Unlike the secrets it is DISPLAYED while it holds a value, because this is
   * the only moment it can be: nothing serves it back after the save. See
   * {@link SETTINGS_API_TOKEN_NEW_COPY}.
   */
  loopbackApiToken: string | null;
}

/** Untouched — see {@link SettingsDraft}. */
export const SECRET_UNTOUCHED = "";

export function settingsDraftFromPayload(
  payload: WorkbenchSettingsValues,
): SettingsDraft {
  return {
    chatProvider: payload.chatProvider ?? "",
    chatModel: payload.chatModel ?? "",
    ingestProvider: payload.ingestProvider ?? "",
    ingestModel: payload.ingestModel ?? "",
    customBaseUrl: payload.customBaseUrl ?? "",
    customApiKey: SECRET_UNTOUCHED,
    llmTimeoutSeconds:
      payload.llmTimeoutSeconds === null ? "" : String(payload.llmTimeoutSeconds),
    vectorSearchEnabled: payload.vectorSearchEnabled,
    embeddingProvider: payload.embeddingProvider ?? "",
    embeddingModel: payload.embeddingModel ?? "",
    embeddingBaseUrl: payload.embeddingBaseUrl ?? "",
    embeddingApiKey: SECRET_UNTOUCHED,
    firecrawlBaseUrl: payload.firecrawlBaseUrl ?? "",
    firecrawlApiKey: SECRET_UNTOUCHED,
    researchProvider: payload.researchProvider ?? "",
    tavilyApiKey: SECRET_UNTOUCHED,
    serpApiKey: SECRET_UNTOUCHED,
    serpApiEngine: payload.serpApiEngine ?? "",
    searxngBaseUrl: payload.searxngBaseUrl ?? "",
    searxngCategories: payload.searxngCategories ?? "",
    intakeKeepParsed: payload.intakeKeepParsed,
    mineruMode: payload.mineruMode,
    mineruLocalBaseUrl: payload.mineruLocalBaseUrl ?? "",
    mineruApiKey: SECRET_UNTOUCHED,
    apiEnabled: payload.apiEnabled,
    allowUnauthenticated: payload.allowUnauthenticated,
    loopbackApiToken: SECRET_UNTOUCHED,
  };
}

/**
 * The draft after the owner presses Generate.
 *
 * A pure rule, not a `set()` in the component, for the reason every other
 * decision on this surface is one: the suite runs in `environment: "node"`, so a
 * rule inside a click handler could only be grepped for. And this one has a
 * consequence — the token is shown ONCE — that a rewrite would happily keep the
 * wording of while dropping.
 *
 * The token arrives as an argument rather than being minted here so the caller
 * owns the entropy source and the suite can pin a value.
 */
export function settingsDraftAfterTokenGenerated(
  draft: SettingsDraft,
  token: string,
): SettingsDraft {
  return { ...draft, loopbackApiToken: token };
}

/**
 * The draft after the owner ticks or unticks the local API.
 *
 * Unticking clears `allowUnauthenticated` TOO. The two are not independent: an
 * owner who shuts the door has not thereby decided that the next time they open
 * it, it should be open to everything — and leaving the second switch set would
 * mean a later tick of the first one silently reopened an UNAUTHENTICATED door.
 * The stored token is left alone, on the same argument
 * {@link settingsDraftAfterMinerUEnabled} leaves the MinerU key alone: pausing
 * a feature should not turn re-enabling it into a credential hunt.
 */
export function settingsDraftAfterApiEnabled(
  draft: SettingsDraft,
  enabled: boolean,
): SettingsDraft {
  if (enabled) return { ...draft, apiEnabled: true };
  return { ...draft, apiEnabled: false, allowUnauthenticated: false };
}

/**
 * Will the door this DRAFT describes let an untokened caller in?
 *
 * Read off the draft rather than the payload, on exactly
 * {@link draftMinerULeavesMachine}'s argument: the orange warning has to appear
 * when the owner TICKS the box, not after the save that opened the door.
 */
export function draftApiUnauthenticated(draft: SettingsDraft): boolean {
  return draft.apiEnabled && draft.allowUnauthenticated;
}

/**
 * Would this draft leave the API on with NO way for a caller to authenticate?
 *
 * On, unauth off, and no token — from the environment, from the store or from a
 * Generate press. It is not an error and does not block Save: the door is
 * simply shut to everyone, which is a safe state and an honest one. It is a
 * SENTENCE, so the owner is not left wondering why their agent gets 401.
 */
export function draftApiTokenMissing(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  if (!draft.apiEnabled || draft.allowUnauthenticated) return false;
  if (payload.loopbackTokenSource === "env") return false;
  const pending = secretPatchValue(draft.loopbackApiToken);
  if (pending === null) return true;
  if (pending !== undefined) return false;
  return !payload.hasLoopbackApiToken;
}

/**
 * The draft after the owner ticks or unticks "Use MinerU for PDFs".
 *
 * A pure rule for the same reason {@link settingsDraftAfterEmbeddingProvider}
 * is one: it is a decision, not a control. Ticking lands on
 * {@link MINERU_FIRST_MODE} — Local API, the mode that keeps documents on the
 * machine — rather than on whatever the select happens to show, because the
 * owner has not been asked about Cloud yet. Unticking goes to `off` and leaves
 * the base URL and the key ALONE: they are not the enable state, and dropping
 * a stored token because the owner paused the feature would make re-enabling
 * it a credential hunt.
 *
 * A tick when the draft is ALREADY on an enabled mode is a no-op, which matters
 * only for a redundant tick (a click the browser fired twice, a controlled
 * checkbox re-asserting itself): it must not move a chosen Cloud back to Local
 * behind the owner.
 *
 * UNTICK-THEN-RE-TICK DOES land back on Local, and that is not a contradiction
 * of the line above — the untick wrote `off` into the draft, so the re-tick is
 * a first enablement and takes the first-enablement rule. Losing a Cloud
 * selection that way is the safe direction to be wrong in, and the draft is not
 * saved until the owner presses Save, so nothing has been applied either way.
 */
export function settingsDraftAfterMinerUEnabled(
  draft: SettingsDraft,
  enabled: boolean,
): SettingsDraft {
  if (!enabled) return { ...draft, mineruMode: "off" };
  if (draft.mineruMode !== "off") return draft;
  return { ...draft, mineruMode: MINERU_FIRST_MODE };
}

/**
 * Does the DRAFT's MinerU selection send documents off the machine?
 *
 * Read off the draft, not the payload: the orange warning has to appear when
 * the owner PICKS Cloud, before Save applies it — that is the whole acceptance
 * criterion. A predicate over the stored value would show the warning only
 * after the upload it is warning about was already possible.
 */
export function draftMinerULeavesMachine(draft: SettingsDraft): boolean {
  return mineruLeavesMachine(draft.mineruMode);
}

/**
 * The draft after the owner moves the embedding provider select (DW-69/DW-72).
 *
 * A pure rule rather than a `set("embeddingProvider", …)` in the component,
 * because it is the SAME rule the store applies: when the value moves, the
 * endpoint and the key belong to the previous vendor and are dropped. Here they
 * are dropped from the DRAFT, which is what makes the surface honest —
 * {@link settingsSaveBody} sends `embeddingBaseUrl` on every save, so a draft
 * still holding the old vendor's endpoint would write it straight back into the
 * store the moment `applyWorkbenchSettings` had cleared it, and the fix would
 * hold on the API path while failing on the surface the owner actually uses.
 *
 * The key returns to {@link SECRET_UNTOUCHED} rather than to `null`: `null` is
 * "Remove", and the owner did not press Remove — the STORE's own clear is what
 * drops the stored key, and the field is simply back to untouched so a
 * credential typed for the new vendor before saving still rides. A value the
 * owner had typed for the vendor being left behind goes the same way, and so
 * does a pending Remove: neither was about the vendor now selected.
 *
 * `payload` is what the STORE holds, and it is why this takes three arguments
 * rather than two. The draft is not the only reference point: switching away
 * and BACK within one draft ends on the stored vendor, whose endpoint and key
 * were never touched — so the boxes are RESTORED to the payload's values rather
 * than left blank. Leaving them blank would send `embeddingBaseUrl: null` on
 * the next save and DELETE a stored endpoint the stored provider never moved
 * away from, which is exactly the byte-identical-preservation promise the
 * fourth acceptance criterion makes. The key half already behaved this way for
 * free — {@link draftEmbeddingKeyStored} reports the stored key again the moment
 * the draft returns to the payload's provider — and this makes the endpoint half
 * symmetric with it.
 *
 * So there are three answers, not two: same value as the draft already holds
 * (nothing moves), back to the STORED vendor (restore), any other vendor
 * (blank).
 */
export function settingsDraftAfterEmbeddingProvider(
  draft: SettingsDraft,
  next: string,
  payload: WorkbenchSettingsValues,
): SettingsDraft {
  if (!embeddingProviderChanged(draft.embeddingProvider, next)) {
    return { ...draft, embeddingProvider: next };
  }
  // Back where the STORE is: the stored pair is the new vendor's own, because
  // the new vendor IS the stored one. Restoring is what a freshly seeded draft
  // would hold, so the surface shows the same thing a reload would.
  const returning = !embeddingProviderChanged(payload.embeddingProvider, next);
  return {
    ...draft,
    embeddingProvider: next,
    embeddingBaseUrl: returning ? payload.embeddingBaseUrl ?? "" : "",
    // Always untouched, in BOTH directions: the stored key is reported through
    // `draftEmbeddingKeyStored` rather than held here, and anything the owner
    // typed belonged to the vendor being left.
    embeddingApiKey: SECRET_UNTOUCHED,
  };
}

/**
 * Does the STORED embedding key still count for the vendor this draft selects?
 * (DW-69/DW-72)
 *
 * `payload.hasEmbeddingApiKey` alone answers "the store holds a key", which was
 * the misreport: it kept the row saying "A key is stored." and kept `Remove` on
 * screen for a credential the very next save deletes. The predicate the surface
 * needs is "a key is stored FOR WHAT THIS DRAFT SELECTS", and that is the
 * stored boolean intersected with the one switch test.
 *
 * The same fact the route's `mergedVectorInputs` reads, so the browser's half of
 * the vector rule and the route's half answer identically for one draft.
 */
export function draftEmbeddingKeyStored(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  return (
    payload.hasEmbeddingApiKey &&
    !embeddingProviderChanged(payload.embeddingProvider, draftText(draft.embeddingProvider))
  );
}

/**
 * Has anything moved since the draft was seeded?
 *
 * Compared against the draft the PAYLOAD would produce rather than against the
 * payload itself, so "typed a value and deleted it again" is correctly not
 * dirty, and a secret left at `""` never is.
 */
export function settingsDirty(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  const seeded = settingsDraftFromPayload(payload);
  return (Object.keys(seeded) as Array<keyof SettingsDraft>).some(
    (key) => draft[key] !== seeded[key],
  );
}

/**
 * What `Save` actually sends.
 *
 * Non-secret fields always ride, with `""` normalised to `null` so clearing a
 * field is expressible at all. The three secrets ride only when the owner
 * touched them: `""` is omitted entirely, so a save that only changed the
 * timeout carries no `*ApiKey` field and cannot disturb a stored key.
 */
export function settingsSaveBody(draft: SettingsDraft): WorkbenchSettingsPatch {
  const seconds = draftText(draft.llmTimeoutSeconds);
  const patch: WorkbenchSettingsPatch = {
    chatProvider: draftText(draft.chatProvider),
    chatModel: draftText(draft.chatModel),
    ingestProvider: draftText(draft.ingestProvider),
    ingestModel: draftText(draft.ingestModel),
    customBaseUrl: draftText(draft.customBaseUrl),
    // A blank box is "no deadline". A box holding something that is not a finite
    // number is NOT silently blanked — the raw string rides, and the validator
    // refuses it with a sentence. `Number("abc")` would be `NaN`, which
    // `JSON.stringify` writes as `null`, i.e. as a request to CLEAR the stored
    // deadline: a typo deleting a setting and reporting success.
    llmTimeoutSeconds: seconds === null ? null : numberOrRaw(seconds),
    vectorSearchEnabled: draft.vectorSearchEnabled,
    embeddingProvider: draftText(draft.embeddingProvider),
    embeddingModel: draftText(draft.embeddingModel),
    embeddingBaseUrl: draftText(draft.embeddingBaseUrl),
    firecrawlBaseUrl: draftText(draft.firecrawlBaseUrl),
    researchProvider: draftText(draft.researchProvider),
    serpApiEngine: draftText(draft.serpApiEngine),
    searxngBaseUrl: draftText(draft.searxngBaseUrl),
    searxngCategories: draftText(draft.searxngCategories),
    intakeKeepParsed: draft.intakeKeepParsed,
    // `off` rides as the literal string, not as `null`. Clearing the key would
    // read back as "never decided", and `getWorkbenchSettings` resolves an
    // absent value to `off` anyway — but an owner who switched MinerU off
    // should be recorded as having done it.
    mineruMode: draft.mineruMode,
    mineruLocalBaseUrl: draftText(draft.mineruLocalBaseUrl),
    // Both switches ride on every save, like `vectorSearchEnabled`: they are
    // booleans with no "unset" state, and omitting one would make "I switched
    // the door off" indistinguishable from "I edited a model".
    apiEnabled: draft.apiEnabled,
    allowUnauthenticated: draft.allowUnauthenticated,
  };
  // Secrets ride only when the owner touched them — see `secretPatchValue`.
  const custom = secretPatchValue(draft.customApiKey);
  if (custom !== undefined) patch.customApiKey = custom;
  const embedding = secretPatchValue(draft.embeddingApiKey);
  if (embedding !== undefined) patch.embeddingApiKey = embedding;
  const firecrawl = secretPatchValue(draft.firecrawlApiKey);
  if (firecrawl !== undefined) patch.firecrawlApiKey = firecrawl;
  const tavily = secretPatchValue(draft.tavilyApiKey);
  if (tavily !== undefined) patch.tavilyApiKey = tavily;
  const serpapi = secretPatchValue(draft.serpApiKey);
  if (serpapi !== undefined) patch.serpApiKey = serpapi;
  const mineru = secretPatchValue(draft.mineruApiKey);
  if (mineru !== undefined) patch.mineruApiKey = mineru;
  const loopback = secretPatchValue(draft.loopbackApiToken);
  if (loopback !== undefined) patch.loopbackApiToken = loopback;
  return patch;
}

/**
 * Does the SELECTED research provider have a credential, counting env and store?
 *
 * The browser's half of the same question `resolveResearchProvider` answers on
 * the kernel side, and it exists so the surface can say so BEFORE a run refuses:
 * the select is the one control that decides which credential matters, and a
 * "configured" light driven by "any provider has a key" would report green for
 * a deployment whose every research run fails.
 *
 * SearXNG's credential is its instance URL, not a key — a public instance needs
 * no token, so requiring one would refuse the provider's normal deployment.
 */
export function draftResearchProviderConfigured(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  if (payload.envResearchProviderInvalid) return false;
  const provider = draftResearchProvider(draft, payload);
  if (provider === "searxng") {
    const value = payload.envSearxngBaseUrl ?? draftText(draft.searxngBaseUrl);
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  }
  const typed = secretPatchValue(
    provider === "tavily" ? draft.tavilyApiKey : draft.serpApiKey,
  );
  // `null` is a pending Remove, and it un-configures the provider even though
  // the store still holds the key — the save that follows deletes it, and a row
  // that keeps saying "configured" until reload is the same misreport
  // `draftEmbeddingKeyStored` closed for the embedding key.
  if (typed === null) return payload.envResearchProviders.includes(provider);
  if (typed !== undefined) return true;
  const stored = provider === "tavily" ? payload.hasTavilyApiKey : payload.hasSerpApiKey;
  return stored || payload.envResearchProviders.includes(provider);
}

/**
 * WHICH provider a draft resolves to — env override, then the select, then the
 * default. The same precedence the kernel applies, so the surface and the run
 * cannot disagree about which provider is about to be used.
 */
export function draftResearchProvider(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): ResearchProviderId {
  if (payload.envResearchProvider !== null) return payload.envResearchProvider;
  const chosen = draftText(draft.researchProvider);
  return isResearchProviderId(chosen) ? chosen : DEFAULT_RESEARCH_PROVIDER;
}

/** Trim-and-null: a box holding only whitespace holds nothing. */
function draftText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/** A finite number, or the raw text so the validator can name the problem. */
function numberOrRaw(value: string): number | string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : value;
}

/**
 * What a secret draft field contributes to the patch, or `undefined` for "omit
 * it entirely".
 *
 * `null` is Remove and rides as `null`. A non-blank string is a replacement. A
 * WHITESPACE-ONLY string is untouched, exactly like `""`: without that, holding
 * the space bar in a key field would send `"   "`, which the merge trims to
 * empty and therefore DELETES — a stored credential destroyed by a stray
 * keystroke, with a success message.
 */
function secretPatchValue(value: string | null): string | null | undefined {
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * May the vector control be enabled from the DRAFT the owner is looking at?
 *
 * The same predicate the route re-runs, fed from the draft plus the stored
 * presence boolean — a key already in the store counts even though the field
 * shows nothing, which is precisely what the boolean is for.
 */
export function draftCanEnableVectorSearch(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): boolean {
  return canEnableVectorSearch(draftVectorInputs(draft, payload));
}

/**
 * The BROWSER's half of feeding {@link canEnableVectorSearch}, written to answer
 * identically to the route's half for identical situations: the env override
 * wins, then what the owner has typed, then what is stored.
 */
export function draftVectorInputs(
  draft: SettingsDraft,
  payload: WorkbenchSettingsValues,
): VectorSearchInputs {
  const provider = payload.envEmbeddingProvider ?? draftText(draft.embeddingProvider);
  const typed = secretPatchValue(draft.embeddingApiKey);
  const hasKey =
    // An env credential counts only for the vendor it belongs to — the same
    // reading the route's `mergedVectorInputs` applies.
    (provider !== null && payload.envEmbeddingApiKeyProviders.includes(provider)) ||
    (typed === undefined
      ? // The stored key counts only for the vendor the draft still selects —
        // the same reading the route's `mergedVectorInputs` applies to
        // `stored.hasEmbeddingApiKey` across a switch (DW-69/DW-72).
        draftEmbeddingKeyStored(draft, payload)
      : typeof typed === "string" && typed.length > 0);
  return {
    provider,
    // No switch test needed on THIS half: the box itself is blanked the moment
    // the select moves ({@link settingsDraftAfterEmbeddingProvider}), so the
    // draft never holds the previous vendor's endpoint to begin with.
    baseUrl: draftText(draft.embeddingBaseUrl),
    model: payload.envEmbeddingModel ?? draftText(draft.embeddingModel),
    hasKey,
    // Same reading as the route's `mergedVectorInputs`: the override wins, so
    // with one set the editable box is not the value being checked.
    modelOrigin: payload.envEmbeddingModel !== null ? "env" : "stored",
    // The same reading of the `provider` line above that the route's
    // `mergedVectorInputs` applies — both halves must read the same origin, or
    // they answer differently for the same deployment.
    providerOrigin: payload.envEmbeddingProvider !== null ? "env" : "stored",
    // Served on the payload precisely because the browser cannot ask.
    hasWorkersAiBinding: payload.hasWorkersAiBinding,
  };
}

/**
 * The vector inputs as the STORE holds them — no draft in play (DW-327).
 *
 * The flat `/settings` page edits none of the vector fields but must still be
 * able to SAY what state they are in, and the only honest answer there is the
 * stored one: there is no draft on that page for any of them.
 *
 * COMPOSED from the two functions the Workbench already uses rather than
 * derived afresh, because a freshly seeded draft IS the stored state — every
 * field of {@link settingsDraftFromPayload} is the payload's own value, and the
 * three secrets seed to {@link SECRET_UNTOUCHED}, which
 * {@link draftVectorInputs} reads as "whatever the store has". So the flat page
 * cannot disagree with a just-loaded Workbench about which legs are unmet, and
 * a change to the env-override precedence lands in both at once.
 */
export function storedVectorInputs(
  payload: WorkbenchSettingsValues,
): VectorSearchInputs {
  return draftVectorInputs(settingsDraftFromPayload(payload), payload);
}

// ---------------------------------------------------------------------------
// The one settings client
// ---------------------------------------------------------------------------
//
// Same technique `workbench-preview.ts` uses: `fetch` is a parameter, so the
// node suite drives both functions with a stub and never opens a socket. The
// route URL is named once here rather than typed into a component, so a
// Workbench component never carries a literal `/api/` string.

/** The subset of a `Response` these functions read. */
export interface SettingsResponseLike {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** The subset of `fetch` these functions call. The global satisfies it. */
export type SettingsFetch = (
  url: string,
  init?: {
    signal?: AbortSignal;
    method?: string;
    headers?: Record<string, string>;
    body?: string;
  },
) => Promise<SettingsResponseLike>;

/**
 * The reason a caller passes to `controller.abort()` when its own DEADLINE
 * fired, as opposed to the surface unmounting.
 *
 * Both stop the same request through the same controller, and without a way to
 * tell them apart every abort reads as "superseded" — so the caller stays
 * silent, `loading` is never cleared, and a hung request shows `Loading…` for
 * the rest of the session. That is precisely the state a deadline exists to
 * prevent, so the two reasons must produce different outcomes. Same mechanism
 * `workbench-preview.ts` uses for the Preview's read.
 */
export const SETTINGS_TIMEOUT_REASON = "settings-request-timeout";

/**
 * What a settings read produced.
 *
 * `stale` is deliberately its own outcome rather than a flavour of `failed`: an
 * unmounted surface has nothing to tell anyone, and setting state from it would
 * warn about updating a component that is gone. A DEADLINE abort is the
 * opposite case — nothing else is coming, so it must NOT be silent — and
 * resolves to `failed`.
 */
export type SettingsFetchResult =
  | { status: "ok"; payload: WorkbenchSettingsPayload }
  | { status: "stale" }
  | { status: "failed" };

/** Which kind of abort was this? See {@link SETTINGS_TIMEOUT_REASON}. */
function abortOutcome(signal: AbortSignal): SettingsFetchResult {
  return signal.reason === SETTINGS_TIMEOUT_REASON
    ? { status: "failed" }
    : { status: "stale" };
}

/**
 * Read the stored settings.
 *
 * Every failure — a 404 from the owner gate, a 500, an unparseable body, a
 * transport error, a blown deadline — resolves to the SAME `failed`, because the
 * route deliberately grants no existence oracle and the surface must not be able
 * to invent one.
 */
export async function fetchWorkbenchSettings(
  options: { signal?: AbortSignal; fetchImpl?: SettingsFetch } = {},
): Promise<SettingsFetchResult> {
  const send = options.fetchImpl ?? fetch;
  const signal = options.signal;
  try {
    const response = await send(SETTINGS_ROUTE, {
      ...(signal ? { signal } : {}),
    });
    if (signal?.aborted) return abortOutcome(signal);
    if (!response.ok) return { status: "failed" };
    const body: unknown = await response.json();
    if (signal?.aborted) return abortOutcome(signal);
    const payload = workbenchSettingsFrom(body);
    return payload ? { status: "ok", payload } : { status: "failed" };
  } catch {
    // No message is derived here at all: a transport string is vocabulary no
    // Copy table contains and that the owner cannot act on.
    return signal?.aborted ? abortOutcome(signal) : { status: "failed" };
  }
}

export type SettingsSaveResult =
  | { status: "ok"; payload: WorkbenchSettingsPayload }
  | {
      status: "error";
      message: string;
      /**
       * NOTHING IS KNOWN about this save — see `WriteFailure.unconfirmed`. The
       * caller must keep every edit on screen AND clear the version it was
       * holding, because the stored config may already have moved past it; it
       * must never tell the owner the settings were not saved. REQUIRED rather
       * than optional, so a future construction site cannot forget the verdict
       * into a silent false.
       */
      unconfirmed: boolean;
    };

/**
 * Write one `workbench` patch.
 *
 * Resolves on a refusal rather than throwing, because the caller's only correct
 * response is to keep every edit on screen and show the message. ONLY a
 * server-supplied `{ error }` sentence is relayed; a thrown error shows the one
 * fixed fallback (see {@link SETTINGS_SAVE_FAILED_COPY}).
 *
 * …EXCEPT when nothing answered at all (DW-376). A fired deadline, a dropped
 * connection and a gateway status ({@link UNCONFIRMED_STATUSES}) are not
 * refusals: the patch may have landed, so they answer `unconfirmed: true` and
 * the ONE sentence `workbench-request` owns, composed from `action`. The
 * fallback is not shown there: it says the settings were NOT saved, which
 * nobody knows.
 *
 * THIS ROUTE'S OWN 503 IS NOT ONE OF THEM. `PUT /api/settings` answers 503 with
 * `CONFIG_UNREADABLE_COPY` when the store cannot be read, and refuses before
 * merging anything — an arrived verdict about a write that did not land, so its
 * sentence is relayed and the caller keeps the version it is holding.
 *
 * A 200 whose body carries no usable `workbench` object is an ERROR, not a
 * success: the caller re-seeds its draft from that object, and treating a
 * shapeless 200 as landed would clear the dirty flag over values nobody
 * confirmed were stored.
 */
export async function saveWorkbenchSettings(
  patch: WorkbenchSettingsPatch,
  options: {
    signal?: AbortSignal;
    fetchImpl?: SettingsFetch;
    fallback?: string;
    /** The phrase the UNKNOWN-outcome sentence is composed from. */
    action?: string;
    /**
     * The {@link WorkbenchSettingsPayload.version} the draft was SEEDED from,
     * sent as `If-Match` (DW-63). `PUT /api/settings` requires it and answers
     * 428 without one, so omitting it is a refusal rather than a blind write —
     * the two Settings surfaces write the same file and would otherwise put
     * each other's fields back.
     */
    version?: string;
  } = {},
): Promise<SettingsSaveResult> {
  const send = options.fetchImpl ?? fetch;
  const fallback = options.fallback ?? SETTINGS_SAVE_FAILED_COPY;
  const action = options.action ?? SETTINGS_SAVE_ACTION;
  try {
    const response = await send(SETTINGS_ROUTE, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        ...(options.version ? { [IF_MATCH_HEADER]: formatIfMatch(options.version) } : {}),
      },
      body: JSON.stringify({ workbench: patch }),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    if (!response.ok) {
      const body = (await response.json().catch(() => null)) as {
        error?: unknown;
      } | null;
      const served = typeof body?.error === "string" ? body.error.trim() : "";
      // The verdict has ONE owner, in `workbench-request`: a gateway's status
      // wins over whatever it put in the body, and every other status relays the
      // server's sentence exactly as before.
      return {
        status: "error",
        ...refusedWriteFailure(response.status, served, action, fallback),
      };
    }
    // Two different failures hide behind one `response.json()`, and they get
    // opposite verdicts (DW-408).
    //
    // A body that PARSES BADLY — truncated JSON, or an HTML page from something
    // sitting in front of the route — is still the ROUTE's arrived answer: the
    // status line came back, so the patch's outcome is known and only the
    // ability to re-seed the draft is lost. That is precisely the shapeless-200
    // branch below, and `workbenchSettingsFrom(null)` is already `null`, so
    // answering `null` lands it there and makes an arrived answer EXPLICIT
    // rather than something the thrown fallback happened to get right.
    //
    // A body read that DIES MID-STREAM — an abort, a `TypeError` off a dropped
    // socket — is the same missing confirmation as any other unconfirmed cause,
    // and is rethrown to the outer catch untouched. That distinction is not
    // cosmetic: `SettingsCanvas.save` clears the held version ONLY on
    // `unconfirmed: true`, so calling this one "arrived" would keep a version
    // the save may already have superseded and make the next save a 412 —
    // "somebody else changed this while you were editing", about an actor that
    // does not exist — where clearing it yields the truthful 428.
    const body: unknown = await response.json().catch((cause: unknown) => {
      if (unconfirmedCause(cause)) throw cause;
      return null;
    });
    const payload = workbenchSettingsFrom(body);
    // A shapeless 200 is the ROUTE's own answer, arrived: it ran and it replied,
    // so nothing here is unknown — the draft simply cannot be re-seeded from it.
    return payload
      ? { status: "ok", payload }
      : { status: "error", message: fallback, unconfirmed: false };
  } catch (cause) {
    // Deliberately discards the cause's message — see the docblock — but not the
    // FACT it carries: an abort and a `TypeError` mean the patch may have landed.
    return { status: "error", ...thrownWriteFailure(cause, action, fallback) };
  }
}
