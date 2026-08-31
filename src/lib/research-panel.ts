import { URL_MAX_CHARS } from "./research-projects";
import type { ResearchProject, ResearchProjectStatus } from "./research-projects";

/**
 * The Research Panel's vocabulary, as pure functions.
 *
 * Client-safe and free of React so the suite can assert the SENTENCES without
 * mounting anything — the same split `workbench-settings.ts` uses for its copy.
 * A status word or a progress line composed inline in the component is a string
 * only a render test can see, and these are the strings the acceptance criteria
 * are written about.
 */

/**
 * The statuses that mean "this run is going somewhere on its own".
 *
 * `queued` IS active here, which is the one that matters: the fourth start is
 * queued and waiting, and a panel that polled only while something was
 * `collecting` would show that project frozen at "waiting" until the owner
 * reloaded — precisely the transition it exists to display.
 *
 * `ready` is the synthesis window. It is the shortest of the three and the
 * easiest to leave out, and leaving it out would stop the poll exactly while
 * the LLM call the owner is waiting on runs.
 */
export const RESEARCH_ACTIVE_STATUSES: readonly ResearchProjectStatus[] = [
  "queued",
  "collecting",
  "ready",
];

/**
 * Whether the panel must keep polling this row.
 *
 * Active statuses always poll. A `complete` row whose outbox is still draining
 * must poll too — otherwise a partial ingest that already wrote the Page
 * freezes at "N still pending" and never retries.
 */
export function researchIsPolling(project: ResearchProject): boolean {
  if (project.deliveryBlocked) return false;
  if (RESEARCH_ACTIVE_STATUSES.includes(project.status)) return true;
  return project.completion !== undefined && project.completion.phase !== "done";
}

/**
 * The statuses a row can be RE-started from.
 *
 * A run that is going somewhere is not restartable (it is cancellable), and a
 * `complete` row has nothing left to start — so the three that remain are the
 * ones a Start/Retry control is offered for.
 */
const RESEARCH_RESTARTABLE_STATUSES: readonly ResearchProjectStatus[] = [
  "draft",
  "failed",
  "cancelled",
];

/**
 * Whether the canvas offers this row a **Cancel** (DW-644).
 *
 * The door is `POST /api/research/[id]/run` with `{action:"cancel"}`, which
 * answers `READ_ONLY_REFUSAL.researchMutate` — the same door
 * {@link researchOffersRun} meets, which is why one note describes both.
 *
 * A PREDICATE RATHER THAN AN INLINE CONDITION because the row and the
 * list-level read-only note now read the SAME rule: two copies is how a note
 * appears beside a control that is not on screen, describing the refusal of an
 * operation the owner was never offered.
 */
export function researchOffersCancel(project: ResearchProject): boolean {
  return RESEARCH_ACTIVE_STATUSES.includes(project.status);
}

/**
 * Whether the canvas offers this row a **Start** / **Retry** (DW-644).
 *
 * The same door as {@link researchOffersCancel}, `POST /api/research/[id]/run`,
 * without a body. A row that already carries a DELIVERED completion is offered
 * nothing: the research is done and the Page is written. A `deliveryBlocked`
 * completion is the exception — that delivery never landed, so the run is
 * still worth retrying.
 */
export function researchOffersRun(project: ResearchProject): boolean {
  if (researchOffersCancel(project)) return false;
  if (!RESEARCH_RESTARTABLE_STATUSES.includes(project.status)) return false;
  return !project.completion || project.deliveryBlocked === true;
}

/**
 * How often the panel re-reads while something is active.
 *
 * Fast enough that a query-to-query transition is visible as a transition
 * rather than as a jump between two distant states, slow enough that a run with
 * eight sources is a few dozen requests rather than a few hundred.
 */
export const RESEARCH_POLL_MS = 3_000;

const STATUS_LABELS: Record<ResearchProjectStatus, string> = {
  draft: "Draft",
  queued: "Waiting",
  collecting: "Searching",
  ready: "Synthesizing",
  complete: "Complete",
  failed: "Failed",
  cancelled: "Cancelled",
};

/**
 * The chip's word.
 *
 * `queued` reads "Waiting" and `ready` reads "Synthesizing" rather than echoing
 * the stored names: the store's words describe the RUNTIME's state machine, and
 * "ready" in particular reads to an owner as "the result is ready" when it means
 * the opposite — the search finished and the writing has not.
 */
export function researchStatusLabel(status: ResearchProjectStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/**
 * The one progress sentence under the heading.
 *
 * The runtime's own `progress.message` wins whenever there is one: it is written
 * by the code that knows what it is doing — "Reading source 3 of 8",
 * "Waiting for a free research slot (3 of 3 running)" — and re-deriving a
 * sentence here from the counters would produce a second, vaguer account of the
 * same moment. The counters are APPENDED rather than substituted, so the row
 * still says how far along it is.
 *
 * The fallbacks matter for exactly two rows: a `draft` project that was created
 * before this epic and never run, and a project whose progress record is
 * missing. Neither should render an empty line.
 */
export function researchTaskLine(project: ResearchProject): string {
  const progress = project.progress;
  const counted =
    progress && progress.totalQueries > 0
      ? `${progress.completedQueries} of ${progress.totalQueries}`
      : "";
  const message = progress?.message?.trim() ?? "";
  if (message) return counted ? `${message} (${counted})` : message;
  switch (project.status) {
    case "draft":
      return "Not started. Confirm a topic and queries to search.";
    case "complete":
      return `Complete. ${(project.results?.length ?? 0)} sources cited.`;
    case "failed":
      return "Failed. Nothing was written to the wiki.";
    case "cancelled":
      return "Cancelled.";
    default:
      return counted ? `In progress (${counted}).` : "In progress.";
  }
}

/**
 * What this run's collected URLs cost, or `null` when nothing was lost.
 *
 * `Collect N URLs` reports the SURVIVORS as if they were everything (DW-655):
 * the store keeps 40 URLs of at most 2,000 characters each, and until now it
 * discarded the rest, shortened the over-long ones and collapsed two URLs
 * sharing a 2,000-character prefix into one with nothing said. The bounds are
 * unchanged — this is the sentence that stops them being silent.
 *
 * TWO CLAUSES, JOINED BY A SPACE, because they are two different losses and a
 * row can suffer both: a dropped URL was never stored, while a truncated one
 * IS stored and is the more dangerous of the pair — it looks like a source and
 * points somewhere else. `total` is reconstructed as `sourceUrls.length +
 * dropped` rather than stored, so the count the owner reads always agrees with
 * the list they can see.
 *
 * `null`, not `""`, so the caller renders no empty element for the ordinary
 * lossless run.
 *
 * THE COUNTS ARE VALIDATED HERE, not by the registry guard. `isResearchProject`
 * is deliberately structural and checks no optional field, so a stored
 * `{dropped: "5"}` reaches this function — where `sourceUrls.length + dropped`
 * would string-concatenate into "5 of the 405 URLs…", a wrong number stated
 * with total confidence. Loosening the guard is the wrong fix (it refuses the
 * WHOLE registry for one bad row, which is a far worse failure than a missing
 * note), so the defence sits at the consumer: a count counts only when it is a
 * positive integer, and a clause with an unusable count is simply not said.
 */
export function researchSourceUrlNote(project: ResearchProject): string | null {
  const loss = project.sourceUrlLoss;
  if (!loss) return null;
  const dropped = positiveCount(loss.dropped);
  const truncated = positiveCount(loss.truncated);
  const clauses: string[] = [];
  if (dropped !== null) {
    // Through the shared derivation, so the sentence and the Studio's evidence
    // drawer cannot state two different totals for one card.
    const total = researchSourceUrlTotal(project);
    clauses.push(
      `${dropped} of the ${total} URLs this run collected ` +
        `${dropped === 1 ? "was" : "were"} not stored.`,
    );
  }
  if (truncated !== null) {
    clauses.push(
      `${truncated} stored URL${truncated === 1 ? " was" : "s were"} shortened to ` +
        // Interpolated, never re-typed: this sentence is the store's cap shown
        // to an owner, and a literal here would go on claiming 2,000 after the
        // cap changed. `en-US` is pinned so the grouping does not follow the
        // server's locale.
        `${URL_MAX_CHARS.toLocaleString("en-US")} characters and may no longer resolve.`,
    );
  }
  // A stored `{dropped:0,truncated:0}` says nothing worth a sentence — the
  // store deletes the key rather than writing that pair, but a row written by
  // an older build must not render an empty note.
  return clauses.length > 0 ? clauses.join(" ") : null;
}

/**
 * The total this run collected, or `null` when nothing was dropped.
 *
 * The ONE derivation of "how many there really were", shared by the note above
 * and the Studio's evidence drawer so the two surfaces on the same card cannot
 * disagree about the number. Same positive-integer discipline as the note: an
 * unusable stored count yields `null`, and the caller keeps its plain wording.
 */
export function researchSourceUrlTotal(project: ResearchProject): number | null {
  const dropped = positiveCount(project.sourceUrlLoss?.dropped);
  return dropped === null ? null : project.sourceUrls.length + dropped;
}

/**
 * A stored count worth stating: really a number, whole, and above zero.
 *
 * The registry guard is structural by policy and validates no optional field,
 * so this is where a `"5"` or a `NaN` stops.
 */
function positiveCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/**
 * The Workbench rail's sentinel for "no wiki chosen yet".
 *
 * `ModeCanvas` defaults `wikiId` to this and passes it to every canvas, so a
 * canvas that forwards `wikiId` straight into a request body sends the literal
 * string `"current"` as an id. Named here rather than inlined at each call site
 * so the two canvases that create research projects filter the same value.
 */
const WIKI_SENTINEL = "current";

/**
 * The project's wiki id, or `null` when the rail has not got one.
 *
 * PERSISTED IDS MUST BE REAL. `"current"` is a rail placeholder, and a project
 * created with `vaultId: "current"` stores a wiki id that matches no wiki
 * forever — it does not resolve, it cannot be migrated, and nothing downstream
 * can tell it from a wiki that was deleted. Omitting the field is the honest
 * record of "started before a wiki existed".
 */
export function researchWikiId(wikiId: string | null | undefined): string | null {
  const trimmed = typeof wikiId === "string" ? wikiId.trim() : "";
  if (!trimmed || trimmed === WIKI_SENTINEL) return null;
  return trimmed;
}

/**
 * One query per line, cleaned the way the kernel cleans them.
 *
 * Trimmed, blank lines dropped, duplicates dropped, order kept. The store
 * applies its own cleaning on top (`cleanList`), and this exists so the panel
 * can count what it is about to send — a Start button enabled by a textarea
 * holding three blank lines is the disagreement it prevents.
 */
export function parseResearchQueries(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/\s+/g, " ");
    if (!line || seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/**
 * Why the Deep Research surfaces refuse on a read-only deployment (DW-386).
 *
 * Three doors stand behind the Research desk and its two Workbench canvases, so
 * three sentences — each the CLIENT mirror of the one its own door answers,
 * character-identical, and all three pinned by
 * `read-only-copy-parity.test.ts`:
 *
 *   - `POST /api/research` (the Studio's Create, the Studio's and the Graph
 *     canvas's **Research this**, the Review canvas's **Deep Research**, and
 *     the Research canvas's **Start Deep Research**) —
 *     `READ_ONLY_REFUSAL.researchCreate`.
 *   - `POST /api/research/[id]/run` and `DELETE /api/research/[id]` (Run,
 *     Cancel, Delete) — `READ_ONLY_REFUSAL.researchMutate`.
 *   - `POST /api/ingest/batch` (Collect) — `READ_ONLY_REFUSAL.ingest`, which is
 *     not a research sentence at all: Collect pushes the brief's source URLs
 *     into the ordinary ingest pipeline, and saying "Research projects cannot
 *     be changed…" beside it would name the wrong refusal.
 *
 * HERE RATHER THAN IN `KnowledgeStudio.tsx`, where they used to live (DW-529).
 * The Workbench's `ResearchCanvas` stands in front of the SAME create door and
 * had written a fourth wording of its own inline, owned by nobody and pinned by
 * nothing. It cannot import the Studio for a string — that would pull a large
 * `"use client"` page component into three canvases — so the sentences move to
 * the module both sides already import, for the `workbench-settings.ts` reason:
 * one owner, reachable from every surface that stands in front of the door.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const RESEARCH_CREATE_READ_ONLY_COPY =
  "Research projects cannot be created while this deployment is read-only.";

/** See {@link RESEARCH_CREATE_READ_ONLY_COPY} — run, cancel and delete. */
export const RESEARCH_MUTATE_READ_ONLY_COPY =
  "Research projects cannot be changed while this deployment is read-only.";

/** See {@link RESEARCH_CREATE_READ_ONLY_COPY} — Collect, which is an INGEST. */
export const RESEARCH_COLLECT_READ_ONLY_COPY =
  "Sources cannot be ingested while this deployment is read-only.";
