import { extractCitedSlugs } from "./citations";
import { isEnoent } from "./errors";
import { callLLM, hasLLMKey } from "./llm";
import { withFileLock } from "./lock";
import {
  buildContext,
  buildQuerySystemPrompt,
  selectPagesForQuery,
} from "./query";
import { resolveScopeSlugs } from "./search";
import { getStorage } from "./storage";
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
    return Array.isArray(parsed) ? (parsed as ChatConversation[]) : [];
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
  input?: { title?: string; scope?: string },
): Promise<ChatConversation> {
  return withFileLock(lockKey(owner), async () => {
    const conversations = await readConversations(owner);
    const now = new Date().toISOString();
    const conversation: ChatConversation = {
      id: crypto.randomUUID(),
      title: input?.title?.trim().slice(0, 120) || "New conversation",
      ...(input?.scope?.trim() ? { scope: input.scope.trim() } : {}),
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
  patch: { title?: string; scope?: string | null },
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
    const rows = (await toolsetsResponse.json()) as Array<{
      enabled?: boolean;
      tools?: string[];
    }>;
    if (!Array.isArray(rows)) {
      return {
        configured: true,
        available: false,
        safe: false,
        reason: "Hermes returned an unrecognized tool-discovery response.",
      };
    }
    const dangerous = new Set([
      "terminal",
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
      .flatMap((row) => row.tools ?? []);
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
  const retrievalQuestion = [
    ...recent.filter((message) => message.role === "user").map((message) => message.content),
    question,
  ].join("\n");
  const selected = await selectPagesForQuery(
    retrievalQuestion,
    entries,
    scopeSlugs,
  );
  const { context } = await buildContext(selected);
  let system = await buildQuerySystemPrompt(context, entries, selected, "prose");
  system +=
    "\n\nThis is a multi-turn conversation. Use prior turns only to understand the user's intent. " +
    "Every factual claim about the user's knowledge must remain grounded in the supplied wiki context, " +
    "and every answer must include markdown citations to the relevant wiki pages.";

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
      content = await callLLM(system, retrievalQuestion);
    }
  } else {
    if (!hasLLMKey()) throw new Error("No LLM provider is configured.");
    content = await callLLM(system, retrievalQuestion);
  }

  return {
    content,
    sources: extractCitedSlugs(content, entries.map((entry) => entry.slug)),
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
