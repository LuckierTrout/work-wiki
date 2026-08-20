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

import {
  CONFIG_UNREADABLE_COPY,
  UNSTAMPED_CONFIG_VERSION,
  _resetConfigCache,
  applyWorkbenchSettings,
  getChatModelSettings,
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
  SETTINGS_SAVE_FAILED_COPY,
  SETTINGS_CATEGORIES,
  canEnableVectorSearch,
  draftCanEnableVectorSearch,
  draftVectorInputs,
  fetchWorkbenchSettings,
  isWorkbenchSettingsPayload,
  saveWorkbenchSettings,
  settingsAnnouncement,
  settingsDirty,
  settingsDraftFromPayload,
  settingsSaveBody,
  validateWorkbenchSettingsPatch,
  vectorSearchMissingCopy,
  type SettingsFetch,
  type WorkbenchSettingsPayload,
} from "../workbench-settings";

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
 * The precondition token the STORE currently holds — the opaque stamp
 * `saveConfig` wrote to the sibling file, not anything derived from the config
 * (DW-197). This is what a surface seeded from `GET` would send back.
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
    envEmbeddingProvider: null,
    envEmbeddingModel: null,
    envEmbeddingApiKeyProviders: [],
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

describe("canEnableVectorSearch", () => {
  it("requires an EXPLICIT embedding provider before anything else", () => {
    // `resolveEmbeddingProvider`'s auto-detect branch consults env vars only, so
    // without this leg an owner could satisfy endpoint + model + stored key,
    // turn the switch on, and still resolve no embedding provider at all.
    const legs = { baseUrl: "https://e", model: "m", hasKey: true };
    expect(canEnableVectorSearch({ provider: null, ...legs })).toBe(false);
    expect(canEnableVectorSearch({ provider: "", ...legs })).toBe(false);
    // A provider that cannot embed is not a selection either.
    expect(canEnableVectorSearch({ provider: "anthropic", ...legs })).toBe(false);
    expect(canEnableVectorSearch({ provider: "openai", ...legs })).toBe(true);
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
        expect(canEnableVectorSearch({ provider, baseUrl, model, hasKey })).toBe(expected);
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
      expect(canEnableVectorSearch({ provider, baseUrl: null, model, hasKey: false })).toBe(
        true,
      );
      expect(
        canEnableVectorSearch({ provider, baseUrl: null, model: null, hasKey: false }),
      ).toBe(false);
    }
  });

  it("refuses a model id from the WRONG namespace, in both directions", () => {
    // `resolveEmbeddingModelName` honours an override only when
    // `id.startsWith("@cf/")` matches `provider === "workers-ai"`, and silently
    // falls back to the provider default otherwise. Accepting the mismatch here
    // would turn the switch on and then embed with a model nobody selected.
    expect(
      canEnableVectorSearch({
        provider: "workers-ai",
        baseUrl: null,
        model: "text-embedding-3-small",
        hasKey: false,
      }),
    ).toBe(false);
    expect(
      canEnableVectorSearch({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(false);
    // Both matching cases still pass — the rule is an equality, not a ban.
    expect(
      canEnableVectorSearch({
        provider: "workers-ai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(true);
    expect(
      canEnableVectorSearch({
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
      canEnableVectorSearch({
        provider: "ollama",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(false);
    expect(
      vectorSearchMissingCopy({
        provider: "ollama",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.",
    );
    // Google is a keyed provider, and gets the same answer OpenAI does.
    expect(
      canEnableVectorSearch({
        provider: "google",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(false);
    expect(
      canEnableVectorSearch({
        provider: "google",
        baseUrl: "https://e",
        model: "gemini-embedding-001",
        hasKey: true,
      }),
    ).toBe(true);
  });

  it("treats the empty string as unset, not as set to nothing", () => {
    expect(
      canEnableVectorSearch({ provider: "openai", baseUrl: "", model: "m", hasKey: true }),
    ).toBe(false);
    expect(
      canEnableVectorSearch({
        provider: "openai",
        baseUrl: "https://e",
        model: "",
        hasKey: true,
      }),
    ).toBe(false);
  });

  it("names what is missing FOR THE SELECTED PROVIDER", () => {
    expect(
      vectorSearchMissingCopy({
        provider: null,
        baseUrl: "https://e",
        model: "m",
        hasKey: true,
      }),
    ).toBe("Vector search needs an embedding provider before it can be turned on.");
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs an endpoint, a model and an API key before it can be turned on.",
    );
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "m",
        hasKey: false,
      }),
    ).toBe("Vector search needs an API key before it can be turned on.");
    // Ollama is never told to find a key it does not have.
    expect(
      vectorSearchMissingCopy({
        provider: "ollama",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe("Vector search needs a model before it can be turned on.");
    // Nothing missing is not a sentence — the caller shows the ordinary hint.
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "m",
        hasKey: true,
      }),
    ).toBe("");
  });

  it("names the NAMESPACE rather than repeating \"a model\" (DW-73)", () => {
    expect(
      vectorSearchMissingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: "text-embedding-3-small",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: true,
      }),
    ).toBe(
      "Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.",
    );
    // A leg, not a separate sentence: it composes with the others in leg order
    // instead of hiding them.
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: "https://e",
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs a model id outside the Workers AI @cf/ namespace and an API key before it can be turned on.",
    );
    // THREE legs, which is what pins the new leg's POSITION: it is the middle
    // clause, between the endpoint and the key, because that is the order
    // `vectorSearchMissingLegs` pushes them in. A two-leg case alone cannot
    // tell "second" from "last".
    expect(
      vectorSearchMissingCopy({
        provider: "openai",
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
      }),
    ).toBe(
      "Vector search needs an endpoint, a model id outside the Workers AI @cf/ namespace and an API key before it can be turned on.",
    );
    // No model at all is still just "a model" — the namespace clause needs a
    // value to complain about.
    expect(
      vectorSearchMissingCopy({
        provider: "workers-ai",
        baseUrl: null,
        model: null,
        hasKey: false,
      }),
    ).toBe("Vector search needs a model before it can be turned on.");
    // And an id that matches its provider is not named at all.
    expect(
      vectorSearchMissingCopy({
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
        canEnableVectorSearch({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(false);
      expect(
        vectorSearchMissingCopy({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(
        "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
      );
    }
  });

  it("accepts every id the sentence names, so the copy is not a dead end", () => {
    // The refusal lists four ids; each one must actually clear the gate, or the
    // sentence sends the owner somewhere the switch still says no.
    for (const model of WORKERS_AI_EMBEDDING_MODEL_IDS) {
      expect(
        canEnableVectorSearch({
          provider: "workers-ai",
          baseUrl: null,
          model,
          hasKey: false,
        }),
      ).toBe(true);
    }
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
    const refusal = validateWorkbenchSettingsPatch(body, workbenchSettingsStored({}));
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
  return { ...workbenchSettingsStored({}), ...over };
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
    expect(
      validateWorkbenchSettingsPatch(
        { vectorSearchEnabled: true, embeddingProvider: "openai" },
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
  ];

  for (const situation of situations) {
    it(`agrees when ${situation.name}`, async () => {
      if (situation.env.provider) process.env.EMBEDDING_PROVIDER = situation.env.provider;
      if (situation.env.model) process.env.EMBEDDING_MODEL = situation.env.model;
      if (situation.env.key) process.env.OPENAI_API_KEY = situation.env.key;
      await store(situation.config);

      const payload = getWorkbenchSettings();
      const draft = settingsDraftFromPayload(payload);
      // The BROWSER's answer, from the payload alone…
      const client = draftCanEnableVectorSearch(draft, payload);
      // …and the ROUTE's, for the very patch that draft would send.
      const route = validateWorkbenchSettingsPatch(
        { ...settingsSaveBody(draft), vectorSearchEnabled: true },
        workbenchSettingsStored(situation.config),
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
    const payload = getWorkbenchSettings();
    // The box stays empty — showing an env value in an editable field would
    // persist it on the next save…
    expect(payload.embeddingModel).toBeNull();
    // …while the gate is satisfied, because the override is served beside it.
    expect(payload.envEmbeddingModel).toBe("text-embedding-3-small");
    expect(draftCanEnableVectorSearch(settingsDraftFromPayload(payload), payload)).toBe(
      true,
    );
  });

  it("applies the namespace leg to a mismatch that arrives from EMBEDDING_MODEL", async () => {
    // All three feeders take the env override AHEAD of anything stored or typed
    // (`mergedVectorInputs`, `draftVectorInputs`, `config.ts`'s
    // `getVectorSearchSettings`), so the env value is a first-class input to the
    // namespace leg — the mismatch can arrive without the owner ever touching
    // the model box, which is exactly the stale-override case
    // `resolveEmbeddingModelName` was written for.
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({ embeddingProvider: "workers-ai", vectorSearchEnabled: true });

    const payload = getWorkbenchSettings();
    expect(payload.envEmbeddingModel).toBe("text-embedding-3-small");

    // The browser refuses, and says why…
    const draft = settingsDraftFromPayload(payload);
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(false);
    expect(vectorSearchMissingCopy(draftVectorInputs(draft, payload))).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
    // …the already-stored `true` reads as off…
    expect(getVectorSearchSettings().enabled).toBe(false);
    // …and the route refuses the save with the same sentence.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: { vectorSearchEnabled: true, embeddingProvider: "workers-ai" },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
  });

  it("does not let a TYPED matching id lift a refusal the env override owns", async () => {
    // Today's intended answer, pinned rather than smoothed over: the override
    // WINS over the box in every feeder, so typing a `@cf/` id fixes nothing
    // until `EMBEDDING_MODEL` is unset. Pinning it is what keeps a later
    // "helpful" change to the precedence from passing unnoticed.
    process.env.EMBEDDING_MODEL = "text-embedding-3-small";
    await store({ embeddingProvider: "workers-ai" });

    const payload = getWorkbenchSettings();
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
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
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
    const payload = getWorkbenchSettings();
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
    });

    const thrown: SettingsFetch = async () => {
      throw new Error("NetworkError when attempting to fetch resource");
    };
    await expect(saveWorkbenchSettings({}, { fetchImpl: thrown })).resolves.toEqual({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
    });

    const blank = stubFetch(() => ({ ok: false, status: 500, body: { error: "  " } })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: blank })).resolves.toEqual({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
    });
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
    ).resolves.toEqual({ status: "error", message: WRITE_CONFLICT_COPY });

    // …and the 428 the route answers a missing precondition with, the same way.
    const missing = stubFetch(() => ({
      ok: false,
      status: 428,
      body: { error: WRITE_PRECONDITION_REQUIRED_COPY },
    })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: missing })).resolves.toEqual({
      status: "error",
      message: WRITE_PRECONDITION_REQUIRED_COPY,
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
    // generated from randomness and stored beside the config.
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
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify(
        {
          provider: "openai",
          firecrawlApiKey: "fc-secret-two",
          customApiKey: "sk-custom-two",
          embeddingApiKey: "sk-embed-two",
        },
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    _resetConfigCache();
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

    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify({ model: "gpt-4o", provider: "openai" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      first.version,
    );

    // The RESIDUAL is the same fact with different bytes: a hand edit that
    // actually CHANGES a value also leaves the version standing, so a draft
    // seeded before it saves straight over it. The derived version moved here
    // and this one does not — that is the cost paid to get the three API keys
    // off the boundary (AD-23), and it is recorded rather than closed. See
    // `UNSTAMPED_CONFIG_VERSION` in `config.ts`.
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify({ provider: "anthropic", model: "claude" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      first.version,
    );

    // …and it moves on every save THROUGH the API, which is the whole set of
    // writes the guard is defined over.
    await store({ provider: "anthropic", model: "gpt-4o" });
    const last = (await (await GET()).json()) as { version: string };
    expect(last.version).not.toBe(first.version);
  });

  it("serves the sentinel for a store that has a config but no token file", async () => {
    // A store written by hand, restored from a backup, or created before this
    // scheme existed. Refusing every save against it would strand the owner.
    await store({ provider: "openai" });
    await fs.rm(path.join(tmpDir, ".llm-wiki-config.version"));
    _resetConfigCache();
    const { GET } = await import("@/app/api/settings/route");
    const body = (await (await GET()).json()) as { version: string };
    expect(body.version).toBe(UNSTAMPED_CONFIG_VERSION);
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

  it("refuses when the CONFIG reads but its TOKEN FILE does not", async () => {
    // The precondition lives in a sibling file, so its read can fail on its
    // own. Serving a version the store did not actually stamp would seed a
    // draft against a guess, and the save that followed would be compared to
    // something nobody wrote.
    await store({ provider: "openai" });
    await fs.rm(path.join(tmpDir, ".llm-wiki-config.version"));
    await fs.mkdir(path.join(tmpDir, ".llm-wiki-config.version"));
    _resetConfigCache();
    const { GET } = await import("@/app/api/settings/route");
    const response = await GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
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
    expect(body.error).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
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
      "Vector search needs a model id outside the Workers AI @cf/ namespace before it can be turned on.",
    );
    expect(await stored()).toEqual({ provider: "openai" });
  });

  it("refuses an UNRELATED edit while the STORED config holds a mismatch", async () => {
    // Every other route case here puts the offending model IN the request. This
    // one does not: the mismatch is already in the store and the patch touches
    // only `chatModel`. `validateWorkbenchSettingsPatch` takes the flag from the
    // patch when present and from the STORE otherwise, then re-runs the whole
    // rule over the merged inputs — so the namespace leg is not scoped to the
    // fields being edited. Narrowing it to the patch would leave every other
    // route test in this file green, which is the regression this case exists
    // to catch.
    //
    // It is also the friction this spec's `deferred` list records: until the
    // model is fixed or the switch turned off, unrelated Workbench saves are
    // refused with the namespace sentence. Recovery is always available (the
    // switch may be turned OFF), so the behaviour is pinned, not softened.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
    // The unrelated edit did NOT land — the refusal precedes `saveConfig`, so
    // the store is byte-for-byte what it was.
    expect(await stored()).toEqual({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
  });

  it("turns vector search on for a Workers AI id under Workers AI", async () => {
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
    const payload = getWorkbenchSettings();
    expect(
      vectorSearchMissingCopy(
        draftVectorInputs(settingsDraftFromPayload(payload), payload),
      ),
    ).toBe(
      "Vector search needs a supported Workers AI model id (@cf/baai/bge-small-en-v1.5, @cf/baai/bge-base-en-v1.5, @cf/baai/bge-large-en-v1.5, @cf/baai/bge-m3) before it can be turned on.",
    );
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
    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify({ model: "gpt-4o", provider: "openai" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();

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

    await fs.writeFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      JSON.stringify({ provider: "anthropic" }, null, 2) + "\n",
      "utf-8",
    );
    _resetConfigCache();

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(200);
    // The hand edit survives only because it is in the merge BASE this request
    // read — nothing about it was checked, and a save that had touched
    // `provider` would have overwritten it silently.
    expect(await stored()).toEqual({ provider: "anthropic", chatModel: "gpt-4o" });
  });

  it("refuses the NEXT save after a half-completed one, rather than losing it", async () => {
    // `saveConfig` writes the token first and the config second. When the
    // second write fails, the stamp has already moved: every surface still
    // holding the pre-save version is refused and recovers by reloading. The
    // reverse order would leave that version MATCHING a config that had already
    // changed, and the stale draft would write straight over it.
    await store({ provider: "openai" });
    const seeded = await storedVersion();
    const { PUT } = await import("@/app/api/settings/route");

    const storage = getStorage();
    const write = storage.writeFile.bind(storage);
    const spy = vi
      .spyOn(storage, "writeFile")
      .mockImplementation(async (target: string, content: string) => {
        if (target.endsWith(".llm-wiki-config.json")) {
          return Promise.reject(new Error("the storage provider is unavailable"));
        }
        return write(target, content);
      });
    try {
      // The route surfaces the storage failure as its existing 500.
      const half = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));
      expect(half.status).toBe(500);
    } finally {
      spy.mockRestore();
    }

    // The config never changed…
    expect(await stored()).toEqual({ provider: "openai" });
    // …and a surface still holding the pre-save version is REFUSED rather than
    // allowed to land over whatever the store now holds.
    const next = await PUT(await put({ workbench: { chatModel: "gpt-4.1" } }, seeded));
    expect(next.status).toBe(412);
    expect(await response412Error(next)).toBe(WRITE_CONFLICT_COPY);
    expect(await stored()).toEqual({ provider: "openai" });
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

  it("refuses a save whose TOKEN FILE could not be read (503), and writes nothing", async () => {
    // Same refusal, same sentence, for the other half of the read. The bytes
    // on disk are the proof nothing was merged.
    await store({ provider: "openai", firecrawlApiKey: "fc-secret" });
    const seeded = await storedVersion();
    const before = await readFile(
      path.join(tmpDir, ".llm-wiki-config.json"),
      "utf-8",
    );
    await fs.rm(path.join(tmpDir, ".llm-wiki-config.version"));
    await fs.mkdir(path.join(tmpDir, ".llm-wiki-config.version"));
    _resetConfigCache();
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      await put({ workbench: { chatModel: "gpt-4o" } }, seeded),
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
    expect(
      await readFile(path.join(tmpDir, ".llm-wiki-config.json"), "utf-8"),
    ).toBe(before);
  });

  it("lands a first save against the UNSTAMPED sentinel and stamps a real token", async () => {
    // A store with a config and no token file — hand-written, restored, or
    // created before this scheme existed. Refusing it would strand the owner.
    await store({ provider: "openai" });
    await fs.rm(path.join(tmpDir, ".llm-wiki-config.version"));
    _resetConfigCache();
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

  it("lets a FLAT-ONLY body store a namespace mismatch the gate never runs on", async () => {
    // CHARACTERIZATION, not endorsement. The case above passes only because its
    // body also carries `workbench`, which is what makes the route enter the
    // validated branch at all. A body with NO `workbench` key skips it entirely
    // — by explicit design, so that "a body with no `workbench` produces
    // byte-identically the same saved object" stays true — and the flat
    // `embeddingModel` branch has never validated anything.
    //
    // The consequence since DW-73 is recorded as the FIRST entry in this spec's
    // `deferred` list: a flat-only save can now switch effective vector search
    // off, where before it was harmless because the resolver simply fell back.
    // Closing it is a decision about legacy compatibility, not a patch, so this
    // test pins TODAY'S answer. When that decision is taken, this expectation
    // should be updated deliberately rather than tripped over.
    await store({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "@cf/baai/bge-m3",
    });
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(true);

    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ embeddingModel: "text-embedding-3-small" }));

    // Accepted, because the vector gate is never consulted on this path.
    expect(response.status).toBe(200);
    expect(await stored()).toMatchObject({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
    });
    // And the effective accessor now disagrees with the stored flag: the switch
    // still reads on in the store while vector search is off in fact.
    await loadConfig();
    expect(getVectorSearchSettings().enabled).toBe(false);
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
    expect(JSON.stringify(getWorkbenchSettings())).not.toContain("fc-1");
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
    expect(canvas).toContain('aria-describedby={hint ? hintId : undefined}');
    expect(canvas).toContain(
      'aria-describedby={describedBy(field("vectorSearchEnabled-hint"))}',
    );
    expect(canvas).toContain('id={field("vectorSearchEnabled-hint")}');
    // Every control a read-only deployment refuses routes its description
    // through `describedBy`, which APPENDS the save bar's read-only sentence to
    // the control's own hint — `aria-describedby` takes a space-separated list,
    // so the hint is kept rather than replaced. Three controls, three calls.
    expect(canvas.match(/aria-describedby=\{describedBy\(/g)).toHaveLength(3);
    expect(canvas).toContain('const readOnlyNoteId = field("bar-note");');
    expect(canvas).toContain('<span className="wb-set-bar-note" id={readOnlyNoteId}>');
    // Each row builder wires its own hint; none of them renders a bare span.
    const hintSpans = [...canvas.matchAll(/<span className="wb-set-hint"/g)];
    const identified = [...canvas.matchAll(/<span className="wb-set-hint" id=/g)];
    expect(identified.length).toBe(hintSpans.length);
    // One bare `hintId` left — the secret row, which a read-only deployment
    // renders `readOnly` rather than `aria-disabled`, so it has no refusal to
    // announce. The provider picker's went through `describedBy` above.
    expect(canvas.match(/aria-describedby=\{hintId\}/g)?.length).toBe(1);
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
    // One canvas at a time, so the skip link keeps exactly one target.
    const shell = await readComponent("Workbench.tsx");
    expect(shell).toContain("{settingsOpen ? (");
    expect(shell).toContain("<SettingsCanvas category={settingsCategoryId}");
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
    expect(shell).toContain("setAnnouncement(workbenchMode(mode).label)");
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
