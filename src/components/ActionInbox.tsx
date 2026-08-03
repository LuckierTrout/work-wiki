"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert } from "@/components/Alert";
import type {
  ActionItem,
  ActionItemPriority,
  ActionItemStatus,
} from "@/lib/action-items";

const TABS: Array<{ value: ActionItemStatus | "all"; label: string }> = [
  { value: "inbox", label: "Proposed" },
  { value: "accepted", label: "Accepted" },
  { value: "done", label: "Done" },
  { value: "dismissed", label: "Dismissed" },
  { value: "all", label: "All" },
];

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

export function ActionInbox() {
  const [items, setItems] = useState<ActionItem[]>([]);
  const [tab, setTab] = useState<ActionItemStatus | "all">("inbox");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [adding, setAdding] = useState(false);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const data = await request<{ items: ActionItem[] }>("/api/action-items");
      setItems(data.items);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Could not load tasks.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function update(id: string, patch: Partial<ActionItem>) {
    setError(null);
    try {
      const data = await request<{ item: ActionItem }>(`/api/action-items/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      setItems((current) => current.map((item) => item.id === id ? data.item : item));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be updated.");
    }
  }

  async function add() {
    if (!newTitle.trim()) return;
    setAdding(true);
    setError(null);
    try {
      const data = await request<{ item: ActionItem }>("/api/action-items", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: newTitle.trim() }),
      });
      setItems((current) => [data.item, ...current]);
      setNewTitle("");
      setTab("inbox");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be added.");
    } finally {
      setAdding(false);
    }
  }

  async function remove(id: string) {
    if (!window.confirm("Delete this task permanently?")) return;
    try {
      await request(`/api/action-items/${id}`, { method: "DELETE" });
      setItems((current) => current.filter((item) => item.id !== id));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Task could not be deleted.");
    }
  }

  const shown = tab === "all" ? items : items.filter((item) => item.status === tab);
  const proposed = items.filter((item) => item.status === "inbox").length;

  return (
    <main className="shell fade" style={{ paddingTop: 48, paddingBottom: 88 }}>
      <p className="fmark" style={{ marginBottom: 16 }}>private action ledger</p>
      <div className="spread" style={{ gap: 24, alignItems: "end" }}>
        <div>
          <h1 className="display" style={{ fontSize: "clamp(34px,4.4vw,56px)", margin: 0 }}>Your task inbox.</h1>
          <p style={{ color: "var(--ink-2)", fontSize: 17, margin: "10px 0 0", maxWidth: "58ch" }}>
            Yopedia proposes actions from new material. Nothing becomes active until you accept it.
          </p>
        </div>
        <div style={{ textAlign: "right" }}>
          <span className="display" style={{ fontSize: 34, color: proposed ? "var(--accent)" : "var(--muted)" }}>{proposed}</span>
          <span className="receipt" style={{ display: "block", color: "var(--faint)", fontSize: 10 }}>awaiting review</span>
        </div>
      </div>

      <form onSubmit={(event) => { event.preventDefault(); void add(); }} className="row" style={{ gap: 9, marginTop: 28 }}>
        <input value={newTitle} onChange={(event) => setNewTitle(event.target.value)} placeholder="Add a task yourself…" style={{ flex: 1, border: "1px solid var(--rule-strong)", borderRadius: 12, background: "var(--paper-2)", color: "var(--ink)", padding: "11px 14px", fontSize: 14.5 }} />
        <button className="btn primary" type="submit" disabled={adding || !newTitle.trim()}>{adding ? "Adding…" : "Add task"}</button>
      </form>

      {error && <div style={{ marginTop: 16 }}><Alert variant="error">{error}</Alert></div>}

      <div className="row" role="tablist" aria-label="Task status" style={{ gap: 6, flexWrap: "wrap", marginTop: 28, paddingBottom: 16, borderBottom: "1px solid var(--rule)" }}>
        {TABS.map((item) => {
          const count = item.value === "all" ? items.length : items.filter((task) => task.status === item.value).length;
          return (
            <button key={item.value} type="button" role="tab" aria-selected={tab === item.value} className="btn ghost" onClick={() => setTab(item.value)} style={{ background: tab === item.value ? "var(--paper-3)" : undefined }}>
              {item.label} <span className="receipt" style={{ marginLeft: 5, color: "var(--faint)", fontSize: 9.5 }}>{count}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <p style={{ color: "var(--muted)", marginTop: 28 }}>Loading tasks…</p>
      ) : shown.length === 0 ? (
        <div style={{ textAlign: "center", padding: "70px 20px", borderBottom: "1px solid var(--rule)" }}>
          <p className="display" style={{ fontSize: 25, margin: 0 }}>Nothing here.</p>
          <p style={{ color: "var(--muted)", margin: "7px 0 0" }}>{tab === "inbox" ? "Newly extracted actions will wait here for your review." : "Tasks appear here when their status changes."}</p>
        </div>
      ) : (
        <div>
          {shown.map((item) => (
            <article key={item.id} className="grid sm:grid-cols-[minmax(0,1fr)_auto]" style={{ gap: 18, padding: "20px 0", borderBottom: "1px solid var(--rule)" }}>
              <div>
                <div className="row" style={{ gap: 9, flexWrap: "wrap" }}>
                  <h2 style={{ margin: 0, fontSize: 17, fontWeight: 600, lineHeight: 1.4 }}>{item.title}</h2>
                  <select aria-label={`Priority for ${item.title}`} value={item.priority} onChange={(event) => void update(item.id, { priority: event.target.value as ActionItemPriority })} style={{ border: "1px solid var(--rule)", borderRadius: 7, background: "var(--paper-2)", color: "var(--muted)", padding: "3px 6px", fontSize: 11 }}>
                    <option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
                  </select>
                </div>
                {item.details && <p style={{ color: "var(--ink-2)", fontSize: 14, lineHeight: 1.55, margin: "7px 0 0" }}>{item.details}</p>}
                {item.sourceExcerpt && <blockquote style={{ borderLeft: "2px solid var(--rule-strong)", margin: "10px 0 0", paddingLeft: 12, color: "var(--muted)", fontSize: 13, lineHeight: 1.5 }}>{item.sourceExcerpt}</blockquote>}
                <div className="row" style={{ gap: 12, flexWrap: "wrap", marginTop: 10 }}>
                  {item.assignee && <span className="receipt" style={{ fontSize: 10.5 }}>owner · {item.assignee}</span>}
                  {item.dueDate && <span className="receipt" style={{ fontSize: 10.5 }}>due · {item.dueDate}</span>}
                  {typeof item.confidence === "number" && <span className="receipt" style={{ fontSize: 10.5 }}>{Math.round(item.confidence * 100)}% confidence</span>}
                  {item.sourceSlug && <Link href={`/wiki/${item.sourceSlug}`} className="receipt" style={{ fontSize: 10.5, color: "var(--accent)" }}>source · {item.sourceSlug}</Link>}
                </div>
              </div>
              <div className="row" style={{ gap: 6, alignSelf: "start", flexWrap: "wrap", justifyContent: "end" }}>
                {item.status === "inbox" && <><button className="btn primary" type="button" onClick={() => void update(item.id, { status: "accepted" })}>Accept</button><button className="btn ghost" type="button" onClick={() => void update(item.id, { status: "dismissed" })}>Dismiss</button></>}
                {item.status === "accepted" && <button className="btn primary" type="button" onClick={() => void update(item.id, { status: "done" })}>Mark done</button>}
                {(item.status === "done" || item.status === "dismissed") && <button className="btn ghost" type="button" onClick={() => void update(item.id, { status: "inbox" })}>Restore</button>}
                <button className="btn ghost" type="button" onClick={() => void remove(item.id)} style={{ color: "var(--rust)" }}>Delete</button>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
