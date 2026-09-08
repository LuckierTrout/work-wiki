import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-route", () => ({ requireOwnerPrincipal: vi.fn() }));
vi.mock("@/lib/todos", () => ({
  listTodos: vi.fn(async () => []),
  pendingTodoCount: vi.fn(async () => 0),
  getTodoExtractError: vi.fn(async () => undefined),
  decideTodos: vi.fn(async () => []),
  patchTodo: vi.fn(async () => null),
  deleteTodo: vi.fn(async () => false),
}));
vi.mock("@/lib/source-meeting", () => ({
  isSourceMeeting: vi.fn(async () => false),
  setSourceMeeting: vi.fn(async () => ({ path: "raw/sources/a.md", meeting: true })),
}));
vi.mock("@/lib/todo-dispatch", () => ({
  dispatchMeetingTodoExtract: vi.fn(async () => "ran"),
}));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn(async () => false) }));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  isReadOnly: vi.fn(() => false),
}));

import { requireOwnerPrincipal } from "@/lib/owner-route";
import { GET as listTodos, POST as postTodos } from "@/app/api/todos/route";
import { PATCH as patchTodo, DELETE as deleteTodo } from "@/app/api/todos/[id]/route";
import { GET as getMeeting, POST as postMeeting } from "@/app/api/sources/meeting/route";
import { listTodos as listTodosFn } from "@/lib/todos";
import { dispatchMeetingTodoExtract } from "@/lib/todo-dispatch";

const mockedOwner = vi.mocked(requireOwnerPrincipal);

function request(url: string, method = "GET", body?: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedOwner.mockResolvedValue(null);
});

describe("Todo APIs require a signed-in owner", () => {
  it("returns 401 Sign in required. when signed out", async () => {
    const responses = await Promise.all([
      listTodos(request("http://localhost/api/todos")),
      postTodos(request("http://localhost/api/todos", "POST", { decision: "approve", ids: [] })),
      patchTodo(request("http://localhost/api/todos/x", "PATCH", { status: "done" }), {
        params: Promise.resolve({ id: "x" }),
      }),
      deleteTodo(request("http://localhost/api/todos/x", "DELETE"), {
        params: Promise.resolve({ id: "x" }),
      }),
      getMeeting(request("http://localhost/api/sources/meeting?path=raw/sources/a.md")),
      postMeeting(request("http://localhost/api/sources/meeting", "POST", {
        path: "raw/sources/a.md",
      })),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Sign in required." });
    }
  });
});

describe("signed-in Todo doors", () => {
  beforeEach(() => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
  });

  it("passes ?tab= to listTodos", async () => {
    const res = await listTodos(request("http://localhost/api/todos?tab=open"));
    expect(res.status).toBe(200);
    expect(listTodosFn).toHaveBeenCalledWith("alice", "open");
  });

  it("retries extract through dispatchMeetingTodoExtract", async () => {
    const res = await postTodos(
      request("http://localhost/api/todos", "POST", {
        retry: true,
        slug: "meet",
        sourcePath: "raw/sources/meet/a.md",
      }),
    );
    expect(res.status).toBe(200);
    expect(dispatchMeetingTodoExtract).toHaveBeenCalledWith("alice", {
      slug: "meet",
      sourcePath: "raw/sources/meet/a.md",
    });
  });

  it("does not claim retry succeeded when dispatch skips", async () => {
    vi.mocked(dispatchMeetingTodoExtract).mockResolvedValueOnce("skipped");
    const res = await postTodos(
      request("http://localhost/api/todos", "POST", {
        retry: true,
        slug: "notes",
      }),
    );
    expect(res.status).toBe(409);
  });
});
