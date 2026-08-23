/**
 * Client-safe Chat / Search contracts for Epic 3.
 *
 * Kept free of storage, LLM, and Node APIs so Workbench canvases can import
 * the same types the kernel persist layer writes.
 */

export const CHAT_TOKEN_BUDGET_MIN = 4_000;
export const CHAT_TOKEN_BUDGET_MAX = 1_000_000;
export const CHAT_TOKEN_BUDGET_DEFAULT = 32_000;
export const CHAT_HISTORY_DEPTH_DEFAULT = 10;

export const CHAT_PAGE_BUDGET_RATIO = 0.6;
export const CHAT_HISTORY_BUDGET_RATIO = 0.2;
export const CHAT_INDEX_BUDGET_RATIO = 0.05;
export const CHAT_SYSTEM_BUDGET_RATIO = 0.15;

/** UUID (any version) or the reserved `current` wiki id. */
const WIKI_UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ChatCitation {
  n: number;
  path: string;
  title: string;
  type: string;
}

export interface ChatExportMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations: ChatCitation[];
  thinking?: string;
  createdAt: string;
}

export interface ChatExportRecord {
  id: string;
  name: string;
  messages: ChatExportMessage[];
}

export interface SearchHit {
  path: string;
  title: string;
  snippet: string;
  score: number;
}

export function isFilesystemWikiId(value: string): boolean {
  return value.includes("/") || value.includes("\\") || value.includes("..");
}

export function isSidecarWikiId(value: string): boolean {
  return value === "current" || WIKI_UUID_RE.test(value);
}

export function clampTokenBudget(value: number): number {
  if (!Number.isFinite(value)) return CHAT_TOKEN_BUDGET_DEFAULT;
  return Math.min(
    CHAT_TOKEN_BUDGET_MAX,
    Math.max(CHAT_TOKEN_BUDGET_MIN, Math.round(value)),
  );
}

export function clampHistoryDepth(value: number): number {
  if (!Number.isFinite(value)) return CHAT_HISTORY_DEPTH_DEFAULT;
  return Math.min(80, Math.max(1, Math.round(value)));
}

export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.max(1, Math.ceil(text.length / 4));
}
