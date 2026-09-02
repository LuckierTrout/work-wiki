/**
 * Story 1.2 — the Wiki API's house shape.
 *
 * Handlers are imported directly and their storage-touching collaborators are
 * mocked (the `workspace-profile-routes.test.ts` recipe), so what is pinned
 * here is the contract: 401 before anything, 403 in read-only, 400 on input the
 * real parsers reject (they are NOT mocked), 201/200 on success, 404 for an
 * unknown id — and that a rejected request never reaches the write.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/config", () => ({ isReadOnly: vi.fn() }));
// `@/lib/owner` MUST be mocked here: the real `isOwnerPrincipal` resolves the
// owner from `YOPEDIA_OWNER_USER_ID` / `NEXT_PUBLIC_OWNER_HANDLE`, both unset
// under vitest, so it would answer false for `alice` and 403 every POST case
// below. `beforeEach` defaults it to true so each existing status keeps meaning
// what it meant. SPREAD, not replaced: `owner.ts` also exports `getOwnerHandle`,
// `getOwnerUserId` and `isOwnerConfigured`, and real modules in this graph call
// them — `owner-route.ts` spends two of them on every `requireOwnerPrincipal`,
// and `wikis.ts` calls `getOwnerHandle()` from `readActiveWikiSchema`. Replacing
// the module would leave those `undefined`, so adding any route that reaches
// them to this suite would fail with "not a function" rather than a real result.
// Only the predicate under test is stubbed.
vi.mock("@/lib/owner", async (original) => ({
  ...(await original<typeof import("@/lib/owner")>()),
  isOwnerPrincipal: vi.fn(),
}));
vi.mock("@/lib/wikis", async (original) => ({
  ...(await original<typeof import("@/lib/wikis")>()),
  getWikiRegistry: vi.fn(),
  createWiki: vi.fn(),
  applyScenarioTemplate: vi.fn(),
  setCurrentWiki: vi.fn(),
  renameWiki: vi.fn(),
  deleteWiki: vi.fn(),
}));

import { GET, POST } from "@/app/api/wikis/route";
import { PUT } from "@/app/api/wikis/current/route";
import { POST as APPLY_TEMPLATE } from "@/app/api/wikis/[id]/template/route";
import { DELETE as DELETE_WIKI, PATCH as RENAME_WIKI } from "@/app/api/wikis/[id]/route";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ClientInputError } from "@/lib/errors";
import { isOwnerPrincipal } from "@/lib/owner";
import { READ_ONLY_REFUSAL, ReadOnlyError } from "@/lib/read-only";
import {
  applyScenarioTemplate,
  createWiki,
  deleteWiki,
  getWikiRegistry,
  renameWiki,
  setCurrentWiki,
  type WikiRecord,
} from "@/lib/wikis";

const WIKI: WikiRecord = {
  id: "11111111-2222-4333-8444-555555555555",
  name: "Q3 planning",
  scenario: "business",
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z",
};

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedIsOwner = vi.mocked(isOwnerPrincipal);
const mockedRegistry = vi.mocked(getWikiRegistry);
const mockedCreate = vi.mocked(createWiki);
const mockedApply = vi.mocked(applyScenarioTemplate);
const mockedSetCurrent = vi.mocked(setCurrentWiki);
const mockedRename = vi.mocked(renameWiki);
const mockedDelete = vi.mocked(deleteWiki);

function jsonRequest(url: string, method: string, body: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const createRequest = (body: unknown) =>
  jsonRequest("http://localhost/api/wikis", "POST", body);
const currentRequest = (body: unknown) =>
  jsonRequest("http://localhost/api/wikis/current", "PUT", body);
const templateRequest = (body: unknown) =>
  jsonRequest(`http://localhost/api/wikis/${WIKI.id}/template`, "POST", body);
const templateContext = (id = WIKI.id) => ({ params: Promise.resolve({ id }) });
// The id is a PARAMETER of both, so a 404 case can point the URL and the route
// context at the SAME unknown id. Hard-coding `WIKI.id` in the URL while
// passing another id through `params` would let a handler that parsed the id
// out of the pathname pass every assertion here.
const renameRequest = (body: unknown, id = WIKI.id) =>
  jsonRequest(`http://localhost/api/wikis/${id}`, "PATCH", body);
const deleteRequest = (id = WIKI.id) =>
  new Request(`http://localhost/api/wikis/${id}`, { method: "DELETE" });
const idContext = (id = WIKI.id) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedReadOnly.mockReturnValue(false);
  mockedIsOwner.mockReturnValue(true);
  mockedRegistry.mockResolvedValue({ version: 1, wikis: [WIKI], currentId: WIKI.id });
  mockedCreate.mockResolvedValue(WIKI);
  mockedApply.mockResolvedValue({ ...WIKI, scenario: "reading" });
  mockedSetCurrent.mockResolvedValue(WIKI);
  mockedRename.mockResolvedValue({ ...WIKI, name: "Q4 plan" });
  mockedDelete.mockResolvedValue(WIKI);
});

describe("wiki API auth", () => {
  it("requires sign-in on every route and writes nothing", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(401);
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(401);
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(401);
    expect(
      (await RENAME_WIKI(renameRequest({ name: "Q4 plan" }), idContext())).status,
    ).toBe(401);
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(401);
    expect(mockedRegistry).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
    // 401 PRECEDES the owner check on POST. `beforeEach` defaults the owner
    // mock to true, so a reordering that consulted the owner first would still
    // answer 401 here and go unnoticed without this.
    expect(mockedIsOwner).not.toHaveBeenCalled();
  });

  it("refuses writes on a read-only deployment", async () => {
    mockedReadOnly.mockReturnValue(true);
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(403);
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(403);
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(403);
    expect(
      (await RENAME_WIKI(renameRequest({ name: "Q4 plan" }), idContext())).status,
    ).toBe(403);
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("refuses Wiki CREATION by a non-owner and writes nothing", async () => {
    // DW-159: the creation door is the one `/api/wikis` route gated on being
    // the OWNER, not merely signed in — a non-owner's Wiki is inert, so the
    // answer is a refusal. Every OTHER route here addresses the caller's OWN
    // already-existing registry and stays ungated, so all five are asserted
    // below, not a sample: gating any one of them is a silent regression the
    // POST 403 cannot catch. DELETE matters most — `deleteWiki`'s inline
    // orphan sweep is a pre-gate non-owner tenant's ONLY reclamation path, and
    // the `sweepOrphanWikiDirs` scope note in `maintenance.ts` rests on it.
    mockedIsOwner.mockReturnValue(false);
    const response = await POST(createRequest({ name: "x", scenario: "business" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/owner/i);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedIsOwner).toHaveBeenCalledWith({ id: "user-1", handle: "alice" });
    expect((await GET()).status).toBe(200);
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(200);
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(200);
    expect(
      (await RENAME_WIKI(renameRequest({ name: "Q4 plan" }), idContext())).status,
    ).toBe(200);
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(200);
    expect(mockedDelete).toHaveBeenCalledWith("alice", WIKI.id);
  });

  it("answers the OWNER refusal first — before read-only and before the body", async () => {
    // Ordering is 401 → owner → read-only → parse, mirroring the artifact
    // route, so a non-owner meets ONE answer from both write doors whatever
    // else is wrong with the request. Asserted on the copy, not just the 403,
    // because read-only refuses with the same status.
    mockedIsOwner.mockReturnValue(false);
    mockedReadOnly.mockReturnValue(true);
    const readOnly = await POST(createRequest({ name: "x", scenario: "business" }));
    expect(readOnly.status).toBe(403);
    expect((await readOnly.json()).error).toMatch(/owner/i);

    const unparseable = await POST(
      new Request("http://localhost/api/wikis", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
    );
    expect(unparseable.status).toBe(403);
    expect((await unparseable.json()).error).toMatch(/owner/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("keeps the read-only refusal for the owner", async () => {
    mockedReadOnly.mockReturnValue(true);
    const response = await POST(createRequest({ name: "x", scenario: "business" }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toMatch(/read-only/i);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe("malformed bodies", () => {
  it("400s on invalid JSON on every write route without touching storage", async () => {
    const bad = (url: string, method: string) =>
      new Request(url, {
        method,
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      });

    expect((await POST(bad("http://localhost/api/wikis", "POST"))).status).toBe(400);
    expect((await PUT(bad("http://localhost/api/wikis/current", "PUT"))).status).toBe(400);
    expect(
      (
        await APPLY_TEMPLATE(
          bad(`http://localhost/api/wikis/${WIKI.id}/template`, "POST"),
          templateContext(),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await RENAME_WIKI(
          bad(`http://localhost/api/wikis/${WIKI.id}`, "PATCH"),
          idContext(),
        )
      ).status,
    ).toBe(400);

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it("400s on valid JSON that is not an object, without touching storage", async () => {
    // `["general"]` and `"general"` parse fine and then read `.scenario` /
    // `.id` off a non-record — the branch that separates a 400 from a 500.
    for (const body of [null, "general", ["general"], 7]) {
      expect((await POST(createRequest(body))).status).toBe(400);
      expect((await PUT(currentRequest(body))).status).toBe(400);
      expect(
        (await APPLY_TEMPLATE(templateRequest(body), templateContext())).status,
      ).toBe(400);
      expect((await RENAME_WIKI(renameRequest(body), idContext())).status).toBe(400);
    }

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
    expect(mockedRename).not.toHaveBeenCalled();
  });
});

describe("GET /api/wikis", () => {
  it("returns the registry for the principal's tenant", async () => {
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wikis: [WIKI], currentId: WIKI.id });
    expect(mockedRegistry).toHaveBeenCalledWith("alice");
  });
});

describe("POST /api/wikis", () => {
  it("creates a wiki", async () => {
    const response = await POST(createRequest({ name: "Q3 planning", scenario: "business" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ wiki: WIKI });
    expect(mockedCreate).toHaveBeenCalledWith("alice", {
      name: "Q3 planning",
      scenario: "business",
    });
  });

  it("400s on the blank/custom scenario, an unknown one, and an empty name", async () => {
    for (const body of [
      { name: "x", scenario: "custom" },
      { name: "x", scenario: "blank" },
      { name: "x" },
      { name: "   ", scenario: "general" },
      { name: "x".repeat(81), scenario: "general" },
    ]) {
      const response = await POST(createRequest(body));
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe("POST /api/wikis/<id>/template", () => {
  it("applies a different template", async () => {
    const response = await APPLY_TEMPLATE(
      templateRequest({ scenario: "reading" }),
      templateContext(),
    );
    expect(response.status).toBe(200);
    expect((await response.json()).wiki.scenario).toBe("reading");
    expect(mockedApply).toHaveBeenCalledWith("alice", WIKI.id, "reading");
  });

  it("404s on an unknown wiki", async () => {
    mockedApply.mockResolvedValue(null);
    const response = await APPLY_TEMPLATE(
      templateRequest({ scenario: "reading" }),
      templateContext("00000000-0000-4000-8000-000000000000"),
    );
    expect(response.status).toBe(404);
  });

  it("400s on the custom scenario", async () => {
    const response = await APPLY_TEMPLATE(
      templateRequest({ scenario: "custom" }),
      templateContext(),
    );
    expect(response.status).toBe(400);
    expect(mockedApply).not.toHaveBeenCalled();
  });
});

describe("PATCH /api/wikis/<id>", () => {
  it("renames the wiki and answers with the updated record", async () => {
    const response = await RENAME_WIKI(renameRequest({ name: "  Q4   plan " }), idContext());
    expect(response.status).toBe(200);
    expect((await response.json()).wiki.name).toBe("Q4 plan");
    // The route's parser normalises before the lib call, so the lib never sees
    // the raw string — the 80-char cap and the collapse are one rule.
    expect(mockedRename).toHaveBeenCalledWith("alice", WIKI.id, "Q4 plan");
  });

  it("404s on an unknown wiki", async () => {
    mockedRename.mockResolvedValue(null);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const response = await RENAME_WIKI(
      renameRequest({ name: "Q4 plan" }, unknown),
      idContext(unknown),
    );
    expect(response.status).toBe(404);
    expect(mockedRename).toHaveBeenCalledWith("alice", unknown, "Q4 plan");
  });

  it("400s on a blank, non-string or oversized name without reaching the lib", async () => {
    for (const body of [{ name: "   " }, { name: 7 }, {}, { name: "x".repeat(81) }]) {
      const response = await RENAME_WIKI(renameRequest(body), idContext());
      expect(response.status).toBe(400);
      expect((await response.json()).error).toBeTruthy();
    }
    expect(mockedRename).not.toHaveBeenCalled();
  });

  it("surfaces a lib-side ClientInputError as a 400 and anything else as a 500", async () => {
    mockedRename.mockRejectedValueOnce(new ClientInputError("Wiki name is required."));
    expect((await RENAME_WIKI(renameRequest({ name: "x" }), idContext())).status).toBe(400);
    mockedRename.mockRejectedValueOnce(new Error("disk on fire"));
    expect((await RENAME_WIKI(renameRequest({ name: "x" }), idContext())).status).toBe(500);
  });
});

describe("DELETE /api/wikis/<id>", () => {
  it("deletes the wiki and answers with the removed record", async () => {
    const response = await DELETE_WIKI(deleteRequest(), idContext());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ wiki: WIKI });
    expect(mockedDelete).toHaveBeenCalledWith("alice", WIKI.id);
  });

  it("404s on an unknown wiki", async () => {
    mockedDelete.mockResolvedValue(null);
    const unknown = "00000000-0000-4000-8000-000000000000";
    const response = await DELETE_WIKI(deleteRequest(unknown), idContext(unknown));
    expect(response.status).toBe(404);
    expect(mockedDelete).toHaveBeenCalledWith("alice", unknown);
  });

  it("400s when the lib refuses to delete the active wiki", async () => {
    // The one rejection an owner can act on: switch first, then delete. A 500
    // would read as a server fault and offer nothing to do about it.
    mockedDelete.mockRejectedValueOnce(
      new ClientInputError("Switch to a different wiki before deleting this one."),
    );
    const response = await DELETE_WIKI(deleteRequest(), idContext());
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("Switch to a different wiki");
  });

  it("500s on an unexpected failure", async () => {
    mockedDelete.mockRejectedValueOnce(new Error("disk on fire"));
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(500);
  });
});

describe("PUT /api/wikis/current", () => {
  it("sets the active wiki", async () => {
    const response = await PUT(currentRequest({ id: WIKI.id }));
    expect(response.status).toBe(200);
    expect(mockedSetCurrent).toHaveBeenCalledWith("alice", WIKI.id);
  });

  it("404s on an unknown id and 400s without one", async () => {
    mockedSetCurrent.mockResolvedValue(null);
    expect((await PUT(currentRequest({ id: "nope" }))).status).toBe(404);
    expect((await PUT(currentRequest({}))).status).toBe(400);
  });
});

/**
 * THE MID-REQUEST FLAG FLIP (DW-316).
 *
 * `isReadOnly()` is FALSE at every gate here — the deployment was writable when
 * the request arrived — and the kernel writer refuses anyway, because the flag
 * moved while the handler was in flight. Each of these catches used to call that
 * `ReadOnlyError` a server fault and answer 500, which tells the owner their
 * refused write broke something. It is a refusal: 403, carrying the KERNEL's own
 * sentence rather than the route's inline literal, the
 * `PUT /api/workbench/artifact` shape.
 *
 * The gates themselves are untouched — the "refuses writes on a read-only
 * deployment" case above still pins them, and the writers are never reached
 * there.
 */
describe("a flag that flips mid-request on the wiki-lifecycle writes", () => {
  it("403s POST /api/wikis with the kernel's create sentence", async () => {
    mockedCreate.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.wikiCreate),
    );
    const response = await POST(createRequest({ name: "x", scenario: "business" }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiCreate });
    // The gate did not answer this — the writer did.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("403s PATCH /api/wikis/<id> with the kernel's rename sentence", async () => {
    mockedRename.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.wikiRename),
    );
    const response = await RENAME_WIKI(renameRequest({ name: "Q4 plan" }), idContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiRename });
  });

  it("403s DELETE /api/wikis/<id> with the kernel's delete sentence", async () => {
    mockedDelete.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.wikiDelete),
    );
    const response = await DELETE_WIKI(deleteRequest(), idContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiDelete });
  });

  it("403s POST /api/wikis/<id>/template with the kernel's template sentence", async () => {
    mockedApply.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.wikiTemplate),
    );
    const response = await APPLY_TEMPLATE(
      templateRequest({ scenario: "reading" }),
      templateContext(),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiTemplate });
  });

  it("403s PUT /api/wikis/current with the kernel's switch sentence", async () => {
    // `setCurrentWiki` writes ONE registry file — plus the `dataVersion`
    // counter it bumps at its tail (DW-518) — which is exactly why it needs the
    // same answer: which Wiki is current decides which `schema.md` every prompt
    // runs on.
    mockedSetCurrent.mockRejectedValueOnce(
      new ReadOnlyError(READ_ONLY_REFUSAL.wikiSwitch),
    );
    const response = await PUT(currentRequest({ id: WIKI.id }));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiSwitch });
  });

  it("leaves the OTHER classifications alone — 400 for input, 500 for a fault", async () => {
    // The 403 branch is first in each catch, so it must not have swallowed the
    // mapping underneath it.
    mockedCreate.mockRejectedValueOnce(new ClientInputError("Wiki name is required."));
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(400);
    mockedCreate.mockRejectedValueOnce(new Error("disk on fire"));
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(500);
    mockedSetCurrent.mockRejectedValueOnce(new Error("disk on fire"));
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(500);
    mockedApply.mockRejectedValueOnce(new Error("disk on fire"));
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(500);
    // Both handlers in `wikis/[id]/route.ts` too — each gained its OWN branch,
    // so each needs its own post-403 mapping pinned. `renameWiki` and
    // `deleteWiki` already have 400/500 rows of their own above; these are here
    // because the branch that could swallow them is new.
    mockedRename.mockRejectedValueOnce(new Error("disk on fire"));
    expect(
      (await RENAME_WIKI(renameRequest({ name: "x" }), idContext())).status,
    ).toBe(500);
    mockedDelete.mockRejectedValueOnce(new Error("disk on fire"));
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(500);
  });

  it("400s a FOREIGN-REALM ClientInputError past the 403 branch, on every write", async () => {
    // DW-578, at the HTTP surface. Every OTHER client-input row in this file
    // throws through the same `errors.ts` instance the route imported, so all of
    // them pass whether the route classifies by identity or by name. This one
    // does not: the error carries the right `name` and the wrong constructor —
    // exactly what a duplicated module graph produces — and an `instanceof`
    // check answers false for it, dropping the caller's 400 to a 500 in
    // production only.
    //
    // These five doors are also the awkward shape: `isReadOnlyError` runs FIRST
    // in each catch. That branch matches on `name` too, so a client-input error
    // must fall PAST it rather than be swallowed as a 403 — which is why the
    // status asserted here is 400 and not merely "not 500".
    const foreign = () =>
      Object.assign(new Error("Wiki name is required."), { name: "ClientInputError" });
    expect(foreign()).not.toBeInstanceOf(ClientInputError);

    mockedCreate.mockRejectedValueOnce(foreign());
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(400);
    mockedRename.mockRejectedValueOnce(foreign());
    expect((await RENAME_WIKI(renameRequest({ name: "x" }), idContext())).status).toBe(400);
    mockedDelete.mockRejectedValueOnce(foreign());
    expect((await DELETE_WIKI(deleteRequest(), idContext())).status).toBe(400);
    mockedApply.mockRejectedValueOnce(foreign());
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(400);
    mockedSetCurrent.mockRejectedValueOnce(foreign());
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(400);
  });

  it("keeps the 403 for a foreign-realm ReadOnlyError — the branches stay distinct", async () => {
    // The mirror of the row above: the two structural classifiers sit in the
    // same catch and match on the same property, so a foreign-realm refusal must
    // still reach 403 rather than be re-read as the caller's input.
    mockedRename.mockRejectedValueOnce(
      Object.assign(new Error(READ_ONLY_REFUSAL.wikiRename), { name: "ReadOnlyError" }),
    );
    const response = await RENAME_WIKI(renameRequest({ name: "x" }), idContext());
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.wikiRename });
  });
});
