import { afterEach, describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";

// clerkMiddleware runs at module load (`export default clerkMiddleware(...)`);
// stub it so importing the middleware doesn't require a Clerk runtime.
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (fn: unknown) => fn,
}));

import middleware, {
  authenticatesInRoute,
  isBearerMachineWrite,
} from "@/middleware";

const savedOwnerUserId = process.env.YOPEDIA_OWNER_USER_ID;

afterEach(() => {
  if (savedOwnerUserId === undefined) delete process.env.YOPEDIA_OWNER_USER_ID;
  else process.env.YOPEDIA_OWNER_USER_ID = savedOwnerUserId;
});

describe("write-gate in-route auth exemptions", () => {
  it("exempts the service-token-authenticated routes", () => {
    // These authenticate in-route with a token (no Clerk session) — a missing
    // entry silently 401s the caller before it reaches the route.
    expect(authenticatesInRoute("/api/tasks/run")).toBe(true); // task-consumer
    expect(authenticatesInRoute("/api/tasks/scan")).toBe(true); // maintenance cron
    expect(authenticatesInRoute("/api/email/ingest")).toBe(true); // Email Worker
    expect(authenticatesInRoute("/api/ingest")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/x-mention")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/batch")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/document")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/image")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/pdf")).toBe(true);
    expect(authenticatesInRoute("/api/ingest/reingest")).toBe(true);
    expect(authenticatesInRoute("/api/sync/status")).toBe(true);
    expect(authenticatesInRoute("/api/agents/seed")).toBe(true);
    expect(authenticatesInRoute("/api/agents/alice--yoyo/ingest")).toBe(true);
    expect(authenticatesInRoute("/api/agents/alice--yoyo/publish")).toBe(true);
    expect(authenticatesInRoute("/api/admin/migrate")).toBe(true);
    expect(authenticatesInRoute("/api/admin/reset")).toBe(true);
    expect(authenticatesInRoute("/api/admin/rebuild-embeddings")).toBe(true);
    expect(authenticatesInRoute("/api/admin/tenant/alice")).toBe(true);
    // Wiki routes: POST /api/wiki (create) and PUT/PATCH/DELETE /api/wiki/:slug
    expect(authenticatesInRoute("/api/wiki")).toBe(true);
    expect(authenticatesInRoute("/api/wiki/transformers")).toBe(true);
    // Remote MCP — Bearer token (per-user agent token / service token).
    expect(authenticatesInRoute("/api/mcp")).toBe(true);
  });

  it("does NOT exempt normal write paths (they need a Clerk session)", () => {
    expect(authenticatesInRoute("/api/vaults")).toBe(false);
    expect(authenticatesInRoute("/api/tasks/run/extra")).toBe(false);
    // Sub-paths beyond /api/wiki/:slug still go through Clerk (except revisions)
    expect(authenticatesInRoute("/api/wiki/transformers/discuss")).toBe(false);
  });

  it("does NOT exempt fixed wiki sub-routes that are not slugs", () => {
    // These match the WIKI_SLUG_RE pattern but are fixed routes, not page slugs.
    // They must NOT be exempted from the Clerk write-gate.
    expect(authenticatesInRoute("/api/wiki/dataview")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/browse")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/export")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/graph")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/routes")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/search")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/templates")).toBe(false);
  });

  it("does NOT exempt the LLM query endpoints — they stay signed-in-only", () => {
    // Querying costs a real LLM call. These are POST routes that must NOT be
    // added to the in-route exemption list, or the owner gate would stop 401ing
    // anonymous callers and free querying would open up. The routes also self-
    // guard on a null principal as defense-in-depth.
    expect(authenticatesInRoute("/api/query")).toBe(false);
    expect(authenticatesInRoute("/api/query/stream")).toBe(false);
  });

  it("exempts wiki revisions sub-route for service-token callers", () => {
    expect(authenticatesInRoute("/api/wiki/transformers/revisions")).toBe(true);
    expect(authenticatesInRoute("/api/wiki/test-slug/revisions")).toBe(true);
    // Must not overmatch other sub-routes or deeper paths
    expect(authenticatesInRoute("/api/wiki/transformers/revisions/extra")).toBe(false);
    expect(authenticatesInRoute("/api/wiki/transformers/discuss")).toBe(false);
  });
});

describe("private single-owner middleware gate", () => {
  type AuthMock = (() => Promise<{ userId: string | null }>) & {
    redirectToSignIn: ReturnType<typeof vi.fn>;
  };

  function authMock(userId: string | null): AuthMock {
    const redirectToSignIn = vi.fn(() =>
      Response.redirect("https://workwiki.app/sign-in", 307),
    );
    const auth = vi.fn(async () => ({
      userId,
      redirectToSignIn,
    })) as unknown as AuthMock;
    auth.redirectToSignIn = redirectToSignIn;
    return auth;
  }

  async function run(
    pathname: string,
    options: {
      method?: string;
      userId?: string | null;
      authorization?: string;
    } = {},
  ) {
    const headers = new Headers();
    if (options.authorization) {
      headers.set("authorization", options.authorization);
    }
    const req = new NextRequest(`https://workwiki.app${pathname}`, {
      method: options.method ?? "GET",
      headers,
    });
    const auth = authMock(options.userId ?? null);
    const response = await (
      middleware as unknown as (
        auth: AuthMock,
        req: NextRequest,
      ) => Promise<Response | undefined>
    )(auth, req);
    return { auth, response };
  }

  it("returns 401 for an anonymous API read", async () => {
    process.env.YOPEDIA_OWNER_USER_ID = "user_owner";
    const { response } = await run("/api/wiki");
    expect(response?.status).toBe(401);
    expect(response?.headers.get("cache-control")).toBe("private, no-store");
    expect(response?.headers.get("x-robots-tag")).toContain("noindex");
  });

  it("redirects anonymous page navigation to the owner sign-in", async () => {
    process.env.YOPEDIA_OWNER_USER_ID = "user_owner";
    const { auth, response } = await run("/wiki/graph");
    expect(auth.redirectToSignIn).toHaveBeenCalledWith({
      returnBackUrl: "https://workwiki.app/wiki/graph",
    });
    expect(response?.status).toBe(307);
  });

  it("allows only the configured Clerk owner", async () => {
    process.env.YOPEDIA_OWNER_USER_ID = "user_owner";
    const owner = await run("/wiki", { userId: "user_owner" });
    expect(owner.response?.status).toBe(200);
    expect(owner.response?.headers.get("x-middleware-next")).toBe("1");

    const other = await run("/wiki", { userId: "user_other" });
    expect(other.response?.status).toBe(404);
  });

  it("fails closed when the owner user id is missing", async () => {
    delete process.env.YOPEDIA_OWNER_USER_ID;
    const { response } = await run("/wiki", { userId: "user_owner" });
    expect(response?.status).toBe(503);
  });

  it("permits only bearer-authenticated machine writes to bypass Clerk", async () => {
    const serviceReq = new NextRequest("https://workwiki.app/api/tasks/run", {
      method: "POST",
      headers: { authorization: "Bearer service-token" },
    });
    expect(isBearerMachineWrite(serviceReq)).toBe(true);

    const noToken = new NextRequest("https://workwiki.app/api/tasks/run", {
      method: "POST",
    });
    expect(isBearerMachineWrite(noToken)).toBe(false);

    const publicRead = new NextRequest("https://workwiki.app/api/wiki", {
      method: "GET",
      headers: { authorization: "Bearer anything" },
    });
    expect(isBearerMachineWrite(publicRead)).toBe(false);
  });

  it("keeps Clerk's session proxy reachable", async () => {
    const { auth, response } = await run("/__clerk/v1/client");
    expect(response?.status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
  });

  it("keeps the content-free owner sign-in route reachable", async () => {
    const { auth, response } = await run("/sign-in");
    expect(response?.status).toBe(200);
    expect(auth).not.toHaveBeenCalled();
  });
});
