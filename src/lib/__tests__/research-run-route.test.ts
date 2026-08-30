/**
 * The Deep Research project doors: `POST /api/research/[id]/run` and the `GET`
 * the panel polls it with, plus the PATCH and DELETE beside them.
 *
 * Handlers imported directly with the store mocked (the `research-route.test.ts`
 * recipe). What is pinned here is the DOOR, not the run: the read-only refusal
 * and its ordering behind the 401, the 202-and-poll contract that replaced
 * "run the whole job inside the POST", the 400 that names a provider the
 * deployment has not configured, and — for both verbs — that every fault leaves
 * by a JSON `{ error }` body with a status decided by TYPE, never by matching
 * the message.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/research-runtime", () => ({
  queueResearchProject: vi.fn(),
  runResearchProject: vi.fn(),
  cancelResearchProject: vi.fn(),
  retireResearchProject: vi.fn(),
}));
// PARTIAL mock — the spread is load-bearing, not tidiness. The run route now
// imports `ResearchProjectNotFoundError` / `ResearchProjectConflictError` from
// this module to classify its catch by `instanceof`; under a bare factory those
// bindings would be `undefined` and every `instanceof` in the catch would throw
// at runtime. Only the four store functions are stubbed.
vi.mock("@/lib/research-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research-projects")>()),
  deleteResearchProject: vi.fn(),
  updateResearchProject: vi.fn(),
  updateResearchProjectIf: vi.fn(),
  editResearchProject: vi.fn(),
  getResearchProject: vi.fn(),
}));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn() }));

import { GET, POST } from "@/app/api/research/[id]/run/route";
import { DELETE, PATCH } from "@/app/api/research/[id]/route";
import { getPrincipal } from "@/lib/auth";
import { ClientInputError } from "@/lib/errors";
import { READ_ONLY_REFUSAL, ReadOnlyError } from "@/lib/read-only";
import {
  ResearchProviderOverrideError,
  ResearchProviderUnconfiguredError,
} from "@/lib/research-providers";
import {
  editResearchProject,
  getResearchProject,
  ResearchProjectConflictError,
  ResearchProjectNotFoundError,
  updateResearchProject,
} from "@/lib/research-projects";
import {
  cancelResearchProject,
  queueResearchProject,
  retireResearchProject,
  runResearchProject,
} from "@/lib/research-runtime";
import { enqueueTask } from "@/lib/tasks";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedQueue = vi.mocked(queueResearchProject);
const mockedRun = vi.mocked(runResearchProject);
const mockedCancel = vi.mocked(cancelResearchProject);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedEdit = vi.mocked(editResearchProject);
const mockedDelete = vi.mocked(retireResearchProject);
const mockedGet = vi.mocked(getResearchProject);

const params = Promise.resolve({ id: "p1" });
const ctx = () => ({ params: Promise.resolve({ id: "p1" }) });

const runRequest = (body: unknown = {}) =>
  new Request("http://localhost/api/research/p1/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

let savedReadOnly: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  savedReadOnly = process.env.YOPEDIA_READONLY;
  delete process.env.YOPEDIA_READONLY;
  mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<
    ReturnType<typeof getPrincipal>
  >);
  mockedQueue.mockResolvedValue({ id: "p1", status: "queued" } as Awaited<
    ReturnType<typeof queueResearchProject>
  >);
  mockedEnqueue.mockResolvedValue(true);
});

afterEach(() => {
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
});

describe("POST /api/research/[id]/run", () => {
  it("202s and hands the run to the queue rather than doing it in the request", async () => {
    // The run searches, fetches up to eight pages and calls an LLM. A response
    // that arrived only after all of that would hold the request open for
    // minutes and time out behind any proxy — the panel polls instead.
    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      project: { id: "p1", status: "queued" },
      enqueued: true,
    });
    expect(mockedEnqueue).toHaveBeenCalledWith({
      kind: "run-research",
      projectId: "p1",
      owner: "alice",
    });
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it("starts the run inline — still unawaited — when there is no queue", async () => {
    // Off-Workers there is nothing to hand it to. It must still not block the
    // response, and it must still respect the same three-slot lease.
    mockedEnqueue.mockResolvedValue(false);
    mockedRun.mockReturnValue(new Promise(() => {}) as ReturnType<typeof runResearchProject>);

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ enqueued: false });
    expect(mockedRun).toHaveBeenCalledWith("alice", "p1");
  });

  it("403s a read-only deployment before the project is touched", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    expect(mockedQueue).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("refuses a read-only cancel too — cancel writes the project record", async () => {
    process.env.YOPEDIA_READONLY = "1";

    expect((await POST(runRequest({ action: "cancel" }), ctx())).status).toBe(403);
    expect(mockedCancel).not.toHaveBeenCalled();
  });

  it("still 401s an unauthenticated caller on a read-only deployment", async () => {
    process.env.YOPEDIA_READONLY = "1";
    mockedPrincipal.mockResolvedValue(null);

    expect((await POST(runRequest(), ctx())).status).toBe(401);
  });

  it("400s a selected provider that has no credential, and names what IS configured", async () => {
    // The owner's configuration, not a server fault — and reported with the
    // alternatives so the surface can say what to switch to without ever
    // silently switching.
    mockedQueue.mockRejectedValue(new ResearchProviderUnconfiguredError("tavily"));

    const response = await POST(runRequest(), ctx());
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/no credential/);
    expect(body).toHaveProperty("availableProviders");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("400s an unsupported deployment provider override without enqueueing", async () => {
    mockedQueue.mockRejectedValue(new ResearchProviderOverrideError("firecrawl"));

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringMatching(/unsupported value/i) });
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("404s a project that is not there and 409s one already running", async () => {
    mockedQueue.mockRejectedValue(new ResearchProjectNotFoundError());
    expect((await POST(runRequest(), ctx())).status).toBe(404);

    mockedQueue.mockRejectedValue(
      new ResearchProjectConflictError("Research project is already running"),
    );
    expect((await POST(runRequest(), ctx())).status).toBe(409);
  });

  it("400s a store refusal of the caller's own input", async () => {
    // The `POST /api/research` branch this door was missing entirely: a
    // `ClientInputError` is the caller's fault by construction and used to fall
    // through to 500 here.
    mockedQueue.mockRejectedValue(new ClientInputError("Research question is required"));

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "Research question is required",
      availableProviders: expect.anything(),
    });
  });

  /**
   * DW-480/DW-577. The catch used to decide 404/409 by running `/not found/i`
   * and `/already running/i` over the MESSAGE, so a storage fault whose
   * sentence happened to carry those words was handed to the caller as their
   * own mistake — a 404 invites "the project is gone", a 409 invites "retry
   * later", and both hide a store that is broken. Classification is by TYPE
   * now, so an untyped `Error` is a 500 no matter what it says.
   */
  it.each([
    ["says not found", new Error("R2 object not found for research-projects.json")],
    ["says already running", new Error("lock already running for research-projects.json")],
  ])("500s a storage fault whose message %s", async (_label, fault) => {
    mockedQueue.mockRejectedValue(fault);

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({
      error: fault.message,
      availableProviders: expect.anything(),
    });
  });

  it("cancels through the same door", async () => {
    mockedCancel.mockResolvedValue({ id: "p1", status: "cancelled" } as Awaited<
      ReturnType<typeof cancelResearchProject>
    >);

    const response = await POST(runRequest({ action: "cancel" }), ctx());

    expect(response.status).toBe(200);
    expect(mockedCancel).toHaveBeenCalledWith("alice", "p1");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

describe("PATCH and DELETE /api/research/[id]", () => {
  const patchRequest = (body: unknown) =>
    new Request("http://localhost/api/research/p1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

  it("403s a read-only PATCH before the store is written", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const response = await PATCH(patchRequest({ title: "New" }), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("403s a read-only DELETE before the store is written", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const response = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    expect(mockedDelete).not.toHaveBeenCalled();
  });

  it("still writes on a writable deployment", async () => {
    mockedEdit.mockResolvedValue({ id: "p1", title: "New" } as Awaited<
      ReturnType<typeof updateResearchProject>
    >);

    const response = await PATCH(patchRequest({ title: "New" }), { params });

    expect(response.status).toBe(200);
    expect(mockedEdit).toHaveBeenCalled();
    expect(mockedEdit.mock.calls[0][2]({ status: "draft" } as never)).toBe(true);
    expect(mockedEdit.mock.calls[0][2]({ status: "collecting" } as never)).toBe(false);
    expect(mockedEdit.mock.calls[0][2]({ status: "draft", deleteRequested: true } as never)).toBe(false);
  });

  it("refuses a client-supplied status or synthesis", async () => {
    mockedGet.mockResolvedValue({ id: "p1", status: "draft" } as Awaited<
      ReturnType<typeof getResearchProject>
    >);

    expect((await PATCH(patchRequest({ status: "complete" }), { params })).status).toBe(400);
    expect((await PATCH(patchRequest({ synthesis: "# Invented" }), { params })).status).toBe(400);
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it.each([
    ["malformed JSON", "{not json"],
    ["JSON null", "null"],
    ["JSON array", "[]"],
  ])("400s %s PATCH input", async (_label, body) => {
    const response = await PATCH(new Request("http://localhost/api/research/p1", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body,
    }), { params });

    expect(response.status).toBe(400);
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it.each([
    ["blank title", { title: "  " }],
    ["blank question", { question: "  " }],
    ["empty query set", { queries: [] }],
    ["non-string query", { queries: [7] }],
  ])("400s %s PATCH input", async (_label, body) => {
    expect((await PATCH(patchRequest(body), { params })).status).toBe(400);
    expect(mockedEdit).not.toHaveBeenCalled();
  });

  it("404s an edit of a row DELETE already retired", async () => {
    mockedEdit.mockResolvedValue(null);
    mockedGet.mockResolvedValue({ id: "p1", status: "cancelled", deleteRequested: true } as Awaited<
      ReturnType<typeof getResearchProject>
    >);

    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(404);
  });

  it("refuses an edit of a running project", async () => {
    mockedEdit.mockResolvedValue(null);
    mockedGet.mockResolvedValue({ id: "p1", status: "collecting" } as Awaited<
      ReturnType<typeof getResearchProject>
    >);

    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(409);
  });

  /**
   * DW-478. Both catches used to answer 500 for everything, so the store's
   * typed refusals — the `MAX_PROJECTS` cap and `cleanInput`'s blank
   * title/question — surfaced as server faults at these doors while
   * `POST /api/research` already classified them correctly. Classification is by
   * TYPE alone; the message passes through unchanged either way.
   */
  it.each([
    ["400s", new ClientInputError("Research question is required"), 400],
    ["500s", new Error("EINVAL: invalid argument, open '/data/research-projects.json'"), 500],
  ])("%s a store fault on PATCH", async (_label, fault, status) => {
    mockedEdit.mockRejectedValue(fault);

    const response = await PATCH(patchRequest({ title: "New" }), { params });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: fault.message });
  });

  /**
   * DW-527. The early `isReadOnly()` gate above answers a deployment that was
   * already read-only when the request arrived. This is the OTHER moment: the
   * flag flips after the gate passed, so the refusal comes from
   * `editResearchProject`'s own `assertWritable`. Before the new first branch
   * that landed as a 500 — a server fault the owner would retry forever — and
   * a `null`-returning writer would have landed as the 409 below, which names
   * the wrong reason entirely.
   */
  it("403s a PATCH whose writer refuses mid-request", async () => {
    mockedEdit.mockRejectedValue(new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate));

    const response = await PATCH(patchRequest({ title: "New" }), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    // The gate did not fire — the store WAS reached, which is what makes this
    // the mid-request flip rather than the early refusal above.
    expect(mockedEdit).toHaveBeenCalled();
  });

  it("403s a foreign ReadOnlyError, since the branch classifies by name", async () => {
    // `isReadOnlyError` matches `err.name`, not `instanceof` — a second copy of
    // `read-only.ts` (vitest's two projects, a split server/edge bundle, the
    // stdio MCP entry point) would otherwise turn this 403 into a 500 only in
    // production.
    const foreign = new Error(READ_ONLY_REFUSAL.researchMutate);
    foreign.name = "ReadOnlyError";
    mockedEdit.mockRejectedValue(foreign);

    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(403);
  });

  it("does not swallow the other PATCH outcomes", async () => {
    // The control for the branch above: a `isReadOnlyError` check that matched
    // too widely would turn every one of these into a 403.
    mockedEdit.mockRejectedValue(new ClientInputError("Research question is required"));
    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(400);

    mockedEdit.mockRejectedValue(new Error("EINVAL: invalid argument"));
    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(500);

    mockedEdit.mockResolvedValue(null);
    mockedGet.mockResolvedValue(null);
    expect((await PATCH(patchRequest({ title: "New" }), { params })).status).toBe(404);

    mockedGet.mockResolvedValue({ id: "p1", status: "collecting" } as Awaited<
      ReturnType<typeof getResearchProject>
    >);
    const conflict = await PATCH(patchRequest({ title: "New" }), { params });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({
      error: "A running or finished research project cannot be edited.",
    });
  });

  it.each([
    ["400s", new ClientInputError("Research question is required"), 400],
    ["500s", new Error("EINVAL: invalid argument, open '/data/research-projects.json'"), 500],
  ])("%s a store fault on DELETE", async (_label, fault, status) => {
    mockedDelete.mockRejectedValue(fault);

    const response = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error: fault.message });
  });

  it("retires on DELETE so the lease is released", async () => {
    mockedDelete.mockResolvedValue(true);

    const response = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect(response.status).toBe(200);
    expect(mockedDelete).toHaveBeenCalledWith("alice", "p1");
  });
});

describe("POST /api/research/[id]/run — owner lifecycle only", () => {
  it("400s an unknown action instead of treating it as start", async () => {
    const response = await POST(runRequest({ action: "retry" }), ctx());

    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("400s malformed JSON instead of treating it as start", async () => {
    const response = await POST(
      new Request("http://localhost/api/research/p1/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{not json",
      }),
      ctx(),
    );

    expect(response.status).toBe(400);
    expect(mockedQueue).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("400s a provider override — Settings is the source of record", async () => {
    const response = await POST(runRequest({ provider: "serpapi" }), ctx());

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: "The search provider is chosen in Settings, not on the run.",
    });
    expect(mockedQueue).not.toHaveBeenCalled();
  });
});

describe("GET /api/research/[id]/run", () => {
  const getRequest = () => new Request("http://localhost/api/research/p1/run");

  it("401s an unauthenticated caller", async () => {
    mockedPrincipal.mockResolvedValue(null);

    expect((await GET(getRequest(), ctx())).status).toBe(401);
    expect(mockedGet).not.toHaveBeenCalled();
  });

  it("returns the project the panel polls for", async () => {
    mockedGet.mockResolvedValue({ id: "p1", status: "collecting" } as Awaited<
      ReturnType<typeof getResearchProject>
    >);

    const response = await GET(getRequest(), ctx());

    expect(response.status).toBe(200);
    // `availableProviders` is half this response's contract — the panel reads it
    // to say what the deployment can switch to.
    expect(await response.json()).toMatchObject({
      project: { id: "p1", status: "collecting" },
      availableProviders: expect.anything(),
    });
  });

  it.each([
    ["absent", null],
    ["retired", { id: "p1", status: "cancelled", deleteRequested: true }],
  ])("404s a project that is %s", async (_label, project) => {
    mockedGet.mockResolvedValue(project as Awaited<ReturnType<typeof getResearchProject>>);

    const response = await GET(getRequest(), ctx());

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Research project not found." });
  });

  /**
   * DW-576. `parseRegistry` refuses a registry that is not a list (DW-297,
   * widened by DW-476), and the handler ran entirely outside a `try` — so the
   * refusal escaped as a framework error page with NO body. What is pinned is
   * the SHAPE: this door answers the same `{ error }` JSON every sibling door
   * returns, carrying the store's own sentence, so any client that reads the
   * body gets one. (The Studio's Research poll discards it — `catch {}` — which
   * is why the missing body went unnoticed.)
   */
  it("500s a refused registry with a real JSON body", async () => {
    mockedGet.mockRejectedValue(new Error("Research projects file is not a list."));

    const response = await GET(getRequest(), ctx());

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Research projects file is not a list." });
  });
});
