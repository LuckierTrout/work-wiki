import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/chat", async (original) => ({
  ...(await original<typeof import("@/lib/chat")>()),
  addChatTurn: vi.fn(),
  persistChatTurn: vi.fn(),
  retractLastChatTurn: vi.fn(),
  createChatConversation: vi.fn(),
  getChatConversation: vi.fn(),
  updateChatConversation: vi.fn(),
}));

import {
  GET as listConversations,
  POST as createConversation,
} from "@/app/api/chat/conversations/route";
import { PATCH as updateConversation } from "@/app/api/chat/conversations/[id]/route";
import { POST as addMessage } from "@/app/api/chat/conversations/[id]/messages/route";
import { getPrincipal } from "@/lib/auth";
import {
  addChatTurn,
  persistChatTurn,
  createChatConversation,
  retractLastChatTurn,
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
const mockedPersist = vi.mocked(persistChatTurn);
const mockedRetract = vi.mocked(retractLastChatTurn);
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
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", undefined);
  mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });
  mockedCreate.mockResolvedValue(CONVERSATION);
  mockedUpdate.mockResolvedValue(CONVERSATION);
});

afterEach(() => {
  vi.unstubAllEnvs();
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

  it("refuses Worker generation on the leftover { message } door", async () => {
    const response = await addMessage(
      request("POST", { message: "What does the source say?" }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(410);
    await expect(response.json()).resolves.toEqual({ error: "sidecar_required" });
    expect(mockedAddTurn).not.toHaveBeenCalled();
  });

  it("persists sidecar frames without Worker generation", async () => {
    mockedPersist.mockResolvedValue({
      ...CONVERSATION,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "What is alpha?",
          sources: [],
          createdAt: CONVERSATION.createdAt,
        },
      ],
    });
    const response = await addMessage(
      request("POST", {
        persist: true,
        messages: [
          { role: "user", content: "What is alpha?" },
          {
            role: "assistant",
            content: "Alpha [1].",
            citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
          },
        ],
      }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(200);
    expect(mockedPersist).toHaveBeenCalledWith(
      "alice",
      CONVERSATION.id,
      expect.arrayContaining([
        expect.objectContaining({ role: "user", content: "What is alpha?" }),
      ]),
      { replaceLastTurn: false },
    );
    expect(mockedAddTurn).not.toHaveBeenCalled();
  });

  it("retracts the last turn for Regenerate", async () => {
    mockedRetract.mockResolvedValue({
      conversation: CONVERSATION,
      userContent: "What is alpha?",
    });
    const response = await addMessage(
      request("POST", { retractLastTurn: true }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ userContent: "What is alpha?", noop: false }),
    );
    expect(mockedRetract).toHaveBeenCalledWith("alice", CONVERSATION.id);
  });

  it("rejects a misordered persist batch before storage", async () => {
    const response = await addMessage(
      request("POST", {
        persist: true,
        messages: [{ role: "assistant", content: "Only the model spoke [1]." }],
      }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(400);
    expect(mockedPersist).not.toHaveBeenCalled();
  });

  it("rejects malformed persist JSON with 400", async () => {
    const response = await addMessage(
      new Request("http://localhost/api/chat/conversations/x/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{",
      }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(response.status).toBe(400);
  });

  it("rejects a non-numeric tokenBudget", async () => {
    const created = await createConversation(
      request("POST", { tokenBudget: "big" }),
    );
    expect(created.status).toBe(400);
    expect(mockedCreate).not.toHaveBeenCalled();
  });
});

describe("configured owner gate", () => {
  it("401s Conversation and Save when the principal is not the owner", async () => {
    vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "owner");
    mockedPrincipal.mockResolvedValue({ id: "user-1", handle: "alice" });

    const list = await listConversations();
    expect(list.status).toBe(401);

    const persist = await addMessage(
      request("POST", { persist: true, messages: [] }),
      { params: Promise.resolve({ id: CONVERSATION.id }) },
    );
    expect(persist.status).toBe(401);

    const { POST: saveAnswer } = await import(
      "@/app/api/chat/conversations/[id]/save/route"
    );
    const saved = await saveAnswer(request("POST", { messageId: "a1" }), {
      params: Promise.resolve({ id: CONVERSATION.id }),
    });
    expect(saved.status).toBe(401);
    expect(mockedPersist).not.toHaveBeenCalled();
  });
});
