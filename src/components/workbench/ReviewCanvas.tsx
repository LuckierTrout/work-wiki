"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { normalizeReviewCount } from "@/lib/review-count";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import type { ReviewItem } from "@/lib/review-queue";
import { DeepResearchConfirm } from "./DeepResearchConfirm";

export interface ReviewCanvasProps {
  wikiId: string | null;
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
  wikiId,
  readOnly = false,
  active = true,
  dataVersion = 0,
  onDockPreview,
  onPendingCountChange,
  onOpenResearch,
}: ReviewCanvasProps) {
  const empty = workbenchMode("review").emptyState ?? "No pending cards.";
  const [items, setItems] = useState<ReviewItem[]>([]);
  const [itemsWikiId, setItemsWikiId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyWikiId, setBusyWikiId] = useState<string | null>(null);
  const busy = busyWikiId === wikiId;
  const [research, setResearch] = useState<ReviewItem | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const actionSeq = useRef(0);
  const researchSeq = useRef(0);
  const wikiScope = useRef(wikiId);

  useEffect(() => {
    wikiScope.current = wikiId;
    loadSeq.current += 1;
    actionSeq.current += 1;
    researchSeq.current += 1;
    setBusyWikiId(null);
    setResearch(null);
    setResearchBusy(false);
    setResearchError(null);
  }, [wikiId]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    if (!wikiId) {
      setItems([]);
      setItemsWikiId(null);
      setError(null);
      onPendingCountChange?.(0);
      return;
    }
    try {
      const query = `?wikiId=${encodeURIComponent(wikiId)}`;
      const body = await send<ReviewResponse>(`/api/review-queue${query}`, { method: "GET" });
      if (seq !== loadSeq.current) return;
      setItems(body.items ?? []);
      setItemsWikiId(wikiId);
      const next = normalizeReviewCount(body.pendingCount);
      if (next !== null) onPendingCountChange?.(next);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setItems([]);
      setItemsWikiId(wikiId);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Review.");
    }
  }, [onPendingCountChange, wikiId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, dataVersion]);

  async function act(id: string, action: "skip" | "create-page") {
    if (readOnly || !wikiId) return;
    const actedWikiId = wikiId;
    const seq = ++actionSeq.current;
    setBusyWikiId(actedWikiId);
    setError(null);
    try {
      const body = await send<ReviewResponse>(`/api/review-queue/${encodeURIComponent(id)}`, {
        method: "POST",
        body: JSON.stringify({ action, wikiId }),
      });
      if (seq !== actionSeq.current || wikiScope.current !== actedWikiId) return;
      const next = normalizeReviewCount(body.pendingCount);
      if (next !== null) onPendingCountChange?.(next);
      await load();
    } catch (cause) {
      if (seq !== actionSeq.current || wikiScope.current !== actedWikiId) return;
      setError(writeFailure(cause, action === "skip" ? "skip the review" : "create the page").message);
    } finally {
      if (seq === actionSeq.current && wikiScope.current === actedWikiId) setBusyWikiId(null);
    }
  }

  async function confirmResearch(values: { topic: string; queries: string[] }) {
    const originWikiId = wikiScope.current;
    const originPageSlug = research?.pageSlug;
    const seq = ++researchSeq.current;
    if (!originWikiId) return;
    setResearchBusy(true);
    setResearchError(null);
    try {
      const body = await send<{ project?: { id: string } }>("/api/research", {
        method: "POST",
        body: JSON.stringify({
          title: values.topic,
          question: values.topic,
          queries: values.queries,
          pageSlugs: originPageSlug ? [originPageSlug] : [],
        }),
      });
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
      const id = body.project?.id;
      if (!id) {
        setResearchError("Deep Research did not return a project.");
        return;
      }
      setResearch(null);
      onOpenResearch?.(id);
    } catch (cause) {
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
      setResearchError(writeFailure(cause, "open Deep Research").message);
    } finally {
      if (seq === researchSeq.current && wikiScope.current === originWikiId) {
        setResearchBusy(false);
      }
    }
  }

  return (
    <div className="wb-review">
      {error && <p className="wb-todos-error">{error}</p>}
      {(itemsWikiId === wikiId ? items : []).length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        <ul className="wb-todos-cards">
          {(itemsWikiId === wikiId ? items : []).map((item) => (
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
                    disabled={readOnly || busy || item.status === "creating"}
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
                  disabled={readOnly || busy || item.status === "creating"}
                  onClick={() => void act(item.id, "create-page")}
                >
                  Create Page
                </button>
                <button
                  type="button"
                  className="wb-todos-btn"
                  disabled={readOnly || busy || item.status === "creating"}
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
