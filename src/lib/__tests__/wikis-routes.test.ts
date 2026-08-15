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
vi.mock("@/lib/wikis", async (original) => ({
  ...(await original<typeof import("@/lib/wikis")>()),
  getWikiRegistry: vi.fn(),
  createWiki: vi.fn(),
  applyScenarioTemplate: vi.fn(),
  setCurrentWiki: vi.fn(),
}));

import { GET, POST } from "@/app/api/wikis/route";
import { PUT } from "@/app/api/wikis/current/route";
import { POST as APPLY_TEMPLATE } from "@/app/api/wikis/[id]/template/route";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import {
  applyScenarioTemplate,
  createWiki,
  getWikiRegistry,
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
const mockedRegistry = vi.mocked(getWikiRegistry);
const mockedCreate = vi.mocked(createWiki);
const mockedApply = vi.mocked(applyScenarioTemplate);
const mockedSetCurrent = vi.mocked(setCurrentWiki);

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

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedReadOnly.mockReturnValue(false);
  mockedRegistry.mockResolvedValue({ version: 1, wikis: [WIKI], currentId: WIKI.id });
  mockedCreate.mockResolvedValue(WIKI);
  mockedApply.mockResolvedValue({ ...WIKI, scenario: "reading" });
  mockedSetCurrent.mockResolvedValue(WIKI);
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
    expect(mockedRegistry).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
  });

  it("refuses writes on a read-only deployment", async () => {
    mockedReadOnly.mockReturnValue(true);
    expect((await POST(createRequest({ name: "x", scenario: "business" }))).status).toBe(403);
    expect((await PUT(currentRequest({ id: WIKI.id }))).status).toBe(403);
    expect(
      (await APPLY_TEMPLATE(templateRequest({ scenario: "reading" }), templateContext()))
        .status,
    ).toBe(403);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
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

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
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
    }

    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedSetCurrent).not.toHaveBeenCalled();
    expect(mockedApply).not.toHaveBeenCalled();
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
