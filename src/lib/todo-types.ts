/**
 * Client-safe Todo types and path helpers. The kernel store stays in `todos.ts`.
 */

export type TodoDecision = "approve" | "reject";
export type TodoStatus = "open" | "done";
export type TodoTab = "candidates" | "open" | "done";

export interface TodoItem {
  id: string;
  wikiId: string;
  sourceId: string;
  pageSlug?: string;
  title: string;
  rationale: string;
  due?: string;
  speaker?: string;
  context?: string;
  decision?: TodoDecision;
  decidedAt?: string;
  actor?: string;
  sourceMissing?: boolean;
  status?: TodoStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TodoExtractError {
  message: string;
  slug: string;
  sourcePath?: string;
  at: string;
}

export function todoMeetingPath(
  item: Pick<TodoItem, "pageSlug" | "sourceId">,
): string {
  if (item.pageSlug?.trim()) return `wiki/${item.pageSlug.trim()}.md`;
  return item.sourceId;
}
