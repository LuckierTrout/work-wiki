/**
 * The Workbench Settings surface's vocabulary and every decision it makes.
 *
 * Pure and client-safe, the same posture as `workbench-modes.ts` (vocabulary +
 * copy) and `workbench-preview.ts` (decisions + one fetch/save client taking an
 * injectable `fetchImpl`): the route imports it on the server, `SettingsCanvas`
 * imports it in the browser, and the node suite EXECUTES it.
 *
 * That last part is the whole reason the module exists. `vitest.config.ts` is
 * `environment: "node"` — there is no DOM and no testing-library — so any rule
 * that lives inside a React effect can only ever be grepped for. "Which
 * categories exist", "may vector search be enabled", "what does Save actually
 * send", and "which sentence does a rejected save show" are exactly the rules a
 * rewrite keeps the wording of while changing the behaviour, so all four are
 * functions here rather than branches typed into JSX.
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
 * Nav order, top → bottom. Six categories carry content Story 1.9 built; the
 * three whose settings belong to Epics 6-8 are LISTED and `pending` —
 * `epic-1-context.md:65` says so in as many words ("may appear in the Settings
 * nav but are implemented in Epics 6, 7, and 8").
 */
export const SETTINGS_CATEGORIES: readonly SettingsCategory[] = [
  { id: "general", label: "General", pending: null },
  { id: "llm-models", label: "LLM Models", pending: null },
  { id: "embeddings", label: "Embeddings", pending: null },
  {
    id: "intake",
    label: "Intake",
    pending: "Intake settings arrive with Sources ingest.",
  },
  {
    id: "mineru",
    label: "MinerU PDF",
    pending: "MinerU PDF extraction settings arrive with binary extract.",
  },
  { id: "external-sources", label: "External Sources", pending: null },
  {
    id: "api-mcp",
    label: "API + MCP",
    pending: "Local API and MCP settings arrive with the sidecar.",
  },
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
 * `src/lib/llm.ts:287-301` keeps its shorter "Settings → LLM Models": those are
 * RUNTIME errors, raised from the LLM call rather than rendered on a Settings
 * page, so the ambiguity this pointer resolves does not arise there. The two
 * are deliberately not the same string.
 */
function settingsPointer(id: SettingsCategoryId): string {
  return `${WORKBENCH_SETTINGS_LABEL} → ${settingsCategory(id).label}`;
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
 * saves successfully, and nothing changes. The box is not disabled — the stored
 * value is still what applies if the variable is ever unset — so the sentence
 * has to carry the whole explanation.
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

/** External Sources: the one credential Story 1.9 stores for Epic 6. */
export const SETTINGS_FIRECRAWL_COPY =
  "Firecrawl credentials are stored for Deep Research; nothing here calls it yet.";

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
    typeof payload.readOnly === "boolean" &&
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

  for (const key of ["customBaseUrl", "embeddingBaseUrl", "firecrawlBaseUrl"] as const) {
    const raw = patch[key];
    if (raw === undefined || raw === null || raw === "") continue;
    if (typeof raw !== "string" || !isAbsoluteHttpUrl(raw.trim())) {
      return { ok: false, error: SETTINGS_INVALID_URL_COPY };
    }
  }

  for (const key of ["customApiKey", "embeddingApiKey", "firecrawlApiKey"] as const) {
    const raw = patch[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string") {
      return { ok: false, error: SETTINGS_INVALID_SECRET_COPY };
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
  const provider =
    stored.envEmbeddingProvider ??
    resolve(patch.embeddingProvider, stored.embeddingProvider);
  const key = patch.embeddingApiKey;
  const hasKey =
    // An env credential counts only for the vendor it belongs to.
    (provider !== null && stored.envEmbeddingApiKeyProviders.includes(provider)) ||
    (key === undefined
      ? stored.hasEmbeddingApiKey
      : typeof key === "string" && key.trim().length > 0);
  return {
    provider,
    baseUrl: resolve(patch.embeddingBaseUrl, stored.embeddingBaseUrl),
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
  };
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
  };
  // Secrets ride only when the owner touched them — see `secretPatchValue`.
  const custom = secretPatchValue(draft.customApiKey);
  if (custom !== undefined) patch.customApiKey = custom;
  const embedding = secretPatchValue(draft.embeddingApiKey);
  if (embedding !== undefined) patch.embeddingApiKey = embedding;
  const firecrawl = secretPatchValue(draft.firecrawlApiKey);
  if (firecrawl !== undefined) patch.firecrawlApiKey = firecrawl;
  return patch;
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
      ? payload.hasEmbeddingApiKey
      : typeof typed === "string" && typed.length > 0);
  return {
    provider,
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
  | { status: "error"; message: string };

/**
 * Write one `workbench` patch.
 *
 * Resolves on a refusal rather than throwing, because the caller's only correct
 * response is to keep every edit on screen and show the message. ONLY a
 * server-supplied `{ error }` sentence is relayed; a thrown error shows the one
 * fixed fallback (see {@link SETTINGS_SAVE_FAILED_COPY}).
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
      return { status: "error", message: served || fallback };
    }
    const body: unknown = await response.json();
    const payload = workbenchSettingsFrom(body);
    return payload ? { status: "ok", payload } : { status: "error", message: fallback };
  } catch {
    // Deliberately discards the cause's message — see the docblock.
    return { status: "error", message: fallback };
  }
}
