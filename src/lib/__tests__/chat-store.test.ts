import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createChatConversation,
  deleteChatConversation,
  getChatConversation,
  listChatConversations,
  updateChatConversation,
} from "../chat";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "chat-store-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("owner chat conversations", () => {
  it("creates, updates, lists, and isolates conversations", async () => {
    const conversation = await createChatConversation("alice", {
      title: "Launch plan",
      scope: "mine",
    });
    expect(await getChatConversation("bob", conversation.id)).toBeNull();
    expect(await listChatConversations("alice")).toEqual([
      expect.objectContaining({ id: conversation.id, title: "Launch plan", messages: [] }),
    ]);
    const updated = await updateChatConversation("alice", conversation.id, {
      title: "Launch checklist",
      scope: null,
    });
    expect(updated).toMatchObject({ title: "Launch checklist" });
    expect(updated?.scope).toBeUndefined();
    expect(await deleteChatConversation("alice", conversation.id)).toBe(true);
    expect(await getChatConversation("alice", conversation.id)).toBeNull();
  });
});
