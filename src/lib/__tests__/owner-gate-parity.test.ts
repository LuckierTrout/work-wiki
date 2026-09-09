/**
 * DW-486 — a principal the DEPLOYMENT GATE admitted is never refused by a
 * ROUTE gate.
 *
 * The bug this pins against was a disagreement between two facts.
 * `handlePrivateRequest` in `src/middleware.ts` admits on the STABLE Clerk id
 * (`YOPEDIA_OWNER_USER_ID`); every route and page gate used to answer the same
 * question from the HANDLE (`NEXT_PUBLIC_OWNER_HANDLE`). Those drift apart in
 * two ordinary ways — `getPrincipal` falls back to the raw Clerk id as the
 * handle for a user with no username and no linked X account, and a username
 * change moves the handle — and when they did, the real owner passed middleware
 * and was then 403'd/404'd by a route gate, with no in-app recovery at all
 * (`NEXT_PUBLIC_*` is inlined at build time, so the fix was a redeploy).
 *
 * Two halves, because neither alone holds the property:
 *
 *  (a) BEHAVIOURAL — with an owner id configured, every server owner gate
 *      admits the principal carrying that id whatever its handle says.
 *  (b) SOURCE SCAN — no server-side surface reaches for `isOwnerHandle(` any
 *      more. A behavioural test can only cover the gates it thinks to call; the
 *      scan is what stops another gate from returning to a handle comparison.
 *      Client islands now receive server-computed owner flags.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import path from "path";

vi.mock("../auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(),
}));

// `clerkMiddleware` runs at module load (`export default clerkMiddleware(...)`),
// so importing the middleware needs it stubbed — the same shim
// `middleware-write-gate.test.ts` uses. It costs nothing here: `@/lib/auth` is
// already replaced above, so nothing else in this graph reaches Clerk.
vi.mock("@clerk/nextjs/server", () => ({
  clerkMiddleware: (fn: unknown) => fn,
}));

import { NextRequest } from "next/server";
import middleware from "@/middleware";
import { getPrincipal, getServicePrincipal } from "../auth";
import { isOwnerPrincipal } from "../owner";
import { canWritePage, isAdmin } from "../authz";
import { requireOwnerPrincipal, requireOwnerOrServicePrincipal } from "../owner-route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedService = vi.mocked(getServicePrincipal);

const OWNER_ID = "user_2stableClerkId";
const OWNER_HANDLE = "alice";

const saved = {
  id: process.env.YOPEDIA_OWNER_USER_ID,
  handle: process.env.NEXT_PUBLIC_OWNER_HANDLE,
  admins: process.env.ADMIN_HANDLES,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockedService.mockReturnValue(null);
  // The configuration production actually runs (`wrangler.jsonc` sets both).
  process.env.YOPEDIA_OWNER_USER_ID = OWNER_ID;
  process.env.NEXT_PUBLIC_OWNER_HANDLE = OWNER_HANDLE;
  delete process.env.ADMIN_HANDLES;
});

afterEach(() => {
  for (const [key, value] of [
    ["YOPEDIA_OWNER_USER_ID", saved.id],
    ["NEXT_PUBLIC_OWNER_HANDLE", saved.handle],
    ["ADMIN_HANDLES", saved.admins],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

/**
 * The handles a middleware-admitted owner can actually show up with.
 *
 * `user_2stableClerkId` is not a contrivance: it is exactly what
 * `getPrincipal` puts in `handle` when Clerk hands back a user with no username
 * and no linked X account (it logs a warning and uses the id). `alice2` is the
 * username-change case. `alice` is the configured handle, which must keep
 * working — the id path is a decision, not a replacement that breaks the
 * ordinary case.
 */
const ADMITTED_HANDLES = [
  ["the configured handle", OWNER_HANDLE],
  ["the raw Clerk id (no username, no linked X account)", OWNER_ID],
  ["a stale username after a change", "alice2"],
  ["a different case", "ALICE"],
] as const;

describe("a middleware-admitted owner passes every server owner gate", () => {
  it.each(ADMITTED_HANDLES)(
    "isOwnerPrincipal admits the owner id carrying %s",
    (_label, handle) => {
      expect(isOwnerPrincipal({ id: OWNER_ID, handle })).toBe(true);
    },
  );

  it.each(ADMITTED_HANDLES)(
    "requireOwnerPrincipal returns the owner carrying %s",
    async (_label, handle) => {
      const principal = { id: OWNER_ID, handle };
      mockedPrincipal.mockResolvedValue(principal);
      await expect(requireOwnerPrincipal()).resolves.toEqual(principal);
      await expect(
        requireOwnerOrServicePrincipal(new Request("http://localhost/api/wiki/x")),
      ).resolves.toEqual(principal);
    },
  );

  it.each(ADMITTED_HANDLES)(
    "the owner ⇒ admin grant survives %s",
    (_label, handle) => {
      // `isAdmin` is the owner's page-authz grant (read/write/delete any page).
      // Hinging it on the handle meant a drifted-handle owner silently lost
      // admin over their own deployment's pages.
      expect(isAdmin({ id: OWNER_ID, handle })).toBe(true);
    },
  );

  it.each(ADMITTED_HANDLES)(
    "the DEPLOYMENT GATE and the route gates agree, executed, for %s",
    async (_label, handle) => {
      // THE PROPERTY THIS FILE IS NAMED FOR, with both halves actually run
      // rather than one of them assumed. `handlePrivateRequest` is driven
      // through the same shim `middleware-write-gate.test.ts` uses (Clerk
      // stubbed above, `auth()` supplied per call), and the SAME principal is
      // then put to the route-side predicates in this one test — so the two
      // answers are compared, not merely each asserted somewhere.
      const principal = { id: OWNER_ID, handle };

      const redirectToSignIn = vi.fn();
      const auth = Object.assign(async () => ({ userId: OWNER_ID, redirectToSignIn }), {
        redirectToSignIn,
      });
      const admitted = await (
        middleware as unknown as (
          a: typeof auth,
          r: NextRequest,
        ) => Promise<Response | undefined>
      )(auth, new NextRequest("https://workwiki.app/api/settings"));

      // Admitted: middleware passes the request through untouched.
      expect(admitted?.status).toBe(200);
      expect(admitted?.headers.get("x-middleware-next")).toBe("1");

      // …and NOTHING behind it refuses that same principal.
      expect(isOwnerPrincipal(principal)).toBe(true);
      mockedPrincipal.mockResolvedValue(principal);
      await expect(requireOwnerPrincipal()).resolves.toEqual(principal);
    },
  );

  it.each([
    ["an MCP agent token", `agent:bot1`],
    ["an agent run acting for its human", `agent-owner:${OWNER_HANDLE}`],
    ["the MCP system caller", "service:mcp"],
    ["the bearer service credential", `service:${OWNER_HANDLE}`],
  ])(
    "keeps the owner grant for %s, whose id is SYNTHESIZED",
    (_label, id) => {
      // Not just `service:`. `src/app/api/mcp/route.ts` mints `agent:<id>` and
      // `src/lib/agent-runtime.ts` mints `agent-owner:<handle>`, both carrying
      // the OWNER's handle and both flowing into `isAdmin` → `canWritePage`.
      // A carve-out that only knew about `service:` would push them onto the
      // stable-id path, where they can never match, and the owner's agents would
      // start failing the realm gate on their own commons pages.
      const principal = { id, handle: OWNER_HANDLE };
      expect(isOwnerPrincipal(principal)).toBe(true);
      expect(isAdmin(principal)).toBe(true);
      // The realm gate is where the loss would have shown up first: a public,
      // non-agent-scoped, non-artifact page is writable by admins only.
      expect(canWritePage({ visibility: "public" }, principal, "body")).toBe(true);
    },
  );

  it.each([
    ["an MCP agent token", "agent:bot1"],
    ["an agent run acting for its human", "agent-owner:mallory"],
  ])("refuses %s carrying a NON-owner handle", (_label, id) => {
    // The carve-out widens WHICH fact decides, never who passes: a synthesized
    // principal still has to carry the owner's handle.
    const principal = { id, handle: "mallory" };
    expect(isOwnerPrincipal(principal)).toBe(false);
    expect(isAdmin(principal)).toBe(false);
    expect(canWritePage({ visibility: "public" }, principal, "body")).toBe(false);
  });

  it("still refuses a NON-owner holding the configured handle", async () => {
    // The gates did not merely get more permissive: with an id configured,
    // holding `NEXT_PUBLIC_OWNER_HANDLE` is no longer enough anywhere.
    const impostor = { id: "user_someoneElse", handle: OWNER_HANDLE };
    expect(isOwnerPrincipal(impostor)).toBe(false);
    expect(isAdmin(impostor)).toBe(false);
    mockedPrincipal.mockResolvedValue(impostor);
    await expect(requireOwnerPrincipal()).resolves.toBeNull();
  });

  it("keeps the bearer SERVICE principal on the handle path", async () => {
    // `service:<handle>` is synthesized, so it can never equal the owner's
    // Clerk id. Deciding it on the id would revoke the sidecar's and the
    // automation token's access to every route this gate protects.
    const service = { id: `service:${OWNER_HANDLE}`, handle: OWNER_HANDLE };
    mockedPrincipal.mockResolvedValue(null);
    mockedService.mockReturnValue(service);
    await expect(
      requireOwnerOrServicePrincipal(new Request("http://localhost/api/wiki/x")),
    ).resolves.toEqual(service);

    // …and a service principal pointed at somebody who is NOT the owner is
    // still refused, exactly as before.
    mockedService.mockReturnValue({ id: "service:bob", handle: "bob" });
    await expect(
      requireOwnerOrServicePrincipal(new Request("http://localhost/api/wiki/x")),
    ).resolves.toBeNull();
  });

  it("keeps the bearer token on a deployment configured by ID ALONE", async () => {
    // The regression this pins: with `YOPEDIA_OWNER_USER_ID` set and
    // `NEXT_PUBLIC_OWNER_HANDLE` unset, "an owner is configured" is true while
    // the only fact a service principal carries is not. Gating the service
    // branch on `isOwnerConfigured()` refused the sidecar and every automation
    // on every route this gate protects.
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    const service = { id: `service:${OWNER_HANDLE}`, handle: OWNER_HANDLE };
    mockedPrincipal.mockResolvedValue(null);
    mockedService.mockReturnValue(service);
    await expect(
      requireOwnerOrServicePrincipal(new Request("http://localhost/api/wiki/x")),
    ).resolves.toEqual(service);

    // The SESSION branch is still gated by the id on that same deployment — the
    // service branch's laxity is about the fact it carries, not a general
    // opening.
    mockedPrincipal.mockResolvedValue({ id: "user_someoneElse", handle: "whoever" });
    await expect(requireOwnerPrincipal()).resolves.toBeNull();
    mockedPrincipal.mockResolvedValue({ id: OWNER_ID, handle: "whoever" });
    await expect(requireOwnerPrincipal()).resolves.toEqual({
      id: OWNER_ID,
      handle: "whoever",
    });
  });

  it("still passes any signed-in principal when NOTHING is configured", async () => {
    // The unconfigured-deployment escape `requireOwnerPrincipal` has always had
    // (the suites rely on it) survives — but "unconfigured" now means NEITHER
    // var, so naming the owner by id alone gates instead of opening up.
    delete process.env.YOPEDIA_OWNER_USER_ID;
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    const anyone = { id: "user_anyone", handle: "anyone" };
    mockedPrincipal.mockResolvedValue(anyone);
    await expect(requireOwnerPrincipal()).resolves.toEqual(anyone);

    process.env.YOPEDIA_OWNER_USER_ID = OWNER_ID;
    await expect(requireOwnerPrincipal()).resolves.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (b) The source scan
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(__dirname, "../../..");
const SRC_ROOT = path.join(REPO_ROOT, "src");

/** Only the owner helper may fall back to a handle; clients receive server flags. */
const HANDLE_GATE_ALLOWED = [
  "src/lib/owner.ts",
];

/** Same naive strip as `owner-single-reader.test.ts` — see its rationale. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "__tests__" || entry.name === "node_modules") continue;
      found.push(...(await sourceFiles(full)));
      continue;
    }
    if (!/\.tsx?$/.test(entry.name)) continue;
    if (/\.test\.tsx?$/.test(entry.name)) continue;
    found.push(full);
  }
  return found;
}

describe("no server surface decides owner-ness on the handle", () => {
  it("calls isOwnerHandle( only from owner.ts", async () => {
    const files = await sourceFiles(SRC_ROOT);
    // Non-vacuity: a walk that found nothing would pass trivially.
    expect(files.length).toBeGreaterThan(100);

    const callers: string[] = [];
    for (const file of files) {
      const code = stripComments(await fs.readFile(file, "utf8"));
      if (/\bisOwnerHandle\(/.test(code)) {
        callers.push(path.relative(REPO_ROOT, file).split(path.sep).join("/"));
      }
    }

    expect(
      callers.sort(),
      `Owner checks must use isOwnerPrincipal on the server and a required ` +
        `isSiteOwner flag on clients; only owner.ts may compare the public handle.`,
    ).toEqual(HANDLE_GATE_ALLOWED);
  });

  it("keeps client islands on server flags and off the owner id", async () => {
    // The other direction of the same rule: importing `getOwnerUserId` into a
    // client island would read `undefined` in the browser and quietly gate the
    // owner OUT of their own nav, so the islands must not reach for it.
    for (const file of ["src/components/ArticleActions.tsx", "src/components/NavHeader.tsx", "src/components/RevisionHistory.tsx"]) {
      const code = stripComments(await fs.readFile(path.join(REPO_ROOT, file), "utf8"));
      expect(code, `${file} receives server authority`).toContain("isSiteOwner: boolean");
      expect(code).not.toMatch(/\bisOwnerHandle\(/);
      expect(code, `${file} must not read the server-only owner id`).not.toMatch(
        /\bgetOwnerUserId\b|\bYOPEDIA_OWNER_USER_ID\b/,
      );
    }
  });
});
