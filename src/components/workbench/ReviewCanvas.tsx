"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { RESEARCH_CREATE_READ_ONLY_COPY, researchWikiId } from "@/lib/research-panel";
import { normalizeReviewCount } from "@/lib/review-count";
import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
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

/**
 * Why **Create Page** and **Skip** refuse on a read-only deployment (DW-531).
 *
 * The CLIENT mirror of `READ_ONLY_REFUSAL.reviewQueue` — what
 * `POST /api/review-queue/[id]` answers for both actions — character-identical
 * to it and pinned by `read-only-copy-parity.test.ts`. Exported because it is
 * the sentence those two refused controls POINT AT through `aria-describedby`.
 *
 * NOT the third control's sentence. **Deep Research** resolves no card: it
 * stands in front of `POST /api/research` and names
 * {@link RESEARCH_CREATE_READ_ONLY_COPY} instead — three controls in one card,
 * two doors, two sentences, the policy the DW-386 review settled on.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const REVIEW_QUEUE_READ_ONLY_COPY =
  "Review items cannot be changed while this deployment is read-only.";

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
  const visible = useSurfaceVisible(active);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
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
  /**
   * One id per DOOR, not one per card.
   *
   * **Create Page** and **Skip** meet `POST /api/review-queue/[id]`;
   * **Deep Research** meets `POST /api/research` and resolves no card at all.
   * A single shared note would announce one door's refusal beside the other's
   * control. Both notes render once for the whole list rather than per card —
   * the sentence is a property of the deployment, not of a row — and only while
   * there is a control of that kind on screen to describe.
   */
  const queueNoteId = useId();
  const researchNoteId = useId();

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
    if (!visibleRef.current) return;
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
      if (!visibleRef.current || seq !== loadSeq.current) return;
      setItems(body.items ?? []);
      setItemsWikiId(wikiId);
      const next = normalizeReviewCount(body.pendingCount);
      if (next !== null) onPendingCountChange?.(next);
      setError(null);
    } catch (cause) {
      if (!visibleRef.current || seq !== loadSeq.current) return;
      setItems([]);
      setItemsWikiId(wikiId);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Review.");
    }
  }, [onPendingCountChange, wikiId]);

  useEffect(() => {
    if (!visible) return;
    void load();
    return () => { loadSeq.current += 1; };
  }, [visible, load, dataVersion]);

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
    // DEFENCE IN DEPTH for a future opener. Today the button that opens this
    // dialog early-returns, so `readOnly` cannot reach here — but this is the
    // door-facing call, the same shape `act` above carries, and it is the one
    // place a second opener could not route around. It STATES THE REASON rather
    // than dropping the confirm: a bare `return` would leave the dialog open
    // with a spent Confirm and no explanation, which is the silent-refusal
    // shape this whole change exists to remove.
    if (readOnly) {
      setResearchError(RESEARCH_CREATE_READ_ONLY_COPY);
      return;
    }
    const originWikiId = wikiScope.current;
    const originPageSlug = research?.pageSlug;
    const seq = ++researchSeq.current;
    if (!originWikiId) return;
    setResearchBusy(true);
    setResearchError(null);
    let created: string | null = null;
    try {
      const body = await send<{ project?: { id: string } }>("/api/research", {
        method: "POST",
        body: JSON.stringify({
          title: values.topic,
          question: values.topic,
          queries: values.queries,
          pageSlugs: originPageSlug ? [originPageSlug] : [],
          // The wiki the confirm came FROM, recorded on the project so the
          // auto-Ingest lands there even if the rail has moved on by the time
          // the run finishes. `originWikiId` still SCOPES this canvas's reads,
          // but only a real id is persisted — never the rail's `"current"`
          // placeholder, which resolves to no wiki forever.
          ...(researchWikiId(originWikiId) ? { vaultId: researchWikiId(originWikiId) } : {}),
        }),
      });
      created = body.project?.id ?? null;
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) {
        // The confirm is spent. Always start the run so a Wiki switch cannot
        // leave an orphan draft; the UI fence below still drops the dialog.
        if (created) {
          await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" }).catch(
            () => undefined,
          );
        }
        return;
      }
      if (!created) {
        setResearchError("Deep Research did not return a project.");
        return;
      }
      // CREATE THEN RUN. Confirm used to stop at the create, which left a draft
      // project nothing would ever search — the owner had confirmed a topic and
      // got a card that said web search had not started. The run is a second
      // call because create and start are separately refusable: a create that
      // succeeded and a start that was refused for a missing provider key is a
      // real state, and it has to be reportable as itself.
      await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" });
    } catch (cause) {
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
      // ONE CONFIRM, ONE PROJECT — the same rule as `GraphCanvas`. A refused RUN
      // left this dialog open with its sentence, and pressing Confirm again
      // created a second project for the same Review card. Once the create has
      // landed the dialog closes and the panel opens on the project, which is
      // where the refusal is recorded. Only a failed CREATE keeps the dialog.
      if (!created) {
        setResearchError(writeFailure(cause, "open Deep Research").message);
        return;
      }
    } finally {
      if (seq === researchSeq.current && wikiScope.current === originWikiId) {
        setResearchBusy(false);
      }
    }
    if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
    // The Review card stays PENDING: Deep Research is a second opinion on it,
    // not a decision about it. Only Skip and Create Page resolve a card.
    setResearch(null);
    onOpenResearch?.(created);
  }

  // The cards this canvas is actually showing: Wiki A's rows are never painted
  // under Wiki B's id. Named once so the read-only notes below can be guarded
  // on the SAME list the controls they describe are rendered from.
  const shown = itemsWikiId === wikiId ? items : [];

  return (
    <SurfacePresentation active={active}>
    <div className="wb-review">
      {error && <p className="wb-todos-error">{error}</p>}
      {shown.length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        <ul className="wb-todos-cards">
          {shown.map((item) => (
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
              {/* `busy` and `creating` are TRANSIENT and keep `disabled`, but
                  both YIELD to the standing refusal (DW-531, the
                  DW-191/DW-299 shape): a request that never settles would
                  otherwise leave `busy` true forever and take the controls
                  carrying the sentence out of the tab order — reached by a
                  stalled write instead of by a fieldset. `aria-disabled` is
                  the standing state; the handlers are what refuse. */}
              <div className="wb-todos-actions">
                {item.queries.length > 0 && (
                  <button
                    type="button"
                    className="wb-todos-btn wb-todos-btn--primary"
                    disabled={!readOnly && (busy || item.status === "creating")}
                    aria-disabled={readOnly || undefined}
                    aria-describedby={readOnly ? researchNoteId : undefined}
                    onClick={() => {
                      if (readOnly) return;
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
                  disabled={!readOnly && (busy || item.status === "creating")}
                  aria-disabled={readOnly || undefined}
                  aria-describedby={readOnly ? queueNoteId : undefined}
                  onClick={() => void act(item.id, "create-page")}
                >
                  Create Page
                </button>
                <button
                  type="button"
                  className="wb-todos-btn"
                  disabled={!readOnly && (busy || item.status === "creating")}
                  aria-disabled={readOnly || undefined}
                  aria-describedby={readOnly ? queueNoteId : undefined}
                  onClick={() => void act(item.id, "skip")}
                >
                  Skip
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {/* Identified so each refused control above can point at its OWN door's
          sentence. The queue note rides on there being a card at all — every
          card carries Create Page and Skip — while the create note rides on
          some card actually OFFERING Deep Research, which only a card with
          queries does. A note for a control the owner was never offered would
          announce the refusal of an operation that is not on screen, and
          `aria-describedby` would resolve to nothing. Not `role="alert"` —
          nothing failed; it is the deployment's standing state. */}
      {readOnly && shown.length > 0 ? (
        <p id={queueNoteId} className="wb-todos-meta">
          {REVIEW_QUEUE_READ_ONLY_COPY}
        </p>
      ) : null}
      {readOnly && shown.some((item) => item.queries.length > 0) ? (
        <p id={researchNoteId} className="wb-todos-meta">
          {RESEARCH_CREATE_READ_ONLY_COPY}
        </p>
      ) : null}
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
    </SurfacePresentation>
  );
}
