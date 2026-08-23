"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import type { ReviewItem } from "@/lib/review-queue";
import { DeepResearchConfirm } from "./DeepResearchConfirm";

export interface ReviewCanvasProps {
  wikiId: string;
  readOnly?: boolean;
  active?: boolean;
  dataVersion?: number;
  onDockPreview: (selection: TreeSelection) => void;
  onPendingCountChange?: (count: number) => void;
  onOpenResearch?: (projectId: string) => void;
}

interface ReviewResponse {
  items?: ReviewItem[];
  pendingCount?: number;
}

export function ReviewCanvas({
  wikiId: _wikiId,
  readOnly = false,
  active = true,
  dataVersion = 0,
  onDockPreview,
  onPendingCountChange,
  onOpenResearch,
}: ReviewCanvasProps) {
  const empty = workbenchMode("review").emptyState ?? "No pending cards.";
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [research, setResearch] = useState<ReviewItem | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const body = await send<ReviewResponse>("/api/review-queue", { method: "GET" });
      if (seq !== loadSeq.current) return;
      setItems(body.items ?? []);
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setItems([]);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Review.");
    }
  }, [onPendingCountChange]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, dataVersion]);

  async function act(id: string, action: "skip" | "create-page") {
    if (readOnly) return;
    setBusy(true);
    setError(null);
    try {
      const body = await send<ReviewResponse>(`/api/review-queue/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ action }),
      });
      if (typeof body.pendingCount === "number") onPendingCountChange?.(body.pendingCount);
      await load();
    } catch (cause) {
      setError(writeFailure(cause, action === "skip" ? "skip the review" : "create the page").message);
    } finally {
      setBusy(false);
    }
  }

  async function confirmResearch(values: { topic: string; queries: string[] }) {
    setResearchBusy(true);
    setResearchError(null);
    try {
      const body = await send<{ project?: { id: string } }>("/api/research", {
        method: "POST",
        body: JSON.stringify({
          title: values.topic,
          question: values.topic,
          queries: values.queries,
          pageSlugs: research?.pageSlug ? [research.pageSlug] : [],
        }),
      });
      const id = body.project?.id;
      if (!id) {
        setResearchError("Deep Research did not return a project.");
        return;
      }
      setResearch(null);
      onOpenResearch?.(id);
    } catch (cause) {
      setResearchError(writeFailure(cause, "open Deep Research").message);
    } finally {
      setResearchBusy(false);
    }
  }

  return (
    <div className="wb-review">
      {error && <p className="wb-todos-error">{error}</p>}
      {items.length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        <ul className="wb-todos-cards">
          {items.map((item) => (
            <li key={item.id} className="wb-todos-card">
              <span className="wb-review-kind" aria-hidden="true">
                {item.kind === "warning" ? (
                  <svg viewBox="0 0 16 16" width="16" height="16">
                    <path
                      d="M8 1.5 15 14H1L8 1.5z"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="1.4"
                    />
                    <path d="M8 6v4.2M8 12.2v.2" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                ) : (
                  <svg viewBox="0 0 16 16" width="16" height="16">
                    <circle cx="8" cy="7" r="4.2" fill="none" stroke="currentColor" strokeWidth="1.4" />
                    <path d="M6 12h4M6.5 14h3" stroke="currentColor" strokeWidth="1.4" />
                  </svg>
                )}
              </span>
              <span className="wb-sr-only">
                {item.kind === "warning" ? "Warning" : "Suggestion"}
              </span>
              <h3 className="wb-todos-title">{item.title}</h3>
              {item.summary && <p className="wb-todos-rationale">{item.summary}</p>}
              <p className="wb-todos-path">
                <button
                  type="button"
                  className="wb-todos-link"
                  onClick={() => onDockPreview(selectionFromContentPath(item.path))}
                >
                  {item.path}
                </button>
              </p>
              <div className="wb-todos-actions">
                {item.queries.length > 0 && (
                  <button
                    type="button"
                    className="wb-todos-btn wb-todos-btn--primary"
                    disabled={readOnly || busy}
                    onClick={() => {
                      setResearchError(null);
                      setResearch(item);
                    }}
                  >
                    Deep Research
                  </button>
                )}
                <button
                  type="button"
                  className="wb-todos-btn"
                  disabled={readOnly || busy}
                  onClick={() => void act(item.id, "create-page")}
                >
                  Create Page
                </button>
                <button
                  type="button"
                  className="wb-todos-btn"
                  disabled={readOnly || busy}
                  onClick={() => void act(item.id, "skip")}
                >
                  Skip
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      <DeepResearchConfirm
        open={research !== null}
        initialTopic={research?.title ?? ""}
        initialQueries={research?.queries ?? []}
        busy={researchBusy}
        error={researchError}
        onCancel={() => {
          setResearch(null);
          setResearchError(null);
        }}
        onConfirm={(values) => void confirmResearch(values)}
      />
    </div>
  );
}
