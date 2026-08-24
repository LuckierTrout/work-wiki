/**
 * The Deep Research mutate doors: `POST /api/research/[id]/run`, and the PATCH
 * and DELETE beside it.
 *
 * Handlers imported directly with the store mocked (the `research-route.test.ts`
 * recipe). What is pinned here is the DOOR, not the run: the read-only refusal
 * and its ordering behind the 401, the 202-and-poll contract that replaced
 * "run the whole job inside the POST", and the 400 that names a provider the
 * deployment has not configured.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/research-runtime", () => ({
  queueResearchProject: vi.fn(),
  runResearchProject: vi.fn(),
  cancelResearchProject: vi.fn(),
}));
vi.mock("@/lib/research-projects", () => ({
  deleteResearchProject: vi.fn(),
  updateResearchProject: vi.fn(),
}));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn() }));

import { POST } from "@/app/api/research/[id]/run/route";
import { DELETE, PATCH } from "@/app/api/research/[id]/route";
import { getPrincipal } from "@/lib/auth";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { ResearchProviderUnconfiguredError } from "@/lib/research-providers";
import { deleteResearchProject, updateResearchProject } from "@/lib/research-projects";
import {
  cancelResearchProject,
  queueResearchProject,
  runResearchProject,
} from "@/lib/research-runtime";
import { enqueueTask } from "@/lib/tasks";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedQueue = vi.mocked(queueResearchProject);
const mockedRun = vi.mocked(runResearchProject);
const mockedCancel = vi.mocked(cancelResearchProject);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedUpdate = vi.mocked(updateResearchProject);
const mockedDelete = vi.mocked(deleteResearchProject);

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

  it("404s a project that is not there and 409s one already running", async () => {
    mockedQueue.mockRejectedValue(new Error("Research project not found"));
    expect((await POST(runRequest(), ctx())).status).toBe(404);

    mockedQueue.mockRejectedValue(new Error("Research project is already running"));
    expect((await POST(runRequest(), ctx())).status).toBe(409);
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
    expect(mockedUpdate).not.toHaveBeenCalled();
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
    mockedUpdate.mockResolvedValue({ id: "p1", title: "New" } as Awaited<
      ReturnType<typeof updateResearchProject>
    >);

    const response = await PATCH(patchRequest({ title: "New" }), { params });

    expect(response.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalled();
  });
});
