/**
 * Chat's empty sentence follows whether a conversation is open.
 *
 * "Start a new conversation. Click New Chat to begin." is the mode's own empty
 * state — true while nothing is selected. It stayed on screen AFTER the owner
 * clicked New Chat, over a conversation that now existed and was open, telling
 * them to do the thing they had just done. An open conversation with no turns
 * yet is a different fact, and gets a sentence that points at the composer.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import {
  CHAT_CONVERSATION_EMPTY_COPY,
  CHAT_SIDECAR_UP_COPY,
} from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ChatCanvas } from "@/components/workbench/ChatCanvas";

const EMPTY_CONV = {
  id: "c1",
  title: "New conversation",
  name: "New conversation",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/chat/conversations") {
      return { conversations: [EMPTY_CONV] };
    }
    if (url.includes("/conversations/c1") && !url.includes("/messages") && !url.includes("/save")) {
      return { conversation: EMPTY_CONV };
    }
    return {};
  });
});

describe("the Chat empty sentence", () => {
  it("tells the owner to click New Chat only while no conversation is open", async () => {
    // The hook opens the first conversation it lists, so "nothing open" is an
    // EMPTY list — the state the very first visit lands on.
    send.mockImplementation(async (url: string) =>
      url === "/api/chat/conversations" ? { conversations: [] } : {},
    );
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    expect(await screen.findByText(CHAT_SIDECAR_UP_COPY)).toBeTruthy();
    expect(screen.queryByText(CHAT_CONVERSATION_EMPTY_COPY)).toBeNull();
  });

  it("points at the composer once an empty conversation is open", async () => {
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    fireEvent.click(await screen.findByText("New conversation"));
    expect(await screen.findByText(CHAT_CONVERSATION_EMPTY_COPY)).toBeTruthy();
    // The instruction the owner has already followed must not be on screen.
    expect(screen.queryByText(CHAT_SIDECAR_UP_COPY)).toBeNull();
  });
});
