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
  embeddingModelMatchesProvider,
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
 * The environment's overrides, said out loud.
 *
 * `EMBEDDING_PROVIDER` and `EMBEDDING_MODEL` win at runtime and a save cannot
 * move them, so without these an owner reads an EMPTY model box beside a vector
 * switch that is somehow enabled, types a model into it, saves successfully, and
 * nothing changes. The box is not disabled — the stored value is still what
 * applies if the variable is ever unset — so the sentence has to carry the
 * whole explanation.
 */
export function settingsEnvOverrideCopy(kind: "provider" | "model", value: string): string {
  const variable = kind === "provider" ? "EMBEDDING_PROVIDER" : "EMBEDDING_MODEL";
  return `The environment sets ${variable}=${value}, and that wins at runtime. What you save here applies only once that variable is unset.`;
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
   * (DW-63) — the OPAQUE TOKEN `saveConfig` stamped beside the config, never a
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
   * WHICH providers the environment carries an embedding credential for, not
   * whether it carries one at all: `OPENAI_API_KEY` is not a Google key, and a
   * flat boolean let the gate pass on a credential the embed step would then
   * resolve to `null`.
   */
  envEmbeddingApiKeyProviders: string[];
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
    (payload.llmTimeoutSeconds === null ||
      typeof payload.llmTimeoutSeconds === "number") &&
    typeof payload.vectorSearchEnabled === "boolean" &&
    typeof payload.hasCustomApiKey === "boolean" &&
    typeof payload.hasEmbeddingApiKey === "boolean" &&
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
 *  - The MODEL is always required, for every provider, and it must sit in the
 *    selected provider's NAMESPACE — {@link embeddingModelMatchesProvider}, the
 *    same predicate `embeddings.ts`'s `resolveEmbeddingModelName` uses to decide
 *    whether to honour a model id or drop it for the provider default. Without
 *    this leg the gate would accept a mismatch the resolver then silently
 *    overrides, embedding with a model the owner never chose (DW-73).
 *  - The KEY and the ENDPOINT are required only where the provider does not
 *    supply them itself (see {@link SELF_TRANSPORTING_EMBEDDING_PROVIDERS}).
 *
 * What this deliberately does NOT do is teach `hasEmbeddingSupport()` about it.
 * Story 2.9 owns the ingest embed step and Story 3.4 the search merge; moving
 * those here would rewrite `embeddings.test.ts` on behalf of two unwritten
 * stories.
 */
export function canEnableVectorSearch(v: VectorSearchInputs): boolean {
  return vectorSearchMissingLegs(v).length === 0;
}

/** Which legs are unmet, in the order the sentence names them. */
function vectorSearchMissingLegs(v: VectorSearchInputs): string[] {
  if (!v.provider || !isEmbeddingProvider(v.provider)) {
    return ["an embedding provider"];
  }
  const missing: string[] = [];
  if (!SELF_TRANSPORTING_EMBEDDING_PROVIDERS.has(v.provider) && !v.baseUrl) {
    missing.push("an endpoint");
  }
  if (!v.model) {
    missing.push("a model");
  } else if (!embeddingModelMatchesProvider(v.provider, v.model)) {
    // The SAME predicate `resolveEmbeddingModelName` applies, so the gate cannot
    // refuse a combination the resolver would have honoured, or accept one it
    // would silently override.
    missing.push(
      v.provider === "workers-ai"
        ? `a model id in the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace`
        : `a model id outside the Workers AI ${WORKERS_AI_MODEL_PREFIX} namespace`,
    );
  }
  if (!SELF_TRANSPORTING_EMBEDDING_PROVIDERS.has(v.provider) && !v.hasKey) {
    missing.push("an API key");
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
  const list =
    missing.length === 1
      ? missing[0]
      : `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}`;
  return `Vector search needs ${list} before it can be turned on.`;
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
}

/**
 * Validate one `workbench` patch, including the vector rule over the MERGE.
 *
 * Returns the patch rather than a bare `true` so the caller cannot forget to use
 * the narrowed value, and one sentence rather than a field list because the
 * surface shows the server's sentence verbatim.
 */
export function validateWorkbenchSettingsPatch(
  value: unknown,
  stored: WorkbenchSettingsStored,
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
  const enabled =
    typeof patch.vectorSearchEnabled === "boolean"
      ? patch.vectorSearchEnabled
      : stored.vectorSearchEnabled;
  if (enabled) {
    const merged = mergedVectorInputs(patch as WorkbenchSettingsPatch, stored);
    if (!canEnableVectorSearch(merged)) {
      return { ok: false, error: vectorSearchMissingCopy(merged) };
    }
  }

  return { ok: true, patch: patch as WorkbenchSettingsPatch };
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
  };
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
