"use client";

import Link from "next/link";
import { useSlugTenants } from "@/hooks/useSlugTenants";
import { useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import type {
  ChatConversation,
  ChatContextBudget,
  ChatMessage,
  ChatRetrievalMode,
} from "@/lib/chat";

interface ScopeOption {
  value: string;
  label: string;
}

async function json<T>(response: Response): Promise<T> {
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function ChatWorkspace() {
  const { hrefForSlug, slugTenants } = useSlugTenants();
  const [conversations, setConversations] = useState<ChatConversation[]>([]);
  const [active, setActive] = useState<ChatConversation | null>(null);
  const [scope, setScope] = useState("");
  const [retrievalMode, setRetrievalMode] = useState<ChatRetrievalMode>("wiki");
  const [contextBudget, setContextBudget] = useState<ChatContextBudget>("standard");
  const [scopeOptions, setScopeOptions] = useState<ScopeOption[]>([
    { value: "", label: "All knowledge" },
    { value: "mine", label: "My pages" },
  ]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The saved banner links via the server-returned canonical `url`: a
  // just-created slug cannot be in the session-cached slug→tenant map, so
  // `hrefForSlug` would bounce it through the 308 fallback. `hrefForSlug` is
  // only the fallback if the response carried no url.
  const [savedMessage, setSavedMessage] = useState<{ slug: string; url?: string } | null>(null);
  const [hermes, setHermes] = useState<{ configured: boolean; available: boolean; safe: boolean; reason?: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      fetch("/api/chat/conversations").then((response) => json<{ conversations: ChatConversation[] }>(response)),
      fetch("/api/vaults").then((response) => json<{ vaults?: Array<{ id: string; name: string }> }>(response)).catch(() => ({ vaults: [] })),
      fetch("/api/agents?mine=1").then((response) => json<{ agents?: Array<{ id: string; name: string }> }>(response)).catch(() => ({ agents: [] })),
      fetch("/api/chat/hermes").then((response) => json<{ configured: boolean; available: boolean; safe: boolean; reason?: string }>(response)).catch(() => ({ configured: false, available: false, safe: false })),
    ]).then(([conversationData, vaultData, agentData, hermesData]) => {
      if (cancelled) return;
      setConversations(conversationData.conversations);
      setScopeOptions([
        { value: "", label: "All knowledge" },
        { value: "mine", label: "My pages" },
        ...(vaultData.vaults ?? []).map((vault) => ({ value: `vault:${vault.id}`, label: `Vault · ${vault.name}` })),
        ...(agentData.agents ?? []).map((agent) => ({ value: `agent:${agent.id}`, label: `Agent · ${agent.name}` })),
      ]);
      setHermes(hermesData);
      setLoading(false);
    }).catch((reason) => {
      if (!cancelled) {
        setError(reason instanceof Error ? reason.message : "Could not load conversations.");
        setLoading(false);
      }
    });
    return () => { cancelled = true; };
  }, []);

  async function openConversation(id: string) {
    setError(null);
    try {
      const data = await json<{ conversation: ChatConversation }>(
        await fetch(`/api/chat/conversations/${id}`),
      );
      setActive(data.conversation);
      setScope(data.conversation.scope ?? "");
      setRetrievalMode(data.conversation.retrievalMode ?? "wiki");
      setContextBudget(data.conversation.contextBudget ?? "standard");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not open conversation.");
    }
  }

  async function createConversation(): Promise<ChatConversation> {
    const data = await json<{ conversation: ChatConversation }>(
      await fetch("/api/chat/conversations", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scope, retrievalMode, contextBudget }),
      }),
    );
    setConversations((current) => [data.conversation, ...current]);
    setActive(data.conversation);
    return data.conversation;
  }

  async function send() {
    const message = draft.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setDraft("");
    try {
      const conversation = active ?? (await createConversation());
      const optimistic: ChatMessage = {
        id: `pending-${Date.now()}`,
        role: "user",
        content: message,
        sources: [],
        createdAt: new Date().toISOString(),
      };
      setActive((current) => current ? { ...current, messages: [...current.messages, optimistic] } : current);
      const data = await json<{ conversation: ChatConversation; message: ChatMessage }>(
        await fetch(`/api/chat/conversations/${conversation.id}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ message }),
        }),
      );
      setActive(data.conversation);
      setConversations((current) => [
        { ...data.conversation, messages: [] },
        ...current.filter((item) => item.id !== data.conversation.id),
      ]);
    } catch (reason) {
      setDraft(message);
      setError(reason instanceof Error ? reason.message : "The message could not be sent.");
      if (active) void openConversation(active.id);
    } finally {
      setSending(false);
    }
  }

  async function changeScope(value: string) {
    setScope(value);
    if (!active) return;
    try {
      const data = await json<{ conversation: ChatConversation }>(
        await fetch(`/api/chat/conversations/${active.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: value || null }),
        }),
      );
      setActive(data.conversation);
      setConversations((current) => current.map((item) =>
        item.id === data.conversation.id
          ? { ...data.conversation, messages: [] }
          : item,
      ));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Scope could not be changed.");
    }
  }

  async function changeRetrievalMode(value: ChatRetrievalMode) {
    setRetrievalMode(value);
    if (!active) return;
    try {
      const data = await json<{ conversation: ChatConversation }>(
        await fetch(`/api/chat/conversations/${active.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ retrievalMode: value }),
        }),
      );
      setActive(data.conversation);
      setConversations((current) => current.map((item) =>
        item.id === data.conversation.id
          ? { ...data.conversation, messages: [] }
          : item,
      ));
    } catch (reason) {
      setRetrievalMode(active.retrievalMode ?? "wiki");
      setError(reason instanceof Error ? reason.message : "Evidence mode could not be changed.");
    }
  }

  async function changeContextBudget(value: ChatContextBudget) {
    setContextBudget(value);
    if (!active) return;
    try {
      const data = await json<{ conversation: ChatConversation }>(
        await fetch(`/api/chat/conversations/${active.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ contextBudget: value }),
        }),
      );
      setActive(data.conversation);
      setConversations((current) => current.map((item) =>
        item.id === data.conversation.id
          ? { ...data.conversation, messages: [] }
          : item,
      ));
    } catch (reason) {
      setContextBudget(active.contextBudget ?? "standard");
      setError(reason instanceof Error ? reason.message : "Context size could not be changed.");
    }
  }

  async function removeConversation() {
    if (!active || !window.confirm(`Delete “${active.title}”?`)) return;
    try {
      await json(await fetch(`/api/chat/conversations/${active.id}`, { method: "DELETE" }));
      setConversations((current) => current.filter((item) => item.id !== active.id));
      setActive(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Conversation could not be deleted.");
    }
  }

  async function saveAnswer(message: ChatMessage) {
    if (!active) return;
    setSavedMessage(null);
    try {
      const result = await json<{ slug: string; url?: string }>(await fetch("/api/query/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: active.title,
          content: message.content,
          sources: message.sources,
          format: "prose",
        }),
      }));
      // json() maps an unparseable-but-OK body to {} — without a slug there is
      // nothing to link, so keep the banner hidden (the pre-object behavior)
      // rather than rendering "Saved as undefined".
      setSavedMessage(result.slug ? { slug: result.slug, url: result.url } : null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Answer could not be saved.");
    }
  }

  const currentScopeLabel =
    scopeOptions.find((option) => option.value === scope)?.label ?? "Custom scope";

  return (
    <div className="shell fade" style={{ paddingTop: 46, paddingBottom: 88 }}>
      <p className="fmark" style={{ marginBottom: 16 }}>grounded conversation</p>
      <div className="spread" style={{ gap: 20, alignItems: "end", marginBottom: 30 }}>
        <div>
          <h1 className="display" style={{ fontSize: "clamp(34px,4.4vw,56px)", margin: 0 }}>Chat with your wiki.</h1>
          <div className="row" style={{ gap: 9, flexWrap: "wrap", marginTop: 10 }}>
            <p style={{ color: "var(--ink-2)", fontSize: 17, margin: 0 }}>Follow a thread without losing the receipts.</p>
            {hermes && (
              <span title={hermes.reason} className="receipt" style={{ fontSize: 9.5, color: hermes.available ? "var(--accent)" : "var(--faint)" }}>
                {hermes.available ? "Hermes connected" : hermes.configured ? "Hermes offline · provider fallback" : "provider runtime"}
              </span>
            )}
          </div>
        </div>
        <button className="btn primary" type="button" onClick={() => { setActive(null); setScope(""); setRetrievalMode("wiki"); setContextBudget("standard"); setDraft(""); }}>
          New conversation
        </button>
      </div>

      {error && <div style={{ marginBottom: 16 }}><Alert variant="error">{error}</Alert></div>}
      {savedMessage && (
        <div style={{ marginBottom: 16 }}><Alert variant="success">Saved as <Link href={savedMessage.url ?? hrefForSlug(savedMessage.slug)}>{savedMessage.slug}</Link>.</Alert></div>
      )}

      <div className="grid lg:grid-cols-[260px_minmax(0,1fr)]" style={{ gap: 18, alignItems: "stretch" }}>
        <aside style={{ border: "1px solid var(--rule)", borderRadius: 16, background: "var(--paper-2)", overflow: "hidden" }}>
          <div className="spread" style={{ padding: "13px 14px", borderBottom: "1px solid var(--rule)" }}>
            <span className="fmark">Threads</span>
            <span className="receipt" style={{ color: "var(--faint)", fontSize: 10 }}>{conversations.length}</span>
          </div>
          {loading ? (
            <p style={{ padding: 16, color: "var(--muted)", fontSize: 13 }}>Loading…</p>
          ) : conversations.length === 0 ? (
            <p style={{ padding: 16, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>Ask a question to start your first conversation.</p>
          ) : (
            <div style={{ maxHeight: 540, overflowY: "auto" }}>
              {conversations.map((conversation) => (
                <button
                  key={conversation.id}
                  type="button"
                  onClick={() => void openConversation(conversation.id)}
                  style={{
                    width: "100%", textAlign: "left", border: 0,
                    borderBottom: "1px solid var(--rule)", padding: "12px 14px",
                    background: active?.id === conversation.id ? "var(--paper-3)" : "transparent",
                    color: "var(--ink)", cursor: "pointer",
                  }}
                >
                  <span style={{ display: "block", fontSize: 13.5, fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{conversation.title}</span>
                  <span className="receipt" style={{ color: "var(--faint)", fontSize: 9.5 }}>
                    {conversation.scope || "all knowledge"} · {conversation.retrievalMode === "sources" ? "originals" : "wiki"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </aside>

        <section style={{ minHeight: 590, border: "1px solid var(--rule)", borderRadius: 16, background: "var(--paper)", display: "flex", flexDirection: "column", overflow: "hidden" }}>
          <div className="spread" style={{ padding: "12px 14px", borderBottom: "1px solid var(--rule)", gap: 12, flexWrap: "wrap" }}>
            <div className="row" style={{ gap: 12, flexWrap: "wrap" }}>
              <label className="row" style={{ gap: 8, fontSize: 12.5, color: "var(--muted)" }}>
                Search
                <select value={scope} onChange={(event) => void changeScope(event.target.value)} disabled={sending} style={{ border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "7px 9px" }}>
                  {scopeOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </label>
              <label className="row" style={{ gap: 8, fontSize: 12.5, color: "var(--muted)" }}>
                Evidence
                <select value={retrievalMode} onChange={(event) => void changeRetrievalMode(event.target.value as ChatRetrievalMode)} disabled={sending} style={{ border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "7px 9px" }}>
                  <option value="wiki">Wiki pages</option>
                  <option value="sources">Original sources only</option>
                </select>
              </label>
              <label className="row" style={{ gap: 8, fontSize: 12.5, color: "var(--muted)" }}>
                Context
                <select value={contextBudget} onChange={(event) => void changeContextBudget(event.target.value as ChatContextBudget)} disabled={sending} style={{ border: "1px solid var(--rule-strong)", borderRadius: 8, background: "var(--paper-2)", color: "var(--ink)", padding: "7px 9px" }}>
                  <option value="compact">Compact · 4 pages</option>
                  <option value="standard">Standard · 8 pages</option>
                  <option value="expanded">Expanded · 12 pages</option>
                </select>
              </label>
            </div>
            {active && <button className="btn ghost" type="button" onClick={() => void removeConversation()} style={{ color: "var(--rust)" }}>Delete</button>}
          </div>

          <div aria-live="polite" style={{ flex: 1, padding: "20px clamp(16px,3vw,34px)", overflowY: "auto" }}>
            {!active?.messages.length ? (
              <div style={{ maxWidth: 540, margin: "74px auto", textAlign: "center" }}>
                <p className="display" style={{ fontSize: 27, margin: 0 }}>Start with what you need to know.</p>
                <p style={{ color: "var(--muted)", lineHeight: 1.6 }}>
                  {currentScopeLabel} will be searched. {retrievalMode === "sources"
                    ? "Answers use original snapshots only and cite exact source lines."
                    : "Answers link back to the wiki pages they use."}
                </p>
              </div>
            ) : (
              <div className="stack" style={{ gap: 22 }}>
                {active.messages.map((message) => (
                  <article key={message.id} style={{ marginLeft: message.role === "user" ? "auto" : 0, maxWidth: message.role === "user" ? "78%" : "100%" }}>
                    <p className="receipt" style={{ fontSize: 9.5, color: "var(--faint)", margin: "0 0 6px" }}>
                      {message.role === "user" ? "You" : message.backend === "hermes" ? "work-wiki · Hermes" : "work-wiki"}
                    </p>
                    <div style={{ background: message.role === "user" ? "var(--paper-3)" : "transparent", border: message.role === "user" ? "1px solid var(--rule)" : 0, borderRadius: 14, padding: message.role === "user" ? "11px 14px" : 0 }}>
                      {message.role === "assistant" ? <MarkdownRenderer content={message.content} slugTenants={slugTenants} /> : <p style={{ margin: 0, whiteSpace: "pre-wrap", lineHeight: 1.55 }}>{message.content}</p>}
                    </div>
                    {message.role === "assistant" && (
                      <div className="row" style={{ gap: 8, flexWrap: "wrap", marginTop: 10 }}>
                        {message.sources.map((source) => <Link key={source} href={hrefForSlug(source)} className="receipt" style={{ fontSize: 10.5, color: "var(--accent)" }}>{source}</Link>)}
                        <button type="button" className="btn ghost" onClick={() => void saveAnswer(message)} style={{ fontSize: 11, padding: "5px 8px" }}>Save to wiki</button>
                      </div>
                    )}
                  </article>
                ))}
                {sending && (
                  <p className="receipt" style={{ color: "var(--muted)" }}>
                    {retrievalMode === "sources" ? "Reading original snapshots and composing…" : "Searching pages and composing…"}
                  </p>
                )}
              </div>
            )}
          </div>

          <div style={{ borderTop: "1px solid var(--rule)", padding: 14, background: "var(--paper-2)" }}>
            <form onSubmit={(event) => { event.preventDefault(); void send(); }} className="row" style={{ gap: 10, alignItems: "end" }}>
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(); } }} rows={2} placeholder="Ask a follow-up…" disabled={sending} style={{ flex: 1, resize: "vertical", minHeight: 54, border: "1px solid var(--rule-strong)", borderRadius: 12, background: "var(--paper)", color: "var(--ink)", padding: "11px 13px", fontFamily: "var(--font-read)", fontSize: 15 }} />
              <button className="btn primary" type="submit" disabled={sending || !draft.trim()}>{sending ? "Working…" : "Send"}</button>
            </form>
          </div>
        </section>
      </div>
    </div>
  );
}
