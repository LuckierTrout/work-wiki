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
  _resetConfigCache,
  applyWorkbenchSettings,
  getChatModelSettings,
  getFirecrawlSettings,
  getIngestModelSettings,
  getLlmTimeoutMs,
  getVectorSearchSettings,
  getWorkbenchSettings,
  loadConfig,
  saveConfig,
  workbenchSettingsStored,
  type AppConfig,
} from "../config";
import { EMBEDDING_PROVIDERS, PROVIDER_INFO, embeddingProviderLabel } from "../providers";
import { _resetStorage } from "../storage";
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

function put(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Read the config file back through storage, bypassing the sync cache. */
async function stored(): Promise<AppConfig> {
  _resetConfigCache();
  return loadConfig();
}

/** A payload with every field at its "fresh deployment" value. */
function emptyPayload(): WorkbenchSettingsPayload {
  return {
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
    for (const provider of ["ollama", "workers-ai"]) {
      expect(
        canEnableVectorSearch({ provider, baseUrl: null, model: "m", hasKey: false }),
      ).toBe(true);
      expect(
        canEnableVectorSearch({ provider, baseUrl: null, model: null, hasKey: false }),
      ).toBe(false);
    }
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
    const response = await PUT(put({ workbench: settingsSaveBody(draft) }));
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
});

describe("PUT /api/settings", () => {
  it("persists a Chat model and an Ingest model on different providers", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      put({
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
    const response = await PUT(put({ provider: "ollama-cloud", model: "gpt-oss:120b" }));
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
      put({ workbench: { vectorSearchEnabled: true, embeddingProvider: "openai" } }),
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

  it("turns vector search on when the endpoint, the model and the key all arrive", async () => {
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      put({
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
      put({
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
    await PUT(put({ workbench: { llmTimeoutSeconds: 90 } }));
    let config = await stored();
    expect(config.firecrawlApiKey).toBe("fc-1");
    expect(config.customApiKey).toBe("sk-1");
    expect(config.llmTimeoutSeconds).toBe(90);

    await PUT(put({ workbench: { firecrawlApiKey: null } }));
    config = await stored();
    expect("firecrawlApiKey" in config).toBe(false);
    expect(config.customApiKey).toBe("sk-1");

    await PUT(put({ workbench: { customApiKey: "" } }));
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
      const response = await PUT(put({ workbench }));
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
    const response = await PUT(put({ workbench: { llmTimeoutSeconds: 60 } }));
    expect(response.status).toBe(403);
    expect(await stored()).toEqual({});
  });

  it("answers a non-owner with the route's existing 404", async () => {
    principal.current = null;
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(put({ workbench: { llmTimeoutSeconds: 60 } }));
    expect(response.status).toBe(404);
    expect(await stored()).toEqual({});
  });

  it("counts an embedding model set by the LEGACY field in the same request", async () => {
    // The workbench patch is applied after every legacy branch, and the vector
    // gate is evaluated over that post-merge object — so one request can set the
    // model the flat way and the switch the nested way.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      put({
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
    expect(canvas).toContain('aria-describedby={field("vectorSearchEnabled-hint")}');
    expect(canvas).toContain('id={field("vectorSearchEnabled-hint")}');
    // Each row builder wires its own hint; none of them renders a bare span.
    const hintSpans = [...canvas.matchAll(/<span className="wb-set-hint"/g)];
    const identified = [...canvas.matchAll(/<span className="wb-set-hint" id=/g)];
    expect(identified.length).toBe(hintSpans.length);
    expect(canvas.match(/aria-describedby=\{hintId\}/g)?.length).toBe(2);
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
