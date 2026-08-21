/**
 * Story 1.9 — Settings for models and embeddings.
 *
 * The whole story is invisible when it works, and the two parts most likely to
 * rot silently are the SECRET DISCIPLINE (a key goes in and never comes back
 * out, and an untouched key field never disturbs a stored key) and the VECTOR
 * GATE (one predicate, evaluated by the client to disable a control and re-run
 * by the route to refuse a write). Both are pinned here by execution rather
 * than by reading source.
 *
 * `vitest.config.ts` is `environment: "node"` with no DOM (DW-15), so every
 * decision the surface makes lives in `../workbench-settings` and is run
 * directly; the route is run against a real temp `DATA_DIR` so the merge, the
 * refusals and the stored bytes are the real ones; and only the wiring inside
 * the three components — which a node suite genuinely cannot execute — is left
 * to a source scan.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs, { readFile } from "fs/promises";
import os from "os";
import path from "path";

/**
 * The route's gate is `getPrincipal()`. Hoisted so it governs the whole file:
 * there is no Clerk session in a node suite, and what is under test is what the
 * route does WITH a principal. Ownership itself is left REAL and driven by
 * `NEXT_PUBLIC_OWNER_HANDLE`, so the 404 below is the deployment's own rule.
 */
const principal = vi.hoisted(() => ({
  current: null as { id: string; handle: string } | null,
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => principal.current),
}));

/**
 * The Cloudflare `AI` binding the route now reads (DW-225).
 *
 * `getWorkersAiBinding()` calls `getCloudflareContext()`, which THROWS off the
 * Workers runtime — so the default here throws too, which is the honest answer
 * for a node suite and for the Docker deployment `DEPLOY.md` describes. That
 * makes `workers-ai` REFUSED by default in this file, which is the whole point
 * of the leg; the cases that are about a Workers deployment opt in through
 * {@link onWorkers}.
 */
const cloudflare = vi.hoisted(() => ({ ai: null as unknown }));
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: () => {
    if (cloudflare.ai === null) throw new Error("no cloudflare context");
    return { env: { AI: cloudflare.ai } };
  },
}));

/** Put this test on the Workers runtime with the `AI` binding bound. */
function onWorkers(): void {
  cloudflare.ai = { run: vi.fn() };
}

import {
  CONFIG_UNREADABLE_COPY,
  UNSTAMPED_CONFIG_VERSION,
  _resetConfigCache,
  applyWorkbenchSettings,
  getChatModelSettings,
  getCustomBaseUrl,
  getFirecrawlSettings,
  getIngestModelSettings,
  getLlmTimeoutMs,
  getVectorSearchSettings,
  getWorkbenchSettings,
  loadConfig,
  readConfig,
  saveConfig,
  workbenchSettingsStored,
  type AppConfig,
} from "../config";
import {
  EMBEDDING_PROVIDERS,
  PROVIDER_INFO,
  WORKERS_AI_EMBEDDING_MODEL_IDS,
  WORKERS_AI_MODEL_PREFIX,
  embeddingProviderLabel,
} from "../providers";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
  formatIfMatch,
  objectVersion,
} from "../write-precondition";
import { _resetStorage, getStorage } from "../storage";
import {
  DEFAULT_SETTINGS_CATEGORY,
  LLM_TIMEOUT_MAX_SECONDS,
  LLM_TIMEOUT_MIN_SECONDS,
  SECRET_UNTOUCHED,
  SETTINGS_INVALID_MODEL_COPY,
  SETTINGS_INVALID_PROVIDER_COPY,
  SETTINGS_INVALID_TIMEOUT_COPY,
  SETTINGS_INVALID_URL_COPY,
  SETTINGS_LANGUAGE_VALUE,
  SETTINGS_LOAD_FAILED_COPY,
  SETTINGS_ROUTE,
  SETTINGS_TIMEOUT_REASON,
  SETTINGS_SAVE_BAR_COPY,
  SETTINGS_SAVE_ACTION,
  SETTINGS_SAVE_FAILED_COPY,
  SETTINGS_CATEGORIES,
  SETTINGS_CUSTOM_ENDPOINT_COPY,
  SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY,
  SETTINGS_VECTOR_BINDING_ENV_NOTE,
  SETTINGS_VECTOR_BINDING_NOTE,
  SETTINGS_VECTOR_ENV_MODEL_NOTE,
  canEnableVectorSearch,
  draftCanEnableVectorSearch,
  draftEmbeddingKeyStored,
  draftVectorInputs,
  embeddingProviderChanged,
  fetchWorkbenchSettings,
  flatMovableVectorLegs,
  isWorkbenchSettingsPayload,
  saveWorkbenchSettings,
  settingsAnnouncement,
  settingsDirty,
  settingsDraftAfterEmbeddingProvider,
  settingsDraftFromPayload,
  settingsEnvOverrideCopy,
  settingsCategory,
  settingsSaveBody,
  storedVectorInputs,
  validateWorkbenchSettingsPatch,
  vectorSearchFieldIssue,
  vectorSearchInactiveCopy,
  vectorSearchMissingCopy,
  type SettingsFetch,
  type VectorSearchInputs,
  type VectorSearchLegField,
  type WorkbenchSettingsPayload,
} from "../workbench-settings";
import { UNCONFIRMED_STATUSES, unconfirmedWriteMessage } from "../workbench-request";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function readComponent(file: string): Promise<string> {
  return readFile(path.join(WORKBENCH, file), "utf8");
}

// ---------------------------------------------------------------------------
// Fixture — a real temp DATA_DIR, the `config.test.ts` idiom
// ---------------------------------------------------------------------------

let tmpDir: string;
let savedEnv: Record<string, string | undefined>;

/**
 * Every env var that can reach a field this story owns. They are cleared rather
 * than merely saved: `embeddingKeyPresent` counts `OPENAI_API_KEY`, so a
 * developer's own shell could otherwise satisfy the vector gate and turn the
 * refusal tests green for the wrong reason.
 */
const ENV_KEYS = [
  "DATA_DIR",
  "NEXT_PUBLIC_OWNER_HANDLE",
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "GOOGLE_GENERATIVE_AI_API_KEY",
  "DEEPSEEK_API_KEY",
  "OLLAMA_API_KEY",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "LLM_MODEL",
  "LLM_CUSTOM_API_KEY",
  "LLM_CUSTOM_BASE_URL",
  "EMBEDDING_MODEL",
  "EMBEDDING_PROVIDER",
  "FIRECRAWL_API_KEY",
  "YOPEDIA_READONLY",
  "STORAGE_PROVIDER",
];

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wb-settings-"));
  savedEnv = {};
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
  process.env.DATA_DIR = tmpDir;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = "christianlee";
  principal.current = { id: "user_1", handle: "christianlee" };
  // Off the Workers runtime unless a case says otherwise — see `onWorkers`.
  cloudflare.ai = null;
  _resetConfigCache();
  _resetStorage();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  principal.current = null;
  _resetConfigCache();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/** Write a config and prime the sync cache from it, as the route does. */
async function store(config: AppConfig): Promise<void> {
  await saveConfig(config);
  _resetConfigCache();
  await loadConfig();
}

/**
 * The reserved key the precondition token rides under, INSIDE the config object
 * (DW-272). Spelled here so the hand-edit cases below can preserve it: a hand
 * edit that drops it leaves an UNSTAMPED store, which is a different case from
 * the one each of those tests is about.
 */
const VERSION_KEY = "__settingsVersion";

/** Write the config object BY HAND, behind the API, exactly as given. */
async function handWrite(object: Record<string, unknown>): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, ".llm-wiki-config.json"),
    JSON.stringify(object, null, 2) + "\n",
    "utf-8",
  );
  _resetConfigCache();
}

/**
 * The precondition token the STORE currently holds — the opaque stamp
 * `saveConfig` wrote under {@link VERSION_KEY}, not anything derived from the
 * config (DW-197). This is what a surface seeded from `GET` would send back.
 */
async function storedVersion(): Promise<string> {
  const read = await readConfig();
  if (read.status !== "ok") throw new Error("store is unreadable");
  return read.version;
}

/**
 * `PUT /api/settings` REQUIRES the write precondition (DW-63), so the default is
 * the version of what the store CURRENTLY holds — exactly what a surface seeded
 * from `GET` would send back. Pass `ifMatch` to send a stale one, or `null` to
 * send none, and exercise the two refusals.
 */
async function put(
  body: Record<string, unknown>,
  ifMatch?: string | null,
): Promise<Request> {
  const version = ifMatch === undefined ? await storedVersion() : ifMatch;
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(version === null ? {} : { "If-Match": formatIfMatch(version) }),
    },
    body: JSON.stringify(body),
  });
}

/** The `{ error }` sentence a refusal answered with. */
async function response412Error(response: Response): Promise<unknown> {
  return ((await response.json()) as { error?: unknown }).error;
}

/** Read the config file back through storage, bypassing the sync cache. */
async function stored(): Promise<AppConfig> {
  _resetConfigCache();
  return loadConfig();
}

/** A payload with every field at its "fresh deployment" value. */
function emptyPayload(): WorkbenchSettingsPayload {
  return {
    // The write precondition the surface sends back as `If-Match` (DW-63) — the
    // opaque stamp the store holds. Optional on the payload since DW-199: an
    // absent one degrades to "keep the version already held" rather than
    // failing the whole read.
    version: "s1:00000000000000000000000000000000",
    chatProvider: null,
    chatModel: null,
    ingestProvider: null,
    ingestModel: null,
    customBaseUrl: null,
    hasCustomApiKey: false,
    llmTimeoutSeconds: null,
    vectorSearchEnabled: false,
    embeddingProvider: null,
    embeddingModel: null,
    embeddingBaseUrl: null,
    hasEmbeddingApiKey: false,
    // Nothing set and nothing embedding, so there is no substitution to
    // announce — the "fresh deployment" answer for the DW-312 pair too.
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    // No `LLM_CUSTOM_BASE_URL` on a fresh deployment, so the Custom endpoint box
    // has no override to announce (DW-71).
    envCustomBaseUrl: null,
    envEmbeddingApiKeyProviders: [],
    // The Docker/compose answer, which is what a "fresh deployment" means for
    // every case in this file that does not say otherwise (DW-225).
    hasWorkersAiBinding: false,
    firecrawlBaseUrl: null,
    hasFirecrawlApiKey: false,
    language: SETTINGS_LANGUAGE_VALUE,
    readOnly: false,
  };
}

// ---------------------------------------------------------------------------
// The category vocabulary
// ---------------------------------------------------------------------------

describe("the settings nav vocabulary", () => {
  it("lists the six categories it built and the three the later epics own", () => {
    const labels = SETTINGS_CATEGORIES.map((category) => category.label);
    for (const required of [
      "General",
      "LLM Models",
      "Embeddings",
      "Interface",
      "About",
      "Intake",
      "MinerU PDF",
      "API + MCP",
      "External Sources",
    ]) {
      expect(labels).toContain(required);
    }
  });

  it("opens on General", () => {
    expect(DEFAULT_SETTINGS_CATEGORY).toBe("general");
    expect(SETTINGS_CATEGORIES.map((c) => c.id)).toContain(DEFAULT_SETTINGS_CATEGORY);
  });

  it("gives every category a unique id and a non-empty label", () => {
    const ids = SETTINGS_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of SETTINGS_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
    }
  });

  it("marks exactly the three unbuilt categories as pending, each with one sentence", () => {
    const pending = SETTINGS_CATEGORIES.filter((c) => c.pending !== null).map((c) => c.id);
    // Listed, not required to function. A category that rendered nothing would
    // be a dead nav row; one that rendered a stub would lie about what works.
    expect(pending.sort()).toEqual(["api-mcp", "intake", "mineru"]);
    for (const category of SETTINGS_CATEGORIES) {
      if (category.pending === null) continue;
      expect(category.pending.endsWith(".")).toBe(true);
    }
  });

  it("announces the surface as `Settings, <category>`", () => {
    expect(settingsAnnouncement("Embeddings")).toBe("Settings, Embeddings");
    expect(settingsAnnouncement(SETTINGS_CATEGORIES[0].label)).toBe("Settings, General");
  });

  it("keeps the save bar's standing sentence exactly as the handoff fixes it", () => {
    expect(SETTINGS_SAVE_BAR_COPY).toBe("Changes apply after saving");
  });
});

// ---------------------------------------------------------------------------
// The vector predicate — ONE rule
// ---------------------------------------------------------------------------

/**
 * A {@link VectorSearchInputs} from the four legs a case is ABOUT, with the
 * three facts DW-218/DW-225/DW-281 added at their "not in play" values:
 * `"stored"` twice (the editable controls hold the model and the provider, so
 * they are what a wrong value is about) and `null` (this caller cannot know
 * whether a Cloudflare `AI` binding exists, so the binding leg is not applied).
 * The cases that are ABOUT any of the three pass it explicitly, which is what
 * keeps every other case here reading as it did.
 */
type VectorLegs = Omit<
  VectorSearchInputs,
  "modelOrigin" | "providerOrigin" | "hasWorkersAiBinding"
> &
  Partial<
    Pick<VectorSearchInputs, "modelOrigin" | "providerOrigin" | "hasWorkersAiBinding">
  >;

function vectorInputs(legs: VectorLegs): VectorSearchInputs {
  return {
    modelOrigin: "stored",
    providerOrigin: "stored",
    hasWorkersAiBinding: null,
    ...legs,
  };
}

/** {@link canEnableVectorSearch} over {@link vectorInputs}. */
function canEnable(legs: VectorLegs): boolean {
  return canEnableVectorSearch(vectorInputs(legs));
}

/** {@link vectorSearchMissingCopy} over {@link vectorInputs}. */
function missingCopy(legs: VectorLegs): string {
  return vectorSearchMissingCopy(vectorInputs(legs));
}

/**
 * The model refusal under `workers-ai`, spelled once. Built from the catalog
 * rather than typed, so adding a supported id updates the expectation with the
 * sentence instead of leaving a stale literal behind.
 */
const UNSUPPORTED_WORKERS_MODEL_LIST = `a supported Cloudflare Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")})`;

const UNSUPPORTED_WORKERS_MODEL = `Vector search needs ${UNSUPPORTED_WORKERS_MODEL_LIST} before it can be turned on.`;

/**
 * The same refusal in the SWITCHED-ON frame (DW-308) — what the route answers
 * when the store already held the flag `true`, so the save bar lands the
 * sentence beside a box the payload still shows ticked. Same legs, same order;
 * only the frame differs.
 */
const UNSUPPORTED_WORKERS_MODEL_INACTIVE = `Vector search is switched on, but it needs ${UNSUPPORTED_WORKERS_MODEL_LIST} before it can run. Turn it off, or supply what is missing.`;

/**
 * …and the same sentence again for the FLAT surface (DW-329).
 *
 * A refusal the route SCOPED is one the flat `/settings` page will read, and
 * that page renders no vector switch — so the action clause names where the
 * switch lives instead of instructing the owner to flip one that is not there.
 * Everything before that clause is shared with the two constants above, which
 * is the property the frames exist to preserve.
 */
const UNSUPPORTED_WORKERS_MODEL_INACTIVE_FLAT = `Vector search is switched on, but it needs ${UNSUPPORTED_WORKERS_MODEL_LIST} before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.`;

describe("canEnableVectorSearch", () => {
  it("requires an EXPLICIT embedding provider before anything else", () => {
    // `resolveEmbeddingProvider`'s auto-detect branch consults env vars only, so
    // without this leg an owner could satisfy endpoint + model + stored key,
    // turn the switch on, and still resolve no embedding provider at all.
    const legs = { baseUrl: "https://e", model: "m", hasKey: true };
    expect(canEnable({ provider: null, ...legs })).toBe(false);
    expect(canEnable({ provider: "", ...legs })).toBe(false);
    // A provider that cannot embed is not a selection either.
    expect(canEnable({ provider: "anthropic", ...legs })).toBe(false);
    expect(canEnable({ provider: "openai", ...legs })).toBe(true);
  });

  it("requires all three legs for a KEYED provider, in every combination", () => {
    const cases: Array<[string | null, string | null, boolean, boolean]> = [
      [null, null, false, false],
      ["https://e", null, false, false],
      [null, "m", false, false],
      [null, null, true, false],
      ["https://e", "m", false, false],
      ["https://e", null, true, false],
      [null, "m", true, false],
      ["https://e", "m", true, true],
    ];
    for (const provider of ["openai", "google"]) {
      for (const [baseUrl, model, hasKey, expected] of cases) {
        expect(canEnable({ provider, baseUrl, model, hasKey })).toBe(expected);
      }
    }
  });

  it("needs only a model from a provider that carries its own transport", () => {
    // `embeddings.ts` documents both as keyless and reaches them through
    // `getOllamaBaseUrl()` / the Cloudflare `AI` binding. Demanding an endpoint
    // and a key would make vector search unreachable for half the supported
    // providers, and would store an endpoint no code path reads.
    // The model must still sit in the provider's own namespace, which is why
    // `workers-ai` is fed a `@cf/` id here rather than the bare `"m"` Ollama
    // takes (DW-73).
    for (const [provider, model] of [
      ["ollama", "m"],
      ["workers-ai", "@cf/baai/bge-m3"],
    ] as const) {
      expect(canEnable({ provider, baseUrl: null, model, hasKey: false })).toBe(
        true,
      );
      expect(
        canEnable({ provider, baseUrl: null, model: null, hasKey: false }),
      ).toBe(false);
    }
  });

  it("refuses a model id from the WRONG namespace, in both directions", () => {
    // `resolveEmbeddingModelName` honours an override only when
    // `id.startsWith("@cf/")` matches `provider === "workers-ai"`, and silently
    // falls back to the provider default otherwise. Accepting the mismatch here
    // would turn the switch on and then embed with a model nobody selected.
    expect(
      canEnable({
        provider: "workers-ai",
        baseUrl: null,
        model: "text-embedding-3-small",
        hasKey: false,
      }),
    ).toBe(false);
    expect(
      canEnable({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(false);
    // Both matching cases still pass — the rule is an equality, not a ban.
    expect(
      canEnable({
        provider: "workers-ai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(true);
    expect(
      canEnable({
        provider: "openai",
        baseUrl: "https://e",
        model: "text-embedding-3-small",
        hasKey: true,
      }),
    ).toBe(true);
  });

  it("applies the namespace leg to EVERY embedding provider, not just openai", () => {
    // Ollama is the case where the namespace leg stands ALONE: it is
    // self-transporting, so there is no endpoint or key leg beside it to make
    // the sentence non-empty for the wrong reason.
    expect(
      canEnable({
        provider: "ollama",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(false);
    expect(
      missingCopy({
        provider: "ollama",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.",
    );
    // Google is a keyed provider, and gets the same answer OpenAI does.
    expect(
      canEnable({
        provider: "google",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(false);
    expect(
      canEnable({
        provider: "google",
        baseUrl: "https://e",
        model: "gemini-embedding-001",
        hasKey: true,
      }),
    ).toBe(true);
  });

  it("treats the empty string as unset, not as set to nothing", () => {
    expect(
      canEnable({ provider: "openai", baseUrl: "", model: "m", hasKey: true }),
    ).toBe(false);
    expect(
      canEnable({
        provider: "openai",
        baseUrl: "https://e",
        model: "",
        hasKey: true,
      }),
    ).toBe(false);
  });

  it("names what is missing FOR THE SELECTED PROVIDER", () => {
    expect(
      missingCopy({
        provider: null,
        baseUrl: "https://e",
        model: "m",
        hasKey: true,
      }),
    ).toBe("Vector search needs an embedding provider before it can be turned on.");
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs an endpoint, a model and an API key before it can be turned on.",
    );
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "m",
        hasKey: false,
      }),
    ).toBe("Vector search needs an API key before it can be turned on.");
    // Ollama is never told to find a key it does not have.
    expect(
      missingCopy({
        provider: "ollama",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe("Vector search needs a model before it can be turned on.");
    // Nothing missing is not a sentence — the caller shows the ordinary hint.
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "m",
        hasKey: true,
      }),
    ).toBe("");
  });

  it("names the NAMESPACE rather than repeating \"a model\" (DW-73)", () => {
    expect(
      missingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: "text-embedding-3-small",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a supported Cloudflare Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(
      "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.",
    );
    // A leg, not a separate sentence: it composes with the others in leg order
    // instead of hiding them.
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace and an API key before it can be turned on.",
    );
    // THREE legs, which is what pins the new leg's POSITION: it is the middle
    // clause, between the endpoint and the key, because that is the order
    // `vectorSearchMissingLegs` pushes them in. A two-leg case alone cannot
    // tell "second" from "last".
    expect(
      missingCopy({
        provider: "openai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs an endpoint, a model id outside the Cloudflare Workers AI @cf/ namespace and an API key before it can be turned on.",
    );
    // No model at all is still just "a model" — the namespace clause needs a
    // value to complain about.
    expect(
      missingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe("Vector search needs a model before it can be turned on.");
    // And an id that matches its provider is not named at all.
    expect(
      missingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe("");
  });

  it("refuses a @cf/ id that is NOT a supported embedding model (DW-220)", () => {
    // The id is genuinely inside the namespace, so the old sentence — "needs a
    // model id in the Workers AI @cf/ namespace" — described a condition the
    // owner had already met, next to a switch that stayed off. `ai.run()` is
    // where it used to fail.
    for (const model of ["@cf/", "@cf/llava-hf/llava-1.5-7b-hf", "constructor"]) {
      expect(
        canEnable({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(false);
      expect(
        missingCopy({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(
        "Vector search needs a supported Cloudflare Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
      );
    }
  });

  it("accepts every id the sentence names, so the copy is not a dead end", () => {
    // The refusal lists four ids; each one must actually clear the gate, or the
    // sentence sends the owner somewhere the switch still says no.
    for (const model of WORKERS_AI_EMBEDDING_MODEL_IDS) {
      expect(
        canEnable({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(true);
    }
  });

  it("names EMBEDDING_MODEL only when the ENVIRONMENT owns the mismatch (DW-218)", () => {
    // The same four legs, twice, differing only in ORIGIN. Without the note the
    // sentence sends the owner to a box whose value the gate never reads: they
    // type a supported id, save successfully, and the switch still will not turn
    // on. With it for a STORED mismatch it would send them to a variable that is
    // not set. Both directions, because either alone reads as an accident.
    const legs = {
      provider: "workers-ai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
      hasWorkersAiBinding: true,
    } as const;
    expect(missingCopy({ ...legs, modelOrigin: "env" })).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
    expect(missingCopy({ ...legs, modelOrigin: "stored" })).toBe(
      UNSUPPORTED_WORKERS_MODEL,
    );
    // The note NAMES the variable — that is the whole content of the fix.
    expect(SETTINGS_VECTOR_ENV_MODEL_NOTE).toContain("EMBEDDING_MODEL");
  });

  it("adds a BINDING leg for Workers AI with no Cloudflare AI binding (DW-225)", () => {
    // `workers-ai` is exempt from the endpoint and the key BECAUSE the binding
    // supplies both, so off Workers nothing is left — the switch turned on for a
    // deployment where `resolveEmbeddingProvider` returns `null` forever.
    const legs = {
      provider: "workers-ai",
      baseUrl: null,
      model: "@cf/baai/bge-m3",
      hasKey: false,
    } as const;
    expect(canEnable({ ...legs, hasWorkersAiBinding: false })).toBe(false);
    expect(missingCopy({ ...legs, hasWorkersAiBinding: false })).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // Bound: nothing missing at all.
    expect(canEnable({ ...legs, hasWorkersAiBinding: true })).toBe(true);
    // NOT KNOWABLE: the leg is not applied, which is the pre-change answer and
    // the one `getVectorSearchSettings()` has to keep giving.
    expect(canEnable({ ...legs, hasWorkersAiBinding: null })).toBe(true);
  });

  it("applies the binding leg to NO other provider", () => {
    // The exemption it complements is `workers-ai`-only; a missing binding says
    // nothing about Ollama, which reaches its own server over HTTP.
    expect(
      canEnable({
        provider: "ollama",
        baseUrl: null,
        model: "nomic-embed-text",
        hasKey: false,
        hasWorkersAiBinding: false,
      }),
    ).toBe(true);
  });

  it("composes the binding leg with the model leg rather than hiding it", () => {
    // Both wrong at once: the sentence lists both, in leg order, and carries
    // both notes. A refusal that named one would send the owner round twice.
    expect(
      missingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: "text-embedding-3-small",
        hasKey: false,
        modelOrigin: "env",
        hasWorkersAiBinding: false,
      }),
    ).toBe(
      "Vector search needs a supported Cloudflare Workers AI model id " +
        `(${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) and the Cloudflare AI binding ` +
        `before it can be turned on. ${SETTINGS_VECTOR_ENV_MODEL_NOTE} ` +
        SETTINGS_VECTOR_BINDING_NOTE,
    );
  });

  it("picks the note the OWNER can act on when EMBEDDING_PROVIDER forces the selection (DW-281)", () => {
    // The stored note's second way out — "choose another embedding provider" —
    // is advice the provider select cannot follow while the variable is set:
    // every feeder takes `EMBEDDING_PROVIDER` ahead of the stored selection, so
    // a different provider picked in the box changes nothing and the switch
    // stays refused. The env variant names unsetting the variable instead.
    const legs = {
      provider: "workers-ai",
      baseUrl: null,
      model: "@cf/baai/bge-m3",
      hasKey: false,
      hasWorkersAiBinding: false,
    } as const;
    expect(missingCopy({ ...legs, providerOrigin: "env" })).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_ENV_NOTE}`,
    );
    // The variable is named, and naming it is what turns "choose another
    // provider" back into an action: unset it FIRST, and then the select works.
    expect(SETTINGS_VECTOR_BINDING_ENV_NOTE).toContain(
      "unset EMBEDDING_PROVIDER to choose another embedding provider",
    );
    // …and NOT the stored note's unconditional form, which is the advice this
    // deployment cannot follow.
    expect(SETTINGS_VECTOR_BINDING_ENV_NOTE).not.toContain(
      "or choose another embedding provider",
    );
    // It also does not restate `settingsEnvOverrideCopy`, which already says the
    // variable wins over the box and is ALREADY the provider row's standing
    // hint — the two ride on the same control, so a second telling is the same
    // duplication the `"model"` exception in `vectorSearchFieldIssue` avoids.
    expect(SETTINGS_VECTOR_BINDING_ENV_NOTE).not.toContain("wins at runtime");
    expect(settingsEnvOverrideCopy("provider", "workers-ai")).toContain(
      "wins at runtime",
    );
    // …and the stored half is untouched, where that advice IS actionable.
    expect(missingCopy({ ...legs, providerOrigin: "stored" })).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // The origin changes only the NOTE — the refusal itself, and whether there
    // is one at all, is the same rule either way.
    expect(canEnable({ ...legs, providerOrigin: "env" })).toBe(false);
    expect(canEnable({ ...legs, providerOrigin: "stored" })).toBe(false);
  });
});

describe("vectorSearchInactiveCopy — what a SWITCHED-ON switch says (DW-279)", () => {
  /** {@link vectorSearchInactiveCopy} over {@link vectorInputs}. */
  function inactiveCopy(legs: VectorLegs): string {
    return vectorSearchInactiveCopy(vectorInputs(legs));
  }

  it("acknowledges the switch instead of describing it as un-turn-on-able", () => {
    // The payload serves the STORED flag rather than the intersected one, so a
    // config whose legs went missing renders CHECKED. Beside a ticked box,
    // "before it can be turned on" describes a state the surface is visibly not
    // in, and leaves the owner unable to tell whether the feature is running.
    const copy = inactiveCopy({
      provider: "openai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
    });
    expect(copy).toBe(
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.",
    );
    expect(copy).not.toContain("before it can be turned on");
    // It says what the SETTINGS still need, never what the deployment is doing.
    // Every term the surface computes is draft-derived, so a claim about the
    // running deployment would be false the moment an unsaved edit unmet a leg
    // while the stored config went on working.
    expect(copy).not.toContain("inactive");
    // The action the owner actually HAS here is named — turning it off is
    // always allowed, which is exactly what `vectorRefused` leaves operable.
    expect(copy).toContain("Turn it off");
  });

  it("lists the same legs in the same order as the refusal, and carries their notes", () => {
    // One sentence frame differs; the legs, their order and their notes do not.
    // Anything else and the two sentences would disagree about what is wrong.
    const legs = {
      provider: "workers-ai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
      modelOrigin: "env",
      hasWorkersAiBinding: false,
    } as const;
    const list = `a supported Cloudflare Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) and the Cloudflare AI binding`;
    expect(missingCopy(legs)).toBe(
      `Vector search needs ${list} before it can be turned on. ${SETTINGS_VECTOR_ENV_MODEL_NOTE} ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    expect(inactiveCopy(legs)).toBe(
      `Vector search is switched on, but it needs ${list} before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_ENV_MODEL_NOTE} ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
  });

  it("says nothing at all when every leg is met", () => {
    // The switch is on AND working, which is the surface's ordinary hint — not
    // this sentence with an empty list.
    expect(
      inactiveCopy({
        provider: "ollama",
        baseUrl: null,
        model: "nomic-embed-text",
        hasKey: false,
      }),
    ).toBe("");
  });

  // -------------------------------------------------------------------------
  // The FLAT frame — the same state, said where there is no switch (DW-329)
  // -------------------------------------------------------------------------

  describe("the flat frame", () => {
    /** The four-leg case, in both frames, from one set of inputs. */
    const LEGS = {
      provider: "workers-ai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
      modelOrigin: "env",
      hasWorkersAiBinding: false,
    } as const;

    it("differs from the default frame ONLY in the trailing action clause", () => {
      // The legs, their order and their notes are the DIAGNOSIS, and the
      // diagnosis is a property of the configuration rather than of who is
      // looking at it. Two surfaces disagreeing about what is wrong is exactly
      // what parameterizing the sentence must not be allowed to produce.
      const workbench = vectorSearchInactiveCopy(vectorInputs(LEGS));
      const flat = vectorSearchInactiveCopy(vectorInputs(LEGS), "flat");

      const shared = `Vector search is switched on, but it needs a supported Cloudflare Workers AI model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")}) and the Cloudflare AI binding before it can run.`;
      const notes = `${SETTINGS_VECTOR_ENV_MODEL_NOTE} ${SETTINGS_VECTOR_BINDING_NOTE}`;

      expect(workbench).toBe(
        `${shared} Turn it off, or supply what is missing. ${notes}`,
      );
      expect(flat).toBe(
        `${shared} Supply what is missing, or turn the switch off in Workbench Settings → Embeddings. ${notes}`,
      );
      // Said as a property rather than as two literals: strip each frame's own
      // action clause and what is left is the identical string.
      expect(workbench.replace("Turn it off, or supply what is missing. ", "")).toBe(
        flat.replace(
          "Supply what is missing, or turn the switch off in Workbench Settings → Embeddings. ",
          "",
        ),
      );
    });

    it("names the Embeddings category by its NAV label rather than by a literal", () => {
      // The pointer and the nav row are the same one string, so renaming the
      // category cannot leave the sentence pointing at a name that is no longer
      // on screen.
      expect(vectorSearchInactiveCopy(vectorInputs(LEGS), "flat")).toContain(
        `Settings → ${settingsCategory("embeddings").label}`,
      );
      // …and it does NOT tell an owner who cannot see the switch to turn it off.
      expect(vectorSearchInactiveCopy(vectorInputs(LEGS), "flat")).not.toContain(
        "Turn it off",
      );
    });

    it("still says nothing at all when every leg is met", () => {
      // The frame decides the wording of a sentence, never whether there is
      // one: `canEnableVectorSearch` is the sole rule, and a satisfied config
      // is silent on both surfaces.
      const satisfied = vectorInputs({
        provider: "ollama",
        baseUrl: null,
        model: "nomic-embed-text",
        hasKey: false,
      });
      expect(vectorSearchInactiveCopy(satisfied, "flat")).toBe("");
      expect(vectorSearchInactiveCopy(satisfied)).toBe("");
      expect(canEnableVectorSearch(satisfied)).toBe(true);
    });

    it("agrees with the default frame about WHETHER there is a sentence, leg for leg", () => {
      // Swept across the shapes the two frames could have diverged on — an
      // early-returning provider leg, a single leg, several legs, and a
      // satisfied config.
      const cases: VectorLegs[] = [
        { provider: null, baseUrl: null, model: null, hasKey: false },
        { provider: "openai", baseUrl: null, model: null, hasKey: false },
        {
          provider: "openai",
          baseUrl: "https://embed.example",
          model: "text-embedding-3-small",
          hasKey: true,
        },
        {
          provider: "workers-ai",
          baseUrl: null,
          model: "@cf/baai/bge-m3",
          hasWorkersAiBinding: true,
          hasKey: false,
        },
      ];
      for (const legs of cases) {
        const inputs = vectorInputs(legs);
        expect(vectorSearchInactiveCopy(inputs, "flat") === "").toBe(
          vectorSearchInactiveCopy(inputs) === "",
        );
        expect(vectorSearchInactiveCopy(inputs, "flat") === "").toBe(
          canEnableVectorSearch(inputs),
        );
      }
    });

    it("defaults to the Workbench frame, so `SettingsCanvas` is untouched", () => {
      // The one-argument call is what every existing caller makes, and it must
      // go on producing the sentence it produced before the parameter existed.
      expect(vectorSearchInactiveCopy(vectorInputs(LEGS))).toBe(
        vectorSearchInactiveCopy(vectorInputs(LEGS), "workbench"),
      );
    });
  });
});

// ---------------------------------------------------------------------------
// The vector inputs as the STORE holds them (DW-327)
// ---------------------------------------------------------------------------

describe("storedVectorInputs — the flat page's view of the vector rule", () => {
  it("answers exactly what a FRESHLY SEEDED Workbench draft answers", () => {
    // The claim the flat advisory rests on: a just-loaded Workbench and
    // `/settings` cannot disagree about which legs are unmet, because the two
    // read the same function over the same payload.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://embed.example",
      hasEmbeddingApiKey: true,
    };

    expect(storedVectorInputs(payload)).toEqual(
      draftVectorInputs(settingsDraftFromPayload(payload), payload),
    );
    expect(canEnableVectorSearch(storedVectorInputs(payload))).toBe(true);
  });

  it("reads a STORED key even though the draft's key field shows nothing", () => {
    // The seeded secret is `SECRET_UNTOUCHED`, which means "leave the stored one
    // alone" rather than "there is none" — a helper that read the blank string
    // as an absent key would report a KEY leg for a deployment that has one.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://embed.example",
      hasEmbeddingApiKey: true,
    };
    expect(settingsDraftFromPayload(payload).embeddingApiKey).toBe(SECRET_UNTOUCHED);
    expect(storedVectorInputs(payload).hasKey).toBe(true);
    expect(vectorSearchInactiveCopy(storedVectorInputs(payload), "flat")).toBe("");
  });

  it("lets the ENVIRONMENT win, and reports the origin it won with", () => {
    // The same precedence both halves of the rule apply. Without it the flat
    // page would name the model box for a value `EMBEDDING_MODEL` owns.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      envEmbeddingProvider: "workers-ai",
      envEmbeddingModel: "@cf/baai/bge-m3",
      hasWorkersAiBinding: true,
    };
    const inputs = storedVectorInputs(payload);
    expect(inputs.provider).toBe("workers-ai");
    expect(inputs.model).toBe("@cf/baai/bge-m3");
    expect(inputs.modelOrigin).toBe("env");
    expect(inputs.providerOrigin).toBe("env");
  });

  it("names the unmet legs of a switch that is stored ON but inactive", () => {
    // The DW-327 state itself: the switch is on, the legs are not met, and the
    // flat page has to be able to say so.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    };
    expect(vectorSearchInactiveCopy(storedVectorInputs(payload), "flat")).toBe(
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    );
  });
});

// ---------------------------------------------------------------------------
// The Custom advisory, on the surface with no fields for it (DW-61)
// ---------------------------------------------------------------------------

describe("SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY", () => {
  it("points at the LLM Models category by its nav label, on the surface named in full", () => {
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).toBe(
      `Custom uses an OpenAI-compatible endpoint. Set the base URL and the API key in Workbench Settings → ${settingsCategory("llm-models").label}.`,
    );
  });

  it("says the same thing the Workbench twin says, minus its 'below'", () => {
    // Two surfaces, one fact. The Workbench renders the two fields beneath the
    // sentence, so it can say "below"; the flat page does not, so it says
    // where. Everything before the pointer is identical.
    const lead = "Custom uses an OpenAI-compatible endpoint. ";
    expect(SETTINGS_CUSTOM_ENDPOINT_COPY.startsWith(lead)).toBe(true);
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY.startsWith(lead)).toBe(true);
    // The flat one cannot say "below" — there is nothing below it.
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).not.toContain("below");
  });

  it("names the OTHER surface in full, because 'Settings' alone is the page it renders on", () => {
    // `SETTINGS_CATEGORIES` is the nav of the Workbench's `SettingsCanvas` and
    // exists nowhere else. The app's own "Settings" nav row
    // (`NavHeader.tsx:197`, `:322`) routes to `/settings` — the flat page this
    // advisory renders on, whose `<h1>` also reads "Settings". So a bare
    // "Settings → LLM Models" here would read as a path inside the page the
    // owner is already standing on, and send them nowhere.
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).toContain(
      "Workbench Settings → LLM Models",
    );
    // The SURFACE word is the only thing typed; the category half stays derived.
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).toContain(
      settingsCategory("llm-models").label,
    );
  });

  it("is deliberately NOT the string `llm.ts`'s runtime refusals use", () => {
    // `getResolvedCredentials` throws "Set it in Settings → LLM Models." for a
    // `custom` provider with no base URL, no key, or no model. Those are
    // RUNTIME errors raised from the LLM call rather than sentences rendered on
    // a Settings page, so the ambiguity this pointer resolves does not arise
    // there — and the two strings are not required to match. Pinned so that a
    // later attempt to "unify" them has to read this reasoning first.
    const runtimeDestination = "Settings → LLM Models";
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).not.toContain(
      ` in ${runtimeDestination}`,
    );
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).toContain(
      ` in Workbench ${runtimeDestination}`,
    );
  });
});

describe("vectorSearchFieldIssue — what the MODEL BOX says about itself (DW-223)", () => {
  const workersAi = {
    provider: "workers-ai",
    baseUrl: null,
    hasKey: false,
    hasWorkersAiBinding: true,
  } as const;

  it("marks the box invalid when the box's OWN value is the wrong one", () => {
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAi, model: "text-embedding-3-small", modelOrigin: "stored" }),
        "model",
      ),
    ).toEqual({ copy: UNSUPPORTED_WORKERS_MODEL, invalid: true });
  });

  it("describes but does NOT mark an env-owned mismatch", () => {
    // `EMBEDDING_MODEL` wins over the box, so the box is not what is wrong and
    // marking it is a dead end — the owner still needs to know what the gate is
    // unhappy about, which is why the copy is the same.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAi, model: "text-embedding-3-small", modelOrigin: "env" }),
        "model",
      ),
    ).toEqual({ copy: UNSUPPORTED_WORKERS_MODEL, invalid: false });
  });

  it("says nothing when the id matches, when the box is empty, or when no provider is chosen", () => {
    // A matching id: no complaint.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAi, model: "@cf/baai/bge-m3" }),
        "model",
      ),
    ).toBeNull();
    // An EMPTY box holds no wrong value — the checkbox's own "needs a model"
    // sentence carries that, and marking an empty optional field invalid would
    // be a complaint about a state the owner has not entered.
    expect(
      vectorSearchFieldIssue(vectorInputs({ ...workersAi, model: null }), "model"),
    ).toBeNull();
    // No provider: the gate has exactly ONE leg, and it is not this row's.
    const noProvider = vectorInputs({
      provider: null,
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
    });
    expect(vectorSearchFieldIssue(noProvider, "model")).toBeNull();
    expect(vectorSearchMissingCopy(noProvider)).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
  });

  it("carries the leg's sentence ALONE, never the EMBEDDING_MODEL note", () => {
    // The model row already carries `settingsEnvOverrideCopy` saying where the
    // value comes from; a second sentence about the same variable would only
    // repeat it, so the note stays on the checkbox.
    const issue = vectorSearchFieldIssue(
      vectorInputs({ ...workersAi, model: "text-embedding-3-small", modelOrigin: "env" }),
      "model",
    );
    expect(issue?.copy).not.toContain("EMBEDDING_MODEL");
  });

  it("is not disturbed by the OTHER legs being unmet", () => {
    // A keyed provider missing its endpoint and key still gets exactly the model
    // sentence here — the row speaks for its own field, not for the switch.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({
          provider: "openai",
          baseUrl: null,
          model: "@cf/baai/bge-m3",
          hasKey: false,
        }),
        "model",
      ),
    ).toEqual({
      copy: "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.",
      invalid: true,
    });
  });
});

describe("vectorSearchFieldIssue — every refusable control, one rule (DW-277)", () => {
  const workersAiUnbound = {
    provider: "workers-ai",
    baseUrl: null,
    model: "@cf/baai/bge-m3",
    hasKey: false,
    hasWorkersAiBinding: false,
  } as const;

  it("gives the BINDING leg to the provider select, which is the only control that can move it", () => {
    // Nothing on this surface binds `ai` in `wrangler.jsonc`, so the leg has no
    // control of its own — but choosing a different embedding provider drops it
    // entirely, which makes the select the one control the complaint can act
    // through. Before this it belonged to nothing and the select stayed silent.
    expect(
      vectorSearchFieldIssue(vectorInputs(workersAiUnbound), "provider"),
    ).toEqual({
      copy: `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
      invalid: true,
    });
    // The model row is silent about it — the id is not what is wrong.
    expect(vectorSearchFieldIssue(vectorInputs(workersAiUnbound), "model")).toBeNull();
  });

  it("describes but does NOT mark an env-owned selection, and swaps the note", () => {
    // Same dead end `modelOrigin` closes for the model box: `EMBEDDING_PROVIDER`
    // wins over the select, so marking it "wrong, fix it" points at a control
    // that cannot fix it — and the note has to name the variable rather than
    // "choose another provider" (DW-281).
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAiUnbound, providerOrigin: "env" }),
        "provider",
      ),
    ).toEqual({
      copy: `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_ENV_NOTE}`,
      invalid: false,
    });
  });

  it("says nothing once the binding exists", () => {
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAiUnbound, hasWorkersAiBinding: true }),
        "provider",
      ),
    ).toBeNull();
    // And nothing where the fact is not knowable, which applies no leg at all.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...workersAiUnbound, hasWorkersAiBinding: null }),
        "provider",
      ),
    ).toBeNull();
  });

  it("complains where the select holds a value the gate does not recognise", () => {
    // Present-and-wrong, so the select IS what is at fault — the same test the
    // model box passes for a mismatched id.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ provider: "acme", baseUrl: null, model: "m", hasKey: false }),
        "provider",
      ),
    ).toEqual({
      copy: "Vector search needs an embedding provider before it can be turned on.",
      invalid: true,
    });
  });

  it("treats an UNSET provider as absence, not as a wrong value", () => {
    // The select holds nothing, so it holds nothing WRONG. Its standing
    // `SETTINGS_VECTOR_PROVIDER_COPY` hint is already the complaint, and the
    // checkbox lists the leg once — a second copy on the select would be the
    // same sentence twice on one screen.
    const unset = vectorInputs({
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    });
    expect(vectorSearchFieldIssue(unset, "provider")).toBeNull();
    expect(vectorSearchMissingCopy(unset)).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
  });

  it("never produces an issue for the ENDPOINT or the KEY, whose legs are pure absence", () => {
    // Not an omission — the answer. Both legs fire only when the value is
    // MISSING, and a missing value is not a wrong one, so a fresh deployment
    // renders no box repeating a leg the checkbox already lists in one sentence.
    const bare = vectorInputs({
      provider: "openai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
    });
    expect(vectorSearchMissingCopy(bare)).toBe(
      "Vector search needs an endpoint and an API key before it can be turned on.",
    );
    expect(vectorSearchFieldIssue(bare, "endpoint")).toBeNull();
    expect(vectorSearchFieldIssue(bare, "key")).toBeNull();
    // …and neither does a SATISFIED endpoint or key, for the ordinary reason.
    const filled = vectorInputs({
      provider: "openai",
      baseUrl: "https://embed.example",
      model: "text-embedding-3-small",
      hasKey: true,
    });
    expect(vectorSearchFieldIssue(filled, "endpoint")).toBeNull();
    expect(vectorSearchFieldIssue(filled, "key")).toBeNull();
    expect(vectorSearchFieldIssue(filled, "provider")).toBeNull();
    expect(vectorSearchFieldIssue(filled, "model")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The draft, the dirty rule, and the save body
// ---------------------------------------------------------------------------

describe("the settings draft", () => {
  it("seeds every field from the payload and every secret as untouched", () => {
    const draft = settingsDraftFromPayload({
      ...emptyPayload(),
      chatProvider: "openai",
      chatModel: "gpt-4o",
      llmTimeoutSeconds: 60,
      hasCustomApiKey: true,
      hasEmbeddingApiKey: true,
      hasFirecrawlApiKey: true,
    });
    expect(draft.chatProvider).toBe("openai");
    expect(draft.chatModel).toBe("gpt-4o");
    expect(draft.llmTimeoutSeconds).toBe("60");
    // A presence boolean does NOT seed the box: there is no stored key on the
    // client to seed it with, which is the whole of the secret discipline.
    expect(draft.customApiKey).toBe(SECRET_UNTOUCHED);
    expect(draft.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    expect(draft.firecrawlApiKey).toBe(SECRET_UNTOUCHED);
  });

  it("is clean when seeded, dirty when moved, and clean again when reverted", () => {
    const payload = { ...emptyPayload(), chatModel: "gpt-4o" };
    const seeded = settingsDraftFromPayload(payload);
    expect(settingsDirty(seeded, payload)).toBe(false);
    const edited = { ...seeded, chatModel: "gpt-4o-mini" };
    expect(settingsDirty(edited, payload)).toBe(true);
    expect(settingsDirty({ ...edited, chatModel: "gpt-4o" }, payload)).toBe(false);
    // Arming Remove is an edit, even though the box still shows nothing.
    expect(settingsDirty({ ...seeded, firecrawlApiKey: null }, payload)).toBe(true);
  });

  it("omits an untouched secret entirely, so a timeout-only save disturbs no key", () => {
    const payload = { ...emptyPayload(), hasFirecrawlApiKey: true };
    const body = settingsSaveBody({
      ...settingsDraftFromPayload(payload),
      llmTimeoutSeconds: "90",
    });
    expect(body.llmTimeoutSeconds).toBe(90);
    expect("customApiKey" in body).toBe(false);
    expect("embeddingApiKey" in body).toBe(false);
    expect("firecrawlApiKey" in body).toBe(false);
  });

  it("sends a typed key to replace and a null to remove", () => {
    const seeded = settingsDraftFromPayload(emptyPayload());
    expect(settingsSaveBody({ ...seeded, firecrawlApiKey: "fc-1" }).firecrawlApiKey).toBe(
      "fc-1",
    );
    expect(settingsSaveBody({ ...seeded, firecrawlApiKey: null }).firecrawlApiKey).toBeNull();
  });

  it("turns a blank non-secret field into null so clearing is expressible", () => {
    const body = settingsSaveBody({
      ...settingsDraftFromPayload({ ...emptyPayload(), chatModel: "gpt-4o" }),
      chatModel: "   ",
      llmTimeoutSeconds: "",
    });
    expect(body.chatModel).toBeNull();
    expect(body.llmTimeoutSeconds).toBeNull();
  });

  it("does not silently blank a nonsense timeout — it sends what the validator refuses", () => {
    const body = settingsSaveBody({
      ...settingsDraftFromPayload(emptyPayload()),
      llmTimeoutSeconds: "1.5",
    });
    expect(body.llmTimeoutSeconds).toBe(1.5);
    const refusal = validateWorkbenchSettingsPatch(
      body,
      workbenchSettingsStored({}, false),
    );
    expect(refusal).toEqual({ ok: false, error: SETTINGS_INVALID_TIMEOUT_COPY });
  });

  it("treats a whitespace-only secret as untouched, never as a delete", () => {
    // The merge trims before it stores, so a `"   "` that RODE would be trimmed
    // to empty and DELETE the stored credential — a key destroyed by a stray
    // keystroke, answered with a success message.
    const body = settingsSaveBody({
      ...settingsDraftFromPayload({ ...emptyPayload(), hasCustomApiKey: true }),
      customApiKey: "   ",
    });
    expect("customApiKey" in body).toBe(false);
  });

  it("sends a raw string rather than NaN for a timeout that is not a number", () => {
    // `Number("abc")` is `NaN`, which `JSON.stringify` writes as `null` — i.e.
    // as "clear the deadline". A typo must not silently delete a setting and
    // report success, so the raw text rides and the validator refuses it.
    for (const typed of ["abc", "1.5", "60s", "1e999"]) {
      const body = settingsSaveBody({
        ...settingsDraftFromPayload(emptyPayload()),
        llmTimeoutSeconds: typed,
      });
      expect(JSON.parse(JSON.stringify(body)).llmTimeoutSeconds).not.toBeNull();
      expect(validateWorkbenchSettingsPatch(body, storedState()).ok).toBe(false);
    }
  });

  it("counts a key already in the store toward the client-side vector gate", () => {
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
      hasEmbeddingApiKey: true,
    };
    const seeded = settingsDraftFromPayload(payload);
    // The box shows nothing, and the control is still allowed — the presence
    // boolean is exactly what makes that correct.
    expect(seeded.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    expect(draftCanEnableVectorSearch(seeded, payload)).toBe(true);
    // Arming Remove withdraws the permission in the same breath.
    expect(draftCanEnableVectorSearch({ ...seeded, embeddingApiKey: null }, payload)).toBe(
      false,
    );
    // …and a key typed in this session counts even with none stored.
    const fresh = { ...payload, hasEmbeddingApiKey: false };
    expect(
      draftCanEnableVectorSearch(
        { ...settingsDraftFromPayload(fresh), embeddingApiKey: "sk-1" },
        fresh,
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** The stored side of a merge, defaulted to a fresh deployment. */
function storedState(
  over: Partial<ReturnType<typeof workbenchSettingsStored>> = {},
): ReturnType<typeof workbenchSettingsStored> {
  return { ...workbenchSettingsStored({}, false), ...over };
}

describe("validateWorkbenchSettingsPatch", () => {
  const clean = () => storedState();

  it("accepts an empty patch and refuses a non-object", () => {
    expect(validateWorkbenchSettingsPatch({}, clean()).ok).toBe(true);
    expect(validateWorkbenchSettingsPatch(null, clean()).ok).toBe(false);
    expect(validateWorkbenchSettingsPatch([], clean()).ok).toBe(false);
    expect(validateWorkbenchSettingsPatch("x", clean()).ok).toBe(false);
  });

  it("refuses an unknown provider, a blank model, a relative URL and a bad timeout", () => {
    expect(validateWorkbenchSettingsPatch({ chatProvider: "acme" }, clean())).toEqual({
      ok: false,
      error: SETTINGS_INVALID_PROVIDER_COPY,
    });
    expect(validateWorkbenchSettingsPatch({ chatModel: "   " }, clean())).toEqual({
      ok: false,
      error: SETTINGS_INVALID_MODEL_COPY,
    });
    expect(
      validateWorkbenchSettingsPatch({ customBaseUrl: "not-a-url" }, clean()),
    ).toEqual({ ok: false, error: SETTINGS_INVALID_URL_COPY });
    // A `file:` URL parses — the protocol check is what refuses it.
    expect(
      validateWorkbenchSettingsPatch({ customBaseUrl: "file:///etc/passwd" }, clean()),
    ).toEqual({ ok: false, error: SETTINGS_INVALID_URL_COPY });
    // `""` is refused with the rest of the non-numbers rather than skipped:
    // `applyWorkbenchSettings` ignores every string it is handed, so accepting
    // it would answer 200 for a request that changed nothing. `null` is the one
    // way to clear the deadline, and it is what `settingsSaveBody` sends for an
    // emptied box.
    for (const seconds of [0, 4, 3601, 1.5, -1, "60", ""]) {
      expect(
        validateWorkbenchSettingsPatch({ llmTimeoutSeconds: seconds }, clean()).ok,
      ).toBe(false);
    }
    for (const seconds of [LLM_TIMEOUT_MIN_SECONDS, 60, LLM_TIMEOUT_MAX_SECONDS]) {
      expect(
        validateWorkbenchSettingsPatch({ llmTimeoutSeconds: seconds }, clean()).ok,
      ).toBe(true);
    }
  });

  it("accepts `custom` as a provider, because the picker offers it", () => {
    expect(validateWorkbenchSettingsPatch({ chatProvider: "custom" }, clean()).ok).toBe(
      true,
    );
    expect(PROVIDER_INFO.map((p) => p.value)).toContain("custom");
  });

  it("refuses a non-embedding provider for embeddings", () => {
    expect(
      validateWorkbenchSettingsPatch({ embeddingProvider: "anthropic" }, clean()).ok,
    ).toBe(false);
    expect(
      validateWorkbenchSettingsPatch({ embeddingProvider: "openai" }, clean()).ok,
    ).toBe(true);
  });

  it("refuses vector-on until all three arrive, over the MERGE", () => {
    const refusal = validateWorkbenchSettingsPatch(
      { vectorSearchEnabled: true },
      clean(),
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.error).toContain("Vector search needs");

    // All four legs in the SAME request is enough — the rule is about the merge,
    // not about what happened to be stored before it.
    expect(
      validateWorkbenchSettingsPatch(
        {
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          embeddingModel: "text-embedding-3-small",
          embeddingApiKey: "sk-1",
        },
        clean(),
      ).ok,
    ).toBe(true);

    // …and a key already in the store counts, with nothing sent for it.
    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: true },
        storedState({
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          embeddingModel: "m",
          hasEmbeddingApiKey: true,
        }),
      ).ok,
    ).toBe(true);

    // An ENV override the patch cannot move satisfies its leg too, and does so
    // identically on both sides of the wire — see the client/server agreement
    // test below.
    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: true },
        storedState({
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          envEmbeddingModel: "text-embedding-3-small",
          envEmbeddingApiKeyProviders: ["openai"],
        }),
      ).ok,
    ).toBe(true);
  });

  it("counts an env key only for the vendor it belongs to", () => {
    // `OPENAI_API_KEY` is not a Google credential. Letting it satisfy the key
    // leg for a Google selection turns the switch on for a provider whose
    // `embeddingApiKeyFor()` then resolves `null` at embed time.
    const googleWithOpenAiKey = storedState({
      embeddingProvider: "google",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "gemini-embedding-001",
      envEmbeddingApiKeyProviders: ["openai"],
    });
    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, googleWithOpenAiKey),
    ).toEqual({
      ok: false,
      error: "Vector search needs an API key before it can be turned on.",
    });

    // The same environment satisfies an OpenAI selection.
    //
    // The ENDPOINT rides in the same request, and it has to (DW-69/DW-72): this
    // patch SWITCHES the stored provider, so the stored `embeddingBaseUrl` was
    // typed for Google and the store is about to delete it. The gate judges the
    // config that will exist AFTER the write, so a patch that switched vendor
    // and named no endpoint would be refused over the endpoint leg rather than
    // passing on the strength of the previous vendor's URL.
    expect(
      validateWorkbenchSettingsPatch(
        {
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
        },
        googleWithOpenAiKey,
      ).ok,
    ).toBe(true);
  });

  it("refuses vector-on when the provider is only auto-detected", () => {
    const refusal = validateWorkbenchSettingsPatch(
      { vectorSearchEnabled: true },
      storedState({
        embeddingBaseUrl: "https://embed.example",
        embeddingModel: "m",
        hasEmbeddingApiKey: true,
      }),
    );
    expect(refusal).toEqual({
      ok: false,
      error: "Vector search needs an embedding provider before it can be turned on.",
    });
  });

  it("asks a self-transporting provider only for a model", () => {
    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: true, embeddingProvider: "ollama", embeddingModel: "nomic" },
        clean(),
      ).ok,
    ).toBe(true);
  });

  it("refuses a patch that removes a leg out from under an already-on switch", () => {
    // `vectorSearchEnabled` is absent here, so the STORED `true` is what the
    // merge carries — clearing the key must still be refused rather than leaving
    // the switch on over a credential that no longer exists.
    const refusal = validateWorkbenchSettingsPatch(
      { embeddingApiKey: null },
      storedState({
        vectorSearchEnabled: true,
        embeddingProvider: "openai",
        embeddingBaseUrl: "https://embed.example",
        embeddingModel: "m",
        hasEmbeddingApiKey: true,
      }),
    );
    expect(refusal.ok).toBe(false);
  });

  it("always allows turning it OFF", () => {
    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: false },
        storedState({ vectorSearchEnabled: true }),
      ).ok,
    ).toBe(true);
  });

  describe("the gate runs only for a patch that MOVES it (DW-219)", () => {
    /** A deployment already storing a mismatch, with the switch on. */
    const mismatch = () =>
      storedState({
        vectorSearchEnabled: true,
        embeddingProvider: "workers-ai",
        embeddingModel: "text-embedding-3-small",
        hasWorkersAiBinding: true,
      });

    it("accepts an edit that touches nothing the rule reads", () => {
      // `settingsSaveBody` sends `vectorSearchEnabled`, `embeddingProvider`,
      // `embeddingModel` and `embeddingBaseUrl` on EVERY save, so a PRESENCE
      // test would fix nothing — the body below is the real one a timeout edit
      // produces, with every vector field riding at its stored value.
      const body = {
        chatModel: "gpt-4o",
        llmTimeoutSeconds: 90,
        vectorSearchEnabled: true,
        embeddingProvider: "workers-ai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: null,
      };
      expect(validateWorkbenchSettingsPatch(body, mismatch()).ok).toBe(true);
    });

    it("still refuses an edit that moves one of the inputs", () => {
      // Moving the PROVIDER re-opens the whole question, and the answer is a
      // fresh one: `text-embedding-3-small` is fine for OpenAI, so what is now
      // missing is the endpoint and the key this provider needs.
      //
      // `mismatch()` stores the flag ON, so both refusals below carry the
      // SWITCHED-ON frame (DW-308): neither request is asking to turn the switch
      // on, so "before it can be turned on" would land beside a ticked box.
      expect(
        validateWorkbenchSettingsPatch(
          { vectorSearchEnabled: true, embeddingProvider: "openai" },
          mismatch(),
        ),
      ).toEqual({
        ok: false,
        error:
          "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.",
      });
      // And moving the MODEL to another unsupported id keeps the model leg.
      expect(
        validateWorkbenchSettingsPatch(
          { embeddingModel: "@cf/llava-hf/llava-1.5-7b-hf" },
          mismatch(),
        ),
      ).toEqual({ ok: false, error: UNSUPPORTED_WORKERS_MODEL_INACTIVE });
    });

    it("still refuses TURNING IT ON even when no input moved", () => {
      // The flag itself is not one of the inputs `vectorInputsEqual` compares,
      // so "turning on" has to be its own term — without it a stored-off
      // deployment could switch on over an unchanged mismatch.
      expect(
        validateWorkbenchSettingsPatch(
          { vectorSearchEnabled: true },
          { ...mismatch(), vectorSearchEnabled: false },
        ).ok,
      ).toBe(false);
    });

    it("still allows turning it OFF over the same mismatch", () => {
      expect(
        validateWorkbenchSettingsPatch({ vectorSearchEnabled: false }, mismatch()).ok,
      ).toBe(true);
    });

    it("re-checks when a leg goes missing under an already-on switch", () => {
      // The pre-existing guarantee this scope must not break: the patch moves
      // `hasKey`, so the rule runs even though the flag is untouched.
      expect(
        validateWorkbenchSettingsPatch(
          { embeddingApiKey: null },
          storedState({
            vectorSearchEnabled: true,
            embeddingProvider: "openai",
            embeddingBaseUrl: "https://embed.example",
            embeddingModel: "m",
            hasEmbeddingApiKey: true,
          }),
        ).ok,
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// Scoping the vector refusal to legs the requesting surface can move (DW-303)
// ---------------------------------------------------------------------------

describe("flatMovableVectorLegs", () => {
  const legs = (body: Record<string, unknown>): VectorSearchLegField[] =>
    [...flatMovableVectorLegs(body)].sort();

  it("claims nothing for a body carrying neither embedding key", () => {
    // The chat-model edit that DW-219 already lets through the gate: it can move
    // no vector leg at all, so no vector sentence could be about it.
    expect(legs({})).toEqual([]);
    expect(legs({ model: "gpt-4o", ollamaBaseUrl: "http://h:11434" })).toEqual([]);
  });

  it("claims the MODEL leg for embeddingModel", () => {
    expect(legs({ embeddingModel: "text-embedding-3-large" })).toEqual(["model"]);
  });

  it("claims the PROVIDER and BINDING legs for embeddingProvider", () => {
    // Derived from `VECTOR_LEG_CONTROL`, not hand-listed. The binding leg has no
    // control of its own and maps to the provider select — the only thing that
    // can move it — so a body that can move the provider can move it too
    // (DW-277).
    expect(legs({ embeddingProvider: "openai" })).toEqual(["binding", "provider"]);
  });

  it("reads PRESENCE, not value", () => {
    // A key the body carries is a move whatever it moves the field TO: `null` is
    // a clear, which moves the leg exactly as a new id does. An explicit
    // `undefined` is the absent case — it is what the route's own merge branches
    // skip on, so it must claim nothing here either.
    expect(legs({ embeddingModel: null, embeddingProvider: null })).toEqual([
      "binding",
      "model",
      "provider",
    ]);
    expect(legs({ embeddingModel: "" })).toEqual(["model"]);
    expect(legs({ embeddingModel: undefined, embeddingProvider: undefined })).toEqual([]);
  });
});

describe("validateWorkbenchSettingsPatch — actionableLegs (DW-303)", () => {
  /**
   * An `openai` configuration switched ON and ALREADY unsatisfiable on the two
   * legs the flat `/settings` page renders no control for.
   */
  const brokenOpenai = () =>
    storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    });

  const MISSING_TRANSPORT =
    "Vector search needs an endpoint and an API key before it can be turned on.";

  /**
   * The same two legs in the SWITCHED-ON frame (DW-308). Scoping decides WHETHER
   * the gate refuses; the baseline flag decides WHICH sentence it carries, and
   * every case in this describe but "never scopes a patch that is TURNING IT ON"
   * runs against a store that already held the flag `true`.
   */
  const INACTIVE_TRANSPORT =
    "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.";

  /**
   * The same two legs again, in the FLAT frame (DW-329).
   *
   * A SCOPED call is by definition one from the flat `/settings` page, and that
   * page renders no vector switch — so "Turn it off" would name a control the
   * owner cannot find. Which sentence, never whether: the legs, their order and
   * their notes are identical to {@link INACTIVE_TRANSPORT} above, and only the
   * trailing action clause moves.
   */
  const INACTIVE_TRANSPORT_FLAT =
    "Vector search is switched on, but it needs an endpoint and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.";

  it("an OMITTED fourth argument refuses exactly as before, and an EMPTY set is its opposite", () => {
    // The default is what keeps every caller but the flat-only route path
    // unchanged, so the two have to be pinned against each other: omitted means
    // "this surface reaches every control", an empty set means "it reaches
    // none". Same three other arguments, opposite answers.
    const baseline = brokenOpenai();
    const merged = storedState({
      ...baseline,
      embeddingModel: "text-embedding-3-large",
    });

    expect(validateWorkbenchSettingsPatch({}, merged, baseline)).toEqual({
      ok: false,
      error: INACTIVE_TRANSPORT,
    });
    expect(
      validateWorkbenchSettingsPatch({}, merged, baseline, new Set()).ok,
    ).toBe(true);
  });

  it("REFUSES an unmet leg that is actionable even though the baseline was already broken", () => {
    // PIN FOR THE `actionableLegs` HALF ALONE. The baseline cannot be enabled —
    // no model, no endpoint, no key — so the "did this request break it" half
    // answers NO, and only "does the sentence name something this body could
    // move" can produce this refusal. Delete that half and this case passes with
    // a 200.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
    });
    expect(
      canEnableVectorSearch({
        provider: "openai",
        baseUrl: null,
        model: null,
        hasKey: false,
        modelOrigin: "stored",
        providerOrigin: "stored",
        hasWorkersAiBinding: false,
      }),
    ).toBe(false);
    const merged = storedState({ ...baseline, embeddingModel: "@cf/baai/bge-m3" });

    expect(
      validateWorkbenchSettingsPatch(
        {},
        merged,
        baseline,
        flatMovableVectorLegs({ embeddingModel: "@cf/baai/bge-m3" }),
      ),
    ).toEqual({
      ok: false,
      // Scoped, so the FLAT frame (DW-329).
      error:
        "Vector search is switched on, but it needs an endpoint, a model id outside the Cloudflare Workers AI @cf/ namespace and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    });
  });

  it("ALLOWS choosing a provider the baseline did not have", () => {
    // PIN FOR THE SHAPE A SET-DIFF PREDICATE GETS WRONG.
    // `vectorSearchMissingLegs` early-returns the provider leg ALONE, so this
    // baseline reports `[provider]` while the merge reports the `[endpoint,
    // key]` that leg was hiding. A per-leg "was it unmet before" test reads both
    // as newly unmet and answers the unactionable sentence, on a request that
    // made an already-broken configuration no more broken.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingModel: "text-embedding-3-small",
    });
    const merged = storedState({ ...baseline, embeddingProvider: "openai" });

    expect(
      validateWorkbenchSettingsPatch(
        {},
        merged,
        baseline,
        flatMovableVectorLegs({ embeddingProvider: "openai" }),
      ).ok,
    ).toBe(true);
  });

  it("REFUSES on the BINDING leg alone, because embeddingProvider CLAIMS it", () => {
    // PIN FOR THE `binding` HALF OF THE CLAIM. Everywhere else the binding leg
    // rides along with legs that are claimed anyway, so set equality is the only
    // thing that notices it — drop `binding` from `flatMovableVectorLegs` and
    // nothing but that one assertion fails.
    //
    // Here it is the ONLY unmet leg: `workers-ai` is self-transporting so there
    // is no endpoint or key leg, the model is a catalog id, and the baseline is
    // unsatisfiable purely because no Cloudflare `AI` binding is bound. That
    // makes `canEnableVectorSearch(current)` false, so the "did this request
    // break it" half cannot produce the refusal either — the binding claim is
    // the whole reason this answers 400.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
      hasWorkersAiBinding: false,
    });
    expect(
      canEnableVectorSearch({
        provider: "workers-ai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
        modelOrigin: "stored",
        providerOrigin: "stored",
        hasWorkersAiBinding: false,
      }),
    ).toBe(false);
    // The merge moves the model to ANOTHER valid catalog id, so the model leg is
    // met on both sides and cannot be what the sentence is about.
    const merged = storedState({
      ...baseline,
      embeddingModel: "@cf/baai/bge-large-en-v1.5",
    });
    const claimed = flatMovableVectorLegs({
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-large-en-v1.5",
    });

    expect(validateWorkbenchSettingsPatch({}, merged, baseline, claimed)).toEqual({
      ok: false,
      // Scoped, so the FLAT frame (DW-329) — and the leg's NOTE is unmoved,
      // which is the half of the sentence that must not vary by surface.
      error: `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    });

    // …and the same call with `binding` removed from the claimed set ALLOWS it.
    // That is the discriminator: the provider and model legs are both met, so
    // `binding` is the only member of the set the refusal can be reached
    // through.
    const withoutBinding = new Set([...claimed].filter((leg) => leg !== "binding"));
    expect(
      validateWorkbenchSettingsPatch({}, merged, baseline, withoutBinding).ok,
    ).toBe(true);
  });

  it("REFUSES on unactionable legs when the request BROKE a working configuration (DW-217)", () => {
    // PIN FOR THE `canEnableVectorSearch(current)` HALF ALONE. `ollama` is
    // self-transporting, so the baseline IS satisfiable; switching to `openai`
    // leaves the endpoint and key legs unmet, and neither is in
    // `actionableLegs`. Delete that half and this silently switches effective
    // vector search off.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    expect(
      canEnableVectorSearch({
        provider: "ollama",
        baseUrl: null,
        model: "nomic-embed-text",
        hasKey: false,
        modelOrigin: "stored",
        providerOrigin: "stored",
        hasWorkersAiBinding: false,
      }),
    ).toBe(true);
    const merged = storedState({ ...baseline, embeddingProvider: "openai" });

    expect(
      validateWorkbenchSettingsPatch(
        {},
        merged,
        baseline,
        flatMovableVectorLegs({ embeddingProvider: "openai" }),
      ),
    ).toEqual({ ok: false, error: INACTIVE_TRANSPORT_FLAT });
  });

  it("never scopes a patch that is TURNING IT ON", () => {
    // Asking for vector search makes every leg the request's business, whatever
    // the requesting surface can reach.
    const baseline = storedState({
      vectorSearchEnabled: false,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
    });

    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: true },
        storedState({ ...baseline, vectorSearchEnabled: true }),
        baseline,
        new Set(),
      ),
    ).toEqual({ ok: false, error: MISSING_TRANSPORT });
  });

  it("leaves a scoped patch that satisfies every leg alone", () => {
    // Scoping only ever suppresses a refusal; it never invents one.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    const merged = storedState({ ...baseline, embeddingModel: "mxbai-embed-large" });

    expect(
      validateWorkbenchSettingsPatch(
        {},
        merged,
        baseline,
        flatMovableVectorLegs({ embeddingModel: "mxbai-embed-large" }),
      ).ok,
    ).toBe(true);
  });
});

describe("validateWorkbenchSettingsPatch — the baseline argument (DW-306)", () => {
  it("measures the move against `baseline`, where a two-argument call compares it to itself", () => {
    // The one case the third argument exists for, at the parameter itself rather
    // than only through the route body that reaches it. `stored` is the
    // post-legacy-merge object, so a flat `embeddingModel` set earlier in the
    // same request is ALREADY baked into it — handed that for both sides, the
    // move compares equal to itself, `vectorInputsEqual` answers true and the
    // gate is skipped.
    const satisfied = {
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      hasEmbeddingApiKey: true,
    };
    const baseline = storedState({
      ...satisfied,
      embeddingModel: "text-embedding-3-small",
    });
    // The flat move has already landed on the merge target.
    const stored = storedState({ ...satisfied, embeddingModel: "@cf/baai/bge-m3" });

    // Two arguments: the move is invisible, so an empty patch changes nothing.
    expect(validateWorkbenchSettingsPatch({}, stored).ok).toBe(true);
    // Three: the move is measured from what the store held BEFORE the request.
    // The baseline held the flag ON, so the refusal carries the switched-on
    // frame (DW-308) — this request is not asking to turn anything on.
    expect(validateWorkbenchSettingsPatch({}, stored, baseline)).toEqual({
      ok: false,
      error:
        "Vector search is switched on, but it needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can run. Turn it off, or supply what is missing.",
    });
  });
});

// ---------------------------------------------------------------------------
// WHICH sentence a refusal carries, and what still decides WHETHER (DW-308)
// ---------------------------------------------------------------------------
//
// DW-279 closed the ticked-box mismatch on the CLIENT: the hint beside a
// checked switch says "Vector search is switched on, but…" rather than "…before
// it can be turned on", because the second describes a state the surface is
// visibly not in. The route answered `vectorSearchMissingCopy` for every
// refusal, so a save that broke an already-ON switch landed that same retired
// sentence in the save bar — beside the same still-ticked box.
//
// The frame is picked from `baseline.vectorSearchEnabled`: the flag as the store
// held it BEFORE the request, which is the server's analogue of the box the
// client reads. Both frames stay reachable, and neither moves any refusal
// boundary — `canEnableVectorSearch` is still the one rule.

describe("the refusal's FRAME follows the stored flag (DW-308)", () => {
  /** `openai` with a model and nothing else: the endpoint and key legs unmet. */
  const openaiLegs = {
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
  } as const;

  it("keeps 'before it can be turned on' for a request that TURNS THE SWITCH ON", () => {
    // The frame that would be retired outright if the choice were made from the
    // post-merge `enabled`: the gate runs only inside `if (enabled)`, so that
    // flag is always `true` there. This request is asking for vector search, and
    // "before it can be turned on" is exactly what it is being told.
    const baseline = storedState({ vectorSearchEnabled: false, ...openaiLegs });

    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, baseline),
    ).toEqual({
      ok: false,
      error: "Vector search needs an endpoint and an API key before it can be turned on.",
    });
  });

  it("answers the SWITCHED-ON frame when the store already held the flag on", () => {
    // Same legs, same order, same absence of notes — only the frame differs, and
    // the action the owner actually has here (turning it off) is the one named.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    const merged = storedState({ ...baseline, embeddingProvider: "openai" });

    expect(validateWorkbenchSettingsPatch({}, merged, baseline)).toEqual({
      ok: false,
      error:
        "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.",
    });
  });

  it("carries every leg NOTE through the switched-on frame unchanged", () => {
    // The notes are what tell an owner where a leg they cannot see is coming
    // from, so a frame that dropped them would be a worse refusal than the one
    // it replaced. `workers-ai` off the Workers runtime is the leg with a note.
    const baseline = storedState({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
      hasWorkersAiBinding: false,
    });
    const merged = storedState({ ...baseline, embeddingModel: "@cf/baai/bge-large-en-v1.5" });

    expect(validateWorkbenchSettingsPatch({}, merged, baseline)).toEqual({
      ok: false,
      error: `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    });
  });

  it("is the copy functions' own output, never a second spelling of them", () => {
    // The frames are chosen, not re-written: whichever one a refusal lands on,
    // the string is byte-identical to the exported function's over the same
    // merged inputs. A future edit to either sentence therefore cannot leave the
    // route saying something the surface does not.
    const inputs = {
      provider: "openai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: false,
      modelOrigin: "stored",
      providerOrigin: "stored",
      hasWorkersAiBinding: false,
    } as const;
    const off = storedState({ vectorSearchEnabled: false, ...openaiLegs });
    const on = storedState({ vectorSearchEnabled: true, ...openaiLegs });

    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, off),
    ).toEqual({ ok: false, error: vectorSearchMissingCopy(inputs) });
    expect(
      validateWorkbenchSettingsPatch(
        {},
        storedState({ ...on, embeddingModel: "text-embedding-3-large" }),
        on,
      ),
    ).toEqual({
      ok: false,
      error: vectorSearchInactiveCopy({ ...inputs, model: "text-embedding-3-large" }),
    });
  });

  it("moves no refusal boundary: the same situations are refused either way", () => {
    // The Block If. The frame is about WHICH sentence, never WHETHER — so for
    // each situation below, flipping only the stored flag changes the string and
    // never the `ok`.
    const satisfiable = {
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    } as const;

    // Satisfied: accepted with the flag off AND with the flag on.
    for (const flag of [false, true]) {
      const baseline = storedState({ vectorSearchEnabled: flag, ...satisfiable });
      expect(
        validateWorkbenchSettingsPatch(
          { vectorSearchEnabled: true, embeddingModel: "mxbai-embed-large" },
          baseline,
        ).ok,
      ).toBe(true);
    }
    // Unsatisfiable: refused with the flag off AND with the flag on, and the two
    // sentences differ.
    const answers = [false, true].map(
      (flag) =>
        validateWorkbenchSettingsPatch(
          { vectorSearchEnabled: true, embeddingProvider: "openai" },
          storedState({ vectorSearchEnabled: flag, ...satisfiable }),
        ) as { ok: false; error: string },
    );
    expect(answers.map((answer) => answer.ok)).toEqual([false, false]);
    expect(answers[0].error).not.toBe(answers[1].error);
    expect(answers[0].error).toContain("before it can be turned on");
    expect(answers[1].error).toContain("Vector search is switched on, but it needs");
  });
});

describe("the client and the route read the same vector rule", () => {
  /**
   * The whole point of the env fields on the payload. For each situation, the
   * browser's `draftVectorInputs` and the route's own merge must answer the
   * same — otherwise the checkbox is disabled for a configuration the route
   * would accept, or (worse) enabled for one it refuses.
   */
  const situations: Array<{
    name: string;
    env: { provider?: string; model?: string; key?: string };
    config: AppConfig;
    /** The RUNTIME fact both halves must be handed. Default: off Workers. */
    binding?: boolean;
  }> = [
    { name: "nothing configured", env: {}, config: {} },
    {
      name: "everything stored",
      env: {},
      config: {
        embeddingProvider: "openai",
        embeddingBaseUrl: "https://embed.example",
        embeddingModel: "text-embedding-3-small",
        embeddingApiKey: "sk-1",
      },
    },
    {
      name: "the model comes from the environment",
      env: { model: "text-embedding-3-small" },
      config: {
        embeddingProvider: "openai",
        embeddingBaseUrl: "https://embed.example",
        embeddingApiKey: "sk-1",
      },
    },
    {
      name: "the provider and key come from the environment",
      env: { provider: "openai", key: "sk-env" },
      config: {
        embeddingBaseUrl: "https://embed.example",
        embeddingModel: "text-embedding-3-small",
      },
    },
    {
      name: "a self-transporting provider with only a model",
      env: {},
      config: { embeddingProvider: "ollama", embeddingModel: "nomic-embed-text" },
    },
    // The three situations the two new inputs introduce. Each must be answered
    // identically by both halves, or the browser disables a control the route
    // would accept — or enables one it refuses.
    {
      name: "Workers AI WITH the Cloudflare AI binding",
      env: {},
      config: { embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" },
      binding: true,
    },
    {
      name: "Workers AI WITHOUT the Cloudflare AI binding",
      env: {},
      config: { embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" },
      binding: false,
    },
    {
      name: "the model the environment forces cannot be served by the provider",
      env: { model: "text-embedding-3-small" },
      config: { embeddingProvider: "workers-ai" },
      binding: true,
    },
    // The two `providerOrigin` situations (DW-281). The ORIGIN itself changes
    // only which note a refusal carries, never whether there is one — so these
    // pin the property that matters: adding a third input to
    // `VECTOR_INPUT_KEYS` did not make the two halves read it differently.
    {
      name: "the environment forces workers-ai with no binding",
      env: { provider: "workers-ai" },
      config: { embeddingModel: "@cf/baai/bge-m3" },
      binding: false,
    },
    {
      name: "the environment forces workers-ai and the binding exists",
      env: { provider: "workers-ai" },
      config: { embeddingModel: "@cf/baai/bge-m3" },
      binding: true,
    },
  ];

  for (const situation of situations) {
    it(`agrees when ${situation.name}`, async () => {
      if (situation.env.provider) process.env.EMBEDDING_PROVIDER = situation.env.provider;
      if (situation.env.model) process.env.EMBEDDING_MODEL = situation.env.model;
      if (situation.env.key) process.env.OPENAI_API_KEY = situation.env.key;
      await store(situation.config);
      // ONE read of the runtime fact, handed to BOTH halves — exactly what the
      // route does per request. Two reads is the shape that lets them drift.
      const binding = situation.binding ?? false;

      const payload = getWorkbenchSettings(binding);
      const draft = settingsDraftFromPayload(payload);
      // Every INPUT the rule reads, not just the boolean it produces: the
      // origins decide which sentence a refusal carries, so two halves that
      // agreed on `false` while disagreeing about WHY would still send the two
      // surfaces apart. `VECTOR_INPUT_KEYS` is exhaustive by construction, so
      // this comparison grows with the interface.
      const inputs = draftVectorInputs(draft, payload);
      expect({
        situation: situation.name,
        providerOrigin: inputs.providerOrigin,
      }).toEqual({
        situation: situation.name,
        providerOrigin: situation.env.provider ? "env" : "stored",
      });
      // The BROWSER's answer, from the payload alone…
      const client = draftCanEnableVectorSearch(draft, payload);
      // …and the ROUTE's, for the very patch that draft would send.
      const route = validateWorkbenchSettingsPatch(
        { ...settingsSaveBody(draft), vectorSearchEnabled: true },
        workbenchSettingsStored(situation.config, binding),
      ).ok;
      expect({ situation: situation.name, client }).toEqual({
        situation: situation.name,
        client: route,
      });
    });
  }

  it("keeps the editable model field STORED while the gate sees the env override", async () => {
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingApiKey: "sk-1",
    });
    const payload = getWorkbenchSettings(false);
    // The box stays empty — showing an env value in an editable field would
    // persist it on the next save…
    expect(payload.embeddingModel).toBeNull();
    // …while the gate is satisfied, because the override is served beside it.
    expect(payload.envEmbeddingModel).toBe("text-embedding-3-small");
    expect(draftCanEnableVectorSearch(settingsDraftFromPayload(payload), payload)).toBe(
      true,
    );
  });

  it("serves LLM_CUSTOM_BASE_URL apart from the editable endpoint (DW-71)", async () => {
    // The third variable that wins over a box on this surface. `getCustomBaseUrl()`
    // takes it ahead of the store, so the payload has to carry both halves: the
    // box keeps showing what a save moves, and the sentence says what is
    // actually in effect.
    process.env.LLM_CUSTOM_BASE_URL = "https://env.example/v1";
    await store({ customBaseUrl: "https://saved.example/v1" });

    const payload = getWorkbenchSettings(false);
    expect(payload.customBaseUrl).toBe("https://saved.example/v1");
    expect(payload.envCustomBaseUrl).toBe("https://env.example/v1");
    // …which is exactly what the runtime resolves.
    expect(getCustomBaseUrl()).toBe("https://env.example/v1");
  });

  it("reads a BLANK LLM_CUSTOM_BASE_URL as unset, so nothing is announced", async () => {
    // Same `nonEmpty` the resolver uses: a set-but-empty variable does not
    // override anything, and announcing one would be a sentence about a fact
    // that is not true.
    for (const blank of ["", "   "]) {
      process.env.LLM_CUSTOM_BASE_URL = blank;
      await store({ customBaseUrl: "https://saved.example/v1" });
      const payload = getWorkbenchSettings(false);
      expect(payload.envCustomBaseUrl).toBeNull();
      // …and the stored value still applies.
      expect(getCustomBaseUrl()).toBe("https://saved.example/v1");
    }
  });

  it("names LLM_CUSTOM_BASE_URL in the ONE override sentence", () => {
    // One wording for one fact across all three variables — a second would be
    // two sentences to keep in step.
    const copy = settingsEnvOverrideCopy("customBaseUrl", "https://env.example/v1");
    expect(copy).toContain("LLM_CUSTOM_BASE_URL=https://env.example/v1");
    expect(copy).toContain("wins at runtime");
    expect(settingsEnvOverrideCopy("model", "m")).toContain("EMBEDDING_MODEL=m");
    expect(settingsEnvOverrideCopy("provider", "p")).toContain("EMBEDDING_PROVIDER=p");
  });

  it("refuses a payload with no `envCustomBaseUrl` at all", () => {
    // The canvas seeds its draft during render and reads this field to decide
    // whether to describe the row. `undefined` means the body is not a payload.
    expect(isWorkbenchSettingsPayload(emptyPayload())).toBe(true);
    const { envCustomBaseUrl: _omitted, ...without } = emptyPayload();
    expect(isWorkbenchSettingsPayload(without)).toBe(false);
    expect(
      isWorkbenchSettingsPayload({ ...emptyPayload(), envCustomBaseUrl: 42 }),
    ).toBe(false);
    expect(
      isWorkbenchSettingsPayload({
        ...emptyPayload(),
        envCustomBaseUrl: "https://env.example/v1",
      }),
    ).toBe(true);
  });

  it("applies the namespace leg to a mismatch that arrives from EMBEDDING_MODEL", async () => {
    // All three feeders take the env override AHEAD of anything stored or typed
    // (`mergedVectorInputs`, `draftVectorInputs`, `config.ts`'s
    // `getVectorSearchSettings`), so the env value is a first-class input to the
    // namespace leg — the mismatch can arrive without the owner ever touching
    // the model box, which is exactly the stale-override case
    // `resolveEmbeddingModelName` was written for.
    // ON Workers, so the ONLY unmet leg is the model — this case is about
    // WHERE the model came from, and a missing binding would add a second leg
    // and a second note to every sentence below.
    onWorkers();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({ embeddingProvider: "workers-ai", vectorSearchEnabled: true });

    const payload = getWorkbenchSettings(true);
    expect(payload.envEmbeddingModel).toBe("text-embedding-3-small");

    // The browser refuses, and says why — INCLUDING which variable owns the
    // value, without which the sentence points at a box the gate never reads
    // (DW-218).
    const draft = settingsDraftFromPayload(payload);
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(false);
    expect(vectorSearchMissingCopy(draftVectorInputs(draft, payload))).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
    expect(SETTINGS_VECTOR_ENV_MODEL_NOTE).toContain("EMBEDDING_MODEL");
    // …the already-stored `true` reads as off…
    expect(getVectorSearchSettings().enabled).toBe(false);
    // …and the route refuses the save with the same sentence. The flag is put
    // back to OFF first so this is a genuine TURN-ON: since DW-219 the gate is
    // scoped to patches that move it, and a store that already holds `true` is
    // not moved by a patch repeating `true` (that skip is pinned in its own
    // cases under `PUT /api/settings`).
    await store({ embeddingProvider: "workers-ai" });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: { vectorSearchEnabled: true, embeddingProvider: "workers-ai" },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
  });

  it("does NOT name EMBEDDING_MODEL when the STORE owns the mismatch (DW-218)", async () => {
    // The other half of the same rule. Naming a variable that is not set would
    // send the owner to a shell they have nothing to change — the box IS what is
    // wrong here, and the model row says so with `aria-invalid` instead.
    onWorkers();
    await store({
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });

    const payload = getWorkbenchSettings(true);
    expect(payload.envEmbeddingModel).toBeNull();
    const draft = settingsDraftFromPayload(payload);
    const inputs = draftVectorInputs(draft, payload);
    expect(inputs.modelOrigin).toBe("stored");
    expect(vectorSearchMissingCopy(inputs)).toBe(UNSUPPORTED_WORKERS_MODEL);
    expect(vectorSearchFieldIssue(inputs, "model")).toEqual({
      copy: UNSUPPORTED_WORKERS_MODEL,
      invalid: true,
    });
  });

  it("refuses Workers AI off the Workers runtime, naming the binding (DW-225)", async () => {
    // `SELF_TRANSPORTING_EMBEDDING_PROVIDERS` exempts `workers-ai` from the
    // endpoint and the key precisely BECAUSE the Cloudflare `AI` binding
    // supplies both — so on Docker, where no such binding exists, the old gate
    // turned the switch on for a deployment whose `resolveEmbeddingProvider`
    // returns `null` forever. Nothing about the stored config is wrong here: the
    // id is supported and the provider is explicit.
    await store({
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });

    const payload = getWorkbenchSettings(false);
    expect(payload.hasWorkersAiBinding).toBe(false);
    const draft = settingsDraftFromPayload(payload);
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(false);
    const sentence = vectorSearchMissingCopy(draftVectorInputs(draft, payload));
    expect(sentence).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // The model row has nothing to complain about — the id is fine.
    expect(vectorSearchFieldIssue(draftVectorInputs(draft, payload), "model")).toBeNull();

    // And the route, which reads the binding for itself, answers the same.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { vectorSearchEnabled: true } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(sentence);
  });

  it("allows the same deployment once the binding is bound (DW-225)", async () => {
    onWorkers();
    await store({
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });

    const payload = getWorkbenchSettings(true);
    expect(payload.hasWorkersAiBinding).toBe(true);
    expect(
      draftCanEnableVectorSearch(settingsDraftFromPayload(payload), payload),
    ).toBe(true);

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { vectorSearchEnabled: true } }));
    expect(response.status).toBe(200);
    // The landed save RE-SEEDS the draft from this body, so the fact has to be
    // on it too — a PUT response that dropped it would hand the surface a
    // payload its own type guard rejects, and the canvas would report a save
    // that landed as a failure.
    const body = (await response.json()) as { workbench: WorkbenchSettingsPayload };
    expect(body.workbench.hasWorkersAiBinding).toBe(true);
    expect(isWorkbenchSettingsPayload(body.workbench)).toBe(true);
  });

  it("does not apply the binding leg where the fact is not knowable", async () => {
    // `getVectorSearchSettings()` runs inside `config.ts` and passes `null`, so
    // it answers exactly as it did before this change even though this process
    // is nowhere near a Workers runtime. The embed path refuses independently.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });
    expect(getVectorSearchSettings().enabled).toBe(true);
    // And the two gate-only inputs do not leak onto the settings object.
    expect(Object.keys(getVectorSearchSettings()).sort()).toEqual([
      "baseUrl",
      "enabled",
      "hasKey",
      "model",
      "provider",
    ]);
  });

  it("does not let a TYPED matching id lift a refusal the env override owns", async () => {
    // Today's intended answer, pinned rather than smoothed over: the override
    // WINS over the box in every feeder, so typing a `@cf/` id fixes nothing
    // until `EMBEDDING_MODEL` is unset. Pinning it is what keeps a later
    // "helpful" change to the precedence from passing unnoticed.
    onWorkers();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({ embeddingProvider: "workers-ai" });

    const payload = getWorkbenchSettings(true);
    const typed = {
      ...settingsDraftFromPayload(payload),
      embeddingModel: "@cf/baai/bge-m3",
    };
    // The typed value is not what the gate reads — the override is.
    expect(draftVectorInputs(typed, payload).model).toBe("text-embedding-3-small");
    expect(draftCanEnableVectorSearch(typed, payload)).toBe(false);

    // The route answers identically for the very patch that draft would send.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: { ...settingsSaveBody(typed), vectorSearchEnabled: true },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
  });
});

describe("the editing payload serves the STORED vector flag", () => {
  it("does not let an unrelated save switch vector search off", async () => {
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-1",
    });
    // Now a leg goes missing behind the owner's back (a rotated env key, a
    // hand-edited config). The EFFECTIVE answer is off…
    await store({ vectorSearchEnabled: true, embeddingProvider: "openai" });
    expect(getVectorSearchSettings().enabled).toBe(false);
    // …but the surface must still show the owner's own stored decision, because
    // `settingsSaveBody` always sends this field back: serving the intersected
    // value would make the next timeout edit silently rewrite `true` to `false`.
    const payload = getWorkbenchSettings(false);
    expect(payload.vectorSearchEnabled).toBe(true);
    expect(settingsSaveBody(settingsDraftFromPayload(payload)).vectorSearchEnabled).toBe(
      true,
    );
  });

  it("keeps a stored `true` through a timeout-only save", async () => {
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-1",
    });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const payload = (
      (await (await GET()).json()) as { workbench: WorkbenchSettingsPayload }
    ).workbench;
    const draft = { ...settingsDraftFromPayload(payload), llmTimeoutSeconds: "90" };
    const response = await PUT(await put({ workbench: settingsSaveBody(draft) }));
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({
      vectorSearchEnabled: true,
      llmTimeoutSeconds: 90,
      embeddingApiKey: "sk-1",
    });
  });
});

// ---------------------------------------------------------------------------
// applyWorkbenchSettings — the merge
// ---------------------------------------------------------------------------

describe("applyWorkbenchSettings", () => {
  it("leaves an ABSENT field alone and deletes on null or empty", () => {
    const existing: AppConfig = {
      provider: "openai",
      model: "gpt-4o",
      firecrawlApiKey: "fc-1",
      chatModel: "gpt-4o-mini",
    };
    expect(applyWorkbenchSettings(existing, {})).toEqual(existing);
    expect(applyWorkbenchSettings(existing, { firecrawlApiKey: null })).toEqual({
      provider: "openai",
      model: "gpt-4o",
      chatModel: "gpt-4o-mini",
    });
    expect(applyWorkbenchSettings(existing, { firecrawlApiKey: "" })).toEqual({
      provider: "openai",
      model: "gpt-4o",
      chatModel: "gpt-4o-mini",
    });
  });

  it("does not mutate the config it was handed", () => {
    const existing: AppConfig = { chatModel: "gpt-4o" };
    applyWorkbenchSettings(existing, { chatModel: null, vectorSearchEnabled: true });
    expect(existing).toEqual({ chatModel: "gpt-4o" });
  });

  it("trims stored text so a pasted endpoint does not carry its whitespace", () => {
    expect(
      applyWorkbenchSettings({}, { customBaseUrl: "  https://api.example/v1  " }),
    ).toEqual({ customBaseUrl: "https://api.example/v1" });
  });
});

// ---------------------------------------------------------------------------
// The one settings client — driven with a stubbed fetch, never a socket
// ---------------------------------------------------------------------------

function stubFetch(
  handler: (url: string, init?: Parameters<SettingsFetch>[1]) => {
    ok: boolean;
    status: number;
    body: unknown;
  },
): { impl: SettingsFetch; calls: Array<{ url: string; init?: Parameters<SettingsFetch>[1] }> } {
  const calls: Array<{ url: string; init?: Parameters<SettingsFetch>[1] }> = [];
  const impl: SettingsFetch = async (url, init) => {
    calls.push({ url, init });
    const answer = handler(url, init);
    return {
      ok: answer.ok,
      status: answer.status,
      json: async () => answer.body,
    };
  };
  return { impl, calls };
}

describe("the settings client", () => {
  it("reads the workbench object out of the full GET body", async () => {
    const payload = emptyPayload();
    const { impl, calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      // Deliberately the WHOLE body — the legacy fields ride beside it.
      body: { provider: "openai", readOnly: false, workbench: payload },
    }));
    await expect(fetchWorkbenchSettings({ fetchImpl: impl })).resolves.toEqual({
      status: "ok",
      payload,
    });
    expect(calls[0].url).toBe(SETTINGS_ROUTE);
  });

  it("answers one indistinguishable failure for a 404, a 500, a bad shape and a throw", async () => {
    const shapes: SettingsFetch[] = [
      stubFetch(() => ({ ok: false, status: 404, body: { error: "Not found" } })).impl,
      stubFetch(() => ({ ok: false, status: 500, body: {} })).impl,
      stubFetch(() => ({ ok: true, status: 200, body: { workbench: { nope: 1 } } })).impl,
      stubFetch(() => ({ ok: true, status: 200, body: "<html>" })).impl,
      async () => {
        throw new Error("Failed to fetch");
      },
    ];
    for (const fetchImpl of shapes) {
      await expect(fetchWorkbenchSettings({ fetchImpl })).resolves.toEqual({
        status: "failed",
      });
    }
    // The surface has exactly one sentence for all of them; the route grants no
    // existence oracle, so neither may the client.
    expect(SETTINGS_LOAD_FAILED_COPY).toBe("Settings couldn’t be loaded.");
  });

  it("tells a blown DEADLINE apart from an unmount", async () => {
    // Both stop the same request through the same controller. Without the
    // distinction every abort read as "superseded", so the surface stayed
    // silent, `loading` was never cleared, and a hung read showed `Loading…` for
    // the rest of the session — precisely the state the deadline exists to
    // prevent.
    const hang: SettingsFetch = (_url, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });

    const deadline = new AbortController();
    const timedOut = fetchWorkbenchSettings({
      signal: deadline.signal,
      fetchImpl: hang,
    });
    deadline.abort(SETTINGS_TIMEOUT_REASON);
    // Nothing else is coming, so it must NOT be silent.
    await expect(timedOut).resolves.toEqual({ status: "failed" });

    const unmount = new AbortController();
    const superseded = fetchWorkbenchSettings({
      signal: unmount.signal,
      fetchImpl: hang,
    });
    unmount.abort();
    // Nobody is left to tell.
    await expect(superseded).resolves.toEqual({ status: "stale" });
  });

  it("still reports a deadline that fires after the response landed", async () => {
    const deadline = new AbortController();
    const late: SettingsFetch = async () => {
      deadline.abort(SETTINGS_TIMEOUT_REASON);
      return { ok: true, status: 200, json: async () => ({ workbench: emptyPayload() }) };
    };
    await expect(
      fetchWorkbenchSettings({ signal: deadline.signal, fetchImpl: late }),
    ).resolves.toEqual({ status: "failed" });
  });

  it("wraps the patch under `workbench` and sends it as one PUT", async () => {
    const payload = emptyPayload();
    const { impl, calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { saved: true, workbench: payload },
    }));
    await expect(
      saveWorkbenchSettings({ chatModel: "gpt-4o" }, { fetchImpl: impl }),
    ).resolves.toEqual({ status: "ok", payload });
    expect(calls).toHaveLength(1);
    expect(calls[0].init?.method).toBe("PUT");
    expect(JSON.parse(calls[0].init?.body ?? "{}")).toEqual({
      workbench: { chatModel: "gpt-4o" },
    });
  });

  it("relays the SERVER's sentence and never a transport's", async () => {
    const served = stubFetch(() => ({
      ok: false,
      status: 400,
      body: { error: "Vector search needs an API key before it can be turned on." },
    })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: served })).resolves.toEqual({
      status: "error",
      message: "Vector search needs an API key before it can be turned on.",
      // The route ANSWERED, so nothing about this save is unknown.
      unconfirmed: false,
    });

    // A plain `Error` is not something `fetch` produces for a dead connection —
    // that is a `TypeError`, covered below. This one keeps the fallback.
    const thrown: SettingsFetch = async () => {
      throw new Error("NetworkError when attempting to fetch resource");
    };
    await expect(saveWorkbenchSettings({}, { fetchImpl: thrown })).resolves.toEqual({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
      unconfirmed: false,
    });

    const blank = stubFetch(() => ({ ok: false, status: 500, body: { error: "  " } })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: blank })).resolves.toEqual({
      status: "error",
      // A PLAIN 500 is the route's own verdict: it ran and it fell over. Not
      // widened to unknown — see the gateway case below.
      message: SETTINGS_SAVE_FAILED_COPY,
      unconfirmed: false,
    });
  });

  it("calls a gateway and a dropped connection an unknown outcome (DW-376)", async () => {
    // `Settings couldn’t be saved.` says the patch did NOT land, which is the
    // one claim nobody is in a position to make here: the request left and no
    // verdict came back, so the stored config may already have moved.
    // Iterated off the constant, so a status added to or removed from the rule
    // cannot leave this case asserting the old set.
    for (const status of UNCONFIRMED_STATUSES) {
      const gateway = stubFetch(() => ({
        ok: false,
        status,
        // A proxy's error page is not the route's sentence, and is not relayed.
        body: { error: "<html>Bad Gateway</html>" },
      })).impl;
      await expect(saveWorkbenchSettings({}, { fetchImpl: gateway })).resolves.toEqual({
        status: "error",
        message: unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
        unconfirmed: true,
      });
    }

    // The two abort flavours and the `TypeError` a dead connection rejects with.
    const thrown: unknown[] = [
      Object.assign(new Error("signal timed out"), { name: "TimeoutError" }),
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
      new TypeError("Failed to fetch"),
    ];
    for (const cause of thrown) {
      const impl: SettingsFetch = async () => {
        throw cause;
      };
      const result = await saveWorkbenchSettings({}, { fetchImpl: impl });
      expect(result).toEqual({
        status: "error",
        message: unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
        unconfirmed: true,
      });
      // Still no transport vocabulary: the FACT the cause carries is used, the
      // string it carries never is.
      expect(result.status === "error" && result.message).not.toContain(
        (cause as Error).message,
      );
    }
  });

  it("treats a shapeless 200 as an error, because the draft is re-seeded from it", async () => {
    const shapeless = stubFetch(() => ({ ok: true, status: 200, body: { saved: true } })).impl;
    const result = await saveWorkbenchSettings({}, { fetchImpl: shapeless });
    expect(result.status).toBe("error");
  });

  it("sends the seeded version as `If-Match` (DW-63)", async () => {
    const payload = emptyPayload();
    const { impl, calls } = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { saved: true, workbench: payload },
    }));
    await saveWorkbenchSettings({}, { fetchImpl: impl, version: "w1:2-abc" });
    expect(calls[0].init?.headers).toEqual({
      "Content-Type": "application/json",
      "If-Match": '"w1:2-abc"',
    });
  });

  it("relays THIS ROUTE'S OWN 503, which is a verdict and not a gateway's silence", async () => {
    // `PUT /api/settings` answers 503 with `CONFIG_UNREADABLE_COPY` when the
    // store cannot be read, and it refuses BEFORE merging anything — so nothing
    // was written. Reading that as "nobody answered" would discard the one
    // actionable sentence the owner could act on, tell them the outcome is
    // unknown, and send `SettingsCanvas` to clear the version it was holding,
    // all for a write that provably did not land.
    expect(UNCONFIRMED_STATUSES).not.toContain(503);
    const unreadable = stubFetch(() => ({
      ok: false,
      status: 503,
      body: { error: CONFIG_UNREADABLE_COPY },
    })).impl;
    await expect(
      saveWorkbenchSettings({ chatModel: "gpt-4o" }, { fetchImpl: unreadable, version: "w1:2-abc" }),
    ).resolves.toEqual({
      status: "error",
      message: CONFIG_UNREADABLE_COPY,
      unconfirmed: false,
    });
  });

  it("relays the SERVER's conflict sentence, and keeps the draft's own state out of it", async () => {
    // A refused save is a message, never a thrown error and never a cleared
    // draft: the caller's only correct response is to keep every edit on screen
    // — which is why this resolves rather than rejects.
    const conflict = stubFetch(() => ({
      ok: false,
      status: 412,
      body: { error: WRITE_CONFLICT_COPY },
    })).impl;
    await expect(
      saveWorkbenchSettings({ chatModel: "gpt-4o" }, { fetchImpl: conflict, version: "w1:2-old" }),
    ).resolves.toEqual({
      status: "error",
      message: WRITE_CONFLICT_COPY,
      unconfirmed: false,
    });

    // …and the 428 the route answers a missing precondition with, the same way.
    const missing = stubFetch(() => ({
      ok: false,
      status: 428,
      body: { error: WRITE_PRECONDITION_REQUIRED_COPY },
    })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: missing })).resolves.toEqual({
      status: "error",
      message: WRITE_PRECONDITION_REQUIRED_COPY,
      unconfirmed: false,
    });
  });

  it("ACCEPTS a landed SAVE whose payload carries no version (DW-199)", async () => {
    // The headline symptom: `isWorkbenchSettingsPayload` required `version`, so
    // a 200 that omitted one was reported to the surface as an ERROR. A save
    // that LANDED being shown as a failure is the worst of the three outcomes —
    // the owner reads "not applied" about a change that was applied, and the
    // canvas is left showing a draft it believes is unsaved.
    const { version: _dropped, ...withoutVersion } = emptyPayload();
    const impl = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { saved: true, workbench: withoutVersion },
    })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: impl })).resolves.toEqual({
      status: "ok",
      payload: withoutVersion,
    });
  });

  it("ACCEPTS a GET body that carries no version, and still renders (DW-199)", async () => {
    // The route always sends one, so absence means something in between
    // dropped it. Refusing takes the whole canvas off screen and loses every
    // unsaved edit on it; accepting shows the settings and lets the surface
    // keep the version it already held. Nothing can clobber either way — a
    // save with no version is refused 428, because `checkWritePrecondition`
    // has no "skip the check" branch.
    const { version: _dropped, ...withoutVersion } = emptyPayload();
    const impl = stubFetch(() => ({
      ok: true,
      status: 200,
      body: { workbench: withoutVersion },
    })).impl;
    await expect(fetchWorkbenchSettings({ fetchImpl: impl })).resolves.toEqual({
      status: "ok",
      payload: withoutVersion,
    });
  });

  it("accepts a `null` or empty version, and refuses only a wrong TYPE", async () => {
    // `null` is the same absence spelled by a serializer, and `""` is a token
    // nothing can match — both degrade the same way. A NUMBER would be sent
    // back as `If-Match` and answered with a conflict the owner cannot explain.
    for (const version of [null, ""]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), version }),
      ).toBe(true);
    }
    for (const version of [1, {}, []]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), version }),
      ).toBe(false);
    }
  });

  it("REQUIRES `hasWorkersAiBinding`, unlike the version (DW-225)", () => {
    // The one field on this payload with no safe default, so it is the one
    // absence that is NOT degraded over. `true` would enable the switch on a
    // deployment with no binding and `false` would refuse `workers-ai` on
    // Workers itself, so a payload without it is not one — the surface shows the
    // load-failed sentence rather than guessing.
    const { hasWorkersAiBinding: _dropped, ...without } = emptyPayload();
    expect(isWorkbenchSettingsPayload(without)).toBe(false);
    for (const value of [null, "false", 0, 1]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), hasWorkersAiBinding: value }),
      ).toBe(false);
    }
    // Both booleans are accepted, so the guard is about TYPE, not about which
    // deployment this is.
    for (const value of [true, false]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), hasWorkersAiBinding: value }),
      ).toBe(true);
    }
  });

  it("REQUIRES the substitution pair on the same argument (DW-312)", () => {
    // The canvas guards its note on BOTH fields, and neither absence has a safe
    // reading: a flag defaulted to `false` silences a substitution that IS
    // running — the one thing the note exists to say — and `true` announces one
    // that is not. So a payload missing either is not one, and the surface
    // shows its failed-read sentence rather than guessing.
    const { embeddingModelInEffect: _model, ...withoutModel } = emptyPayload();
    expect(isWorkbenchSettingsPayload(withoutModel)).toBe(false);
    const { embeddingModelOverridden: _flag, ...withoutFlag } = emptyPayload();
    expect(isWorkbenchSettingsPayload(withoutFlag)).toBe(false);

    for (const value of [null, "true", 0, 1]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), embeddingModelOverridden: value }),
      ).toBe(false);
    }
    for (const value of [1, {}, []]) {
      expect(
        isWorkbenchSettingsPayload({ ...emptyPayload(), embeddingModelInEffect: value }),
      ).toBe(false);
    }

    // `null` IS accepted for the model name — "nothing embeds" is a real state,
    // and it is exactly the state that withholds the note.
    expect(
      isWorkbenchSettingsPayload({
        ...emptyPayload(),
        embeddingModelInEffect: null,
        embeddingModelOverridden: true,
      }),
    ).toBe(true);
    expect(
      isWorkbenchSettingsPayload({
        ...emptyPayload(),
        embeddingModelInEffect: "@cf/baai/bge-m3",
        embeddingModelOverridden: true,
      }),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The route — run for real against a temp DATA_DIR
// ---------------------------------------------------------------------------

describe("GET /api/settings", () => {
  it("serves the legacy fields and one workbench object with the story's defaults", async () => {
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;

    // The legacy contract is frozen: every field `EffectiveSettings` carries is
    // still at the top level, in its exact shape.
    for (const key of [
      "provider",
      "model",
      "configured",
      "embeddingSupport",
      "embeddingModel",
      "hasApiKey",
      "ollamaBaseUrl",
      "structuredKnowledgeProvider",
      "readOnly",
    ]) {
      expect(Object.keys(body)).toContain(key);
    }

    expect(isWorkbenchSettingsPayload(body.workbench)).toBe(true);
    expect(body.workbench).toMatchObject({
      chatProvider: null,
      ingestProvider: null,
      // Off by default, and off in the KERNEL rather than in a component.
      vectorSearchEnabled: false,
      llmTimeoutSeconds: null,
      language: "English",
      hasCustomApiKey: false,
      hasEmbeddingApiKey: false,
      hasFirecrawlApiKey: false,
      readOnly: false,
    });
  });

  it("answers a non-owner with 404 and no oracle", async () => {
    principal.current = { id: "user_2", handle: "someone-else" };
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Not found" });
  });

  it("never serves a stored key — anywhere in the serialized body", async () => {
    await store({
      customApiKey: "sk-custom-secret",
      embeddingApiKey: "sk-embed-secret",
      firecrawlApiKey: "fc-secret",
      customBaseUrl: "https://api.example/v1",
    });
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    const text = await response.text();
    for (const secret of ["sk-custom-secret", "sk-embed-secret", "fc-secret"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text) as { workbench: WorkbenchSettingsPayload };
    // Presence is a boolean, and the non-secret half of the same setting is served.
    expect(body.workbench.hasCustomApiKey).toBe(true);
    expect(body.workbench.hasEmbeddingApiKey).toBe(true);
    expect(body.workbench.hasFirecrawlApiKey).toBe(true);
    expect(body.workbench.customBaseUrl).toBe("https://api.example/v1");
  });

  it("reports a read-only deployment", async () => {
    process.env.YOPEDIA_READONLY = "1";
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as {
      readOnly: boolean;
      workbench: WorkbenchSettingsPayload;
    };
    expect(body.readOnly).toBe(true);
    expect(body.workbench.readOnly).toBe(true);
  });

  it("serves ONE write precondition, at the top level and on `workbench`", async () => {
    // Two surfaces read this body — `/settings` takes the top-level field
    // through `useSettings`, the canvas takes it off the object it seeds its
    // draft from. One stored token, served twice, so the two cannot drift into
    // disagreeing about what the next save is conditional on.
    await store({ provider: "openai", model: "gpt-4o" });
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as {
      version: string;
      workbench: WorkbenchSettingsPayload;
    };

    expect(typeof body.version).toBe("string");
    expect(body.workbench.version).toBe(body.version);
    // …and it is the token the store HOLDS, not a value computed here.
    expect(body.version).toBe(await storedVersion());
  });

  it("serves a version that is NOT a function of the stored secrets", async () => {
    // AD-23: no secret material crosses this boundary. A CONTENT-DERIVED
    // version was exactly that — a value computed over `firecrawlApiKey`,
    // `customApiKey` and `embeddingApiKey` — so two stores differing only in a
    // key had to serve different versions. An opaque stamp cannot: it is
    // generated from randomness and stamped under a reserved key, and no field
    // feeds it.
    const secrets = {
      firecrawlApiKey: "fc-secret-one",
      customApiKey: "sk-custom-one",
      embeddingApiKey: "sk-embed-one",
    };
    await store({ provider: "openai", ...secrets });
    const { GET } = await import("@/app/api/settings/route");
    const first = await (await GET()).json();
    const firstText = JSON.stringify(first);

    // The serialized body carries no key, and no version derived from one.
    for (const secret of Object.values(secrets)) {
      expect(firstText).not.toContain(secret);
    }
    expect(firstText).not.toContain(objectVersion({ provider: "openai", ...secrets }));

    // Hand-stamp a second store with the SAME token but different keys: the
    // served version is identical, which is only possible because no field
    // contributes to it.
    const held = await storedVersion();
    await handWrite({
      provider: "openai",
      firecrawlApiKey: "fc-secret-two",
      customApiKey: "sk-custom-two",
      embeddingApiKey: "sk-embed-two",
      [VERSION_KEY]: held,
    });
    const second = (await (await GET()).json()) as { version: string };
    expect(second.version).toBe(held);
  });

  it("is BLIND to any config change that did not go through `saveConfig`", async () => {
    // The real property of the stamp scheme, stated as it is rather than as the
    // narrower claim the derived version used to make. The version tracks
    // SAVES, not bytes, so anything that edits `.llm-wiki-config.json` behind
    // the API is invisible to the guard.
    //
    // The BENIGN case is a key re-order: `.llm-wiki-config.json` is
    // hand-editable, and a text editor that re-serialized it must not be
    // reported as a change nobody made. Under the stamp that is structural
    // rather than earned by sorting keys.
    await store({ provider: "openai", model: "gpt-4o" });
    const { GET } = await import("@/app/api/settings/route");
    const first = (await (await GET()).json()) as { version: string };

    await handWrite({ model: "gpt-4o", provider: "openai", [VERSION_KEY]: first.version });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      first.version,
    );

    // The RESIDUAL is the same fact with different bytes: a hand edit that
    // actually CHANGES a value also leaves the version standing, so a draft
    // seeded before it saves straight over it. The derived version moved here
    // and this one does not — that is the cost paid to get the three API keys
    // off the boundary (AD-23), and it is recorded rather than closed. See
    // `UNSTAMPED_CONFIG_VERSION` in `config.ts`.
    await handWrite({
      provider: "anthropic",
      model: "claude",
      [VERSION_KEY]: first.version,
    });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      first.version,
    );

    // A hand edit that DROPS the token is the one this scheme does see, and it
    // errs the safe way: the store reads as unstamped, so a draft holding a real
    // token is refused rather than allowed to land over it.
    await handWrite({ provider: "anthropic", model: "claude" });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      UNSTAMPED_CONFIG_VERSION,
    );

    // …and it moves on every save THROUGH the API, which is the whole set of
    // writes the guard is defined over.
    await store({ provider: "anthropic", model: "gpt-4o" });
    const last = (await (await GET()).json()) as { version: string };
    expect(last.version).not.toBe(first.version);
  });

  it("serves the sentinel for a config carrying no embedded token", async () => {
    // A store written by hand, restored from a backup, or written by the
    // two-file scheme this replaced. Refusing every save against it would
    // strand the owner.
    await handWrite({ provider: "openai" });
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as { version: string };
    expect(body.version).toBe(UNSTAMPED_CONFIG_VERSION);
  });

  it("never reads the RETIRED sibling version file (DW-272)", async () => {
    // A migrated store still has `.llm-wiki-config.version` lying beside the
    // config. It is not swept — deleting files an owner did not ask about is not
    // this module's business — and it must never be honoured: the token this
    // scheme trusts is the one inside the object.
    await handWrite({ provider: "openai" });
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.version"),
      "s1:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\n",
      "utf-8",
    );
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as { version: string };
    expect(body.version).toBe(UNSTAMPED_CONFIG_VERSION);
    expect(body.version).not.toContain("aaaaaaaa");
  });

  it("serves the sentinel over `{}` for a store with no files at all", async () => {
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as { version: string };
    expect(body.version).toBe(UNSTAMPED_CONFIG_VERSION);
  });

  it("refuses to serve settings it could not read (503)", async () => {
    // `loadConfig()` answers `{}` for an absent config AND for a broken one.
    // Serving defaults for the second would seed a draft from settings the
    // owner never chose, and the save that followed would write them in.
    await store({ provider: "openai" });
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      "{ not json",
      "utf-8",
    );
    _resetConfigCache();
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
  });

  it("refuses a config file that parses to something that is not an object", async () => {
    // `"x"`, `[]` and `null` are all valid JSON and none of them is a config.
    // Spreading one into the merge base is the same lost store as a read error.
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      "[1, 2, 3]\n",
      "utf-8",
    );
    _resetConfigCache();
    const { GET } = await import("@/app/api/settings/route");
    expect((await GET()).status).toBe(503);
  });

  it("serves the settings and their token out of ONE object (DW-272)", async () => {
    // The token used to live in a sibling file, and two files cannot be read in
    // one instant: `readConfig` had to ORDER its two reads to choose which
    // mismatched pair it could produce, and on R2 it could not make the pair
    // atomic at all. There is no pair now — and the config half is served with
    // exactly the fields it stored, the reserved key stripped on the way out.
    await store({ provider: "openai", customBaseUrl: "https://api.example/v1" });
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as {
      version: string;
      workbench: WorkbenchSettingsPayload & Record<string, unknown>;
    };
    expect(body.version).toBe(await storedVersion());
    expect(body.workbench.customBaseUrl).toBe("https://api.example/v1");
    expect(body.workbench[VERSION_KEY]).toBeUndefined();
    expect(await stored()).toEqual({
      provider: "openai",
      customBaseUrl: "https://api.example/v1",
    });
  });
});

describe("PUT /api/settings", () => {
  it("persists a Chat model and an Ingest model on different providers", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          chatProvider: "openai",
          chatModel: "gpt-4o",
          ingestProvider: "anthropic",
          ingestModel: "claude-sonnet-4-20250514",
        },
      }),
    );
    expect(response.status).toBe(200);

    // Back from the STORE, as a restarted process would read them.
    expect(await stored()).toMatchObject({
      chatProvider: "openai",
      chatModel: "gpt-4o",
      ingestProvider: "anthropic",
      ingestModel: "claude-sonnet-4-20250514",
    });
    await loadConfig();
    expect(getChatModelSettings()).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      usesPrimary: false,
    });
    expect(getIngestModelSettings()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      usesPrimary: false,
    });
  });

  it("leaves a legacy save byte-identical to what it was before this story", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ provider: "ollama-cloud", model: "gpt-oss:120b" }));
    expect(response.status).toBe(200);
    // Exactly the two keys, and nothing Story 1.9 added.
    expect(await stored()).toEqual({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    });
  });

  it("refuses vector-on without all three, and writes nothing", async () => {
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({ workbench: { vectorSearchEnabled: true, embeddingProvider: "openai" } }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toContain("Vector search needs");
    expect(body.error).toContain("an endpoint");
    expect(body.error).toContain("a model");
    expect(body.error).toContain("an API key");
    // Nothing written: the refusal happens before `saveConfig`.
    expect(await stored()).toEqual({ provider: "openai" });
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(false);
  });

  it("refuses vector-on for a non-Workers-AI id under Workers AI", async () => {
    // DW-73: the gate used to accept any non-empty model, and
    // `resolveEmbeddingModelName` then discarded this one for `@cf/baai/bge-m3`
    // without a word. Now the route says so and writes nothing.
    //
    // ON Workers, so the MODEL is the only unmet leg: off the runtime the
    // binding leg (DW-225) would refuse this same request for a second reason
    // and the sentence below would no longer be about DW-73 at all.
    onWorkers();
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "workers-ai",
          embeddingModel: "text-embedding-3-small",
        },
      }),
    );
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe(UNSUPPORTED_WORKERS_MODEL);
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("refuses vector-on for a Workers AI id under a keyed provider", async () => {
    // The MIRROR of the case above, in its own `it` so a regression in one
    // cannot hide behind the other: this direction is just as silently
    // overridden at embed time, and just as refused here.
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          embeddingModel: "@cf/baai/bge-m3",
          embeddingApiKey: "sk-embed",
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can be turned on.",
    );
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("ACCEPTS an unrelated edit while the STORED config holds a mismatch (DW-219)", async () => {
    // The inversion this spec makes, and the reason it is a bug rather than a
    // strictness: `settingsSaveBody` sends `vectorSearchEnabled` on EVERY save,
    // so re-running the whole rule whenever the merged flag was on answered 400
    // to a chat-model or a timeout edit on any deployment already storing a
    // mismatch — naming a field the owner's edit never touched, with no way out
    // of the surface except turning the switch off.
    //
    // The gate is now scoped to patches that MOVE something it reads. Nothing
    // escapes: `getVectorSearchSettings()` still intersects the stored flag with
    // the same predicate, so the mismatch still reads as vector-OFF (asserted
    // below), and the switch cannot be turned on while it stands.
    onWorkers();
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }));

    expect(response.status).toBe(200);
    // The edit landed, and the owner's own stored flag was NOT rewritten by it.
    expect(await stored()).toMatchObject({
      chatModel: "gpt-4o",
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    await loadConfig();
    // …while the effective answer is still off, which is what makes the skip
    // safe rather than a hole.
    expect(getVectorSearchSettings().enabled).toBe(false);
  });

  it("still refuses an edit that MOVES a vector input over the same store (DW-219)", async () => {
    // The other side of the scope. `embeddingModel` is one of the inputs the
    // rule reads, so this patch re-opens the question — and the answer is still
    // no, with the sentence, and nothing written.
    onWorkers();
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({ workbench: { embeddingModel: "@cf/llava-hf/llava-1.5-7b-hf" } }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      UNSUPPORTED_WORKERS_MODEL_INACTIVE,
    );
    expect(await stored()).toEqual({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
  });

  it("still refuses TURNING IT ON over a mismatch, and allows turning it OFF (DW-219)", async () => {
    // The two doors the scope must leave exactly where they were. Turning ON is
    // always re-checked even when no input moved; turning OFF is always allowed,
    // which is the owner's way out of the state above.
    onWorkers();
    await store({
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");
    const refused = await PUT(
      await put({ workbench: { vectorSearchEnabled: true } }),
    );
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toBe(
      UNSUPPORTED_WORKERS_MODEL,
    );

    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const allowed = await PUT(
      await put({ workbench: { vectorSearchEnabled: false } }),
    );
    expect(allowed.status).toBe(200);
    expect(await stored()).toMatchObject({ vectorSearchEnabled: false });
  });

  it("ACCEPTS a typed id over an ALREADY-ON env mismatch, and stays off (DW-218 x DW-219)", async () => {
    // CHARACTERIZATION of the corner where the two fixes meet, written down
    // because it is surprising rather than because it is wrong.
    //
    // `EMBEDDING_MODEL` owns the mismatch and the switch is ALREADY stored on.
    // The owner types a supported `@cf/` id and saves: the override still wins,
    // so the merged inputs are identical to the ones already stored, nothing
    // moved, and the switch is not being turned on — so the gate does not run
    // and the save is answered 200. Before DW-219 it was 400.
    //
    // It is not a regression, for two reasons. Nothing was enabled: the flag was
    // already on, and effective vector search stays OFF (asserted below) because
    // `getVectorSearchSettings()` intersects the flag with the same predicate.
    // And the refusal is still on screen — the checkbox announces the sentence
    // WITH the `EMBEDDING_MODEL` note, which is the DW-218 fix telling the owner
    // that the box they just typed into is not the one that matters.
    onWorkers();
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({ vectorSearchEnabled: true, embeddingProvider: "workers-ai" });

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: { vectorSearchEnabled: true, embeddingModel: "@cf/baai/bge-m3" },
      }),
    );
    expect(response.status).toBe(200);

    // The typed id was stored — it is what applies the day the variable is
    // unset — while the effective switch is still off underneath it.
    await loadConfig();
    expect(await stored()).toMatchObject({ embeddingModel: "@cf/baai/bge-m3" });
    expect(getVectorSearchSettings().enabled).toBe(false);

    // And the surface still says why, naming the variable that owns it.
    const payload = getWorkbenchSettings(true);
    const draft = settingsDraftFromPayload(payload);
    expect(vectorSearchMissingCopy(draftVectorInputs(draft, payload))).toBe(
      `${UNSUPPORTED_WORKERS_MODEL} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
    );
  });

  it("turns vector search on for a Workers AI id under Workers AI", async () => {
    // ON Workers: `workers-ai` is self-transporting THROUGH the Cloudflare `AI`
    // binding, so without one the save is refused by the binding leg (DW-225) —
    // see the case below, which is the same request off the runtime.
    onWorkers();
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "workers-ai",
          embeddingModel: "@cf/baai/bge-m3",
        },
      }),
    );
    expect(response.status).toBe(200);
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);
  });

  it("SERVES the binding it read, on GET, in both directions (DW-225)", async () => {
    // The value, not just the type. `isWorkbenchSettingsPayload` only checks
    // that the field is a boolean, and the agreement table hands one local
    // boolean to both halves — so a `GET` that hardcoded `false` (or dropped the
    // read entirely) would leave every other case in this repo green while the
    // browser's half of the rule ran on a fiction.
    await store({ embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" });
    const { GET } = await import("@/app/api/settings/route");

    const offWorkers = (await (await GET()).json()) as {
      workbench: WorkbenchSettingsPayload;
    };
    expect(offWorkers.workbench.hasWorkersAiBinding).toBe(false);
    // …and the browser, fed only that body, refuses.
    expect(
      draftCanEnableVectorSearch(
        settingsDraftFromPayload(offWorkers.workbench),
        offWorkers.workbench,
      ),
    ).toBe(false);

    onWorkers();
    const onRuntime = (await (await GET()).json()) as {
      workbench: WorkbenchSettingsPayload;
    };
    expect(onRuntime.workbench.hasWorkersAiBinding).toBe(true);
    expect(
      draftCanEnableVectorSearch(
        settingsDraftFromPayload(onRuntime.workbench),
        onRuntime.workbench,
      ),
    ).toBe(true);
  });

  it("refuses the SAME request off the Workers runtime (DW-225)", async () => {
    // No `onWorkers()`: `getCloudflareContext()` throws, `getWorkersAiBinding()`
    // is `null`, and the switch would otherwise turn on for a deployment where
    // `resolveEmbeddingProvider` returns `null` forever.
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "workers-ai",
          embeddingModel: "@cf/baai/bge-m3",
        },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("reads a STORED namespace mismatch as vector-off", async () => {
    // Bytes that arrived another way (a hand-edited config, an older release)
    // get the same answer as a save would: off, with the Settings sentence
    // saying why — not an embed with a model the owner never chose.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    expect(getVectorSearchSettings().enabled).toBe(false);
    // ON Workers, so the model is the only leg this case is about.
    const payload = getWorkbenchSettings(true);
    expect(
      vectorSearchMissingCopy(
        draftVectorInputs(settingsDraftFromPayload(payload), payload),
      ),
    ).toBe(UNSUPPORTED_WORKERS_MODEL);
  });

  it("turns vector search on when the endpoint, the model and the key all arrive", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          embeddingModel: "text-embedding-3-small",
          embeddingApiKey: "sk-embed",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({ vectorSearchEnabled: true });
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);
    // The response re-seeds the draft, and still carries no key.
    const body = (await (await import("@/app/api/settings/route")).GET().then((r) =>
      r.text(),
    )) as string;
    expect(body).not.toContain("sk-embed");
  });

  it("writes the EXISTING embedding keys rather than a second embedding model", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    await PUT(
      await put({
        workbench: {
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-large",
        },
      }),
    );
    const config = await stored();
    expect(config.embeddingProvider).toBe("openai");
    expect(config.embeddingModel).toBe("text-embedding-3-large");
    // One embedding model, one config key: no parallel field appeared.
    expect(Object.keys(config).filter((k) => /embeddingModel/i.test(k))).toEqual([
      "embeddingModel",
    ]);
  });

  it("clears a key on null and on empty, and leaves an ABSENT one alone", async () => {
    await store({ firecrawlApiKey: "fc-1", customApiKey: "sk-1" });
    const { PUT, GET } = await import("@/app/api/settings/route");

    // Absent: the timeout moves and neither key is disturbed.
    await PUT(await put({ workbench: { llmTimeoutSeconds: 90 } }));
    let config = await stored();
    expect(config.firecrawlApiKey).toBe("fc-1");
    expect(config.customApiKey).toBe("sk-1");
    expect(config.llmTimeoutSeconds).toBe(90);

    await PUT(await put({ workbench: { firecrawlApiKey: null } }));
    config = await stored();
    expect("firecrawlApiKey" in config).toBe(false);
    expect(config.customApiKey).toBe("sk-1");

    await PUT(await put({ workbench: { customApiKey: "" } }));
    expect("customApiKey" in (await stored())).toBe(false);

    await loadConfig();
    const body = (await (await GET()).json()) as { workbench: WorkbenchSettingsPayload };
    expect(body.workbench.hasFirecrawlApiKey).toBe(false);
    expect(body.workbench.hasCustomApiKey).toBe(false);
  });

  it("refuses an invalid provider, model, URL or timeout with one sentence and no write", async () => {
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");
    const refusals: Array<Record<string, unknown>> = [
      { chatProvider: "acme" },
      { chatModel: "" },
      { customBaseUrl: "not-a-url" },
      { llmTimeoutSeconds: 0 },
      { llmTimeoutSeconds: 4000 },
      { llmTimeoutSeconds: 1.5 },
    ];
    for (const workbench of refusals) {
      const response = await PUT(await put({ workbench }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as { error: string };
      expect(typeof body.error).toBe("string");
      expect(body.error.length).toBeGreaterThan(0);
    }
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("answers a read-only deployment with the route's existing 403", async () => {
    process.env.YOPEDIA_READONLY = "1";
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { llmTimeoutSeconds: 60 } }));
    expect(response.status).toBe(403);
    expect(await stored()).toEqual({});
  });

  it("answers a non-owner with the route's existing 404", async () => {
    principal.current = null;
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { llmTimeoutSeconds: 60 } }));
    expect(response.status).toBe(404);
    expect(await stored()).toEqual({});
  });

  it("lands the save when the precondition matches, and answers the NEW version", async () => {
    await store({ provider: "openai" });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const seeded = ((await (await GET()).json()) as { version: string }).version;

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      workbench: WorkbenchSettingsPayload;
    };
    expect(await stored()).toMatchObject({ chatModel: "gpt-4o" });
    // The token the store now HOLDS — `saveConfig` stamped it and returned it,
    // so there is nothing to predict and nothing to read back.
    expect(body.version).toBe(await storedVersion());
    expect(body.version).not.toBe(seeded);
    // …and served on the object the canvas re-seeds its draft from, so a second
    // save without a reload still lands.
    expect(body.workbench.version).toBe(body.version);

    const again = await PUT(
      await put({ workbench: { chatModel: "gpt-4.1" } }, body.version),
    );
    expect(again.status).toBe(200);
    expect(await stored()).toMatchObject({ chatModel: "gpt-4.1" });
  });

  it("refuses a save seeded before the OTHER surface saved (412), and keeps its value", async () => {
    await store({});
    const { GET, PUT } = await import("@/app/api/settings/route");
    // Both surfaces read the same version…
    const seeded = ((await (await GET()).json()) as { version: string }).version;
    // …the first one saves…
    expect((await PUT(await put({ workbench: { chatModel: "from-canvas" } }, seeded))).status).toBe(
      200,
    );

    // …and the second's draft is now stale.
    const response = await PUT(
      await put({ workbench: { ingestModel: "from-legacy" } }, seeded),
    );

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ error: WRITE_CONFLICT_COPY });
    // The first surface's value survives, and the second's was not applied.
    const config = await stored();
    expect(config.chatModel).toBe("from-canvas");
    expect(config.ingestModel).toBeUndefined();
  });

  it("refuses a save with no precondition (428) and writes nothing", async () => {
    await store({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, null));

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    });
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("treats `*` and an unquoted version as absent", async () => {
    await store({ provider: "openai" });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const seeded = ((await (await GET()).json()) as { version: string }).version;
    for (const header of ["*", seeded, ""]) {
      const response = await PUT(
        new Request("http://localhost/api/settings", {
          method: "PUT",
          headers: { "Content-Type": "application/json", "If-Match": header },
          body: JSON.stringify({ workbench: { chatModel: "gpt-4o" } }),
        }),
      );
      expect(response.status).toBe(428);
    }
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("does not refuse a save over a config re-ordered underneath it", async () => {
    // The config-re-order row of the matrix, end to end: same values, other key
    // order, no false conflict. Re-ordered BY HAND — a re-order through
    // `saveConfig` is a save, and every save rotates the token by design.
    await store({ provider: "openai", model: "gpt-4o" });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const seeded = ((await (await GET()).json()) as { version: string }).version;
    await handWrite({ model: "gpt-4o", provider: "openai", [VERSION_KEY]: seeded });

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(200);
  });

  it("LANDS over a hand edit it never saw — the residual, pinned", async () => {
    // The same blindness as the row above, with the sign flipped: the guard is
    // defined over saves, so a hand edit between the seed and the save is not a
    // conflict it can see, and the stale draft wins. Pinned so the trade is a
    // recorded behaviour rather than a surprise — the derived version refused
    // this, and refusing it is what cost the boundary its secret discipline.
    await store({ provider: "openai" });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const seeded = ((await (await GET()).json()) as { version: string }).version;

    // The token is PRESERVED, which is what a text editor rewriting the file
    // does. Dropping it would leave an unstamped store, and the draft below
    // would be refused — a different case, pinned in the GET suite above.
    await handWrite({ provider: "anthropic", [VERSION_KEY]: seeded });

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(200);
    // The hand edit survives only because it is in the merge BASE this request
    // read — nothing about it was checked, and a save that had touched
    // `provider` would have overwritten it silently.
    expect(await stored()).toEqual({ provider: "anthropic", chatModel: "gpt-4o" });
  });

  it("leaves NOTHING behind when the one write fails, so the next save lands", async () => {
    // `saveConfig` used to write a token file and then the config, and leaned on
    // that ORDER: a failed second write left a stamp nobody held, which refused
    // every open draft. One object has no order to lean on and no half-state to
    // recover from — a failed write changes nothing at all, so the draft that
    // was refused a 500 can simply be saved again.
    await store({ provider: "openai" });
    const seeded = await storedVersion();
    const { PUT } = await import("@/app/api/settings/route");

    const storage = getStorage();
    const spy = vi
      .spyOn(storage, "writeFileIfMatch")
      .mockRejectedValue(new Error("the storage provider is unavailable"));
    try {
      // The route surfaces the storage failure as its existing 500.
      const half = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));
      expect(half.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // The config never changed, and neither did the token…
    expect(await stored()).toEqual({ provider: "openai" });
    expect(await storedVersion()).toBe(seeded);
    // …so the same draft, still holding the same version, now lands.
    const next = await PUT(await put({ workbench: { chatModel: "gpt-4.1" } }, seeded));
    expect(next.status).toBe(200);
    expect(await stored()).toEqual({ provider: "openai", chatModel: "gpt-4.1" });
  });

  it("refuses a save it could not read the store for (503), without calling saveConfig", async () => {
    // `loadConfig()` answers `{}` for a broken read, and a patch merged into
    // `{}` and written back deletes every stored field — the three API keys
    // included. The refusal happens before the merge, so the bytes on disk are
    // untouched.
    await store({ provider: "openai", firecrawlApiKey: "fc-secret" });
    const seeded = await storedVersion();
    const broken = "{ not json";
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      broken,
      "utf-8",
    );
    _resetConfigCache();
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      await put({ workbench: { chatModel: "gpt-4o" } }, seeded),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
    // Nothing was written: the store still holds the broken bytes rather than
    // a config merged out of `{}`.
    expect(
      await readFile(path.join(tmpDir, ".llm-wiki-config.json"), "utf-8"),
    ).toBe(broken);
  });

  it("refuses a save whose COMPARE-AND-SET loses (412), and writes nothing", async () => {
    // The window the `If-Match` check cannot see (DW-272). This request's draft
    // token matched, its merge base was read — and then another writer landed
    // before it wrote back. Without the compare-and-set the merge base read a
    // moment earlier would go straight over that save; with it the write is
    // refused and the other writer's value stands.
    await store({ provider: "openai", firecrawlApiKey: "fc-secret" });
    const seeded = await storedVersion();
    const { PUT } = await import("@/app/api/settings/route");

    const storage = getStorage();
    const realWrite = storage.writeFileIfMatch.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFileIfMatch")
      .mockImplementation(async (target, content, etag) => {
        // The OTHER writer lands, in the instant between this request's read
        // and its write.
        await handWrite({
          provider: "anthropic",
          firecrawlApiKey: "fc-secret",
          [VERSION_KEY]: "s1:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        });
        return realWrite(target, content, etag);
      });
    let response: Response;
    try {
      response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));
    } finally {
      spy.mockRestore();
    }

    expect(response.status).toBe(412);
    expect(await response412Error(response)).toBe(WRITE_CONFLICT_COPY);
    // The other writer's value is what the store still holds — no `chatModel`,
    // and the secret it never touched intact.
    expect(await stored()).toEqual({
      provider: "anthropic",
      firecrawlApiKey: "fc-secret",
    });
  });

  it("lands a first save against the UNSTAMPED sentinel and stamps a real token", async () => {
    // A config with no embedded token — hand-written, restored, or written by
    // the two-file scheme. Refusing it would strand the owner.
    await handWrite({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      await put({ workbench: { chatModel: "gpt-4o" } }, UNSTAMPED_CONFIG_VERSION),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { version: string };
    expect(body.version).not.toBe(UNSTAMPED_CONFIG_VERSION);
    expect(body.version).toBe(await storedVersion());
    expect(await stored()).toMatchObject({ provider: "openai", chatModel: "gpt-4o" });
  });

  it("lands a first save into a store with NO files at all", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({ workbench: { chatModel: "gpt-4o" } }, UNSTAMPED_CONFIG_VERSION),
    );
    expect(response.status).toBe(200);
    expect(await stored()).toEqual({ chatModel: "gpt-4o" });
    expect(await storedVersion()).not.toBe(UNSTAMPED_CONFIG_VERSION);
  });

  it("counts an embedding model set by the LEGACY field in the same request", async () => {
    // The workbench patch is applied after every legacy branch, and the vector
    // gate is evaluated over that post-merge object — so one request can set the
    // model the flat way and the switch the nested way.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        embeddingModel: "text-embedding-3-small",
        workbench: {
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingBaseUrl: "https://embed.example",
          embeddingApiKey: "sk-embed",
        },
      }),
    );
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({
      embeddingModel: "text-embedding-3-small",
      vectorSearchEnabled: true,
    });
  });

  it("REFUSES a flat embedding field that breaks the gate beside a workbench key", async () => {
    // The refusal direction of the case above, and the one the DW-219 scoping
    // could quietly drop. The gate now re-runs only when the request MOVES an
    // input — and the flat `embeddingModel` branch has ALREADY landed on the
    // object the patch is merged onto by the time the validator sees it. Handed
    // that same object as both the merge target and the "what did this request
    // move" baseline, the flat move would compare equal to itself and skip the
    // gate. So the route passes `existing` — the PRE-request config — as the
    // baseline, and this is what that argument buys.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingApiKey: "sk-embed",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        // Flat, and a namespace mismatch for the stored `openai` selection…
        embeddingModel: "@cf/baai/bge-m3",
        // …beside a `workbench` key that moves nothing the rule reads.
        workbench: { chatModel: "gpt-4o" },
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search is switched on, but it needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can run. Turn it off, or supply what is missing.",
    );
    // Nothing written — not the flat field, not the chat model.
    expect(await stored()).toMatchObject({
      embeddingModel: "text-embedding-3-small",
    });
    expect(await stored()).not.toMatchObject({ chatModel: "gpt-4o" });
  });

  it("REFUSES the ledger's verbatim DW-217 reproduction against the real store", async () => {
    // THE REPRODUCTION AS THE LEDGER STATES IT, end to end against the actual
    // config store rather than a mocked one — the point being that the answer is
    // observed at the RESOLVER surface, where the damage used to show up.
    //
    // `onWorkers()` binds `AI`, so the refusal is about the MODEL leg alone; off
    // the runtime the binding leg would join the sentence and hide the leg this
    // case is about.
    onWorkers();
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ embeddingModel: "text-embedding-3-small" }));

    // Before DW-217 this answered 200, wrote the mismatch, and left the stored
    // switch reading ON while `getVectorSearchSettings()` had gone to `false`.
    expect(response.status).toBe(400);
    // A FLAT-only body, so the route scopes it — and a scoped refusal carries
    // the flat frame (DW-329).
    expect(((await response.json()) as { error: string }).error).toBe(
      UNSUPPORTED_WORKERS_MODEL_INACTIVE_FLAT,
    );
    // Nothing landed, so the store still holds the id it held…
    expect(await stored()).toMatchObject({ embeddingModel: "@cf/baai/bge-m3" });
    // …and the switch still means what it says.
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);
  });

  it("REFUSES a FLAT-ONLY body that moves a vector input past the gate (DW-217)", async () => {
    // This used to be a CHARACTERIZATION of the hole. The case above passed only
    // because its body also carried `workbench`, which is what made the route
    // enter the validated branch at all; a body with NO `workbench` key skipped
    // the gate entirely, so a flat-only save could switch effective vector
    // search off while the stored flag went on reading as on.
    //
    // DW-217 closes it by running the ONE rule over the post-legacy-merge config
    // on both paths — an empty `{}` patch when `workbench` is absent — which is
    // why the sentence below is byte-identical to the one the nested case above
    // answers with. `applyWorkbenchSettings` is still conditional on the key, so
    // "a body with no `workbench` produces byte-identically the same saved
    // object" stays true for every body that PASSES.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingApiKey: "sk-embed",
      embeddingModel: "text-embedding-3-small",
    });
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ embeddingModel: "@cf/baai/bge-m3" }));

    expect(response.status).toBe(400);
    // …byte-identical to the nested case above EXCEPT for the action clause:
    // no `workbench` key means the route scoped it, and a scoped refusal is
    // read on the page with no vector switch (DW-329).
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search is switched on, but it needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    );
    // Refused BEFORE `saveConfig`: the store still holds what it held.
    expect(await stored()).toMatchObject({
      embeddingModel: "text-embedding-3-small",
    });
    // …so the stored flag and the effective accessor still agree.
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);
  });

  it("still lets a flat-only body through when it moves no vector input (DW-219)", async () => {
    // The gate re-runs on the flat path, but only for a request that MOVES
    // something the rule reads. A deployment already storing a mismatch must
    // still be able to edit its chat model.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(await put({ model: "gpt-4o" }));

    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({
      model: "gpt-4o",
      embeddingModel: "text-embedding-3-small",
    });
  });

  it("picks the refusal's FRAME from the STORED flag, on both paths (DW-308)", async () => {
    // End to end against the real store, because the frame is chosen from the
    // config as it was READ — and on the flat-legacy path the object the patch
    // merges onto has already had the flat field folded into it. Only the third
    // argument still holds the pre-request flag, so a route that passed the
    // merge target for both would answer the wrong frame here.
    //
    // Off the Workers runtime the binding leg joins the sentence, which is what
    // makes this case pin the NOTES surviving the reframe as well.
    const { PUT } = await import("@/app/api/settings/route");

    // Stored OFF, and the request asks to turn it on: "before it can be turned
    // on" is exactly what it is being told.
    await store({ embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" });
    const turningOn = await PUT(await put({ workbench: { vectorSearchEnabled: true } }));
    expect(turningOn.status).toBe(400);
    expect(((await turningOn.json()) as { error: string }).error).toBe(
      `Vector search needs the Cloudflare AI binding before it can be turned on. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // The WHOLE stored object, not `not.toMatchObject({ vectorSearchEnabled:
    // true })`: that assertion passes just as happily when the key is absent —
    // which is the state this store starts in — so it could never have observed
    // the write it is guarding. Equality pins the flag as still unwritten AND
    // that nothing else landed either.
    expect(await stored()).toEqual({
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });

    // Stored ON, and a FLAT legacy field moves a leg into an unmet state: the
    // save bar would land the sentence beside a box the payload still ticks.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    const alreadyOn = await PUT(await put({ embeddingProvider: "workers-ai" }));
    expect(alreadyOn.status).toBe(400);
    // Two legs and a note, in leg order — the reframe changes the sentence they
    // are wrapped in and nothing about the legs themselves.
    expect(((await alreadyOn.json()) as { error: string }).error).toBe(
      `Vector search is switched on, but it needs ${UNSUPPORTED_WORKERS_MODEL_LIST} and the Cloudflare AI binding before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // Nothing written either way — the frame is the only thing that changed.
    expect(await stored()).toMatchObject({ embeddingProvider: "ollama" });
  });
});

// ---------------------------------------------------------------------------
// The resolvers Epics 2 and 3 will read
// ---------------------------------------------------------------------------

describe("the workload resolvers", () => {
  it("inherits the primary provider and model when the workload is unset", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    await store({ provider: "openai", model: "gpt-4o" });
    for (const settings of [getChatModelSettings(), getIngestModelSettings()]) {
      expect(settings).toMatchObject({
        provider: "openai",
        model: "gpt-4o",
        usesPrimary: true,
      });
    }
  });

  it("resolves each workload independently of the other and of the primary", async () => {
    process.env.OPENAI_API_KEY = "sk-openai";
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    await store({
      provider: "openai",
      model: "gpt-4o",
      chatProvider: "anthropic",
      chatModel: "claude-sonnet-4-20250514",
    });
    expect(getChatModelSettings()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      configured: true,
      usesPrimary: false,
    });
    // Ingest was not touched, so it still inherits.
    expect(getIngestModelSettings()).toMatchObject({
      provider: "openai",
      model: "gpt-4o",
      usesPrimary: true,
    });
  });

  it("falls to the provider's default model when only the provider is chosen", async () => {
    process.env.ANTHROPIC_API_KEY = "sk-anthropic";
    await store({ ingestProvider: "anthropic" });
    expect(getIngestModelSettings()).toMatchObject({
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      modelSource: "default",
      usesPrimary: false,
    });
  });

  it("reports `custom` as configured only with BOTH a key and a base URL", async () => {
    await store({ chatProvider: "custom", chatModel: "my-model", customApiKey: "sk-1" });
    expect(getChatModelSettings().configured).toBe(false);
    await store({
      chatProvider: "custom",
      chatModel: "my-model",
      customApiKey: "sk-1",
      customBaseUrl: "https://api.example/v1",
    });
    expect(getChatModelSettings().configured).toBe(true);
  });

  it("keeps the LLM timeout unset by default and converts seconds to ms", async () => {
    expect(getLlmTimeoutMs()).toBeNull();
    await store({ llmTimeoutSeconds: 60 });
    expect(getLlmTimeoutMs()).toBe(60_000);
  });

  it("reads Firecrawl back as a base URL and a presence boolean", async () => {
    await store({ firecrawlBaseUrl: "https://fc.example", firecrawlApiKey: "fc-1" });
    expect(getFirecrawlSettings()).toEqual({
      baseUrl: "https://fc.example",
      hasKey: true,
    });
    // The resolver reports presence; it does not hand the key back.
    expect(JSON.stringify(getWorkbenchSettings(false))).not.toContain("fc-1");
  });

  it("refuses to report a hand-forced vector switch as on", async () => {
    // Bytes can reach the config file without passing the route. The predicate
    // is applied on READ too, so the gate holds either way.
    await store({ vectorSearchEnabled: true });
    expect(getVectorSearchSettings().enabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Source scans — the wiring a node suite cannot execute
// ---------------------------------------------------------------------------

describe("the Settings components stay inside the shell", () => {
  it("routes every request through the one client, with no fetch and no URL of its own", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // Zero `fetch(` in the component: the request lives in the pure module,
    // where a stubbed `fetchImpl` runs it. A second write path beside `save`
    // would have to start with one of these.
    expect(canvas).not.toMatch(/[^a-zA-Z]fetch\(/);
    expect(canvas).not.toContain('"/api/');
    expect(canvas.match(/saveWorkbenchSettings\(/g) ?? []).toHaveLength(1);
    expect(canvas.match(/fetchWorkbenchSettings\(/g) ?? []).toHaveLength(1);
    expect(canvas).toContain("AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
    // The read's deadline carries its own reason, so a blown deadline clears
    // `loading` and shows the failure sentence while an unmount stays silent.
    expect(canvas).toContain("controller.abort(SETTINGS_TIMEOUT_REASON)");
    expect(canvas).toContain('if (result.status === "stale") return;');
  });

  it("force-shows the left column from CSS, not by rewriting the preference", async () => {
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    expect(css).toContain(
      '.wb-shell[data-collapsed="true"][data-settings="true"] .wb-left {',
    );
    // …and the narrow breakpoint names the two-attribute selector explicitly,
    // because it outranks the single-attribute rules there by specificity.
    const narrow = css.slice(css.indexOf("@media (max-width: 899px)"));
    expect(narrow).toContain('.wb-shell[data-collapsed="true"][data-settings="true"] {');

    // Specificity is a TIE between those two rules (0,3,0 each — a media query
    // adds none), so the later one wins outright and the stacked layout below
    // 900px would lose to the desktop template that follows it. Each column
    // template therefore has to be scoped to the width it was written for.
    const columnRules = [
      ...css.matchAll(
        /\.wb-shell\[data-collapsed="true"\]\[data-settings="true"\] \{\s*grid-template-columns:/g,
      ),
    ].map((match) => match.index ?? -1);
    expect(columnRules.length).toBeGreaterThan(0);
    for (const at of columnRules) {
      const preceding = css.slice(css.lastIndexOf("@media", at), at);
      const query = preceding.slice(0, preceding.indexOf("\n"));
      // Every column template for this selector is inside one of the two
      // complementary width queries — never a bare rule that could outrank the
      // other by source order alone.
      expect(query).toMatch(/@media \((min-width: 900px|max-width: 899px)\)/);
      expect(preceding).not.toContain("\n}\n");
    }
  });

  it("describes every control whose constraint is not in its label", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // A range printed beside a box and a disabled reason printed beside a
    // checkbox are both invisible to a screen reader — and so is "a key is
    // stored", which for a password field showing nothing IS the state, and so
    // is "leave the provider unset to inherit", which is what the blank option
    // in the picker means.
    // The text rows route their OWN hint through `describedBy` too (DW-280):
    // the ternary picks whether this row has a hint at all, and `describedBy`
    // decides what a read-only deployment adds to it — including for the rows
    // that have no hint, where the read-only sentence becomes the whole
    // description rather than being dropped for want of something to append to.
    expect(canvas).toContain(
      'aria-describedby={describedBy(hint ? hintId : undefined)}',
    );
    expect(canvas).toContain(
      'aria-describedby={describedBy(field("vectorSearchEnabled-hint"))}',
    );
    expect(canvas).toContain('id={field("vectorSearchEnabled-hint")}');
    // Every control a read-only deployment refuses routes its description
    // through `describedBy`, which APPENDS the save bar's read-only sentence to
    // the control's own hint — `aria-describedby` takes a space-separated list,
    // so the hint is kept rather than replaced. Five call sites now: the two
    // pickers, the vector switch, `textRow` (seven rows) and `secretRow` (the
    // three API-key rows, DW-307).
    expect(canvas.match(/aria-describedby=\{describedBy\(/g)).toHaveLength(5);
    expect(canvas).toContain('const readOnlyNoteId = field("bar-note");');
    expect(canvas).toContain('<span className="wb-set-bar-note" id={readOnlyNoteId}>');
    // Each row builder wires its own hint; none of them renders a bare span.
    const hintSpans = [...canvas.matchAll(/<span className="wb-set-hint"/g)];
    const identified = [...canvas.matchAll(/<span className="wb-set-hint" id=/g)];
    expect(identified.length).toBe(hintSpans.length);
    // NO bare `hintId` left. The secret row was the last one, exempted on the
    // reasoning that a read-only deployment renders it `readOnly` rather than
    // `aria-disabled` so it has "no refusal to announce" — which was never true
    // (DW-307): `readOnly` announces a property of the BOX and says nothing
    // about the deployment, and the row's only other affordance, the Remove
    // button, is removed outright under `stored.readOnly`. Both it and the
    // provider picker now match the `describedBy(hintId)` form below.
    expect(canvas.match(/aria-describedby=\{hintId\}/g)?.length ?? 0).toBe(0);
    expect(canvas).toContain("aria-describedby={describedBy(hintId)}");
  });

  it("refuses a write with aria-disabled and a restoring handler, never `disabled` (DW-37)", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // `disabled` takes a control OUT of the tab order, so a keyboard user on a
    // read-only deployment could not reach the provider pickers at all — could
    // not read which provider is stored, and never heard the hint that is wired
    // as the vector switch's own description. Every refused control therefore
    // carries `aria-disabled` instead. A node suite cannot mount this, so the
    // wiring is pinned as source.
    // The negative lookbehind is what makes these real: `aria-disabled={…}`
    // CONTAINS `disabled={…}`, so a plain substring check would pass on the very
    // attribute it is meant to forbid.
    expect(canvas).not.toMatch(/(?<![-\w])disabled=\{stored\.readOnly/);
    expect(canvas).not.toMatch(/(?<![-\w])disabled=\{vectorRefused/);
    // The ONLY `disabled` left in the component is Save's — which is a
    // deliberate exception, because `SETTINGS_READ_ONLY_COPY` already ships
    // beside it and says why.
    const disabledProps = [...canvas.matchAll(/(?<![-\w])disabled=\{/g)];
    expect(disabledProps).toHaveLength(1);
    expect(canvas).toContain("disabled={saving || payload.readOnly || !dirty}");

    // Both provider pickers and the vector switch, each with the attribute…
    expect(canvas.match(/aria-disabled=\{stored\.readOnly \|\| undefined\}/g)).toHaveLength(
      2,
    );
    expect(canvas).toContain("aria-disabled={vectorRefused || undefined}");
    // …and each with a handler that COMMITS NOTHING when the control is
    // refused. That early return is the whole refusal: React re-applies a
    // controlled value to the DOM after a change event that set no state, so no
    // control needs putting back by hand. `settings-read-only.test.tsx` is what
    // observes the result — this only pins that the handler still guards.
    expect(canvas).not.toContain("event.currentTarget");
    expect(canvas).toContain("if (stored.readOnly) return;");
    expect(canvas).toContain("if (vectorRefused) return;");
    // The checkbox refuses on its WHOLE predicate — read-only and
    // provider-unsupported alike — named once so the attribute that announces
    // the refusal and the handler that enforces it cannot drift apart.
    expect(canvas).toMatch(
      /const vectorRefused =\s*\n?\s*stored\.readOnly \|\| \(!vectorAllowed && !values\.vectorSearchEnabled\);/,
    );
  });

  it("gives the aria-disabled faces a rule, and takes them off the hover face", async () => {
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    // A control that refuses every activation must not light up on hover or show
    // a pointer cursor — and `aria-disabled` gets none of the browser's own
    // disabled treatment, so the stylesheet has to supply it.
    expect(css).toMatch(/\.wb-set-select\[aria-disabled="true"\] \{[^}]*cursor: default;/);
    expect(css).toMatch(
      /\.wb-set-check input\[aria-disabled="true"\] \{[^}]*cursor: default;/,
    );
    // The switcher's controls keep `disabled` for the transient `switching`
    // state, so the hover rule has to exclude BOTH.
    expect(css).toContain(
      '.wb-wiki-switch-action:hover:not([disabled]):not([aria-disabled="true"])',
    );
    expect(css).toContain('.wb-wiki-switch-new:hover:not([aria-disabled="true"])');
    expect(css).toMatch(
      /\.wb-wiki-switch-action\[aria-disabled="true"\] \{[^}]*cursor: default;/,
    );
  });

  it("labels the embedding provider that is not an LLM provider", async () => {
    // `workers-ai` embeds but does not generate, so it is absent from
    // PROVIDER_INFO and `providerLabel` would put the raw slug in the picker
    // beside "OpenAI" and "Google".
    expect(embeddingProviderLabel("workers-ai")).toBe("Cloudflare Workers AI");
    expect(embeddingProviderLabel("openai")).toBe("OpenAI");
    for (const provider of EMBEDDING_PROVIDERS) {
      expect(embeddingProviderLabel(provider)).not.toBe(provider);
    }
    const canvas = await readComponent("SettingsCanvas.tsx");
    expect(canvas).toContain("embeddingProviderLabel(option)");
  });

  it("gives workers-ai ONE name across the picker and every vector refusal (DW-222)", async () => {
    // The picker renders `embeddingProviderLabel(option)` and the refusal sits
    // two rows below it, so a hand-typed short name described one selection
    // under two names on one screen. This sweeps every refusal the gate can
    // produce rather than checking the four strings that were wrong once: a
    // literal-by-literal rename passes again the next time someone types it.
    const label = embeddingProviderLabel("workers-ai");
    // The name itself, pinned. Without this the whole sweep survives deleting
    // `embeddingProviderLabel`'s `workers-ai` branch: the label would fall back
    // to the raw slug, every copy would name the provider "workers-ai", and
    // every assertion below would still hold.
    expect(label).toBe("Cloudflare Workers AI");
    const providers = [null, "", "not-a-provider", ...EMBEDDING_PROVIDERS];
    const models = [
      null,
      "@cf/baai/bge-m3",
      "@cf/llava-hf/llava-1.5-7b-hf",
      "text-embedding-3-small",
    ];
    const produced: string[] = [];
    for (const provider of providers) {
      for (const baseUrl of [null, "https://embeddings.example"]) {
        for (const model of models) {
          for (const hasKey of [false, true]) {
            for (const modelOrigin of ["stored", "env"] as const) {
              for (const providerOrigin of ["stored", "env"] as const) {
                for (const hasWorkersAiBinding of [null, false, true]) {
                  const inputs: VectorSearchInputs = {
                    provider,
                    baseUrl,
                    model,
                    hasKey,
                    modelOrigin,
                    providerOrigin,
                    hasWorkersAiBinding,
                  };
                  const copies = [
                    vectorSearchMissingCopy(inputs),
                    vectorSearchInactiveCopy(inputs),
                    // The THIRD copy producer on the same screen: the per-control
                    // sentence each row carries. It composes the same legs, so a
                    // name typed into one would surface here too.
                    ...(["provider", "endpoint", "model", "key"] as const).map(
                      (control) => vectorSearchFieldIssue(inputs, control)?.copy ?? "",
                    ),
                  ];
                  for (const copy of copies) {
                    if (!copy) continue;
                    produced.push(copy);
                    // Whatever is left once the picker's own name is removed
                    // must not still be naming the provider — in any spelling,
                    // so the slug and the short name are both caught.
                    expect(copy.replaceAll(label, "«provider»")).not.toMatch(
                      /workers[\s-]?ai/i,
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    // A sweep that stopped producing the provider-naming refusals would pass
    // while proving nothing, so each phrase family that CAN name the provider is
    // pinned as actually reached.
    const reached = (needle: string) => produced.some((copy) => copy.includes(needle));
    expect(
      reached(
        `a supported ${label} model id (${WORKERS_AI_EMBEDDING_MODEL_IDS.join(", ")})`,
      ),
    ).toBe(true);
    expect(reached(`a model id outside the ${label} ${WORKERS_AI_MODEL_PREFIX} namespace`)).toBe(
      true,
    );
    expect(reached(SETTINGS_VECTOR_BINDING_NOTE)).toBe(true);
    expect(reached(SETTINGS_VECTOR_BINDING_ENV_NOTE)).toBe(true);
    // The sweep above can only catch the SHORT name. Hand-typing the full name
    // would produce copy identical to the derived copy and slip through, so the
    // module source is scanned too: the name may only ever arrive through
    // `WORKERS_AI_LABEL`, which is what makes the picker its single source.
    const source = await readFile(path.join(SRC, "lib/workbench-settings.ts"), "utf8");
    expect(source).not.toContain(label);
    expect(source).toContain('const WORKERS_AI_LABEL = embeddingProviderLabel("workers-ai")');
    // The notes are reached by the sweep as leg notes; what the shape check adds
    // is that each one OPENS with the derived name, which is the position the
    // hand-typed short name occupied.
    for (const note of [SETTINGS_VECTOR_BINDING_NOTE, SETTINGS_VECTOR_BINDING_ENV_NOTE]) {
      expect(note.startsWith(`${label} embeds through the Cloudflare AI binding`)).toBe(
        true,
      );
    }
  });

  it("keeps DEPLOY.md's quoted refusal identical to the constant it quotes (DW-222)", async () => {
    // `DEPLOY.md` block-quotes SETTINGS_VECTOR_BINDING_ENV_NOTE so an operator
    // can compare the doc to the screen. Nothing but memory joined the two, which
    // is how the doc came to quote a sentence the surface had stopped showing.
    // The quote is hard-wrapped, so it is un-wrapped before comparing: what must
    // match is the SENTENCE, not the line breaks the markdown happens to use.
    const doc = await readFile(path.resolve(SRC, "..", "DEPLOY.md"), "utf8");
    const blocks: string[] = [];
    let current: string[] = [];
    for (const line of doc.split("\n")) {
      if (line.startsWith(">")) {
        current.push(line.replace(/^>\s?/, ""));
      } else if (current.length > 0) {
        blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
        current = [];
      }
    }
    if (current.length > 0) blocks.push(current.join(" ").replace(/\s+/g, " ").trim());
    expect(blocks.some((block) => block.includes(SETTINGS_VECTOR_BINDING_ENV_NOTE))).toBe(
      true,
    );
  });

  it("clears a stale refusal as soon as the owner edits anything", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // The refusal described the values that were SENT, so leaving it beside Save
    // would have the owner reading "needs an API key" while typing one.
    expect(canvas).toMatch(/setStatus\(""\);[\s\S]{0,300}setSaveError\(null\);/);
  });

  it("keeps the shell router-free and the draft out of durable storage", async () => {
    for (const file of ["SettingsCanvas.tsx", "SettingsNav.tsx"]) {
      const source = await readComponent(file);
      expect(source).not.toMatch(/\buseRouter\(/);
      expect(source).not.toMatch(/from "next\/link"/);
      expect(source).not.toContain("router.push(");
      // A reload must not land the owner in Settings, and an unsaved edit must
      // not survive the unmount that discards it.
      expect(source).not.toContain("localStorage");
      expect(source).not.toContain("writeStored");
      // The type lock: chrome is sans, and Georgia is the Preview BODY's face.
      expect(source.replaceAll("sans-serif", "")).not.toContain("serif");
      expect(source).not.toContain("Georgia");
    }
  });

  it("takes the canvas id from ModeCanvas rather than restating it", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    expect(canvas).toContain('import { CANVAS_ID } from "./ModeCanvas"');
    expect(canvas).toContain("id={CANVAS_ID}");
    expect(canvas).toContain("tabIndex={-1}");
    // BOTH canvases mount while Settings is open (DW-373) and exactly one is
    // SHOWING, which is what keeps the skip link pointing at one target: the
    // mode canvas renders unconditionally and drops the id behind `hidden`,
    // and Settings is the conditional one — its unmount on close is the whole
    // of "unsaved edits are discarded on leave".
    //
    // Pinned as the two shapes rather than as the old `"{settingsOpen ? ("`
    // substring: that assertion read as "one canvas at a time" but would have
    // gone on passing against the left column's own ternary further up the
    // file, which is to say it pinned nothing here at all.
    const shell = await readComponent("Workbench.tsx");
    // Each element is read as its own slice — its tag through the `>` that
    // closes the opening tag — so what follows pins WHAT is passed rather than
    // the order the props happen to sit in or the column the formatter wrapped
    // them at. A case named for the canvas id must not fail on a rewrap.
    const opening = (tag: string) => {
      const start = shell.indexOf(`<${tag}`);
      expect(start).toBeGreaterThan(-1);
      return shell.slice(start, shell.indexOf(">", start) + 1);
    };
    // Settings is the CONDITIONAL one: its unmount on close is the discard.
    expect(shell).toContain("{settingsOpen && (");
    expect(opening("SettingsCanvas")).toContain("category={settingsCategoryId}");
    expect(opening("SettingsCanvas")).toContain("headingId={settingsHeadingId}");
    // The mode canvas is the unconditional one, withdrawn by the same flag.
    expect(opening("ModeCanvas")).toContain("headingId={headingId}");
    expect(opening("ModeCanvas")).toContain("hidden={settingsOpen}");
    // …and Settings comes FIRST in the JSX, which is not cosmetic: several
    // suites read `document.querySelector(".wb-canvas")` to mean "the canvas the
    // owner is looking at", and that is only true while the showing one leads in
    // document order. Swapping the two blocks changes nothing else at all, so
    // without this line nothing at all would notice.
    expect(shell.indexOf("<SettingsCanvas")).toBeLessThan(shell.indexOf("<ModeCanvas"));
    // Two heading ids, because both canvases render an `<h2 id=…>` and one
    // `useId` between them would be a duplicate id the moment Settings opened
    // over a non-Wiki mode.
    expect(shell).toContain("const settingsHeadingId = useId();");
  });

  it("makes the shell own which surface is showing, and undocks the Preview", async () => {
    const shell = await readComponent("Workbench.tsx");
    expect(shell).toContain("const [settingsOpen, setSettingsOpen] = useState(false)");
    expect(shell).toContain("setSettingsOpen(false)");
    expect(shell).toContain("settingsAnnouncement(");
    expect(shell).toContain("<SettingsNav");
    // The rail control marks itself current while Settings shows, so it has to
    // be able to turn back off — and closing announces the surface the owner
    // lands on, the way `selectMode` does.
    expect(shell).toContain("if (settingsOpen) {");
    expect(shell).toContain("announce(workbenchMode(mode).label)");
    expect(shell).toContain("onToggleSettings={toggleSettings}");
    // A collapsed left column would hide the settings nav entirely, and
    // `collapsed` is durable — so the shell reports the surface and CSS
    // force-shows the column, without rewriting the stored preference.
    expect(shell).toContain('data-settings={settingsOpen ? "true" : "false"}');
    expect(shell).not.toContain("setCollapsed(false)");
    // A docked Preview beside a Settings detail column would describe a tree row
    // that is not on screen.
    expect(shell).toContain("shouldDockPreview(mode, selection) && !settingsOpen");
    // Still `useState` on ONE shell, exactly as a mode switch is.
    expect(shell).not.toMatch(/\buseRouter\(/);
    expect(shell).not.toMatch(/from "next\/link"/);
    // The category is not persisted — `workbench-state.ts`'s durable set is
    // mode, tab, selection, collapse and widths.
    expect(shell).not.toContain("writeStoredSettings");
  });

  it("labels the settings nav and marks the open category", async () => {
    const nav = await readComponent("SettingsNav.tsx");
    expect(nav).toContain('aria-label="Settings categories"');
    expect(nav).toContain("<nav");
    expect(nav).toContain('aria-current={active ? "page" : undefined}');
    // The vocabulary is the shared module's; a list typed here would be a fork.
    expect(nav).toContain("SETTINGS_CATEGORIES.map");
  });

  it("names the settings route in exactly one place", async () => {
    const module_ = await readFile(path.join(SRC, "lib/workbench-settings.ts"), "utf8");
    expect(module_).toContain('export const SETTINGS_ROUTE = "/api/settings"');
    // Pure and client-safe: no Node built-in may appear here, or the module
    // cannot be imported by both the browser bundle and this suite.
    expect(module_).not.toMatch(/from "node:/);
    expect(module_).not.toMatch(/from "(fs|path|os)"/);
    expect(module_).not.toContain("./storage");
    expect(module_).not.toContain("./config");
  });

  it("renders no API key value anywhere in the surface", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // The only key-shaped identifiers in the component are the DRAFT field
    // names, and the input's value is the draft — never a served value, because
    // the payload carries none.
    expect(canvas).toContain('type="password"');
    expect(canvas).not.toContain("payload.customApiKey");
    expect(canvas).not.toContain("payload.embeddingApiKey");
    expect(canvas).not.toContain("payload.firecrawlApiKey");
    expect(canvas).not.toContain("stored.customApiKey");
    expect(canvas).not.toContain("stored.embeddingApiKey");
    expect(canvas).not.toContain("stored.firecrawlApiKey");
  });

  it("offers Language as English with no picker anywhere", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    expect(canvas).toContain("SETTINGS_LANGUAGE_LABEL");
    expect(canvas).toContain("{stored.language}");
    expect(SETTINGS_LANGUAGE_VALUE).toBe("English");
    // No second locale is named, and no locale control exists.
    expect(canvas).not.toContain("zh-CN");
    expect(canvas).not.toContain("InterfaceLocale");
  });

  it("gives every class it applies a rule in the stylesheet", async () => {
    // A class applied and never defined is a rule somebody deleted and a
    // component that still asks for it.
    const css = await readFile(path.join(SRC, "app/globals.css"), "utf8");
    const sources = [
      await readComponent("SettingsCanvas.tsx"),
      await readComponent("SettingsNav.tsx"),
    ].join("\n");
    const applied = new Set(
      [...sources.matchAll(/\bwb-set-[a-z-]+/g)].map((match) => match[0]),
    );
    expect(applied.size).toBeGreaterThan(0);
    for (const name of applied) {
      expect({ name, defined: css.includes(`.${name}`) }).toEqual({ name, defined: true });
    }
  });

  it("keeps Settings out of the rail's mode list", async () => {
    const modes = await readFile(path.join(SRC, "lib/workbench-modes.ts"), "utf8");
    // Settings is a surface, not a mode: `workbench-modes.test.ts` pins the ten.
    expect(modes).not.toContain('id: "settings"');
  });
});

// ---------------------------------------------------------------------------
// Clear on switch — the embedding provider's secret isolation (DW-69/DW-72)
// ---------------------------------------------------------------------------

describe("embeddingProviderChanged", () => {
  it("answers on the VALUE, so the every-save re-send is not a move", () => {
    // `settingsSaveBody` sends `embeddingProvider` on EVERY save, so a presence
    // test would read a timeout edit as a vendor switch and delete the owner's
    // key. This is the one definition of "switched", and it compares values.
    expect(embeddingProviderChanged("openai", "openai")).toBe(false);
    expect(embeddingProviderChanged("openai", "google")).toBe(true);
  });

  it("reads the auto-detect rung as a real move in both directions", () => {
    // Clearing the select is a change of effective vendor — the resolver may
    // now land somewhere else entirely — so the old vendor's pair goes with it.
    expect(embeddingProviderChanged("openai", null)).toBe(true);
    expect(embeddingProviderChanged(null, "openai")).toBe(true);
    expect(embeddingProviderChanged(null, null)).toBe(false);
  });

  it("normalises whitespace on both sides before comparing", () => {
    // A padded value and a clean one are the same vendor; a whitespace-only box
    // and an empty one are both "nothing selected". Without this a stray space
    // in a stored value would clear a key on the next unrelated save.
    expect(embeddingProviderChanged(" openai ", "openai")).toBe(false);
    expect(embeddingProviderChanged("   ", null)).toBe(false);
    expect(embeddingProviderChanged("", "openai")).toBe(true);
  });
});

describe("settingsDraftAfterEmbeddingProvider", () => {
  /** A deployment storing OpenAI's endpoint and OpenAI's key. */
  const OPENAI_PAYLOAD: WorkbenchSettingsPayload = {
    ...emptyPayload(),
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: "https://o/v1",
    hasEmbeddingApiKey: true,
  };

  /** A draft seeded from that deployment. */
  function openaiDraft() {
    return settingsDraftFromPayload(OPENAI_PAYLOAD);
  }

  it("blanks the endpoint and un-touches the key when the vendor moves", () => {
    const next = settingsDraftAfterEmbeddingProvider(openaiDraft(), "google", OPENAI_PAYLOAD);
    expect(next.embeddingProvider).toBe("google");
    // The endpoint box empties, so `settingsSaveBody` sends `null` rather than
    // writing OpenAI's URL back into the store the clear just emptied.
    expect(next.embeddingBaseUrl).toBe("");
    // UNTOUCHED, not `null`: `null` is "Remove", and the owner pressed nothing.
    // The stored key is dropped by the STORE, not by a pretend Remove.
    expect(next.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    // Nothing else moves — the model is not a credential and not vendor-bound
    // in the way the endpoint and the key are.
    expect(next.embeddingModel).toBe("text-embedding-3-small");
  });

  it("leaves both boxes alone when the same provider is re-selected", () => {
    const next = settingsDraftAfterEmbeddingProvider(openaiDraft(), "openai", OPENAI_PAYLOAD);
    expect(next.embeddingBaseUrl).toBe("https://o/v1");
    expect(next.embeddingApiKey).toBe(SECRET_UNTOUCHED);
  });

  it("clears on the way to auto-detect too", () => {
    const next = settingsDraftAfterEmbeddingProvider(openaiDraft(), "", OPENAI_PAYLOAD);
    expect(next.embeddingProvider).toBe("");
    expect(next.embeddingBaseUrl).toBe("");
  });

  it("discards a key TYPED for the vendor being left behind", () => {
    // The reset is not decoration. A credential typed into the box belongs to
    // the vendor that was selected while it was typed — carrying it across the
    // switch would send the new vendor a secret meant for the old one, which is
    // the very leak the store-side clear exists to prevent.
    const typed = { ...openaiDraft(), embeddingApiKey: "sk-typed-for-openai" };
    const next = settingsDraftAfterEmbeddingProvider(typed, "google", OPENAI_PAYLOAD);
    expect(next.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    // …and so nothing rides in the save body for the new vendor.
    expect(settingsSaveBody(next).embeddingApiKey).toBeUndefined();
  });

  it("cancels a PENDING REMOVE, which was about the previous vendor's key", () => {
    // `null` is "Remove". Left in place across a switch it would ride as
    // `embeddingApiKey: null` and delete whatever the new vendor's clear had
    // just left behind — and it would strand the row in its removal-pending
    // state with no `Remove`/`Undo` button to leave it, since that button is
    // gated on the key still counting for the selected vendor.
    const removing = { ...openaiDraft(), embeddingApiKey: null };
    const next = settingsDraftAfterEmbeddingProvider(removing, "google", OPENAI_PAYLOAD);
    expect(next.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    expect(settingsSaveBody(next).embeddingApiKey).toBeUndefined();
  });

  it("RESTORES the stored endpoint on a switch away and BACK within one draft", () => {
    // The draft nets back to the STORED vendor, whose endpoint and key the
    // store never moved away from. Leaving the box blank would send
    // `embeddingBaseUrl: null` on the next save and DELETE a stored endpoint
    // for a provider that never net-moved — breaking the promise that a save
    // which does not move the stored value preserves both fields.
    const there = settingsDraftAfterEmbeddingProvider(openaiDraft(), "google", OPENAI_PAYLOAD);
    expect(there.embeddingBaseUrl).toBe("");
    const back = settingsDraftAfterEmbeddingProvider(there, "openai", OPENAI_PAYLOAD);
    expect(back.embeddingProvider).toBe("openai");
    expect(back.embeddingBaseUrl).toBe("https://o/v1");
    expect(back.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    // What the save actually carries: the stored endpoint back verbatim, and no
    // key at all — so `applyWorkbenchSettings` sees no move and preserves both.
    expect(settingsSaveBody(back).embeddingBaseUrl).toBe("https://o/v1");
    expect(settingsSaveBody(back).embeddingApiKey).toBeUndefined();
    // The whole draft is back where a reload would put it — the endpoint half is
    // now symmetric with the key half, which already reported the stored key
    // again through `draftEmbeddingKeyStored`.
    expect(settingsDirty(back, OPENAI_PAYLOAD)).toBe(false);
    expect(draftEmbeddingKeyStored(back, OPENAI_PAYLOAD)).toBe(true);
  });

  it("drops an endpoint typed for the vendor being left, even on the way back", () => {
    // Restoring means restoring the STORE's value, not keeping whatever the
    // owner typed while another vendor was selected.
    const there = settingsDraftAfterEmbeddingProvider(openaiDraft(), "google", OPENAI_PAYLOAD);
    const typed = { ...there, embeddingBaseUrl: "https://g/v1" };
    const back = settingsDraftAfterEmbeddingProvider(typed, "openai", OPENAI_PAYLOAD);
    expect(back.embeddingBaseUrl).toBe("https://o/v1");
  });

  it("restores an EMPTY endpoint when the store holds none", () => {
    const noEndpoint: WorkbenchSettingsPayload = {
      ...OPENAI_PAYLOAD,
      embeddingBaseUrl: null,
    };
    const draft = settingsDraftFromPayload(noEndpoint);
    const there = settingsDraftAfterEmbeddingProvider(draft, "google", noEndpoint);
    const back = settingsDraftAfterEmbeddingProvider(there, "openai", noEndpoint);
    expect(back.embeddingBaseUrl).toBe("");
  });

  it("does not restore for a vendor the STORE is not on", () => {
    // Three answers, not two: only a return to the payload's own provider
    // restores. Hopping between two other vendors keeps blanking.
    const google = settingsDraftAfterEmbeddingProvider(openaiDraft(), "google", OPENAI_PAYLOAD);
    const withUrl = { ...google, embeddingBaseUrl: "https://g/v1" };
    const ollama = settingsDraftAfterEmbeddingProvider(withUrl, "ollama", OPENAI_PAYLOAD);
    expect(ollama.embeddingBaseUrl).toBe("");
  });

  it("does not mutate the draft it was handed", () => {
    const draft = openaiDraft();
    settingsDraftAfterEmbeddingProvider(draft, "google", OPENAI_PAYLOAD);
    expect(draft.embeddingProvider).toBe("openai");
    expect(draft.embeddingBaseUrl).toBe("https://o/v1");
  });
});

describe("draftEmbeddingKeyStored", () => {
  const stored: WorkbenchSettingsPayload = {
    ...emptyPayload(),
    embeddingProvider: "openai",
    embeddingBaseUrl: "https://o/v1",
    hasEmbeddingApiKey: true,
  };

  it("reports the stored key for the vendor the draft still selects", () => {
    expect(draftEmbeddingKeyStored(settingsDraftFromPayload(stored), stored)).toBe(true);
  });

  it("stops reporting it the moment the draft selects another vendor", () => {
    // The misreport DW-69 names: "A key is stored." beside a `Remove` button,
    // for a credential the very next save deletes.
    const moved = settingsDraftAfterEmbeddingProvider(
      settingsDraftFromPayload(stored),
      "google",
      stored,
    );
    expect(draftEmbeddingKeyStored(moved, stored)).toBe(false);
    // Auto-detect is a move too.
    const cleared = settingsDraftAfterEmbeddingProvider(
      settingsDraftFromPayload(stored),
      "",
      stored,
    );
    expect(draftEmbeddingKeyStored(cleared, stored)).toBe(false);
  });

  it("never invents a key the store does not hold", () => {
    const none: WorkbenchSettingsPayload = { ...stored, hasEmbeddingApiKey: false };
    expect(draftEmbeddingKeyStored(settingsDraftFromPayload(none), none)).toBe(false);
  });
});

describe("the payload after a provider switch, over the REAL store (DW-69/DW-72)", () => {
  it("answers a payload that reports the cleared state", async () => {
    // END TO END, against the real config file: the store holds OpenAI's
    // endpoint and OpenAI's key, and one `PUT` moves the vendor.
    await store({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      embeddingApiKey: "sk-o",
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      await put({ workbench: { embeddingProvider: "google" } }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workbench: WorkbenchSettingsPayload };
    // THE HALF THE OWNER SEES. The canvas re-seeds its draft from this object,
    // so a payload still reporting `hasEmbeddingApiKey: true` would put "A key
    // is stored." and a `Remove` button back on screen for a credential this
    // very request deleted — the misreport DW-69 names, arriving by a different
    // door than the one the draft rule closes.
    expect(body.workbench.embeddingProvider).toBe("google");
    expect(body.workbench.hasEmbeddingApiKey).toBe(false);
    expect(body.workbench.embeddingBaseUrl).toBeNull();
    // Presence stays a boolean: no stored secret is ever ON a payload.
    expect(JSON.stringify(body)).not.toContain("sk-o");
    // …and the STORE agrees, read back through the resolver rather than from
    // the response the same request produced.
    expect(getWorkbenchSettings(false).hasEmbeddingApiKey).toBe(false);
    expect(getWorkbenchSettings(false).embeddingBaseUrl).toBeNull();
    // The model is untouched — not a credential, not vendor-bound here.
    expect(body.workbench.embeddingModel).toBe("text-embedding-3-small");
  });

  it("keeps both fields on the payload when the provider does NOT move", async () => {
    // The every-save re-send, end to end. A payload that dropped the key here
    // would take `Remove` off screen for a credential that is still stored.
    await store({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      embeddingApiKey: "sk-o",
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      await put({
        workbench: {
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingBaseUrl: "https://o/v1",
          llmTimeoutSeconds: 90,
        },
      }),
    );

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workbench: WorkbenchSettingsPayload };
    expect(body.workbench.hasEmbeddingApiKey).toBe(true);
    expect(body.workbench.embeddingBaseUrl).toBe("https://o/v1");
  });

  it("clears through the FLAT legacy body too, and says so on the payload", async () => {
    await store({
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      embeddingApiKey: "sk-o",
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(await put({ embeddingProvider: "google" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as { workbench: WorkbenchSettingsPayload };
    expect(body.workbench.hasEmbeddingApiKey).toBe(false);
    expect(body.workbench.embeddingBaseUrl).toBeNull();
  });
});

describe("the switch-aware vector rule — both halves agree (DW-69/DW-72)", () => {
  /** The route's view and the browser's view of ONE deployment. */
  function deployment() {
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      hasEmbeddingApiKey: true,
    };
    return {
      payload,
      stored: storedState({
        vectorSearchEnabled: true,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: "https://o/v1",
        hasEmbeddingApiKey: true,
      }),
    };
  }

  it("refuses a bare switch on BOTH sides, with the same sentence", () => {
    const { payload, stored } = deployment();
    const draft = settingsDraftAfterEmbeddingProvider(
      settingsDraftFromPayload(payload),
      "google",
      payload,
    );

    // The browser's half: the stored key no longer counts, and the endpoint box
    // is blank, so the switch cannot be left on.
    const inputs = draftVectorInputs(draft, payload);
    expect(inputs.hasKey).toBe(false);
    expect(inputs.baseUrl).toBeNull();
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(false);

    // The route's half, fed the very body that draft would send. Same answer,
    // and — since the switch was already stored ON — the same sentence the
    // browser puts beside the checkbox.
    expect(validateWorkbenchSettingsPatch(settingsSaveBody(draft), stored)).toEqual({
      ok: false,
      error: vectorSearchInactiveCopy(inputs),
    });
  });

  it("refuses a switch that supplies the new KEY but no endpoint", () => {
    // The case that pins the endpoint half of the clear on its own. Every other
    // case here names an `embeddingBaseUrl` in the patch, so the merge would
    // answer identically whether or not it dropped the STORED endpoint across a
    // switch — this one names none, so the only endpoint on offer is OpenAI's
    // stored one, and counting it would pass a config the store will not hold.
    const { stored } = deployment();
    const refusal = validateWorkbenchSettingsPatch(
      {
        vectorSearchEnabled: true,
        embeddingProvider: "google",
        embeddingModel: "gemini-embedding-001",
        // The new vendor's credential rides, so the KEY leg is met and cannot be
        // what this refusal is about.
        embeddingApiKey: "g-key",
      },
      stored,
    );
    expect(refusal.ok).toBe(false);
    expect(refusal.ok === false && refusal.error).toContain("endpoint");
  });

  it("refuses the route even when the browser never blanked the endpoint", () => {
    // The API path has no draft to blank anything. A raw patch that switches
    // vendor while re-sending the OLD vendor's endpoint must still be judged on
    // the post-clear config: the store is about to delete that endpoint.
    const { stored } = deployment();
    expect(
      validateWorkbenchSettingsPatch(
        {
          vectorSearchEnabled: true,
          embeddingProvider: "google",
          embeddingBaseUrl: "https://o/v1",
          embeddingModel: "text-embedding-3-small",
        },
        stored,
      ).ok,
    ).toBe(false);
  });

  it("passes on BOTH sides when the new vendor's credentials ride along", () => {
    const { payload, stored } = deployment();
    let draft = settingsDraftAfterEmbeddingProvider(
      settingsDraftFromPayload(payload),
      "google",
      payload,
    );
    draft = { ...draft, embeddingBaseUrl: "https://g/v1", embeddingApiKey: "g-key" };
    draft = { ...draft, embeddingModel: "gemini-embedding-001" };

    expect(draftCanEnableVectorSearch(draft, payload)).toBe(true);
    expect(validateWorkbenchSettingsPatch(settingsSaveBody(draft), stored).ok).toBe(true);
  });

  it("leaves the every-save re-send of the same provider passing", () => {
    const { payload, stored } = deployment();
    const draft = settingsDraftFromPayload(payload);
    const body = settingsSaveBody(draft);
    // The body DOES carry the provider — that is exactly why the rule is a value
    // comparison rather than a presence test.
    expect(body.embeddingProvider).toBe("openai");
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(true);
    expect(validateWorkbenchSettingsPatch(body, stored).ok).toBe(true);
  });

  it("still counts an ENV key belonging to the NEW vendor", () => {
    // The clear is about the STORED credential. A deployment carrying
    // `GOOGLE_GENERATIVE_AI_API_KEY` satisfies the key leg for Google the moment
    // Google is selected, and no save can move that.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://o/v1",
      hasEmbeddingApiKey: true,
      envEmbeddingApiKeyProviders: ["google"],
    };
    const draft = {
      ...settingsDraftAfterEmbeddingProvider(
        settingsDraftFromPayload(payload),
        "google",
        payload,
      ),
      embeddingBaseUrl: "https://g/v1",
      embeddingModel: "gemini-embedding-001",
    };
    expect(draftVectorInputs(draft, payload).hasKey).toBe(true);
    expect(
      validateWorkbenchSettingsPatch(
        settingsSaveBody(draft),
        storedState({
          vectorSearchEnabled: true,
          embeddingProvider: "openai",
          embeddingModel: "text-embedding-3-small",
          embeddingBaseUrl: "https://o/v1",
          hasEmbeddingApiKey: true,
          envEmbeddingApiKeyProviders: ["google"],
        }),
      ).ok,
    ).toBe(true);
  });

  it("leaves `storedVectorInputs` — no draft in play — untouched", () => {
    // A freshly seeded draft selects the stored provider, so nothing switched
    // and the flat page's advisory reads exactly what it read before.
    const { payload } = deployment();
    expect(storedVectorInputs(payload).hasKey).toBe(true);
    expect(storedVectorInputs(payload).baseUrl).toBe("https://o/v1");
  });
});
