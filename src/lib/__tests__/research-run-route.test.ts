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
import { ResearchLeaseError } from "@/lib/research-concurrency";
import {
  editResearchProject,
  getResearchProject,
  ResearchProjectBusyError,
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

  /**
   * DW-651, every refusal `queueResearchProject` can raise and the status its
   * owner reads for it — decided by the CLASS alone, with the sentence echoed
   * verbatim beside `availableProviders` on every one of them.
   *
   * The RETIRED row is a 404 because the GET on this very path already answers
   * 404 for it; a 500 told the owner the store was broken about a project that
   * was simply gone. CONTENTION is a 503 because it is transient and every one
   * of those sentences already says `retry` — as a 500 it read as permanent and
   * carried no retry signal at all. `ResearchLeaseError` and a plain `Error`
   * carrying the very same words stay 500, which is what makes this a TYPE
   * ladder rather than the message-matching one DW-480 deleted.
   */
  it.each([
    [
      "a retired project",
      new ResearchProjectNotFoundError("Research project is retired"),
      404,
    ],
    [
      "a completion still being delivered",
      new ResearchProjectConflictError(
        "Research project completion is still being delivered",
      ),
      409,
    ],
    [
      "a lost delivery-retry CAS",
      new ResearchProjectBusyError(
        "Research project changed while delivery retry started",
      ),
      503,
    ],
    [
      "a lost rerun-baseline CAS",
      new ResearchProjectBusyError(
        "Research project changed while the rerun baseline was captured; retry",
      ),
      503,
    ],
    [
      "an exhausted store CAS ladder",
      new ResearchProjectBusyError("Research projects were busy; retry the request."),
      503,
    ],
    [
      "a lease that could not be retired",
      new ResearchLeaseError(
        "The previous research lease could not be retired; retry after storage recovers.",
      ),
      500,
    ],
    [
      "an untyped fault saying the project is retired",
      new Error("Research project is retired"),
      500,
    ],
    [
      "an untyped fault saying the projects were busy",
      new Error("Research projects were busy; retry the request."),
      500,
    ],
  ])("answers %s with the status its type decides", async (_label, fault, status) => {
    mockedQueue.mockRejectedValue(fault);

    const response = await POST(runRequest(), ctx());

    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({
      error: (fault as Error).message,
      availableProviders: expect.anything(),
    });
    expect(mockedEnqueue).not.toHaveBeenCalled();
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

  it("503s a CANCEL whose registry CAS was contended too", async () => {
    // `cancelResearchProject` reaches the same compare-and-swap and can raise
    // the same class. The ladder is verb-independent — the read-only tables
    // below run over both verbs for exactly this reason — so a 500 here would
    // strand a cancel with no retry signal while the run beside it got one.
    mockedCancel.mockRejectedValueOnce(
      new ResearchProjectBusyError("Research projects were busy; retry the request."),
    );

    const response = await POST(runRequest({ action: "cancel" }), ctx());

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: "Research projects were busy; retry the request.",
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
    // DW-684. An exhausted registry CAS is transient contention — the run door
    // has answered 503 for this class since DW-651 while this sibling said 500,
    // so the same moment got two verdicts from the one store.
    ["503s", new ResearchProjectBusyError("Research projects were busy; retry the request."), 503],
    // The control for the row above: by TYPE, never by the sentence.
    ["500s untyped", new Error("Research projects were busy; retry the request."), 500],
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

  /**
   * DW-657/DW-639. `retireResearchProject` gates, then TOMBSTONES through the
   * CAS, and a flag that flips in between now leaves it as a `ReadOnlyError`.
   * Before this branch that landed as the 500 below; before the runtime change
   * behind it, the writer returned `false` and the owner got 404 "Research
   * project not found." about a row nothing had touched.
   */
  it("403s a DELETE whose writer refuses mid-request", async () => {
    mockedDelete.mockRejectedValue(new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate));

    const response = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    // The gate did not fire — the writer WAS reached, which is what makes this
    // the mid-request flip rather than the early refusal above.
    expect(mockedDelete).toHaveBeenCalled();
  });

  it("403s a foreign ReadOnlyError on DELETE and echoes ITS sentence", async () => {
    // `isReadOnlyError` matches `err.name`, not `instanceof` — a second copy of
    // `read-only.ts` (vitest's two projects, a split server/edge bundle, the
    // stdio MCP entry point) would otherwise turn this 403 into a 500 only in
    // production.
    //
    // A DIFFERENT sentence on purpose. Carrying `researchMutate` here — the
    // literal this door's own early gate serves — a handler that re-served its
    // own constant instead of echoing the caught error would look identical,
    // and the backstop's whole point is that WHICH sentence the caller reads
    // records WHEN the deployment turned read-only.
    const foreign = new Error(READ_ONLY_REFUSAL.pageWrite);
    foreign.name = "ReadOnlyError";
    mockedDelete.mockRejectedValue(foreign);

    const response = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.pageWrite });
  });

  it("does not swallow the other DELETE outcomes", async () => {
    // The control for the branch above: an `isReadOnlyError` check that
    // matched too widely would turn every one of these into a 403.
    mockedDelete.mockResolvedValue(false);
    const missing = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Research project not found." });

    mockedDelete.mockResolvedValue(true);
    expect((await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params })).status).toBe(200);
  });

  it.each([
    ["400s", new ClientInputError("Research question is required"), 400],
    ["500s", new Error("EINVAL: invalid argument, open '/data/research-projects.json'"), 500],
    // DW-684, mirroring the PATCH table above: `retireResearchProject` routes
    // through the same CAS, so it must give the same retryable answer.
    ["503s", new ResearchProjectBusyError("Research projects were busy; retry the request."), 503],
    ["500s untyped", new Error("Research projects were busy; retry the request."), 500],
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

  /**
   * ONE STORE, ONE VERDICT (DW-684) — the parity stated in a single assertion
   * rather than as three per-door literals that could drift apart one at a
   * time. Both verbs reach the SAME exhausted compare-and-swap inside
   * `applyResearchProjectMutation`, and `POST /api/research/[id]/run` has
   * answered 503 for it since DW-651; these two said 500, so the identical
   * moment of contention got two different answers depending on which verb
   * the owner happened to use. The sibling of the names-terms three-verb
   * control in `names-terms-routes.test.ts`.
   */
  it("503s a contended registry write at BOTH verbs, matching the run door", async () => {
    const sentence = "Research projects were busy; retry the request.";
    // One-shot rejections. The suite's `beforeEach` calls `vi.clearAllMocks()`,
    // which clears CALL RECORDS but not implementations, so a sticky
    // `mockRejectedValue` here would keep throwing in every later case; `Once`
    // is also what lets it win over the resolved values the tests above left
    // on these same two mocks.
    mockedEdit.mockRejectedValueOnce(new ResearchProjectBusyError(sentence));
    mockedDelete.mockRejectedValueOnce(new ResearchProjectBusyError(sentence));

    const patched = await PATCH(patchRequest({ title: "New" }), { params });
    const deleted = await DELETE(new Request("http://localhost/api/research/p1", {
      method: "DELETE",
    }), { params });

    expect([patched.status, deleted.status]).toEqual([503, 503]);
    // The store's own sentence rides on both, verbatim.
    expect(await patched.json()).toEqual({ error: sentence });
    expect(await deleted.json()).toEqual({ error: sentence });
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

describe("POST /api/research/[id]/run — a writer that refuses mid-request", () => {
  /**
   * DW-657. The gate at the top of the handler answers a deployment that was
   * already read-only. This is the OTHER moment: the flag flips after the gate
   * passed, so the refusal comes from the CAS inside `queueResearchProject` /
   * `cancelResearchProject`. Collapsed to `null` that refusal used to leave
   * both as `ResearchProjectNotFoundError` — a 404 telling the owner their
   * project was gone, about a row nothing had written to.
   */
  it.each([
    ["start", {}, () => mockedQueue],
    ["cancel", { action: "cancel" }, () => mockedCancel],
  ] as const)("403s a %s whose writer refuses mid-request", async (_label, body, writer) => {
    writer().mockRejectedValueOnce(new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate));

    const response = await POST(runRequest(body), ctx());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });
    // The gate did not fire — the writer WAS reached.
    expect(writer()).toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedRun).not.toHaveBeenCalled();
  });

  it.each([
    ["start", {}, () => mockedQueue],
    ["cancel", { action: "cancel" }, () => mockedCancel],
  ] as const)("403s a foreign ReadOnlyError from %s and echoes ITS sentence", async (_label, body, writer) => {
    // `isReadOnlyError` matches `err.name`, not `instanceof` — a second copy of
    // `read-only.ts` (vitest's two projects, a split server/edge bundle, the
    // stdio MCP entry point) would otherwise turn this 403 into a 500 only in
    // production.
    //
    // A DIFFERENT sentence on purpose, for the reason the DELETE case beside
    // this one spells out: with `researchMutate` a handler that re-served the
    // literal from its own early gate would be indistinguishable from one that
    // echoes what the writer threw.
    const foreign = new Error(READ_ONLY_REFUSAL.pageWrite);
    foreign.name = "ReadOnlyError";
    writer().mockRejectedValueOnce(foreign);

    const response = await POST(runRequest(body), ctx());

    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: READ_ONLY_REFUSAL.pageWrite });
  });

  it("answers the delivery-retry branch's two outcomes with two different statuses", async () => {
    // DW-651 + DW-657. That branch's conditional update returns the read-only
    // SENTINEL for a refused deployment and `null` for a lost predicate;
    // `queueResearchProject` converts them to a `ReadOnlyError` and a
    // `ResearchProjectBusyError`. Collapsed back into one, the owner of a
    // read-only deployment would be told to retry in a moment a write that will
    // never be accepted. WHICH condition yields which class is pinned in the
    // runtime and read-only-gate suites, since this one mocks that module
    // wholesale; what is pinned here is that the door keeps them apart.
    mockedQueue.mockRejectedValueOnce(new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate));
    const refused = await POST(runRequest(), ctx());
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: READ_ONLY_REFUSAL.researchMutate });

    mockedQueue.mockRejectedValueOnce(
      new ResearchProjectBusyError("Research project changed while delivery retry started"),
    );
    const contended = await POST(runRequest(), ctx());
    expect(contended.status).toBe(503);
    expect(await contended.json()).toMatchObject({
      error: "Research project changed while delivery retry started",
      availableProviders: expect.anything(),
    });
  });

  it("does not swallow the other run outcomes", async () => {
    // The control for the branch above, walking the whole ladder behind it: a
    // check that matched too widely would turn every one of these into a 403.
    mockedQueue.mockRejectedValue(new ResearchProjectNotFoundError());
    expect((await POST(runRequest(), ctx())).status).toBe(404);

    mockedQueue.mockRejectedValue(new ResearchProjectConflictError("already running"));
    expect((await POST(runRequest(), ctx())).status).toBe(409);

    // The class DW-651 added, walked by the same control: an `isReadOnlyError`
    // check that matched too widely would answer 403 for this one too.
    mockedQueue.mockRejectedValue(
      new ResearchProjectBusyError("Research projects were busy; retry the request."),
    );
    expect((await POST(runRequest(), ctx())).status).toBe(503);

    mockedQueue.mockRejectedValue(new ClientInputError("Research question is required"));
    expect((await POST(runRequest(), ctx())).status).toBe(400);

    mockedQueue.mockRejectedValue(new Error("EIO: registry unreadable"));
    expect((await POST(runRequest(), ctx())).status).toBe(500);

    mockedCancel.mockRejectedValueOnce(new ResearchProjectNotFoundError());
    expect((await POST(runRequest({ action: "cancel" }), ctx())).status).toBe(404);
  });

  afterEach(() => {
    // The suite-wide `beforeEach` calls `vi.clearAllMocks()`, which clears
    // recorded CALLS but leaves implementations standing, and it re-seeds only
    // `mockedQueue`/`mockedEnqueue` — never `mockedCancel`. Every rejection in
    // this block is therefore one-shot, and this is the belt to that braces:
    // a cancel left rejecting would follow the cancel path into any block
    // added after this one, failing it for a reason with no source in it.
    // `mockedQueue` is reset too, since the ladder case above rejects it
    // repeatedly; `beforeEach` re-seeds it before the next test runs.
    mockedCancel.mockReset();
    mockedQueue.mockReset();
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
