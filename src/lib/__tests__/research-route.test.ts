/**
 * `POST /api/research` — how a create failure is classified.
 *
 * DW-164 gave `createResearchProject` a `MAX_PROJECTS` refusal, which is the
 * caller's state and not a server fault. The handler is imported directly and
 * its store is mocked (the `wikis-routes.test.ts` recipe), so what is pinned
 * here is the mapping alone: a `ClientInputError` is a 400 by TYPE and
 * anything else stays a 500. There is no message matching left — the retired
 * /required|invalid/i regex is pinned OUT by the storage-fault row below.
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
import { ClientInputError, StoreFaultError } from "@/lib/errors";
import {
  createResearchProject,
  listResearchProjects,
  REPAIR_HINT,
  ResearchProjectBusyError,
} from "@/lib/research-projects";
import { researchRegistryRepairable } from "@/lib/research-panel";
import { reconcileResearchProjects } from "@/lib/research-runtime";
import { READ_ONLY_REFUSAL, ReadOnlyError } from "@/lib/read-only";
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
  let savedProvider: string | undefined;

  beforeEach(() => {
    vi.clearAllMocks();
    savedReadOnly = process.env.YOPEDIA_READONLY;
    savedProvider = process.env.RESEARCH_PROVIDER;
    // Cleared rather than inherited: a value exported in a developer's shell
    // would otherwise turn every case below into a 403.
    delete process.env.YOPEDIA_READONLY;
    delete process.env.RESEARCH_PROVIDER;
    mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
      ReturnType<typeof getPrincipal>
    >);
  });

  afterEach(() => {
    if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = savedReadOnly;
    if (savedProvider === undefined) delete process.env.RESEARCH_PROVIDER;
    else process.env.RESEARCH_PROVIDER = savedProvider;
  });

  it("403s on a read-only deployment without reaching the store", async () => {
    // DW-294. Before this gate nothing behind the handler refused, so the form
    // reported a create that happened. `createResearchProject` gates in the
    // kernel too since DW-385 (same sentence) for callers with no route in
    // front; this gate stays because it answers before the body parse.
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

  it("403s a create the KERNEL refuses after the flag flipped mid-request", async () => {
    // DW-526. `YOPEDIA_READONLY` is unset — the gate above passed, because the
    // deployment was writable when the request arrived — and
    // `createResearchProject` refuses anyway (DW-385). Classified as "not a
    // ClientInputError" this was a 500: a refusal reported as a server fault.
    // The kernel's own sentence is carried verbatim.
    mockedCreate.mockRejectedValue(
      new ReadOnlyError(READ_ONLY_REFUSAL.researchCreate),
    );

    const response = await POST(request(BODY));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      error: READ_ONLY_REFUSAL.researchCreate,
    });
    // The gate did not answer this — the store did.
    expect(mockedCreate).toHaveBeenCalledTimes(1);
  });

  it("still 500s a storage failure", async () => {
    // The discriminator for the row above: classification is by type, not by
    // "any error from the store is the caller's fault".
    mockedCreate.mockRejectedValue(new Error("disk full"));

    expect((await POST(request(BODY))).status).toBe(500);
  });

  it("400s a store-side ClientInputError such as a blank title", async () => {
    // `cleanInput` now throws this typed, so the route needs no message regex
    // to tell a blank title from a server fault.
    mockedCreate.mockRejectedValue(new ClientInputError("Research title is required"));

    const response = await POST(request(BODY));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Research title is required" });
  });

  it("500s a server fault whose message merely says \"invalid\"", async () => {
    // DW-296. The retired /required|invalid/i regex called this a 400, so the
    // client retried a storage fault forever. The message passes through
    // unchanged; only the status changes.
    mockedCreate.mockRejectedValue(
      new Error("EINVAL: invalid argument, open '/data/research-projects.json'"),
    );

    const response = await POST(request(BODY));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      error: "EINVAL: invalid argument, open '/data/research-projects.json'",
    });
  });

  /**
   * DW-684. `createResearchProject` reaches the same exhausted compare-and-swap
   * `POST /api/research/[id]/run` does, and that door has answered 503 for it
   * since DW-651 while this one said 500 — one store, two verdicts about one
   * moment of contention. The class's own sentence tells the caller to retry, so
   * a 500 (permanent server fault) was the wrong word for it.
   */
  it("503s a contended registry write so the caller knows to retry", async () => {
    mockedCreate.mockRejectedValue(
      new ResearchProjectBusyError("Research projects were busy; retry the request."),
    );

    const response = await POST(request(BODY));

    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      error: "Research projects were busy; retry the request.",
    });
  });

  it("500s an untyped error carrying that same sentence", async () => {
    // The control: classification is by TYPE, so the words buy nothing. An
    // `instanceof` that had been replaced by a message match would pass the row
    // above and fail this one.
    mockedCreate.mockRejectedValue(
      new Error("Research projects were busy; retry the request."),
    );

    expect((await POST(request(BODY))).status).toBe(500);
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

  /**
   * DW-442. `sourceUrls` used to be collected by the form, validated here and
   * stored — and then overwritten by the first automated run. Refusing is what
   * makes the removal legible: ignoring the field would leave a caller with the
   * same 201 and the same silently discarded seeds.
   */
  const SOURCE_URLS_REFUSAL =
    "sourceUrls is no longer accepted — an automated run collects its own sources.";

  it.each([
    ["a seed list", ["https://example.com/report"]],
    // Presence is what is refused, not contents: an empty list is still a
    // caller who believes the field does something.
    ["an empty list", []],
  ])("400s a create carrying %s of sourceUrls", async (_label, sourceUrls) => {
    const response = await POST(request({ ...BODY, sourceUrls }));

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: SOURCE_URLS_REFUSAL });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("201s the same body without the field, and forwards no sourceUrls KEY", async () => {
    // The control case: the refusal is about the KEY, not about the rest of the
    // brief, and nothing downstream is handed a seed list any more.
    mockedCreate.mockResolvedValue({ id: "p1" } as Awaited<
      ReturnType<typeof createResearchProject>
    >);

    const response = await POST(request(BODY));

    expect(response.status).toBe(201);
    // ON THE KEY, not on its value. `body.sourceUrls` is `undefined` on this
    // path, so restoring the deleted `sourceUrls: body.sourceUrls as …` line
    // would forward `{ sourceUrls: undefined }` — which an
    // `expect.not.objectContaining({ sourceUrls: expect.anything() })` accepts,
    // because `expect.anything()` does not match `undefined`. Reading the keys
    // is what makes this row able to fail on that regression.
    const input = mockedCreate.mock.calls[0][1];
    expect(Object.keys(input)).not.toContain("sourceUrls");
    expect("sourceUrls" in input).toBe(false);
  });

  it("still 403s a body carrying sourceUrls on a read-only deployment", async () => {
    // Ordering: read-only wins over the body check, the same way it already
    // wins over the body PARSE. A caller on a deployment that stores nothing
    // learns that first.
    process.env.YOPEDIA_READONLY = "1";

    const response = await POST(request({ ...BODY, sourceUrls: ["https://example.com/report"] }));

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchCreate });
    expect(mockedCreate).not.toHaveBeenCalled();
  });

  it("reconciles interrupted runs on the panel's read", async () => {
    // SM-3: the poll is where a queued project whose wake-up was lost gets
    // re-dispatched and an abandoned `collecting` one gets failed visibly.
    await GET(new Request("http://localhost/api/research"));

    expect(mockedReconcile).toHaveBeenCalledWith("alice", []);
  });

  it("keeps project history visible when the provider env is invalid", async () => {
    process.env.RESEARCH_PROVIDER = "unsupported";
    mockedList.mockResolvedValue([{ id: "p1" }] as Awaited<ReturnType<typeof listResearchProjects>>);
    mockedReconcile.mockImplementation(async (_owner, projects) => [...projects]);

    const response = await GET(new Request("http://localhost/api/research"));
    const body = await response.json() as {
      projects: Array<{ id: string }>;
      activeProvider: null;
      providerConfigurationError: string;
    };

    expect(response.status).toBe(200);
    expect(body.projects).toEqual([{ id: "p1" }]);
    expect(body.activeProvider).toBeNull();
    expect(body.providerConfigurationError).toMatch(/unsupported/i);
  });

  it("does not reconcile on a read-only deployment", async () => {
    // Reconciling writes. Every other door refuses a write here, so a GET that
    // quietly performed one would be the single exception.
    process.env.YOPEDIA_READONLY = "1";

    const response = await GET(new Request("http://localhost/api/research"));

    expect(response.status).toBe(200);
    expect(mockedReconcile).not.toHaveBeenCalled();
  });

  it("tells the Studio the deployment is read-only (DW-386)", async () => {
    // The desk's ONLY source for the flag. Without this the line could be
    // deleted and every other test would stay green while `/studio` shipped a
    // Research desk that never refuses: Create, Run, Cancel, Collect and Delete
    // all live in front of four 403s, and Delete's `window.confirm` open again.
    process.env.YOPEDIA_READONLY = "1";

    const response = await GET(new Request("http://localhost/api/research"));
    const body = await response.json() as { readOnly: boolean };

    expect(response.status).toBe(200);
    expect(body.readOnly).toBe(true);
  });

  it("says so when the deployment is writable — the control case", async () => {
    // Without this half, a route hardcoding `readOnly: true` would pass above
    // while refusing every research control on a deployment that writes fine.
    delete process.env.YOPEDIA_READONLY;

    const response = await GET(new Request("http://localhost/api/research"));
    const body = await response.json() as { readOnly: boolean };

    expect(body.readOnly).toBe(false);
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

  it("relays the store's repair hint to the client, verbatim (DW-688)", async () => {
    // THE ONE RELAY THE **Repair** CONTROL DEPENDS ON. `parseRegistry` refuses
    // a wedged registry with a sentence ending in `REPAIR_HINT`, this catch is
    // the only thing in production that puts that sentence in front of a
    // browser, and `researchRegistryRepairable` — which decides whether either
    // surface offers the control at all — reads nothing else.
    //
    // Nothing pinned it. Replace `getErrorMessage(error)` below with a fixed
    // sentence — the exact move DW-689 makes to the artifact door in this same
    // change, for good reasons there — and the store test, the predicate test
    // and both mounted client suites stay green while the way out of a wedged
    // registry silently stops rendering everywhere.
    //
    // The sentence is COMPOSED from the exported constant rather than retyped,
    // so a reworded hint moves this row with it instead of leaving it green
    // against copy that no longer exists.
    const wedged = `Research projects file is unreadable.${REPAIR_HINT}`;
    mockedList.mockRejectedValueOnce(new StoreFaultError(wedged));

    const response = await GET(new Request("http://localhost/api/research"));

    expect(response.status).toBe(500);
    const body = await response.json() as { error: string };
    expect(body.error).toBe(wedged);
    expect(body.error).toContain(REPAIR_HINT);
    // …and the client predicate, run over the body the client actually
    // receives, still says the control is offered. This is the end of the wire.
    expect(researchRegistryRepairable(body.error)).toBe(true);
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
