/**
 * The Workbench rail's mode vocabulary — one source for order, labels, empty
 * copy and accessible names (Story 1.3, UX-DR3 / UX-DR15 / UX-DR21).
 *
 * Pure and client-safe on purpose: the rail imports it in the browser and the
 * node-environment test imports it to pin the order and the copy. Every
 * sentence below is fixed by the UX handoff — paraphrasing one is a regression,
 * not a style choice, so no caller may inline its own.
 */

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
 * Chat fails closed when no sidecar answers on the loopback port. It names the
 * port because that is the only thing the owner can act on — the Worker cannot
 * reach localhost, so there is no server-side fallback to offer instead.
 */
export const CHAT_SIDECAR_DOWN_COPY =
  "Start the local sidecar on 127.0.0.1:19828 to use Chat.";

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
