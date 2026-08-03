import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  deleteActionItem,
  listActionItems,
  proposeActionItems,
  updateActionItem,
} from "../action-items";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-items-"));
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

describe("owner action items", () => {
  it("stores proposals privately and deduplicates title plus source", async () => {
    const [created] = await proposeActionItems("alice", [{
      title: "Send the report",
      sourceSlug: "meeting-notes",
      priority: "high",
      confidence: 0.93,
    }]);
    expect(created).toMatchObject({ status: "inbox", priority: "high" });
    expect(await proposeActionItems("alice", [{
      title: "  send   the report ",
      sourceSlug: "meeting-notes",
    }])).toEqual([]);
    expect(await listActionItems("bob")).toEqual([]);
    expect(await listActionItems("alice")).toHaveLength(1);
  });

  it("supports approval, completion, filtering, and deletion", async () => {
    const [created] = await proposeActionItems("alice", [{ title: "Review draft" }]);
    await updateActionItem("alice", created.id, { status: "accepted" });
    expect(await listActionItems("alice", "accepted")).toHaveLength(1);
    const done = await updateActionItem("alice", created.id, { status: "done" });
    expect(done?.completedAt).toBeTruthy();
    expect(await deleteActionItem("alice", created.id)).toBe(true);
    expect(await listActionItems("alice")).toEqual([]);
  });
});
