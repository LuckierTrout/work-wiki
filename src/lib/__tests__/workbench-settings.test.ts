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
 * This file is collected by vitest's `node` project (`environment: "node"`,
 * `*.test.ts`), which mounts nothing (DW-15), so every
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
  WRITE_CONFLICT_STATUS,
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
  SETTINGS_LABEL,
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
  SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
  canEnableVectorSearch,
  draftCanEnableVectorSearch,
  draftEmbeddingIdentityDirty,
  draftEmbeddingKeyStored,
  draftResearchProvider,
  draftResearchProviderConfigured,
  draftVectorInputs,
  embeddingProviderChanged,
  fetchWorkbenchSettings,
  flatMovableVectorLegs,
  flatTextFieldAction,
  isSettingsCategoryId,
  isWorkbenchSettingsPayload,
  resolveEnvEmbeddingProvider,
  saveWorkbenchSettings,
  settingsAnnouncement,
  settingsDirty,
  settingsDraftAfterEmbeddingPinRefusal,
  settingsDraftAfterEmbeddingProvider,
  settingsDraftFromPayload,
  settingsEnvOverrideCopy,
  settingsEnvProviderInvalidCopy,
  settingsEnvProviderPinCopy,
  settingsEnvProviderPinRefusalCopy,
  SETTINGS_ENV_PROVIDER_PIN_CODE,
  SETTINGS_SAVE_UNREADABLE_COPY,
  settingsRefusalPinsEmbeddingProvider,
  settingsCategory,
  settingsPointer,
  settingsSaveBody,
  storedVectorInputs,
  validateWorkbenchSettingsPatch,
  verdictClearsHeldVersion,
  vectorSearchFieldIssue,
  vectorSearchInactiveCopy,
  vectorSearchMissingCopy,
  type SettingsFetch,
  type SettingsSaveResult,
  type SettingsSaveVerdict,
  type VectorSearchInputs,
  type VectorSearchLegField,
  type WorkbenchSettingsPatch,
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

/**
 * The reserved key BINDING the token to the bytes it was stamped for (DW-372).
 *
 * Spelled here so the hand-edit cases can carry the store's own digest forward:
 * a hand edit that drops it, like one that drops the token, leaves an UNSTAMPED
 * store — a different case again. Never recomputed here; {@link heldDigest}
 * reads what the store already holds.
 */
const DIGEST_KEY = "__settingsDigest";

/**
 * The digest the store currently holds on disk — read BEFORE a hand edit.
 *
 * CHECKED before it is handed back. Unchecked, a regression that stopped writing
 * the digest would return `undefined`, the "carries the digest forward" cases
 * would hand-write `undefined`, and the store would read unstamped — which is
 * what some of those cases assert anyway, for an entirely different reason.
 */
async function heldDigest(): Promise<string> {
  const raw = JSON.parse(
    await fs.readFile(path.join(tmpDir, ".llm-wiki-config.json"), "utf-8"),
  ) as Record<string, unknown>;
  expect(raw[DIGEST_KEY]).toMatch(/^[0-9a-f]{64}$/);
  return raw[DIGEST_KEY] as string;
}

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
    // Nothing in the environment either, so both key rows are stored-only
    // and `Remove` is on the page for a key that is actually there (DW-66).
    envCustomApiKey: false,
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
    envFirecrawlApiKey: false,
    // Deep Research on a fresh deployment: nothing chosen (which READS as
    // Tavily), no credential for any of the three, no env override.
    researchProvider: null,
    envResearchProvider: null,
    hasTavilyApiKey: false,
    hasSerpApiKey: false,
    serpApiEngine: null,
    searxngBaseUrl: null,
    envSearxngBaseUrl: null,
    searxngCategories: null,
    envResearchProviders: [],
    // Intake and MinerU on a fresh deployment: no inbound address configured,
    // the door switched off, no `raw/parsed/` copies, and MinerU `off` with no
    // credential. `off` is the fail-closed default and the value an absent or
    // unreadable stored mode resolves to.
    inboundEmailAddress: null,
    inboundEmailEnabled: false,
    intakeKeepParsed: false,
    mineruMode: "off",
    mineruLocalBaseUrl: null,
    hasMinerUApiKey: false,
    // The loopback door on a fresh deployment: SHUT, unauthenticated access
    // off, no token anywhere. All four are the fail-closed answers, and they are
    // the defaults `getLoopbackApiSettings` resolves an absent config to.
    apiEnabled: false,
    allowUnauthenticated: false,
    hasLoopbackApiToken: false,
    loopbackTokenSource: "none",
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

  it("narrows an untrusted value to a listed id, and nothing else", () => {
    // The `?category=` param's narrower (DW-514). It lives beside the
    // vocabulary rather than beside its reader in `workbench-url.ts` for the
    // reason `isWorkbenchModeId` does: a validator written at the call site is a
    // second copy of the list that nothing forces to agree with this one — so
    // this pins it against `SETTINGS_CATEGORIES` itself, and a category added
    // above is linkable without a second edit anywhere.
    for (const category of SETTINGS_CATEGORIES) {
      expect(isSettingsCategoryId(category.id)).toBe(true);
    }
    // A hand-edited link, a label mistaken for an id, an id from a future build,
    // and the shapes a query read can hand in when the param is absent.
    for (const value of [
      "General",
      "LLM Models",
      "nope",
      "",
      " general",
      "general ",
      null,
      undefined,
      0,
      {},
    ]) {
      expect(isSettingsCategoryId(value)).toBe(false);
    }
  });

  it("gives every category a unique id and a non-empty label", () => {
    const ids = SETTINGS_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const category of SETTINGS_CATEGORIES) {
      expect(category.label.length).toBeGreaterThan(0);
    }
  });

  it("leaves NO category pending now that API + MCP has controls", () => {
    const pending = SETTINGS_CATEGORIES.filter((c) => c.pending !== null).map((c) => c.id);
    // Epic 7 built Intake and MinerU PDF; Story 8.1 built API + MCP, which was
    // the last one. `api-mcp` kept its pending sentence for exactly as long as
    // the pane had no enable switch, no token and no copyable MCP config — it
    // has all three now, so the sentence would be the lie in the other
    // direction.
    expect(pending).toEqual([]);
    // The MECHANISM survives the last pending category leaving. It is the rule
    // for a listed-but-unbuilt category, and deleting it because nothing uses
    // it today would mean the next such category either renders nothing (a dead
    // nav row) or renders a stub (a lie about what works).
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
    // It also does not restate `settingsEnvProviderPinCopy`, which already says
    // the variable wins over the box and is the provider row's hint in exactly
    // the state that selects this note — the two ride on the same control, so a
    // second telling is the same duplication the `"model"` exception in
    // `vectorSearchFieldIssue` avoids.
    expect(SETTINGS_VECTOR_BINDING_ENV_NOTE).not.toContain("wins at runtime");
    expect(settingsEnvProviderPinCopy("workers-ai")).toContain("wins at runtime");
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
// The pointer itself — one derivation, two surface labels (DW-369)
// ---------------------------------------------------------------------------

describe("settingsPointer", () => {
  it("derives the category half from SETTINGS_CATEGORIES rather than spelling it", () => {
    // THE POINT of exporting this. `src/lib/llm.ts` used to hand-type "LLM
    // Models" at five throw sites, so renaming the category left five runtime
    // messages naming a nav row the Settings surface no longer shows. Asserted
    // against the nav entry, not against a literal, so this stays true through a
    // rename instead of having to be edited by one.
    for (const category of SETTINGS_CATEGORIES) {
      expect(settingsPointer(category.id)).toBe(
        `Workbench Settings → ${category.label}`,
      );
      expect(settingsPointer(category.id, SETTINGS_LABEL)).toBe(
        `Settings → ${category.label}`,
      );
    }
  });

  it("defaults to the OTHER surface named in full, so the two existing call sites are unchanged", () => {
    // The default parameter is `WORKBENCH_SETTINGS_LABEL`, which is declared
    // BELOW the function — safe because a default is evaluated at call time, and
    // the only module-level call runs after that declaration. Byte-for-byte:
    // both existing call sites render on `/settings`, whose own nav row and
    // <h1> read "Settings", so a bare pointer would name the page the owner is
    // already standing on.
    expect(settingsPointer("llm-models")).toBe("Workbench Settings → LLM Models");
    expect(settingsPointer("embeddings")).toBe("Workbench Settings → Embeddings");
    expect(SETTINGS_FLAT_CUSTOM_ENDPOINT_COPY).toContain(
      settingsPointer("llm-models"),
    );
  });

  it("composes the surface word from SETTINGS_LABEL, so the two surfaces cannot drift", () => {
    // "Workbench Settings" is `Workbench ${SETTINGS_LABEL}` — not a second
    // spelling of the word this module already owns.
    expect(settingsPointer("general")).toBe(
      `Workbench ${settingsPointer("general", SETTINGS_LABEL)}`,
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
    //
    // This row is ALSO the guard on how DW-636's note suppression is keyed. The
    // `binding` leg reaches the PROVIDER control (`VECTOR_LEG_CONTROL`) while
    // its field is `binding`, so a suppression keyed on the control would delete
    // this note — the one place the two ways out of an unbound `workers-ai` are
    // named — along with the provider leg's. It is keyed on `leg.field`, which
    // is why the note below still arrives.
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
// The PROVIDER leg's env note (DW-636)
// ---------------------------------------------------------------------------

describe("the provider leg names EMBEDDING_PROVIDER when the environment owns it", () => {
  // `providerOrigin: "env"` over a provider the gate does not recognise can only
  // mean a JUNK variable: a filtered env provider always passes
  // `isEmbeddingProvider`, so the only way a refused string reaches this leg is
  // the join `resolveEnvEmbeddingProvider` performs. Everything else here is a
  // complete, supported config — which is exactly what made the un-noted
  // sentence unactionable: "supply what is missing" pointed at an endpoint, a
  // model and a key that were all already supplied.
  const junkEnv: VectorLegs = {
    provider: "deepseek",
    baseUrl: "https://embed.example",
    model: "text-embedding-3-small",
    hasKey: true,
    providerOrigin: "env",
  };

  it("APPENDS the note to the refusal and to both switched-on frames", () => {
    expect(missingCopy(junkEnv)).toBe(
      `Vector search needs an embedding provider before it can be turned on. ${SETTINGS_VECTOR_PROVIDER_ENV_NOTE}`,
    );
    // Appended, never substituted: the leg sentence still leads, so a caller
    // that reads only the first sentence loses nothing it had before.
    expect(missingCopy(junkEnv).startsWith("Vector search needs an embedding provider")).toBe(
      true,
    );
    // The same note under both switched-on frames — `withLegNotes` carries it
    // for every caller, so the frame is the only thing the surface changes.
    expect(vectorSearchInactiveCopy(vectorInputs(junkEnv))).toBe(
      `Vector search is switched on, but it needs an embedding provider before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_PROVIDER_ENV_NOTE}`,
    );
    // …and on the flat page, where only the ACTION clause differs — the note
    // rides after it, so the surface's pointer is not what carries the variable.
    const flat = vectorSearchInactiveCopy(vectorInputs(junkEnv), "flat");
    expect(flat).toContain(
      "Vector search is switched on, but it needs an embedding provider before it can run. Supply what is missing, or turn the switch off in ",
    );
    expect(flat.endsWith(` ${SETTINGS_VECTOR_PROVIDER_ENV_NOTE}`)).toBe(true);
  });

  it("names the VARIABLE and the control it overrides, without restating the row", () => {
    // The one thing that can lift the refusal. Without it the sentence named
    // every field on the surface except the only one that mattered.
    expect(SETTINGS_VECTOR_PROVIDER_ENV_NOTE).toContain("EMBEDDING_PROVIDER");
    // It NAMES the select rather than saying "here": it rides on the CHECKBOX's
    // sentence, so "here" would point at the checkbox (DW-218's reading, one leg
    // up).
    expect(SETTINGS_VECTOR_PROVIDER_ENV_NOTE).toContain("Embedding provider select");
    // …and it does not restate what the provider row already says — that is the
    // same division `SETTINGS_VECTOR_BINDING_ENV_NOTE` keeps.
    expect(SETTINGS_VECTOR_PROVIDER_ENV_NOTE).not.toContain("wins at runtime");
    // CORRECTING the variable is a way out this note has and the model note does
    // not: any non-blank `EMBEDDING_MODEL` overrides, while an unsupported
    // provider is as often a typo as a decision.
    expect(SETTINGS_VECTOR_PROVIDER_ENV_NOTE).toContain("corrected");
  });

  it("leaves every STORED-origin sentence byte-identical", () => {
    // The regression this change must not cause. Same legs, same order, no note
    // — a variable that is not set is not something an owner can act on, and
    // saying so is the mistake DW-218 fixed for the model leg.
    const stored: VectorLegs = { ...junkEnv, providerOrigin: "stored" };
    expect(missingCopy(stored)).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
    expect(vectorSearchInactiveCopy(vectorInputs(stored))).toBe(
      "Vector search is switched on, but it needs an embedding provider before it can run. Turn it off, or supply what is missing.",
    );
    // …and an UNSET provider carries no note: `providerOrigin` is `"stored"`
    // whenever the join answered `null`, so "no provider at all" and "the
    // environment owns it" cannot co-occur — the select's standing
    // `SETTINGS_VECTOR_PROVIDER_COPY` hint is the complaint there.
    const unset: VectorLegs = { ...junkEnv, provider: null, providerOrigin: "stored" };
    expect(missingCopy(unset)).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
  });

  it("suppresses the note on the provider ROW, which already names the variable", () => {
    // The row renders `settingsEnvProviderInvalidCopy` beside this hint — an
    // env-owned provider leg is ALWAYS a junk variable, so that sentence is
    // always there — and two sentences naming `EMBEDDING_PROVIDER` in one
    // description is the same fact twice on one screen.
    const issue = vectorSearchFieldIssue(vectorInputs(junkEnv), "provider");
    expect(issue).toEqual({
      copy: "Vector search needs an embedding provider before it can be turned on.",
      // DESCRIBED, not marked: the value is not this control's, and the store is
      // what applies the moment the variable is corrected (DW-398's boundary).
      invalid: false,
    });
    expect(issue?.copy).not.toContain("EMBEDDING_PROVIDER");
    // …while the CHECKBOX, which has no row of its own to lean on, still carries
    // it — the note is dropped from one hint, not from the screen.
    expect(missingCopy(junkEnv)).toContain(SETTINGS_VECTOR_PROVIDER_ENV_NOTE);
    // The stored-origin row is untouched by the suppression: same copy, and the
    // mark that says the owner's own value is the wrong one.
    expect(
      vectorSearchFieldIssue(
        vectorInputs({ ...junkEnv, providerOrigin: "stored" }),
        "provider",
      ),
    ).toEqual({
      copy: "Vector search needs an embedding provider before it can be turned on.",
      invalid: true,
    });
  });
});

// ---------------------------------------------------------------------------
// The ONE join both feeders read the variable through (DW-637)
// ---------------------------------------------------------------------------

describe("resolveEnvEmbeddingProvider — one expression, two feeders", () => {
  /**
   * The four states of `EMBEDDING_PROVIDER` as the WIRE serves them, plus the
   * pair no constructor mints. `ollama` is the stored selection throughout
   * because it is self-transporting and complete with only a model — so the
   * gate's verdict turns on the JOIN alone and on nothing else.
   */
  const states: Array<{
    name: string;
    filtered: WorkbenchSettingsPayload["envEmbeddingProvider"];
    invalid: string | null | undefined;
    joined: string | null;
    origin: "env" | "stored";
  }> = [
    { name: "unset", filtered: null, invalid: null, joined: null, origin: "stored" },
    // Blank/whitespace never reaches here: `nonEmpty` is the single raw reader in
    // `config.ts` and both fields arrive `null`, which is this row.
    { name: "omitted on the wire", filtered: null, invalid: undefined, joined: null, origin: "stored" },
    { name: "supported", filtered: "google", invalid: null, joined: "google", origin: "env" },
    { name: "junk", filtered: null, invalid: "deepseek", joined: "deepseek", origin: "env" },
    // The wire anomaly no constructor produces — the two fields are exclusive by
    // construction in `config.ts` — but which `WorkbenchSettingsPayload` can
    // carry. FILTERED FIRST means the PIN wins, matching `SettingsCanvas`'
    // explicit guard; the other order would refuse a perfectly good
    // `EMBEDDING_PROVIDER=openai` deployment on a stale invalid field.
    { name: "both (wire anomaly)", filtered: "openai", invalid: "deepseek", joined: "openai", origin: "env" },
  ];

  it.each(states)("answers $name identically on both halves", (state) => {
    expect(resolveEnvEmbeddingProvider(state.filtered, state.invalid)).toBe(state.joined);

    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      envEmbeddingProvider: state.filtered,
      ...(state.invalid === undefined ? {} : { envEmbeddingProviderInvalid: state.invalid }),
    };
    const browser = draftVectorInputs(settingsDraftFromPayload(payload), payload);
    expect(browser.provider).toBe(state.joined ?? "ollama");
    // Read off the JOINED value, not off the filtered field — or a junk variable
    // would report the store as the owner and the note above would never fire.
    expect(browser.providerOrigin).toBe(state.origin);

    // The ROUTE's half reaches the same join through the merge, and its VERDICT
    // is the pin: with `ollama` stored and complete, the turn-on is accepted
    // exactly when the join answers `null`, and refused for every value the
    // environment supplies — `google` for its missing endpoint and key,
    // `deepseek` at the provider leg itself.
    const stored = storedState({
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
      envEmbeddingProvider: state.filtered,
      envEmbeddingProviderInvalid: state.invalid ?? null,
    });
    expect(validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, stored).ok).toBe(
      canEnableVectorSearch(browser),
    );
    expect(validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, stored).ok).toBe(
      state.joined === null,
    );
  });

  it("normalises the payload's OPTIONAL half inside the helper", () => {
    // The asymmetry that made the two call sites spell the join differently in
    // the first place: the store's field is required, the payload's is optional.
    // `undefined` must answer `null`, because every caller reads `!== null` as
    // "the environment owns this" and `undefined` is not "unset".
    expect(resolveEnvEmbeddingProvider(null, undefined)).toBeNull();
    expect(resolveEnvEmbeddingProvider(null, null)).toBeNull();
    expect(Object.hasOwn(emptyPayload(), "envEmbeddingProviderInvalid")).toBe(false);
  });
});

describe("the RESEARCH half early-returns where the vector half joins (DW-637)", () => {
  it("refuses a junk research provider without representing it anywhere", () => {
    // The other side of the asymmetry the two wire fields' doc comments claim.
    // `envEmbeddingProviderInvalid` and `envResearchProviderInvalid` really are
    // mirrors — same shape, same optionality, same reason — but their CONSUMERS
    // cannot be, and this is the half that has nowhere to join TO.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      // Everything that would otherwise answer `true`: a credential in the store
      // AND one in the environment, both for the provider the draft resolves to.
      // So the `false` below is the early return and not an unconfigured page.
      hasTavilyApiKey: true,
      envResearchProviders: ["tavily"],
      envResearchProviderInvalid: "deepresearch",
    };
    const draft = settingsDraftFromPayload(payload);
    expect(draftResearchProviderConfigured(draft, payload)).toBe(false);

    // …and the REPORTED provider is untouched. This is the whole difference:
    // `resolveEnvEmbeddingProvider` carries a refused `EMBEDDING_PROVIDER` into
    // `VectorSearchInputs.provider`, where `string | null` can hold it and the
    // gate's first leg refuses it BY NAME. Here `draftResearchProvider` returns
    // a closed `ResearchProviderId` whose consumers branch on the value
    // (`=== "searxng"`, tavily vs serpApi key selection), so "deepresearch" has
    // no representation to be joined into and the default still stands.
    expect(draftResearchProvider(draft, payload)).toBe("tavily");

    // The same payload without the junk variable answers `true`, which is what
    // makes the early return the ONLY thing the assertion above is measuring.
    const { envResearchProviderInvalid: _junk, ...corrected } = payload;
    expect(
      draftResearchProviderConfigured(settingsDraftFromPayload(corrected), corrected),
    ).toBe(true);
    // `false` IS the join, collapsed: this predicate's only output is a boolean,
    // so "the environment named something unusable" and "no credential" are the
    // same answer — there is no second field for a refused value to ride on.
    expect(draftResearchProviderConfigured(draft, payload)).toBe(
      draftResearchProviderConfigured(settingsDraftFromPayload(emptyPayload()), emptyPayload()),
    );
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
    // The ONE frame the route mints since DW-330 — the request is sending the
    // flag on, which is the state the sentence describes.
    expect(refusal.ok === false && refusal.error).toContain(
      "Vector search is switched on, but it needs",
    );

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
      error:
        "Vector search is switched on, but it needs an API key before it can run. Turn it off, or supply what is missing.",
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
      error:
        "Vector search is switched on, but it needs an embedding provider before it can run. Turn it off, or supply what is missing.",
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
// What a flat text field of a settings PUT body means (DW-305/DW-328)
// ---------------------------------------------------------------------------

describe("flatTextFieldAction", () => {
  it("ignores an ABSENT field", () => {
    // Not in the body is not a request about the field: `PUT` is a patch here,
    // and a save from `/settings` carries nothing the Workbench pane owns.
    expect(flatTextFieldAction(undefined)).toBe("ignore");
  });

  it("CLEARS on `null` and on every blank string", () => {
    // The three blank forms an owner can produce — cleared box, spaces, an
    // explicit `null` from an API caller — all mean the same thing: drop the key
    // rather than store a blank the readers would have to special-case.
    for (const blank of [null, "", "   ", "\t", "\n  \t"]) {
      expect(flatTextFieldAction(blank)).toBe("delete");
    }
  });

  it("STORES a string TRIMMED", () => {
    // Every reader compares the stored value literally, so a padded id is one
    // nothing recognises — and `" http://x "` and `"http://x"` are the same
    // endpoint, only one of which is what the owner typed.
    expect(flatTextFieldAction("gpt-4o")).toEqual({ store: "gpt-4o" });
    expect(flatTextFieldAction("  gpt-4o  ")).toEqual({ store: "gpt-4o" });
    expect(flatTextFieldAction("\n http://x:11434 \t")).toEqual({
      store: "http://x:11434",
    });
  });

  it("LEAVES THE FIELD ALONE for a non-string, rather than deleting it (DW-328)", () => {
    // THE ARM NO REQUEST CAN REACH, and the reason this decision is a function
    // in a client-safe module rather than a branch inside `route.ts`: each of
    // the four fields answers 400 for a non-string well above the merge, so the
    // only way to execute this is to call it.
    //
    // It used to resolve every one of these to `""` and then read `""` as the
    // CLEAR — so the belt-and-braces fallback pointed AT erasing a field the
    // client never asked to clear. `ignore` is the inert answer: a body the door
    // should have refused now changes nothing.
    for (const malformed of [
      42,
      0,
      true,
      false,
      {},
      [],
      ["gpt-4o"],
      { toString: () => "gpt-4o" },
      Number.NaN,
    ]) {
      expect(flatTextFieldAction(malformed)).toBe("ignore");
    }
  });

  it("answers with EXACTLY THREE shapes, so a caller cannot forget an arm", () => {
    // `ignore` and `delete` are the two string literals; anything else is the
    // store instruction carrying the value. A fourth shape would be a fourth
    // branch every call site would have to grow.
    for (const value of [undefined, null, "", "  ", "x", 42, {}, []]) {
      const action = flatTextFieldAction(value);
      const shape =
        action === "ignore" || action === "delete" ? action : "store";
      expect(["ignore", "delete", "store"]).toContain(shape);
      if (shape === "store") {
        expect(typeof (action as { store: string }).store).toBe("string");
        expect((action as { store: string }).store.trim()).toBe(
          (action as { store: string }).store,
        );
        expect((action as { store: string }).store.length).toBeGreaterThan(0);
      }
    }
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

  /**
   * The two unmet legs in the frame the route mints. Scoping decides WHETHER the
   * gate refuses; since DW-330 it also decides which ACTION CLAUSE the one frame
   * carries, and nothing decides between two frames any more — the request sends
   * the flag on, so the switched-on words are the only ones there are.
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
    ).toEqual({ ok: false, error: INACTIVE_TRANSPORT_FLAT });
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
// DW-308 first picked the frame from `baseline.vectorSearchEnabled` — the flag
// as the STORE held it. That closed half the mismatch and opened the other half
// (DW-330): the client reads the DRAFT, so one draft that ticks the box and then
// breaks a leg got the switched-on hint beside the box and the turned-on
// sentence in the save bar, from the same request.
//
// The frame now follows the REQUEST's flag, which is what the draft becomes on
// the wire and is `true` for every path that reaches the refusal — so the route
// mints exactly one frame, and it is the one the ticked box already shows.
// `vectorSearchMissingCopy` stays the client's UNTICKED-box hint and stops being
// a sentence the route can send. No refusal boundary moves either way —
// `canEnableVectorSearch` is still the one rule.

describe("the refusal's FRAME follows the REQUEST's flag (DW-308, DW-330)", () => {
  /** `openai` with a model and nothing else: the endpoint and key legs unmet. */
  const openaiLegs = {
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
  } as const;

  it("answers the SWITCHED-ON frame for a request that TURNS THE SWITCH ON", () => {
    // The half DW-330 moved. The store held the flag off, so the old rule chose
    // "…before it can be turned on" — but the REQUEST is sending the flag on,
    // and the surface that sent it is already rendering the box ticked. The
    // sentence describes the settings the request is asking for, which is the
    // same thing the checkbox hint describes.
    const baseline = storedState({ vectorSearchEnabled: false, ...openaiLegs });

    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, baseline),
    ).toEqual({
      ok: false,
      error:
        "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.",
    });
  });

  it("answers ONE draft with ONE sentence, client half and route half (DW-330)", () => {
    // THE LEDGER'S SYMPTOM, composed. The owner ticks the box on a draft whose
    // legs are met, then breaks one — the checkbox hint reads the DRAFT and says
    // the switched-on sentence, while the save that same draft produces used to
    // buy a 400 saying the other one, because the STORE still held the flag off.
    // Both halves are computed here from one draft and compared byte for byte.
    const payload: WorkbenchSettingsPayload = {
      ...emptyPayload(),
      vectorSearchEnabled: false,
      embeddingProvider: "openai",
      embeddingModel: "text-embedding-3-small",
      embeddingBaseUrl: "https://embed.example",
      hasEmbeddingApiKey: true,
    };
    // Ticked, and then the endpoint emptied.
    const draft = {
      ...settingsDraftFromPayload(payload),
      vectorSearchEnabled: true,
      embeddingBaseUrl: "",
    };
    // What `SettingsCanvas` renders beside the ticked box — its `vectorInactive`
    // term, over the same `draftVectorInputs` the surface uses.
    const hint = vectorSearchInactiveCopy(draftVectorInputs(draft, payload));
    expect(hint).not.toBe("");

    // What the route answers the save of that same draft with. The store still
    // holds the flag OFF, which is exactly the situation the old rule framed as
    // "before it can be turned on".
    const refusal = validateWorkbenchSettingsPatch(
      { vectorSearchEnabled: true, embeddingBaseUrl: null },
      storedState({
        vectorSearchEnabled: false,
        embeddingProvider: "openai",
        embeddingModel: "text-embedding-3-small",
        embeddingBaseUrl: null,
        hasEmbeddingApiKey: true,
      }),
    ) as { ok: false; error: string };

    expect(refusal.ok).toBe(false);
    expect(refusal.error).toBe(hint);
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

    // ONE function on BOTH halves since DW-330: the stored flag no longer picks
    // between two mints, so a request that turns the switch on and a request
    // that breaks an already-on one are both `vectorSearchInactiveCopy` over
    // their own merged inputs.
    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, off),
    ).toEqual({ ok: false, error: vectorSearchInactiveCopy(inputs) });
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
    // …and since DW-330 they are refused with the SAME sentence. The request
    // sends the flag on in both, so the frame no longer moves with the store —
    // which is the whole of what changed. What did NOT change is either `ok`.
    expect(answers[0].error).toBe(answers[1].error);
    expect(answers[0].error).toContain("Vector search is switched on, but it needs");
    expect(answers[0].error).not.toContain("before it can be turned on");
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
    /**
     * The THIRD feeder's gate answer, where it legitimately differs from the
     * two above. Default: the same answer.
     *
     * `getVectorSearchSettings` is a sync cache read that cannot ask for the
     * Cloudflare `AI` binding, so it carries `hasWorkersAiBinding: null` and
     * applies NO binding leg (DW-225). A bindingless `workers-ai` therefore
     * reads as satisfiable there while both halves above refuse it — the one
     * declared divergence, spelled per situation rather than derived, so a new
     * row cannot inherit an excuse it has not earned.
     */
    runtimeEnabled?: boolean;
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
      runtimeEnabled: true,
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
      runtimeEnabled: true,
    },
    {
      name: "the environment forces workers-ai and the binding exists",
      env: { provider: "workers-ai" },
      config: { embeddingModel: "@cf/baai/bge-m3" },
      binding: true,
    },
    // The situation the two-feeder pin could NOT have caught (DW-552): the two
    // halves agreed with each other on `openai` and only the runtime dissented.
    // `EMBEDDING_PROVIDER` names nothing that can embed, over a stored config
    // that would otherwise satisfy every leg — so falling through to the store
    // is exactly the shadowing `getVectorSearchSettings` stopped doing.
    {
      name: "the environment forces a provider that cannot embed",
      env: { provider: "deepseek", key: "sk-env" },
      config: {
        embeddingProvider: "openai",
        embeddingBaseUrl: "https://embed.example",
        embeddingModel: "text-embedding-3-small",
        embeddingApiKey: "sk-1",
      },
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

      // …and the THIRD feeder of the same one rule (DW-552).
      //
      // Two halves is not enough: they are written from the same payload shape
      // and drift TOGETHER, which is precisely how a junk `EMBEDDING_PROVIDER`
      // came to read as satisfiable on both while `getVectorSearchSettings`
      // — the answer the embed path actually uses — refused it.
      //
      // The PROVIDER first, because it is the value every leg is judged
      // against: all three must name the same vendor, refused or not.
      const runtimeProvider = getVectorSearchSettings().provider;
      expect({ situation: situation.name, runtimeProvider }).toEqual({
        situation: situation.name,
        runtimeProvider: inputs.provider,
      });
      // Then the gate. `enabled` is the stored flag INTERSECTED with the
      // predicate, so the only way to read the predicate alone is to store the
      // flag on — done last, so nothing above sees a config it was not given.
      await store({ ...situation.config, vectorSearchEnabled: true });
      const runtime = getVectorSearchSettings().enabled;
      expect({ situation: situation.name, runtime }).toEqual({
        situation: situation.name,
        runtime: situation.runtimeEnabled ?? client,
      });
    });
  }

  it("refuses a junk EMBEDDING_PROVIDER on ALL THREE feeders, naming the provider leg", async () => {
    // The deployment the two-feeder pin waved through (DW-552): a variable that
    // names no embedding vendor over a stored config that satisfies every leg.
    process.env.EMBEDDING_PROVIDER = "deepseek";
    const config: AppConfig = {
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-1",
    };
    await store(config);

    const payload = getWorkbenchSettings(false);
    // The payload carries the two halves APART — the filtered field stays null
    // so `SettingsCanvas` leaves the select unpinned (DW-398), and the raw value
    // rides beside it so the rule can still read it.
    expect(payload.envEmbeddingProvider).toBeNull();
    expect(payload.envEmbeddingProviderInvalid).toBe("deepseek");

    const draft = settingsDraftFromPayload(payload);
    const inputs = draftVectorInputs(draft, payload);
    // …and the rule reads the JOIN, so the browser names the refused vendor
    // rather than the stored one it would otherwise fall through to.
    expect(inputs.provider).toBe("deepseek");
    expect(inputs.providerOrigin).toBe("env");
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(false);

    // The ROUTE, for the very body that draft would send.
    const refusal = validateWorkbenchSettingsPatch(
      { ...settingsSaveBody(draft), vectorSearchEnabled: true },
      workbenchSettingsStored(config, false),
    );
    expect(refusal).toEqual({
      ok: false,
      // The leg sentence AND the note that names the only thing which can lift
      // it (DW-636): the store here is a complete, supported OpenAI config, so
      // "supply what is missing" alone pointed at fields that are all supplied.
      // The FRAME is the switched-on one, because the request sends the flag on
      // (DW-330) — the same frame the ticked box beside it shows.
      error:
        "Vector search is switched on, but it needs an embedding provider before it can run. " +
        "Turn it off, or supply what is missing. " +
        SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
    });

    // …and the RUNTIME, whose answer the other two are being aligned TO.
    await store({ ...config, vectorSearchEnabled: true });
    expect(getVectorSearchSettings()).toMatchObject({
      provider: "deepseek",
      enabled: false,
    });
  });

  it("lets the PIN win over an invalid value on BOTH feeders if a payload carries both", async () => {
    // Neither builder can mint this pair — the invalid string is exactly what
    // the `isEmbeddingProvider` filter threw away, so it is non-null only where
    // the filtered field is `null`, and `workbenchSettingsStored` now reads the
    // filter ONCE to keep that structural. But `WorkbenchSettingsPayload` is a
    // WIRE type: `isWorkbenchSettingsPayload` does not enforce the exclusivity,
    // `storedState()` can construct the pair, and `SettingsCanvas` already
    // guards the disagreement explicitly ("where they disagree the PIN wins").
    // The two feeders get the same precedence from bare `??` ORDERING, which
    // until now was backed by a comment and nothing else — and getting it
    // backwards would refuse a perfectly good `EMBEDDING_PROVIDER=openai`
    // deployment on the strength of a stale invalid field.
    process.env.EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-env";
    const config: AppConfig = {
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
    };
    await store(config);

    // The BROWSER's half, off a payload the wire could deliver.
    const payload = {
      ...getWorkbenchSettings(false),
      envEmbeddingProviderInvalid: "deepseek",
    };
    const draft = settingsDraftFromPayload(payload);
    const inputs = draftVectorInputs(draft, payload);
    expect(inputs.provider).toBe("openai");
    expect(inputs.providerOrigin).toBe("env");
    expect(draftCanEnableVectorSearch(draft, payload)).toBe(true);

    // …and the ROUTE's, which reaches the same join through the merge: with
    // `openai` winning every leg is met and the turn-on is ACCEPTED. Had the
    // invalid value won, this would be the provider-leg refusal instead — so
    // the verdict itself is what pins the ordering.
    const storedSide = {
      ...workbenchSettingsStored(config, false),
      envEmbeddingProvider: "openai",
      envEmbeddingProviderInvalid: "deepseek",
    };
    expect(validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, storedSide).ok).toBe(
      true,
    );
  });

  it("refuses the vector legs on the WORKBENCH under a junk env, without locking the flat page out", async () => {
    // The fix has to bite where the surface can act and stay out of the way
    // where it cannot. Four rows on ONE deployment: `EMBEDDING_PROVIDER` names
    // nothing that can embed, the flag is ALREADY stored on (bytes that landed
    // before the variable was set, or a hand edit), and the store itself is a
    // complete OpenAI config.
    process.env.EMBEDDING_PROVIDER = "deepseek";
    const config: AppConfig = {
      vectorSearchEnabled: true,
      embeddingProvider: "openai",
      embeddingBaseUrl: "https://embed.example",
      embeddingModel: "text-embedding-3-small",
      embeddingApiKey: "sk-1",
    };
    const storedSide = workbenchSettingsStored(config, false);
    expect(storedSide.envEmbeddingProviderInvalid).toBe("deepseek");

    // (a) MOVES NOTHING the rule reads, so the gate is never entered (DW-219).
    // `turningOn` is false and `vectorInputsEqual(current, merged)` holds, so an
    // owner is not locked out of an unrelated edit by a variable they may be on
    // their way to fixing.
    expect(validateWorkbenchSettingsPatch({ llmTimeoutSeconds: 90 }, storedSide).ok).toBe(
      true,
    );
    // Re-asserting the SAME flag is not a turn-on either.
    expect(
      validateWorkbenchSettingsPatch({ vectorSearchEnabled: true }, storedSide).ok,
    ).toBe(true);

    // (b) MOVES an embedding field from the WORKBENCH, which reaches every
    // control — so the gate is entered, the join hands it `deepseek`, and the
    // provider leg is unmet. The SWITCHED-ON frame, not "before it can be turned
    // on": the flag is already ticked, so the sentence the save bar lands beside
    // it has to describe the state the surface is visibly in (DW-279/DW-308).
    // Its remedy — "Turn it off, or supply what is missing" — is the honest one
    // here: on this deployment "supply what is missing" means correcting
    // `EMBEDDING_PROVIDER`, and turning the switch off is the action the
    // Workbench itself can take.
    //
    // This is the row that FAILS with the join removed: without it the merge
    // reads `openai`, every leg is met, and the model edit saves 200 while
    // nothing embeds.
    expect(
      validateWorkbenchSettingsPatch(
        { embeddingModel: "text-embedding-3-large" },
        storedSide,
      ),
    ).toEqual({
      ok: false,
      // Same note under the SWITCHED-ON frame (DW-636) — the frame changes, the
      // notes do not, which is what `withLegNotes` guarantees for both callers.
      // It is also what makes the remedy quoted above SAYABLE: "correcting
      // `EMBEDDING_PROVIDER`" was the true reading of "supply what is missing"
      // on this deployment, and until now the sentence named no variable at all.
      error:
        "Vector search is switched on, but it needs an embedding provider before it can run. Turn it off, or supply what is missing. " +
        SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
    });

    // (c) THE SAME MOVE from the flat `/settings` page, which renders no
    // provider select — so it is scoped to the legs it can actually move, and
    // DW-303's suppression applies: `canEnableVectorSearch(current)` is now
    // `false`, so this request did not break anything, and the one unmet leg
    // (`provider`) is not one this surface names. The edit lands.
    //
    // The VERDICT here is `ok` with or without the join — before it, the gate
    // was never entered at all; after it, the gate is entered and the
    // suppression carries it. So this row is not a pin on the join itself: it is
    // the pin that the join did not turn DW-303's escape hatch into a lockout,
    // and it is the CONTRAST with (b) that shows the scoping is what does the
    // work.
    const legs = flatMovableVectorLegs({ embeddingModel: "text-embedding-3-large" });
    expect([...legs]).toEqual(["model"]);
    expect(
      validateWorkbenchSettingsPatch(
        { embeddingModel: "text-embedding-3-large" },
        storedSide,
        storedSide,
        legs,
      ).ok,
    ).toBe(true);
  });

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
    // One wording for one fact across both FREE-TEXT variables — a second would
    // be two sentences to keep in step.
    const copy = settingsEnvOverrideCopy("customBaseUrl", "https://env.example/v1");
    expect(copy).toContain("LLM_CUSTOM_BASE_URL=https://env.example/v1");
    expect(copy).toContain("wins at runtime");
    expect(settingsEnvOverrideCopy("model", "m")).toContain("EMBEDDING_MODEL=m");
    // …and the promise that makes it one sentence for both: the value typed in
    // an editable box is stored and waits its turn.
    expect(copy).toContain("applies only once that variable is unset");
  });

  it("gives the PINNED provider row its own sentence, without the queued promise (DW-507)", () => {
    // The provider row is a SELECT the pin disables (DW-398) and a save the
    // route refuses (DW-510), so "what you save here applies only once that
    // variable is unset" is a promise it cannot keep. Same first half — one
    // wording for "the environment set this and it wins" — honest second half.
    const pin = settingsEnvProviderPinCopy("workers-ai");
    expect(pin).toContain("EMBEDDING_PROVIDER=workers-ai");
    expect(pin).toContain("wins at runtime");
    expect(pin).not.toContain("What you save here");
    expect(pin).toContain("fixed until that variable is unset");
    // The ROUTE's refusal is the same family and names the same two things
    // (DW-510). Its reader is a stale tab or a CLI, with no row beside them
    // quoting the value — so "some variable is set" would be unactionable, and
    // the VALUE is what tells them what is embedding instead.
    const refusal = settingsEnvProviderPinRefusalCopy("workers-ai");
    expect(refusal).toContain("EMBEDDING_PROVIDER=workers-ai");
    expect(refusal).toContain("wins at runtime");
    expect(refusal).toContain("until that variable is unset");
  });

  it("says an unsupported EMBEDDING_PROVIDER out loud (DW-508)", () => {
    // `envEmbeddingProviderPair()` filters junk to `null`, so without this sentence
    // the row reads exactly as it does with no variable set while nothing
    // embeds. The rejected value is QUOTED, and the remedy names the
    // environment rather than this box.
    const invalid = settingsEnvProviderInvalidCopy("deepseek");
    expect(invalid).toContain("EMBEDDING_PROVIDER");
    expect(invalid).toContain("deepseek");
    expect(invalid).toContain("Nothing will embed until the environment is corrected");
    // NOT the pin's wording: a junk variable leaves this box editable, so it
    // must not claim the box is fixed.
    expect(invalid).not.toContain("fixed until");
  });

  it("accepts the optional `envEmbeddingProviderInvalid`, exactly as the research twin", () => {
    // OPTIONAL on both sides: it was added after the payload shipped, so an
    // older body that omits it is still a payload — the same rule
    // `envResearchProviderInvalid` already follows, which is what keeps every
    // existing fixture valid.
    const set = { ...emptyPayload(), envEmbeddingProviderInvalid: "deepseek" };
    expect(isWorkbenchSettingsPayload(set)).toBe(true);
    const { envEmbeddingProviderInvalid: _omitted, ...without } = set;
    expect(isWorkbenchSettingsPayload(without)).toBe(true);
    expect(
      isWorkbenchSettingsPayload({ ...emptyPayload(), envEmbeddingProviderInvalid: null }),
    ).toBe(true);
    // …but a WRONG shape is still refused: the row renders this string, and a
    // number would reach the sentence as `[object Object]`-grade nonsense.
    expect(
      isWorkbenchSettingsPayload({ ...emptyPayload(), envEmbeddingProviderInvalid: 42 }),
    ).toBe(false);
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
    // …and the route refuses the save over the same LEG and the same NOTE, in
    // the frame a request that sends the flag on gets (DW-330). The flag is put
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
      `${UNSUPPORTED_WORKERS_MODEL_INACTIVE} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
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

    // And the route, which reads the binding for itself, refuses over the SAME
    // leg and the SAME note. The frame differs, and correctly so (DW-330): the
    // client sentence above is the hint beside an UNTICKED box, while the
    // request below is asking to tick it — which is the state the route's one
    // frame describes, and the state that box is in the instant Save is pressed.
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(await put({ workbench: { vectorSearchEnabled: true } }));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // …and that is the sentence the box shows the moment it is ticked, over the
    // same inputs — the two halves are the two exported mints of one leg set,
    // never a second spelling.
    expect(
      vectorSearchInactiveCopy(
        draftVectorInputs({ ...draft, vectorSearchEnabled: true }, payload),
      ),
    ).toBe(
      `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
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

    // The route refuses the very patch that draft would send, over the same leg
    // and the same note — in the switched-on frame, because the patch sends the
    // flag on (DW-330).
    const { PUT } = await import("@/app/api/settings/route");
    const response = await PUT(
      await put({
        workbench: { ...settingsSaveBody(typed), vectorSearchEnabled: true },
      }),
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      `${UNSUPPORTED_WORKERS_MODEL_INACTIVE} ${SETTINGS_VECTOR_ENV_MODEL_NOTE}`,
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
    // Whitespace-only is a CLEAR too, and pinned HERE rather than only through
    // `flatTextFieldAction`'s own suite: this merge is what a save actually runs,
    // and a field that trimmed to nothing but stored `"   "` would be a stored
    // key every reader compares literally and none recognises.
    expect(applyWorkbenchSettings(existing, { firecrawlApiKey: "   " })).toEqual({
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

  it("persists the Intake and MinerU choices, and only on Save", () => {
    // The whole point of the draft is that picking Cloud in the select does
    // nothing until Save — so the two halves are tested together: the body the
    // draft produces, and the merge that body lands through.
    const seeded = settingsDraftFromPayload(emptyPayload());
    const body = settingsSaveBody({
      ...seeded,
      mineruMode: "cloud",
      mineruLocalBaseUrl: "http://127.0.0.1:9000",
      intakeKeepParsed: true,
    });
    expect(body).toMatchObject({
      mineruMode: "cloud",
      mineruLocalBaseUrl: "http://127.0.0.1:9000",
      intakeKeepParsed: true,
    });
    // Nothing was stored by building the body; the merge is what stores.
    expect(applyWorkbenchSettings({}, body)).toMatchObject({
      mineruMode: "cloud",
      mineruLocalBaseUrl: "http://127.0.0.1:9000",
      intakeKeepParsed: true,
    });
    // An untouched key never rides, so a keep-parsed tick cannot delete a
    // stored MinerU token.
    expect("mineruApiKey" in body).toBe(false);
    expect(
      applyWorkbenchSettings({ mineruApiKey: "mk-1" }, body).mineruApiKey,
    ).toBe("mk-1");
  });

  it("leaves the stored key alone for a NON-STRING, exactly as the flat half does", () => {
    // DW-623. `setText` used to collapse a non-string to `""` and then read `""`
    // as a CLEAR, so the `workbench` half of a body would have ERASED a stored
    // key where the flat half — through `flatTextFieldAction` — left it
    // untouched. Two answers to one question about one stored key, and the
    // destructive one belonged to the surface that holds the secrets.
    //
    // CAST THROUGH `unknown`, because the arm is unreachable BY CONSTRUCTION:
    // the patch type admits no non-string, and `validateWorkbenchSettingsPatch`
    // answers 400 for one well above this merge. That is exactly why it needs
    // executing directly — defence in depth nothing can reach is defence
    // nothing can check.
    //
    // THE STORE HERE HOLDS THE CLEAR-ON-SWITCH TRIO on purpose. Leaving
    // `embeddingProvider` alone is only half of inert: `embeddingProviderChanged`
    // normalises any non-string to `null`, so a junk provider against a stored
    // `"openai"` used to read as a move to auto-detect and DELETE the key and
    // the endpoint — the field itself survived while two others were destroyed.
    const existing: AppConfig = {
      embeddingModel: "text-embedding-3-small",
      customApiKey: "sk-1",
      embeddingProvider: "openai",
      embeddingApiKey: "sk-embed-1",
      embeddingBaseUrl: "https://api.openai.com/v1",
    };
    expect(
      applyWorkbenchSettings(existing, {
        embeddingModel: 42,
        customApiKey: { paste: "oops" },
        embeddingProvider: 42,
      } as unknown as WorkbenchSettingsPatch),
    ).toEqual(existing);
    // …the same answer the shared decision gives, which is the point: one rule,
    // not two implementations that agree today.
    expect(flatTextFieldAction(42)).toBe("ignore");
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
      // The route ANSWERED, so nothing about this save is unknown — and its
      // body was read, so the held version is untouched.
      verdict: "refused",
    });

    // A plain `Error` is not something `fetch` produces for a dead connection —
    // that is a `TypeError`, covered below. This one keeps the fallback.
    const thrown: SettingsFetch = async () => {
      throw new Error("NetworkError when attempting to fetch resource");
    };
    await expect(saveWorkbenchSettings({}, { fetchImpl: thrown })).resolves.toEqual({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
      // A thrown cause that is not an unconfirmed one: nothing was applied as
      // far as this client can tell, so the held version is still current —
      // the same answer the two booleans gave (DW-558).
      verdict: "refused",
    });

    const blank = stubFetch(() => ({ ok: false, status: 500, body: { error: "  " } })).impl;
    await expect(saveWorkbenchSettings({}, { fetchImpl: blank })).resolves.toEqual({
      status: "error",
      // A PLAIN 500 is the route's own verdict: it ran and it fell over. Not
      // widened to unknown — see the gateway case below.
      message: SETTINGS_SAVE_FAILED_COPY,
      verdict: "refused",
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
        // Nothing was read off a 2xx here: this is silence, not an unreadable
        // answer, and the two verdicts stay apart.
        verdict: "unconfirmed",
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
        verdict: "unconfirmed",
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
    expect(result).toEqual({
      status: "error",
      // THE THIRD SENTENCE (DW-554). Not the fallback: this branch clears the
      // held version precisely because the route MAY have run, so it is in no
      // position to say the settings were not saved.
      message: SETTINGS_SAVE_UNREADABLE_COPY,
      verdict: "unreadable",
    });
    expect(result.status === "error" && result.message).not.toBe(SETTINGS_SAVE_FAILED_COPY);
    // Asserted on its own too (DW-427): the body yielded no payload, so the
    // caller must clear the version it was holding even though something
    // answered. Which side of that line a cause falls on is the whole point,
    // and one field now states it.
    expect(result.status === "error" && result.verdict).toBe("unreadable");
  });

  it("treats an UNPARSEABLE 200 the same way — the route answered (DW-408)", async () => {
    // A bare literal rather than `stubFetch`, whose `json` cannot throw: the
    // whole case is a 2xx whose body fails to parse — truncated, or an HTML
    // page from something sitting in front of the route.
    //
    // Stated plainly, because it is easy to misread this case as the fix: a
    // `SyntaxError` is not an `unconfirmedCause`, so it reached this same
    // verdict before DW-408 too — by falling through the outer catch to
    // `thrownWriteFailure`'s fallback. What the `.catch` changes is that the
    // route's arrived answer is now EXPLICIT, decided on the shapeless-200
    // branch where it belongs, instead of being whatever the thrown fallback
    // happened to produce. This case pins the verdict; it does not flip it.
    const unparseable: SettingsFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw new SyntaxError("Unexpected token '<', \"<html>\"... is not valid JSON");
      },
    });
    const result = await saveWorkbenchSettings({}, { fetchImpl: unparseable });
    expect(result).toEqual({
      status: "error",
      message: SETTINGS_SAVE_UNREADABLE_COPY,
      verdict: "unreadable",
    });
    // Asserted on its own as well as inside the object: something answered, so
    // "nothing came back" is false here — and only the ability to re-seed the
    // draft was lost, not the knowledge of which failure this is. That is what
    // `"unreadable"` is for (DW-427). "The version I am holding is still good"
    // is the claim this branch must not make, so the fact gets its own NAME
    // rather than being folded into `"unconfirmed"`.
    expect(result.status === "error" && result.verdict).toBe("unreadable");
    // THREE VERDICTS, THREE SENTENCES (DW-554): neither of the other two.
    expect(result.status === "error" && result.message).not.toBe(
      unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
    );
    expect(result.status === "error" && result.message).not.toBe(SETTINGS_SAVE_FAILED_COPY);
  });

  /**
   * The three sentences, each read off a PRODUCER that mints it (DW-554).
   *
   * Beside the DW-408 loop below rather than as a table of constants, because
   * the claim is not that three strings differ — it is that the three verdicts
   * a real save can reach put three different things in front of the owner. The
   * `unreadable` one used to be the `refused` one, which flatly stated the save
   * had failed while the same result told the caller to drop its version
   * because the route may well have run.
   */
  it.each([
    [
      "refused",
      "an arrived refusal that served nothing",
      stubFetch(() => ({ ok: false, status: 400, body: {} })).impl,
      SETTINGS_SAVE_FAILED_COPY,
    ],
    [
      "unconfirmed",
      "a gateway",
      stubFetch(() => ({ ok: false, status: 502, body: {} })).impl,
      unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
    ],
    [
      "unreadable",
      "a shapeless 200",
      stubFetch(() => ({ ok: true, status: 200, body: { saved: true } })).impl,
      SETTINGS_SAVE_UNREADABLE_COPY,
    ],
  ] as const)(
    "answers %s from %s with its own sentence",
    async (verdict, _label, fetchImpl, sentence) => {
      const result = await saveWorkbenchSettings({}, { fetchImpl });
      expect(result).toEqual({ status: "error", message: sentence, verdict });
    },
  );

  it("keeps the three verdicts' sentences three (DW-554)", () => {
    // The pairwise claim the loop above cannot make from inside one row. All
    // three are shown beside the SAME Save button, and two of them clear the
    // held version — so a shared sentence would leave the owner unable to tell
    // "nothing was stored" from "nobody knows".
    const sentences = [
      SETTINGS_SAVE_FAILED_COPY,
      unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
      SETTINGS_SAVE_UNREADABLE_COPY,
    ];
    expect(new Set(sentences).size).toBe(3);
    // …and the new one says what it is for: the outcome, and the way out.
    expect(SETTINGS_SAVE_UNREADABLE_COPY).toContain("the outcome is unknown");
    expect(SETTINGS_SAVE_UNREADABLE_COPY).toContain("Reload");
    // No transport vocabulary — no Copy table contains any.
    expect(SETTINGS_SAVE_UNREADABLE_COPY).not.toMatch(/fetch|JSON|parse|200|status/i);
  });

  /**
   * The half the `SyntaxError` case cannot pin, and the one the `.catch` must
   * NOT swallow (DW-408).
   *
   * These three ARE unconfirmed causes, and thrown from `json()` they arrive
   * after a 200 status line — so a `.catch(() => null)` written without a guard
   * would quietly reclassify them as the route's arrived answer. That is a
   * behaviour flip with a consumer behind it, and since DW-427 it is no longer
   * the held version that flips — `SettingsCanvas.save` clears on `unreadable`
   * as well — but the SENTENCE. Calling a dead body read "arrived" tells the
   * owner their settings were not saved, which is the one claim nobody is in a
   * position to make: the request left and no verdict came back. The verdict
   * these three answer is unchanged from before DW-408, deliberately.
   */
  it.each([
    ["TimeoutError", Object.assign(new Error("signal timed out"), { name: "TimeoutError" })],
    [
      "AbortError",
      Object.assign(new Error("This operation was aborted"), { name: "AbortError" }),
    ],
    ["TypeError", new TypeError("Failed to fetch")],
  ])("still calls a 200 whose body read died on a %s unconfirmed", async (_label, cause) => {
    const impl: SettingsFetch = async () => ({
      ok: true,
      status: 200,
      json: async () => {
        throw cause;
      },
    });
    const result = await saveWorkbenchSettings({}, { fetchImpl: impl });
    expect(result).toEqual({
      status: "error",
      message: unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
      verdict: "unconfirmed",
    });
    // The line between the two verdicts, from the other side (DW-427). Both
    // clear the held version, so folding them together would look harmless —
    // but only ONE of them may put "the outcome is unknown" in front of the
    // owner, and that is this one.
    expect(result.status === "error" && result.verdict).toBe("unconfirmed");
  });

  it("still calls a REFUSAL whose body read died mid-stream a refusal (DW-557)", async () => {
    // The refusal-branch parse is unguarded, deliberately — and until now that
    // was argued in a comment with nothing executing it. A refusal STATUS
    // arrived, so the outcome is KNOWN whatever then happened to the body: the
    // route ran and declined, nothing was applied, and the version the caller
    // is holding is still current.
    //
    // The same `TypeError` off the same dead socket answers `"unconfirmed"` when
    // it kills a 2xx body read (the `it.each` above) and `"refused"` here. The
    // status line is the whole difference, which is why the guard belongs on one
    // parse and not the other.
    //
    // A bare literal rather than `stubFetch`, whose `json` cannot throw.
    const dyingRefusal: SettingsFetch = async () => ({
      ok: false,
      status: 400,
      json: async () => {
        throw new TypeError("Failed to fetch");
      },
    });
    const result = await saveWorkbenchSettings({}, { fetchImpl: dyingRefusal });
    expect(result).toEqual({
      status: "error",
      // `served` is empty — nothing was read out of that body — so the fallback
      // is shown. Not the unknown-outcome sentence: a status line came back.
      message: SETTINGS_SAVE_FAILED_COPY,
      verdict: "refused",
    });
    expect(result.status === "error" && result.message).not.toBe(
      unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
    );
  });

  it("still calls a GATEWAY whose body read died an unknown outcome (DW-557)", async () => {
    // The same dying body read, one status over — and the answer flips, because
    // the STATUS decides it and not the body. `refusedWriteFailure` reads a
    // gateway status as unconfirmed whatever the body did, so the refusal
    // branch's own `failedSave` must carry that through rather than calling
    // everything that arrived with a status line a refusal.
    //
    // Nothing executed this before: the DW-557 case above uses a 400, and the
    // gateway loop stubs a body that parses. The interaction of the two is
    // exactly the argued-but-unexecuted gap DW-557 exists to close.
    for (const status of UNCONFIRMED_STATUSES) {
      const dyingGateway: SettingsFetch = async () => ({
        ok: false,
        status,
        json: async () => {
          throw new TypeError("Failed to fetch");
        },
      });
      const result = await saveWorkbenchSettings({}, { fetchImpl: dyingGateway });
      expect([status, result]).toEqual([
        status,
        {
          status: "error",
          message: unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
          verdict: "unconfirmed",
        },
      ]);
    }
  });

  /**
   * The relay, and the one thing it is not allowed to do (DW-628).
   *
   * `code` exists so `SettingsCanvas` can stop exact-matching an English
   * sentence to decide whether the env pin refused it. It carries no verdict
   * meaning, which is exactly why it must never ride an UNKNOWN outcome: a
   * proxy answering 502 with a body of its own would otherwise be able to name
   * a refusal that may never have happened, and the surface would re-seed a
   * draft over a save that might have landed.
   */
  it("relays a refusal's `code` and attaches none to an unknown outcome (DW-628)", async () => {
    const pinned = stubFetch(() => ({
      ok: false,
      status: 400,
      body: {
        error: settingsEnvProviderPinRefusalCopy("workers-ai"),
        code: SETTINGS_ENV_PROVIDER_PIN_CODE,
      },
    })).impl;
    const refusal = await saveWorkbenchSettings({}, { fetchImpl: pinned });
    expect(refusal).toEqual({
      status: "error",
      message: settingsEnvProviderPinRefusalCopy("workers-ai"),
      verdict: "refused",
      code: SETTINGS_ENV_PROVIDER_PIN_CODE,
    });
    // …and the consumer answers off it.
    expect(
      refusal.status === "error" && settingsRefusalPinsEmbeddingProvider(refusal),
    ).toBe(true);

    // A GATEWAY carrying the very same body. The status decides the verdict, so
    // the code is dropped with it — an unknown outcome cannot be a named
    // refusal.
    for (const status of UNCONFIRMED_STATUSES) {
      const gateway = stubFetch(() => ({
        ok: false,
        status,
        body: {
          error: settingsEnvProviderPinRefusalCopy("workers-ai"),
          code: SETTINGS_ENV_PROVIDER_PIN_CODE,
        },
      })).impl;
      const result = await saveWorkbenchSettings({}, { fetchImpl: gateway });
      expect([status, result]).toEqual([
        status,
        {
          status: "error",
          message: unconfirmedWriteMessage(SETTINGS_SAVE_ACTION),
          verdict: "unconfirmed",
        },
      ]);
      expect([status, "code" in result]).toEqual([status, false]);
    }

    // A refusal that carries no code, and one whose `code` is not a string:
    // read exactly like `error`, so neither becomes one.
    for (const body of [
      { error: "No." },
      { error: "No.", code: 42 },
      { error: "No.", code: { pin: true } },
    ]) {
      const result = await saveWorkbenchSettings(
        {},
        { fetchImpl: stubFetch(() => ({ ok: false, status: 400, body })).impl },
      );
      expect([body, result]).toEqual([
        body,
        { status: "error", message: "No.", verdict: "refused" },
      ]);
    }
  });

  it("answers each verdict's held-version duty from ONE rule (DW-558)", async () => {
    // The action the canvas takes, pinned where the rule lives rather than only
    // through the DOM. `"refused"` KEEPS the version — nothing was applied, so
    // it is still current. The other two CLEAR it: the stored config may have
    // moved past it either way, and a 412 on the next save would deny a save
    // that landed.
    expect(verdictClearsHeldVersion("refused")).toBe(false);
    expect(verdictClearsHeldVersion("unconfirmed")).toBe(true);
    expect(verdictClearsHeldVersion("unreadable")).toBe(true);

    // Every member answered, read off the type rather than off this list — a
    // verdict added to the union with no answer here leaves a hole a reader can
    // see. The `never` default inside the helper is the other half: it makes
    // that hole fail to COMPILE instead of silently inheriting one of the two
    // answers, which is what a hand-written `||` of two names would have done.
    const ALL: readonly SettingsSaveVerdict[] = ["refused", "unconfirmed", "unreadable"];
    expect(ALL.map(verdictClearsHeldVersion)).toEqual([false, true, true]);
  });

  it("has no spelling left for a fourth verdict (DW-558)", async () => {
    // The state space, executed. Two independent booleans could express FOUR
    // states when exactly three are legal, and nothing forbade the fourth —
    // `{ unconfirmed: true, unreadable: true }` type-checked and meant nothing.
    // One discriminated field makes that unconstructible, and this case pins
    // both halves of the claim: every producing scenario answers exactly the
    // three keys, and all three verdicts are still reachable.
    const VERDICTS = ["refused", "unconfirmed", "unreadable"] as const;
    const producers: ReadonlyArray<readonly [string, SettingsFetch]> = [
      [
        "an arrived refusal",
        stubFetch(() => ({ ok: false, status: 400, body: { error: "No." } })).impl,
      ],
      ["a gateway", stubFetch(() => ({ ok: false, status: 502, body: {} })).impl],
      [
        "this route's own 503",
        stubFetch(() => ({
          ok: false,
          status: 503,
          body: { error: CONFIG_UNREADABLE_COPY },
        })).impl,
      ],
      [
        "a thrown plain Error",
        async () => {
          throw new Error("NetworkError when attempting to fetch resource");
        },
      ],
      [
        "a dropped connection",
        async () => {
          throw new TypeError("Failed to fetch");
        },
      ],
      [
        "an abort",
        async () => {
          throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
        },
      ],
      ["a shapeless 200", stubFetch(() => ({ ok: true, status: 200, body: { saved: true } })).impl],
      [
        "an UNPARSEABLE 200",
        async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new SyntaxError("Unexpected token '<'");
          },
        }),
      ],
      [
        "a 200 whose body read died",
        async () => ({
          ok: true,
          status: 200,
          json: async () => {
            throw new TypeError("Failed to fetch");
          },
        }),
      ],
    ];

    const seen = new Set<string>();
    for (const [label, fetchImpl] of producers) {
      const result = await saveWorkbenchSettings({}, { fetchImpl });
      expect([label, result.status]).toEqual([label, "error"]);
      if (result.status !== "error") continue;
      // Exactly three keys: no leftover boolean, and no second field a fourth
      // state could be assembled out of.
      //
      // `code` is destructured OFF rather than added to the expected list
      // (DW-628). It is a RELAY of the server's own name for a refusal, not a
      // state: nothing here interprets it, `verdictClearsHeldVersion` never
      // reads it, and widening the list would quietly retire the guard this
      // case exists to be. What must stay true is that the STATE is spelled by
      // three keys and no more.
      const { code: _relayed, ...state } = result;
      expect([label, Object.keys(state).sort()]).toEqual([
        label,
        ["message", "status", "verdict"],
      ]);
      expect([label, VERDICTS.includes(result.verdict)]).toEqual([label, true]);
      seen.add(result.verdict);
    }
    // …and the union is no wider than the producers: every name in it is one
    // some scenario above actually answers.
    expect([...seen].sort()).toEqual([...VERDICTS].sort());

    // The TYPE-LEVEL half of the same claim, which no runtime assertion can
    // reach: the fourth state is not merely unproduced, it is unspellable.
    // `@ts-expect-error` FAILS `tsc` if either construction ever compiles
    // again, which is the actual regression to catch — a boolean quietly
    // re-added beside `verdict`, or a verdict name outside the union.
    void ((): SettingsSaveResult => ({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
      verdict: "unconfirmed",
      // @ts-expect-error the old boolean pair is gone; `{ unconfirmed: true,
      // unreadable: true }` was the fourth state and has no spelling left.
      unreadable: true,
    }));
    void ((): SettingsSaveResult => ({
      status: "error",
      message: SETTINGS_SAVE_FAILED_COPY,
      // @ts-expect-error a verdict must be one of the three the union names.
      verdict: "unknown",
    }));
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
    const storeUnreadable = stubFetch(() => ({
      ok: false,
      status: 503,
      body: { error: CONFIG_UNREADABLE_COPY },
    })).impl;
    await expect(
      saveWorkbenchSettings(
        { chatModel: "gpt-4o" },
        { fetchImpl: storeUnreadable, version: "w1:2-abc" },
      ),
    ).resolves.toEqual({
      status: "error",
      message: CONFIG_UNREADABLE_COPY,
      // `"refused"`, and NOT `"unreadable"`: that verdict is about a 2xx whose
      // body yielded no payload. This is a refusal status the route chose,
      // arrived and read, over a write it declined before merging anything — so
      // the version the caller is holding is still current and must survive.
      verdict: "refused",
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
      // An arrived refusal applied nothing, so the held version is still current.
      verdict: "refused",
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
      verdict: "refused",
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

  it("REQUIRES both ENV-KEY halves, on the same argument (DW-66)", () => {
    // The env half is not decoration beside the stored half. A payload carrying
    // `hasCustomApiKey: false` without `envCustomApiKey` renders "No key is
    // stored." beside a working `LLM_CUSTOM_API_KEY` — a WRONG answer, not a
    // degraded one — and defaulting the env flag the other way announces a
    // variable nobody set. So absence is refused and the surface shows its
    // failed-read sentence instead of guessing.
    //
    // Worth its own case because every fixture in this file carries both
    // fields, so nothing else here exercises the refusal: each existing case
    // only proves the ACCEPTING half of the guard.
    const { envCustomApiKey: _custom, ...withoutCustom } = emptyPayload();
    expect(isWorkbenchSettingsPayload(withoutCustom)).toBe(false);
    const { envFirecrawlApiKey: _firecrawl, ...withoutFirecrawl } = emptyPayload();
    expect(isWorkbenchSettingsPayload(withoutFirecrawl)).toBe(false);

    for (const field of ["envCustomApiKey", "envFirecrawlApiKey"] as const) {
      for (const value of [null, "false", 0, 1]) {
        expect(
          isWorkbenchSettingsPayload({ ...emptyPayload(), [field]: value }),
          `${field}=${String(value)}`,
        ).toBe(false);
      }
      // Both booleans are accepted: the guard is about TYPE, not about which
      // deployment this is — an unset variable is a legitimate `false`.
      for (const value of [true, false]) {
        expect(
          isWorkbenchSettingsPayload({ ...emptyPayload(), [field]: value }),
          `${field}=${String(value)}`,
        ).toBe(true);
      }
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

    // A save that changed NOTHING still rotates the served version, and a save
    // that changed only a SECRET serves a version bearing no trace of it. A
    // content-derived version could do neither — it moved only when content
    // moved, and it moved BECAUSE the secret did. That is the whole difference.
    const held = await storedVersion();
    await store({ provider: "openai", ...secrets });
    expect(await storedVersion()).not.toBe(held);

    const swapped = {
      firecrawlApiKey: "fc-secret-two",
      customApiKey: "sk-custom-two",
      embeddingApiKey: "sk-embed-two",
    };
    await store({ provider: "openai", ...swapped });
    const second = (await (await GET()).json()) as { version: string };
    expect(second.version).toMatch(/^s1:[0-9a-f]{32}$/);
    const secondText = JSON.stringify(second);
    for (const secret of Object.values(swapped)) {
      expect(secondText).not.toContain(secret);
    }
    expect(secondText).not.toContain(objectVersion({ provider: "openai", ...swapped }));
  });

  it("honours the stamp only while the BYTES it was stamped for are still there", async () => {
    // What the stamp promises, end to end at `GET` (DW-372). The token is
    // rotated by SAVES, but it is BOUND to the config it was stamped over, so a
    // change that did not go through `saveConfig` is not invisible to the guard —
    // it reads as unstamped.
    //
    // The BENIGN case is a key re-order: `.llm-wiki-config.json` is
    // hand-editable, and a text editor that re-serialized it must not be
    // reported as a change nobody made. The digest is canonical over sorted
    // keys, so the token stands — the same answer the scheme always gave here,
    // now earned rather than structural.
    await store({ provider: "openai", model: "gpt-4o" });
    const { GET } = await import("@/app/api/settings/route");
    const first = (await (await GET()).json()) as { version: string };
    const digest = await heldDigest();

    await handWrite({
      model: "gpt-4o",
      provider: "openai",
      [DIGEST_KEY]: digest,
      [VERSION_KEY]: first.version,
    });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      first.version,
    );

    // A hand edit that actually CHANGES a value is the case that moved. It used
    // to leave the version standing — so a draft seeded before it saved straight
    // over it — and that is exactly the rollback shape DW-372 names: a
    // pre-DW-272 build round-trips the token verbatim while the bytes move. The
    // stored digest no longer matches, so the store now reads as UNSTAMPED and
    // the stale draft is refused instead.
    await handWrite({
      provider: "anthropic",
      model: "claude",
      [VERSION_KEY]: first.version,
      [DIGEST_KEY]: digest,
    });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      UNSTAMPED_CONFIG_VERSION,
    );

    // A hand edit that DROPS the token — and one that drops only the digest,
    // which is every store a pre-DW-272 build wrote — errs the same safe way.
    await handWrite({ provider: "anthropic", model: "claude" });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      UNSTAMPED_CONFIG_VERSION,
    );
    await handWrite({
      provider: "anthropic",
      model: "claude",
      [VERSION_KEY]: first.version,
    });
    expect(((await (await GET()).json()) as { version: string }).version).toBe(
      UNSTAMPED_CONFIG_VERSION,
    );

    // …and it is RECOVERABLE: the next save through the API re-stamps, and the
    // read after it honours the fresh token.
    await store({ provider: "anthropic", model: "gpt-4o" });
    const last = (await (await GET()).json()) as { version: string };
    expect(last.version).toMatch(/^s1:[0-9a-f]{32}$/);
    expect(last.version).not.toBe(first.version);
    expect(last.version).not.toBe(UNSTAMPED_CONFIG_VERSION);
  });

  it("serves NO digest, and no function of the stored bytes, on the boundary", async () => {
    // The digest exists to be CHECKED, never SERVED (AD-23 / DW-372). It is a
    // function of every byte in the store, `firecrawlApiKey` included, so if it
    // ever crossed this boundary it would be the very leak the opaque stamp was
    // introduced to stop.
    await store({ provider: "openai", firecrawlApiKey: "fc-secret" });
    const { GET } = await import("@/app/api/settings/route");
    const text = await (await GET()).text();

    expect(text).not.toContain(await heldDigest());
    expect(text).not.toContain(DIGEST_KEY);
    expect(text).not.toContain(VERSION_KEY);
    expect(text).not.toContain("fc-secret");
    expect(((await (await GET()).json()) as { version: string }).version).toMatch(
      /^s1:[0-9a-f]{32}$/,
    );
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
    // The one frame the route mints (DW-330): the request sends the flag on.
    expect(body.error).toContain("Vector search is switched on, but it needs");
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
    expect(body.error).toBe(UNSUPPORTED_WORKERS_MODEL_INACTIVE);
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
      "Vector search is switched on, but it needs a model id outside the Cloudflare Workers AI @cf/ namespace before it can run. Turn it off, or supply what is missing.",
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
      UNSUPPORTED_WORKERS_MODEL_INACTIVE,
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
      `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_NOTE}`,
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
    // The digest is carried forward with the token, which is what a text editor
    // rewriting the file does — it re-serializes the whole object, both reserved
    // keys included. And it still matches, because the digest is canonical over
    // sorted keys and nothing but the order moved.
    const digest = await heldDigest();
    await handWrite({
      model: "gpt-4o",
      provider: "openai",
      [DIGEST_KEY]: digest,
      [VERSION_KEY]: seeded,
    });

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(200);
  });

  it("REFUSES a save over a hand edit that CHANGED a value (DW-372)", async () => {
    // The sign flipped on the row above, and the behaviour DW-372 bought. The
    // guard is still defined over saves, but the token is bound to the bytes it
    // was stamped for — so a hand edit between the seed and the save unstamps
    // the store, and the stale draft is refused rather than landing over content
    // no one checked. The derived version refused this too; the difference is
    // that the value on the boundary is still an opaque token (AD-23).
    await store({ provider: "openai" });
    const { GET, PUT } = await import("@/app/api/settings/route");
    const seeded = ((await (await GET()).json()) as { version: string }).version;
    const digest = await heldDigest();

    // Both reserved keys PRESERVED — the rollback shape, where a build that
    // knows nothing of either key round-trips them verbatim while the config
    // moves underneath.
    await handWrite({
      provider: "anthropic",
      [VERSION_KEY]: seeded,
      [DIGEST_KEY]: digest,
    });

    const response = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, seeded));

    expect(response.status).toBe(WRITE_CONFLICT_STATUS);
    // A refused save writes NOTHING: the hand edit stands exactly as made.
    expect(await stored()).toEqual({ provider: "anthropic" });

    // …and the owner has a way through: a draft re-seeded from `GET` holds the
    // sentinel, which is what the unstamped store now serves, so the next save
    // lands and re-stamps.
    const reseeded = ((await (await GET()).json()) as { version: string }).version;
    expect(reseeded).toBe(UNSTAMPED_CONFIG_VERSION);
    const retry = await PUT(await put({ workbench: { chatModel: "gpt-4o" } }, reseeded));
    expect(retry.status).toBe(200);
    expect(await stored()).toEqual({ provider: "anthropic", chatModel: "gpt-4o" });
    expect(await storedVersion()).toMatch(/^s1:[0-9a-f]{32}$/);
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

  it("mints ONE frame end to end, whatever the store held (DW-308, DW-330)", async () => {
    // End to end against the real store, because the two paths reach the gate
    // differently — on the flat-legacy path the object the patch merges onto has
    // already had the flat field folded into it — and because the FLAG the frame
    // now follows is the request's, which is the one thing both paths carry.
    //
    // Off the Workers runtime the binding leg joins the sentence, which is what
    // makes this case pin the NOTES surviving the reframe as well.
    const { PUT } = await import("@/app/api/settings/route");

    // Stored OFF, and the request asks to turn it on. The old rule read the
    // STORE here and answered "before it can be turned on"; the request is
    // sending the flag on, and that is the box the owner is looking at.
    await store({ embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" });
    const turningOn = await PUT(await put({ workbench: { vectorSearchEnabled: true } }));
    expect(turningOn.status).toBe(400);
    expect(((await turningOn.json()) as { error: string }).error).toBe(
      `Vector search is switched on, but it needs the Cloudflare AI binding before it can run. Turn it off, or supply what is missing. ${SETTINGS_VECTOR_BINDING_NOTE}`,
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
    // Two legs and a note, in leg order — and the SAME frame as the turn-on
    // above, differing only in the action clause the flat path earns (DW-329).
    expect(((await alreadyOn.json()) as { error: string }).error).toBe(
      `Vector search is switched on, but it needs ${UNSUPPORTED_WORKERS_MODEL_LIST} and the Cloudflare AI binding before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings. ${SETTINGS_VECTOR_BINDING_NOTE}`,
    );
    // Nothing written either way — no refusal boundary moved.
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
      // The two halves ride beside the OR (DW-66). The OR is unchanged — env
      // first, then the store — while the Settings row, which used to be its
      // only reader, now needs to know which SIDE the credential came from:
      // `Remove` deletes the stored one and cannot touch the variable.
      hasEnvKey: false,
      hasStoredKey: true,
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
    // The API + MCP pane holds the same posture (DW-445). Its one network call
    // is `probeLoopbackApiPane`, which goes through the shared loopback client
    // and names its URLs in `v1-contract.ts` — the pane names none of its own.
    const apiPane = await readComponent("SettingsApiMcpPane.tsx");
    expect(apiPane).not.toMatch(/[^a-zA-Z]fetch\(/);
    expect(apiPane).not.toContain('"/api/');
    expect(canvas.match(/saveWorkbenchSettings\(/g) ?? []).toHaveLength(1);
    // TWO reads, and the second is a decision rather than an accident (DW-555).
    // One is the mount read that seeds the payload and the draft. The other is
    // the recovery read inside `save`, which fires ONLY when NO version is held
    // and adopts the answered VERSION alone — the draft is left exactly as the
    // owner typed it. A third would be the one to worry about: any read that
    // re-seeded the draft would throw away every unsaved edit, which is the
    // whole reason this surface has no refresh.
    expect(canvas.match(/fetchWorkbenchSettings\(/g) ?? []).toHaveLength(2);
    expect(canvas).toContain("let version = payloadRef.current?.version;");
    // FALSINESS on both the trigger and the adoption, which is the rule
    // `saveWorkbenchSettings` gates the `If-Match` header on. `null` and `""`
    // are spellings of absence `isWorkbenchSettingsPayload` accepts, so an
    // `=== undefined` test here would walk a held `null` past the recovery and
    // an `!== undefined` adoption would write one back and disable it for good.
    expect(canvas).toContain("if (!version) {");
    expect(canvas).toContain("if (answered) {");
    expect(canvas).not.toContain("version === undefined");
    expect(canvas).not.toContain("answered !== undefined");
    // `setSaving(false)` cannot be SKIPPED (DW-67/DW-626). Both request helpers
    // are total — they catch their own transport failures and answer a result —
    // so nothing in `save` throws today and no test can drive this branch. It is
    // pinned as source because of what a stuck flag now costs: before the freeze
    // a leaked `saving` only disabled the Save button, and now it makes the
    // WHOLE form permanently inert, announcing that a save is in progress with
    // no error beside it, escapable only by the reload that destroys every
    // unsaved edit. A helper that grows a throw later must not be able to strand
    // the surface.
    expect(canvas).toMatch(/\} finally \{\s*\n\s*setSaving\(false\);\s*\n\s*\}/);
    // …and exactly one place CALLS it — the semicolon is what keeps the
    // component's own prose about the guard out of this count — so the
    // `finally` is the whole answer rather than a second one racing the
    // straight-line path it replaced.
    expect(canvas.match(/setSaving\(false\);/g)).toHaveLength(1);
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
    // decides what a refusing surface adds to it — including for the rows
    // that have no hint, where the refusal sentence becomes the whole
    // description rather than being dropped for want of something to append to.
    expect(canvas).toContain(
      'aria-describedby={describedBy(hint ? hintId : undefined)}',
    );
    expect(canvas).toContain(
      'aria-describedby={describedBy(field("vectorSearchEnabled-hint"))}',
    );
    expect(canvas).toContain('id={field("vectorSearchEnabled-hint")}');
    // Every control the surface refuses routes its description through
    // `describedBy`, which APPENDS the save bar's refusal sentence to the
    // control's own hint — `aria-describedby` takes a space-separated list, so
    // the hint is kept rather than replaced. TEN call sites in the canvas:
    // the two provider pickers, the vector switch, `textRow`, `secretRow`
    // (DW-307) and its `Remove` button, the Deep Research provider picker —
    // whose hint carries both the env-pinned note and the "this provider has no
    // credential" refusal — and Epic 7's three: Intake's keep-parsed checkbox,
    // MinerU's enable checkbox and MinerU's mode select, whose description IS
    // the orange leave-the-machine warning and so must be announced rather than
    // merely rendered beside the control.
    //
    // `describedBy` now answers for TWO refusals, not one (DW-67/DW-626): a
    // read-only deployment and a save in flight both make the whole form inert,
    // and both append whichever sentence the bar note is showing. That is what
    // keeps the freeze from being a surface that silently stops taking
    // keystrokes for up to two request deadlines — the same "dimmed, with no
    // reason" gap `aria-disabled` was adopted to close, arriving from time
    // rather than from configuration. `Remove` joined the list for exactly that
    // reason: under `readOnly` it is not rendered at all, but during a save it
    // is on screen and refusing, so it has to say so.
    expect(canvas.match(/aria-describedby=\{describedBy\(/g)).toHaveLength(10);
    // Epic 8's THREE: the API switch, the unauthenticated-access switch whose
    // description is the orange "anything on this machine can read the wiki"
    // warning, and — since DW-67 — the Generate-token button, which is refused
    // in place during a save rather than removed. `describedBy` is passed down
    // from the canvas, so all three append the same sentence.
    const apiPane = await readComponent("SettingsApiMcpPane.tsx");
    expect(apiPane.match(/aria-describedby=\{describedBy\(/g)).toHaveLength(3);
    // Named for the BAR, not for read-only: one span, three sentences — the
    // standing promise, the read-only refusal and the in-flight refusal.
    expect(canvas).toContain('const barNoteId = field("bar-note");');
    expect(canvas).toContain('<span className="wb-set-bar-note" id={barNoteId}>');
    // …and the third sentence is actually wired, rather than the note being
    // renamed while it still says only two things.
    expect(canvas).toContain("SETTINGS_SAVING_NOTE_COPY");
    // Each row builder wires its own hint; none of them renders a bare span.
    // A ratio, so it holds per file — the API + MCP pane carries its own three.
    for (const source of [canvas, apiPane]) {
      const hintSpans = [...source.matchAll(/<span className="wb-set-hint"/g)];
      const identified = [...source.matchAll(/<span className="wb-set-hint" id=/g)];
      expect(identified.length).toBe(hintSpans.length);
    }
    // …and an id is not a wire (DW-634). The pane MINTED `apiToken-hint` and
    // then referenced it from nothing, so the env-pinned sentence and the
    // "copy it now, it is never shown again" sentence — the most consequential
    // one on the pane — were announced to nobody, while the check above passed
    // because the span did carry an id. Every `-hint` id the pane mints must
    // therefore appear a SECOND time, in some control's `aria-describedby`.
    const minted = [...apiPane.matchAll(/id=\{field\("([\w-]+-hint)"\)\}/g)].map(
      (match) => match[1],
    );
    expect(minted).toEqual([
      "apiEnabled-hint",
      "allowUnauthenticated-hint",
      "apiToken-hint",
    ]);
    for (const hint of minted) {
      // Two or more: the `id={…}` that declares it, plus at least one reference.
      // The token row's reference is the shared `tokenDescribedBy` value that
      // Generate, Show and Copy all take, which is why this counts occurrences
      // rather than insisting on a literal `describedBy(field("…"))` call.
      const references = [
        ...apiPane.matchAll(new RegExp(`field\\("${hint}"\\)`, "g")),
      ];
      expect(references.length).toBeGreaterThanOrEqual(2);
    }
    // The token row's three controls share ONE two-id value — the row label
    // first, then the row hint. Built once so Generate (through `describedBy`,
    // which appends the bar's refusal), Show and Copy cannot drift apart.
    expect(apiPane).toContain(
      'const tokenDescribedBy = `${field("apiToken-label")} ${field("apiToken-hint")}`;',
    );
    expect(apiPane.match(/aria-describedby=\{tokenDescribedBy\}/g)).toHaveLength(2);
    expect(apiPane).toContain("aria-describedby={describedBy(tokenDescribedBy)}");
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
    expect(canvas).not.toMatch(/(?<![-\w])disabled=\{editRefused/);
    expect(canvas).not.toMatch(/(?<![-\w])disabled=\{vectorRefused/);
    // Purpose and Schema use ordinary disabled buttons only when there is no
    // current Wiki, plus Save's existing deliberate exception. Read-only
    // provider controls remain focusable and explanatory.
    const disabledProps = [...canvas.matchAll(/(?<![-\w])disabled=\{/g)];
    expect(disabledProps).toHaveLength(3);
    expect(canvas.match(/disabled=\{!hasWiki\}/g)).toHaveLength(2);
    expect(canvas).toContain("disabled={saving || payload.readOnly || !dirty}");

    // THE STANDING REFUSAL, named once for the whole surface (DW-67/DW-626):
    // read-only, OR a save in flight. `save` captures `draftRef.current` before
    // up to two `REQUEST_TIMEOUT_MS` awaits — the DW-555 recovery read, then the
    // PUT — and a landed save re-seeds the draft from the answered payload, so a
    // keystroke landing in that window is neither sent nor kept. The form
    // therefore goes INERT for the whole window rather than accepting edits it
    // will drop. Keyed off `saving` and nothing narrower, because
    // `setSaving(true)` is the first thing `save` does and the recovery read is
    // inside the window.
    expect(canvas).toContain("const editRefused = stored.readOnly || saving;");
    // Every control that refuses on THAT term alone carries the attribute: the
    // LLM provider picker, `secretRow`'s Remove button, and Epic 7's Intake
    // keep-parsed checkbox, MinerU enable checkbox and MinerU mode select.
    // Counted rather than enumerated so a new refusable control cannot be added
    // without this number moving — the vector switch has its own compound
    // predicate below. `Remove` is the one that JOINED at DW-67: `readOnly`
    // takes it off screen outright, but a save is a moment, and a button that
    // vanishes and returns is a layout jump and a lost focus target.
    expect(canvas.match(/aria-disabled=\{editRefused \|\| undefined\}/g)).toHaveLength(
      5,
    );
    // …and no control still refuses on the read-only half alone, which would be
    // a control the freeze silently walks past.
    expect(canvas).not.toMatch(/aria-disabled=\{stored\.readOnly \|\| undefined\}/);
    // Epic 8's THREE ride in the pane (DW-445): the API switch, the
    // unauthenticated-access switch, and the Generate-token button. They refuse
    // on the canvas's own term, handed down as a PROP rather than re-derived —
    // the pane owns no draft and no save, so a second predicate there would be a
    // second answer to one question.
    const apiPane = await readComponent("SettingsApiMcpPane.tsx");
    expect(apiPane.match(/aria-disabled=\{editRefused \|\| undefined\}/g)).toHaveLength(
      3,
    );
    expect(apiPane).toContain("editRefused: boolean;");
    expect(apiPane).not.toMatch(/aria-disabled=\{stored\.readOnly \|\| undefined\}/);
    expect(apiPane).not.toMatch(/(?<![-\w])disabled=\{/);
    expect(canvas).toContain("editRefused={editRefused}");
    // TWO controls refuse on the standing term OR an env pin: the Deep Research
    // provider select, and the embedding provider select (DW-398). Both are
    // selects whose move is DESTRUCTIVE beyond the field itself — the embedding
    // one blanks the stored endpoint and key — so under a variable that already
    // decides the answer they announce themselves unavailable rather than
    // inviting an edit that can only take something away.
    expect(
      canvas.match(/aria-disabled=\{editRefused \|\| envPinned \|\| undefined\}/g),
    ).toHaveLength(2);
    expect(canvas.match(/if \(editRefused \|\| envPinned\) return;/g)).toHaveLength(2);
    expect(canvas).toContain("aria-disabled={vectorRefused || undefined}");
    // …and each with a handler that COMMITS NOTHING when the control is
    // refused. That early return is the whole refusal: React re-applies a
    // controlled value to the DOM after a change event that set no state, so no
    // control needs putting back by hand. `settings-read-only.test.tsx` and
    // `settings-save-in-flight.test.tsx` are what observe the result — this only
    // pins that the handler still guards.
    //
    // BOTH the attribute and the guard, on every value-bearing control. The
    // attribute is what a sighted owner and a screen reader run into; the guard
    // is what makes the freeze enforceable at all, since neither `readOnly` nor
    // `aria-disabled` stops a programmatic change event — so a freeze pinned
    // only by the attribute is a freeze the draft does not have.
    expect(canvas).not.toContain("event.currentTarget");
    expect(canvas).toContain("if (editRefused) return;");
    expect(canvas).not.toContain("if (stored.readOnly) return;");
    expect(apiPane.match(/if \(editRefused\) return;/g)).toHaveLength(3);
    expect(apiPane).not.toContain("if (stored.readOnly) return;");
    // The two text builders freeze the BOX as well as the handler — `readOnly`
    // rather than `disabled`, so the value stays reachable and readable.
    expect(canvas).toContain("readOnly={editRefused || pinned}");
    expect(canvas).toContain("readOnly={editRefused || removing}");
    expect(canvas).toContain("if (editRefused || pinned) return;");
    // …but `aria-invalid` is NOT withdrawn by the freeze: a momentary request
    // does not make a wrong value unfixable, and flickering the mark off and
    // back around every save would be noise. It still keys off the two
    // PERMANENT dead ends — a read-only deployment and an env pin.
    expect(canvas).toContain(
      "aria-invalid={(invalid && !stored.readOnly && !pinned) || undefined}",
    );
    expect(canvas).not.toMatch(/aria-invalid=\{[^}]*editRefused/);
    expect(canvas).toContain("if (vectorRefused) return;");
    // The checkbox refuses on its WHOLE predicate — the standing refusal and
    // provider-unsupported alike — named once so the attribute that announces
    // the refusal and the handler that enforces it cannot drift apart. Composed
    // FROM `editRefused` rather than restating its read-only half, so the freeze
    // reaches the vector switch by construction.
    expect(canvas).toMatch(
      /const vectorRefused =\s*\n?\s*editRefused \|\| \(!vectorAllowed && !values\.vectorSearchEnabled\);/,
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
    // DW-531's five: the Graph and Review card controls. `readOnly` no longer
    // sets `disabled` on any of them, so without this rule all five render at
    // full opacity with a pointer cursor while refusing every click — and no
    // mounted test can see it, because jsdom applies no stylesheet. `disabled`
    // stays for their transient states, so the face has to be reachable through
    // both selectors.
    expect(css).toMatch(/\.wb-todos-btn\[disabled\] \{[^}]*cursor: default;/);
    expect(css).toMatch(
      /\.wb-todos-btn\[aria-disabled="true"\] \{[^}]*cursor: default;/,
    );
    // DW-644's two: the Deep Research canvas's row controls, which are
    // `.wb-set-action` rather than `.wb-todos-btn`. They RENDER under
    // `readOnly` now instead of vanishing, so the same face is needed — and
    // the create form's Start Deep Research keeps a real `disabled` (DW-529),
    // so the hover rule has to exclude BOTH selectors.
    expect(css).toMatch(
      /\.wb-set-action\[aria-disabled="true"\] \{[^}]*cursor: default;/,
    );
    // …and `[disabled]` alongside it, the same pair `.wb-todos-btn` carries.
    // Start Deep Research is disabled on every load until a topic and a query
    // are typed, and the hover background the exclusion below takes away was
    // the only feedback that state had.
    expect(css).toMatch(/\.wb-set-action\[disabled\] \{[^}]*cursor: default;/);
    expect(css).toContain(
      '.wb-set-action:hover:not([disabled]):not([aria-disabled="true"])',
    );
    expect(css).not.toMatch(/\.wb-set-action:hover \{/);
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

  it("keeps DEPLOY.md's quoted refusals identical to the constants they quote (DW-222)", async () => {
    // `DEPLOY.md` block-quotes the vector refusals an operator meets on a
    // misconfigured deployment, so they can compare the doc to the screen.
    // Nothing but memory joined the two, which is how the doc came to quote a
    // sentence the surface had stopped showing. The quote is hard-wrapped, so it
    // is un-wrapped before comparing: what must match is the SENTENCE, not the
    // line breaks the markdown happens to use.
    //
    // BOTH env notes are pinned. The junk-`EMBEDDING_PROVIDER` section quotes
    // what the vector switch announces on exactly that deployment (DW-636), and
    // it is quoted for the same reason the binding note is — it is the sentence
    // that names the variable, and a doc describing that deployment without it
    // sends the operator to the provider select.
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
    for (const note of [
      SETTINGS_VECTOR_BINDING_ENV_NOTE,
      SETTINGS_VECTOR_PROVIDER_ENV_NOTE,
    ]) {
      expect({ note, quoted: blocks.some((block) => block.includes(note)) }).toEqual({
        note,
        quoted: true,
      });
    }
  });

  it("clears a stale refusal as soon as the owner edits anything", async () => {
    const canvas = await readComponent("SettingsCanvas.tsx");
    // The refusal described the values that were SENT, so leaving it beside Save
    // would have the owner reading "needs an API key" while typing one.
    expect(canvas).toMatch(/setStatus\(""\);[\s\S]{0,300}setSaveError\(null\);/);
  });

  it("leaves the API + MCP pane's vocabulary and live state entirely to the pane (DW-445)", async () => {
    // The extraction's own pin. The category moved out with its copy, its
    // reveal toggle and its health probe; the canvas keeps only the `case` that
    // renders it. Anything of these names reappearing here is the split coming
    // undone — a second copy of a sentence, or a second probe firing from a
    // surface that is not showing the pane.
    const canvas = await readComponent("SettingsCanvas.tsx");
    expect(canvas).not.toMatch(/SETTINGS_API_[A-Z_]+/);
    expect(canvas).not.toContain("probeLoopbackApiPane");
    expect(canvas).not.toContain("revealToken");
    expect(canvas).not.toContain("apiLive");
    expect(canvas).not.toContain("loopbackMcpConfig");
    expect(canvas).not.toContain("maskToken");
    // …and the pane is what the category renders, from the one `case`.
    expect(canvas).toContain("<SettingsApiMcpPane");
    expect(canvas.match(/<SettingsApiMcpPane/g)).toHaveLength(1);
    // The pane takes the canvas's id builder and describer rather than making
    // its own, so its controls stay in the one `useId` namespace and the
    // read-only sentence still appends to both of its hints.
    expect(canvas).toContain("field={field}");
    expect(canvas).toContain("describedBy={describedBy}");
    // `apply` is the only edit gesture handed down — it is what clears the
    // status and the refusal, so a pane with its own `setDraft` would leave
    // both standing beside an edit that invalidated them.
    expect(canvas).toContain("apply={apply}");
    const pane = await readComponent("SettingsApiMcpPane.tsx");
    expect(pane).not.toContain("setDraft");
    expect(pane).not.toContain("useId(");
  });

  it("keeps the shell router-free and the draft out of durable storage", async () => {
    for (const file of [
      "SettingsCanvas.tsx",
      "SettingsNav.tsx",
      "SettingsApiMcpPane.tsx",
    ]) {
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
    // ONE canvas answers to that id at a time, and the handoff is what keeps it
    // that way (DW-373). The shell no longer renders one canvas OR the other:
    // `ModeCanvas` stays mounted behind `hidden` so an open Create Wiki dialog
    // and its draft survive the visit, and gives the id up while it is hidden.
    //
    // Both halves are pinned because either alone would pass a broken shell: a
    // `<ModeCanvas` with no `hidden` prop would put a second `#wb-canvas` on the
    // page, and a `SettingsCanvas` rendered unconditionally would do the same.
    // (The old spelling here was `{settingsOpen ? (`, which the left column's
    // own `SettingsNav`/`TreePanel` ternary also matched — it would have gone on
    // passing against a shell that had lost the canvas ternary entirely. A bare
    // `{settingsOpen && (` has since become the same trap for the same reason:
    // the left column now renders `SettingsNav` under that exact literal, so the
    // gate has to be pinned to the thing it gates.)
    const shell = await readComponent("Workbench.tsx");
    expect(shell).toMatch(/<ModeCanvas[^>]*hidden=\{settingsOpen\}/);
    expect(shell).toMatch(/\{settingsOpen && \(\s*<SettingsCanvas/);
    expect(shell).toMatch(
      /<SettingsCanvas\s+category=\{settingsCategoryId\}\s+headingId=\{headingId\}\s+hasWiki=\{currentWikiId !== null\}\s+onOpenArtifact=\{openSettingsArtifact\}/,
    );
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
    // that is not on screen — so it goes OFF SCREEN, and only off screen.
    //
    // Two booleans since DW-412, because the old single
    // `shouldDockPreview(mode, selection) && !settingsOpen` moved the mount and
    // the visibility together: the column unmounted for the visit and took the
    // editor's unsaved markdown with it. MOUNTED is the dock rule alone; ON
    // SCREEN is what every layout consumer still reads. Both halves are pinned,
    // because a fix that kept only the first would leave the Preview showing
    // beside the settings nav, and one that kept only the second would be the
    // discard this replaced.
    expect(shell).toContain("const previewDocked = shouldDockPreview(mode, selection);");
    expect(shell).toContain("const previewOpen = previewDocked && !settingsOpen;");
    // …and the mount is gated on the first while the withdrawal is the second.
    //
    // The second term is Epic 8's third selection kind, not a second gate: an
    // Agent output under `agent-workspace/` mounts `WorkspacePreview` instead,
    // because those bytes are on the sidecar's disk and this column reads the
    // kernel. Both branches are still `previewDocked && …`, and neither reads
    // `previewOpen` — which is the property this pin exists for.
    expect(shell).toMatch(
      /\{previewDocked && isKernelSelection\(selection\) && \(\s*<PreviewColumn/,
    );
    expect(shell).toMatch(
      /\{previewDocked && selection\?\.kind === "workspace" && \(\s*<WorkspacePreview/,
    );
    expect(shell).not.toMatch(/\{previewOpen && \(\s*<(?:Preview|Workspace)/);
    expect(shell).toContain("hidden={!previewOpen}");
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
      await readComponent("SettingsApiMcpPane.tsx"),
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

describe("settingsRefusalPinsEmbeddingProvider (DW-553)", () => {
  it("recognises the sentence for EVERY provider the route can name", () => {
    // The set is closed at both ends — the route mints the sentence only from
    // `storedBefore.envEmbeddingProvider`, and `envEmbeddingProviderPair()` filters
    // through `isEmbeddingProvider` — so every sentence that can arrive is one
    // of these. A provider added to `EMBEDDING_PROVIDERS` is covered the moment
    // it is added, which is the point of enumerating rather than parsing.
    for (const provider of EMBEDDING_PROVIDERS) {
      expect(
        settingsRefusalPinsEmbeddingProvider({
          message: settingsEnvProviderPinRefusalCopy(provider),
        }),
      ).toBe(true);
    }
  });

  it("prefers the CODE, and takes it whatever the sentence says (DW-628)", () => {
    // The point of minting a code at all: the recovery stops depending on
    // English. A sentence nobody here would recognise still matches when the
    // route names the refusal.
    expect(
      settingsRefusalPinsEmbeddingProvider({
        message: "Reworded by somebody, six months from now.",
        code: SETTINGS_ENV_PROVIDER_PIN_CODE,
      }),
    ).toBe(true);
    // And a code that is not this one does not become a match by being present.
    expect(
      settingsRefusalPinsEmbeddingProvider({
        message: "Reworded by somebody, six months from now.",
        code: "some_other_refusal",
      }),
    ).toBe(false);
  });

  it("still answers from the SENTENCE when no code arrives (DW-628)", () => {
    // The stale tab, and every client stubbing the pre-DW-628 body. The code is
    // ADDITIVE — the sentence is byte-identical to what it always was — so the
    // fallback has to keep working or the change breaks the exact owners the
    // recovery was written for.
    const pinned = settingsEnvProviderPinRefusalCopy("workers-ai");
    expect(settingsRefusalPinsEmbeddingProvider({ message: pinned })).toBe(true);
    expect(settingsRefusalPinsEmbeddingProvider({ message: pinned, code: "" })).toBe(true);
    // Fails CLOSED on a reworded sentence with no code — the old behaviour,
    // which is the safe one: the draft is left exactly as the owner typed it.
    expect(
      settingsRefusalPinsEmbeddingProvider({ message: `${pinned} And another thing.` }),
    ).toBe(false);
    // A wrong code AND a wrong sentence is not a near miss on either half.
    expect(
      settingsRefusalPinsEmbeddingProvider({
        message: SETTINGS_SAVE_FAILED_COPY,
        code: "embedding_provider_env_pinned_v2",
      }),
    ).toBe(false);
  });

  it("refuses a NEAR MISS rather than matching loosely", () => {
    // EXACT equality, never a substring or a regex. Each of these shares enough
    // wording with the refusal that a loose match would take it — and each one
    // means something the re-seed is wrong for.
    const pinned = settingsEnvProviderPinRefusalCopy("workers-ai");
    expect(settingsRefusalPinsEmbeddingProvider({ message: `${pinned} ` })).toBe(false);
    expect(settingsRefusalPinsEmbeddingProvider({ message: pinned.slice(0, -1) })).toBe(
      false,
    );
    expect(settingsRefusalPinsEmbeddingProvider({ message: pinned.toLowerCase() })).toBe(
      false,
    );
    // A value outside the closed set can never have been minted by the route.
    expect(
      settingsRefusalPinsEmbeddingProvider({
        message: settingsEnvProviderPinRefusalCopy("deepseek"),
      }),
    ).toBe(false);
    // The ROW's pin sentence shares the whole first half and is not a refusal
    // at all: it is what the surface says beside a disabled select.
    expect(
      settingsRefusalPinsEmbeddingProvider({
        message: settingsEnvProviderPinCopy("workers-ai"),
      }),
    ).toBe(false);
  });

  it("takes none of the other sentences a refused save can carry", () => {
    // The rest of this seam's vocabulary. Every one of them leaves the draft
    // exactly as the owner typed it.
    for (const other of [
      WRITE_CONFLICT_COPY,
      WRITE_PRECONDITION_REQUIRED_COPY,
      SETTINGS_SAVE_FAILED_COPY,
      settingsEnvProviderInvalidCopy("deepseek"),
      "",
    ]) {
      expect(settingsRefusalPinsEmbeddingProvider({ message: other })).toBe(false);
    }
  });
});

describe("settingsDraftAfterEmbeddingPinRefusal (DW-553)", () => {
  /** A deployment storing OpenAI's endpoint and OpenAI's key. */
  const STORED: WorkbenchSettingsPayload = {
    ...emptyPayload(),
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: "https://o/v1",
    hasEmbeddingApiKey: true,
    llmTimeoutSeconds: 30,
  };

  /** The stale tab's draft: the move the route is about to refuse. */
  function movedDraft() {
    return settingsDraftAfterEmbeddingProvider(
      settingsDraftFromPayload(STORED),
      "google",
      STORED,
    );
  }

  it("puts the three embedding legs back where the STORE has them", () => {
    const moved = movedDraft();
    // The blanking really happened, so the restore below cannot pass vacuously.
    expect(moved.embeddingProvider).toBe("google");
    expect(moved.embeddingBaseUrl).toBe("");

    const back = settingsDraftAfterEmbeddingPinRefusal(moved, STORED);
    expect(back.embeddingProvider).toBe("openai");
    expect(back.embeddingBaseUrl).toBe("https://o/v1");
    expect(back.embeddingApiKey).toBe(SECRET_UNTOUCHED);
    // Field for field what a freshly seeded draft holds — the whole promise of
    // reusing `settingsDraftFromPayload`'s three expressions.
    const seeded = settingsDraftFromPayload(STORED);
    expect(back.embeddingProvider).toBe(seeded.embeddingProvider);
    expect(back.embeddingBaseUrl).toBe(seeded.embeddingBaseUrl);
    expect(back.embeddingApiKey).toBe(seeded.embeddingApiKey);
  });

  it("makes the RETRY a request the pin does not refuse", () => {
    // What the save actually carries afterwards: the stored provider and the
    // stored endpoint, so `embeddingProviderChanged` sees no move and the
    // route's pin never fires.
    const body = settingsSaveBody(settingsDraftAfterEmbeddingPinRefusal(movedDraft(), STORED));
    expect(body.embeddingProvider).toBe("openai");
    expect(body.embeddingBaseUrl).toBe("https://o/v1");
    expect(embeddingProviderChanged(STORED.embeddingProvider, body.embeddingProvider ?? null)).toBe(
      false,
    );
    // And no key rides: the field is UNTOUCHED, not a pretend Remove.
    expect(body.embeddingApiKey).toBeUndefined();
  });

  it("moves NOTHING else, however the owner edited it", () => {
    // A refused save is never allowed to be the thing that loses an edit, and
    // the refusal is about ONE field. Everything else on the surface stands.
    const edited = {
      ...movedDraft(),
      chatModel: "gpt-4.1-mini",
      llmTimeoutSeconds: "45",
      embeddingModel: "text-embedding-3-large",
      searxngBaseUrl: "https://s/search",
      loopbackApiToken: "wk_generated",
    };
    const back = settingsDraftAfterEmbeddingPinRefusal(edited, STORED);
    expect(back.chatModel).toBe("gpt-4.1-mini");
    expect(back.llmTimeoutSeconds).toBe("45");
    // Not vendor-bound in the way the endpoint and the key are, and not what
    // the pin refused: the model the owner typed survives.
    expect(back.embeddingModel).toBe("text-embedding-3-large");
    expect(back.searxngBaseUrl).toBe("https://s/search");
    // A token generated in this draft is shown ONCE; losing it here would lose
    // it for good.
    expect(back.loopbackApiToken).toBe("wk_generated");
  });

  it("restores an EMPTY endpoint and auto-detect when the store holds neither", () => {
    // `?? ""` on both legs, exactly as the seeding does: a store on auto-detect
    // with no endpoint restores to blank boxes rather than to `null` text.
    const bare: WorkbenchSettingsPayload = {
      ...STORED,
      embeddingProvider: null,
      embeddingBaseUrl: null,
    };
    const back = settingsDraftAfterEmbeddingPinRefusal(movedDraft(), bare);
    expect(back.embeddingProvider).toBe("");
    expect(back.embeddingBaseUrl).toBe("");
  });

  it("discards a key and a pending REMOVE typed against the refused vendor", () => {
    // Both are about a vendor the store never moved to. `null` is "Remove", and
    // left standing it would delete the pinned vendor's own credential on the
    // retry — the very sabotage the route's refusal exists to prevent.
    const typed = { ...movedDraft(), embeddingApiKey: "sk-typed-for-google" };
    expect(settingsDraftAfterEmbeddingPinRefusal(typed, STORED).embeddingApiKey).toBe(
      SECRET_UNTOUCHED,
    );
    const removing = { ...movedDraft(), embeddingApiKey: null };
    expect(settingsDraftAfterEmbeddingPinRefusal(removing, STORED).embeddingApiKey).toBe(
      SECRET_UNTOUCHED,
    );
  });

  it("lands on a draft that is not dirty in the fields it restored", () => {
    // The re-seeded legs agree with the payload, so the surface shows what a
    // reload would show — and a draft that changed nothing else is clean.
    const back = settingsDraftAfterEmbeddingPinRefusal(movedDraft(), STORED);
    expect(settingsDirty(back, STORED)).toBe(false);
    expect(draftEmbeddingKeyStored(back, STORED)).toBe(true);
  });

  it("does not mutate the draft it was handed", () => {
    const moved = movedDraft();
    settingsDraftAfterEmbeddingPinRefusal(moved, STORED);
    expect(moved.embeddingProvider).toBe("google");
    expect(moved.embeddingBaseUrl).toBe("");
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

describe("draftEmbeddingIdentityDirty (DW-337)", () => {
  /**
   * The gate on the SUBSTITUTION NOTE — the one sentence on the embedding model
   * row that is payload-derived, sitting beside two that are draft-derived.
   * While the model or the provider holds something the server has not seen, the
   * note would go on describing pre-edit server state in the present tense
   * ("Not in effect. This deployment embeds with …"), so it is withheld until a
   * landed save re-seeds the payload.
   */
  const stored: WorkbenchSettingsPayload = {
    ...emptyPayload(),
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
    embeddingBaseUrl: "https://o/v1",
    embeddingModelOverridden: true,
    embeddingModelInEffect: "@cf/baai/bge-m3",
  };

  it("is clean when seeded", () => {
    expect(draftEmbeddingIdentityDirty(settingsDraftFromPayload(stored), stored)).toBe(
      false,
    );
    // …including over a payload holding NEITHER field, where `null` seeds as
    // `""`: a blank box over an unset value must not read as an edit.
    const bare = { ...emptyPayload(), embeddingProvider: null, embeddingModel: null };
    expect(draftEmbeddingIdentityDirty(settingsDraftFromPayload(bare), bare)).toBe(false);
  });

  it("is dirty on EITHER field", () => {
    const seeded = settingsDraftFromPayload(stored);
    expect(
      draftEmbeddingIdentityDirty({ ...seeded, embeddingModel: "text-embedding-3-large" }, stored),
    ).toBe(true);
    // The provider is the other half of what the resolver's answer is a
    // function of, and the row's own select is what moves it — an owner
    // correcting the substitution from THERE gets the same silence.
    expect(
      draftEmbeddingIdentityDirty({ ...seeded, embeddingProvider: "google" }, stored),
    ).toBe(true);
    // Blanking counts too: an empty box is a different value, not an absence of
    // one, and it is the state Auto-detect leaves the select in.
    expect(draftEmbeddingIdentityDirty({ ...seeded, embeddingModel: "" }, stored)).toBe(
      true,
    );
  });

  it("is clean again when the edit is reverted", () => {
    // The `settingsDirty` shape, and the reason for it: compared against the
    // draft the PAYLOAD would produce, so "typed a value and undid it" is
    // correctly clean and the note comes back without a save.
    const seeded = settingsDraftFromPayload(stored);
    const edited = { ...seeded, embeddingModel: "text-embedding-3-large" };
    expect(draftEmbeddingIdentityDirty(edited, stored)).toBe(true);
    expect(
      draftEmbeddingIdentityDirty(
        { ...edited, embeddingModel: "text-embedding-3-small" },
        stored,
      ),
    ).toBe(false);
  });

  it("ignores the model box entirely when EMBEDDING_MODEL owns the model", () => {
    // `embeddingModelAnswer` takes `getEmbeddingModelOverride()` in preference
    // to the stored value, so with the variable set the editable box is not what
    // resolves — the substitution the server reported stays true whatever is
    // typed there, and withholding the note would hide a still-true fact while
    // the owner edits a box that is not in play. The same precedence
    // `draftVectorInputs` reports as `modelOrigin`.
    const envOwned: WorkbenchSettingsPayload = {
      ...stored,
      envEmbeddingModel: "text-embedding-3-small",
    };
    const seeded = settingsDraftFromPayload(envOwned);
    expect(
      draftEmbeddingIdentityDirty({ ...seeded, embeddingModel: "anything-at-all" }, envOwned),
    ).toBe(false);
    // The PROVIDER leg keeps no such qualifier: an env-owned MODEL says nothing
    // about which vendor resolves, and this select is not pinned by it.
    expect(
      draftEmbeddingIdentityDirty({ ...seeded, embeddingProvider: "google" }, envOwned),
    ).toBe(true);
  });

  it("is unmoved by an unrelated edit", () => {
    // IDENTITY, not the whole row. The endpoint and the key change how the
    // vendor is reached, not which model resolves, so the server's answer is
    // still true — and a chat-model edit three categories away must not silence
    // a sentence about embeddings.
    const seeded = settingsDraftFromPayload(stored);
    expect(
      draftEmbeddingIdentityDirty({ ...seeded, embeddingBaseUrl: "https://p/v1" }, stored),
    ).toBe(false);
    expect(draftEmbeddingIdentityDirty({ ...seeded, embeddingApiKey: "sk-x" }, stored)).toBe(
      false,
    );
    expect(draftEmbeddingIdentityDirty({ ...seeded, chatModel: "gpt-4o-mini" }, stored)).toBe(
      false,
    );
    // …and it is a NARROWER question than `settingsDirty`, which those edits do
    // move. Two predicates, two jobs.
    expect(settingsDirty({ ...seeded, embeddingBaseUrl: "https://p/v1" }, stored)).toBe(true);
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
