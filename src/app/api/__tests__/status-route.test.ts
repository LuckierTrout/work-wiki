import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * `GET /api/status` — the honest read (DW-622).
 *
 * The route used to await `loadConfig()`, which flattens `readStoredConfig`'s
 * `unreadable` answer to `{}`. A config that EXISTED and could not be parsed was
 * therefore served byte-for-byte like one that was never saved: `configured:
 * false`, `provider: null`, nothing anywhere on the body to say the store was
 * the reason. That is the conflation DW-549 closed for `yopedia status` and left
 * standing on the web.
 *
 * The route is driven directly rather than over a socket, and both of its
 * collaborators are mocked, because what is under test is the ROUTE's own
 * decision — which door it reads through, what it carries onto each body, and
 * what it refuses to carry. Storage, parsing and provider resolution all have
 * their own suites.
 *
 * The route had no test before this file.
 */

vi.mock("@/lib/config", () => ({
  readConfig: vi.fn(),
  loadConfig: vi.fn(),
}));
vi.mock("@/lib/llm", () => ({
  getProviderInfo: vi.fn(),
}));

import { readConfig, loadConfig } from "@/lib/config";
import { getProviderInfo } from "@/lib/llm";
import { GET } from "@/app/api/status/route";

const mockedRead = vi.mocked(readConfig);
const mockedLoad = vi.mocked(loadConfig);
const mockedInfo = vi.mocked(getProviderInfo);

/** What the environment resolved, independent of how the store read. */
function providerInfo(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    provider: null,
    model: null,
    embeddingSupport: false,
    ollamaBaseUrlIssue: null,
    ...overrides,
  } as ReturnType<typeof getProviderInfo>;
}

/**
 * `readConfig()` succeeding — an absent store (ENOENT) reads exactly like this.
 *
 * No parameter for the config's CONTENTS, because they are not this endpoint's
 * input: the route asks the read one question (`status !== "ok"`) and takes
 * everything else from `getProviderInfo()`, which is mocked. A fixture that
 * accepted settings here would imply a coupling the route does not have.
 */
function okRead() {
  return {
    status: "ok" as const,
    config: {},
    version: "unstamped",
    etag: null,
  } as unknown as Awaited<ReturnType<typeof readConfig>>;
}

/** `readConfig()` failing — bad JSON, a non-object, or a storage error. */
function unreadableRead(error: unknown) {
  return { status: "unreadable" as const, error } as unknown as Awaited<
    ReturnType<typeof readConfig>
  >;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedRead.mockResolvedValue(okRead());
  mockedInfo.mockReturnValue(providerInfo());
});

describe("GET /api/status — the config read", () => {
  it("reads through readConfig, once, and never through the lossy loadConfig", async () => {
    // ONE read, one round-trip: `readConfig()` REPLACES `loadConfig()` rather
    // than being added beside it. The warm this route performs for
    // `getProviderInfo()` (DW-502/DW-550) is the same single read it always was
    // — `readConfig` primes the sync cache identically on the ok path — and a
    // second read here would be a second storage round-trip per request for a
    // fact the first one already answered.
    await GET();

    expect(mockedRead).toHaveBeenCalledTimes(1);
    expect(mockedLoad).not.toHaveBeenCalled();
  });

  it("warms the cache BEFORE the resolver runs", async () => {
    // The whole reason this route reads at all: `getProviderInfo()` is
    // synchronous over the cache, so a read that landed after it would resolve
    // the environment alone and the stored provider would be invisible.
    const order: string[] = [];
    mockedRead.mockImplementation(async () => {
      order.push("read");
      return okRead();
    });
    mockedInfo.mockImplementation(() => {
      order.push("resolve");
      return providerInfo();
    });

    await GET();

    expect(order).toEqual(["read", "resolve"]);
  });

  it("serves the whole ProviderInfo plus configUnreadable: false on a readable store", async () => {
    mockedInfo.mockReturnValue(
      providerInfo({ configured: true, provider: "anthropic", model: "claude-x" }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    // Byte-for-byte what it was, plus the one new field — the body is a shape
    // `StatusBadge` and `useSettings` both hand-duplicate.
    expect(await response.json()).toEqual({
      configured: true,
      provider: "anthropic",
      model: "claude-x",
      embeddingSupport: false,
      ollamaBaseUrlIssue: null,
      configUnreadable: false,
    });
  });

  it("says nothing about the store when it is simply ABSENT", async () => {
    // ENOENT is `status: "ok"` with `{}` inside `readStoredConfig`, and that is
    // the distinction this endpoint exists to draw: a deployment that never
    // saved anything is not a deployment with a broken file.
    mockedRead.mockResolvedValue(okRead());

    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body.configUnreadable).toBe(false);
  });
});

describe("GET /api/status — an unreadable store", () => {
  it("still answers 200 with the env-resolved fields, and flags the read", async () => {
    // NOT a 503 and not an error body: every other field on this object reports
    // what the ENVIRONMENT resolves, and the environment resolved fine. The flag
    // is a caveat on that reading, not a failure of the request.
    mockedRead.mockResolvedValue(unreadableRead(new SyntaxError("Unexpected token }")));
    mockedInfo.mockReturnValue(
      providerInfo({ configured: true, provider: "openai", model: "gpt-4o" }),
    );

    const response = await GET();

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      configured: true,
      provider: "openai",
      model: "gpt-4o",
      embeddingSupport: false,
      ollamaBaseUrlIssue: null,
      configUnreadable: true,
    });
  });

  it("carries NO error text, snippet or byte of the file", async () => {
    // AD-23. The store holds `customApiKey`, `embeddingApiKey` and
    // `firecrawlApiKey`, and V8's `JSON.parse` message quotes the offending
    // bytes straight back — so a parser string on this body is an endpoint that
    // serves secret material to anyone who can reach it. The flag is a BOOLEAN
    // and the detail stays in the `logger.warn` inside `readStoredConfig`.
    const error = new SyntaxError(
      `Unexpected token } in JSON at position 42: {"customApiKey":"sk-live-SECRET"`,
    );
    mockedRead.mockResolvedValue(unreadableRead(error));

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(body);

    expect(body.configUnreadable).toBe(true);
    expect(Object.keys(body).sort()).toEqual([
      "configUnreadable",
      "configured",
      "embeddingSupport",
      "model",
      "ollamaBaseUrlIssue",
      "provider",
    ]);
    expect(serialized).not.toContain("sk-live-SECRET");
    expect(serialized).not.toContain("Unexpected token");
    expect(serialized).not.toContain("customApiKey");
    // …and nothing that names the file or the storage layer either.
    expect(serialized.toLowerCase()).not.toContain("config.json");
  });

  it("flags a storage failure the same way it flags bad bytes", async () => {
    // `readStoredConfig` answers `unreadable` for a non-ENOENT storage error and
    // for a parse that produced a non-object, not just for malformed JSON. The
    // route asks only `status !== "ok"`, so all three read the same from here.
    mockedRead.mockResolvedValue(unreadableRead(new Error("R2 unavailable")));

    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body.configUnreadable).toBe(true);
  });
});

describe("GET /api/status — the resolver throwing", () => {
  it("keeps the 500 branch, and reports the read that already happened", async () => {
    mockedRead.mockResolvedValue(unreadableRead(new Error("bad bytes")));
    mockedInfo.mockImplementation(() => {
      throw new Error("resolver exploded");
    });

    const response = await GET();

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      configured: false,
      provider: null,
      model: null,
      embeddingSupport: false,
      ollamaBaseUrlIssue: null,
      configUnreadable: true,
      error: "Error: resolver exploded",
    });
  });

  it("reports a CLEAN read on the 500 body too", async () => {
    // The read happens first and its answer survives a throwing RESOLVER, so
    // this branch does not smear one failure over the other: a store that read
    // fine and a resolver that then failed is not an unreadable store.
    mockedInfo.mockImplementation(() => {
      throw new Error("resolver exploded");
    });

    const body = (await (await GET()).json()) as Record<string, unknown>;

    expect(body.configUnreadable).toBe(false);
  });

  it("flags the store when the READ itself rejects, rather than claiming it clean", async () => {
    // Unreachable today — `readConfig()` returns its failures rather than
    // throwing — and pinned anyway, because it is the one case where the store's
    // state is genuinely UNKNOWN. Reporting `false` there would be the endpoint
    // asserting a clean store it never managed to look at, which is the same
    // conflation in a new place. The flag starts `true` and is cleared only by a
    // read that answered, so the unreachable path is inert instead of wrong.
    mockedRead.mockRejectedValue(new Error("storage client blew up"));

    const response = await GET();
    const body = (await response.json()) as Record<string, unknown>;

    expect(response.status).toBe(500);
    expect(body.configUnreadable).toBe(true);
    expect(body.error).toBe("Error: storage client blew up");
    // …and the rejection's own text is the `error` field the branch always
    // carried, nothing new: still no parser snippet and no bytes.
    expect(mockedInfo).not.toHaveBeenCalled();
  });
});
