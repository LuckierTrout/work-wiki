"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { readStoredResearchFill } from "@/lib/workbench-state";
import {
  RESEARCH_ACTIVE_STATUSES,
  RESEARCH_POLL_MS,
  researchIsPolling,
  researchStatusLabel,
  researchTaskLine,
  researchWikiId,
  parseResearchQueries,
} from "@/lib/research-panel";
import type { ResearchProject } from "@/lib/research-projects";

export interface ResearchCanvasProps {
  /** The rail's active wiki, or `null` before one exists. See `researchWikiId`. */
  wikiId: string | null;
  active?: boolean;
  filledId?: string | null;
  readOnly?: boolean;
}

interface ResearchResponse {
  projects?: ResearchProject[];
}

/** Newest last, five lines, exactly as Chat's live thinking viewport shows. */
function tail(lines: readonly string[]): string[] {
  return lines.slice(-5);
}

function reducedMotion(): boolean {
  if (typeof window === "undefined" || !window.matchMedia) return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The Research Panel: the Deep Research canvas.
 *
 * WHAT CHANGED. It used to show at most one card, and that card said "Draft —
 * web search has not started." for every project regardless of state — which
 * was true of the fill-only confirm it was built against and became a lie the
 * moment confirm started runs. It now lists every project, streams each one's
 * progress, and starts a run of its own.
 *
 * IT POLLS. The run is a queue task on another isolate, so there is no stream
 * for the browser to hold: progress and thinking are written onto the project
 * record and this reads them back. Chat's SSE event names are deliberately not
 * reused, and no research SSE route exists — a poll that reads the SAME record
 * the panel would render anyway cannot miss a line, because the line is stored
 * rather than emitted.
 */
export function ResearchCanvas({
  wikiId,
  active = true,
  filledId = null,
  readOnly = false,
}: ResearchCanvasProps) {
  const empty = workbenchMode("research").emptyState ?? "";
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [queryText, setQueryText] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [openThinking, setOpenThinking] = useState<Record<string, boolean>>({});
  const loadSeq = useRef(0);
  const startSeq = useRef(0);
  const wikiScope = useRef(wikiId);

  useEffect(() => {
    wikiScope.current = wikiId;
    loadSeq.current += 1;
    startSeq.current += 1;
    setProjects([]);
    setError(null);
    setStartError(null);
  }, [wikiId]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const wiki = researchWikiId(wikiId);
      const path = wiki
        ? `/api/research?wikiId=${encodeURIComponent(wiki)}`
        : "/api/research";
      const body = await send<ResearchResponse>(path, { method: "GET" });
      if (seq !== loadSeq.current) return;
      setProjects(body.projects ?? []);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Couldn’t load Deep Research.");
    }
  }, [wikiId]);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, filledId]);

  // Poll only while something is moving. A finished board is static, and an
  // interval against it would be a request every few seconds for the life of
  // the session; a queued project matters too, since the thing being waited for
  // is precisely a transition this panel cannot otherwise learn about.
  const streaming = projects.some(researchIsPolling);
  useEffect(() => {
    if (!active || !streaming) return;
    const timer = setInterval(() => {
      void load();
    }, RESEARCH_POLL_MS);
    return () => clearInterval(timer);
  }, [active, streaming, load]);

  const queries = parseResearchQueries(queryText);
  const canStart = !readOnly && topic.trim().length > 0 && queries.length > 0 && !starting;

  async function start() {
    if (!canStart) return;
    const originWikiId = wikiScope.current;
    const seq = ++startSeq.current;
    setStarting(true);
    setStartError(null);
    const vaultId = researchWikiId(originWikiId);
    let created: string | null = null;
    try {
      const body = await send<{ project?: { id: string } }>("/api/research", {
        method: "POST",
        body: JSON.stringify({
          title: topic.trim(),
          question: topic.trim(),
          queries,
          // The wiki the start came FROM, recorded so the run's auto-Ingest
          // lands there even if the rail moves on before it finishes — the same
          // record Graph and Review write on their own confirms. Omitted rather
          // than sent as the rail's `"current"` placeholder, which is not an id
          // any wiki has.
          ...(vaultId ? { vaultId } : {}),
        }),
      });
      created = body.project?.id ?? null;
      if (seq !== startSeq.current || wikiScope.current !== originWikiId) {
        if (created) {
          await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" })
            .catch(() => undefined);
        }
        return;
      }
      if (!created) {
        setStartError("Deep Research did not return a project.");
        return;
      }
      // CREATE THEN RUN, the same two calls Graph and Review make. Mode-direct
      // start is not a different door — it is the same one without a dialog.
      await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" });
      if (seq !== startSeq.current || wikiScope.current !== originWikiId) return;
      setTopic("");
      setQueryText("");
    } catch (cause) {
      if (seq !== startSeq.current || wikiScope.current !== originWikiId) return;
      setStartError(writeFailure(cause, "start Deep Research").message);
    } finally {
      if (seq === startSeq.current && wikiScope.current === originWikiId) {
        setStarting(false);
      }
      // RELOADED EITHER WAY, and this is the case that used to be missed: when
      // the RUN was refused, the create had already stored a project and
      // `queueResearchProject` had already marked it failed, but nothing
      // re-read the list — so the owner saw the error sentence above an empty
      // panel still reading "No research tasks yet." The row and the sentence
      // now arrive together. A wiki switch fences the reload so Wiki A's
      // response cannot paint Wiki B.
      if (created && seq === startSeq.current && wikiScope.current === originWikiId) {
        await load();
      }
    }
  }

  async function cancel(id: string) {
    if (readOnly) return;
    const originWikiId = wikiScope.current;
    try {
      await send(`/api/research/${encodeURIComponent(id)}/run`, {
        method: "POST",
        body: JSON.stringify({ action: "cancel" }),
      });
      if (wikiScope.current === originWikiId) await load();
    } catch (cause) {
      if (wikiScope.current === originWikiId) {
        setError(writeFailure(cause, "cancel Deep Research").message);
      }
    }
  }

  async function runExisting(id: string) {
    if (readOnly) return;
    const originWikiId = wikiScope.current;
    try {
      await send(`/api/research/${encodeURIComponent(id)}/run`, { method: "POST" });
      if (wikiScope.current === originWikiId) await load();
    } catch (cause) {
      if (wikiScope.current === originWikiId) {
        setError(writeFailure(cause, "start Deep Research").message);
      }
    }
  }

  const highlight = filledId ?? readStoredResearchFill();
  // NEWEST-UPDATED FIRST, with the highlighted project pulled to the top. The
  // route already sorts by `updatedAt`; the only reordering here is the one the
  // rail asked for by handing over a project id.
  const shown = [...projects].sort((a, b) => {
    if (a.id === highlight) return -1;
    if (b.id === highlight) return 1;
    return 0;
  });

  return (
    <div className="wb-research">
      {error && <p className="wb-todos-error">{error}</p>}

      <div className="wb-research-start">
        <label className="wb-set-label" htmlFor="wb-research-topic">
          Topic
        </label>
        <input
          id="wb-research-topic"
          className="wb-set-input"
          type="text"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          readOnly={readOnly}
          placeholder="What should Deep Research find out?"
        />
        <label className="wb-set-label" htmlFor="wb-research-queries">
          Queries
        </label>
        <textarea
          id="wb-research-queries"
          className="wb-dr-queries"
          rows={3}
          value={queryText}
          onChange={(event) => setQueryText(event.target.value)}
          readOnly={readOnly}
          placeholder="One search query per line"
        />
        <button
          type="button"
          className="wb-set-action"
          onClick={() => void start()}
          // A real `disabled` here, unlike the Settings selects: there is
          // nothing to READ on this control — it is an action, not a value — so
          // taking it out of the tab order hides no information. The reason it
          // is off rides in the sentence below.
          disabled={!canStart}
        >
          {starting ? "Starting…" : "Start Deep Research"}
        </button>
        <span className="wb-set-hint">
          {readOnly
            ? "Deep Research cannot start while this deployment is read-only."
            : queries.length === 0
              ? "Add a topic and at least one query."
              : `${queries.length} ${queries.length === 1 ? "query" : "queries"} ready.`}
        </span>
        {startError && <p className="wb-todos-error">{startError}</p>}
      </div>

      {shown.length === 0 ? (
        <p className="wb-empty">{empty}</p>
      ) : (
        <ul className="wb-todos-cards">
          {shown.map((project) => (
            <li key={project.id}>
              <ResearchTask
                project={project}
                highlighted={project.id === highlight}
                readOnly={readOnly}
                thinkingOpen={openThinking[project.id] === true}
                onToggleThinking={(open) =>
                  setOpenThinking((current) => ({ ...current, [project.id]: open }))
                }
                onCancel={() => void cancel(project.id)}
                onRun={() => void runExisting(project.id)}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface ResearchTaskProps {
  project: ResearchProject;
  highlighted: boolean;
  readOnly: boolean;
  thinkingOpen: boolean;
  onToggleThinking: (open: boolean) => void;
  onCancel: () => void;
  onRun: () => void;
}

/**
 * One task row.
 *
 * DISTINGUISHABLE, which the spec asks for by name: the status is a chip with
 * its own modifier class AND its own word, the topic is the heading, and the
 * progress line names the query count. Two collecting runs therefore differ by
 * heading and by progress even where the chip is identical — colour is not
 * carrying the distinction.
 */
function ResearchTask({
  project,
  highlighted,
  readOnly,
  thinkingOpen,
  onToggleThinking,
  onCancel,
  onRun,
}: ResearchTaskProps) {
  const liveRef = useRef<HTMLDivElement | null>(null);
  const thinking = Array.isArray(project.thinking) ? project.thinking : [];
  const live = RESEARCH_ACTIVE_STATUSES.includes(project.status);
  const lines = tail(thinking);
  const [liveThinkingOpen, setLiveThinkingOpen] = useState(true);

  // FOLLOW THE NEWEST LINE. `useLayoutEffect` so the scroll happens in the same
  // frame the new line paints — in a plain effect the viewport visibly lands on
  // the previous bottom first. `prefers-reduced-motion` JUMPS: `smooth` is an
  // animation, and the one thing the media query means is "do not animate".
  useLayoutEffect(() => {
    const node = liveRef.current;
    if (!node || lines.length === 0) return;
    // `prefers-reduced-motion` JUMPS, and it jumps by ASSIGNING `scrollTop`
    // rather than by passing `behavior: "auto"` — same destination, and it also
    // covers the platforms with no `scrollTo` at all (jsdom, a few embedded
    // webviews), which the shell's `scrollIntoView?.()` guards against the same
    // way. A viewport that throws is strictly worse than one that does not
    // animate.
    if (reducedMotion() || typeof node.scrollTo !== "function") {
      node.scrollTop = node.scrollHeight;
      return;
    }
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" });
  }, [lines.length, project.updatedAt]);

  return (
    <article
      className={`wb-todos-card wb-research-task wb-research-task--${project.status}${
        highlighted ? " wb-research-task--focus" : ""
      }`}
      // The rail handed this panel a project id; saying WHICH row that was is
      // the whole point of the highlight, and a border cannot say it.
      aria-current={highlighted ? "true" : undefined}
    >
      <h3 className="wb-todos-title">{project.title}</h3>
      <p className="wb-research-status">
        <span className="wb-research-chip">{researchStatusLabel(project.status)}</span>
        {project.provider ? <span className="wb-research-chip">{project.provider}</span> : null}
      </p>
      <p className="wb-todos-meta">{researchTaskLine(project)}</p>
      {project.error ? <p className="wb-todos-error">{project.error}</p> : null}
      <ul className="wb-research-queries">
        {(Array.isArray(project.queries) ? project.queries : []).map((query) => (
          <li key={query}>{query}</li>
        ))}
      </ul>

      {/* NO CHROME WHEN THERE IS NO THINKING — the Chat rule, kept. */}
      {thinking.length > 0 ? (
        <details
          className="wb-chat-thinking"
          open={live ? liveThinkingOpen : thinkingOpen}
          onToggle={(event) => {
            const open = (event.currentTarget as HTMLDetailsElement).open;
            if (live) setLiveThinkingOpen(open);
            onToggleThinking(open);
          }}
        >
          <summary>Thinking</summary>
          {live ? (
            // The live viewport: five lines, newer more opaque, `aria-live` polite.
            <div
              className="wb-chat-thinking--live"
              aria-live="polite"
              ref={liveRef}
            >
              {lines.map((line, index, all) => (
                <p key={`${line}-${index}`} style={{ opacity: (index + 1) / all.length }}>
                  {line}
                </p>
              ))}
            </div>
          ) : <pre>{thinking.join("\n")}</pre>}
        </details>
      ) : null}

      {live && !readOnly ? (
        <button type="button" className="wb-set-action" onClick={onCancel}>
          Cancel
        </button>
      ) : null}
      {!live && !readOnly && ["draft", "failed", "cancelled"].includes(project.status) ? (
        <button type="button" className="wb-set-action" onClick={onRun}>
          {project.status === "draft" ? "Start" : "Retry"}
        </button>
      ) : null}
    </article>
  );
}
