"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { ChatBody } from "./ChatBody";
import { useChatConversations } from "./useChatConversations";
import {
  CHAT_TOKEN_BUDGET_MAX,
  CHAT_TOKEN_BUDGET_MIN,
  type ChatCitation,
} from "@/lib/chat-contract";
import { assembleTurn, chatHistorySlice } from "@/lib/chat-assemble";
import {
  attachThroughIntake,
  composerHintText,
  scanSkills,
  skillCommandOutcome,
} from "@/lib/chat-composer";
import {
  groupCitationsByType,
  lastAssistantMessage,
  regenerateTarget,
  saveAnswerToWiki,
  type CanvasMessage,
} from "@/lib/chat-conversation-store";
import {
  runSidecarTurn,
  type SidecarTurnHandlers,
} from "@/lib/chat-session-transport";
import {
  chatTurnRequest,
  resumeRequest,
  settleTurn,
  turnFailureCopy,
  type OpenTurn,
} from "@/lib/chat-pending-turn";
import {
  CHAT_COMPOSER_PLACEHOLDER,
  CHAT_MODEL_MISSING_COPY,
  CHAT_SIDECAR_UP_COPY,
  CHAT_VECTOR_FALLBACK_COPY,
} from "@/lib/workbench-modes";
import {
  selectionFromContentPath,
  workspaceSelection,
  type TreeSelection,
} from "@/lib/workbench-tree";
import { requestDataVersionCheck } from "@/lib/workbench-data-version";
import {
  COMPOSER_TOOLS,
  FORM_CANCEL_LABEL,
  FORM_SUBMIT_LABEL,
  SHELL_APPROVAL_TITLE,
  SHELL_APPROVE_LABEL,
  SHELL_DENY_LABEL,
  SKILL_CLEARED_COPY,
  formIsSubmittable,
  matchSkills,
  mergeToolRow,
  outputChipLabel,
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

function thinkingLines(text: string): string[] {
  return text.split(/\n/).filter((line) => line.trim().length > 0).slice(-5);
}

export function ChatCanvas({ wikiId, readOnly, onDockPreview }: ChatCanvasProps) {
  const [error, setError] = useState<string | null>(null);
  // The conversation half — the list, the open one, its messages and its
  // settings — lives in `useChatConversations`, over the doors in
  // `@/lib/chat-conversation-store`. What is left here is the composer, the
  // turn, and the screen.
  const {
    conversations,
    activeId,
    messages,
    retrievalMode,
    tokenBudget,
    historyDepth,
    selectedSkill,
    setActiveId,
    setMessages,
    setRetrievalMode,
    setTokenBudget,
    setHistoryDepth,
    setSelectedSkill,
    loadConversation,
    startConversation,
    removeConversation,
    renameActive,
    patchActive,
    persistFrames,
    clearOptimistic,
  } = useChatConversations({ readOnly, onError: setError });
  const [composer, setComposer] = useState("");
  const drafts = useRef<Record<string, string>>({});
  const [streaming, setStreaming] = useState(false);
  const [streamText, setStreamText] = useState("");
  const [streamThinking, setStreamThinking] = useState("");
  const [thinkingOpen, setThinkingOpen] = useState<Record<string, boolean>>({});
  const [citationsOpen, setCitationsOpen] = useState(true);
  const [vectorNote, setVectorNote] = useState<string | null>(null);
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  // Epic 8 state. `liveRows` are the rows of the turn CURRENTLY streaming; a
  // settled turn's rows live on the message, because they were persisted with it.
  const [liveRows, setLiveRows] = useState<ChatToolRow[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [skillPicker, setSkillPicker] = useState<string | null>(null);
  const [skillNote, setSkillNote] = useState<string | null>(null);
  const [pending, setPending] = useState<ChatPending | null>(null);
  const [formValues, setFormValues] = useState<Record<string, string | string[]>>({});
  const liveRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendInFlight = useRef(false);
  const saveInFlight = useRef(false);
  const turnRef = useRef<OpenTurn | null>(null);
  const attachRef = useRef<HTMLInputElement>(null);

  const empty = messages.length === 0 && !streaming;

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
   * Skills on disk, read once on mount through `scanSkills`.
   *
   * `null` MEANS "THE SCAN SAID NOTHING" — a sidecar that is down, an API that
   * is off, a body that would not parse — and nothing is written, because none
   * of those is a reason to render. A wiki with NO SKILLS is a different answer:
   * it comes back as `[]` and is written like any other list. Neither is an
   * error the owner is shown; the door and its silence live in
   * `@/lib/chat-composer`.
   */
  useEffect(() => {
    const controller = new AbortController();
    void (async () => {
      const scanned = await scanSkills(controller.signal);
      if (scanned) setSkills(scanned);
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
    void loadConversation(id);
  }

  async function createConversation() {
    if (readOnly) return;
    if (activeId) drafts.current[activeId] = composer;
    const conversation = await startConversation();
    if (!conversation) return;
    setMessages([]);
    setComposer("");
    drafts.current[conversation.id] = "";
  }

  async function deleteConversation(id: string) {
    if (readOnly) return;
    abortRef.current?.abort();
    const outcome = await removeConversation(id);
    delete drafts.current[id];
    // The composer follows the conversation the removal left the surface on —
    // its own draft, or empty when nothing is left to be on.
    if (outcome.switched) {
      setComposer(
        outcome.fallbackId ? (drafts.current[outcome.fallbackId] ?? "") : "",
      );
    }
  }

  async function commitRename(id: string) {
    const name = renameValue.trim();
    setRenameId(null);
    if (!name || readOnly) return;
    await renameActive(id, name);
  }

  function dockCitation(citation: ChatCitation) {
    onDockPreview(selectionFromContentPath(citation.path));
  }

  function citeNumber(n: number, citations: ChatCitation[] | undefined) {
    const row = citations?.find((item) => item.n === n);
    if (row) dockCitation(row);
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
    const history = chatHistorySlice(historySource);
    try {
      const assembled = await assembleTurn({
        wikiId,
        query: trimmed,
        retrievalMode,
        tokenBudget,
        historyDepth,
        history,
      });
      if (assembled.vectorPhase?.status === "failed") {
        setVectorNote(assembled.vectorPhase.message || CHAT_VECTOR_FALLBACK_COPY);
      }
      if (!assembled.chatModel.configured) {
        setError(CHAT_MODEL_MISSING_COPY);
        clearOptimistic();
        return false;
      }
      const request = chatTurnRequest({
        query: trimmed,
        conversationId,
        assembled,
        skill: selectedSkill ?? null,
      });
      turnRef.current = {
        conversationId,
        userText: trimmed,
        replaceLastTurn: options?.replaceLastTurn === true,
        request,
        fallbackCitations: assembled.citations,
        coverageMessage: assembled.coverageMessage,
      };
      return await driveTurn(request);
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

  /** Where a streaming turn's pieces land: the live answer, and the live rows. */
  function turnHandlers(): SidecarTurnHandlers {
    return {
      onDelta: (delta) => setStreamText((current) => current + delta),
      onThinking: (thinking) => setStreamThinking(thinking),
      // Merged by id so a tool's announce and its outcome are one row.
      onToolRow: (row) => setLiveRows((current) => mergeToolRow(current, row)),
    };
  }

  /**
   * Run one turn (or one resume) on the sidecar and do what the outcome implies.
   *
   * The wire is `runSidecarTurn` and the decision is `settleTurn`; what is left
   * here is the part that is genuinely the component's — the abort controller,
   * the ref-held open turn, and the state writes.
   */
  async function driveTurn(request: Record<string, unknown>): Promise<boolean> {
    if (!turnRef.current) return false;
    const controller = new AbortController();
    abortRef.current = controller;
    const frame = await runSidecarTurn({
      wikiId,
      request,
      signal: controller.signal,
      handlers: turnHandlers(),
    });
    const turn = turnRef.current;
    if (!turn) return false;
    const outcome = settleTurn(turn, frame);
    if (outcome.kind === "pending") {
      setPending(outcome.pending);
      if (outcome.formValues) setFormValues(outcome.formValues);
      return true;
    }
    // THE SIDECAR TURN IS OVER. Drop the pause before persist so a store
    // failure cannot put Approve/Deny back over a command that already ran or
    // was already denied.
    setLiveRows([]);
    setPending(null);
    turnRef.current = null;
    await persistFrames(turn.conversationId, outcome.frames, {
      replaceLastTurn: outcome.replaceLastTurn,
    });
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
    sendInFlight.current = true;
    setStreaming(true);
    setStreamText("");
    setStreamThinking("");
    try {
      await driveTurn(resumeRequest(turn, current, approved, formValues));
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
   * The Intake path itself is `attachThroughIntake` — bytes arrive the one way
   * they are allowed to (FR-2). What is the surface's here is what the owner
   * then sees: the report in the composer's own note line, and the refresh nudge
   * that sends the trees to re-poll.
   */
  async function attachFiles(list: FileList | null) {
    const files = list ? Array.from(list) : [];
    if (files.length === 0 || readOnly) return;
    setSkillNote(null);
    try {
      const outcome = await attachThroughIntake(files);
      if (outcome.note) setSkillNote(outcome.note);
      if (outcome.refresh) requestDataVersionCheck();
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
   * The decision is `skillCommandOutcome`, which is where the rules live:
   * handled BEFORE the send so it never reaches a provider, completing against
   * ENABLED Skills only. What is left here is the composer clear the command
   * implies and which of the two surfaces the outcome opens.
   */
  function handleSkillCommand(text: string): boolean {
    const outcome = skillCommandOutcome(text, skills);
    if (outcome.kind === "none") return false;
    setComposer("");
    if (activeId) drafts.current[activeId] = "";
    if (outcome.kind === "pick") pickSkill(outcome.id);
    else setSkillPicker(outcome.term);
    return true;
  }

  async function onSend() {
    if (readOnly || pending) return;
    const text = composer.trim();
    if (!text) return;
    if (handleSkillCommand(text)) return;
    let id = activeId;
    if (!id) {
      const conversation = await startConversation();
      if (!conversation) return;
      id = conversation.id;
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
    if (readOnly || !activeId || streaming) return;
    // Only a user-then-assistant tail can be replaced; `regenerateTarget` says
    // so, and hands back the question plus the transcript before it.
    const target = regenerateTarget(messages);
    if (!target) return;
    const prior = messages;
    setMessages(target.history);
    const ok = await sendTurn(target.userText, activeId, {
      history: target.history,
      replaceLastTurn: true,
    });
    if (!ok) {
      setMessages(prior);
      setComposer(target.userText);
      drafts.current[activeId] = target.userText;
    }
  }

  async function saveToWiki() {
    if (!activeId || readOnly || saveInFlight.current) return;
    const assistant = lastAssistantMessage(messages);
    if (!assistant) return;
    saveInFlight.current = true;
    try {
      await saveAnswerToWiki(activeId, assistant.id);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    } finally {
      saveInFlight.current = false;
    }
  }

  const lastCitations = useMemo(() => {
    return lastAssistantMessage(messages)?.citations ?? [];
  }, [messages]);

  /** The selected Skill, or `null` when it was disabled or deleted since. */
  const activeSkill = useMemo(
    () => selectedSkillSummary(skills, selectedSkill),
    [skills, selectedSkill],
  );

  const grouped = useMemo(
    () => groupCitationsByType(lastCitations),
    [lastCitations],
  );

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
                setComposer((current) => composerHintText(current, tool.hint));
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
