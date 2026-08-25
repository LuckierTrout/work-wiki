/**
 * `POST /api/research` — how a create failure is classified.
 *
 * DW-164 gave `createResearchProject` a `MAX_PROJECTS` refusal, which is the
 * caller's state and not a server fault. The handler is imported directly and
 * its store is mocked (the `wikis-routes.test.ts` recipe), so what is pinned
 * here is the mapping alone: a `ClientInputError` is a 400 by TYPE, anything
 * else stays a 500, and the message regex that predates the class still stands.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/research-projects", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/research-projects")>();
  return {
    ...actual,
    createResearchProject: vi.fn(),
    listResearchProjects: vi.fn(async () => []),
  };
});
vi.mock("@/lib/wikis", () => ({ listWikis: vi.fn(async () => []) }));
vi.mock("@/lib/research-runtime", () => ({
  reconcileResearchProjects: vi.fn(async (_owner, projects) => projects),
}));

import { GET, POST } from "@/app/api/research/route";
import { getPrincipal } from "@/lib/auth";
import { ClientInputError } from "@/lib/errors";
import { createResearchProject, listResearchProjects } from "@/lib/research-projects";
import { reconcileResearchProjects } from "@/lib/research-runtime";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { listWikis } from "@/lib/wikis";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedCreate = vi.mocked(createResearchProject);
const mockedList = vi.mocked(listResearchProjects);
const mockedReconcile = vi.mocked(reconcileResearchProjects);
const mockedWikis = vi.mocked(listWikis);

const request = (body: unknown) =>
  new Request("http://localhost/api/research", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const BODY = {
  title: "Launch research",
  question: "What supports the date?",
  queries: ["launch date evidence"],
};

describe("POST /api/research failure classification", () => {
  let savedReadOnly: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedReadOnly = process.env.YOPEDIA_READONLY;
    // Cleared rather than inherited: a value exported in a developer's shell
    // would otherwise turn every case below into a 403.
    delete process.env.YOPEDIA_READONLY;
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
      ReturnType<typeof getPrincipal>
    >);
  });

  afterEach(() => {
    if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = savedReadOnly;
  });

  it("403s on a read-only deployment without reaching the store", async () => {
    // DW-294. `createResearchProject` writes the project record straight to
    // storage and reaches no kernel writer, so nothing behind this handler
    // would have refused — the form simply reported a create that happened.
    process.env.YOPEDIA_READONLY = "1";

    const response = await POST(request(BODY));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: READ_ONLY_REFUSAL.researchCreate,
    });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("still 401s an unauthenticated caller on a read-only deployment", async () => {
    // The gate sits AFTER the 401, so a signed-out caller learns it is signed
    // out rather than being told about a deployment state it cannot see.
    process.env.YOPEDIA_READONLY = "1";
    mockedPrincipal.mockResolvedValue(null);

    expect((await POST(request(BODY))).status).toBe(401);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("refuses BEFORE the body is parsed", async () => {
    // A malformed body would otherwise 500 through the catch, hiding the
    // refusal behind a server fault the deployment did not have.
    process.env.YOPEDIA_READONLY = "1";
    const malformed = new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });

    const response = await POST(malformed);

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: READ_ONLY_REFUSAL.researchCreate,
    });
  });

  it("400s the MAX_PROJECTS refusal", async () => {
    // The refusal message carries no "required"/"invalid", so the pre-existing
    // regex alone would have called this a server fault.
    mockedCreate.mockRejectedValue(
      new ClientInputError("This workspace already has the maximum of 100 research projects."),
    );

    const response = await POST(request(BODY));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "This workspace already has the maximum of 100 research projects.",
    });
  });

  it("still 500s a storage failure", async () => {
    // The discriminator for the row above: classification is by type, not by
    // "any error from the store is the caller's fault".
    mockedCreate.mockRejectedValue(new Error("disk full"));

    expect((await POST(request(BODY))).status).toBe(500);
  });

  it("keeps 400ing the validation throws that predate ClientInputError", async () => {
    mockedCreate.mockRejectedValue(new Error("Research title is required"));

    expect((await POST(request(BODY))).status).toBe(400);
  });

  it("201s a create that lands", async () => {
    mockedCreate.mockResolvedValue({ id: "p1" } as Awaited<
      ReturnType<typeof createResearchProject>
    >);

    const response = await POST(request(BODY));

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ project: { id: "p1" } });
  });

  it.each([
    ["malformed JSON", "{ not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
  ])("400s %s instead of reporting a server failure", async (_label, body) => {
    const response = await POST(new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }));

    expect(response.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["blank title", { ...BODY, title: "  " }],
    ["blank question", { ...BODY, question: "  " }],
    ["no queries", { ...BODY, queries: [] }],
    ["non-string query", { ...BODY, queries: [42] }],
    ["non-string Wiki id", { ...BODY, vaultId: 42 }],
  ])("400s %s", async (_label, body) => {
    const response = await POST(request(body));

    expect(response.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("reconciles interrupted runs on the panel's read", async () => {
    // SM-3: the poll is where a queued project whose wake-up was lost gets
    // re-dispatched and an abandoned `collecting` one gets failed visibly.
    await GET(new Request("http://localhost/api/research"));

    expect(mockedReconcile).toHaveBeenCalledWith("alice", []);
  });

  it("does not reconcile on a read-only deployment", async () => {
    // Reconciling writes. Every other door refuses a write here, so a GET that
    // quietly performed one would be the single exception.
    process.env.YOPEDIA_READONLY = "1";

    const response = await GET(new Request("http://localhost/api/research"));

    expect(response.status).toBe(200);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("filters the list to one Workbench Wiki", async () => {
    mockedList.mockResolvedValue([
      { id: "a", vaultId: "wiki-a" },
      { id: "b", vaultId: "wiki-b" },
    ] as Awaited<ReturnType<typeof listResearchProjects>>);
    mockedReconcile.mockImplementation(async (_owner, projects) => [...projects]);

    const response = await GET(new Request("http://localhost/api/research?wikiId=wiki-a"));
    const body = await response.json() as { projects: Array<{ id: string }> };

    expect(body.projects.map((project) => project.id)).toEqual(["a"]);
  });

  it("400s a create aimed at a Wiki this workspace does not have", async () => {
    mockedWikis.mockResolvedValue([]);

    const response = await POST(request({ ...BODY, vaultId: "missing-wiki" }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "That Wiki is not in this workspace." });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("records a known Wiki on the create", async () => {
    mockedWikis.mockResolvedValue([{ id: "wiki-a" }] as Awaited<ReturnType<typeof listWikis>>);
    mockedCreate.mockResolvedValue({ id: "p1" } as Awaited<
      ReturnType<typeof createResearchProject>
    >);

    const response = await POST(request({ ...BODY, vaultId: "wiki-a" }));

    expect(response.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ vaultId: "wiki-a" }),
    );
  });
});
