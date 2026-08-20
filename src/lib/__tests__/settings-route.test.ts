import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));
vi.mock("@/lib/config", async (original) => ({
  ...(await original<typeof import("@/lib/config")>()),
  readConfig: vi.fn(),
  saveConfig: vi.fn(),
  getEffectiveSettings: vi.fn(),
  getEffectiveProvider: vi.fn(),
  isReadOnly: vi.fn(),
}));
/**
 * The Cloudflare `AI` binding, chosen per test.
 *
 * `getWorkersAiBinding()` answers `null` off the Workers runtime, so under
 * vitest the real function would add the BINDING leg to every `workers-ai`
 * refusal and drown out the leg each test is actually about. Mocking it lets a
 * test say "the binding is there" and keep the sentence about the MODEL.
 */
vi.mock("@/lib/embeddings", () => ({ getWorkersAiBinding: vi.fn(() => null) }));

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import {
  CONFIG_UNREADABLE_COPY,
  getEffectiveProvider,
  getEffectiveSettings,
  isReadOnly,
  readConfig,
  saveConfig,
} from "@/lib/config";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
  formatIfMatch,
} from "@/lib/write-precondition";
import { getWorkersAiBinding } from "@/lib/embeddings";
import type { Ai } from "@/lib/storage/cloudflare-types";
import { vectorSearchMissingCopy } from "@/lib/workbench-settings";

const mockedBinding = vi.mocked(getWorkersAiBinding);
const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedRead = vi.mocked(readConfig);
const mockedSave = vi.mocked(saveConfig);
const mockedEffectiveSettings = vi.mocked(getEffectiveSettings);
const mockedEffectiveProvider = vi.mocked(getEffectiveProvider);

/**
 * The opaque token the store is mocked to hold (DW-197). Nothing about the
 * config produces it — `saveConfig` generates it and writes it to a sibling
 * file — so a test that changes a config field does NOT change the version, and
 * a stale precondition has to be spelled out.
 */
const STORED_VERSION = "s1:0123456789abcdef0123456789abcdef";

/** What `saveConfig` is mocked to stamp on a landed write. */
const SAVED_VERSION = "s1:fedcba9876543210fedcba9876543210";

/**
 * `PUT /api/settings` REQUIRES the write precondition (DW-63). The default is
 * the token `readConfig` is mocked to answer with, so the default matches and
 * the refusals are asked for explicitly.
 */
function request(
  body: Record<string, unknown>,
  precondition: { ifMatch?: string | null } = {},
) {
  const version =
    precondition.ifMatch !== undefined ? precondition.ifMatch : STORED_VERSION;
  return new Request("http://localhost/api/settings", {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      ...(version === null ? {} : { "If-Match": formatIfMatch(version) }),
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  // No binding by default — the state every existing test ran under.
  mockedBinding.mockReturnValue(null);
  // The env halves of the vector rule are the DEPLOYMENT's, not this machine's.
  // `workbenchSettingsStored` reads all four: `EMBEDDING_MODEL` would flip the
  // model leg's origin to "env" and change the refusal sentence, and the two
  // vendor keys feed `envEmbeddingApiKeyProviders()` — a developer with either
  // exported would satisfy the KEY leg and drop it from the sentence. Stubbed
  // so the assertions describe the deployment each test sets up and nothing
  // else.
  vi.stubEnv("EMBEDDING_PROVIDER", "");
  vi.stubEnv("EMBEDDING_MODEL", "");
  vi.stubEnv("OPENAI_API_KEY", "");
  vi.stubEnv("GOOGLE_GENERATIVE_AI_API_KEY", "");
  mockedPrincipal.mockResolvedValue({ id: "user_1", handle: "christianlee" });
  mockedIsOwner.mockReturnValue(true);
  mockedReadOnly.mockReturnValue(false);
  mockedRead.mockResolvedValue({ status: "ok", config: {}, version: STORED_VERSION });
  mockedSave.mockResolvedValue(SAVED_VERSION);
  mockedEffectiveSettings.mockReturnValue({
    provider: null,
    providerSource: "none",
    model: null,
    modelSource: "none",
    configured: false,
    embeddingSupport: true,
    embeddingModel: null,
    embeddingModelSource: "none",
    embeddingModelInEffect: null,
    embeddingModelOverridden: false,
    hasApiKey: false,
    apiKeySource: "none",
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "none",
    structuredKnowledgeProvider: null,
    structuredKnowledgeProviderSource: "none",
    structuredKnowledgeModel: null,
    structuredKnowledgeModelSource: "none",
    structuredKnowledgeConfigured: false,
    readOnly: false,
  });
  mockedEffectiveProvider.mockReturnValue({
    configured: false,
    provider: "ollama-cloud",
    model: "gpt-oss:120b",
    embeddingSupport: true,
  });
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("/api/settings", () => {
  it("does not expose settings to non-owners", async () => {
    mockedIsOwner.mockReturnValue(false);
    const { GET } = await import("@/app/api/settings/route");

    const response = await GET();

    expect(response.status).toBe(404);
    expect(mockedRead).not.toHaveBeenCalled();
  });

  it("allows the owner to persist Ollama Cloud preferences", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ provider: "ollama-cloud", model: "gpt-oss:120b" }),
    );

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    });
    // ONE read: the merge base. `saveConfig` returns the token it stamped, so
    // there is no re-read to answer the new version with.
    expect(mockedRead).toHaveBeenCalledTimes(1);
  });

  it("persists an independent Structured Knowledge provider and model", async () => {
    const existing = { provider: "ollama-cloud" as const, model: "gpt-oss:120b" };
    mockedRead.mockResolvedValue({
      status: "ok",
      config: existing,
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({
        structuredKnowledgeProvider: "openai",
        structuredKnowledgeModel: "gpt-4o",
      }),
    );

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
    });
  });

  it("refuses a save whose precondition describes an older config (412)", async () => {
    // Two surfaces write this one file. A draft seeded before the other saved
    // holds the token the store held BEFORE that save, and every save rotates
    // it — so it no longer matches and the merge never happens.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { provider: "openai" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ model: "gpt-4o" }, { ifMatch: "s1:a-token-the-store-no-longer-has" }),
    );

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ error: WRITE_CONFLICT_COPY });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a save with no precondition at all (428)", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "gpt-4o" }, { ifMatch: null }));

    expect(response.status).toBe(428);
    expect(await response.json()).toEqual({
      error: WRITE_PRECONDITION_REQUIRED_COPY,
    });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses to serve settings it could not read (503)", async () => {
    // `loadConfig()` answers `{}` for an absent config AND for a failed read.
    // Serving defaults for the second would seed a draft from settings the
    // owner never chose.
    mockedRead.mockResolvedValue({ status: "unreadable", error: new Error("EIO") });
    const { GET } = await import("@/app/api/settings/route");

    const response = await GET();

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
  });

  it("refuses a save it could not read the store for (503), and never calls saveConfig", async () => {
    // The merge base has to be what the store HOLDS. Merging a patch into `{}`
    // and writing it back deletes every stored field, the three API keys
    // included — so the refusal comes before the merge, on any body and any
    // `If-Match`.
    mockedRead.mockResolvedValue({ status: "unreadable", error: new Error("EIO") });
    const { PUT } = await import("@/app/api/settings/route");

    for (const ifMatch of [undefined, null, "s1:anything"]) {
      const response = await PUT(request({ model: "gpt-4o" }, { ifMatch }));
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ error: CONFIG_UNREADABLE_COPY });
    }
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers the token `saveConfig` stamped, not one derived from the config", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "gpt-4o" }));

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      version: string;
      workbench: { version: string };
    };
    expect(body.version).toBe(SAVED_VERSION);
    // …and served on the object the canvas re-seeds its draft from, so a second
    // save without a reload still lands.
    expect(body.workbench.version).toBe(SAVED_VERSION);
  });

  it("TRIMS a padded embeddingModel on the legacy flat branch (DW-221)", async () => {
    // The one writer that could still store a padded id. The vector gate reads
    // the stored value trimmed and would accept `" @cf/baai/bge-m3 "`; the embed
    // resolver reads the SAME value and now trims too — but a store holding the
    // padding is a value the two sides only agree on by accident, so the trim
    // happens at the door, exactly as `applyWorkbenchSettings`'s `setText` does.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: " @cf/baai/bge-m3 " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({ embeddingModel: "@cf/baai/bge-m3" });
  });

  it("DELETES embeddingModel when the flat branch is given whitespace only", async () => {
    // `""` already deleted the key; `"   "` used to be stored verbatim and then
    // handed to the provider as a model name.
    //
    // This store has NO `vectorSearchEnabled`, which is why the delete lands at
    // all: since DW-217 the flat branch runs the vector gate, and deleting the
    // model of a store whose switch is ON is refused (see "REFUSES a flat
    // embeddingModel DELETION…" below). The delete semantics are unchanged; the
    // deployment they are exercised on is what makes them reachable.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { embeddingModel: "@cf/baai/bge-m3" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "   " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({});
  });

  it("REFUSES a non-string embeddingModel rather than deleting the stored one", async () => {
    // The trim added for DW-221 reads a non-string as `""`, which the branch
    // below treats as DELETE — so `{"embeddingModel": 42}` would have wiped the
    // owner's model and answered 200. Every sibling flat field refuses a
    // non-string, and a malformed body must never be read as an erasure.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { embeddingModel: "@cf/baai/bge-m3" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [42, true, { id: "@cf/baai/bge-m3" }, ["@cf/baai/bge-m3"]]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "embeddingModel must be a string",
      });
      // Nothing was written, so the stored id is still the stored id.
      expect(mockedSave).not.toHaveBeenCalled();
    }
  });

  it("still deletes embeddingModel for null and the empty string", async () => {
    // Vector search is off in this store, so the gate is skipped — see the note
    // on the whitespace case above.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { embeddingModel: "@cf/baai/bge-m3" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, ""]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({});
    }
  });

  it("honors the explicit deployment read-only switch", async () => {
    mockedReadOnly.mockReturnValue(true);
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ provider: "ollama-cloud", model: "gpt-oss:120b" }),
    );

    expect(response.status).toBe(403);
    expect(mockedSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The vector gate over the LEGACY FLAT branch (DW-217)
// ---------------------------------------------------------------------------

describe("PUT /api/settings — the vector rule on the flat branch (DW-217)", () => {
  /** A satisfied Workers AI vector configuration, as the store holds it. */
  const SATISFIED = {
    vectorSearchEnabled: true,
    embeddingProvider: "workers-ai",
    embeddingModel: "@cf/baai/bge-m3",
  } as const;

  /** The sentence the gate produces once `model` has moved off the catalog. */
  const MISMATCH_COPY = vectorSearchMissingCopy({
    provider: "workers-ai",
    baseUrl: null,
    model: "text-embedding-3-small",
    hasKey: false,
    modelOrigin: "stored",
    providerOrigin: "stored",
    hasWorkersAiBinding: true,
  });

  function storeSatisfied(): void {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ...SATISFIED },
      version: STORED_VERSION,
    });
  }

  beforeEach(() => {
    // The binding is present, so the refusal is about the MODEL leg rather than
    // about the transport `workers-ai` normally supplies for itself.
    mockedBinding.mockReturnValue({} as unknown as Ai);
    storeSatisfied();
  });

  it("REFUSES a flat embeddingModel that moves the config past the vector gate", async () => {
    // The bug: the gate used to run only inside `if (body.workbench !== undefined)`,
    // so this body answered 200 and silently switched effective vector search
    // off — `getVectorSearchSettings()` intersects the stored flag with the same
    // predicate the route skipped.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "text-embedding-3-small" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: MISMATCH_COPY });
    // The sentence names the ids the owner can actually pick.
    expect(MISMATCH_COPY).toContain("@cf/baai/bge-m3");
    // Refused BEFORE the write: the store still holds the satisfied config.
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a flat embeddingProvider that moves the config past the vector gate", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingProvider: "openai" }));

    expect(response.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("answers the SAME sentence whether the move arrives flat or as a workbench patch", async () => {
    // One rule, one wording. A second copy of the refusal at the route is
    // exactly what this pins against.
    const { PUT } = await import("@/app/api/settings/route");

    const flat = await PUT(request({ embeddingModel: "text-embedding-3-small" }));
    const nested = await PUT(
      request({ workbench: { embeddingModel: "text-embedding-3-small" } }),
    );

    expect(flat.status).toBe(400);
    expect(nested.status).toBe(400);
    const flatBody = (await flat.json()) as { error: string };
    const nestedBody = (await nested.json()) as { error: string };
    expect(flatBody.error).toBe(nestedBody.error);
    expect(flatBody.error).toBe(MISMATCH_COPY);
  });

  it("ALLOWS a flat embeddingModel move that still satisfies the gate", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "@cf/baai/bge-large-en-v1.5" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      ...SATISFIED,
      embeddingModel: "@cf/baai/bge-large-en-v1.5",
    });
  });

  it("SKIPS the gate when the flat body moves no vector input (DW-219)", async () => {
    // A deployment already storing a mismatch must still be able to edit its
    // chat model — a refusal naming a field this request never touched would be
    // a surface the owner cannot leave.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: {
        vectorSearchEnabled: true,
        embeddingProvider: "workers-ai",
        embeddingModel: "text-embedding-3-small",
      },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "gpt-4o" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
      model: "gpt-4o",
    });
  });

  it("does not gate a flat move while vector search is off", async () => {
    for (const stored of [{ vectorSearchEnabled: false }, {}]) {
      mockedSave.mockClear();
      mockedRead.mockResolvedValue({
        status: "ok",
        config: { ...stored },
        version: STORED_VERSION,
      });
      const { PUT } = await import("@/app/api/settings/route");

      const response = await PUT(request({ embeddingModel: "anything" }));

      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({
        ...stored,
        embeddingModel: "anything",
      });
    }
  });

  it("REFUSES a flat embeddingModel DELETION that leaves the gate unsatisfied", async () => {
    // The other half of the closed hole. "Moves a vector input" includes moving
    // one to NOTHING: `null`, `""` and whitespace-only all resolve to a deleted
    // key, which is a different value from the stored id and so is a move the
    // rule reads. All three answered 200 before DW-217 and quietly left the
    // switch on over a config that can no longer embed.
    const removalCopy = vectorSearchMissingCopy({
      provider: "workers-ai",
      baseUrl: null,
      model: null,
      hasKey: false,
      modelOrigin: "stored",
      providerOrigin: "stored",
      hasWorkersAiBinding: true,
    });
    expect(removalCopy).toBe(
      "Vector search needs a model before it can be turned on.",
    );
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, "", "   "]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: removalCopy });
      expect(mockedSave).not.toHaveBeenCalled();
    }
  });

  it("REFUSES a flat embeddingProvider DELETION that leaves the gate unsatisfied", async () => {
    // Same half, the other field: with no provider the rule cannot even ask the
    // remaining questions, so it reports the one leg that matters.
    const removalCopy = vectorSearchMissingCopy({
      provider: null,
      baseUrl: null,
      model: "@cf/baai/bge-m3",
      hasKey: false,
      modelOrigin: "stored",
      providerOrigin: "stored",
      hasWorkersAiBinding: true,
    });
    expect(removalCopy).toBe(
      "Vector search needs an embedding provider before it can be turned on.",
    );
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingProvider: null }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: removalCopy });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("ALLOWS the same deletions once vector search is off", async () => {
    // The deletions are not forbidden — they are forbidden while the switch is
    // ON and the deleted value is what the switch depends on. This is what the
    // two flat `embeddingModel` delete tests above are relying on.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { embeddingProvider: "workers-ai", embeddingModel: "@cf/baai/bge-m3" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, "", "   "]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({ embeddingProvider: "workers-ai" });
    }
  });

  it("saves the byte-identical object for a flat body that passes the gate", async () => {
    // `applyWorkbenchSettings` stays conditional on the `workbench` KEY, so
    // validating every body changed no legacy save's outcome.
    mockedRead.mockResolvedValue({ status: "ok", config: {}, version: STORED_VERSION });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ provider: "ollama-cloud", model: "gpt-oss:120b" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    });
  });
});

// ---------------------------------------------------------------------------
// Flat text fields are normalized at the door (DW-275)
// ---------------------------------------------------------------------------

describe("PUT /api/settings — flat field normalization (DW-275)", () => {
  it("TRIMS a padded model", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "  gpt-4o  " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({ model: "gpt-4o" });
  });

  it("still refuses a whitespace-only model rather than storing or deleting it", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "   " }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "Model must be a non-empty string",
    });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("TRIMS a padded ollamaBaseUrl", async () => {
    // `getOllamaBaseUrl()` reads the stored value back with no trim of its own
    // and hands it straight to `fetch`, so the padding has to die here.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ ollamaBaseUrl: "  http://h:11434/api " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({ ollamaBaseUrl: "http://h:11434/api" });
  });

  it("DELETES ollamaBaseUrl when given whitespace only", async () => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ollamaBaseUrl: "http://h:11434/api" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of ["   ", "", null]) {
      mockedSave.mockClear();
      const response = await PUT(request({ ollamaBaseUrl: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({});
    }
  });

  it("REFUSES a non-string ollamaBaseUrl rather than deleting the stored one", async () => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ollamaBaseUrl: "http://h:11434/api" },
      version: STORED_VERSION,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ ollamaBaseUrl: 42 }));

    expect(response.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });
});
