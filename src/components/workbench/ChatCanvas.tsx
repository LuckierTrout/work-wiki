"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
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
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";

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
  messages?: CanvasMessage[];
}

interface CanvasMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  citations?: ChatCitation[];
  thinking?: string;
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
  chatModel: { provider: string | null; model: string | null; configured: boolean };
}

function renderCited(content: string, onCite: (n: number) => void) {
  const parts = content.split(/(\[[1-9]\d*\])/g);
  return parts.map((part, index) => {
    const match = /^\[([1-9]\d*)\]$/.exec(part);
    if (!match) return <span key={index}>{part}</span>;
    const n = Number(match[1]);
    return (
      <button
        key={index}
        type="button"
        className="wb-chat-cite"
        onClick={() => onCite(n)}
      >
        [{n}]
      </button>
    );
  });
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
  const liveRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const sendInFlight = useRef(false);

  const active = conversations.find((item) => item.id === activeId) ?? null;
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
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(id)}`,
      { method: "GET" },
    );
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

  function switchConversation(id: string) {
    abortRef.current?.abort();
    setStreaming(false);
    if (activeId) drafts.current[activeId] = composer;
    setActiveId(id);
    setComposer(drafts.current[id] ?? "");
    setError(null);
    setVectorNote(null);
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

  async function patchActive(patch: Record<string, unknown>) {
    if (!activeId || readOnly) return;
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(activeId)}`,
      {
        method: "PATCH",
        body: JSON.stringify(patch),
      },
    );
    if (body.conversation) {
      setConversations((current) =>
        current.map((item) =>
          item.id === activeId ? { ...item, ...body.conversation } : item,
        ),
      );
    }
  }

  function dockCitation(citation: ChatCitation) {
    onDockPreview(selectionFromContentPath(citation.path));
  }

  function citeNumber(n: number, citations: ChatCitation[] | undefined) {
    const row = citations?.find((item) => item.n === n);
    if (row) dockCitation(row);
  }

  async function persistFrames(id: string, frames: CanvasMessage[]) {
    const body = await send<{ conversation?: ConversationRow }>(
      `/api/chat/conversations/${encodeURIComponent(id)}/messages`,
      {
        method: "POST",
        body: JSON.stringify({
          persist: true,
          messages: frames.map((frame) => ({
            role: frame.role,
            content: frame.content,
            citations: frame.citations ?? [],
            ...(frame.thinking ? { thinking: frame.thinking } : {}),
          })),
        }),
      },
    );
    if (!body.conversation) throw new Error("Persist failed.");
    setMessages(body.conversation.messages ?? []);
    setConversations((current) =>
      current.map((item) =>
        item.id === id ? { ...item, ...body.conversation } : item,
      ),
    );
  }

  async function sendTurn(text: string, conversationId: string): Promise<boolean> {
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
    const history: ChatExportMessage[] = messages.map((message) => ({
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
      if (!assembled.coverage) {
        await persistFrames(conversationId, [
          { id: "u", role: "user", content: trimmed },
          {
            id: "a",
            role: "assistant",
            content: assembled.coverageMessage || CHAT_COVERAGE_MISSING_COPY,
            citations: [],
          },
        ]);
        return true;
      }
      if (!assembled.chatModel.configured) {
        setError(CHAT_MODEL_MISSING_COPY);
        return false;
      }
      const controller = new AbortController();
      abortRef.current = controller;
      const sidecarRes = await fetch(sidecarChatUrl(wikiId), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "text/event-stream",
        },
        signal: controller.signal,
        body: JSON.stringify({
          stream: true,
          query: trimmed,
          coverage: true,
          system: assembled.systemPrompt,
          context: assembled.numberedBodies,
          indexSlice: assembled.indexSlice,
          messages: assembled.historySlice,
          citations: assembled.citations,
          model: assembled.chatModel,
        }),
      });
      if (!sidecarRes.ok || !sidecarRes.body) {
        const failed = (await sidecarRes.json().catch(() => ({}))) as { error?: string };
        throw new Error(failed.error || "Sidecar chat failed.");
      }
      const reader = sidecarRes.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let donePayload: {
        content?: string;
        thinking?: string;
        citations?: ChatCitation[];
      } | null = null;
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
        } else if (event === "done") {
          donePayload = data as {
            content?: string;
            thinking?: string;
            citations?: ChatCitation[];
          };
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
      const content = donePayload?.content?.trim() || CHAT_COVERAGE_MISSING_COPY;
      await persistFrames(conversationId, [
        { id: "u", role: "user", content: trimmed },
        {
          id: "a",
          role: "assistant",
          content,
          citations: donePayload?.citations ?? assembled.citations,
          thinking: donePayload?.thinking,
        },
      ]);
      return true;
    } catch (cause) {
      setMessages((current) => current.filter((item) => !item.id.startsWith("pending-")));
      if ((cause as Error).name === "AbortError") return false;
      setError(cause instanceof Error ? cause.message : "Chat failed.");
      return false;
    } finally {
      sendInFlight.current = false;
      setStreaming(false);
      setStreamText("");
      setStreamThinking("");
      abortRef.current = null;
    }
  }

  async function onSend() {
    if (readOnly) return;
    const text = composer.trim();
    if (!text) return;
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
    const body = await send<{
      noop?: boolean;
      userContent?: string | null;
      conversation?: ConversationRow;
    }>(`/api/chat/conversations/${encodeURIComponent(activeId)}/messages`, {
      method: "POST",
      body: JSON.stringify({ retractLastTurn: true }),
    });
    if (body.noop || !body.userContent) return;
    setMessages(body.conversation?.messages ?? []);
    const ok = await sendTurn(body.userContent, activeId);
    if (!ok) setComposer(body.userContent);
  }

  async function saveToWiki() {
    if (!activeId || readOnly) return;
    const assistant = [...messages].reverse().find((item) => item.role === "assistant");
    if (!assistant) return;
    try {
      await send(`/api/chat/conversations/${encodeURIComponent(activeId)}/save`, {
        method: "POST",
        body: JSON.stringify({ content: assistant.content }),
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Save failed.");
    }
  }

  const lastCitations = useMemo(() => {
    return [...messages].reverse().find((item) => item.role === "assistant")?.citations ?? [];
  }, [messages]);

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
              <div className="wb-chat-body">
                {renderCited(message.content, (n) => citeNumber(n, message.citations))}
              </div>
            </article>
          ))}
          {streaming ? (
            <article className="wb-chat-msg wb-chat-msg--assistant">
              <h3 className="wb-chat-msg-role">Assistant</h3>
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
              <div className="wb-chat-body">{streamText}</div>
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
          />
          <button
            type="button"
            disabled={readOnly || !composer.trim() || streaming}
            onClick={() => void onSend()}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
