/**
 * The Chat conversation doors and their rules (DW-587).
 *
 * `send` is mocked rather than `fetch`: it is the parsed-body helper every
 * workbench write goes through, and a suite that stubbed the network instead
 * would pass even if the store reached around it with a bare `fetch`. What is
 * asserted here is what a review of a Chat door is actually about — the URL, the
 * method, the exact body, and what an answer that carries nothing means.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("../workbench-request", () => ({ send }));

import {
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_TOKEN_BUDGET_DEFAULT,
} from "../chat-contract";
import {
  CONVERSATION_PERSIST_FAILED_COPY,
  conversationSettings,
  conversationUrl,
  createConversation,
  deleteConversation,
  dropOptimisticMessages,
  groupCitationsByType,
  lastAssistantMessage,
  listConversations,
  mergeConversationRow,
  messageWirePayload,
  patchConversation,
  persistConversationMessages,
  readConversation,
  regenerateTarget,
  renameConversation,
  saveAnswerToWiki,
  type CanvasMessage,
  type ConversationRow,
} from "../chat-conversation-store";

const SETTINGS = {
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  selectedSkill: "recap",
};

/** The body of the one call `send` was given, parsed back. */
function sentBody(call = 0): unknown {
  return JSON.parse(String(send.mock.calls[call]?.[1]?.body));
}

beforeEach(() => {
  send.mockReset();
});

describe("the conversation list", () => {
  it("reads the list door and hands back its rows", async () => {
    send.mockResolvedValue({ conversations: [{ id: "c1", title: "One" }] });
    await expect(listConversations()).resolves.toEqual([{ id: "c1", title: "One" }]);
    expect(send).toHaveBeenCalledWith("/api/chat/conversations", { method: "GET" });
  });

  it("reads a body with no conversations as an empty list, not a failure", async () => {
    send.mockResolvedValue({});
    await expect(listConversations()).resolves.toEqual([]);
  });
});

describe("reading one conversation", () => {
  it("encodes the id into the path", async () => {
    send.mockResolvedValue({ conversation: { id: "c 1", title: "Spaced" } });
    await expect(readConversation("c 1")).resolves.toEqual({
      id: "c 1",
      title: "Spaced",
    });
    expect(send).toHaveBeenCalledWith("/api/chat/conversations/c%201", {
      method: "GET",
    });
    expect(conversationUrl("c 1")).toBe("/api/chat/conversations/c%201");
  });

  it("returns null when the body carries no conversation", async () => {
    send.mockResolvedValue({});
    await expect(readConversation("c1")).resolves.toBeNull();
  });
});

describe("the settings a loaded row puts in the toolbar", () => {
  it("falls back to the shared defaults and passes the Skill through", () => {
    const row: ConversationRow = {
      id: "c1",
      title: "One",
      retrievalMode: "sources",
      selectedSkill: "recap",
    };
    expect(conversationSettings(row)).toEqual({
      retrievalMode: "sources",
      tokenBudget: CHAT_TOKEN_BUDGET_DEFAULT,
      historyDepth: CHAT_HISTORY_DEPTH_DEFAULT,
      selectedSkill: "recap",
    });
  });

  it("reads an unrecognized retrieval mode as wiki", () => {
    const row = {
      id: "c1",
      title: "One",
      retrievalMode: "everything",
    } as unknown as ConversationRow;
    expect(conversationSettings(row).retrievalMode).toBe("wiki");
  });

  it("keeps a stored budget and depth rather than the defaults", () => {
    expect(
      conversationSettings({
        id: "c1",
        title: "One",
        tokenBudget: 8_000,
        historyDepth: 3,
      }),
    ).toEqual({
      retrievalMode: "wiki",
      tokenBudget: 8_000,
      historyDepth: 3,
      selectedSkill: undefined,
    });
  });
});

describe("creating a conversation", () => {
  it("posts exactly the three settings the door accepts", async () => {
    send.mockResolvedValue({ conversation: { id: "c9", title: "New" } });
    await expect(createConversation(SETTINGS)).resolves.toEqual({
      id: "c9",
      title: "New",
    });
    expect(send.mock.calls[0]?.[0]).toBe("/api/chat/conversations");
    expect(send.mock.calls[0]?.[1]?.method).toBe("POST");
    // The Skill is NOT among them — it is picked on a conversation that exists.
    expect(sentBody()).toEqual({
      retrievalMode: "wiki",
      tokenBudget: 32_000,
      historyDepth: 10,
    });
  });

  it("returns null when the body carries no conversation", async () => {
    send.mockResolvedValue({});
    await expect(createConversation(SETTINGS)).resolves.toBeNull();
  });
});

describe("deleting a conversation", () => {
  it("sends DELETE at the conversation's own door", async () => {
    send.mockResolvedValue({});
    await deleteConversation("c1");
    expect(send).toHaveBeenCalledWith("/api/chat/conversations/c1", {
      method: "DELETE",
    });
  });
});

describe("renaming a conversation", () => {
  it("patches the name and hands back the row", async () => {
    send.mockResolvedValue({ conversation: { id: "c1", title: "One", name: "Renamed" } });
    await expect(renameConversation("c1", "Renamed")).resolves.toEqual({
      id: "c1",
      title: "One",
      name: "Renamed",
    });
    expect(send.mock.calls[0]?.[0]).toBe("/api/chat/conversations/c1");
    expect(send.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(sentBody()).toEqual({ name: "Renamed" });
  });

  it("returns null when the body carries no conversation, so the list is untouched", async () => {
    send.mockResolvedValue({});
    const rows: ConversationRow[] = [{ id: "c1", title: "One" }];
    const answer = await renameConversation("c1", "Renamed");
    expect(answer).toBeNull();
    expect(rows).toEqual([{ id: "c1", title: "One" }]);
  });
});

describe("patching a setting", () => {
  it("sends the patch as given and hands the merged row back", async () => {
    send.mockResolvedValue({ conversation: { id: "c1", title: "One", tokenBudget: 8000 } });
    const conversation = await patchConversation("c1", { tokenBudget: 8000 });
    expect(send.mock.calls[0]?.[0]).toBe("/api/chat/conversations/c1");
    expect(send.mock.calls[0]?.[1]?.method).toBe("PATCH");
    expect(sentBody()).toEqual({ tokenBudget: 8000 });
    expect(
      mergeConversationRow([{ id: "c1", title: "One" }], "c1", conversation!),
    ).toEqual([{ id: "c1", title: "One", tokenBudget: 8000 }]);
  });

  it("leaves the next patch working after one is refused", async () => {
    // The swallow itself is the surface's serialized chain; what this pins is
    // that the door keeps no state a refusal could poison — the second patch
    // still reaches it, and still answers.
    send.mockRejectedValueOnce(new Error("Request failed (500)"));
    await expect(patchConversation("c1", { tokenBudget: 8000 })).rejects.toThrow(
      "Request failed (500)",
    );
    send.mockResolvedValueOnce({ conversation: { id: "c1", title: "One", historyDepth: 3 } });
    await expect(patchConversation("c1", { historyDepth: 3 })).resolves.toEqual({
      id: "c1",
      title: "One",
      historyDepth: 3,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });
});

describe("persisting a settled turn", () => {
  const FRAMES: CanvasMessage[] = [
    { id: "u", role: "user", content: "What happened?" },
    {
      id: "a",
      role: "assistant",
      content: "This did [1].",
      citations: [{ n: 1, path: "wiki/a.md", title: "A", type: "page" }],
      thinking: "",
      toolCalls: [],
      outputs: [],
    },
  ];

  it("posts the flag and the frames, omitting what is empty", async () => {
    send.mockResolvedValue({ conversation: { id: "c1", title: "One", messages: [] } });
    await persistConversationMessages("c1", FRAMES, { replaceLastTurn: true });
    expect(send.mock.calls[0]?.[0]).toBe("/api/chat/conversations/c1/messages");
    expect(send.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sentBody()).toEqual({
      persist: true,
      replaceLastTurn: true,
      messages: [
        { role: "user", content: "What happened?", citations: [] },
        {
          role: "assistant",
          content: "This did [1].",
          citations: [{ n: 1, path: "wiki/a.md", title: "A", type: "page" }],
        },
      ],
    });
  });

  it("carries the tool rows and outputs a turn actually produced", () => {
    expect(
      messageWirePayload([
        {
          id: "a",
          role: "assistant",
          content: "Done.",
          thinking: "I looked.",
          toolCalls: [{ id: "t1", tool: "wiki_search", detail: "3 matches" }],
          outputs: [{ path: "recaps/a.md", name: "a.md", bytes: 4 }],
        },
      ]),
    ).toEqual([
      {
        role: "assistant",
        content: "Done.",
        citations: [],
        thinking: "I looked.",
        toolCalls: [{ id: "t1", tool: "wiki_search", detail: "3 matches" }],
        outputs: [{ path: "recaps/a.md", name: "a.md", bytes: 4 }],
      },
    ]);
  });

  it("defaults the replace flag to false", async () => {
    send.mockResolvedValue({ conversation: { id: "c1", title: "One" } });
    await persistConversationMessages("c1", FRAMES);
    expect((sentBody() as { replaceLastTurn: boolean }).replaceLastTurn).toBe(false);
  });

  it("throws when the store answered with no conversation", async () => {
    send.mockResolvedValue({});
    await expect(persistConversationMessages("c1", FRAMES)).rejects.toThrow(
      CONVERSATION_PERSIST_FAILED_COPY,
    );
  });
});

describe("saving an answer to the wiki", () => {
  it("posts the message id at the save door", async () => {
    send.mockResolvedValue({});
    await saveAnswerToWiki("c1", "a1");
    expect(send.mock.calls[0]?.[0]).toBe("/api/chat/conversations/c1/save");
    expect(send.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(sentBody()).toEqual({ messageId: "a1" });
  });

  it("lets the door's own sentence reach the caller", async () => {
    send.mockRejectedValue(new Error("Chat is read-only for this wiki."));
    await expect(saveAnswerToWiki("c1", "a1")).rejects.toThrow(
      "Chat is read-only for this wiki.",
    );
  });
});

describe("the list rules", () => {
  it("merges a returned row rather than replacing it", () => {
    expect(
      mergeConversationRow(
        [
          { id: "c1", title: "One", name: "Renamed" },
          { id: "c2", title: "Two" },
        ],
        "c1",
        { messages: [{ id: "u", role: "user", content: "hi" }] },
      ),
    ).toEqual([
      {
        id: "c1",
        title: "One",
        name: "Renamed",
        messages: [{ id: "u", role: "user", content: "hi" }],
      },
      { id: "c2", title: "Two" },
    ]);
  });

  it("drops only the optimistic bubbles", () => {
    expect(
      dropOptimisticMessages([
        { id: "u1", role: "user", content: "kept" },
        { id: "pending-123", role: "user", content: "withdrawn" },
      ]),
    ).toEqual([{ id: "u1", role: "user", content: "kept" }]);
  });

  it("finds the most recent assistant message, or none at all", () => {
    expect(
      lastAssistantMessage([
        { id: "a1", role: "assistant", content: "first" },
        { id: "u1", role: "user", content: "then" },
        { id: "a2", role: "assistant", content: "last" },
      ])?.id,
    ).toBe("a2");
    expect(lastAssistantMessage([{ id: "u1", role: "user", content: "q" }])).toBeNull();
    expect(lastAssistantMessage([])).toBeNull();
  });

  it("groups citations under the heading their type gives them", () => {
    const grouped = groupCitationsByType([
      { n: 1, path: "wiki/a.md", title: "A", type: "page" },
      { n: 2, path: "raw/b.pdf", title: "B", type: "source" },
      { n: 3, path: "wiki/c.md", title: "C", type: "page" },
    ]);
    expect([...grouped.keys()]).toEqual(["page", "source"]);
    expect(grouped.get("page")?.map((row) => row.n)).toEqual([1, 3]);
    expect(grouped.get("source")?.map((row) => row.n)).toEqual([2]);
  });
});

describe("what Regenerate re-sends", () => {
  it("takes the user leg of a user-then-assistant tail, with the history before it", () => {
    expect(
      regenerateTarget([
        { id: "u0", role: "user", content: "earlier" },
        { id: "a0", role: "assistant", content: "answered" },
        { id: "u1", role: "user", content: "Recap the call." },
        { id: "a1", role: "assistant", content: "Here." },
      ]),
    ).toEqual({
      userText: "Recap the call.",
      history: [
        { id: "u0", role: "user", content: "earlier" },
        { id: "a0", role: "assistant", content: "answered" },
      ],
    });
  });

  it("returns nothing for any other tail", () => {
    expect(regenerateTarget([])).toBeNull();
    expect(regenerateTarget([{ id: "u1", role: "user", content: "q" }])).toBeNull();
    // An unanswered question: the last turn is not one that can be replaced.
    expect(
      regenerateTarget([
        { id: "a1", role: "assistant", content: "answered" },
        { id: "u1", role: "user", content: "and then?" },
      ]),
    ).toBeNull();
    // Two assistant messages: there is no question to re-ask.
    expect(
      regenerateTarget([
        { id: "a0", role: "assistant", content: "one" },
        { id: "a1", role: "assistant", content: "two" },
      ]),
    ).toBeNull();
  });
});
