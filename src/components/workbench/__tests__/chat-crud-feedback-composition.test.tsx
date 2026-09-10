import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const session = vi.hoisted(() => ({ signedIn: true }));
vi.mock("@/lib/auth", () => ({
  getPrincipal: async () => session.signedIn ? { id: "user_alice", handle: "alice" } : null,
  getServicePrincipal: () => null,
}));

import { ChatCanvas } from "../ChatCanvas";
import * as collection from "@/app/api/chat/conversations/route";
import * as item from "@/app/api/chat/conversations/[id]/route";
import { createChatConversation, getChatConversation, listChatConversations } from "@/lib/chat";
import { _resetStorage } from "@/lib/storage";
import { _resetLocks } from "@/lib/lock";
import { clearLoopbackDoorToken } from "@/lib/loopback-client";
import { SKILL_SCAN_URL } from "@/lib/chat-agent";

let directory: string;
let conversationId: string;
let loaded: boolean;
let refuseFallback = false;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "chat-feedback-"));
  vi.stubEnv("DATA_DIR", directory);
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "alice");
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_alice");
  vi.stubEnv("YOPEDIA_READ_ONLY", "");
  _resetStorage(); _resetLocks(); clearLoopbackDoorToken();
  session.signedIn = true; loaded = false; refuseFallback = false;
  conversationId = (await createChatConversation("alice", { name: "Alpha" })).id;
  // Only transport and the authenticated session are supplied. The mounted
  // component, request helper, routes, owner gate and filesystem store run real.
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url === SKILL_SCAN_URL) return Response.json({ skills: [] });
    if (url === "/api/v1/loopback-settings") return Response.json({ token: "fixture-token" });
    // jsdom's AbortSignal belongs to a different realm from Node's Request.
    // This in-process route bridge does not simulate transport cancellation.
    const request = new Request(new URL(url, "http://localhost"), { ...init, signal: undefined });
    if (url === "/api/chat/conversations") {
      return request.method === "POST" ? collection.POST(request) : collection.GET();
    }
    const match = /^\/api\/chat\/conversations\/([^/?]+)$/.exec(url);
    if (match) {
      const context = { params: Promise.resolve({ id: match[1] }) };
      if (request.method === "DELETE") return item.DELETE(request, context);
      if (request.method === "PATCH") return item.PATCH(request, context);
      if (refuseFallback && match[1] !== conversationId) session.signedIn = false;
      const response = await item.GET(request, context);
      if (match[1] === conversationId) loaded = true;
      return response;
    }
    throw new Error(`Unexpected fixture request: ${url}`);
  }));
});

afterEach(async () => {
  cleanup(); vi.unstubAllGlobals(); vi.unstubAllEnvs();
  _resetStorage(); _resetLocks(); clearLoopbackDoorToken();
  await rm(directory, { recursive: true, force: true });
});

async function mount() {
  render(<ChatCanvas wikiId="current" readOnly={false} onDockPreview={vi.fn()} />);
  await screen.findByRole("button", { name: "Alpha" });
  fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
  await waitFor(() => expect(loaded).toBe(true));
}

function rename(name: string) {
  fireEvent.doubleClick(screen.getByRole("button", { name: "Alpha" }));
  const input = screen.getByRole("textbox", { name: "Conversation name" });
  fireEvent.change(input, { target: { value: name } });
  fireEvent.keyDown(input, { key: "Enter" });
}

describe("Chat CRUD refusal feedback through real routes and storage", () => {
  it.each(["create", "delete", "rename"])("shows a refused %s, preserves the conversation and clears the error on retry", async (action) => {
    await mount();
    const composer = screen.getByRole("textbox");
    fireEvent.change(composer, { target: { value: "Unsaved draft" } });
    const perform = () => {
      if (action === "create") fireEvent.click(screen.getByRole("button", { name: "New Chat" }));
      else if (action === "delete") fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
      else rename("Renamed");
    };
    session.signedIn = false;
    perform();
    await screen.findByText("Sign in required.");
    expect(screen.getByRole("button", { name: "Alpha" })).toBeTruthy();
    expect(screen.getByRole("textbox")).toHaveProperty("value", "Unsaved draft");
    expect((await getChatConversation("alice", conversationId))?.title).toBe("Alpha");
    expect(await listChatConversations("alice")).toHaveLength(1);
    session.signedIn = true;
    perform();
    await waitFor(async () => {
      if (action === "create") expect(await listChatConversations("alice")).toHaveLength(2);
      else if (action === "delete") expect(await getChatConversation("alice", conversationId)).toBeNull();
      else expect((await getChatConversation("alice", conversationId))?.title).toBe("Renamed");
      expect(screen.queryByText("Sign in required.")).toBeNull();
    });
  });

  it("reports a refused fallback read after a successful delete without restoring the deleted row", async () => {
    await createChatConversation("alice", { name: "Beta" });
    await mount();
    // Select Alpha explicitly: list order is based on timestamps.
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    refuseFallback = true;
    fireEvent.click(screen.getByRole("button", { name: "Delete Alpha" }));
    await screen.findByText("Sign in required.");
    expect(await getChatConversation("alice", conversationId)).toBeNull();
    expect(screen.queryByRole("button", { name: "Alpha" })).toBeNull();
    expect(screen.getByRole("button", { name: "Beta" })).toBeTruthy();
  });
});
