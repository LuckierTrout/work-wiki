import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// Only the external session boundary is stubbed. Middleware, service-token
// validation, owner checks and the startup route handlers are real.
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (fn: unknown) => fn,
  auth: vi.fn(async () => ({ userId: null })),
  currentUser: vi.fn(async () => null),
}));

import { handlePrivateRequest } from "@/middleware";
import { GET as settings } from "@/app/api/v1/loopback-settings/route";
import { GET as projects } from "@/app/api/v1/projects/route";
import { POST as webSearch } from "@/app/api/v1/web-search/route";
import { loadConfig, saveConfig, _resetConfigCache } from "@/lib/config";

const token = "sidecar-middleware-test-service-token";
const routes = [
  ["GET", "/api/v1/loopback-settings"],
  ["GET", "/api/v1/projects"],
  ["GET", "/api/v1/projects/current/files"],
  ["GET", "/api/v1/projects/current/files/content"],
  ["GET", "/api/v1/projects/current/graph"],
  ["GET", "/api/v1/projects/current/reviews"],
  ["GET", "/api/sources/search"],
  ["GET", "/api/graph/workbench"],
  ["POST", "/api/v1/projects/current/search"],
  ["POST", "/api/v1/projects/current/sources/rescan"],
  ["POST", "/api/v1/projects/current/reviews/resolve"],
  ["POST", "/api/v1/web-search"],
  ["PATCH", "/api/v1/projects/current/reviews"],
  ["PATCH", "/api/v1/projects/current/reviews/review-id"],
] as const;

beforeEach(() => {
  vi.stubEnv("YOPEDIA_E2E", "");
  vi.stubEnv("YOPEDIA_SERVICE_TOKEN", token);
  vi.stubEnv("YOPEDIA_SERVICE_PRINCIPAL", "sidecar-owner");
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "sidecar-owner");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_owner");
});
afterEach(() => vi.unstubAllEnvs());

async function gate(method: string, path: string, authorization?: string) {
  const req = new NextRequest(`http://localhost${path}`, {
    method,
    headers: authorization ? { authorization } : undefined,
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  const auth = vi.fn(async () => ({
    userId: null,
    redirectToSignIn: () => Response.redirect("http://localhost/sign-in"),
  }));
  return { req, auth, response: await handlePrivateRequest(auth, req) };
}

describe("sidecar requests through the private middleware", () => {
  it("reads saved loopback settings even when the kernel cache is cold", async () => {
    const original = await loadConfig();
    try {
      await saveConfig({ ...original, apiEnabled: true, loopbackApiToken: "saved-loopback-token", skillEnablement: { example: false } });
      _resetConfigCache();
      const request = await gate("GET", "/api/v1/loopback-settings", `Bearer ${token}`);
      const response = await settings(request.req);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ enabled: true, token: "saved-loopback-token", skillEnablement: { example: false } });
    } finally {
      await saveConfig(original);
      _resetConfigCache();
    }
  });

  it.each(routes)("lets %s %s reach its bearer-authenticated handler", async (method, path) => {
    const result = await gate(method, path, `Bearer ${token}`);
    expect(result.response.headers.get("x-middleware-next")).toBe("1");
    expect(result.response.headers.get("cache-control")).toBe("private, no-store");
    expect(result.auth).not.toHaveBeenCalled();
  });

  it.each(routes)("still requires credentials for %s %s", async (method, path) => {
    for (const header of [undefined, "Bearer ", "Basic credentials"]) {
      expect((await gate(method, path, header)).response.status).toBe(401);
    }
  });

  it.each([
    ["GET", "/api/settings"],
    ["POST", "/api/v1/projects"],
    ["DELETE", "/api/v1/projects/current/files"],
    ["GET", "/api/v1/projects/current/files/content/extra"],
    ["GET", "/api/v1/projects/current/new-route"],
    ["POST", "/api/v1/projects/current/retrieve"],
    ["POST", "/api/v1/chat"],
    ["GET", "/api/v1/health"],
    ["PATCH", "/api/v1/projects/current/reviews/resolve"],
    ["POST", "/api/query"],
  ])("keeps unlisted method/path %s %s behind the session gate", async (method, path) => {
    expect((await gate(method, path, `Bearer ${token}`)).response.status).toBe(401);
  });

  it.each([["settings", settings, "/api/v1/loopback-settings"], ["projects", projects, "/api/v1/projects"]] as const)(
    "composes middleware with real %s authentication and handler",
    async (_name, handler, path) => {
      const valid = await gate("GET", path, `Bearer ${token}`);
      expect(valid.response.headers.get("x-middleware-next")).toBe("1");
      expect((await handler(valid.req)).status).toBe(200);

      const invalid = await gate("GET", path, "Bearer incorrect-token");
      expect(invalid.response.headers.get("x-middleware-next")).toBe("1");
      expect((await handler(invalid.req)).status).toBe(401);

      vi.stubEnv("YOPEDIA_SERVICE_PRINCIPAL", "not-the-owner");
      expect((await handler(valid.req)).status).toBe(401);
      vi.stubEnv("YOPEDIA_SERVICE_PRINCIPAL", "sidecar-owner");
      vi.stubEnv("YOPEDIA_SERVICE_TOKEN", "rotated-token");
      expect((await handler(valid.req)).status).toBe(401);
    },
  );

  it("authenticates a Chat tool POST before validating its body or calling a provider", async () => {
    const valid = await gate("POST", "/api/v1/web-search", `Bearer ${token}`);
    expect(valid.response.headers.get("x-middleware-next")).toBe("1");
    expect((await webSearch(valid.req)).status).toBe(400); // missing query
    const invalid = await gate("POST", "/api/v1/web-search", "Bearer incorrect-token");
    expect((await webSearch(invalid.req)).status).toBe(401);
  });
});
