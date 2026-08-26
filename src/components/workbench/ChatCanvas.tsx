"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { sanitizeCitedAnswer } from "@/lib/chat-citations";
import { ChatBody } from "./ChatBody";
import {
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_TOKEN_BUDGET_DEFAULT,
  CHAT_TOKEN_BUDGET_MAX,
  CHAT_TOKEN_BUDGET_MIN,
  type ChatCitation,
  type ChatExportMessage,
} from "@/lib/chat-contract";
import { SIDECAR_SSE_EVENTS, sidecarChatUrl } from "@/lib/sidecar";
import { send } from "@/lib/workbench-request";
import {
  CHAT_COMPOSER_PLACEHOLDER,
  CHAT_COVERAGE_MISSING_COPY,
  CHAT_MODEL_MISSING_COPY,
  CHAT_SIDECAR_UP_COPY,
  CHAT_VECTOR_FALLBACK_COPY,
} from "@/lib/workbench-modes";
import {
  selectionFromContentPath,
  workspaceSelection,
  type TreeSelection,
} from "@/lib/workbench-tree";
import type { ChatOutput, ChatToolCall } from "@/lib/chat";
import {
  intakeReport,
  intakeShouldRefresh,
  submitIntakeFiles,
} from "@/lib/workbench-intake-client";
import { requestDataVersionCheck } from "@/lib/workbench-data-version";
import {
  COMPOSER_TOOLS,
  FORM_CANCEL_LABEL,
  FORM_SUBMIT_LABEL,
  SHELL_APPROVAL_TITLE,
  SHELL_APPROVE_LABEL,
  SHELL_DENY_LABEL,
  SKILL_CLEARED_COPY,
  SKILL_SCAN_URL,
  chatDoorRefusalCopy,
  formIsSubmittable,
  initialFormValues,
  isChatPending,
  isChatToolRow,
  matchSkills,
  mergeToolRow,
  outputChipLabel,
  parseSkillCommand,
  selectedSkillSummary,
  shellApprovalReasonCopy,
  shellCommandLine,
  skillSelectedCopy,
  staleSkillCopy,
  toolRowLabel,
  type ChatPending,
  type ChatToolRow,
  type SkillSummary,
} from "@/lib/chat-agent";

export interface ChatCanvasProps {
  wikiId: string;
  readOnly: boolean;
  onDockPreview: (selection: TreeSelection) => void;
}

interface ConversationRow {
  id: string;
  title: string;
  name?: string;
  retrievalMode?: "wiki" | "sources";
  tokenBudget?: number;
  historyDepth?: number;
  selectedSkill?: string;
  messages?: CanvasMessage[];
}

interface CanvasMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  thinking?: string;
  /** Tool rows and outputs, persisted with the turn (Stories 8.5 / 8.8). */
  toolCalls?: ChatToolCall[];
  outputs?: ChatOutput[];
}

interface AssembleResponse {
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

/** The `done` frame, as the sidecar sends it. `pending` holds an open question. */
interface SidecarDone {
  content?: string;
  thinking?: string;
  citations?: ChatCitation[];
  toolCalls?: ChatToolCall[];
  outputs?: ChatOutput[];
  pending?: unknown;
}

/**
 * Everything a resume needs to finish the turn it belongs to.
 *
 * HELD IN A REF rather than in state: it is not rendered, and a resume that read
 * a stale render's copy of the request body would re-send the previous turn's
 * question. It is cleared the moment the turn is written down.
 */
interface OpenTurn {
  conversationId: string;
  userText: string;
  replaceLastTurn: boolean;
  request: Record<string, unknown>;
  fallbackCitations: ChatCitation[];
  coverageMessage: string | null;
}

function thinkingLines(text: string): string[] {
  return text.split(/\n/).filter((line) => line.trim().length > 0).slice(-5);
}

export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps) {
  const [conversations, setConversations] = useState<ConversationRow[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<CanvasMessage[]>([]);
  const [composer, setComposer] = useState("");
  const drafts = useRef<Record<string, string>>({});
  const [retrievalMode, setRetrievalMode] = useState<"wiki" | "sources">("wiki");
  const [tokenBudget, setTokenBudget] = useState(CHAT_TOKEN_BUDGET_DEFAULT);
  const [historyDepth, setHistoryDepth] = useState(CHAT_HISTORY_DEPTH_DEFAULT);
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [citationsOpen, setCitationsOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [vectorNote, setVectorNote] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Epic 8 state. `liveRows` are the rows of the turn CURRENTLY streaming; a
  // settled turn's rows live on the message, because they were persisted with it.
  const [liveRows, setLiveRows] = useState<ChatToolRow[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedSkill, setSelectedSkill] = useState<string | undefined>(undefined);
  const [skillPicker, setSkillPicker] = useState<string | null>(null);
  const [skillNote, setSkillNote] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatPending | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | string[]>>({});
  const liveRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendInFlight = useRef(false);
  const saveInFlight = useRef(false);
  const loadSeq = useRef(0);
  const persistSeq = useRef(0);
  const patchChain = useRef(Promise.resolve());
  /**
   * The loopback token this browser presents to the sidecar.
   *
   * THE WORKBENCH IS A CLIENT OF ITS OWN DOOR. Chat runs on the sidecar, the
   * sidecar is behind the API + MCP switch and its token, and the Workbench
   * reaches it from the browser — so it has to send the token like anything else.
   * It comes from `/api/v1/loopback-settings`, which is owner-gated and is the
   * same read the Settings pane's Show / Copy controls use.
   */
  const doorToken = useRef<string | null>(null);
  /**
   * Executables the owner approved IN THIS CONVERSATION.
   *
   * Held here rather than on the sidecar because it is per conversation, and the
   * sidecar is stateless between turns by design. Cleared on every switch — an
   * approval carried into a different conversation would be an allow-all the
   * owner never granted.
   */
  const approvedExecutables = useRef<string[]>([]);
  const turnRef = useRef<OpenTurn | null>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  const empty = messages.length === 0 && !streaming;

  const loadList = useCallback(async () => {
    const body = await send<{ conversations?: ConversationRow[] }>(
      "/api/chat/conversations",
      { method: "GET" },
    );
    setConversations(body.conversations ?? []);
    return body.conversations ?? [];
  }, []);

  const loadConversation = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
    if (seq !== loadSeq.current) return;
    const conversation = body.conversation;
    if (!conversation) {
      setMessages([]);
      setError("Conversation not found.");
      return;
    }
    setMessages(conversation.messages ?? []);
    setRetrievalMode(conversation.retrievalMode === "sources" ? "sources" : "wiki");
    setTokenBudget(conversation.tokenBudget ?? CHAT_TOKEN_BUDGET_DEFAULT);
    setHistoryDepth(conversation.historyDepth ?? CHAT_HISTORY_DEPTH_DEFAULT);
    setSelectedSkill(conversation.selectedSkill);
    setConversations((current) =>
      current.map((item) => (item.id === id ? { ...item, ...conversation } : item)),
    );
  }, []);

  useEffect(() => {
    void loadList()
      .then((rows) => {
        const wanted =
          typeof window !== "undefined"
            ? new URLSearchParams(window.location.search).get("conversation")
            : null;
        const next = rows.find((row) => row.id === wanted) ?? rows[0];
        if (next) {
          setActiveId(next.id);
          return loadConversation(next.id);
        }
      })
      .catch((cause) => {
        setError(cause instanceof Error ? cause.message : "Chat failed.");
      });
  }, [loadList, loadConversation]);

  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  /**
   * Esc closes the form, the approval, or the Skill picker — without running
   * anything (Stories 8.7 / 8.9).
   *
   * ESC IS CANCEL AND DENY, not "dismiss". For a form or an approval it goes
   * through `answerPending(false)`, so the sidecar marks the row and ends the turn
   * with the sentence saying the pending tool did not run. A local close would
   * leave the owner with a transcript that stops mid-turn and a command whose fate
   * nothing recorded.
   *
   * ONE LISTENER, and the picker is checked first because it is the shallower
   * overlay: pressing Esc with both open should close the picker, not deny the
   * command underneath it.
   */
  useEffect(() => {
    if (!pending && skillPicker === null) return;
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      if (skillPicker !== null) {
        setSkillPicker(null);
        return;
      }
      void answerPending(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // `answerPending` closes over `pending` and `formValues`, both in the deps.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending, skillPicker, formValues]);

  /**
   * The door's credential and the Skills on disk, both read once on mount.
   *
   * SKILLS ARE SCANNED, NOT INSTALLED (Story 8.6): this asks the sidecar what is
   * on disk right now, so a `SKILL.md` the owner dropped in a minute ago appears
   * without a reinstall and without a rebuild. A failure is silent on purpose —
   * no Skills is the normal state, and an error banner for it would greet every
   * owner who has never written one.
   */
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      try {
        const settings = await send<{ token?: string | null }>(
          "/api/v1/loopback-settings",
          { method: "GET" },
        );
        doorToken.current =
          typeof settings.token === "string" && settings.token ? settings.token : null;
      } catch {
        doorToken.current = null;
      }
      try {
        // A RAW fetch, not `send`: the sidecar is another origin, and `send` is
        // the kernel's parsed-body helper (it answers with the body, never a
        // `Response`). Naming it `scan` keeps the two apart at a glance.
        const scan = await fetch(SKILL_SCAN_URL, {
          cache: "no-store",
          signal: controller.signal,
          headers: doorToken.current
            ? { authorization: `Bearer ${doorToken.current}` }
            : {},
        });
        if (!scan.ok) return;
        const body = (await scan.json()) as { skills?: SkillSummary[] };
        setSkills(Array.isArray(body.skills) ? body.skills : []);
      } catch {
        // Sidecar down, API off, or no Skills. All three mean "no list".
      }
    })();
    return () => controller.abort();
  }, []);

  function stopTurn() {
    abortRef.current?.abort();
  }

  function switchConversation(id: string) {
    abortRef.current?.abort();
    setStreaming(false);
    if (activeId) drafts.current[activeId] = composer;
    setActiveId(id);
    setComposer(drafts.current[id] ?? "");
    setError(null);
    setVectorNote(null);
    // EVERYTHING PER-TURN IS DROPPED. A pending approval belongs to the
    // conversation that raised it, and an approved executable must not follow the
    // owner into another one — that would be the allow-all this design refuses.
    setLiveRows([]);
    setPending(null);
    setSkillPicker(null);
    setSkillNote(null);
    approvedExecutables.current = [];
    void loadConversation(id);
  }

  async function createConversation() {
    if (readOnly) return;
    if (activeId) drafts.current[activeId] = composer;
    const body = await send<{ conversation?: ConversationRow }>("/api/chat/conversations", {
      method: "POST",
      body: JSON.stringify({
        retrievalMode,
        tokenBudget,
        historyDepth,
      }),
    });
    if (!body.conversation) return;
    setConversations((current) => [body.conversation!, ...current]);
    setActiveId(body.conversation.id);
    setMessages([]);
    setComposer("");
    drafts.current[body.conversation.id] = "";
  }

  async function deleteConversation(id: string) {
    if (readOnly) return;
    abortRef.current?.abort();
    await send(`/api/chat/conversations/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
    const next = conversations.filter((item) => item.id !== id);
    setConversations(next);
    delete drafts.current[id];
    if (activeId === id) {
      const fallback = next[0];
      setActiveId(fallback?.id ?? null);
      setMessages([]);
      setComposer(fallback ? (drafts.current[fallback.id] ?? "") : "");
      if (fallback) void loadConversation(fallback.id);
    }
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    setRenameId(null);
    if (!name || readOnly) return;
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify({ name }),
      },
    );
    if (body.conversation) {
      setConversations((current) =>
        current.map((item) => (item.id === id ? { ...item, ...body.conversation } : item)),
      );
    }
  }

  function patchActive(patch: Record<string, unknown>) {
    if (!activeId || readOnly) return;
    const id = activeId;
    patchChain.current = patchChain.current
      .then(async () => {
        const body = await send<{ conversation?: ConversationRow }>(
          `/api/chat/conversations/${encodeURIComponent(id)}`,
          {
            method: "PATCH",
            body: JSON.stringify(patch),
          },
        );
        if (body.conversation) {
          setConversations((current) =>
            current.map((item) =>
              item.id === id ? { ...item, ...body.conversation } : item,
            ),
          );
        }
      })
      .catch(() => undefined);
  }

  function dockCitation(citation: ChatCitation) {
    onDockPreview(selectionFromContentPath(citation.path));
  }

  function citeNumber(n: number, citations: ChatCitation[] | undefined) {
    const row = citations?.find((item) => item.n === n);
    if (row) dockCitation(row);
  }

  async function persistFrames(
    id: string,
    frames: CanvasMessage[],
    options?: { replaceLastTurn?: boolean },
  ) {
    const seq = ++persistSeq.current;
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          persist: true,
          replaceLastTurn: options?.replaceLastTurn === true,
          messages: frames.map((frame) => ({
            role: frame.role,
            content: frame.content,
            citations: frame.citations ?? [],
            ...(frame.thinking ? { thinking: frame.thinking } : {}),
            // PERSISTED WITH THE TURN, which is what makes "survives restart with
            // the Conversation" true for a chip and auditable for a tool row.
            ...(frame.toolCalls?.length ? { toolCalls: frame.toolCalls } : {}),
            ...(frame.outputs?.length ? { outputs: frame.outputs } : {}),
          })),
        }),
      },
    );
    if (!body.conversation) throw new Error("Persist failed.");
    if (seq !== persistSeq.current) return;
    setMessages(body.conversation.messages ?? []);
    setConversations((current) =>
      current.map((item) =>
        item.id === id ? { ...item, ...body.conversation } : item,
      ),
    );
  }

  function clearOptimistic() {
    setMessages((current) => current.filter((item) => !item.id.startsWith("pending-")));
  }

  async function sendTurn(
    text: string,
    conversationId: string,
    options?: { history?: CanvasMessage[]; replaceLastTurn?: boolean },
  ): Promise<boolean> {
    const trimmed = text.trim();
    if (!trimmed || streaming || sendInFlight.current || readOnly) return false;
    sendInFlight.current = true;
    setStreaming(true);
    setMessages((current) => [
      ...current,
      { id: `pending-${Date.now()}`, role: "user", content: trimmed },
    ]);
    setError(null);
    setVectorNote(null);
    setStreamText("");
    setStreamThinking("");
    const historySource = options?.history ?? messages;
    const history: ChatExportMessage[] = historySource.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      citations: message.citations ?? [],
      createdAt: "",
    }));
    try {
      const assembled = await send<AssembleResponse>(
        `/api/v1/projects/${encodeURIComponent(wikiId)}/retrieve`,
        {
          method: "POST",
          body: JSON.stringify({
            query: trimmed,
            retrievalMode,
            tokenBudget,
            historyDepth,
            history,
          }),
        },
      );
      if (typeof assembled.coverage !== "boolean") {
        throw new Error("Retrieve failed.");
      }
      if (assembled.vectorPhase?.status === "failed") {
        setVectorNote(assembled.vectorPhase.message || CHAT_VECTOR_FALLBACK_COPY);
      }
      if (!assembled.chatModel.configured) {
        setError(CHAT_MODEL_MISSING_COPY);
        clearOptimistic();
        return false;
      }
      // THE AGENT TURN, not the Epic 3 one-shot. `tools: true` is what makes the
      // sidecar run the loop, and the pre-assembled context still rides along —
      // the Agent starts from what one retrieval already found and searches for
      // whatever that missed, rather than starting cold.
      //
      // `coverage: true` even when the assemble said otherwise: with tools on,
      // "one retrieval found nothing" is the reason to look, not the answer. The
      // sidecar's own guard says the same thing from the other side.
      const request = {
        stream: true,
        tools: true,
        query: trimmed,
        coverage: true,
        system: assembled.systemPrompt,
        context: assembled.numberedBodies,
        indexSlice: assembled.indexSlice,
        messages: assembled.historySlice,
        citations: assembled.citations,
        skill: selectedSkill ?? null,
        approvedExecutables: approvedExecutables.current,
        model: { model: assembled.chatModel.model },
      };
      turnRef.current = {
        conversationId,
        userText: trimmed,
        replaceLastTurn: options?.replaceLastTurn === true,
        request,
        fallbackCitations: assembled.citations,
        coverageMessage: assembled.coverageMessage,
      };
      return await runSidecarTurn(request);
    } catch (cause) {
      clearOptimistic();
      if ((cause as Error).name === "AbortError") return false;
      setError(turnFailureCopy(cause));
      return false;
    } finally {
      sendInFlight.current = false;
      setStreaming(false);
      setStreamText("");
      setStreamThinking("");
      abortRef.current = null;
    }
  }

  /**
   * The door's refusal, in words that name the fix.
   *
   * `disabled` and `unauthorized` are the two failures an owner can actually do
   * something about, and both are about the API + MCP pane rather than about
   * Chat. Every other cause keeps its own message.
   */
  function turnFailureCopy(cause: unknown): string {
    const message = cause instanceof Error ? cause.message : "Chat failed.";
    return chatDoorRefusalCopy(message) ?? message;
  }

  /**
   * POST one turn (or one resume) to the sidecar and consume its SSE.
   *
   * ONE FUNCTION FOR BOTH because the wire shape is the same: a resume is the
   * same body with a `resume` field, and the events it produces are the same five.
   * Two readers would be two places for the `pending` handling to drift.
   */
  async function runSidecarTurn(
    request: Record<string, unknown>,
  ): Promise<boolean> {
    const turn = turnRef.current;
    if (!turn) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    const sidecarRes = await fetch(sidecarChatUrl(wikiId), {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "text/event-stream",
        // The Workbench presents the loopback token like any other client — see
        // `doorToken`. Absent is a legitimate state (unauthenticated access on,
        // or no token generated), and the door decides.
        ...(doorToken.current
          ? { Authorization: `Bearer ${doorToken.current}` }
          : {}),
      },
      signal: controller.signal,
      body: JSON.stringify(request),
    });
    if (!sidecarRes.ok || !sidecarRes.body) {
      const failed = (await sidecarRes.json().catch(() => ({}))) as { error?: string };
      throw new Error(failed.error || "Sidecar chat failed.");
    }
    const reader = sidecarRes.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    const doneBox: { current: SidecarDone | null } = { current: null };
    const applySseBlock = (block: string) => {
      const eventMatch = /event:\s*(\w+)/.exec(block);
      const dataMatch = /data:\s*({[\s\S]*})/.exec(block);
      const event = eventMatch?.[1];
      if (!event || !SIDECAR_SSE_EVENTS.includes(event as (typeof SIDECAR_SSE_EVENTS)[number])) {
        return;
      }
      const data = dataMatch ? (JSON.parse(dataMatch[1]) as Record<string, unknown>) : {};
      if (event === "agent") {
        if (typeof data.delta === "string" && data.delta) {
          setStreamText((current) => current + data.delta);
        }
        if (typeof data.thinking === "string" && data.thinking) {
          setStreamThinking(data.thinking);
        }
        // A TOOL ROW ON `agent`, not on a sixth event name (the five are locked).
        // Merged by id so the announce and the outcome are one row.
        if (isChatToolRow(data.toolRow)) {
          const row = data.toolRow;
          setLiveRows((current) => mergeToolRow(current, row));
        }
      } else if (event === "done") {
        doneBox.current = data as SidecarDone;
      } else if (event === "error") {
        throw new Error(typeof data.message === "string" ? data.message : "Chat failed.");
      } else if (event === "cancelled") {
        throw new DOMException("cancelled", "AbortError");
      }
    };
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        buffer += decoder.decode();
        if (buffer.trim()) applySseBlock(buffer);
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split("\n\n");
      buffer = blocks.pop() ?? "";
      for (const block of blocks) applySseBlock(block);
    }
    if (!doneBox.current) {
      throw new Error("Chat ended before a complete answer.");
    }
    return settleTurn(doneBox.current);
  }

  /**
   * What to do with a `done` frame: hold the turn open, or write it down.
   *
   * A `pending` frame is NOT the end of the turn. Nothing is persisted, the rows
   * stay on screen, and the surface draws the form or the approval — because the
   * answer the owner is about to give is part of this turn, and a half-turn
   * written into the conversation would read as an answer the Agent never gave.
   */
  async function settleTurn(frame: SidecarDone): Promise<boolean> {
    const turn = turnRef.current;
    if (!turn) return false;
    if (isChatPending(frame.pending)) {
      setPending(frame.pending);
      if (frame.pending.kind === "skill_form") {
        setFormValues(initialFormValues(frame.pending.fields));
      }
      return true;
    }
    const sanitized = sanitizeCitedAnswer(
      frame.content ?? "",
      frame.citations ?? turn.fallbackCitations,
    );
    // AN EMPTY ANSWER WITH NO TOOL CALLS is the coverage-missing case the assemble
    // predicted, and the assemble's own sentence is the better one to show.
    const content =
      sanitized.content ||
      turn.coverageMessage ||
      CHAT_COVERAGE_MISSING_COPY;
    // THE SIDECAR TURN IS OVER. Drop the pause before persist so a store
    // failure cannot put Approve/Deny back over a command that already ran or
    // was already denied.
    setLiveRows([]);
    setPending(null);
    turnRef.current = null;
    await persistFrames(
      turn.conversationId,
      [
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
      { replaceLastTurn: turn.replaceLastTurn },
    );
    return true;
  }

  /**
   * Answer a pause: Approve / Deny a command, Submit / Cancel a form.
   *
   * DENY AND CANCEL STILL CALL THE SIDECAR, and that is the point rather than
   * waste: the sidecar is the only thing that can end the turn honestly — it
   * marks the row denied or cancelled, writes the sentence saying the command did
   * not run, and hands back everything gathered before the question. A client
   * that closed the modal locally would leave a turn that silently never happened.
   */
  async function answerPending(approved: boolean) {
    const turn = turnRef.current;
    const current = pending;
    if (!turn || !current) return;
    setPending(null);
    if (approved && current.kind === "shell_approval") {
      // Remembered for THIS EXECUTABLE in THIS conversation. Not an allow-all:
      // a different program asks again, and switching conversations forgets.
      const key = current.command.split("/").pop()?.toLowerCase() ?? current.command;
      if (!approvedExecutables.current.includes(key)) {
        approvedExecutables.current = [...approvedExecutables.current, key];
      }
    }
    sendInFlight.current = true;
    setStreaming(true);
    setStreamText("");
    setStreamThinking("");
    try {
      await runSidecarTurn({
        ...turn.request,
        approvedExecutables: approvedExecutables.current,
        resume: {
          pending: current,
          approved,
          ...(current.kind === "skill_form" ? { answers: formValues } : {}),
        },
      });
    } catch (cause) {
      if ((cause as Error).name !== "AbortError") {
        setError(turnFailureCopy(cause));
      }
      if (turnRef.current === turn) {
        setPending(current);
      }
      clearOptimistic();
    } finally {
      sendInFlight.current = false;
      setStreaming(false);
      setStreamText("");
      setStreamThinking("");
      abortRef.current = null;
    }
  }

  /**
   * Attach files from the composer (Story 8.5).
   *
   * THROUGH INTAKE, the one arrival path for bytes (FR-2): the file lands under
   * `raw/sources/` and auto-queues a compile, exactly as a drop on the Sources
   * tree does. A Chat-local upload would be a second door with no pipeline behind
   * it, and the Agent would then be asked about a Source that was never compiled.
   *
   * The outcome is reported in the composer's own error line rather than silently:
   * a refused CSV has to say so, or the owner will ask about a file that is not
   * there.
   */
  async function attachFiles(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || readOnly) return;
    setSkillNote(null);
    try {
      const outcomes = await submitIntakeFiles(files);
      const report = intakeReport(outcomes);
      if (report) setSkillNote(report);
      if (intakeShouldRefresh(outcomes)) requestDataVersionCheck();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Attach failed.");
    } finally {
      // Cleared so re-picking the same file fires `change` again.
      if (attachRef.current) attachRef.current.value = "";
    }
  }

  /**
   * Select or clear the Conversation's Skill (Story 8.6).
   *
   * PERSISTED ON THE CONVERSATION, through the same `patchActive` chain every
   * other conversation setting uses — a Skill held only in React state would be
   * forgotten on reload while the owner went on believing the next five turns
   * were running under it.
   */
  function pickSkill(id: string | null) {
    setSelectedSkill(id ?? undefined);
    setSkillPicker(null);
    patchActive({ selectedSkill: id });
    const chosen = id ? skills.find((skill) => skill.id === id) : null;
    setSkillNote(chosen ? skillSelectedCopy(chosen.name) : SKILL_CLEARED_COPY);
  }

  /**
   * `/skill` — a command, not a message.
   *
   * Handled BEFORE the send so it never reaches a provider: `/skill` bare clears,
   * `/skill <term>` opens the picker filtered to ENABLED Skills only, and an exact
   * name selects outright. A disabled Skill matches nothing, which is what makes
   * the switch real rather than cosmetic.
   */
  function handleSkillCommand(text: string): boolean {
    const command = parseSkillCommand(text);
    if (command.kind === "none") return false;
    setComposer("");
    if (activeId) drafts.current[activeId] = "";
    if (command.kind === "clear") {
      // A bare `/skill` with Skills available opens the picker rather than
      // clearing blind — "which Skills do I have" is the likelier question, and
      // Clear is one press away inside it.
      if (skills.some((skill) => skill.enabled)) setSkillPicker("");
      else pickSkill(null);
      return true;
    }
    const matches = matchSkills(skills, command.term);
    const exact = matches.find(
      (skill) => skill.name.toLowerCase() === command.term.toLowerCase(),
    );
    if (exact) pickSkill(exact.id);
    else if (matches.length === 1) pickSkill(matches[0].id);
    else setSkillPicker(command.term);
    return true;
  }

  async function onSend() {
    if (readOnly || pending) return;
    const text = composer.trim();
    if (!text) return;
    if (handleSkillCommand(text)) return;
    let id = activeId;
    if (!id) {
      const body = await send<{ conversation?: ConversationRow }>("/api/chat/conversations", {
        method: "POST",
        body: JSON.stringify({ retrievalMode, tokenBudget, historyDepth }),
      });
      if (!body.conversation) return;
      id = body.conversation.id;
      setConversations((current) => [body.conversation!, ...current]);
      setActiveId(id);
    }
    setComposer("");
    if (id) drafts.current[id] = "";
    const ok = await sendTurn(text, id);
    if (!ok) {
      setComposer(text);
      if (id) drafts.current[id] = text;
    }
  }

  function onComposerKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void onSend();
    }
  }

  async function regenerate() {
    if (readOnly || !activeId || messages.length < 2 || streaming) return;
    const assistant = messages.at(-1);
    const user = messages.at(-2);
    if (
      !assistant ||
      !user ||
      assistant.role !== "assistant" ||
      user.role !== "user"
    ) {
      return;
    }
    const prior = messages;
    const history = messages.slice(0, -2);
    setMessages(history);
    const ok = await sendTurn(user.content, activeId, {
      history,
      replaceLastTurn: true,
    });
    if (!ok) {
      setMessages(prior);
      setComposer(user.content);
      drafts.current[activeId] = user.content;
    }
  }

  async function saveToWiki() {
    if (!activeId || readOnly || saveInFlight.current) return;
    const assistant = [...messages].reverse().find((item) => item.role === "assistant");
    if (!assistant) return;
    saveInFlight.current = true;
    try {
      await send(`/api/chat/conversations/${encodeURIComponent(activeId)}/save`, {
        method: "POST",
        body: JSON.stringify({ messageId: assistant.id }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      saveInFlight.current = false;
    }
  }

  const lastCitations = useMemo(() => {
    return [...messages].reverse().find((item) => item.role === "assistant")?.citations ?? [];
  }, [messages]);

  /** The selected Skill, or `null` when it was disabled or deleted since. */
  const activeSkill = useMemo(
    () => selectedSkillSummary(skills, selectedSkill),
    [skills, selectedSkill],
  );

  const grouped = useMemo(() => {
    const groups = new Map<string, ChatCitation[]>();
    for (const citation of lastCitations) {
      const list = groups.get(citation.type) ?? [];
      list.push(citation);
      groups.set(citation.type, list);
    }
    return groups;
  }, [lastCitations]);

  return (
    <div className={`wb-chat${retrievalMode === "sources" ? " wb-chat--sources" : ""}`}>
      <aside className="wb-chat-sidebar" aria-label="Conversations">
        <button
          type="button"
          className="wb-chat-new"
          onClick={() => void createConversation()}
          disabled={readOnly}
        >
          New Chat
        </button>
        <ul className="wb-chat-list">
          {conversations.map((item) => {
            const label = item.name || item.title;
            const current = item.id === activeId;
            return (
              <li key={item.id}>
                {renameId === item.id ? (
                  <input
                    className="wb-chat-rename"
                    aria-label="Conversation name"
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onBlur={() => void commitRename(item.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitRename(item.id);
                      if (event.key === "Escape") setRenameId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <button
                    type="button"
                    className={`wb-chat-row${current ? " wb-chat-row--active" : ""}`}
                    aria-current={current ? "true" : undefined}
                    onClick={() => switchConversation(item.id)}
                    onDoubleClick={() => {
                      if (readOnly) return;
                      setRenameId(item.id);
                      setRenameValue(label);
                    }}
                  >
                    {label}
                  </button>
                )}
                <button
                  type="button"
                  className="wb-chat-delete"
                  aria-label={`Delete ${label}`}
                  onClick={() => void deleteConversation(item.id)}
                  disabled={readOnly}
                >
                  Delete
                </button>
              </li>
            );
          })}
        </ul>
      </aside>

      <div className="wb-chat-main">
        <div className="wb-chat-toolbar">
          <label className="wb-chat-field">
            Smart retrieval
            <select
              value={retrievalMode}
              disabled={readOnly}
              onChange={(event) => {
                const next = event.target.value === "sources" ? "sources" : "wiki";
                setRetrievalMode(next);
                void patchActive({ retrievalMode: next });
              }}
            >
              <option value="wiki">Wiki</option>
              <option value="sources">Sources-only</option>
            </select>
          </label>
          <label className="wb-chat-field">
            Context
            <input
              type="range"
              min={CHAT_TOKEN_BUDGET_MIN}
              max={CHAT_TOKEN_BUDGET_MAX}
              step={4000}
              value={tokenBudget}
              disabled={readOnly}
              onChange={(event) => {
                const next = Number(event.target.value);
                setTokenBudget(next);
                void patchActive({ tokenBudget: next });
              }}
            />
            <span>{tokenBudget.toLocaleString()} tokens</span>
          </label>
          <label className="wb-chat-field">
            History
            <input
              type="number"
              min={1}
              max={80}
              value={historyDepth}
              disabled={readOnly}
              onChange={(event) => setHistoryDepth(Number(event.target.value) || 1)}
              onBlur={() => void patchActive({ historyDepth })}
            />
          </label>
          <button
            type="button"
            onClick={() => void regenerate()}
            disabled={readOnly || streaming || messages.length < 2}
          >
            Regenerate
          </button>
          <button
            type="button"
            onClick={() => void saveToWiki()}
            disabled={readOnly || !messages.some((item) => item.role === "assistant")}
          >
            Save to Wiki
          </button>
        </div>

        {retrievalMode === "sources" ? (
          <p className="wb-chat-sources-banner">Sources-only — citations point at Sources.</p>
        ) : null}
        {/* The Skill this conversation runs under (Story 8.6), and — when the id
            no longer resolves — the sentence saying so. A stale id running
            silently would leave the owner comparing answers against instructions
            that were never loaded. */}
        {activeSkill ? (
          <p className="wb-chat-skill">
            <span>{skillSelectedCopy(activeSkill.name)}</span>
            <button type="button" onClick={() => pickSkill(null)} disabled={readOnly}>
              Clear
            </button>
          </p>
        ) : selectedSkill ? (
          <p className="wb-chat-skill wb-chat-skill--stale" role="status">
            {staleSkillCopy(selectedSkill)}
          </p>
        ) : null}
        {skillNote ? <p className="wb-chat-skill-note">{skillNote}</p> : null}
        {vectorNote ? <p className="wb-chat-vector">{vectorNote}</p> : null}
        {error ? <p className="wb-chat-error">{error}</p> : null}

        <div className="wb-chat-log" aria-live="polite" ref={liveRef}>
          {empty ? <p className="wb-empty">{CHAT_SIDECAR_UP_COPY}</p> : null}
          {messages.map((message) => (
            <article
              key={message.id}
              className={`wb-chat-msg wb-chat-msg--${message.role}`}
            >
              <h3 className="wb-chat-msg-role">
                {message.role === "user" ? "You" : "Assistant"}
              </h3>
              {message.thinking ? (
                <details
                  className="wb-chat-thinking"
                  open={thinkingOpen[message.id] === true}
                  onToggle={(event) =>
                    setThinkingOpen((current) => ({
                      ...current,
                      [message.id]: (event.target as HTMLDetailsElement).open,
                    }))
                  }
                >
                  <summary>Thinking</summary>
                  <pre>{message.thinking}</pre>
                </details>
              ) : null}
              {/* WHAT THE AGENT DID, above what it said (Story 8.5). Persisted
                  with the message, so it is still here after a reload — the row
                  is the audit trail for the paragraph below it. */}
              {message.toolCalls?.length ? (
                <ul className="wb-chat-tools">
                  {message.toolCalls.map((row) => (
                    <li key={row.id} className="wb-chat-tool">
                      <span className="wb-chat-tool-name">{toolRowLabel(row.tool)}</span>
                      {row.detail ? (
                        <span className="wb-chat-tool-detail">{row.detail}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="wb-chat-body">
                {/* Markdown since Story 7.8 — GFM, Mermaid and KaTeX — with
                    `[n]` still a citation button. The face stays system sans:
                    it comes from `.wb-chat-body`, and `ChatBody` names none. */}
                <ChatBody
                  content={message.content}
                  onCite={(n) => citeNumber(n, message.citations)}
                />
              </div>
              {/* Output chips (Story 8.8). A chip docks the Preview at the
                  sidecar's copy of the file — a `workspace` pick, because these
                  bytes are not in the wiki and the kernel has never seen them. */}
              {message.outputs?.length ? (
                <ul className="wb-chat-outputs">
                  {message.outputs.map((output) => (
                    <li key={output.path}>
                      <button
                        type="button"
                        className="wb-chat-output"
                        onClick={() => onDockPreview(workspaceSelection(output.path))}
                      >
                        {outputChipLabel(output)}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </article>
          ))}
          {streaming || liveRows.length > 0 ? (
            <article className="wb-chat-msg wb-chat-msg--assistant">
              <h3 className="wb-chat-msg-role">Assistant</h3>
              {/* The SAME rows, live. Announced before the tool runs, so a
                  fifteen-second search reads as work rather than as a hang. */}
              {liveRows.length > 0 ? (
                <ul className="wb-chat-tools" aria-live="polite">
                  {liveRows.map((row) => (
                    <li key={row.id} className={`wb-chat-tool wb-chat-tool--${row.state}`}>
                      <span className="wb-chat-tool-name">{toolRowLabel(row.tool)}</span>
                      <span className="wb-chat-tool-detail">
                        {row.detail || row.state}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
              {streamThinking ? (
                <div className="wb-chat-thinking wb-chat-thinking--live" aria-live="polite">
                  {thinkingLines(streamThinking).map((line, index, all) => (
                    <p
                      key={`${line}-${index}`}
                      style={{ opacity: (index + 1) / all.length }}
                    >
                      {line}
                    </p>
                  ))}
                </div>
              ) : null}
              {/* The SAME renderer as a settled turn, so a diagram or a table
                  does not appear only once the stream ends. No `onCite`: the
                  citation list arrives with `done`, so a marker rendered now
                  has nothing to dock and is text until it does. */}
              <div className="wb-chat-body">
                <ChatBody content={streamText} />
              </div>
            </article>
          ) : null}
        </div>

        {lastCitations.length > 0 ? (
          <details
            className="wb-chat-refs"
            open={citationsOpen}
            onToggle={(event) =>
              setCitationsOpen((event.target as HTMLDetailsElement).open)
            }
          >
            <summary>Cited references</summary>
            {[...grouped.entries()].map(([type, rows]) => (
              <section key={type}>
                <h4>{type}</h4>
                <ul>
                  {rows.map((row) => (
                    <li key={`${row.n}:${row.path}`}>
                      <button type="button" onClick={() => dockCitation(row)}>
                        [{row.n}] {row.title}
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
          </details>
        ) : null}

        {/* Composer tools (Story 8.5): Attach · Web search · AnyTXT · Skills ·
            Smart retrieval. The middle two are HINTS — they write an instruction
            into the composer rather than forcing a tool call, because the Agent
            picking its own tools is the criterion and a button that called one
            would put the owner back in the picking seat. */}
        <div className="wb-chat-tools-bar" role="group" aria-label="Composer tools">
          {COMPOSER_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className={`wb-chat-tool-btn wb-chat-tool-btn--${tool.id}`}
              title={tool.title}
              disabled={readOnly || streaming}
              onClick={() => {
                if (tool.id === "attach") {
                  attachRef.current?.click();
                  return;
                }
                if (tool.id === "skills") {
                  setSkillPicker("");
                  return;
                }
                if (tool.id === "retrieval") {
                  const next = retrievalMode === "wiki" ? "sources" : "wiki";
                  setRetrievalMode(next);
                  void patchActive({ retrievalMode: next });
                  return;
                }
                setComposer((current) =>
                  current.startsWith(tool.hint) ? current : tool.hint + current,
                );
              }}
            >
              {tool.label}
            </button>
          ))}
        </div>

        {/* Attach is a real file picker, and it goes through INTAKE — the one
            arrival path for bytes (FR-2). A Chat-only upload would be a second
            door onto `raw/sources/` with no compile behind it. */}
        <input
          ref={attachRef}
          type="file"
          className="wb-sr-only"
          multiple
          onChange={(event) => void attachFiles(event.target.files)}
        />

        {/* `/skill` completion (Story 8.6): ENABLED Skills only. A disabled pack
            is absent from this list, which is the same absence the Agent sees. */}
        {skillPicker !== null ? (
          <div className="wb-chat-skill-picker" role="dialog" aria-label="Pick a Skill">
            <ul>
              {matchSkills(skills, skillPicker).map((skill) => (
                <li key={skill.id}>
                  <button type="button" onClick={() => pickSkill(skill.id)}>
                    <strong>{skill.name}</strong>
                    <span>{skill.description}</span>
                  </button>
                </li>
              ))}
              {matchSkills(skills, skillPicker).length === 0 ? (
                <li className="wb-empty">No enabled Skills match.</li>
              ) : null}
            </ul>
            <div className="wb-chat-skill-picker-actions">
              <button type="button" onClick={() => pickSkill(null)}>
                Run without a Skill
              </button>
              <button type="button" onClick={() => setSkillPicker(null)}>
                {FORM_CANCEL_LABEL}
              </button>
            </div>
          </div>
        ) : null}

        {/* ONE RENDERER for single, multiple and free text (Story 8.7). Chat waits
            here: nothing is persisted and no tool runs until Submit or Cancel. */}
        {pending?.kind === "skill_form" ? (
          <form
            className="wb-chat-form"
            role="dialog"
            aria-label={pending.title}
            onSubmit={(event) => {
              event.preventDefault();
              void answerPending(true);
            }}
          >
            <h3>{pending.title}</h3>
            {pending.fields.map((field) => (
              <fieldset key={field.name} className="wb-chat-form-field">
                <legend>{field.label}</legend>
                {field.kind === "text" ? (
                  <input
                    type="text"
                    value={String(formValues[field.name] ?? "")}
                    onChange={(event) =>
                      setFormValues((current) => ({
                        ...current,
                        [field.name]: event.target.value,
                      }))
                    }
                  />
                ) : (
                  (field.options ?? []).map((option) => (
                    <label key={option}>
                      <input
                        // `radio` and `checkbox` are the SAME field to the model —
                        // one answers with a string, the other with a list — so one
                        // renderer covers both and the submit shape stays uniform.
                        type={field.kind === "single" ? "radio" : "checkbox"}
                        name={field.name}
                        checked={
                          field.kind === "single"
                            ? formValues[field.name] === option
                            : Array.isArray(formValues[field.name]) &&
                              (formValues[field.name] as string[]).includes(option)
                        }
                        onChange={(event) =>
                          setFormValues((current) => {
                            if (field.kind === "single") {
                              return { ...current, [field.name]: option };
                            }
                            const chosen = Array.isArray(current[field.name])
                              ? (current[field.name] as string[])
                              : [];
                            return {
                              ...current,
                              [field.name]: event.target.checked
                                ? [...chosen, option]
                                : chosen.filter((value) => value !== option),
                            };
                          })
                        }
                      />
                      {option}
                    </label>
                  ))
                )}
              </fieldset>
            ))}
            <div className="wb-chat-form-actions">
              <button
                type="submit"
                disabled={!formIsSubmittable(pending.fields, formValues)}
              >
                {FORM_SUBMIT_LABEL}
              </button>
              <button type="button" onClick={() => void answerPending(false)}>
                {FORM_CANCEL_LABEL}
              </button>
            </div>
          </form>
        ) : null}

        {/* Approve / Deny, PER COMMAND (Story 8.9). There is no allow-all here and
            no remembered "yes to everything": Deny and Esc both end the pending
            call without running it. */}
        {pending?.kind === "shell_approval" ? (
          <div className="wb-chat-approval" role="alertdialog" aria-label={SHELL_APPROVAL_TITLE}>
            <h3>{SHELL_APPROVAL_TITLE}</h3>
            <p>{shellApprovalReasonCopy(pending.reason)}</p>
            <pre className="wb-chat-approval-command">{shellCommandLine(pending)}</pre>
            <p className="wb-chat-approval-cwd">in {pending.cwd}</p>
            <div className="wb-chat-approval-actions">
              <button type="button" onClick={() => void answerPending(true)}>
                {SHELL_APPROVE_LABEL}
              </button>
              <button type="button" onClick={() => void answerPending(false)}>
                {SHELL_DENY_LABEL}
              </button>
            </div>
          </div>
        ) : null}

        <div className="wb-chat-composer">
          <label className="wb-sr-only" htmlFor="wb-chat-input">
            Message
          </label>
          <textarea
            id="wb-chat-input"
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={onComposerKey}
            placeholder={CHAT_COMPOSER_PLACEHOLDER}
            rows={3}
            disabled={readOnly || pending !== null}
          />
          {streaming ? (
            <button type="button" onClick={stopTurn}>
              Stop
            </button>
          ) : (
            <button
              type="button"
              disabled={readOnly || pending !== null || !composer.trim()}
              onClick={() => void onSend()}
            >
              Send
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
