/**
 * The Workbench rail's mode vocabulary — one source for order, labels, empty
 * copy and accessible names (Story 1.3, UX-DR3 / UX-DR15 / UX-DR21).
 *
 * Pure and client-safe on purpose: the rail imports it in the browser and the
 * node-environment test imports it to pin the order and the copy. Every
 * sentence below is fixed by the UX handoff — paraphrasing one is a regression,
 * not a style choice, so no caller may inline its own.
 */

import { isSidecarDefaultAdmittedOrigin } from "./sidecar";

export type WorkbenchModeId =
  | "wiki"
  | "chat"
  | "sources"
  | "search"
  | "graph"
  | "lint"
  | "todos"
  | "review"
  | "research"
  | "skills";

export interface WorkbenchMode {
  id: WorkbenchModeId;
  /** Rail tooltip / accessible name and the canvas surface title. */
  label: string;
  /**
   * The one muted sentence a not-yet-built mode shows. Wiki has none: its
   * canvas is Story 1.2's real surface.
   */
  emptyState: string | null;
}

/** Rail order, top → bottom. Story 1.3 AC and `epics.md` fix this sequence. */
export const WORKBENCH_MODES: readonly WorkbenchMode[] = [
  { id: "wiki", label: "Wiki", emptyState: null },
  {
    id: "chat",
    label: "Chat",
    emptyState: "Start a new conversation. Click New Chat to begin.",
  },
  { id: "sources", label: "Sources", emptyState: "No sources yet. Ingest a file to add one." },
  { id: "search", label: "Search", emptyState: "Press Enter to search." },
  { id: "graph", label: "Graph", emptyState: "No graph yet. Ingest sources to build one." },
  { id: "lint", label: "Lint", emptyState: "Run lint to check wiki health." },
  { id: "todos", label: "Todos", emptyState: "No candidates. Meeting ingest will propose them." },
  { id: "review", label: "Review", emptyState: "No pending cards." },
  {
    id: "research",
    label: "Deep Research",
    emptyState:
      "No research tasks yet. Enter a topic above or click Deep Research in Review.",
  },
  { id: "skills", label: "Skills", emptyState: "No skills enabled yet." },
] as const;

export const DEFAULT_WORKBENCH_MODE: WorkbenchModeId = "wiki";

/**
 * The noun a count badge announces. Only Todos and Review carry a badge
 * (DESIGN.md `badge-count`); every other mode has no counted set to name.
 */
export const BADGE_MODE_NOUNS: Partial<Record<WorkbenchModeId, string>> = {
  todos: "todo candidates",
  review: "pending reviews",
};

/**
 * Shown on a Source that is neither Plaud-origin nor marked meeting.
 * One definition — Preview and Sources import this; do not inline.
 */
export const TODOS_NON_MEETING_COPY =
  "This Source is not a meeting. Mark as meeting to extract Todos.";

/**
 * Chat fails closed when no sidecar answers on the loopback port. It names the
 * port because that is the only thing the owner can act on — the Worker cannot
 * reach localhost, so there is no server-side fallback to offer instead.
 *
 * TRUE ONLY ON A PAGE THE DOOR ADMITS WITH NOTHING CONFIGURED (DW-607). There,
 * `down` can only mean nothing answered. Elsewhere the sidecar may well be
 * running and simply refused, so {@link chatSidecarDownCopy} chooses between
 * this and {@link CHAT_SIDECAR_UNREACHABLE_COPY} — no caller renders either
 * constant directly.
 */
export const CHAT_SIDECAR_DOWN_COPY =
  "Start the local sidecar on 127.0.0.1:19828 to use Chat.";

/**
 * The same fail-closed state on a page the sidecar does not admit by default.
 *
 * NAMES BOTH CAUSES because the browser cannot tell them apart: a refused
 * connection and a CORS refusal reach `fetch` as the same rejected promise, and
 * the only way to distinguish them would be a second request or a same-origin
 * server route that cannot see loopback either. So the sentence stays honest
 * about the ambiguity and names the one knob that resolves half of it — an
 * owner whose sidecar is already running must not be told to start it.
 *
 * The env name is spelled in full because it is what the operator will grep for
 * in `.env.example` and `DEPLOY.md`, which document its shape.
 */
export const CHAT_SIDECAR_UNREACHABLE_COPY =
  "Chat can’t reach the local sidecar on 127.0.0.1:19828. Start it, or add this page’s origin to WORKWIKI_SIDECAR_ALLOWED_ORIGINS.";

/**
 * A real `scheme://host[:port]` origin, and nothing else.
 *
 * `window.location.origin` is a string on every page that has one, but the
 * value reaching this module can also be `null` (server render, first client
 * render), `""`, or the literal `"null"` a sandboxed iframe or a `file://` page
 * reports — none of which say anything about whether the door would admit the
 * page. Round-tripping through `URL` and comparing against `origin` is what
 * separates a genuine origin from all three, and it never throws.
 */
function isPageOrigin(value: string | null | undefined): boolean {
  if (typeof value !== "string") return false;
  const trimmed = value.trim();
  if (!trimmed) return false;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return url.origin.toLowerCase() === trimmed.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * Which fail-closed Chat sentence this page has earned (DW-607).
 *
 * Pure, and decided by the ONE fact a page holds for free: its own origin. The
 * probe cannot report WHY it failed, so the copy is selected from what the
 * browser already knows rather than from a diagnosis it cannot make.
 *
 * DEGRADES TO {@link CHAT_SIDECAR_DOWN_COPY}, not to the longer sentence. An
 * origin that is absent or unparseable is the server render, the first client
 * render, and the sandboxed embedding — and the shorter sentence is the one
 * that is true more often, so it is the conservative answer. That also keeps
 * the server's markup and the first client render identical, which is what
 * stops a hydration mismatch.
 */
export function chatSidecarDownCopy(
  pageOrigin: string | null | undefined,
): string {
  if (isSidecarDefaultAdmittedOrigin(pageOrigin)) return CHAT_SIDECAR_DOWN_COPY;
  if (!isPageOrigin(pageOrigin)) return CHAT_SIDECAR_DOWN_COPY;
  return CHAT_SIDECAR_UNREACHABLE_COPY;
}

export const CHAT_COVERAGE_MISSING_COPY =
  "Wiki has no coverage for this. Ingest a source or run Deep Research.";

export const CHAT_COMPOSER_PLACEHOLDER = "Type a message…";

export const CHAT_VECTOR_FALLBACK_COPY =
  "Vector search failed. Falling back to tokenized search.";

export const CHAT_MODEL_MISSING_COPY =
  "Configure a Chat model in Settings.";

/**
 * Chat's own empty state, reachable only once a sidecar answers. Derived from
 * the `chat` entry above rather than retyped: this module's whole point is that
 * handoff copy has one definition, and two literals that must stay identical
 * are two definitions no matter how close together they sit.
 */
export const CHAT_SIDECAR_UP_COPY: string =
  WORKBENCH_MODES.find((mode) => mode.id === "chat")?.emptyState ?? "";

/** Below ~900px the graph is not the job surface (DESIGN.md Layout). */
export const GRAPH_NARROW_COPY = "The graph needs a wider window.";

const MODE_IDS: ReadonlySet<string> = new Set(WORKBENCH_MODES.map((mode) => mode.id));

/** Narrows an untrusted value (a localStorage read) to a real mode id. */
export function isWorkbenchModeId(value: unknown): value is WorkbenchModeId {
  return typeof value === "string" && MODE_IDS.has(value);
}

export function workbenchMode(id: WorkbenchModeId): WorkbenchMode {
  // The union guarantees a hit; the fallback keeps the return type honest.
  return WORKBENCH_MODES.find((mode) => mode.id === id) ?? WORKBENCH_MODES[0];
}

/**
 * Count + noun in the accessible name, so a badge is never colour-and-digit
 * alone: "Review, 62 pending reviews" (UX-DR21).
 */
export function badgeAccessibleName(label: string, count: number, noun: string): string {
  return `${label}, ${count} ${noun}`;
}
