/**
 * The Chat conversation doors and their rules, extracted out of
 * `ChatCanvas.tsx` (DW-587).
 *
 * This module owns exactly one question: WHICH DOOR, and what does its answer
 * mean. Every `/api/chat/conversations*` URL, method and body THE WORKBENCH'S
 * CHAT USES lives here — the legacy `src/components/ChatWorkspace.tsx` at
 * `/chat` still opens its own on that path, and this is not its owner — along
 * with the pure rules that read an answer: what a loaded row's settings fall
 * back to, how a returned row is merged into the list, which messages are
 * optimistic, and which tail of a transcript can be regenerated. It knows
 * nothing about when a door is opened or what state the answer writes: that is
 * `useChatConversations.ts`, and what is on screen is `ChatCanvas.tsx`.
 *
 * Framework-free on purpose: a URL, a method and a body are the part of Chat a
 * review is actually about, and they are asserted in the `node` project without
 * mounting React.
 *
 * `send` is the ONE import taken from `@/lib/workbench-request` — the mounted
 * Chat suites replace that whole module with `{ send }`, so any other named
 * import would resolve to `undefined` under them.
 */

import {
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_TOKEN_BUDGET_DEFAULT,
  type ChatCitation,
} from "./chat-contract";
import type { ChatOutput, ChatToolCall } from "./chat";
import { send } from "./workbench-request";

/** A row of the conversation list, and — once read — its messages too. */
export interface ConversationRow {
  id: string;
  title: string;
  name?: string;
  retrievalMode?: "wiki" | "sources";
  tokenBudget?: number;
  historyDepth?: number;
  selectedSkill?: string;
  messages?: CanvasMessage[];
}

/** One message as the canvas holds it, optimistic rows included. */
export interface CanvasMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  thinking?: string;
  /** Tool rows and outputs, persisted with the turn (Stories 8.5 / 8.8). */
  toolCalls?: ChatToolCall[];
  outputs?: ChatOutput[];
}

/** The settings a conversation carries, resolved against the defaults. */
export interface ConversationSettings {
  retrievalMode: "wiki" | "sources";
  tokenBudget: number;
  historyDepth: number;
  selectedSkill: string | undefined;
}

/**
 * What creating a conversation is allowed to be told.
 *
 * EXACTLY THE FIELDS THE BODY SENDS, so the type is what stops a fourth from
 * being handed in and silently dropped. `selectedSkill` is the one that would
 * be: a Skill is picked on a conversation that already exists, through
 * {@link patchConversation}.
 */
export type CreateConversationSettings = Pick<
  ConversationSettings,
  "retrievalMode" | "tokenBudget" | "historyDepth"
>;

/** The persist leg's flag: this turn REPLACES the last one (Regenerate). */
export interface PersistOptions {
  replaceLastTurn?: boolean;
}

/** The store thought it wrote a turn and got no conversation back. */
export const CONVERSATION_PERSIST_FAILED_COPY = "Persist failed.";

/** The list door. Also the prefix every per-conversation door is built on. */
export const CONVERSATIONS_URL = "/api/chat/conversations";

/**
 * One conversation's door.
 *
 * ENCODED, because a conversation id reaches this from a row the store handed
 * back and from `?conversation=` in the address bar; an id carrying a space or a
 * slash would otherwise change which path the request names.
 */
export function conversationUrl(id: string): string {
  return `${CONVERSATIONS_URL}/${encodeURIComponent(id)}`;
}

/**
 * Every conversation, newest first as the route orders them.
 *
 * A body with no `conversations` is an EMPTY LIST rather than a failure: the
 * first thing a new owner sees is a wiki with no conversations in it, and a
 * banner is not what that deserves.
 */
export async function listConversations(): Promise<ConversationRow[]> {
  const body = await send<{ conversations?: ConversationRow[] }>(CONVERSATIONS_URL, {
    method: "GET",
  });
  return body.conversations ?? [];
}

/** One conversation with its messages, or `null` when the store has no such row. */
export async function readConversation(id: string): Promise<ConversationRow | null> {
  const body = await send<{ conversation?: ConversationRow }>(conversationUrl(id), {
    method: "GET",
  });
  return body.conversation ?? null;
}

/**
 * Start a conversation, carrying the settings the toolbar is currently showing.
 *
 * The parameter is {@link CreateConversationSettings} — exactly the three fields
 * the route accepts at creation — so a caller cannot hand in a Skill that would
 * be thrown away between here and the wire.
 */
export async function createConversation(
  settings: CreateConversationSettings,
): Promise<ConversationRow | null> {
  const body = await send<{ conversation?: ConversationRow }>(CONVERSATIONS_URL, {
    method: "POST",
    body: JSON.stringify({
      retrievalMode: settings.retrievalMode,
      tokenBudget: settings.tokenBudget,
      historyDepth: settings.historyDepth,
    }),
  });
  return body.conversation ?? null;
}

/** Remove one conversation. The store's answer carries nothing to read. */
export async function deleteConversation(id: string): Promise<void> {
  await send(conversationUrl(id), { method: "DELETE" });
}

/** Rename one conversation; `null` leaves the caller's list untouched. */
export async function renameConversation(
  id: string,
  name: string,
): Promise<ConversationRow | null> {
  const body = await send<{ conversation?: ConversationRow }>(conversationUrl(id), {
    method: "PATCH",
    body: JSON.stringify({ name }),
  });
  return body.conversation ?? null;
}

/** Change one conversation setting; `null` leaves the caller's list untouched. */
export async function patchConversation(
  id: string,
  patch: Record<string, unknown>,
): Promise<ConversationRow | null> {
  const body = await send<{ conversation?: ConversationRow }>(conversationUrl(id), {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
  return body.conversation ?? null;
}

/**
 * Write a settled turn down.
 *
 * THE THROW IS AHEAD OF EVERY CALLER'S SEQUENCE GUARD on purpose: a persist
 * that came back with no conversation wrote nothing, and a superseded caller
 * silently returning would leave the owner looking at an answer no store holds.
 */
export async function persistConversationMessages(
  id: string,
  frames: readonly CanvasMessage[],
  options?: PersistOptions,
): Promise<ConversationRow> {
  const body = await send<{ conversation?: ConversationRow }>(
    `${conversationUrl(id)}/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        persist: true,
        replaceLastTurn: options?.replaceLastTurn === true,
        messages: messageWirePayload(frames),
      }),
    },
  );
  if (!body.conversation) throw new Error(CONVERSATION_PERSIST_FAILED_COPY);
  return body.conversation;
}

/** Save one answer into the wiki, under `queries/`. */
export async function saveAnswerToWiki(id: string, messageId: string): Promise<void> {
  await send(`${conversationUrl(id)}/save`, {
    method: "POST",
    body: JSON.stringify({ messageId }),
  });
}

/**
 * What one turn looks like on the wire.
 *
 * `citations` is always sent, as `[]` when the frame has none — the store reads
 * the key rather than the message's shape. The other three are OMITTED when
 * empty, which is what keeps a plain answer's record from carrying three empty
 * arrays that mean nothing. What is present is PERSISTED WITH THE TURN, which
 * is what makes "survives restart with the Conversation" true for a chip and
 * auditable for a tool row.
 */
export function messageWirePayload(
  frames: readonly CanvasMessage[],
): Array<Record<string, unknown>> {
  return frames.map((frame) => ({
    role: frame.role,
    content: frame.content,
    citations: frame.citations ?? [],
    ...(frame.thinking ? { thinking: frame.thinking } : {}),
    ...(frame.toolCalls?.length ? { toolCalls: frame.toolCalls } : {}),
    ...(frame.outputs?.length ? { outputs: frame.outputs } : {}),
  }));
}

/**
 * The settings a loaded conversation puts in the toolbar.
 *
 * AN UNRECOGNIZED `retrievalMode` FALLS BACK TO `wiki` rather than being shown
 * as-is: the mode decides which corpus the next turn cites, and a row carrying a
 * value this build does not know would otherwise leave the select blank while
 * turns kept running under something the owner cannot read.
 */
export function conversationSettings(row: ConversationRow): ConversationSettings {
  return {
    retrievalMode: row.retrievalMode === "sources" ? "sources" : "wiki",
    tokenBudget: row.tokenBudget ?? CHAT_TOKEN_BUDGET_DEFAULT,
    historyDepth: row.historyDepth ?? CHAT_HISTORY_DEPTH_DEFAULT,
    selectedSkill: row.selectedSkill,
  };
}

/**
 * Fold a returned row back into the list.
 *
 * A MERGE, not a replace: the list row carries the `title` the sidebar renders
 * and the read carries the `messages`, and either door may answer with only its
 * own half.
 */
export function mergeConversationRow(
  rows: readonly ConversationRow[],
  id: string,
  patch: Partial<ConversationRow>,
): ConversationRow[] {
  return rows.map((item) => (item.id === id ? { ...item, ...patch } : item));
}

/**
 * Drop the optimistic user bubble a turn put on screen before it ran.
 *
 * Keyed on the `pending-` id prefix the surface mints, so a turn that failed,
 * was stopped, or was refused leaves no half-sent question behind.
 */
export function dropOptimisticMessages(
  messages: readonly CanvasMessage[],
): CanvasMessage[] {
  return messages.filter((item) => !item.id.startsWith("pending-"));
}

/** The most recent assistant message, which is what Save and the citation list read. */
export function lastAssistantMessage(
  messages: readonly CanvasMessage[],
): CanvasMessage | null {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message;
  }
  return null;
}

/** The cited references, grouped under the heading each one's type gives it. */
export function groupCitationsByType(
  citations: readonly ChatCitation[],
): Map<string, ChatCitation[]> {
  const groups = new Map<string, ChatCitation[]>();
  for (const citation of citations) {
    const list = groups.get(citation.type) ?? [];
    list.push(citation);
    groups.set(citation.type, list);
  }
  return groups;
}

/** The question to re-ask, and the transcript it is re-asked against. */
export interface RegenerateTarget {
  userText: string;
  history: CanvasMessage[];
}

/**
 * What Regenerate re-sends, or `null` when there is nothing to regenerate.
 *
 * ONLY A USER-THEN-ASSISTANT TAIL qualifies. Any other ending — an unanswered
 * question, two assistant messages, a transcript shorter than a turn — is not a
 * turn that can be replaced, and re-sending against it would write a second
 * answer beside the first rather than over it.
 */
export function regenerateTarget(
  messages: readonly CanvasMessage[],
): RegenerateTarget | null {
  if (messages.length < 2) return null;
  const assistant = messages[messages.length - 1];
  const user = messages[messages.length - 2];
  if (assistant.role !== "assistant" || user.role !== "user") return null;
  return { userText: user.content, history: messages.slice(0, -2) };
}
