/**
 * The sidecar chat wire, extracted out of `ChatCanvas.tsx` (DW-444).
 *
 * This module owns exactly one thing: how a turn travels. The POST through the
 * one authenticated loopback door, the byte reader, the five locked SSE event
 * names, and the `done` frame it hands back. It knows nothing about
 * conversations, coverage, citations or persistence — those are the turn's
 * rules and live in `chat-pending-turn.ts`.
 *
 * Framework-free on purpose: the surface passes a handler sink, so every rule
 * below is executable in the `node` project without mounting Chat.
 */

import { isChatToolRow, type ChatToolRow } from "./chat-agent";
import type { ChatCitation } from "./chat-contract";
import type { ChatOutput, ChatToolCall } from "./chat";
import { loopbackFetch } from "./loopback-client";
import { SIDECAR_SSE_EVENTS, sidecarChatUrl, type SidecarSseEvent } from "./sidecar";
import { readJsonBody, unconfirmedCause } from "./workbench-request";

/** The `done` frame, as the sidecar sends it. `pending` holds an open question. */
export interface SidecarDoneFrame {
  content?: string;
  thinking?: string;
  citations?: ChatCitation[];
  toolCalls?: ChatToolCall[];
  outputs?: ChatOutput[];
  pending?: unknown;
}

/**
 * Where a streaming turn's pieces go.
 *
 * A sink rather than a return value because the point of the stream is that the
 * owner sees the answer arrive; the surface decides what "seeing" means.
 */
export interface SidecarTurnHandlers {
  onDelta: (delta: string) => void;
  onThinking: (thinking: string) => void;
  onToolRow: (row: ChatToolRow) => void;
}

/** The door refused before a stream existed. */
export const SIDECAR_TURN_FAILED_COPY = "Sidecar chat failed.";
/** An `error` frame with nothing to say. */
export const SIDECAR_TURN_ERROR_COPY = "Chat failed.";
/** The stream closed without a `done` frame. */
export const SIDECAR_TURN_INCOMPLETE_COPY = "Chat ended before a complete answer.";

// ANCHORED TO A LINE START because only a line start declares an event name: an
// unanchored match reads the literal text `event: done` inside a `data:` payload
// as a done frame and ends the turn on the model's own words (DW-582). The wire
// agrees — `formatSse` emits `event:` as the block's first line, and its
// `JSON.stringify` escapes newlines, so a payload can never forge one.
const EVENT_RE = /^event:\s*(\w+)/m;
const DATA_RE = /data:\s*({[\s\S]*})/;

export interface SidecarSseBlock {
  event: SidecarSseEvent;
  data: Record<string, unknown>;
}

/**
 * One SSE block, parsed — or `null` when it is not one of the locked five.
 *
 * AN UNKNOWN NAME IS IGNORED, NOT AN ERROR: a heartbeat or a future sixth event
 * arriving mid-turn must not kill an answer the owner is already reading.
 */
export function readSidecarSseBlock(block: string): SidecarSseBlock | null {
  const event = EVENT_RE.exec(block)?.[1];
  if (!event || !SIDECAR_SSE_EVENTS.includes(event as SidecarSseEvent)) {
    return null;
  }
  const dataMatch = DATA_RE.exec(block);
  let data: Record<string, unknown> = {};
  if (dataMatch) {
    try {
      data = JSON.parse(dataMatch[1]) as Record<string, unknown>;
    } catch {
      // UNUSABLE IS UNKNOWN, NOT FATAL — the same rule as a sixth event name.
      // An unguarded parse throws a raw `SyntaxError` that escapes the reader
      // and reaches the owner as the JSON parser's own sentence (DW-583).
      return null;
    }
  }
  return { event: event as SidecarSseEvent, data };
}

/**
 * Apply one block: feed the sink, hand back a `done` frame, or throw.
 *
 * `cancelled` throws an `AbortError` rather than an ordinary failure so the
 * caller stays SILENT — the owner pressed Stop and does not need to be told
 * that stopping worked.
 */
export function applySidecarSseBlock(
  block: string,
  handlers: SidecarTurnHandlers,
): SidecarDoneFrame | null {
  const parsed = readSidecarSseBlock(block);
  if (!parsed) return null;
  const { event, data } = parsed;
  if (event === "agent") {
    if (typeof data.delta === "string" && data.delta) handlers.onDelta(data.delta);
    if (typeof data.thinking === "string" && data.thinking) {
      handlers.onThinking(data.thinking);
    }
    // A TOOL ROW ON `agent`, not on a sixth event name (the five are locked).
    // The surface merges it by id so the announce and the outcome are one row.
    if (isChatToolRow(data.toolRow)) handlers.onToolRow(data.toolRow);
    return null;
  }
  if (event === "done") return data as SidecarDoneFrame;
  if (event === "error") {
    throw new Error(
      typeof data.message === "string" ? data.message : SIDECAR_TURN_ERROR_COPY,
    );
  }
  if (event === "cancelled") throw new DOMException("cancelled", "AbortError");
  return null;
}

/**
 * Drain the SSE body and return the `done` frame.
 *
 * The trailing partial block is FLUSHED at stream end: a sidecar that closes
 * without the final `\n\n` would otherwise drop the last delta — or the `done`
 * frame itself — and the turn would fail with "ended before a complete answer"
 * while holding the complete answer in the buffer.
 */
export async function consumeSidecarStream(
  body: ReadableStream<Uint8Array>,
  handlers: SidecarTurnHandlers,
): Promise<SidecarDoneFrame> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let done: SidecarDoneFrame | null = null;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        buffer += decoder.decode();
        if (buffer.trim()) done = applySidecarSseBlock(buffer, handlers) ?? done;
        break;
      }
      buffer += decoder.decode(chunk.value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) {
        done = applySidecarSseBlock(block, handlers) ?? done;
      }
    }
  } finally {
    // EVERY EXIT RELEASES THE BODY: an `error` or `cancelled` frame throws out
    // of the loop mid-stream, and without this the body is left parked with a
    // live reader and the sidecar still holding the loopback connection open
    // (DW-584). `cancel` rather than `releaseLock` because only `cancel` runs
    // the body's own cancel algorithm — releasing the lock drains nothing.
    //
    // DELIBERATELY NOT AWAITED: the cancel algorithm is invoked synchronously,
    // so the body is released before the caller sees the turn's ending, while
    // awaiting inside a `finally` is exactly what would let a cancel's own
    // rejection replace the turn's real failure. The `.catch` is not about
    // ordering: it absorbs the rejection an already-errored stream hands back,
    // which would otherwise surface as an unhandled rejection.
    reader.cancel().catch(() => {});
  }
  if (!done) throw new Error(SIDECAR_TURN_INCOMPLETE_COPY);
  return done;
}

export interface RunSidecarTurnOptions {
  wikiId: string;
  request: Record<string, unknown>;
  handlers: SidecarTurnHandlers;
  signal?: AbortSignal;
}

/**
 * POST one turn (or one resume) to the sidecar and consume its SSE.
 *
 * ONE FUNCTION FOR BOTH because the wire shape is the same: a resume is the
 * same body with a `resume` field, and the events it produces are the same
 * five. Two readers would be two places for the `pending` handling to drift.
 */
export async function runSidecarTurn({
  wikiId,
  request,
  handlers,
  signal,
}: RunSidecarTurnOptions): Promise<SidecarDoneFrame> {
  const response = await loopbackFetch(sidecarChatUrl(wikiId), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "text/event-stream",
    },
    signal,
    body: JSON.stringify(request),
  });
  if (!response.ok || !response.body) {
    // NO STREAM IS READ on a refusal: the body is the door's reason, not an
    // answer, and the owner is owed the reason rather than a generic failure.
    //
    // The read is GUARDED because this branch also takes an `ok` response with
    // no body (DW-717): the gate rethrows the raw cause on a 2xx whose body
    // read dies, and letting it escape here would surface `Failed to fetch` or
    // `signal timed out` to a caller whose whole contract is this module's own
    // sentence. Nothing was written by the sidecar in that case — no turn ran —
    // so the fallback is the honest answer, and no unknown-outcome vocabulary
    // belongs on a door that never opened.
    let failed: { error?: string } = {};
    try {
      failed = await readJsonBody<{ error?: string }>(response);
    } catch (cause) {
      if (!unconfirmedCause(cause)) throw cause;
    }
    throw new Error(failed.error || SIDECAR_TURN_FAILED_COPY);
  }
  return consumeSidecarStream(response.body, handlers);
}
