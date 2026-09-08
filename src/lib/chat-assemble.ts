/**
 * The retrieval door a Chat turn opens before it asks anything (DW-587).
 *
 * ONE JOB: post the question to `/retrieve` and say what came back. The
 * assemble is what gives the Agent leg its system prompt, its numbered bodies
 * and its citations, so it happens BEFORE the sidecar is called and its refusal
 * ends the turn before a provider is ever reached.
 *
 * Separate from `chat-pending-turn.ts`, which by its own design never fetches:
 * that module turns an assemble into a request body and reads the `done` frame,
 * and keeping the fetch out of it is what lets its rules be asserted with no
 * network at all.
 *
 * Framework-free, and `send` is the ONE import taken from
 * `@/lib/workbench-request` — the mounted Chat suites replace that whole module
 * with `{ send }`.
 */

import type { ChatCitation, ChatExportMessage } from "./chat-contract";
import { send } from "./workbench-request";

/**
 * A canvas message the history slice is built FROM.
 *
 * Named for its source rather than for the slice, and deliberately NOT
 * `AssembleHistoryMessage`: `wiki-retrieve.ts` already exports that name in this
 * directory with an incompatible shape (`{role, content}` — the kernel's side of
 * the wire, after this slice has been narrowed), and an import fixed by
 * autocomplete would pick the wrong one and still typecheck at some call sites.
 */
export interface ChatHistorySource {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
}

/** Everything `/retrieve` hands back for one question. */
export interface AssembleResponse {
  coverage: boolean;
  coverageMessage: string | null;
  citations: ChatCitation[];
  numberedBodies: string;
  systemPrompt: string;
  indexSlice: string;
  historySlice: Array<{ role: "user" | "assistant"; content: string }>;
  vectorPhase: { status: string; message?: string };
  chatModel: {
    provider: string | null;
    model: string | null;
    configured: boolean;
    baseUrl?: string;
  };
}

export interface AssembleTurnInput {
  wikiId: string;
  query: string;
  retrievalMode: "wiki" | "sources";
  tokenBudget: number;
  historyDepth: number;
  history: ChatExportMessage[];
}

/** The assemble answered with something that is not an assemble. */
export const RETRIEVE_FAILED_COPY = "Retrieve failed.";

/**
 * Assemble the context for one turn.
 *
 * `coverage` IS THE SHAPE GUARD, not a detail of the answer: `send` hands back
 * `{}` for a 2xx whose body would not parse, and every other field this turn
 * reads — the system prompt, the numbered bodies, whether a Chat model is even
 * configured — would then be `undefined` in a request the sidecar accepts. One
 * boolean decides that the door answered at all.
 */
export async function assembleTurn({
  wikiId,
  query,
  retrievalMode,
  tokenBudget,
  historyDepth,
  history,
}: AssembleTurnInput): Promise<AssembleResponse> {
  const assembled = await send<AssembleResponse>(
    `/api/v1/projects/${encodeURIComponent(wikiId)}/retrieve`,
    {
      method: "POST",
      body: JSON.stringify({
        query,
        retrievalMode,
        tokenBudget,
        historyDepth,
        history,
      }),
    },
  );
  if (typeof assembled.coverage !== "boolean") {
    throw new Error(RETRIEVE_FAILED_COPY);
  }
  return assembled;
}

/**
 * The transcript the assemble is given, in the export shape the kernel reads.
 *
 * `createdAt` is EMPTY on purpose: the canvas does not hold one, and the
 * assemble uses history for its budget and its ordering rather than for its
 * timestamps. `citations` defaults to `[]` so a message with none still carries
 * the key the reader looks for.
 */
export function chatHistorySlice(
  messages: readonly ChatHistorySource[],
): ChatExportMessage[] {
  return messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    citations: message.citations ?? [],
    createdAt: "",
  }));
}
