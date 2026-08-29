/**
 * The turn's own rules, extracted out of `ChatCanvas.tsx` (DW-444).
 *
 * This module knows what a turn IS and what a `done` frame MEANS: the request
 * shape the Agent leg is entitled to, whether the frame holds the turn open or
 * writes it down, what a resume carries, and what the owner is told when the
 * door refuses. It never fetches — the wire is `chat-session-transport.ts`.
 *
 * Framework-free on purpose: the decisions below are what a Chat review is
 * actually about, and they are asserted in the `node` project without a DOM.
 */

import {
  chatDoorRefusalCopy,
  initialFormValues,
  isChatPending,
  type ChatPending,
} from "./chat-agent";
import { sanitizeCitedAnswer } from "./chat-citations";
import type { ChatCitation } from "./chat-contract";
import type { ChatOutput, ChatToolCall } from "./chat";
import type { SidecarDoneFrame } from "./chat-session-transport";
import { CHAT_COVERAGE_MISSING_COPY } from "./workbench-modes";

/**
 * Everything a resume needs to finish the turn it belongs to.
 *
 * HELD IN A REF by the surface rather than in state: it is not rendered, and a
 * resume that read a stale render's copy of the request body would re-send the
 * previous turn's question. It is cleared the moment the turn is written down.
 */
export interface OpenTurn {
  conversationId: string;
  userText: string;
  replaceLastTurn: boolean;
  request: Record<string, unknown>;
  fallbackCitations: ChatCitation[];
  coverageMessage: string | null;
}

/** One message the settled turn writes down, user leg and assistant leg. */
export interface ChatTurnFrame {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  thinking?: string;
  toolCalls?: ChatToolCall[];
  outputs?: ChatOutput[];
}

/** The part of an assemble a turn request is built from. */
export interface ChatTurnAssemble {
  systemPrompt: string;
  numberedBodies: string;
  indexSlice: string;
  historySlice: Array<{ role: "user" | "assistant"; content: string }>;
  citations: ChatCitation[];
  chatModel: { model: string | null };
}

export interface ChatTurnRequestInput {
  query: string;
  conversationId: string;
  assembled: ChatTurnAssemble;
  skill?: string | null;
}

/**
 * THE AGENT TURN, not the Epic 3 one-shot.
 *
 * `tools: true` is what makes the sidecar run the loop, and the pre-assembled
 * context still rides along — the Agent starts from what one retrieval already
 * found and searches for whatever that missed, rather than starting cold.
 *
 * `coverage: true` EVEN WHEN THE ASSEMBLE SAID OTHERWISE: with tools on, "one
 * retrieval found nothing" is the reason to look, not the answer. The sidecar's
 * own guard says the same thing from the other side.
 */
export function chatTurnRequest({
  query,
  conversationId,
  assembled,
  skill,
}: ChatTurnRequestInput): Record<string, unknown> {
  return {
    stream: true,
    tools: true,
    query,
    coverage: true,
    system: assembled.systemPrompt,
    context: assembled.numberedBodies,
    indexSlice: assembled.indexSlice,
    messages: assembled.historySlice,
    citations: assembled.citations,
    skill: skill ?? null,
    conversationId,
    model: { model: assembled.chatModel.model },
  };
}

/** The turn is held open by a question the owner has to answer. */
export interface ChatTurnHeldOpen {
  kind: "pending";
  pending: ChatPending;
  /** Present only for a form: the blanks it opens with. */
  formValues?: Record<string, string | string[]>;
}

/** The turn is over and these are the messages it writes down. */
export interface ChatTurnSettled {
  kind: "settled";
  frames: ChatTurnFrame[];
  replaceLastTurn: boolean;
}

export type ChatTurnOutcome = ChatTurnHeldOpen | ChatTurnSettled;

/**
 * What to do with a `done` frame: hold the turn open, or write it down.
 *
 * A `pending` frame is NOT the end of the turn. Nothing is persisted, the rows
 * stay on screen, and the surface draws the form or the approval — because the
 * answer the owner is about to give is part of this turn, and a half-turn
 * written into the conversation would read as an answer the Agent never gave.
 *
 * A PURE DECISION, not an effect: the surface owns the refs and the state
 * writes each outcome implies, so this stays reviewable on its own.
 */
export function settleTurn(turn: OpenTurn, frame: SidecarDoneFrame): ChatTurnOutcome {
  if (isChatPending(frame.pending)) {
    const pending = frame.pending;
    return pending.kind === "skill_form"
      ? { kind: "pending", pending, formValues: initialFormValues(pending.fields) }
      : { kind: "pending", pending };
  }
  const sanitized = sanitizeCitedAnswer(
    frame.content ?? "",
    frame.citations ?? turn.fallbackCitations,
  );
  // AN EMPTY ANSWER WITH NO TOOL CALLS is the coverage-missing case the assemble
  // predicted.
  //
  // `turn.coverageMessage` is a PRESERVED HISTORICAL SHAPE, not a live branch:
  // `sanitizeCitedAnswer` already substitutes `CHAT_COVERAGE_MISSING_COPY` when
  // no marker survives, so `sanitized.content` is never empty and the middle
  // term never runs. It is kept exactly as it was because the store would undo
  // any other answer anyway — `persistChatTurn` re-runs `isCoverageSentence`
  // and `sanitizeCitedAnswer` with the DEFAULT copy (`chat.ts:480,483`), so a
  // per-query sentence written here would be rewritten back to the generic one
  // on the way into the conversation.
  const content = sanitized.content || turn.coverageMessage || CHAT_COVERAGE_MISSING_COPY;
  return {
    kind: "settled",
    replaceLastTurn: turn.replaceLastTurn,
    frames: [
      { id: "u", role: "user", content: turn.userText },
      {
        id: "a",
        role: "assistant",
        content,
        citations: sanitized.citations,
        thinking: frame.thinking,
        toolCalls: Array.isArray(frame.toolCalls) ? frame.toolCalls : [],
        outputs: Array.isArray(frame.outputs) ? frame.outputs : [],
      },
    ],
  };
}

/**
 * The body that answers a pause: Approve / Deny a command, Submit / Cancel a form.
 *
 * DENY AND CANCEL STILL GO BACK TO THE SIDECAR, and that is the point rather
 * than waste: the sidecar is the only thing that can end the turn honestly — it
 * marks the row denied or cancelled, writes the sentence saying the command did
 * not run, and hands back everything gathered before the question. A client that
 * closed the modal locally would leave a turn that silently never happened.
 *
 * It is the ORIGINAL request plus `resume`, which is why the turn is held in a
 * ref: re-deriving the body from the current render would re-ask the previous
 * question.
 */
export function resumeRequest(
  turn: OpenTurn,
  pending: ChatPending,
  approved: boolean,
  formValues: Record<string, string | string[]>,
): Record<string, unknown> {
  return {
    ...turn.request,
    resume: {
      capabilityId: pending.capabilityId,
      approved,
      ...(pending.kind === "skill_form" ? { answers: formValues } : {}),
    },
  };
}

/**
 * The door's refusal, in words that name the fix.
 *
 * `disabled` and `unauthorized` are the two failures an owner can actually do
 * something about, and both are about the API + MCP pane rather than about
 * Chat. Every other cause keeps its own message.
 */
export function turnFailureCopy(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "Chat failed.";
  return chatDoorRefusalCopy(message) ?? message;
}
