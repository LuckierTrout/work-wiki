import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { CHAT_COVERAGE_MISSING_COPY } from "@/lib/workbench-modes";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("@/lib/workbench-request", () => ({ send }));

import { ChatCanvas } from "@/components/workbench/ChatCanvas";
import { SearchCanvas } from "@/components/workbench/SearchCanvas";

const CONV = {
  id: "c1",
  title: "Evidence review",
  name: "Evidence review",
  retrievalMode: "wiki" as const,
  tokenBudget: 32_000,
  historyDepth: 10,
  messages: [
    { id: "u1", role: "user" as const, content: "What is alpha?" },
    {
      id: "a1",
      role: "assistant" as const,
      content: "Alpha [1].",
      thinking: "I looked at alpha.\nThen I cited it.",
      citations: [{ n: 1, path: "wiki/alpha.md", title: "Alpha", type: "page" }],
    },
  ],
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  send.mockImplementation(async (url: string) => {
    if (url === "/api/chat/conversations") {
      return { conversations: [CONV] };
    }
    if (url.includes("/conversations/c1") && !url.includes("/messages") && !url.includes("/save")) {
      return { conversation: CONV };
    }
    return {};
  });
});

describe("Chat/Search send() is a parsed-body helper", () => {
  it("Search posts through send(url, init) and uses the returned body", async () => {
    send.mockResolvedValueOnce({ hits: [], vectorPhase: { status: "off" } });
    render(<SearchCanvas wikiId="current" onDockPreview={vi.fn()} />);
    fireEvent.change(screen.getByLabelText("Search query"), {
      target: { value: "alpha" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    await waitFor(() => {
      expect(send).toHaveBeenCalledWith(
        "/api/v1/projects/current/search",
        expect.objectContaining({
          method: "POST",
          body: JSON.stringify({ query: "alpha", topK: 10 }),
        }),
      );
    });
    expect(await screen.findByText("No matching Pages or Sources.")).toBeTruthy();
    const body = await send.mock.results[0]?.value;
    expect(body).toEqual({ hits: [], vectorPhase: { status: "off" } });
    expect(body).not.toHaveProperty("json");
  });
});

describe("Chat read-only refuses writes", () => {
  it("disables New Chat, delete, rename, send, regenerate, save, and settings", async () => {
    render(
      <ChatCanvas wikiId="current" readOnly onDockPreview={vi.fn()} />,
    );
    await screen.findByRole("button", { name: "Evidence review" });

    expect((screen.getByRole("button", { name: "New Chat" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Delete Evidence review" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Regenerate" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Save to Wiki" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Send" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText("Smart retrieval") as HTMLSelectElement).disabled).toBe(true);
    expect(
      (document.querySelector(".wb-chat-field input[type='range']") as HTMLInputElement).disabled,
    ).toBe(true);
    expect(
      (document.querySelector(".wb-chat-field input[type='number']") as HTMLInputElement).disabled,
    ).toBe(true);
    expect((screen.getByLabelText("Message") as HTMLTextAreaElement).disabled).toBe(true);

    fireEvent.doubleClick(screen.getByRole("button", { name: "Evidence review" }));
    expect(screen.queryByLabelText("Conversation name")).toBeNull();

    send.mockClear();
    fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
    fireEvent.click(screen.getByRole("button", { name: "Delete Evidence review" }));
    fireEvent.click(screen.getByRole("button", { name: "Regenerate" }));
    fireEvent.click(screen.getByRole("button", { name: "Save to Wiki" }));
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("coverage copy is citation-free", () => {
  it("does not carry a fake [1]", () => {
    expect(CHAT_COVERAGE_MISSING_COPY).not.toMatch(/\[\d+\]/);
  });
});

describe("citation and Search Preview docks", () => {
  it("docks Preview from an in-answer [n] and a Search hit", async () => {
    const onDock = vi.fn();
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={onDock} />);
    await screen.findByRole("button", { name: "Evidence review" });
    fireEvent.click(screen.getAllByRole("button", { name: "[1]" })[0]!);
    expect(onDock).toHaveBeenCalledWith({ kind: "page", slug: "alpha" });

    send.mockResolvedValueOnce({
      hits: [
        {
          path: "raw/sources/meet/cafe01.md",
          title: "Meet",
          snippet: "transcript",
          score: 2,
        },
      ],
    });
    const searchDock = vi.fn();
    render(<SearchCanvas wikiId="current" onDockPreview={searchDock} />);
    fireEvent.change(screen.getByLabelText("Search query"), {
      target: { value: "alpha" },
    });
    fireEvent.keyDown(screen.getByLabelText("Search query"), { key: "Enter" });
    fireEvent.click(await screen.findByRole("button", { name: /Meet/ }));
    expect(searchDock).toHaveBeenCalledWith({
      kind: "file",
      path: "raw/sources/meet/cafe01.md",
    });
  });

  it("restores a stored Thinking block after reload", async () => {
    render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
    const summary = await screen.findByText("Thinking");
    fireEvent.click(summary);
    expect(screen.getByText(/I looked at alpha/)).toBeTruthy();
  });
});
