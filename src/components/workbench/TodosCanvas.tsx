"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import {
  todoMeetingPath,
  type TodoExtractError,
  type TodoItem,
  type TodoTab,
} from "@/lib/todo-types";

export interface TodosCanvasProps {
  wikiId: string;
  readOnly?: boolean;
  /** Stay-mounted; fetch only while this surface is showing. */
  active?: boolean;
  onDockPreview: (selection: TreeSelection) => void;
  onPendingCountChange?: (count: number) => void;
}

interface TodosResponse {
  items?: TodoItem[];
  pendingCount?: number;
  extractError?: TodoExtractError;
}

type DueFilter = "all" | "due" | "overdue" | "none";
type DueSort = "updated" | "due";

const TABS: readonly TodoTab[] = ["candidates", "open", "done"];

function tabLabel(tab: TodoTab): string {
  if (tab === "candidates") return "Candidates";
  if (tab === "open") return "Open";
  return "Done";
}

export function TodosCanvas({
  wikiId: _wikiId,
  readOnly = false,
  active = true,
  onDockPreview,
  onPendingCountChange,
}: TodosCanvasProps) {
  const empty = workbenchMode("todos").emptyState ?? "No candidates. Meeting ingest will propose them.";
  const [tab, setTab] = useState<TodoTab>("candidates");
  const [items, setItems] = useState<TodoItem[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [extractError, setExtractError] = useState<TodoExtractError | null>(null);
  const [busy, setBusy] = useState(false);
  const [dueFilter, setDueFilter] = useState<DueFilter>("all");
  const [dueSort, setDueSort] = useState<DueSort>("updated");
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editDue, setEditDue] = useState("");
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const body = await send<TodosResponse>(`/api/todos?tab=${tab}`, { method: "GET" });
      if (seq !== loadSeq.current) return;
      setItems(body.items ?? []);
      setExtractError(body.extractError ?? null);
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setItems([]);
      setExtractError(null);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Todos.");
    }
  }, [tab, onPendingCountChange]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load]);

  const visible = useMemo(() => {
    const today = new Date().toISOString().slice(0, 10);
    let next = items;
    if (tab !== "candidates") {
      if (dueFilter === "due") next = next.filter((item) => item.due);
      else if (dueFilter === "none") next = next.filter((item) => !item.due);
      else if (dueFilter === "overdue") {
        next = next.filter((item) => item.due && item.due.slice(0, 10) < today);
      }
      if (dueSort === "due") {
        next = [...next].sort((a, b) => {
          if (!a.due && !b.due) return b.updatedAt.localeCompare(a.updatedAt);
          if (!a.due) return 1;
          if (!b.due) return -1;
          return a.due.localeCompare(b.due);
        });
      }
    }
    return next;
  }, [items, tab, dueFilter, dueSort]);

  function toggle(id: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function decide(ids: string[], decision: "approve" | "reject") {
    if (readOnly || ids.length === 0) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<TodosResponse>("/api/todos", {
        method: "POST",
        body: JSON.stringify({ ids, decision }),
      });
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      setSelected(new Set());
      await load();
    } catch (cause) {
      setError(writeFailure(cause, `${decision} the selected candidates`).message);
    } finally {
      setBusy(false);
    }
  }

  async function patch(id: string, payload: Record<string, unknown>) {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<TodosResponse>(`/api/todos/${encodeURIComponent(id)}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      setEditingId(null);
      await load();
    } catch (cause) {
      setError(writeFailure(cause, "update the todo").message);
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<TodosResponse>(`/api/todos/${encodeURIComponent(id)}`, {
        method: "DELETE",
      });
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      await load();
    } catch (cause) {
      setError(writeFailure(cause, "delete the todo").message);
    } finally {
      setBusy(false);
    }
  }

  async function retryExtract() {
    if (readOnly || !extractError) return;
    setBusy(true);
    setError(null);
    try {
      await send("/api/todos", {
        method: "POST",
        body: JSON.stringify({
          retry: true,
          slug: extractError.slug,
          ...(extractError.sourcePath ? { sourcePath: extractError.sourcePath } : {}),
        }),
      });
      await load();
    } catch (cause) {
      setError(writeFailure(cause, "retry meeting extract").message);
    } finally {
      setBusy(false);
    }
  }

  const bulkIds = [...selected];

  return (
    <div className="wb-todos">
      <div className="wb-todos-bar">
        <div className="wb-todos-seg" role="tablist" aria-label="Todo lists">
          {TABS.map((id) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`wb-todos-seg-btn${tab === id ? " wb-todos-seg-btn--on" : ""}`}
              onClick={() => {
                setTab(id);
                setSelected(new Set());
              }}
            >
              {tabLabel(id)}
            </button>
          ))}
        </div>
        {tab === "candidates" && (
          <div className="wb-todos-bulk">
            <button
              type="button"
              className="wb-todos-btn wb-todos-btn--primary"
              disabled={readOnly || busy || bulkIds.length === 0}
              onClick={() => void decide(bulkIds, "approve")}
            >
              Approve
            </button>
            <button
              type="button"
              className="wb-todos-btn wb-todos-btn--reject"
              disabled={readOnly || busy || bulkIds.length === 0}
              onClick={() => void decide(bulkIds, "reject")}
            >
              Reject
            </button>
          </div>
        )}
        {tab !== "candidates" && (
          <div className="wb-todos-filters">
            <label className="wb-todos-field">
              Sort
              <select
                value={dueSort}
                onChange={(event) => setDueSort(event.target.value as DueSort)}
              >
                <option value="updated">Updated</option>
                <option value="due">Due date</option>
              </select>
            </label>
            <label className="wb-todos-field">
              Due
              <select
                value={dueFilter}
                onChange={(event) => setDueFilter(event.target.value as DueFilter)}
              >
                <option value="all">All</option>
                <option value="due">Has due date</option>
                <option value="overdue">Overdue</option>
                <option value="none">No due date</option>
              </select>
            </label>
          </div>
        )}
      </div>

      {error && <p className="wb-todos-error">{error}</p>}
      {extractError && (
        <div className="wb-todos-extract-error">
          <p>{extractError.message}</p>
          <button
            type="button"
            className="wb-todos-btn"
            disabled={readOnly || busy}
            onClick={() => void retryExtract()}
          >
            Retry
          </button>
        </div>
      )}

      {tab === "candidates" && visible.length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        <ul className="wb-todos-cards">
          {visible.map((item) => (
            <li key={item.id} className="wb-todos-card">
              {tab === "candidates" && (
                <label className="wb-todos-check">
                  <input
                    type="checkbox"
                    checked={selected.has(item.id)}
                    onChange={() => toggle(item.id)}
                    disabled={readOnly}
                  />
                  <span className="wb-sr-only">Select {item.title}</span>
                </label>
              )}
              {editingId === item.id ? (
                <form
                  className="wb-todos-edit"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void patch(item.id, {
                      title: editTitle,
                      due: editDue.trim() ? editDue : null,
                    });
                  }}
                >
                  <label className="wb-todos-field">
                    Title
                    <input
                      value={editTitle}
                      onChange={(event) => setEditTitle(event.target.value)}
                      disabled={readOnly}
                    />
                  </label>
                  <label className="wb-todos-field">
                    Due
                    <input
                      type="date"
                      value={editDue}
                      onChange={(event) => setEditDue(event.target.value)}
                      disabled={readOnly}
                    />
                  </label>
                  <button type="submit" className="wb-todos-btn wb-todos-btn--primary" disabled={readOnly || busy}>
                    Save
                  </button>
                  <button
                    type="button"
                    className="wb-todos-btn"
                    onClick={() => setEditingId(null)}
                  >
                    Cancel
                  </button>
                </form>
              ) : (
                <>
                  <h3 className="wb-todos-title">{item.title}</h3>
                  {item.rationale && <p className="wb-todos-rationale">{item.rationale}</p>}
                  <p className="wb-todos-meta">
                    {item.due && <span>Due {item.due}</span>}
                    {item.speaker && <span>{item.speaker}</span>}
                    {item.context && <span>{item.context}</span>}
                    {item.sourceMissing && <span>Source missing</span>}
                    {item.decision === "reject" && <span>Rejected</span>}
                  </p>
                  <p className="wb-todos-path">
                    <button
                      type="button"
                      className="wb-todos-link"
                      onClick={() => onDockPreview(selectionFromContentPath(todoMeetingPath(item)))}
                    >
                      {todoMeetingPath(item)}
                    </button>
                  </p>
                  <div className="wb-todos-actions">
                    {tab === "candidates" && (
                      <>
                        <button
                          type="button"
                          className="wb-todos-btn wb-todos-btn--primary"
                          disabled={readOnly || busy}
                          onClick={() => void decide([item.id], "approve")}
                        >
                          Approve
                        </button>
                        <button
                          type="button"
                          className="wb-todos-btn wb-todos-btn--reject"
                          disabled={readOnly || busy}
                          onClick={() => void decide([item.id], "reject")}
                        >
                          Reject
                        </button>
                      </>
                    )}
                    {tab === "open" && (
                      <>
                        <button
                          type="button"
                          className="wb-todos-btn"
                          disabled={readOnly || busy}
                          onClick={() => {
                            setEditingId(item.id);
                            setEditTitle(item.title);
                            setEditDue(item.due?.slice(0, 10) ?? "");
                          }}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="wb-todos-btn"
                          disabled={readOnly || busy}
                          onClick={() =>
                            void patch(item.id, { due: item.due ? null : new Date().toISOString().slice(0, 10) })
                          }
                        >
                          {item.due ? "Clear due" : "Set due"}
                        </button>
                        <button
                          type="button"
                          className="wb-todos-btn wb-todos-btn--primary"
                          disabled={readOnly || busy}
                          onClick={() => void patch(item.id, { status: "done" })}
                        >
                          Mark done
                        </button>
                        <button
                          type="button"
                          className="wb-todos-btn wb-todos-btn--reject"
                          disabled={readOnly || busy}
                          onClick={() => void remove(item.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                    {tab === "done" && (
                      <>
                        {item.decision === "approve" && (
                          <button
                            type="button"
                            className="wb-todos-btn"
                            disabled={readOnly || busy}
                            onClick={() => void patch(item.id, { status: "open" })}
                          >
                            Reopen
                          </button>
                        )}
                        <button
                          type="button"
                          className="wb-todos-btn wb-todos-btn--reject"
                          disabled={readOnly || busy}
                          onClick={() => void remove(item.id)}
                        >
                          Delete
                        </button>
                      </>
                    )}
                  </div>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
