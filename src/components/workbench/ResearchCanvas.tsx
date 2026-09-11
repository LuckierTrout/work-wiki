"use client";

import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { SurfacePresentation, useSurfaceVisible } from "@/hooks/useSurfaceVisibility";
import { send, writeFailure } from "@/lib/workbench-request";
import { workbenchMode } from "@/lib/workbench-modes";
import { readStoredResearchFill } from "@/lib/workbench-state";
import {
  RESEARCH_ACTIVE_STATUSES,
  RESEARCH_CREATE_READ_ONLY_COPY,
  RESEARCH_MUTATE_READ_ONLY_COPY,
  RESEARCH_POLL_MS,
  RESEARCH_REPAIRED_COPY,
  RESEARCH_REPAIR_LABEL,
  RESEARCH_REPAIR_NOTE_COPY,
  RESEARCH_REPAIR_PATH,
  researchIsPolling,
  researchOffersCancel,
  researchOffersRun,
  researchRegistryRepairable,
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
 *
 * TWO DOORS, TWO SENTENCES on a read-only deployment (DW-529, DW-644). The
 * create form meets `POST /api/research` and names
 * {@link RESEARCH_CREATE_READ_ONLY_COPY} in the hint under its button; the two
 * row controls, Cancel and Start/Retry, meet `POST /api/research/[id]/run` and
 * name {@link RESEARCH_MUTATE_READ_ONLY_COPY} in one list-level note they share
 * through `aria-describedby`. Both are the CLIENT mirrors of what those doors
 * answer, pinned by `read-only-copy-parity.test.ts`.
 */
export function ResearchCanvas({
  wikiId,
  active = true,
  filledId = null,
  readOnly = false,
}: ResearchCanvasProps) {
  const visible = useSurfaceVisible(active);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const empty = workbenchMode("research").emptyState ?? "";
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [queryText, setQueryText] = useState("");
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const [openThinking, setOpenThinking] = useState<Record<string, boolean>>({});
  /** A repair is in flight. See `repair()` — NOT the same fact as `readOnly`. */
  const [repairing, setRepairing] = useState(false);
  /**
   * A repair LANDED, and this panel has not been re-read for another reason
   * since.
   *
   * The canvas has no feedback banner of its own — `error` is the only thing it
   * says — so a successful repair otherwise showed as nothing at all: the
   * refusal vanished and an empty board appeared, with no statement that the
   * owner's whole registry had just been quarantined. That is the one operation
   * on this surface that cannot be undone, and it is the one that said least.
   */
  const [repaired, setRepaired] = useState(false);
  // ONE id for the WHOLE list, minted here rather than inside the `.map()`
  // below: a `useId()` per card would mint a duplicate note per row, and
  // `aria-describedby` would resolve to whichever node the browser found first.
  const mutateNoteId = useId();
  /** The **Repair** note's id — see the control's `aria-describedby`. */
  const repairNoteId = useId();
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
    setStarting(false);
    // A repair belongs to the wiki it was made from; carrying the notice across
    // a rail move would claim it about a registry nobody touched.
    setRepairing(false);
    setRepaired(false);
  }, [wikiId]);

  const load = useCallback(async () => {
    if (!visibleRef.current) return;
    const seq = ++loadSeq.current;
    try {
      const wiki = researchWikiId(wikiId);
      const path = wiki
        ? `/api/research?wikiId=${encodeURIComponent(wiki)}`
        : "/api/research";
      const body = await send<ResearchResponse>(path, { method: "GET" });
      if (!visibleRef.current || seq !== loadSeq.current) return;
      setProjects(body.projects ?? []);
      setError(null);
      // The repair notice is about THIS read's predecessor. Any later read —
      // a poll tick, a start, the rail handing over a project — has moved on
      // from it, so it is cleared here and set again by `repair()` only after
      // the read it makes itself. `repair()` awaits that read, so this runs
      // before the notice goes up rather than after.
      setRepaired(false);
    } catch (cause) {
      if (!visibleRef.current || seq !== loadSeq.current) return;
      setError(cause instanceof Error ? cause.message : "Couldn’t load Deep Research.");
      setRepaired(false);
    }
  }, [wikiId]);

  useEffect(() => {
    if (!visible) return;
    void load();
    return () => { loadSeq.current += 1; };
  }, [visible, load, filledId]);

  // Poll only while something is moving. A finished board is static, and an
  // interval against it would be a request every few seconds for the life of
  // the session; a queued project matters too, since the thing being waited for
  // is precisely a transition this panel cannot otherwise learn about.
  const streaming = error !== null || projects.some(researchIsPolling);
  useEffect(() => {
    if (!visible || !streaming) return;
    const timer = setInterval(() => {
      void load();
    }, RESEARCH_POLL_MS);
    return () => clearInterval(timer);
  }, [visible, streaming, load]);

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

  /**
   * The way OUT of a wedged registry, from the canvas that reports it (DW-688).
   *
   * `parseRegistry` refuses every research door for the tenant and each refusal
   * ends by naming `POST /api/research/repair` — an instruction with nothing in
   * the product behind it until this. Offered only when the failure carries the
   * store's own marker, so an unrelated read failure never puts a
   * quarantine-the-registry button in front of the owner.
   *
   * READ-ONLY REFUSES HERE, unlike the Studio's copy of this control. This
   * canvas takes `readOnly` as a PROP from `ModeCanvas`, independent of the
   * `GET /api/research` that just failed, so the flag is trustworthy and the
   * DW-644 shape applies in full: the button renders rather than vanishing, it
   * is `aria-disabled`, it points at the list-level `researchMutate` note, and
   * THIS handler is what refuses. The Studio's flag is adopted only from a GET
   * that succeeded and is stale by construction wherever this control exists,
   * which is why it derives no `aria-disabled` at all.
   *
   * ONE AT A TIME, and this guard is not cosmetic. The repair is DESTRUCTIVE
   * and it is not idempotent: the second POST of a double-click meets a
   * registry the first one already made parseable, and the door answers 409
   * "the research projects file reads fine; there is nothing to repair." That
   * sentence carries no `REPAIR_HINT`, so a repair that SUCCEEDED would end
   * with a refusal on screen and the control gone. `repairing` is its own state
   * and drives a real `disabled` — deliberately NOT folded into the
   * `aria-disabled` the read-only refusal uses, because "busy for a moment" and
   * "this deployment will never allow it" are different facts and a screen
   * reader must not hear them as one.
   */
  async function repair() {
    if (readOnly || repairing) return;
    const originWikiId = wikiScope.current;
    setRepairing(true);
    try {
      await send(RESEARCH_REPAIR_PATH, { method: "POST" });
      // The repair's whole visible effect is on the list: re-reading is what
      // turns the refusal into the empty board the quarantine produced. `load`
      // clears `error`, and with it this control.
      if (wikiScope.current === originWikiId) {
        await load();
        // AFTER the read, so the notice sits over the board the quarantine
        // produced rather than over the one it replaced — and `load` clears the
        // flag first, so a later read takes the notice back down.
        if (wikiScope.current === originWikiId) setRepaired(true);
      }
    } catch (cause) {
      if (wikiScope.current === originWikiId) {
        // The SERVER's sentence for every refusal — 409 nothing to repair, 503
        // busy, 403 read-only, 500 fault. The client cannot tell them apart and
        // must not claim a repair it did not get.
        setError(writeFailure(cause, "repair the research projects file").message);
      }
    } finally {
      if (wikiScope.current === originWikiId) setRepairing(false);
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

  // Whether the failure on screen is the one the owner can fix from here. Read
  // once so the control and the read-only note it points at cannot disagree.
  const repairable = error !== null && researchRegistryRepairable(error);

  return (
    <SurfacePresentation active={active}>
    <div className="wb-research">
      {error && <p className="wb-todos-error">{error}</p>}
      {/* THE STATEMENT A DESTRUCTIVE OPERATION OWES. This canvas has no
          feedback banner, so without this a landed repair showed as nothing —
          the refusal simply vanished. `role="status"` rather than `alert`:
          nothing failed, and the owner asked for this. */}
      {repaired ? (
        <p className="wb-research-repaired" role="status">{RESEARCH_REPAIRED_COPY}</p>
      ) : null}
      {repairable ? (
        <div className="wb-research-repair">
          {/* RENDERED, NOT HIDDEN, under `readOnly` (DW-644): the owner meets a
              control and the door's own sentence rather than an absence with no
              reason. `repair()` is what refuses.

              TWO DESCRIPTIONS, NOT ONE. The repair note says what pressing this
              costs — the projects do not come back — and that is true on every
              deployment, so it is named ALWAYS. The read-only sentence is an
              ADDITION to it, not a replacement: pointing only at the mutate
              note under `readOnly` would withdraw the warning exactly where the
              control is least explicable, and pointing at neither on a writable
              deployment left a screen reader with a bare "Repair". */}
          <button
            type="button"
            className="wb-set-action"
            aria-disabled={readOnly || undefined}
            aria-describedby={readOnly ? `${repairNoteId} ${mutateNoteId}` : repairNoteId}
            // A REAL `disabled`, and only for the in-flight moment — see
            // `repair()`. The read-only refusal stays `aria-disabled`, because
            // that control must remain focusable to announce its reason.
            disabled={repairing}
            onClick={() => void repair()}
          >
            {repairing ? "Repairing…" : RESEARCH_REPAIR_LABEL}
          </button>
          <p id={repairNoteId} className="wb-todos-meta">{RESEARCH_REPAIR_NOTE_COPY}</p>
        </div>
      ) : null}

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
          {/* THE CREATE DOOR'S OWN SENTENCE (DW-529), not a fourth wording of
              it. This control's first call is `POST /api/research`, which
              answers `READ_ONLY_REFUSAL.researchCreate`; the literal that used
              to sit here ("Deep Research cannot start…") was owned by nobody
              and pinned by nothing, so the owner read one sentence before
              pressing and would have met another in the 403. */}
          {readOnly
            ? RESEARCH_CREATE_READ_ONLY_COPY
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
                mutateNoteId={mutateNoteId}
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
      {/* ONE note for the DOOR, rendered once for the whole list (DW-644).
          Cancel and Start/Retry both meet `POST /api/research/[id]/run`, which
          answers `READ_ONLY_REFUSAL.researchMutate`, so one sentence describes
          both — and it rides on some shown row actually OFFERING one of them,
          read through the same predicates the rows render through. A note for a
          control the owner was never offered would announce the refusal of an
          operation that is not on screen, and `aria-describedby` would resolve
          to nothing. Not `role="alert"` — nothing failed; it is the
          deployment's standing state.

          WIDENED FOR **Repair** (DW-688). That control meets
          `POST /api/research/repair`, which answers this same
          `researchMutate` sentence — repairing IS "change my research" — and it
          points here through `aria-describedby`. When the registry is wedged
          there are no rows at all, so the row predicates below are false and
          the note would not have rendered: the description would have resolved
          to nothing, which describes nothing. */}
      {readOnly
        && (repairable
          || shown.some((project) => researchOffersCancel(project) || researchOffersRun(project))) ? (
        <p id={mutateNoteId} className="wb-todos-meta">
          {RESEARCH_MUTATE_READ_ONLY_COPY}
        </p>
      ) : null}
    </div>
    </SurfacePresentation>
  );
}

interface ResearchTaskProps {
  project: ResearchProject;
  highlighted: boolean;
  readOnly: boolean;
  /** The list-level mutate note's id — see `ResearchCanvas`. */
  mutateNoteId: string;
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
  mutateNoteId,
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

      {/* RENDERED, NOT HIDDEN, on a read-only deployment (DW-644) — the shape
          DW-531 set at the Graph and Review canvases. These two used to vanish
          under `readOnly`, which is the refusal that explains least: the owner
          met a card with no controls and no reason. `aria-disabled` keeps them
          focusable and announced, `aria-describedby` names the door's own
          sentence, and `cancel`/`runExisting` are what refuse. Neither control
          has any TRANSIENT state of its own, so nothing is left in `disabled`
          here. The visibility rules themselves are unchanged — they are simply
          read from the predicates the note above shares. */}
      {researchOffersCancel(project) ? (
        <button
          type="button"
          className="wb-set-action"
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? mutateNoteId : undefined}
          onClick={onCancel}
        >
          Cancel
        </button>
      ) : null}
      {researchOffersRun(project) ? (
        <button
          type="button"
          className="wb-set-action"
          aria-disabled={readOnly || undefined}
          aria-describedby={readOnly ? mutateNoteId : undefined}
          onClick={onRun}
        >
          {project.status === "draft" ? "Start" : "Retry"}
        </button>
      ) : null}
    </article>
  );
}
