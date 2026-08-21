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
 *
 * `getEmbeddingModelName` is the SECOND thing the route needs from this module,
 * and it is load-bearing: since DW-312 `getWorkbenchSettings` resolves
 * `embeddingModelInEffect`/`embeddingModelOverridden` through
 * `embeddingModelAnswer`, which calls it — and `getWorkbenchSettings` builds the
 * payload every 200 in this file serves back. A mock that stopped at the binding
 * left it `undefined` and turned all of them into 500s.
 *
 * `hasEmbeddingSupport` is DEFENSIVE rather than load-bearing: the only route
 * path that reaches it is `getEffectiveSettings`/`getEffectiveProvider`, and
 * both of those are mocked above. It is stubbed so this file does not silently
 * depend on which `config.ts` doors happen to be mocked.
 */
vi.mock("@/lib/embeddings", () => ({
  getWorkersAiBinding: vi.fn(() => null),
  getEmbeddingModelName: vi.fn(() => null),
  hasEmbeddingSupport: vi.fn(() => false),
}));

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
import {
  SETTINGS_INVALID_URL_COPY,
  vectorSearchInactiveCopy,
} from "@/lib/workbench-settings";

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
 * config produces it — `saveConfig` generates it from randomness and stamps it
 * under a reserved key — so a test that changes a config field does NOT change
 * the version, and a stale precondition has to be spelled out.
 */
const STORED_VERSION = "s1:0123456789abcdef0123456789abcdef";

/**
 * The STORAGE layer's version of the bytes `readConfig` is mocked to have read
 * (DW-272) — the compare-and-set input `saveConfig` is handed, and the one value
 * on the read that must never appear in a response body: on R2 it is an MD5 of
 * an object holding three API keys.
 */
const STORED_ETAG = "etag-the-store-held";

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
  mockedRead.mockResolvedValue({
    status: "ok",
    config: {},
    version: STORED_VERSION,
    etag: STORED_ETAG,
  });
  mockedSave.mockResolvedValue({ status: "ok", version: SAVED_VERSION });
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
    }, STORED_ETAG);
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
      etag: STORED_ETAG,
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
    }, STORED_ETAG);
  });

  it("refuses a save whose precondition describes an older config (412)", async () => {
    // Two surfaces write this one file. A draft seeded before the other saved
    // holds the token the store held BEFORE that save, and every save rotates
    // it — so it no longer matches and the merge never happens.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { provider: "openai" },
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ model: "gpt-4o" }, { ifMatch: "s1:a-token-the-store-no-longer-has" }),
    );

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ error: WRITE_CONFLICT_COPY });
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a save whose COMPARE-AND-SET lost (412), and writes nothing", async () => {
    // The window the `If-Match` check above cannot see (DW-272): this request's
    // draft token matched, its merge base was read — and then another writer
    // landed before this one wrote back. `writeFileIfMatch` refuses rather than
    // letting the superseded merge base overwrite that save, and the route says
    // the same sentence it says for the check it can see, because to the owner
    // it is the same fact.
    mockedSave.mockResolvedValue({ status: "conflict" });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "gpt-4o" }));

    expect(response.status).toBe(412);
    expect(await response.json()).toEqual({ error: WRITE_CONFLICT_COPY });
    // The write was ATTEMPTED — that is the whole point — and it was attempted
    // against the etag of the bytes this request merged onto.
    expect(mockedSave).toHaveBeenCalledWith(expect.anything(), STORED_ETAG);
  });

  it("carries the READ's etag into the write, and serves it to nobody", async () => {
    // The etag is the compare-and-set input, and on R2 it is an MD5 of an object
    // holding `customApiKey`, `embeddingApiKey` and `firecrawlApiKey` — the
    // AD-23 leak the opaque stamp exists to avoid. It stays internal.
    const { PUT, GET } = await import("@/app/api/settings/route");

    const put = await PUT(request({ model: "gpt-4o" }));
    expect(put.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith(expect.anything(), STORED_ETAG);
    expect(await put.clone().text()).not.toContain(STORED_ETAG);

    const get = await GET();
    expect(await get.text()).not.toContain(STORED_ETAG);
  });

  it("cannot be made to forge or unstamp the token from the BODY", async () => {
    // THE ONE NEW ATTACK SURFACE THE SCHEME OPENED (DW-272). With the token in a
    // sibling file this was structurally impossible — no field of a `PUT` body
    // could name it. Now the key lives in the same object the route merges into,
    // so a body carrying `__settingsVersion` is a body reaching for the guard's
    // own state. Two things stop it, and this pins the ROUTE's half: the merge
    // never carries the key through, flat or under `workbench`. The other half —
    // `saveConfig` stripping one that somehow arrived, and stamping its own — is
    // pinned in `config.test.ts`, where `saveConfig` is the real one.
    const { PUT } = await import("@/app/api/settings/route");

    for (const body of [
      { model: "gpt-4o", __settingsVersion: "s1:dddddddddddddddddddddddddddddddd" },
      { model: "gpt-4o", __settingsVersion: null },
      {
        workbench: {
          chatModel: "gpt-4o",
          __settingsVersion: "s1:dddddddddddddddddddddddddddddddd",
        },
      },
    ]) {
      mockedSave.mockClear();
      const response = await PUT(request(body));
      expect(response.status).toBe(200);

      // The merged object handed to `saveConfig` carries no reserved key: the
      // flat branch writes only the fields it names, and the `workbench` patch
      // is applied field by field rather than spread.
      const [merged] = mockedSave.mock.calls[0] as [Record<string, unknown>, unknown];
      expect(merged).not.toHaveProperty("__settingsVersion");

      // …and the version served back is the one the STORE stamped, never the
      // one the body asked for.
      const served = (await response.json()) as { version: string };
      expect(served.version).toBe(SAVED_VERSION);
    }
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
    expect(mockedSave).toHaveBeenCalledWith({ embeddingModel: "@cf/baai/bge-m3" }, STORED_ETAG);
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
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "   " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({}, STORED_ETAG);
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
      etag: STORED_ETAG,
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
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, ""]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({}, STORED_ETAG);
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

  /**
   * The sentence the gate produces once `model` has moved off the catalog.
   *
   * The SWITCHED-ON frame (DW-308): every store in this describe holds
   * `vectorSearchEnabled: true` already, so no request here is asking to turn
   * the switch on and "…before it can be turned on" would land in the save bar
   * beside a box the payload still shows ticked.
   *
   * …in its FLAT wording (DW-329). Every request in this describe is a
   * flat-only body, so the route scopes it, and a scoped refusal is by
   * definition one the `/settings` page will read — a page that renders no
   * vector switch, so "Turn it off" would name a control the owner cannot find.
   */
  const MISMATCH_INPUTS = {
    provider: "workers-ai",
    baseUrl: null,
    model: "text-embedding-3-small",
    hasKey: false,
    modelOrigin: "stored",
    providerOrigin: "stored",
    hasWorkersAiBinding: true,
  } as const;
  const MISMATCH_COPY = vectorSearchInactiveCopy(MISMATCH_INPUTS, "flat");
  /**
   * The same state as {@link MISMATCH_COPY}, in the Workbench's wording — what
   * the very same move answers when it arrives under a `workbench` key, which
   * is unchanged by DW-329.
   */
  const WORKBENCH_MISMATCH_COPY = vectorSearchInactiveCopy(MISMATCH_INPUTS);

  function storeSatisfied(): void {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ...SATISFIED },
      version: STORED_VERSION,
      etag: STORED_ETAG,
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

  it("names the SAME legs whether the move arrives flat or as a workbench patch, in each surface's own frame", async () => {
    // One rule, two frames (DW-329). The two refusals used to be the identical
    // string, which is what put "Turn it off, or supply what is missing." on the
    // one surface that renders no switch to turn off. What must stay identical
    // is the DIAGNOSIS — the legs, their order and their notes; what must
    // differ is the trailing action clause, because the two surfaces offer
    // different actions.
    const { PUT } = await import("@/app/api/settings/route");

    const flat = await PUT(request({ embeddingModel: "text-embedding-3-small" }));
    const nested = await PUT(
      request({ workbench: { embeddingModel: "text-embedding-3-small" } }),
    );

    expect(flat.status).toBe(400);
    expect(nested.status).toBe(400);
    const flatBody = (await flat.json()) as { error: string };
    const nestedBody = (await nested.json()) as { error: string };

    expect(flatBody.error).toBe(MISMATCH_COPY);
    expect(nestedBody.error).toBe(WORKBENCH_MISMATCH_COPY);
    // NOT the same string any more — that equality is the behaviour this
    // change deliberately removes.
    expect(flatBody.error).not.toBe(nestedBody.error);

    // The shared half is byte-identical: everything up to the action clause,
    // which is the sentence that says what is wrong.
    const DIAGNOSIS =
      "Vector search is switched on, but it needs a supported Cloudflare Workers AI model id";
    expect(flatBody.error.startsWith(DIAGNOSIS)).toBe(true);
    expect(nestedBody.error.startsWith(DIAGNOSIS)).toBe(true);
    // Same legs, in the same order, named the same way — the ids the owner can
    // actually pick.
    expect(flatBody.error).toContain("@cf/baai/bge-m3");
    expect(nestedBody.error).toContain("@cf/baai/bge-m3");

    // …and the ONE thing that differs is where the owner is sent.
    expect(nestedBody.error).toContain("Turn it off, or supply what is missing.");
    expect(flatBody.error).not.toContain("Turn it off");
    expect(flatBody.error).toContain(
      "turn the switch off in Workbench Settings → Embeddings",
    );
  });

  it("ALLOWS a flat embeddingModel move that still satisfies the gate", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "@cf/baai/bge-large-en-v1.5" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      ...SATISFIED,
      embeddingModel: "@cf/baai/bge-large-en-v1.5",
    }, STORED_ETAG);
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
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ model: "gpt-4o" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      vectorSearchEnabled: true,
      embeddingProvider: "workers-ai",
      embeddingModel: "text-embedding-3-small",
      model: "gpt-4o",
    }, STORED_ETAG);
  });

  it("does not gate a flat move while vector search is off", async () => {
    for (const stored of [{ vectorSearchEnabled: false }, {}]) {
      mockedSave.mockClear();
      mockedRead.mockResolvedValue({
        status: "ok",
        config: { ...stored },
        version: STORED_VERSION,
        etag: STORED_ETAG,
      });
      const { PUT } = await import("@/app/api/settings/route");

      const response = await PUT(request({ embeddingModel: "anything" }));

      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({
        ...stored,
        embeddingModel: "anything",
      }, STORED_ETAG);
    }
  });

  it("REFUSES a flat embeddingModel DELETION that leaves the gate unsatisfied", async () => {
    // The other half of the closed hole. "Moves a vector input" includes moving
    // one to NOTHING: `null`, `""` and whitespace-only all resolve to a deleted
    // key, which is a different value from the stored id and so is a move the
    // rule reads. All three answered 200 before DW-217 and quietly left the
    // switch on over a config that can no longer embed.
    const removalCopy = vectorSearchInactiveCopy(
      {
        provider: "workers-ai",
        baseUrl: null,
        model: null,
        hasKey: false,
        modelOrigin: "stored",
        providerOrigin: "stored",
        hasWorkersAiBinding: true,
      },
      // Flat body, flat frame (DW-329).
      "flat",
    );
    expect(removalCopy).toBe(
      "Vector search is switched on, but it needs a model before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
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
    const removalCopy = vectorSearchInactiveCopy(
      {
        provider: null,
        baseUrl: null,
        model: "@cf/baai/bge-m3",
        hasKey: false,
        modelOrigin: "stored",
        providerOrigin: "stored",
        hasWorkersAiBinding: true,
      },
      // Flat body, flat frame (DW-329).
      "flat",
    );
    expect(removalCopy).toBe(
      "Vector search is switched on, but it needs an embedding provider before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
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
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, "", "   "]) {
      mockedSave.mockClear();
      const response = await PUT(request({ embeddingModel: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({ embeddingProvider: "workers-ai" }, STORED_ETAG);
    }
  });

  it("saves the byte-identical object for a flat body that passes the gate", async () => {
    // `applyWorkbenchSettings` stays conditional on the `workbench` KEY, so
    // validating every body changed no legacy save's outcome.
    mockedRead.mockResolvedValue({
      status: "ok",
      config: {},
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ provider: "ollama-cloud", model: "gpt-oss:120b" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
    }, STORED_ETAG);
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
    expect(mockedSave).toHaveBeenCalledWith({ model: "gpt-4o" }, STORED_ETAG);
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
    expect(mockedSave).toHaveBeenCalledWith({ ollamaBaseUrl: "http://h:11434/api" }, STORED_ETAG);
  });

  it("DELETES ollamaBaseUrl when given whitespace only", async () => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ollamaBaseUrl: "http://h:11434/api" },
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of ["   ", "", null]) {
      mockedSave.mockClear();
      const response = await PUT(request({ ollamaBaseUrl: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({}, STORED_ETAG);
    }
  });

  it("REFUSES a non-string ollamaBaseUrl rather than deleting the stored one", async () => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ollamaBaseUrl: "http://h:11434/api" },
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ ollamaBaseUrl: 42 }));

    expect(response.status).toBe(400);
    expect(mockedSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// The flat `ollamaBaseUrl` passes the workbench URL rule (DW-304)
// ---------------------------------------------------------------------------

describe("PUT /api/settings — the flat ollamaBaseUrl URL rule (DW-304)", () => {
  beforeEach(() => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { ollamaBaseUrl: "http://h:11434/api" },
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
  });

  it("REFUSES a value that is not an absolute http(s) URL", async () => {
    // This was the ONE endpoint stored on a bare `typeof` check while every
    // workbench endpoint had to pass `isAbsoluteHttpUrl` — so these values
    // reached `getOllamaBaseUrl()`, which reads the stored string literally, and
    // from there the provider SDK.
    const { PUT } = await import("@/app/api/settings/route");

    // `localhost:11434` is the classic Ollama misconfiguration and the most
    // likely bad value of the four: it PARSES — `new URL` reads `localhost:` as
    // the scheme and `11434` as the path — so only the protocol half of
    // `isAbsoluteHttpUrl` refuses it.
    for (const value of [
      "not-a-url",
      "file:///etc/passwd",
      "/api",
      "localhost:11434",
    ]) {
      mockedSave.mockClear();
      const response = await PUT(request({ ollamaBaseUrl: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: SETTINGS_INVALID_URL_COPY });
      // Refused BEFORE the write: the stored endpoint is untouched.
      expect(mockedSave).not.toHaveBeenCalled();
    }
  });

  it("answers the SAME sentence the workbench endpoints answer", async () => {
    // One rule, one wording — the route never re-types the copy.
    const { PUT } = await import("@/app/api/settings/route");

    const flat = await PUT(request({ ollamaBaseUrl: "not-a-url" }));
    const nested = await PUT(request({ workbench: { customBaseUrl: "not-a-url" } }));

    expect(flat.status).toBe(400);
    expect(nested.status).toBe(400);
    expect(((await flat.json()) as { error: string }).error).toBe(
      ((await nested.json()) as { error: string }).error,
    );
  });

  it("ACCEPTS an absolute URL, trimmed", async () => {
    // DISTINCT from the seeded value, so a route that ignored `body.ollamaBaseUrl`
    // outright and re-saved `{...existing}` cannot pass this by accident.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ ollamaBaseUrl: "  https://ollama.example:11434/api " }),
    );

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      ollamaBaseUrl: "https://ollama.example:11434/api",
    }, STORED_ETAG);
  });

  it("still DELETES on every blank form — the URL rule does not apply to a clear", async () => {
    // The rule fires only on a value that is going to be STORED. `null`, `""`
    // and whitespace all mean "remove the endpoint", and none of them is an
    // invalid URL the owner needs telling about.
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of [null, "", "   "]) {
      mockedSave.mockClear();
      const response = await PUT(request({ ollamaBaseUrl: value }));
      expect(response.status).toBe(200);
      expect(mockedSave).toHaveBeenCalledWith({}, STORED_ETAG);
    }
  });

  it("diverges from the workbench loop on WHITESPACE, deliberately", async () => {
    // The same predicate, not byte-identical handling of blanks — and the route
    // comment says so, which makes it a claim the suite has to carry. The
    // workbench URL loop skips the literal `""` only, so a whitespace-only
    // endpoint reaches `isAbsoluteHttpUrl("")` there and is REFUSED; the flat
    // path treats every blank form as a clear, which the case above pins.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ workbench: { customBaseUrl: "   " } }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: SETTINGS_INVALID_URL_COPY });
    expect(mockedSave).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// `structuredKnowledgeModel` decides its delete like its three siblings (DW-305)
// ---------------------------------------------------------------------------

describe("PUT /api/settings — structuredKnowledgeModel normalization (DW-305)", () => {
  beforeEach(() => {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: { structuredKnowledgeModel: "gpt-4o" },
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
  });

  it("DELETES the stored model on null", async () => {
    // `useSettings` sends exactly this for an emptied box.
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ structuredKnowledgeModel: null }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({}, STORED_ETAG);
  });

  it("TRIMS a padded model rather than storing the padding", async () => {
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ structuredKnowledgeModel: "  gpt-4o-mini  " }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({ structuredKnowledgeModel: "gpt-4o-mini" }, STORED_ETAG);
  });

  it("still refuses `\"\"` and whitespace above the merge", async () => {
    // Which is WHY the `=== ""` arm this replaced was unreachable: the non-empty
    // check answers 400 first. Pinned so the uniform `trimmed.length === 0`
    // branch cannot be read as a loosening.
    const { PUT } = await import("@/app/api/settings/route");

    for (const value of ["", "   "]) {
      mockedSave.mockClear();
      const response = await PUT(request({ structuredKnowledgeModel: value }));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "Structured Knowledge model must be a non-empty string",
      });
      expect(mockedSave).not.toHaveBeenCalled();
    }
  });
});

// ---------------------------------------------------------------------------
// The flat refusal is SCOPED to legs the flat page can act on (DW-303, DW-306)
// ---------------------------------------------------------------------------

describe("PUT /api/settings — the flat vector refusal names only actionable legs (DW-303)", () => {
  /**
   * An `openai` vector configuration that is switched ON and was ALREADY
   * unsatisfiable — on the endpoint and the key, the two legs `/settings`
   * renders no control for.
   */
  const ALREADY_BROKEN = {
    vectorSearchEnabled: true,
    embeddingProvider: "openai",
    embeddingModel: "text-embedding-3-small",
  } as const;

  function store(config: Record<string, unknown>): void {
    mockedRead.mockResolvedValue({
      status: "ok",
      config: config as never,
      version: STORED_VERSION,
      etag: STORED_ETAG,
    });
  }

  it("ALLOWS an embedding-model edit whose only unmet legs were unmet BEFORE the request", async () => {
    // THE DW-303 REPRODUCTION. The owner edits the one embedding control
    // `/settings` shows; the refusal used to demand an endpoint and an API key,
    // neither of which exists on that page — a surface the owner cannot leave.
    // The request made nothing worse, so it lands.
    store({ ...ALREADY_BROKEN });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: "text-embedding-3-large" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      ...ALREADY_BROKEN,
      embeddingModel: "text-embedding-3-large",
    }, STORED_ETAG);
  });

  it("still REFUSES when an unmet leg IS one this body could move", async () => {
    // Same already-broken store, but clearing the model makes the MODEL leg
    // unmet — and the model box is right there on the page. The sentence names
    // it alongside the two legs that are not actionable, because the refusal is
    // the Workbench's one sentence rather than a per-surface re-write.
    store({ ...ALREADY_BROKEN });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingModel: null }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search is switched on, but it needs an endpoint, a model and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    );
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("still REFUSES a flat move that BREAKS a configuration that worked (DW-217)", async () => {
    // `ollama` is self-transporting, so the stored config is satisfiable.
    // Switching to `openai` leaves the endpoint and key legs unmet — legs no
    // flat field can fill — and that is precisely why it must refuse rather than
    // silently switch effective vector search off.
    store({
      vectorSearchEnabled: true,
      embeddingProvider: "ollama",
      embeddingModel: "nomic-embed-text",
    });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingProvider: "openai" }));

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Supply what is missing, or turn the switch off in Workbench Settings → Embeddings.",
    );
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("ALLOWS choosing a provider where the baseline had none — the hidden legs are not this request's doing", async () => {
    // THE SHAPE A SET-DIFF PREDICATE GETS WRONG. `vectorSearchMissingLegs`
    // early-returns the provider leg ALONE, so the baseline reports `[provider]`
    // and the merge reports the `[endpoint, key]` that leg was hiding — a set
    // diff reads both as newly unmet and refuses with the unactionable sentence,
    // on a request that made an already-broken configuration no more broken.
    store({ vectorSearchEnabled: true, embeddingModel: "text-embedding-3-small" });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(request({ embeddingProvider: "openai" }));

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      vectorSearchEnabled: true,
      embeddingModel: "text-embedding-3-small",
      embeddingProvider: "openai",
    }, STORED_ETAG);
  });

  it("does NOT scope a body that carries a workbench key (DW-306)", async () => {
    // A `workbench` key means the Workbench sent it, and that surface renders
    // every embedding control — so every leg is actionable there and the refusal
    // is unchanged from today. The flat move is measured against the PRE-request
    // baseline, which is the one case the third argument exists for: handed the
    // post-legacy-merge object for both, the flat `embeddingModel` would compare
    // equal to itself and skip the gate.
    store({ ...ALREADY_BROKEN });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({
        embeddingModel: "text-embedding-3-large",
        workbench: { chatModel: "gpt-4o" },
      }),
    );

    expect(response.status).toBe(400);
    expect(((await response.json()) as { error: string }).error).toBe(
      "Vector search is switched on, but it needs an endpoint and an API key before it can run. Turn it off, or supply what is missing.",
    );
    // Nothing written — not the flat field, not the chat model.
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("saves a combined flat + workbench body that satisfies every leg (DW-306)", async () => {
    // The allowed twin: the same combined shape, where the `workbench` half
    // supplies the two legs the flat half cannot. Proof the refusal above is
    // about the LEGS and not about the combined body itself.
    store({ ...ALREADY_BROKEN });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({
        embeddingModel: "text-embedding-3-large",
        workbench: {
          embeddingBaseUrl: "https://embed.example",
          embeddingApiKey: "sk-embed",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(mockedSave).toHaveBeenCalledWith({
      ...ALREADY_BROKEN,
      embeddingModel: "text-embedding-3-large",
      embeddingBaseUrl: "https://embed.example",
      embeddingApiKey: "sk-embed",
    }, STORED_ETAG);
  });
});
