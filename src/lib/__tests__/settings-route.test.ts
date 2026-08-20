import { beforeEach, describe, expect, it, vi } from "vitest";

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
