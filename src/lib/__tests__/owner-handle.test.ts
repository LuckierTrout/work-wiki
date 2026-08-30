/**
 * `owner.ts` — the resolver every owner gate is built on.
 *
 * Pinned here because the Wiki-creation gate (DW-159) and the Schema-edit gate
 * both spend the owner predicate and both MOCK it in their own route suites, so
 * nothing else in the repo asserts what the real functions answer. The
 * load-bearing case is an UNCONFIGURED deployment: it must mean "nobody is the
 * owner", never "everybody is" — an unconfigured deployment has to refuse
 * creation, not open it.
 *
 * Since DW-486 that is TWO env vars, and `isOwnerPrincipal` is the predicate
 * every server gate spends. Its whole point is that the stable Clerk id decides
 * whenever there is one — so the owner the middleware admitted on
 * `YOPEDIA_OWNER_USER_ID` can never be the caller a route gate turns away — with
 * the handle surviving only as the fallback for principals that carry no Clerk
 * id (bearer service principals, and deployments configured by handle alone).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getOwnerHandle, getOwnerUserId, isOwnerHandle, isOwnerPrincipal } from "../owner";
import { isServicePrincipalId, isSynthesizedPrincipalId } from "../principal-id";

const saved = process.env.NEXT_PUBLIC_OWNER_HANDLE;
const savedId = process.env.YOPEDIA_OWNER_USER_ID;

beforeEach(() => {
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  delete process.env.YOPEDIA_OWNER_USER_ID;
});

afterEach(() => {
  if (saved === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = saved;
  if (savedId === undefined) delete process.env.YOPEDIA_OWNER_USER_ID;
  else process.env.YOPEDIA_OWNER_USER_ID = savedId;
});

describe("getOwnerHandle", () => {
  it("answers null when unset, blank, or whitespace-only, and trims otherwise", () => {
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "";
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "   ";
    expect(getOwnerHandle()).toBeNull();
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "  alice  ";
    expect(getOwnerHandle()).toBe("alice");
  });
});

describe("isOwnerHandle", () => {
  it("is false for EVERY handle when the owner var is UNSET", () => {
    for (const handle of ["alice", "bob", "", "  ", null, undefined]) {
      expect(isOwnerHandle(handle)).toBe(false);
    }
  });

  it("is false for EVERY handle when the owner var is SET BUT BLANK", () => {
    // A deployment that set the var to whitespace has no owner either — a
    // separate state from unset, and a separate failure message when it breaks.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "   ";
    for (const handle of ["alice", "bob", "", "  ", null, undefined]) {
      expect(isOwnerHandle(handle)).toBe(false);
    }
  });

  it("matches the configured owner case-insensitively and nobody else", () => {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "Alice";
    expect(isOwnerHandle("alice")).toBe(true);
    expect(isOwnerHandle("ALICE")).toBe(true);
    expect(isOwnerHandle("Alice")).toBe(true);
    expect(isOwnerHandle("bob")).toBe(false);
    expect(isOwnerHandle("alice2")).toBe(false);
    expect(isOwnerHandle(null)).toBe(false);
    expect(isOwnerHandle(undefined)).toBe(false);
  });
});

describe("getOwnerUserId", () => {
  it("answers null when unset, blank, or whitespace-only, and trims otherwise", () => {
    // Byte-identical to the `process.env.YOPEDIA_OWNER_USER_ID?.trim()` the two
    // middleware branches used to do inline: an empty result is "not
    // configured", which is what makes the deployment gate fail closed with a
    // 503 rather than admit everyone.
    expect(getOwnerUserId()).toBeNull();
    process.env.YOPEDIA_OWNER_USER_ID = "";
    expect(getOwnerUserId()).toBeNull();
    process.env.YOPEDIA_OWNER_USER_ID = "   ";
    expect(getOwnerUserId()).toBeNull();
    process.env.YOPEDIA_OWNER_USER_ID = "  user_X  ";
    expect(getOwnerUserId()).toBe("user_X");
  });
});

describe("isOwnerPrincipal", () => {
  it("admits the owner whose HANDLE has drifted away from the configured one", () => {
    // The bug DW-486 exists for. `getPrincipal` falls back to the raw Clerk id
    // as the handle when a user has no username and no linked X account, and a
    // username change drifts it too — either way the middleware admits on the
    // id and the route gate used to 403 on the handle, with no in-app recovery
    // (`NEXT_PUBLIC_*` is inlined at build time).
    process.env.YOPEDIA_OWNER_USER_ID = "user_X";
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "alice";
    expect(isOwnerPrincipal({ id: "user_X", handle: "user_X" })).toBe(true);
    expect(isOwnerPrincipal({ id: "user_X", handle: "alice2" })).toBe(true);
    expect(isOwnerPrincipal({ id: "user_X", handle: null })).toBe(true);
    expect(isOwnerPrincipal({ id: "user_X", handle: "alice" })).toBe(true);
  });

  it("refuses an impostor holding the owner HANDLE when an owner id is configured", () => {
    // The other direction, and the reason the id path is a decision rather than
    // an extra grant: with an id configured, holding the handle is not enough.
    process.env.YOPEDIA_OWNER_USER_ID = "user_X";
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "alice";
    expect(isOwnerPrincipal({ id: "user_Y", handle: "alice" })).toBe(false);
    expect(isOwnerPrincipal({ id: "user_Y", handle: "ALICE" })).toBe(false);
  });

  it("falls back to the handle when NO owner id is configured", () => {
    // Every deployment and every existing suite that names the owner by handle
    // alone keeps exactly the answer it had before DW-486, case-insensitively.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "alice";
    expect(isOwnerPrincipal({ id: "user_Y", handle: "Alice" })).toBe(true);
    expect(isOwnerPrincipal({ id: "user_Y", handle: "bob" })).toBe(false);
    // Blank/whitespace is "not configured" for the id too, so this is the same
    // fallback rather than an id comparison against "".
    process.env.YOPEDIA_OWNER_USER_ID = "   ";
    expect(isOwnerPrincipal({ id: "user_Y", handle: "Alice" })).toBe(true);
  });

  it("keeps EVERY synthesized principal on the handle path", () => {
    // A synthesized id (`<kind>:<value>`) can never equal the owner's Clerk id,
    // so deciding these on the id would revoke the sidecar/automation token and
    // strip the owner's MCP agents and agent runs of the grant they act with.
    // Not just `service:` — `agent:` (src/app/api/mcp/route.ts) and
    // `agent-owner:` (src/lib/agent-runtime.ts) are minted in production too.
    process.env.YOPEDIA_OWNER_USER_ID = "user_X";
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "alice";
    for (const id of [
      "service:alice",
      "service:mcp",
      "agent:bot1",
      "agent-owner:alice",
      "knowledge-compiler:alice",
    ]) {
      expect(isOwnerPrincipal({ id, handle: "alice" })).toBe(true);
      expect(isOwnerPrincipal({ id, handle: "bob" })).toBe(false);
    }
  });

  it("is false for EVERYONE when NEITHER var is configured", () => {
    for (const principal of [
      { id: "user_X", handle: "alice" },
      { id: "service:alice", handle: "alice" },
      { id: "", handle: "" },
    ]) {
      expect(isOwnerPrincipal(principal)).toBe(false);
    }
    // Configured by id alone still refuses everyone else — it does not fall
    // through to the (absent) handle and open up.
    process.env.YOPEDIA_OWNER_USER_ID = "user_X";
    expect(isOwnerPrincipal({ id: "user_Y", handle: "alice" })).toBe(false);
    expect(isOwnerPrincipal({ id: "service:alice", handle: "alice" })).toBe(false);
    expect(isOwnerPrincipal({ id: "agent:bot1", handle: "alice" })).toBe(false);
    expect(isOwnerPrincipal({ id: "user_X", handle: "alice" })).toBe(true);
  });

  it("is false for a missing principal", () => {
    process.env.YOPEDIA_OWNER_USER_ID = "user_X";
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "alice";
    expect(isOwnerPrincipal(null)).toBe(false);
    expect(isOwnerPrincipal(undefined)).toBe(false);
    // A principal with no id at all falls back to the handle rather than
    // comparing `undefined` to the configured id.
    expect(isOwnerPrincipal({ handle: "alice" })).toBe(true);
    expect(isOwnerPrincipal({ handle: "bob" })).toBe(false);
  });
});

describe("isSynthesizedPrincipalId", () => {
  it("separates Clerk ids from every `<kind>:<value>` id this app mints", () => {
    // The rule is the colon, not a prefix list: a Clerk user id never contains
    // one, and every synthesized principal in the repo is `<kind>:<value>`. A
    // false positive here (a real Clerk id read as synthesized) is the only
    // harmful direction — it would put the owner back on the drifting handle —
    // and the shape makes it impossible.
    for (const id of [
      "service:alice",
      "service:mcp",
      "agent:alice--yoyo",
      "agent-owner:alice",
      "knowledge-compiler:t_alice",
      "eval:alice",
    ]) {
      expect(isSynthesizedPrincipalId(id)).toBe(true);
    }
    for (const id of ["user_2abcDEF", "user_3HQlxnUOlZqWjrqgjtIrkKE4nFK", "", null, undefined]) {
      expect(isSynthesizedPrincipalId(id)).toBe(false);
    }
  });

  it("is WIDER than isServicePrincipalId, which stays the write-bypass test", () => {
    // `canWritePage` lets a deployment-trusted SERVICE principal write anything.
    // An `agent:` principal deliberately does not get that — it sits on the
    // ordinary human side of the realm gate — so the two predicates must not
    // collapse into one.
    expect(isServicePrincipalId("service:alice")).toBe(true);
    expect(isServicePrincipalId("agent:bot1")).toBe(false);
    expect(isSynthesizedPrincipalId("agent:bot1")).toBe(true);
  });
});
