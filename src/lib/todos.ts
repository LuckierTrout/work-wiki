/**
 * Kernel Todos SoR — meeting Candidates and approved Todos.
 *
 * Persisted at `tenants/{t}/todos.json` via lock + CAS (same shape as Chat).
 * A Candidate is not a Todo until approve. Nothing auto-promotes.
 */

import { bumpDataVersion } from "./data-version";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { sourceIdentityKeys, workbenchSourcePath } from "./source-delete";
import { getStorage } from "./storage";
import {
  type TodoDecision,
  type TodoExtractError,
  type TodoItem,
  type TodoStatus,
  type TodoTab,
  todoMeetingPath,
} from "./todo-types";
import { tenantForOwner, validateTenant } from "./wiki";

export type { TodoDecision, TodoExtractError, TodoItem, TodoStatus, TodoTab };
export { todoMeetingPath };

export interface TodoCandidateProposal {
  title: string;
  rationale: string;
  due?: string;
  speaker?: string;
  context?: string;
}

export interface TodoStore {
  items: TodoItem[];
  extractError?: TodoExtractError;
}

const MAX_TODOS = 1_000;
const CAS_ATTEMPTS = 4;

function todosPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/todos.json`;
}

function lockKey(owner: string): string {
  return `todos:${tenantForOwner(owner)}`;
}

export function canonicalSourceId(path: string): string {
  return workbenchSourcePath(path) ?? path.trim();
}

export function normalizeTodoTitle(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function sourceLookupKeys(path: string): string[] {
  const keys = sourceIdentityKeys(path);
  if (keys.length > 0) return keys;
  const prefixed = workbenchSourcePath(`raw/sources/${path.replace(/^\/+/, "")}`);
  if (prefixed) return sourceIdentityKeys(prefixed);
  return path.trim() ? [path.trim()] : [];
}

export function itemMatchesSource(item: Pick<TodoItem, "sourceId">, path: string): boolean {
  const pathKeys = new Set(sourceLookupKeys(path));
  const itemKeys = sourceLookupKeys(item.sourceId);
  if (pathKeys.size === 0) return item.sourceId === path;
  return itemKeys.some((key) => pathKeys.has(key)) || pathKeys.has(item.sourceId);
}

export function isPendingCandidate(item: TodoItem): boolean {
  return item.decision === undefined;
}

export function isOpenTodo(item: TodoItem): boolean {
  return item.decision === "approve" && item.status !== "done";
}

export function isDoneTodo(item: TodoItem): boolean {
  return item.decision === "approve" && item.status === "done";
}

export function todoTabOf(item: TodoItem): TodoTab | null {
  if (isPendingCandidate(item)) return "candidates";
  if (isOpenTodo(item)) return "open";
  if (isDoneTodo(item) || item.decision === "reject") return "done";
  return null;
}

function emptyStore(): TodoStore {
  return { items: [] };
}

function parseStore(raw: string): TodoStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyStore();
  }
  if (Array.isArray(parsed)) {
    return { items: parsed.filter(isTodoItem) };
  }
  if (typeof parsed !== "object" || parsed === null) return emptyStore();
  const record = parsed as Record<string, unknown>;
  const items = Array.isArray(record.items) ? record.items.filter(isTodoItem) : [];
  const extractError = parseExtractError(record.extractError);
  return extractError ? { items, extractError } : { items };
}

function isTodoItem(value: unknown): value is TodoItem {
  if (typeof value !== "object" || value === null) return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    typeof item.wikiId === "string" &&
    typeof item.sourceId === "string" &&
    typeof item.title === "string" &&
    typeof item.rationale === "string" &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

function parseExtractError(value: unknown): TodoExtractError | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const error = value as Record<string, unknown>;
  if (
    typeof error.message !== "string" ||
    typeof error.slug !== "string" ||
    typeof error.at !== "string"
  ) {
    return undefined;
  }
  return {
    message: error.message,
    slug: error.slug,
    ...(typeof error.sourcePath === "string" ? { sourcePath: error.sourcePath } : {}),
    at: error.at,
  };
}

function capItems(items: TodoItem[]): TodoItem[] {
  if (items.length <= MAX_TODOS) return items;
  const decided = items.filter((item) => item.decision);
  const pending = items.filter((item) => !item.decision);
  const room = Math.max(0, MAX_TODOS - decided.length);
  return [...decided, ...pending.slice(-room)];
}

function serializeStore(store: TodoStore): string {
  const items = capItems(store.items);
  const body: TodoStore = store.extractError
    ? { items, extractError: store.extractError }
    : { items };
  return JSON.stringify(body, null, 2);
}

async function readStore(owner: string): Promise<TodoStore> {
  try {
    return parseStore(await getStorage().readFile(todosPath(owner)));
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    throw error;
  }
}

async function withTodoStore<T>(
  owner: string,
  mutate: (store: TodoStore) => T,
): Promise<T> {
  const result = await withFileLock(lockKey(owner), async () => {
    const storage = getStorage();
    const path = todosPath(owner);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      let store = emptyStore();
      let etag: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        store = parseStore(read.content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const draft: TodoStore = {
        items: store.items.map((item) => ({ ...item })),
        ...(store.extractError ? { extractError: { ...store.extractError } } : {}),
      };
      const result = mutate(draft);
      const next = serializeStore(draft);
      if (etag === null) {
        try {
          await storage.readFile(path);
          continue;
        } catch (error) {
          if (!isEnoent(error)) throw error;
          await storage.writeFile(path, next);
          return result;
        }
      }
      if (await storage.writeFileIfMatch(path, next, etag)) {
        return result;
      }
    }
    throw new Error("Todo store was busy; retry the request");
  });
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn("todos", "data-version bump failed after a Todo write", error);
  }
  return result;
}

export async function listTodos(owner: string, tab?: TodoTab): Promise<TodoItem[]> {
  const items = (await readStore(owner)).items;
  const filtered = tab ? items.filter((item) => todoTabOf(item) === tab) : items;
  return filtered.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function pendingTodoCount(owner: string): Promise<number> {
  return (await readStore(owner)).items.filter(isPendingCandidate).length;
}

export async function getTodoExtractError(owner: string): Promise<TodoExtractError | undefined> {
  return (await readStore(owner)).extractError;
}

export async function getTodo(owner: string, id: string): Promise<TodoItem | null> {
  return (await readStore(owner)).items.find((item) => item.id === id) ?? null;
}

export function collapseTodoTitles(
  proposals: readonly TodoCandidateProposal[],
): TodoCandidateProposal[] {
  const seen = new Set<string>();
  const out: TodoCandidateProposal[] = [];
  for (const proposal of proposals) {
    const title = proposal.title.trim();
    if (!title) continue;
    const key = normalizeTodoTitle(title);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      title: title.slice(0, 240),
      rationale: proposal.rationale.trim().slice(0, 2_000),
      ...(proposal.due?.trim() ? { due: proposal.due.trim().slice(0, 40) } : {}),
      ...(proposal.speaker?.trim()
        ? { speaker: proposal.speaker.trim().slice(0, 160) }
        : {}),
      ...(proposal.context?.trim()
        ? { context: proposal.context.trim().slice(0, 800) }
        : {}),
    });
  }
  return out;
}

export async function enqueueTodoCandidates(
  owner: string,
  input: {
    wikiId: string;
    sourceId: string;
    pageSlug?: string;
    candidates: readonly TodoCandidateProposal[];
  },
): Promise<TodoItem[]> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  const sourceId = canonicalSourceId(input.sourceId);
  if (!sourceId) throw new Error("sourceId is required");
  const incoming = collapseTodoTitles(input.candidates);
  const now = new Date().toISOString();
  return withTodoStore(owner, (store) => {
    delete store.extractError;
    const kept = store.items.filter(
      (item) => !(itemMatchesSource(item, sourceId) && isPendingCandidate(item)),
    );
    const decidedTitles = new Set(
      kept
        .filter((item) => itemMatchesSource(item, sourceId) && item.decision)
        .map((item) => normalizeTodoTitle(item.title)),
    );
    const created: TodoItem[] = [];
    for (const proposal of incoming) {
      const key = normalizeTodoTitle(proposal.title);
      if (decidedTitles.has(key)) continue;
      decidedTitles.add(key);
      const item: TodoItem = {
        id: crypto.randomUUID(),
        wikiId: input.wikiId,
        sourceId,
        ...(input.pageSlug?.trim() ? { pageSlug: input.pageSlug.trim() } : {}),
        title: proposal.title,
        rationale: proposal.rationale,
        ...(proposal.due ? { due: proposal.due } : {}),
        ...(proposal.speaker ? { speaker: proposal.speaker } : {}),
        ...(proposal.context ? { context: proposal.context } : {}),
        createdAt: now,
        updatedAt: now,
      };
      created.push(item);
      kept.push(item);
    }
    store.items = kept;
    return created;
  });
}

export async function decideTodos(
  owner: string,
  ids: readonly string[],
  decision: TodoDecision,
  actor: string,
): Promise<TodoItem[]> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  const wanted = new Set(ids.filter((id) => id.trim()));
  if (wanted.size === 0) return [];
  const now = new Date().toISOString();
  const handle = actor.trim() || "owner";
  return withTodoStore(owner, (store) => {
    const updated: TodoItem[] = [];
    for (const item of store.items) {
      if (!wanted.has(item.id) || item.decision) continue;
      item.decision = decision;
      item.decidedAt = now;
      item.actor = handle;
      item.updatedAt = now;
      if (decision === "approve") item.status = "open";
      updated.push(item);
    }
    return updated;
  });
}

export async function patchTodo(
  owner: string,
  id: string,
  patch: {
    title?: string;
    due?: string | null;
    status?: TodoStatus;
    decision?: TodoDecision;
    actor?: string;
  },
): Promise<TodoItem | null> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  const now = new Date().toISOString();
  return withTodoStore(owner, (store) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item) return null;
    if (patch.decision && !item.decision) {
      item.decision = patch.decision;
      item.decidedAt = now;
      item.actor = patch.actor?.trim() || "owner";
      if (patch.decision === "approve") item.status = "open";
    }
    if (patch.title !== undefined) {
      if (item.decision !== "approve") {
        throw new Error("Title can be edited after approve.");
      }
      const title = patch.title.trim();
      if (!title) throw new Error("Todo title cannot be empty.");
      item.title = title.slice(0, 240);
    }
    if (patch.due !== undefined) {
      if (item.decision !== "approve") {
        throw new Error("Due date can be edited after approve.");
      }
      if (patch.due === null || !patch.due.trim()) delete item.due;
      else item.due = patch.due.trim().slice(0, 40);
    }
    if (patch.status !== undefined) {
      if (item.decision !== "approve") {
        throw new Error("Only approved Todos can change status.");
      }
      item.status = patch.status;
    }
    item.updatedAt = now;
    return item;
  });
}

export async function deleteTodo(owner: string, id: string): Promise<boolean> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  return withTodoStore(owner, (store) => {
    const before = store.items.length;
    store.items = store.items.filter((item) => item.id !== id);
    return store.items.length < before;
  });
}

export async function markTodosSourceMissing(
  owner: string,
  sourcePath: string,
): Promise<number> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  if (!sourcePath.trim()) return 0;
  const now = new Date().toISOString();
  return withTodoStore(owner, (store) => {
    let n = 0;
    for (const item of store.items) {
      if (item.sourceMissing) continue;
      if (!itemMatchesSource(item, sourcePath)) continue;
      item.sourceMissing = true;
      item.updatedAt = now;
      n += 1;
    }
    return n;
  });
}

export async function recordTodoExtractError(
  owner: string,
  error: Omit<TodoExtractError, "at"> & { at?: string },
): Promise<void> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  await withTodoStore(owner, (store) => {
    store.extractError = {
      message: error.message,
      slug: error.slug,
      ...(error.sourcePath ? { sourcePath: error.sourcePath } : {}),
      at: error.at ?? new Date().toISOString(),
    };
  });
}

export async function clearTodoExtractError(owner: string): Promise<void> {
  assertWritable(READ_ONLY_REFUSAL.todos);
  await withTodoStore(owner, (store) => {
    delete store.extractError;
  });
}
