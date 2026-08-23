import { isCoverageSentence, sanitizeCitedAnswer } from "./chat-citations";
import { extractCitedSlugs } from "./citations";
import { isEnoent } from "./errors";
import { callLLM, hasLLMKey } from "./llm";
import { withFileLock } from "./lock";
import {
  buildNamesTermsGuidance,
  expandQueryWithNamesTerms,
} from "./names-terms";
import {
  buildContext,
  buildQuerySystemPrompt,
  selectPagesForQuery,
} from "./query";
import { resolveScopeSlugs } from "./search";
import { getStorage } from "./storage";
import {
  buildRawSourceContext,
  extractRawCitedPageSlugs,
  type RawSourceChunk,
} from "./raw-source-search";
import { UNTRUSTED_CONTENT_RULE } from "./untrusted";
import { buildWorkspaceGuidance } from "./workspace-guidance";
import {
  isAgentScopedType,
  isArtifactType,
  listReadableWikiPages,
  tenantForOwner,
  validateTenant,
} from "./wiki";
import type { Principal } from "./auth";
import {
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_TOKEN_BUDGET_DEFAULT,
  clampHistoryDepth,
  clampTokenBudget,
  type ChatCitation,
  type ChatExportRecord,
} from "./chat-contract";

export type ChatRole = "user" | "assistant";
export type ChatBackend = "native" | "hermes";
export type ChatRetrievalMode = "wiki" | "sources";
export type ChatContextBudget = "compact" | "standard" | "expanded";

export const CHAT_RETRIEVAL_MODES: readonly ChatRetrievalMode[] = [
  "wiki",
  "sources",
];

export function isChatRetrievalMode(value: unknown): value is ChatRetrievalMode {
  return value === "wiki" || value === "sources";
}

export function isChatContextBudget(value: unknown): value is ChatContextBudget {
  return value === "compact" || value === "standard" || value === "expanded";
}

const CHAT_CONTEXT_PAGE_LIMITS: Record<ChatContextBudget, number> = {
  compact: 4,
  standard: 8,
  expanded: 12,
};

export interface ChatMessage {
  id: string;
  role: ChatRole;
  content: string;
  sources: string[];
  createdAt: string;
  backend?: ChatBackend;
  citations?: ChatCitation[];
  thinking?: string;
}

export interface ChatConversation {
  id: string;
  title: string;
  scope?: string;
  /** Optional at rest for conversations created before evidence modes existed. */
  retrievalMode?: ChatRetrievalMode;
  /** Optional at rest for conversations created before context controls existed. */
  contextBudget?: ChatContextBudget;
  /** Epic 3 token slider (4K–1M). Absent on pre-Epic-3 rows. */
  tokenBudget?: number;
  /** History depth N; tighter of N vs the 20% history slot wins at assemble. */
  historyDepth?: number;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

function normalizeConversation(conversation: ChatConversation): ChatConversation {
  return {
    ...conversation,
    retrievalMode: conversation.retrievalMode === "sources" ? "sources" : "wiki",
    contextBudget: isChatContextBudget(conversation.contextBudget)
      ? conversation.contextBudget
      : "standard",
    tokenBudget: clampTokenBudget(
      conversation.tokenBudget ?? CHAT_TOKEN_BUDGET_DEFAULT,
    ),
    historyDepth: clampHistoryDepth(
      conversation.historyDepth ?? CHAT_HISTORY_DEPTH_DEFAULT,
    ),
    messages: conversation.messages.map((message) => ({
      ...message,
      citations: Array.isArray(message.citations) ? message.citations : [],
      ...(typeof message.thinking === "string" && message.thinking
        ? { thinking: message.thinking }
        : {}),
    })),
  };
}

export function conversationWithName<T extends ChatConversation>(
  conversation: T,
): T & { name: string } {
  return { ...conversation, name: conversation.title };
}

export function exportChatConversation(
  conversation: ChatConversation,
): ChatExportRecord {
  const normalized = normalizeConversation(conversation);
  return {
    id: normalized.id,
    name: normalized.title,
    messages: normalized.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.citations ?? [],
      ...(message.thinking ? { thinking: message.thinking } : {}),
      createdAt: message.createdAt,
    })),
  };
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 80;
const CONTEXT_MESSAGES = 12;
const CONVERSATION_CAS_ATTEMPTS = 4;

export class ChatPersistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ChatPersistError";
  }
}

function conversationsPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/chat-conversations.json`;
}

function lockKey(owner: string): string {
  return `chat-conversations:${tenantForOwner(owner)}`;
}

async function readConversations(owner: string): Promise<ChatConversation[]> {
  try {
    return parseConversationList(
      await getStorage().readFile(conversationsPath(owner)),
    );
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

function serializeConversations(conversations: ChatConversation[]): string {
  const trimmed = conversations
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-MAX_CONVERSATIONS)
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES),
    }));
  return JSON.stringify(trimmed, null, 2);
}

function parseConversationList(raw: string): ChatConversation[] {
  const parsed = JSON.parse(raw) as unknown;
  return Array.isArray(parsed)
    ? (parsed as ChatConversation[]).map(normalizeConversation)
    : [];
}

async function withConversationStore<T>(
  owner: string,
  mutate: (conversations: ChatConversation[]) => T,
): Promise<T> {
  return withFileLock(lockKey(owner), async () => {
    const storage = getStorage();
    const path = conversationsPath(owner);
    for (let attempt = 0; attempt < CONVERSATION_CAS_ATTEMPTS; attempt += 1) {
      let conversations: ChatConversation[] = [];
      let etag: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        conversations = parseConversationList(read.content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const draft = conversations.map((conversation) => ({
        ...conversation,
        messages: [...conversation.messages],
      }));
      const result = mutate(draft);
      const next = serializeConversations(draft);
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
    throw new Error("Conversation store was busy; retry the request");
  });
}

export async function listChatConversations(
  owner: string,
): Promise<ChatConversation[]> {
  return (await readConversations(owner))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .map((conversation) => ({ ...conversation, messages: [] }));
}

export async function getChatConversation(
  owner: string,
  id: string,
): Promise<ChatConversation | null> {
  return (await readConversations(owner)).find((item) => item.id === id) ?? null;
}

export async function createChatConversation(
  owner: string,
  input?: {
    title?: string;
    name?: string;
    scope?: string;
    retrievalMode?: ChatRetrievalMode;
    contextBudget?: ChatContextBudget;
    tokenBudget?: number;
    historyDepth?: number;
  },
): Promise<ChatConversation> {
  return withConversationStore(owner, (conversations) => {
    const now = new Date().toISOString();
    const title =
      (input?.name ?? input?.title)?.trim().slice(0, 120) || "New conversation";
    const conversation: ChatConversation = {
      id: crypto.randomUUID(),
      title,
      ...(input?.scope?.trim() ? { scope: input.scope.trim() } : {}),
      retrievalMode: input?.retrievalMode ?? "wiki",
      contextBudget: input?.contextBudget ?? "standard",
      tokenBudget: clampTokenBudget(input?.tokenBudget ?? CHAT_TOKEN_BUDGET_DEFAULT),
      historyDepth: clampHistoryDepth(
        input?.historyDepth ?? CHAT_HISTORY_DEPTH_DEFAULT,
      ),
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    conversations.push(conversation);
    return conversation;
  });
}

export async function updateChatConversation(
  owner: string,
  id: string,
  patch: {
    title?: string;
    name?: string;
    scope?: string | null;
    retrievalMode?: ChatRetrievalMode;
    contextBudget?: ChatContextBudget;
    tokenBudget?: number;
    historyDepth?: number;
  },
): Promise<ChatConversation | null> {
  return withConversationStore(owner, (conversations) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return null;
    const nextTitle = patch.name ?? patch.title;
    if (nextTitle !== undefined) {
      const title = nextTitle.trim();
      if (!title) throw new Error("Conversation title cannot be empty");
      conversation.title = title.slice(0, 120);
    }
    if (patch.scope !== undefined) {
      if (patch.scope?.trim()) conversation.scope = patch.scope.trim();
      else delete conversation.scope;
    }
    if (patch.retrievalMode !== undefined) {
      conversation.retrievalMode = patch.retrievalMode;
    }
    if (patch.contextBudget !== undefined) {
      conversation.contextBudget = patch.contextBudget;
    }
    if (patch.tokenBudget !== undefined) {
      conversation.tokenBudget = clampTokenBudget(patch.tokenBudget);
    }
    if (patch.historyDepth !== undefined) {
      conversation.historyDepth = clampHistoryDepth(patch.historyDepth);
    }
    conversation.updatedAt = new Date().toISOString();
    return conversation;
  });
}

export async function deleteChatConversation(
  owner: string,
  id: string,
): Promise<boolean> {
  return withConversationStore(owner, (conversations) => {
    const index = conversations.findIndex((item) => item.id === id);
    if (index < 0) return false;
    conversations.splice(index, 1);
    return true;
  });
}

export interface PersistChatMessage {
  role: ChatRole;
  content: string;
  citations?: ChatCitation[];
  thinking?: string;
}

function lastTurnIsPair(messages: readonly ChatMessage[]): boolean {
  if (messages.length < 2) return false;
  const assistant = messages.at(-1);
  const user = messages.at(-2);
  return Boolean(
    assistant &&
      user &&
      assistant.role === "assistant" &&
      user.role === "user",
  );
}

function assertCompleteTurn(frames: readonly PersistChatMessage[]): void {
  if (
    frames.length !== 2 ||
    frames[0]?.role !== "user" ||
    frames[1]?.role !== "assistant"
  ) {
    throw new ChatPersistError(
      "A turn must be one user message then one assistant message",
    );
  }
  if (!frames[0].content.trim() || !frames[1].content.trim()) {
    throw new ChatPersistError("content cannot be empty");
  }
}

/**
 * Persist a complete user+assistant turn after a sidecar `done`.
 * `replaceLastTurn` retracts the current pair in the same compare-and-swap.
 */
export async function persistChatTurn(
  owner: string,
  id: string,
  frames: readonly PersistChatMessage[],
  options?: { replaceLastTurn?: boolean },
): Promise<ChatConversation | null> {
  assertCompleteTurn(frames);
  const userFrame = frames[0];
  const assistantFrame = frames[1];
  const sanitized = isCoverageSentence(assistantFrame.content)
    ? { content: assistantFrame.content.trim(), citations: [] as ChatCitation[] }
    : sanitizeCitedAnswer(assistantFrame.content, assistantFrame.citations);
  if (
    !isCoverageSentence(sanitized.content) &&
    sanitized.citations.length === 0
  ) {
    throw new ChatPersistError("Answer is missing a mapped [n] citation");
  }

  return withConversationStore(owner, (conversations) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return null;
    if (options?.replaceLastTurn) {
      if (!lastTurnIsPair(conversation.messages)) {
        throw new ChatPersistError("No last turn to replace");
      }
      conversation.messages = conversation.messages.slice(0, -2);
    }
    if (conversation.messages.length + 2 > MAX_MESSAGES) {
      throw new ChatPersistError("Conversation is full");
    }
    const now = new Date().toISOString();
    conversation.messages.push(
      {
        id: crypto.randomUUID(),
        role: "user",
        content: userFrame.content.trim(),
        sources: [],
        citations: [],
        createdAt: now,
      },
      {
        id: crypto.randomUUID(),
        role: "assistant",
        content: sanitized.content,
        sources: sanitized.citations.map((citation) => citation.path),
        citations: sanitized.citations,
        ...(assistantFrame.thinking
          ? { thinking: assistantFrame.thinking }
          : {}),
        createdAt: now,
      },
    );
    if (conversation.title === "New conversation") {
      conversation.title = userFrame.content.trim().slice(0, 80);
    }
    conversation.updatedAt = now;
    return conversation;
  });
}

/**
 * Persist user/assistant frames after a sidecar `done` — no Worker generation.
 */
export async function appendChatMessages(
  owner: string,
  id: string,
  frames: readonly PersistChatMessage[],
): Promise<ChatConversation | null> {
  if (frames.length === 0) return getChatConversation(owner, id);
  return persistChatTurn(owner, id, frames);
}

/**
 * Remove the last user+assistant pair. No-op when the conversation has no pair.
 * Returns the retracted user content so Regenerate can re-send it.
 */
export async function retractLastChatTurn(
  owner: string,
  id: string,
): Promise<{ conversation: ChatConversation; userContent: string } | null> {
  return withConversationStore(owner, (conversations) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation || !lastTurnIsPair(conversation.messages)) return null;
    const user = conversation.messages.at(-2);
    if (!user) return null;
    conversation.messages = conversation.messages.slice(0, -2);
    conversation.updatedAt = new Date().toISOString();
    return { conversation, userContent: user.content };
  });
}

interface HermesCompletion {
  choices?: Array<{ message?: { content?: string } }>;
}

interface HermesToolsetRow {
  name?: string;
  enabled?: boolean;
  tools?: string[];
}

interface HermesToolsetEnvelope {
  data?: HermesToolsetRow[];
  toolsets?: HermesToolsetRow[];
}

function hermesConfigured(): boolean {
  return Boolean(process.env.HERMES_AGENT_URL && process.env.HERMES_API_KEY);
}

export async function getHermesStatus(): Promise<{
  configured: boolean;
  available: boolean;
  safe: boolean;
  reason?: string;
}> {
  const configuredUrl = process.env.HERMES_AGENT_URL;
  const key = process.env.HERMES_API_KEY;
  if (!configuredUrl || !key) {
    return { configured: false, available: false, safe: false };
  }
  const base = configuredUrl.replace(/\/$/, "");
  try {
    const [health, toolsetsResponse] = await Promise.all([
      fetch(`${base}/health`, { signal: AbortSignal.timeout(5_000) }),
      fetch(`${base}/v1/toolsets`, {
        headers: { Authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(5_000),
      }),
    ]);
    if (!health.ok || !toolsetsResponse.ok) {
      return {
        configured: true,
        available: false,
        safe: false,
        reason: "Hermes health or tool discovery failed.",
      };
    }
    const payload = (await toolsetsResponse.json()) as
      | HermesToolsetRow[]
      | HermesToolsetEnvelope;
    const rows = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.toolsets)
          ? payload.toolsets
          : null;
    if (!rows) {
      return {
        configured: true,
        available: false,
        safe: false,
        reason: "Hermes returned an unrecognized tool-discovery response.",
      };
    }
    const dangerous = new Set([
      "browser",
      "terminal",
      "file",
      "code_execution",
      "computer_use",
      "cronjob",
      "delegation",
      "skills",
      "process",
      "read_terminal",
      "read_file",
      "write_file",
      "patch",
      "execute_code",
      "computer_use",
      "cronjob",
      "delegate_task",
      "memory",
      "skill_manage",
      "todo",
    ]);
    const enabledTools = rows
      .filter((row) => row.enabled)
      .flatMap((row) => [row.name, ...(row.tools ?? [])])
      .filter((name): name is string => Boolean(name));
    const unsafe = enabledTools.filter((name) => dangerous.has(name));
    if (unsafe.length > 0) {
      return {
        configured: true,
        available: false,
        safe: false,
        reason: "Hermes has host-mutating tools enabled for the API server.",
      };
    }
    return { configured: true, available: true, safe: true };
  } catch {
    return {
      configured: true,
      available: false,
      safe: false,
      reason: "Hermes is unreachable.",
    };
  }
}

async function callHermes(
  system: string,
  messages: readonly ChatMessage[],
): Promise<string> {
  const base = process.env.HERMES_AGENT_URL?.replace(/\/$/, "");
  const key = process.env.HERMES_API_KEY;
  if (!base || !key) throw new Error("Hermes is not configured");
  const status = await getHermesStatus();
  if (!status.available || !status.safe) {
    throw new Error(status.reason || "Hermes is unavailable or unsafe");
  }

  const response = await fetch(`${base}/v1/chat/completions`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: process.env.HERMES_MODEL || "hermes-agent",
      stream: false,
      messages: [
        { role: "system", content: system },
        ...messages.slice(-CONTEXT_MESSAGES).map((message) => ({
          role: message.role,
          content: message.content,
        })),
      ],
    }),
    signal: AbortSignal.timeout(90_000),
  });
  const body = (await response.json().catch(() => ({}))) as HermesCompletion & {
    error?: { message?: string } | string;
  };
  if (!response.ok) {
    const detail =
      typeof body.error === "string" ? body.error : body.error?.message;
    throw new Error(detail || `Hermes request failed (${response.status})`);
  }
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) throw new Error("Hermes returned an empty response");
  return content;
}

async function generateChatAnswer(
  conversation: ChatConversation,
  question: string,
  principal: Principal,
): Promise<{ content: string; sources: string[]; backend: ChatBackend }> {
  const { scopeSlugs, error } = await resolveScopeSlugs(
    conversation.scope,
    principal,
  );
  if (error) throw new Error(error);

  let entries = (await listReadableWikiPages(principal)).filter(
    (entry) => !isArtifactType(entry.type),
  );
  if (!scopeSlugs) {
    entries = entries.filter((entry) => !isAgentScopedType(entry.type));
  }
  if (entries.length === 0) {
    throw new Error("Your wiki has no readable pages to chat with yet.");
  }

  const recent = conversation.messages.slice(-CONTEXT_MESSAGES);
  const rawRetrievalQuestion = [
    ...recent.filter((message) => message.role === "user").map((message) => message.content),
    question,
  ].join("\n");
  const retrievalQuestion = await expandQueryWithNamesTerms(
    principal.handle,
    rawRetrievalQuestion,
  );
  const selected = (await selectPagesForQuery(
    retrievalQuestion,
    entries,
    scopeSlugs,
  )).slice(
    0,
    CHAT_CONTEXT_PAGE_LIMITS[conversation.contextBudget ?? "standard"],
  );
  let system: string;
  let rawChunks: RawSourceChunk[] = [];
  if (conversation.retrievalMode === "sources") {
    const rawContext = await buildRawSourceContext(
      selected,
      entries,
      retrievalQuestion,
    );
    if (!rawContext.context) {
      throw new Error("No original source material is available in this scope.");
    }
    rawChunks = rawContext.chunks;
    const [workspaceGuidance, dictionaryGuidance] = await Promise.all([
      buildWorkspaceGuidance(principal.handle),
      buildNamesTermsGuidance(principal.handle),
    ]);
    system = [
      "You are work-wiki's source-grounded conversation assistant.",
      "Answer using ONLY the ORIGINAL SOURCE EXCERPTS supplied below. The generated wiki pages were used only to locate these originals and are not evidence.",
      "Every factual claim must be followed by the exact markdown citation printed as Required citation for the supporting excerpt. Preserve its label, line range, path, and source query parameter exactly.",
      "Never cite a generated wiki page in this mode. Do not use outside knowledge to fill gaps. If the excerpts do not answer the question, say what is missing and stop.",
      "Use prior turns only to understand the user's intent; prior assistant statements are not evidence.",
      UNTRUSTED_CONTENT_RULE,
      workspaceGuidance,
      dictionaryGuidance,
      "ORIGINAL SOURCE CONTEXT",
      rawContext.context,
    ].filter(Boolean).join("\n\n");
  } else {
    const { context } = await buildContext(selected);
    system = await buildQuerySystemPrompt(
      context,
      entries,
      selected,
      "prose",
      principal.handle,
    );
    system +=
      "\n\nThis is a multi-turn conversation. Use prior turns only to understand the user's intent. " +
      "Every factual claim about the user's knowledge must remain grounded in the supplied wiki context, " +
      "and every answer must include markdown citations to the relevant wiki pages.";
  }

  const userMessage: ChatMessage = {
    id: crypto.randomUUID(),
    role: "user",
    content: question,
    sources: [],
    createdAt: new Date().toISOString(),
  };
  const messages = [...recent, userMessage];

  let content: string;
  let backend: ChatBackend = "native";
  if (hermesConfigured()) {
    try {
      content = await callHermes(system, messages);
      backend = "hermes";
    } catch {
      if (!hasLLMKey()) throw new Error("Hermes is unavailable and no fallback LLM is configured.");
      content = await callLLM(system, rawRetrievalQuestion);
    }
  } else {
    if (!hasLLMKey()) throw new Error("No LLM provider is configured.");
    content = await callLLM(system, rawRetrievalQuestion);
  }

  return {
    content,
    sources: conversation.retrievalMode === "sources"
      ? extractRawCitedPageSlugs(content, rawChunks)
      : extractCitedSlugs(content, entries.map((entry) => entry.slug)),
    backend,
  };
}

/** Legacy Worker generation. The HTTP `{ message }` door is retired (410). */
export async function addChatTurn(
  owner: string,
  id: string,
  question: string,
  principal: Principal,
): Promise<{ conversation: ChatConversation; message: ChatMessage }> {
  const snapshot = await getChatConversation(owner, id);
  if (!snapshot) throw new Error("Conversation not found");
  const trimmed = question.trim();
  if (!trimmed) throw new Error("Message cannot be empty");
  const generated = await generateChatAnswer(snapshot, trimmed, principal);

  return withConversationStore(owner, (conversations) => {
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("Conversation not found");
    const now = new Date().toISOString();
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: trimmed,
      sources: [],
      createdAt: now,
    };
    const assistantMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: generated.content,
      sources: generated.sources,
      backend: generated.backend,
      createdAt: new Date().toISOString(),
    };
    conversation.messages.push(userMessage, assistantMessage);
    if (conversation.title === "New conversation") {
      conversation.title = trimmed.slice(0, 80);
    }
    conversation.updatedAt = assistantMessage.createdAt;
    return { conversation, message: assistantMessage };
  });
}
