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
import { mintE2eCookie } from "@/lib/e2e-identity";

const E2E_KEYS = [
  "YOPEDIA_OWNER_USER_ID",
  "YOPEDIA_E2E",
  "YOPEDIA_E2E_SECRET",
  "YOPEDIA_SITE_URL",
  "NEXT_PUBLIC_OWNER_HANDLE",
] as const;
const originalEnv = Object.fromEntries(
  E2E_KEYS.map((key) => [key, process.env[key]]),
);

/**
 * DW-500 — the E2E fixture values, named once so the two SIDES of the admit
 * assertion can be told apart.
 *
 * The admit row used to retype `"user_e2e_owner"` twice: once as the cookie's
 * subject and once as `YOPEDIA_OWNER_USER_ID`. Those are not the same fact —
 * the middleware resolves the owner id from configuration AT REQUEST TIME and
 * compares it against the cookie — but with one literal on both sides the row
 * passed whether the gate compared them or not, and equally whether it resolved
 * the owner from configuration or simply returned this literal.
 *
 * Two ids close the two halves of that:
 *   - `E2E_ROTATED_OWNER_ID` is a SECOND owner the admit row also has to admit.
 *     One configured id can be hardcoded; two cannot, so the admit row now
 *     observes `getOwnerUserId()` rather than agreeing with a constant.
 *   - `E2E_STALE_OWNER_ID` is a cookie whose HMAC is perfectly valid but whose
 *     subject the deployment is no longer configured with, which is what makes
 *     the comparison itself observable.
 */
const E2E_OWNER_ID = "user_e2e_owner";
const E2E_ROTATED_OWNER_ID = "user_e2e_rotated_owner";
const E2E_STALE_OWNER_ID = "user_e2e_former_owner";
const E2E_SECRET = "e2e-local-secret-do-not-use-in-prod-32";

afterEach(() => {
  for (const key of E2E_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
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
    // The retired publish route answers 404 in-route when reached; it needs no
    // exemption (a bearer caller now gets 401 at this gate, never the route).
    expect(authenticatesInRoute("/api/agents/alice--yoyo/publish")).toBe(false);
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
      cookie?: string;
    } = {},
  ) {
    const headers = new Headers();
    if (options.authorization) {
      headers.set("authorization", options.authorization);
    }
    if (options.cookie) {
      headers.set("cookie", options.cookie);
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

  it("does not let a session-less BROWSER revert bypass the gate (DW-392)", async () => {
    // `RevisionHistory`'s Revert gate carries a signed-in term, and its whole
    // justification is this: the revisions path is on the in-route exemption
    // list, but `isBearerMachineWrite` only honours that list when a `Bearer`
    // credential is actually present — which a browser never sends. Without
    // this row the exemption could grow into an unconditional one and the
    // client gate's stated premise would be false with every suite green.
    const browserRevert = new NextRequest(
      "https://workwiki.app/api/wiki/transformers/revisions",
      { method: "POST" },
    );
    expect(authenticatesInRoute(browserRevert.nextUrl.pathname)).toBe(true);
    expect(isBearerMachineWrite(browserRevert)).toBe(false);

    // …and the gate it therefore reaches answers 401, not a pass-through.
    const { response } = await run("/api/wiki/transformers/revisions", {
      method: "POST",
      userId: null,
    });
    expect(response?.status).toBe(401);
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

  /** Arms the harness for the configured owner, off the production origin. */
  function armE2e(ownerUserId: string) {
    process.env.YOPEDIA_E2E = "1";
    process.env.YOPEDIA_E2E_SECRET = E2E_SECRET;
    process.env.YOPEDIA_OWNER_USER_ID = ownerUserId;
    delete process.env.YOPEDIA_SITE_URL;
  }

  // DW-500 — run over TWO distinct configured owners. A single fixture id is
  // indistinguishable from a hardcode: the gate could ignore
  // `YOPEDIA_OWNER_USER_ID` entirely, answer with the literal, and still admit.
  // Whichever id such a hardcode named, the other case here would refuse.
  it.each([E2E_OWNER_ID, E2E_ROTATED_OWNER_ID])(
    "admits the local E2E owner cookie for the configured owner %s, without calling Clerk",
    async (ownerUserId) => {
      armE2e(ownerUserId);
      const value = await mintE2eCookie(ownerUserId, E2E_SECRET);
      const { auth, response } = await run("/", { cookie: `yopedia_e2e=${value}` });
      expect(response?.status).toBe(200);
      expect(response?.headers.get("x-middleware-next")).toBe("1");
      expect(auth).not.toHaveBeenCalled();
    },
  );

  it("does NOT admit a validly signed cookie minted for a DIFFERENT owner id", async () => {
    // DW-500 — the row that makes the admit above mean something. Same secret,
    // so the HMAC verifies; only the SUBJECT differs from the configured owner,
    // which is exactly the shape of a stale cookie surviving an owner rotation.
    // `principalFromCookieValue` refuses on `userId !== ownerId` and returns
    // null, so this lands on the armed branch's no-identity exit —
    // `unsignedInResponse`, a 307 to /sign-in for a browser path — rather than
    // the middleware's own 404 mismatch branch. Either way Clerk stays untouched.
    expect(
      new Set([E2E_OWNER_ID, E2E_ROTATED_OWNER_ID, E2E_STALE_OWNER_ID]).size,
    ).toBe(3);
    armE2e(E2E_OWNER_ID);
    const value = await mintE2eCookie(E2E_STALE_OWNER_ID, E2E_SECRET);
    const { auth, response } = await run("/wiki/graph", {
      cookie: `yopedia_e2e=${value}`,
    });
    expect(auth).not.toHaveBeenCalled();
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toContain("/sign-in");
  });

  it("redirects an E2E-armed browser with no cookie, still without Clerk", async () => {
    armE2e(E2E_OWNER_ID);
    const { auth, response } = await run("/wiki/graph");
    expect(auth).not.toHaveBeenCalled();
    expect(response?.status).toBe(307);
    expect(response?.headers.get("location")).toContain("/sign-in");
  });
});
