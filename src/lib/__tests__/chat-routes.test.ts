import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/chat", async (original) => ({
  ...(await original<typeof import("@/lib/chat")>()),
  addChatTurn: vi.fn(),
  createChatConversation: vi.fn(),
  getChatConversation: vi.fn(),
  updateChatConversation: vi.fn(),
}));

import { POST as createConversation } from "@/app/api/chat/conversations/route";
import { PATCH as updateConversation } from "@/app/api/chat/conversations/[id]/route";
import { POST as addMessage } from "@/app/api/chat/conversations/[id]/messages/route";
import { getPrincipal } from "@/lib/auth";
import {
  addChatTurn,
  createChatConversation,
  updateChatConversation,
  type ChatConversation,
} from "@/lib/chat";

const CONVERSATION: ChatConversation = {
  id: "conversation-1",
  title: "Evidence review",
  retrievalMode: "sources",
  messages: [],
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedAddTurn = vi.mocked(addChatTurn);
const mockedCreate = vi.mocked(createChatConversation);
const mockedUpdate = vi.mocked(updateChatConversation);

function request(method: string, body: Record<string, unknown>) {
  return new Request("http://localhost/api/chat/conversations", {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedCreate.mockResolvedValue(CONVERSATION);
  mockedUpdate.mockResolvedValue(CONVERSATION);
});

describe("chat evidence-mode API", () => {
  it("persists original-source mode when a conversation is created", async () => {
    const response = await createConversation(request("POST", {
      scope: "mine",
      retrievalMode: "sources",
    }));
    expect(response.status).toBe(201);
    expect(mockedCreate).toHaveBeenCalledWith("alice", {
      scope: "mine",
      retrievalMode: "sources",
    });
  });

  it("persists a per-conversation context budget", async () => {
    const created = await createConversation(request("POST", {
      scope: "mine",
      contextBudget: "compact",
    }));
    const updated = await updateConversation(
      request("PATCH", { contextBudget: "expanded" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(created.status).toBe(201);
    expect(updated.status).toBe(200);
    expect(mockedCreate).toHaveBeenCalledWith("alice", {
      scope: "mine",
      contextBudget: "compact",
    });
    expect(mockedUpdate).toHaveBeenCalledWith("alice", CONVERSATION.id, {
      contextBudget: "expanded",
    });
  });

  it("rejects unknown context budgets before storage is called", async () => {
    const created = await createConversation(request("POST", {
      contextBudget: "unlimited",
    }));
    const updated = await updateConversation(
      request("PATCH", { contextBudget: "unlimited" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(created.status).toBe(400);
    expect(updated.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("updates evidence mode on an existing owner conversation", async () => {
    const response = await updateConversation(
      request("PATCH", { retrievalMode: "wiki" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("alice", CONVERSATION.id, {
      retrievalMode: "wiki",
    });
  });

  it("rejects unknown evidence modes before storage is called", async () => {
    const created = await createConversation(request("POST", {
      retrievalMode: "internet",
    }));
    const updated = await updateConversation(
      request("PATCH", { retrievalMode: "internet" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(created.status).toBe(400);
    expect(updated.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("returns a useful client error when a scope has no original snapshots", async () => {
    mockedAddTurn.mockRejectedValue(
      new Error("No original source material is available in this scope."),
    );
    const response = await addMessage(
      request("POST", { message: "What does the source say?" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(422);
    expect((await response.json()).error).toMatch(/no original source material/i);
  });
});
