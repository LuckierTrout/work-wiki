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
import { buildWorkspaceGuidance } from "./workspace-profile";
import {
  isAgentScopedType,
  isArtifactType,
  listReadableWikiPages,
  tenantForOwner,
  validateTenant,
} from "./wiki";
import type { Principal } from "./auth";

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
}

export interface ChatConversation {
  id: string;
  title: string;
  scope?: string;
  /** Optional at rest for conversations created before evidence modes existed. */
  retrievalMode?: ChatRetrievalMode;
  /** Optional at rest for conversations created before context controls existed. */
  contextBudget?: ChatContextBudget;
  messages: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

const MAX_CONVERSATIONS = 50;
const MAX_MESSAGES = 80;
const CONTEXT_MESSAGES = 12;

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
    const parsed = JSON.parse(
      await getStorage().readFile(conversationsPath(owner)),
    );
    return Array.isArray(parsed)
      ? (parsed as ChatConversation[]).map((conversation) => ({
          ...conversation,
          retrievalMode: conversation.retrievalMode === "sources" ? "sources" : "wiki",
          contextBudget: isChatContextBudget(conversation.contextBudget)
            ? conversation.contextBudget
            : "standard",
        }))
      : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

async function writeConversations(
  owner: string,
  conversations: ChatConversation[],
): Promise<void> {
  const trimmed = conversations
    .sort((a, b) => a.updatedAt.localeCompare(b.updatedAt))
    .slice(-MAX_CONVERSATIONS)
    .map((conversation) => ({
      ...conversation,
      messages: conversation.messages.slice(-MAX_MESSAGES),
    }));
  await getStorage().writeFile(
    conversationsPath(owner),
    JSON.stringify(trimmed, null, 2),
  );
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
    scope?: string;
    retrievalMode?: ChatRetrievalMode;
    contextBudget?: ChatContextBudget;
  },
): Promise<ChatConversation> {
  return withFileLock(lockKey(owner), async () => {
    const conversations = await readConversations(owner);
    const now = new Date().toISOString();
    const conversation: ChatConversation = {
      id: crypto.randomUUID(),
      title: input?.title?.trim().slice(0, 120) || "New conversation",
      ...(input?.scope?.trim() ? { scope: input.scope.trim() } : {}),
      retrievalMode: input?.retrievalMode ?? "wiki",
      contextBudget: input?.contextBudget ?? "standard",
      messages: [],
      createdAt: now,
      updatedAt: now,
    };
    conversations.push(conversation);
    await writeConversations(owner, conversations);
    return conversation;
  });
}

export async function updateChatConversation(
  owner: string,
  id: string,
  patch: {
    title?: string;
    scope?: string | null;
    retrievalMode?: ChatRetrievalMode;
    contextBudget?: ChatContextBudget;
  },
): Promise<ChatConversation | null> {
  return withFileLock(lockKey(owner), async () => {
    const conversations = await readConversations(owner);
    const conversation = conversations.find((item) => item.id === id);
    if (!conversation) return null;
    if (patch.title !== undefined) {
      const title = patch.title.trim();
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
    conversation.updatedAt = new Date().toISOString();
    await writeConversations(owner, conversations);
    return conversation;
  });
}

export async function deleteChatConversation(
  owner: string,
  id: string,
): Promise<boolean> {
  return withFileLock(lockKey(owner), async () => {
    const conversations = await readConversations(owner);
    const filtered = conversations.filter((item) => item.id !== id);
    if (filtered.length === conversations.length) return false;
    await writeConversations(owner, filtered);
    return true;
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

  return withFileLock(lockKey(owner), async () => {
    const conversations = await readConversations(owner);
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
    await writeConversations(owner, conversations);
    return { conversation, message: assistantMessage };
  });
}
