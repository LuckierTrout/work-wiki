import type { ActionItem } from "./action-items";
import type { ChatConversation } from "./chat";
import { isAgentScopedType } from "./page-types";
import type { IndexEntry } from "./types";

export interface DashboardTopic {
  label: string;
  count: number;
}

export interface HomeDashboardSnapshot {
  recentDocuments: IndexEntry[];
  openTasks: ActionItem[];
  recentConversations: ChatConversation[];
  topics: DashboardTopic[];
  totals: {
    documents: number;
    sources: number;
    openTasks: number;
    conversations: number;
  };
}

function timestamp(value: string | undefined): number {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : Number.NEGATIVE_INFINITY;
}

function dueTimestamp(item: ActionItem): number {
  if (!item.dueDate) return Number.POSITIVE_INFINITY;
  const parsed = Date.parse(item.dueDate);
  return Number.isFinite(parsed) ? parsed : Number.POSITIVE_INFINITY;
}

/**
 * Build the signed-in homepage's small, intentionally bounded working set.
 * Pure so ordering and privacy-safe filtering can be regression-tested without
 * a request context or storage provider.
 */
export function buildHomeDashboardSnapshot(
  readablePages: readonly IndexEntry[],
  actionItems: readonly ActionItem[],
  conversations: readonly ChatConversation[],
): HomeDashboardSnapshot {
  // Agent identity/runtime pages are useful in their dedicated administration
  // screens, but they are not documents the owner is likely to resume reading.
  const documents = readablePages.filter(
    (page) => !isAgentScopedType(page.type),
  );

  const openTasks = actionItems
    .filter((item) => item.status === "inbox" || item.status === "accepted")
    .sort((a, b) => {
      const dueA = dueTimestamp(a);
      const dueB = dueTimestamp(b);
      if (dueA !== dueB) {
        return dueA < dueB ? -1 : 1;
      }
      const priority = { high: 0, medium: 1, low: 2 } as const;
      const priorityDifference = priority[a.priority] - priority[b.priority];
      if (priorityDifference !== 0) return priorityDifference;
      return timestamp(b.updatedAt) - timestamp(a.updatedAt);
    });

  const topicMap = new Map<string, DashboardTopic>();
  for (const page of documents) {
    for (const rawTag of page.tags ?? []) {
      const label = rawTag.trim();
      if (!label) continue;
      const key = label.toLocaleLowerCase();
      const existing = topicMap.get(key);
      if (existing) existing.count += 1;
      else topicMap.set(key, { label, count: 1 });
    }
  }

  return {
    recentDocuments: [...documents]
      .sort((a, b) => timestamp(b.updated) - timestamp(a.updated))
      .slice(0, 6),
    openTasks: openTasks.slice(0, 5),
    recentConversations: [...conversations]
      .sort((a, b) => timestamp(b.updatedAt) - timestamp(a.updatedAt))
      .slice(0, 4),
    topics: [...topicMap.values()]
      .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
      .slice(0, 8),
    totals: {
      documents: documents.length,
      sources: documents.reduce((total, page) => total + (page.sourceCount ?? 0), 0),
      openTasks: openTasks.length,
      conversations: conversations.length,
    },
  };
}
