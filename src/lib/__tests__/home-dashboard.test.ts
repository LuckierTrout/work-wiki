import { describe, expect, it } from "vitest";
import type { ActionItem } from "../action-items";
import type { ChatConversation } from "../chat";
import { buildHomeDashboardSnapshot } from "../home-dashboard";
import type { IndexEntry } from "../types";

function page(overrides: Partial<IndexEntry> & Pick<IndexEntry, "slug">): IndexEntry {
  return {
    title: overrides.slug,
    summary: "Summary",
    ...overrides,
  };
}

function task(overrides: Partial<ActionItem> & Pick<ActionItem, "id">): ActionItem {
  return {
    title: overrides.id,
    priority: "medium",
    status: "inbox",
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

function conversation(
  overrides: Partial<ChatConversation> & Pick<ChatConversation, "id">,
): ChatConversation {
  return {
    title: overrides.id,
    messages: [],
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("buildHomeDashboardSnapshot", () => {
  it("builds recent documents and totals without surfacing agent runtime pages", () => {
    const pages = [
      page({ slug: "older", updated: "2026-08-01", sourceCount: 2 }),
      page({ slug: "newer", updated: "2026-08-05", sourceCount: 3 }),
      page({ slug: "agent-memory", type: "agent-knowledge", sourceCount: 99 }),
    ];

    const result = buildHomeDashboardSnapshot(pages, [], []);

    expect(result.recentDocuments.map((item) => item.slug)).toEqual([
      "newer",
      "older",
    ]);
    expect(result.totals.documents).toBe(2);
    expect(result.totals.sources).toBe(5);
  });

  it("shows only open tasks and orders dated work before undated work", () => {
    const tasks = [
      task({ id: "undated", priority: "high" }),
      task({ id: "later", dueDate: "2026-09-15", priority: "high" }),
      task({ id: "sooner", dueDate: "2026-08-12", priority: "low" }),
      task({ id: "done", status: "done", dueDate: "2026-08-01" }),
      task({ id: "dismissed", status: "dismissed" }),
    ];

    const result = buildHomeDashboardSnapshot([], tasks, []);

    expect(result.openTasks.map((item) => item.id)).toEqual([
      "sooner",
      "later",
      "undated",
    ]);
    expect(result.totals.openTasks).toBe(3);
  });

  it("aggregates topics case-insensitively and keeps recent chats first", () => {
    const pages = [
      page({ slug: "one", tags: ["Measurement", "Media"] }),
      page({ slug: "two", tags: ["measurement", "Strategy"] }),
    ];
    const chats = [
      conversation({ id: "old", updatedAt: "2026-08-02T00:00:00.000Z" }),
      conversation({ id: "new", updatedAt: "2026-08-06T00:00:00.000Z" }),
    ];

    const result = buildHomeDashboardSnapshot(pages, [], chats);

    expect(result.topics[0]).toEqual({ label: "Measurement", count: 2 });
    expect(result.recentConversations.map((item) => item.id)).toEqual([
      "new",
      "old",
    ]);
    expect(result.totals.conversations).toBe(2);
  });
});
