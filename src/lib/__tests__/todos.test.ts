import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";
import { setSourceMeeting, isSourceMeeting, meetingExtractTarget } from "../source-meeting";
import {
  collapseTodoTitles,
  decideTodos,
  deleteTodo,
  enqueueTodoCandidates,
  itemMatchesSource,
  listTodos,
  markTodosSourceMissing,
  patchTodo,
  pendingTodoCount,
  recordTodoExtractError,
} from "../todos";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalReadOnly: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "todos-"));
  originalDataDir = process.env.DATA_DIR;
  originalReadOnly = process.env.YOPEDIA_READONLY;
  process.env.DATA_DIR = tmpDir;
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("todo candidates", () => {
  it("replaces pending for a Source and keeps decided rows", async () => {
    const first = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      pageSlug: "standup",
      candidates: [
        { title: "Send recap", rationale: "Asked at close." },
        { title: "Book room", rationale: "For Friday." },
      ],
    });
    expect(first).toHaveLength(2);
    await decideTodos("alice", [first[0]!.id], "approve", "alice");
    const second = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      pageSlug: "standup",
      candidates: [
        { title: "Send recap", rationale: "Still implied." },
        { title: "Ping design", rationale: "New ask." },
      ],
    });
    expect(second.map((item) => item.title)).toEqual(["Ping design"]);
    const candidates = await listTodos("alice", "candidates");
    expect(candidates.map((item) => item.title)).toEqual(["Ping design"]);
    const open = await listTodos("alice", "open");
    expect(open).toHaveLength(1);
    expect(open[0]?.title).toBe("Send recap");
    expect(open[0]?.pageSlug).toBe("standup");
    expect(open[0]?.sourceId).toBe("raw/sources/meet/abc.md");
  });

  it("stores none-found by clearing pending and leaving the list empty", async () => {
    await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      candidates: [{ title: "Old", rationale: "Prior extract." }],
    });
    const created = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      candidates: [],
    });
    expect(created).toEqual([]);
    expect(await listTodos("alice", "candidates")).toEqual([]);
    expect(await pendingTodoCount("alice")).toBe(0);
  });

  it("collapses duplicate titles in one extract", () => {
    expect(
      collapseTodoTitles([
        { title: "Send recap", rationale: "A" },
        { title: " send  recap ", rationale: "B" },
        { title: "Book room", rationale: "C" },
      ]).map((item) => item.title),
    ).toEqual(["Send recap", "Book room"]);
  });

  it("matches cascade identity keys for the same Source", () => {
    const item = { sourceId: "raw/sources/meet/abc.md" };
    expect(itemMatchesSource(item, "meet/abc.md")).toBe(true);
    expect(itemMatchesSource(item, "raw/sources/meet/abc.md")).toBe(true);
    expect(itemMatchesSource(item, "raw/sources/other/x.md")).toBe(false);
  });
});

describe("HITL decisions", () => {
  it("stores decision, timestamp, and actor; rejected never appear in Open", async () => {
    const [keep, drop] = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      candidates: [
        { title: "Keep", rationale: "Yes." },
        { title: "Drop", rationale: "No." },
      ],
    });
    const approved = await decideTodos("alice", [keep!.id], "approve", "alice");
    expect(approved[0]?.decision).toBe("approve");
    expect(approved[0]?.actor).toBe("alice");
    expect(approved[0]?.decidedAt).toMatch(/T/);
    const rejected = await decideTodos("alice", [drop!.id], "reject", "alice");
    expect(rejected[0]?.decision).toBe("reject");
    expect(rejected[0]?.actor).toBe("alice");
    const open = await listTodos("alice", "open");
    expect(open.map((item) => item.title)).toEqual(["Keep"]);
    expect(open.every((item) => item.decision !== "reject")).toBe(true);
    expect((await listTodos("alice", "done")).some((item) => item.decision === "reject")).toBe(true);
  });

  it("edits title and due after approve without breaking links, and delete is owner-only persist", async () => {
    const [item] = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      pageSlug: "standup",
      candidates: [{ title: "Send recap", rationale: "Asked.", due: "2026-09-01" }],
    });
    await decideTodos("alice", [item!.id], "approve", "alice");
    const updated = await patchTodo("alice", item!.id, {
      title: "Send the recap",
      due: null,
    });
    expect(updated?.title).toBe("Send the recap");
    expect(updated?.due).toBeUndefined();
    expect(updated?.sourceId).toBe("raw/sources/meet/abc.md");
    expect(updated?.pageSlug).toBe("standup");
    const done = await patchTodo("alice", item!.id, { status: "done" });
    expect(done?.status).toBe("done");
    expect(await listTodos("alice", "done")).toHaveLength(1);
    expect(await listTodos("alice", "open")).toEqual([]);
    expect(await deleteTodo("alice", item!.id)).toBe(true);
    expect(await listTodos("alice")).toEqual([]);
  });

  it("marks source-missing on cascade identity without deleting the Todo", async () => {
    const [item] = await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      candidates: [{ title: "Follow up", rationale: "Said so." }],
    });
    expect(await markTodosSourceMissing("alice", "meet/abc.md")).toBe(1);
    const kept = await listTodos("alice");
    expect(kept[0]?.id).toBe(item!.id);
    expect(kept[0]?.sourceMissing).toBe(true);
  });
});

describe("mark as meeting", () => {
  it("persists a path-keyed flag read at extract-target time", async () => {
    expect(await isSourceMeeting("alice", "raw/sources/notes/a.md")).toBe(false);
    await setSourceMeeting("alice", "raw/sources/notes/a.md", true);
    expect(await isSourceMeeting("alice", "notes/a.md")).toBe(true);
    const target = await meetingExtractTarget("alice", {
      slug: "notes",
      sourcePath: "raw/sources/notes/a.md",
    });
    expect(target).toEqual({ sourcePath: "raw/sources/notes/a.md" });
    expect(
      await meetingExtractTarget("alice", {
        origin: "plaud",
        slug: "meet",
        sourcePath: "raw/sources/meet/x.md",
      }),
    ).toEqual({ sourcePath: "raw/sources/meet/x.md" });
  });
});

describe("extract error persist", () => {
  it("records a retryable extract failure on the store", async () => {
    await recordTodoExtractError("alice", {
      message: "LLM timeout",
      slug: "meet",
      sourcePath: "raw/sources/meet/abc.md",
    });
    const { getTodoExtractError } = await import("../todos");
    const error = await getTodoExtractError("alice");
    expect(error?.message).toBe("LLM timeout");
    expect(error?.slug).toBe("meet");
    await enqueueTodoCandidates("alice", {
      wikiId: "wiki-1",
      sourceId: "raw/sources/meet/abc.md",
      candidates: [],
    });
    expect(await getTodoExtractError("alice")).toBeUndefined();
  });
});
