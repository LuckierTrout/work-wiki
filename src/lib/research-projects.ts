import { ClientInputError, isEnoent } from "./errors";
import { withDurableLock, withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { hasResearchSlot } from "./research-concurrency";

const CAS_ATTEMPTS = 8;

export type ResearchProjectStatus =
  | "draft"
  | "queued"
  | "collecting"
  | "ready"
  | "complete"
  | "failed"
  | "cancelled";

export interface ResearchProjectResult {
  title: string;
  url: string;
  snippet: string;
  query: string;
  score?: number;
  publishedAt?: string;
}

export interface ResearchProject {
  id: string;
  title: string;
  question: string;
  queries: string[];
  sourceUrls: string[];
  pageSlugs: string[];
  vaultId?: string;
  status: ResearchProjectStatus;
  synthesis?: string;
  provider?: "tavily" | "serpapi" | "searxng";
  progress?: { completedQueries: number; totalQueries: number; message: string };
  results?: ResearchProjectResult[];
  /**
   * The run's narration, newest last — what the Research Panel shows as
   * thinking.
   *
   * PANEL-ONLY. It is never written to the research Page, never saved as a
   * Source and never cited: the same rule Chat applies to its own thinking. It
   * lives on the project rather than in a stream because the panel POLLS, and a
   * line emitted while nobody was looking still has to be there when they look.
   */
  thinking?: string[];
  /**
   * Durable completion record. Present once synthesis has produced a Page
   * payload; drained until Sources and Ingest jobs exist. Survives a crash
   * between the Page write and terminal `complete`.
   */
  completion?: ResearchCompletion;
  /** Page bytes captured when this run was queued; the later commit may only
   * replace exactly these bytes, so owner edits made during search win. */
  runPageBaseline?: { slug: string; content: string | null };
  proposalId?: string;
  cancelRequested?: boolean;
  /**
   * DELETE landed while a Page write or drain was still in flight. Hidden
   * from the panel; the row stays until the writer finishes or the claim
   * goes stale so an orphan outbox can complete ingest.
   */
  deleteRequested?: boolean;
  /** Automatic delivery reconciliation stopped on an operator-recovery fault. */
  deliveryBlocked?: boolean;
  /** Fence token for one automatic or operator-triggered completion delivery. */
  deliveryAttemptId?: string;
  /** Fence token shared with the Research lease for the current execution. */
  runAttemptId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResearchCompletionSource {
  url: string;
  title: string;
  slug: string;
  sha: string;
  jobId?: string;
  ingested?: boolean;
  error?: string;
}

export interface ResearchCompletion {
  phase: "page" | "sources" | "done";
  pageSlug: string;
  wikiId?: string;
  sources: ResearchCompletionSource[];
  /**
   * When this isolate claimed the Page write. A fresh claim blocks every
   * other writer; a stale one can be stolen after a crash only if the Page
   * file is still missing.
   */
  writeClaimedAt?: string;
  /** Opaque id for the isolate that currently owns {@link writeClaimedAt}. */
  writeClaimId?: string;
  /** Atomic cancel/write linearization point immediately before lifecycle. */
  writeAuthorizedAt?: string;
}

export interface ResearchProjectInput {
  title: string;
  question: string;
  queries?: readonly string[];
  sourceUrls?: readonly string[];
  pageSlugs?: readonly string[];
  vaultId?: string | null;
}

export const MAX_PROJECTS = 100;
const STATUSES = new Set<ResearchProjectStatus>([
  "draft", "queued", "collecting", "ready", "complete", "failed", "cancelled",
]);

function projectPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-projects.json`;
}

function lockKey(owner: string): string {
  return `research-projects:${tenantForOwner(owner)}`;
}

function cleanList(values: readonly string[] | undefined, maxItems: number, maxChars: number): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const cleaned = value.trim().replace(/\s+/g, " ").slice(0, maxChars);
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    result.push(cleaned);
    if (result.length >= maxItems) break;
  }
  return result;
}

function cleanUrls(values: readonly string[] | undefined): string[] {
  return cleanList(values, 40, 2_000).filter((value) => {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  });
}

function cleanInput(input: ResearchProjectInput) {
  const title = input.title.trim().replace(/\s+/g, " ").slice(0, 160);
  const question = input.question.trim().slice(0, 4_000);
  // Caller-supplied input, so the fault is typed rather than left for a route
  // to string-match: `POST /api/research` classifies by type alone.
  if (!title) throw new ClientInputError("Research title is required");
  if (!question) throw new ClientInputError("Research question is required");
  return {
    title,
    question,
    queries: cleanList(input.queries, 16, 500),
    sourceUrls: cleanUrls(input.sourceUrls),
    pageSlugs: cleanList(input.pageSlugs, 50, 240),
    ...(input.vaultId?.trim() ? { vaultId: input.vaultId.trim().slice(0, 240) } : {}),
  };
}

/**
 * Parse stored registry bytes, refusing anything that is not a list.
 *
 * A registry that parses to an object/string/number used to read as "no
 * projects", which cleared the `MAX_PROJECTS` guard and let the very next
 * create OVERWRITE the corrupt file — losing whatever it held. Both read sites
 * go through this one helper so they refuse together: refusing only in
 * {@link readProjects} would still let the CAS read in
 * {@link applyResearchProjectMutation} see `[]` and write over the file.
 *
 * The throw is a plain `Error` on purpose — a wrong-shaped stored file is a
 * server fault (500), never a `ClientInputError`. Matches `parseSlots` in
 * `research-concurrency.ts`, which refuses a non-array lease file the same way.
 */
function parseRegistry(raw: string): ResearchProject[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed)) {
    throw new Error("Research projects file is not a list.");
  }
  return parsed as ResearchProject[];
}

async function readProjects(owner: string): Promise<ResearchProject[]> {
  try {
    return parseRegistry(await getStorage().readFile(projectPath(owner)));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

/**
 * Persist the registry verbatim — a write NEVER evicts a stored project.
 *
 * This used to `slice(-MAX_PROJECTS)`, which was silent data loss on any path
 * that reached it holding legacy over-cap data: an update or a delete against a
 * registry above the cap dropped its oldest-inserted rows as a side effect of
 * saving something else, and the caller was told it succeeded. Dropping the
 * slice is what lets a delete bring such a registry back DOWN to the cap
 * instead of shedding unrelated rows on the way.
 *
 * The cap is enforced in exactly one place: `createResearchProject` refuses
 * when `projects.length >= MAX_PROJECTS` before anything is pushed, so no
 * create can grow the registry past it.
 */
function serializeProjects(projects: ResearchProject[]): string {
  return JSON.stringify(projects, null, 2);
}

/**
 * Compare-and-set mutation of the project registry.
 *
 * Same-isolate callers still serialize on {@link withFileLock}. Cross-isolate
 * callers race `readFileWithEtag` / `writeFileIfMatch` — the in-process lock
 * is invisible to another Worker isolate, so a queued→collecting claim that
 * only locked in memory could run twice. Exported so tests can race two
 * callers without that lock.
 */
export async function applyResearchProjectMutation<T>(
  owner: string,
  mutate: (projects: ResearchProject[]) => { projects: ResearchProject[]; result: T },
): Promise<T> {
  const storage = getStorage();
  const path = projectPath(owner);
  const lastError = new Error("Research projects were busy; retry the request.");
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    let etag: string | null = null;
    let projects: ResearchProject[] = [];
    try {
      const read = await storage.readFileWithEtag(path);
      etag = read.etag;
      projects = parseRegistry(read.content);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    const next = mutate(projects);
    const body = serializeProjects(next.projects);
    const wrote = etag === null
      ? await storage.writeFileIfAbsent(path, body)
      : await storage.writeFileIfMatch(path, body, etag);
    if (wrote) return next.result;
  }
  throw lastError;
}

async function lockedMutation<T>(
  owner: string,
  mutate: (projects: ResearchProject[]) => { projects: ResearchProject[]; result: T },
): Promise<T> {
  return withFileLock(lockKey(owner), () => applyResearchProjectMutation(owner, mutate));
}

export async function listResearchProjects(owner: string): Promise<ResearchProject[]> {
  return (await readProjects(owner)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/** Projects recorded against one Workbench Wiki, or none when `wikiId` is empty. */
export function filterResearchProjects(
  projects: readonly ResearchProject[],
  wikiId: string | null | undefined,
): ResearchProject[] {
  const visible = projects.filter((project) => !project.deleteRequested);
  const scope = wikiId?.trim();
  if (!scope) return visible;
  return visible.filter((project) => project.vaultId === scope);
}

export async function getResearchProject(
  owner: string,
  id: string,
): Promise<ResearchProject | null> {
  return (await readProjects(owner)).find((project) => project.id === id) ?? null;
}

/**
 * Create a research project for `owner`.
 *
 * WHY THE CAP IS CHECKED FIRST. This guard is the ONLY place the cap is
 * enforced — {@link serializeProjects} writes the array verbatim and evicts
 * nothing. Historically the write truncated instead, so a create that pushed
 * past the cap did not fail: it silently dropped the tenant's OLDEST project on
 * the floor and reported success. Refusing before anything is mutated or
 * written is the fix, and it is the same discipline `createWiki` applies at
 * `MAX_WIKIS`.
 *
 * WHY THERE IS NO POST-WRITE UNDO. `createWiki` needs one because it seeds
 * three files into a directory before its registry write, so a fault strands
 * them. This create writes exactly ONE file and seeds no sibling artifacts, and
 * the pushed array is function-local — so a rejected registry write in
 * {@link applyResearchProjectMutation} leaves the stored registry
 * byte-identical (`StorageProvider.writeFileIfAbsent`/`writeFileIfMatch` are
 * atomic from the caller's view) and there is nothing behind to clean up.
 */
export async function createResearchProject(
  owner: string,
  input: ResearchProjectInput,
): Promise<ResearchProject> {
  const cleaned = cleanInput(input);
  return lockedMutation(owner, (projects) => {
    if (projects.length >= MAX_PROJECTS) {
      throw new ClientInputError(
        `This workspace already has the maximum of ${MAX_PROJECTS} research projects.`,
      );
    }
    const now = new Date().toISOString();
    const project: ResearchProject = {
      id: crypto.randomUUID(),
      ...cleaned,
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    projects.push(project);
    return { projects, result: project };
  });
}

export async function updateResearchProject(
  owner: string,
  id: string,
  patch: Partial<ResearchProjectInput> & {
    status?: ResearchProjectStatus;
    synthesis?: string | null;
    provider?: ResearchProject["provider"] | null;
    progress?: ResearchProject["progress"] | null;
    results?: ResearchProjectResult[] | null;
    thinking?: readonly string[] | null;
    proposalId?: string | null;
    cancelRequested?: boolean;
    deliveryBlocked?: boolean;
    deliveryAttemptId?: string | null;
    runAttemptId?: string | null;
    error?: string | null;
    completion?: ResearchCompletion | null;
    runPageBaseline?: ResearchProject["runPageBaseline"] | null;
  },
): Promise<ResearchProject | null> {
  return mutateProject(owner, id, () => true, patch);
}

/**
 * Apply `patch` only when `predicate` holds against the stored project.
 *
 * The lost race returns `null` so a second Queue delivery cannot both search.
 * Same-isolate callers serialize on the file lock; cross-isolate callers race
 * the registry CAS, so two isolates that both read `queued` cannot both write
 * `collecting`.
 */
export async function updateResearchProjectIf(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Parameters<typeof updateResearchProject>[2],
): Promise<ResearchProject | null> {
  return mutateProject(owner, id, predicate, patch);
}

/**
 * Apply an in-place mutator under the same CAS as {@link updateResearchProjectIf}.
 *
 * Returns `null` when the project is gone or `mutate` returns null (lost claim).
 */
export async function mutateResearchProject(
  owner: string,
  id: string,
  mutate: (project: ResearchProject) => ResearchProject | null,
): Promise<ResearchProject | null> {
  return lockedMutation(owner, (projects) => {
    const index = projects.findIndex((item) => item.id === id);
    if (index < 0) return { projects, result: null };
    const next = mutate(projects[index]);
    if (!next) return { projects, result: null };
    next.updatedAt = new Date().toISOString();
    projects[index] = next;
    return { projects, result: next };
  });
}

async function mutateProject(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Parameters<typeof updateResearchProject>[2],
): Promise<ResearchProject | null> {
  return mutateResearchProject(owner, id, (project) => {
    if (!predicate(project)) return null;
    if (patch.title !== undefined || patch.question !== undefined) {
      const cleaned = cleanInput({
        title: patch.title ?? project.title,
        question: patch.question ?? project.question,
        queries: patch.queries ?? project.queries,
        sourceUrls: patch.sourceUrls ?? project.sourceUrls,
        pageSlugs: patch.pageSlugs ?? project.pageSlugs,
        vaultId: patch.vaultId === undefined ? project.vaultId : patch.vaultId,
      });
      Object.assign(project, cleaned);
    } else {
      if (patch.queries !== undefined) project.queries = cleanList(patch.queries, 16, 500);
      if (patch.sourceUrls !== undefined) project.sourceUrls = cleanUrls(patch.sourceUrls);
      if (patch.pageSlugs !== undefined) project.pageSlugs = cleanList(patch.pageSlugs, 50, 240);
      if (patch.vaultId !== undefined) {
        if (patch.vaultId?.trim()) project.vaultId = patch.vaultId.trim().slice(0, 240);
        else delete project.vaultId;
      }
    }
    if (patch.status !== undefined) {
      if (!STATUSES.has(patch.status)) throw new ClientInputError("Invalid research status");
      project.status = patch.status;
    }
    if (patch.synthesis !== undefined) {
      if (patch.synthesis?.trim()) project.synthesis = patch.synthesis.trim().slice(0, 200_000);
      else delete project.synthesis;
    }
    if (patch.provider !== undefined) {
      if (patch.provider) project.provider = patch.provider;
      else delete project.provider;
    }
    if (patch.progress !== undefined) {
      if (patch.progress) project.progress = {
        completedQueries: Math.max(0, Math.floor(patch.progress.completedQueries)),
        totalQueries: Math.max(0, Math.floor(patch.progress.totalQueries)),
        message: patch.progress.message.trim().slice(0, 500),
      };
      else delete project.progress;
    }
    if (patch.results !== undefined) {
      if (patch.results) project.results = patch.results.slice(0, 100).map((result) => ({
        ...result,
        title: result.title.trim().slice(0, 300),
        url: result.url.trim().slice(0, 2_000),
        snippet: result.snippet.trim().slice(0, 4_000),
        query: result.query.trim().slice(0, 1_000),
      }));
      else delete project.results;
    }
    if (patch.thinking !== undefined) {
      // Bounded at both ends: 200 lines of 500 characters, keeping the NEWEST
      // when a long run overflows. A run narrates once per query and once per
      // phase, so the cap is only reached by a pathological run — and the tail
      // is the half worth keeping, because the panel follows the newest line.
      const lines = (patch.thinking ?? [])
        .map((line) => line.trim().replace(/\s+/g, " ").slice(0, 500))
        .filter((line) => line.length > 0);
      if (lines.length > 0) project.thinking = lines.slice(-200);
      else delete project.thinking;
    }
    if (patch.proposalId !== undefined) {
      if (patch.proposalId?.trim()) project.proposalId = patch.proposalId.trim().slice(0, 160);
      else delete project.proposalId;
    }
    if (patch.cancelRequested !== undefined) project.cancelRequested = patch.cancelRequested;
    if (patch.deliveryBlocked !== undefined) project.deliveryBlocked = patch.deliveryBlocked;
    if (patch.deliveryAttemptId !== undefined) {
      if (patch.deliveryAttemptId?.trim()) project.deliveryAttemptId = patch.deliveryAttemptId;
      else delete project.deliveryAttemptId;
    }
    if (patch.runAttemptId !== undefined) {
      if (patch.runAttemptId?.trim()) project.runAttemptId = patch.runAttemptId;
      else delete project.runAttemptId;
    }
    if (patch.error !== undefined) {
      if (patch.error?.trim()) project.error = patch.error.trim().slice(0, 2_000);
      else delete project.error;
    }
    if (patch.completion !== undefined) {
      if (patch.completion) project.completion = patch.completion;
      else delete project.completion;
    }
    if (patch.runPageBaseline !== undefined) {
      if (patch.runPageBaseline) {
        project.runPageBaseline = {
          slug: patch.runPageBaseline.slug.trim().slice(0, 240),
          content: patch.runPageBaseline.content,
        };
      } else delete project.runPageBaseline;
    }
    return project;
  });
}

export async function withResearchProjectLifecycleFence<T>(
  owner: string,
  id: string,
  fn: () => Promise<T>,
): Promise<T> {
  const ownerTenant = tenantForOwner(owner);
  validateTenant(ownerTenant);
  return withDurableLock(`research-project-lifecycle:${ownerTenant}:${id}`, fn);
}

export async function deleteResearchProject(owner: string, id: string): Promise<boolean> {
  return withResearchProjectLifecycleFence(owner, id, async () => {
    // Recheck under the same fence used by lease rotation. A caller's earlier
    // release/confirm can otherwise race a recovery that publishes a successor.
    if (await hasResearchSlot(owner, id)) return false;
    return lockedMutation(owner, (projects) => {
      const next = projects.filter((project) => project.id !== id);
      if (next.length === projects.length) return { projects, result: false };
      return { projects: next, result: true };
    });
  });
}
