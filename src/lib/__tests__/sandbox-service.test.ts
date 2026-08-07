import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCloudflareContext = vi.fn();

vi.mock("@opennextjs/cloudflare", () => ({ getCloudflareContext }));

import { executeInSandbox } from "../sandbox-service";

const originalUrl = process.env.YOPEDIA_SANDBOX_URL;
const originalToken = process.env.YOPEDIA_SANDBOX_TOKEN;

beforeEach(() => {
  getCloudflareContext.mockReset();
  getCloudflareContext.mockImplementation(() => {
    throw new Error("off workers");
  });
  process.env.YOPEDIA_SANDBOX_URL = "https://sandbox.example/";
  process.env.YOPEDIA_SANDBOX_TOKEN = "sandbox-test-token";
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUrl === undefined) delete process.env.YOPEDIA_SANDBOX_URL;
  else process.env.YOPEDIA_SANDBOX_URL = originalUrl;
  if (originalToken === undefined) delete process.env.YOPEDIA_SANDBOX_TOKEN;
  else process.env.YOPEDIA_SANDBOX_TOKEN = originalToken;
});

describe("sandbox service", () => {
  it("uses the local URL fallback with a signed and byte-counted payload", async () => {
    vi.mocked(fetch).mockResolvedValue(Response.json({ stdout: "ok", stderr: "", exitCode: 0 }));

    await expect(executeInSandbox({
      runId: "run-12345678",
      command: "node script.js",
      files: { "script.js": "console.log('ok')" },
      outputFiles: ["result.json"],
    })).resolves.toMatchObject({ stdout: "ok", exitCode: 0 });

    const [url, init] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe("https://sandbox.example/execute");
    expect(init?.headers).toMatchObject({
      Authorization: "Bearer sandbox-test-token",
      "Content-Type": "application/json",
    });
    const payload = String(init?.body);
    expect(Number((init?.headers as Record<string, string>)["X-Yopedia-Payload-Bytes"]))
      .toBe(new TextEncoder().encode(payload).byteLength);
  });

  it("prefers the private Cloudflare service binding", async () => {
    const serviceFetch = vi.fn().mockResolvedValue(Response.json({ stdout: "private", stderr: "", exitCode: 0 }));
    getCloudflareContext.mockReturnValue({ env: { YOPEDIA_SANDBOX: { fetch: serviceFetch } } });

    await expect(executeInSandbox({ runId: "run-abcdefgh", command: "pwd" }))
      .resolves.toMatchObject({ stdout: "private" });
    expect(serviceFetch).toHaveBeenCalledWith(
      "https://yopedia-sandbox.internal/execute",
      expect.objectContaining({ method: "POST" }),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("requires both a transport and secret", async () => {
    delete process.env.YOPEDIA_SANDBOX_TOKEN;
    await expect(executeInSandbox({ runId: "run-abcdefgh", command: "pwd" }))
      .rejects.toThrow("YOPEDIA_SANDBOX_TOKEN");
  });
});
