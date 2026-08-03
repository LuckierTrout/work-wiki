import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getHermesStatus } from "../chat";

const saved = {
  url: process.env.HERMES_AGENT_URL,
  key: process.env.HERMES_API_KEY,
};

function mockHermes(toolsets: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/health")) {
        return new Response(JSON.stringify({ status: "ok" }), { status: 200 });
      }
      return new Response(JSON.stringify(toolsets), { status: 200 });
    }),
  );
}

beforeEach(() => {
  process.env.HERMES_AGENT_URL = "https://hermes.example.test";
  process.env.HERMES_API_KEY = "test-hermes-key";
});

afterEach(() => {
  if (saved.url === undefined) delete process.env.HERMES_AGENT_URL;
  else process.env.HERMES_AGENT_URL = saved.url;
  if (saved.key === undefined) delete process.env.HERMES_API_KEY;
  else process.env.HERMES_API_KEY = saved.key;
  vi.unstubAllGlobals();
});

describe("Hermes safety discovery", () => {
  it("accepts the current OpenAI-style data envelope", async () => {
    mockHermes({ object: "list", platform: "api_server", data: [] });

    await expect(getHermesStatus()).resolves.toEqual({
      configured: true,
      available: true,
      safe: true,
    });
  });

  it("keeps compatibility with the legacy bare-array response", async () => {
    mockHermes([]);

    await expect(getHermesStatus()).resolves.toEqual({
      configured: true,
      available: true,
      safe: true,
    });
  });

  it("rejects a dangerous enabled toolset even when its tool list is empty", async () => {
    mockHermes({
      object: "list",
      platform: "api_server",
      data: [{ name: "terminal", enabled: true, tools: [] }],
    });

    await expect(getHermesStatus()).resolves.toEqual({
      configured: true,
      available: false,
      safe: false,
      reason: "Hermes has host-mutating tools enabled for the API server.",
    });
  });

  it("fails closed on an unrecognized discovery response", async () => {
    mockHermes({ object: "list", platform: "api_server" });

    await expect(getHermesStatus()).resolves.toEqual({
      configured: true,
      available: false,
      safe: false,
      reason: "Hermes returned an unrecognized tool-discovery response.",
    });
  });
});
