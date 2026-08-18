import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));
vi.mock("@/lib/config", async (original) => ({
  ...(await original<typeof import("@/lib/config")>()),
  loadConfig: vi.fn(),
  saveConfig: vi.fn(),
  getEffectiveSettings: vi.fn(),
  getEffectiveProvider: vi.fn(),
  isReadOnly: vi.fn(),
  _resetConfigCache: vi.fn(),
}));

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import {
  getEffectiveProvider,
  getEffectiveSettings,
  isReadOnly,
  loadConfig,
  saveConfig,
} from "@/lib/config";
import {
  WRITE_CONFLICT_COPY,
  WRITE_PRECONDITION_REQUIRED_COPY,
  formatIfMatch,
  objectVersion,
} from "@/lib/write-precondition";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedLoad = vi.mocked(loadConfig);
const mockedSave = vi.mocked(saveConfig);
const mockedEffectiveSettings = vi.mocked(getEffectiveSettings);
const mockedEffectiveProvider = vi.mocked(getEffectiveProvider);

/**
 * `PUT /api/settings` REQUIRES the write precondition (DW-63). `config` is the
 * object `loadConfig` is mocked to answer with, which is what the route hashes
 * — so the default matches and the refusals are asked for explicitly.
 */
function request(
  body: Record<string, unknown>,
  precondition: { config?: unknown; ifMatch?: string | null } = {},
) {
  const version =
    precondition.ifMatch !== undefined
      ? precondition.ifMatch
      : objectVersion(precondition.config ?? {});
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
  mockedLoad.mockResolvedValue({});
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
    expect(mockedLoad).not.toHaveBeenCalled();
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
    expect(mockedLoad).toHaveBeenCalledTimes(2);
  });

  it("persists an independent Structured Knowledge provider and model", async () => {
    const existing = { provider: "ollama-cloud" as const, model: "gpt-oss:120b" };
    mockedLoad.mockResolvedValue(existing);
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request(
        {
          structuredKnowledgeProvider: "openai",
          structuredKnowledgeModel: "gpt-4o",
        },
        { config: existing },
      ),
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
    // would otherwise put every field the other changed back.
    mockedLoad.mockResolvedValue({ provider: "openai" });
    const { PUT } = await import("@/app/api/settings/route");

    const response = await PUT(
      request({ model: "gpt-4o" }, { config: { provider: "anthropic" } }),
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
