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
