import { clerkMiddleware } from "@clerk/nextjs/server";
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// HTTP methods that mutate state.
const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// work-wiki is a private, single-owner deployment. Every application page and
// API request requires the configured Clerk owner session. The only exceptions
// are Clerk's own proxy path (needed to establish a session) and machine write
// routes that authenticate in-route with an existing bearer token.
//
// Exception: some routes authenticate IN-ROUTE with a token instead of a Clerk
// session, so they're exempt from this gate (they still reject unauthenticated
// callers — the auth just lives in the handler):
//   - /api/agents/seed            — Clerk session OR the system service token
//   - /api/agents/<id>/ingest     — the agent's own per-agent token
//   - /api/ingest                 — Clerk session OR the system service token
//   - /api/ingest/batch           — Clerk session OR the system service token
//   - /api/ingest/document        — Clerk session OR the system service token
//   - /api/ingest/image           — Clerk session OR the system service token
//   - /api/ingest/pdf             — Clerk session OR the system service token
//   - /api/ingest/reingest        — Clerk session OR the system service token
//   - /api/ingest/x-mention       — Clerk session OR the system service token
//   - /api/tasks/run              — the system service token ONLY (the task-
//                                   consumer worker; has no Clerk session)
//   - /api/email/ingest           — the system service token ONLY (Email Worker)
//   - /api/tasks/scan            — the system service token ONLY (the cron)
//   - /api/wiki                   — Clerk session OR the system service token
//   - /api/wiki/<slug>            — Clerk session OR the system service token
//   - /api/wiki/<slug>/revisions   — Clerk session OR the system service token
//   - /api/mcp                    — remote MCP: Bearer agent/service token
// This is not a hole.
const IN_ROUTE_AUTH_PATHS = new Set([
  "/api/agents/seed",
  // Remote (HTTP) MCP endpoint — authenticates in-route via a Bearer token
  // (per-user agent token or the service token).
  "/api/mcp",
  "/api/ingest",
  "/api/ingest/batch",
  "/api/ingest/document",
  "/api/ingest/image",
  "/api/ingest/pdf",
  "/api/ingest/reingest",
  "/api/ingest/x-mention",
  // Local sync companion heartbeat: authenticated in-route by the owner
  // service token. Browser reads/deletes still require the owner Clerk session.
  "/api/sync/status",
  // Full owner archive restore. The route resolves the fixed service principal
  // before it reads or writes any tenant data.
  "/api/archive/import",
  "/api/email/ingest",
  // Agent task-queue executor + maintenance scanner: authenticated in-route by
  // the service token (getServicePrincipal); the sole callers are the
  // task-consumer worker (queue handler + cron), which has no Clerk session.
  "/api/tasks/run",
  "/api/tasks/scan",
  // Admin migration: authenticated in-route by the service token OR the site
  // owner's session (it rejects everyone else with 403).
  "/api/admin/migrate",
  // Admin content reset (destructive wipe): service-token only, in-route, with
  // an explicit confirm body. Called with no Clerk session.
  "/api/admin/reset",
  // Admin embedding rebuild: service-token only, in-route. Backfills Vectorize
  // (the settings-page rebuild is disabled on the read-only Workers runtime).
  "/api/admin/rebuild-embeddings",
  // Wiki page creation: authenticated in-route via Clerk session OR the
  // service token (agents create pages via REST).
  "/api/wiki",
]);
const AGENT_INGEST_RE = /^\/api\/agents\/[^/]+\/ingest$/;
// Wiki page mutations by slug: authenticated in-route via Clerk session OR the
// service token (agents update/patch/delete pages via REST).
// The regex matches /api/wiki/<segment> — but fixed sub-routes (browse,
// dataview, etc.) are NOT slug routes and must NOT be exempted.
const WIKI_SLUG_RE = /^\/api\/wiki\/[^/]+$/;
const WIKI_FIXED_ROUTES = new Set([
  "/api/wiki/browse",
  "/api/wiki/dataview",
  "/api/wiki/export",
  "/api/wiki/graph",
  "/api/wiki/routes",
  "/api/wiki/search",
  "/api/wiki/templates",
]);
// Wiki revision revert: POST /api/wiki/:slug/revisions — authenticated in-route
// via Clerk session OR the service token (automated revert tasks).
const WIKI_REVISIONS_RE = /^\/api\/wiki\/[^/]+\/revisions$/;
// Admin tenant delete: authenticated in-route by the service token, the site
// owner, or the tenant's own owner (it 403s everyone else).
const ADMIN_TENANT_RE = /^\/api\/admin\/tenant\/[^/]+$/;
const MACHINE_READ_PATHS = new Set(["/api/archive/export"]);

/**
 * Whether a path authenticates in-route (token, not a Clerk session) and is
 * therefore exempt from the middleware's Clerk write-gate. Exported so the
 * exemption list is regression-tested (a missing entry silently 401s a
 * service-token caller before it reaches the route — see /api/tasks/run).
 */
export function authenticatesInRoute(pathname: string): boolean {
  return (
    IN_ROUTE_AUTH_PATHS.has(pathname) ||
    AGENT_INGEST_RE.test(pathname) ||
    (WIKI_SLUG_RE.test(pathname) && !WIKI_FIXED_ROUTES.has(pathname)) ||
    WIKI_REVISIONS_RE.test(pathname) ||
    ADMIN_TENANT_RE.test(pathname)
  );
}

const CLERK_PROXY_RE = /^\/__clerk(?:\/|$)/;
const SIGN_IN_RE = /^\/sign-in(?:\/|$)/;

/**
 * Machine callers have no Clerk session. Only mutating routes that explicitly
 * validate bearer credentials in their own handler may bypass the owner-session
 * gate, and only when a bearer credential is actually present. The route still
 * performs the cryptographic/token lookup and rejects invalid credentials.
 */
export function isBearerMachineWrite(
  req: Pick<NextRequest, "method" | "headers" | "nextUrl">,
): boolean {
  return (
    WRITE_METHODS.has(req.method) &&
    authenticatesInRoute(req.nextUrl.pathname) &&
    /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "")
  );
}

/** Owner-scoped machine reads used by the optional local backup companion. */
export function isBearerMachineRead(
  req: Pick<NextRequest, "method" | "headers" | "nextUrl">,
): boolean {
  return (
    req.method === "GET" &&
    MACHINE_READ_PATHS.has(req.nextUrl.pathname) &&
    /^Bearer\s+\S+/i.test(req.headers.get("authorization") ?? "")
  );
}

function privateResponse<T extends NextResponse>(response: T): T {
  response.headers.set("Cache-Control", "private, no-store");
  response.headers.set("Pragma", "no-cache");
  response.headers.set("X-Robots-Tag", "noindex, nofollow, noarchive");
  return response;
}

function jsonError(message: string, status: number): NextResponse {
  return privateResponse(NextResponse.json({ error: message }, { status }));
}

export default clerkMiddleware(async (auth, req) => {
  const { pathname } = req.nextUrl;

  // The authentication surface and Clerk proxy are the only public app paths.
  // They expose no work-wiki content and are required to establish a session.
  if (SIGN_IN_RE.test(pathname) || CLERK_PROXY_RE.test(pathname)) {
    return privateResponse(NextResponse.next());
  }

  // Queue, cron, email, agent, and MCP callers authenticate inside the route.
  // A missing bearer header never bypasses the private deployment boundary.
  if (isBearerMachineWrite(req) || isBearerMachineRead(req)) {
    return privateResponse(NextResponse.next());
  }

  const isApi = pathname.startsWith("/api/");
  const { userId, redirectToSignIn } = await auth();

  if (!userId) {
    if (isApi) return jsonError("Authentication required.", 401);

    // Browser navigation gets a real sign-in redirect (auth.protect intentionally
    // hides content with a 404, which is not usable after the owner's session
    // expires). Clerk preserves the original destination as the return URL.
    return redirectToSignIn({ returnBackUrl: req.url });
  }

  // Stable Clerk id, not an editable username. Missing configuration fails
  // closed so a bad deployment can never silently become "any signed-in user".
  const ownerUserId = process.env.YOPEDIA_OWNER_USER_ID?.trim();
  if (!ownerUserId) {
    return isApi
      ? jsonError("Private deployment is not configured.", 503)
      : privateResponse(new NextResponse("Service unavailable", { status: 503 }));
  }

  if (userId !== ownerUserId) {
    return isApi
      ? jsonError("Owner access required.", 403)
      : privateResponse(new NextResponse("Not Found", { status: 404 }));
  }

  return privateResponse(NextResponse.next());
}, { signInUrl: "/sign-in" });

export const config = {
  matcher: [
    // Skip Next.js internals and static assets, run on everything else.
    "/((?!_next|[^?]*\\.(?:html?|css|js(?!on)|jpe?g|webp|png|gif|svg|ttf|woff2?|ico|csv|docx?|xlsx?|zip|webmanifest)).*)",
    // Always run for API routes and Clerk's auto-proxy path.
    "/(api|trpc)(.*)",
    "/__clerk/(.*)",
  ],
};
