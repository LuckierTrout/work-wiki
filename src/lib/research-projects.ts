import { isReadOnly } from "./config";
import { ClientInputError, isEnoent } from "./errors";
import { withDurableLock, withFileLock } from "./lock";
import { READ_ONLY_REFUSAL, ReadOnlyError, assertWritable } from "./read-only";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { hasResearchSlot } from "./research-concurrency";

const CAS_ATTEMPTS = 8;

/**
 * The three research-project faults a route has to tell apart from a server
 * fault: the row is GONE, the row's OWN STATE refuses the transition, and the
 * STORE was busy.
 *
 * Typed rather than left as sentences for `POST /api/research/[id]/run` to
 * match with `/not found/i` and `/already running/i` — that ladder reported any
 * storage fault whose message happened to carry those words as the caller's
 * 404/409, the same mislabelling DW-296 deleted from `POST /api/research`.
 * Same idiom as `ClientInputError` here and `ResearchLeaseError` in
 * `research-concurrency.ts`: a plain `extends Error` with `this.name` set, so
 * the door classifies by `instanceof` and the message is only ever echoed.
 *
 * Three classes rather than one carrying a `kind`, because the door branches on
 * three distinct statuses — 404, 409, 503 — and `instanceof` on three names
 * reads at the call site without a second lookup: the shape
 * `ResearchProviderUnconfiguredError` and `ResearchProviderOverrideError`
 * already have in that same catch.
 *
 * NOT-FOUND COVERS THE RETIRED ROW TOO (DW-651). `deleteRequested` is a DELETE
 * tombstone the panel already hides and the GET on the same path already
 * answers 404 for; the POST beside it saying 500 for the same row told the
 * owner their store was broken when their project was simply gone.
 */
export class ResearchProjectNotFoundError extends Error {
  constructor(message = "Research project not found") {
    super(message);
    this.name = "ResearchProjectNotFoundError";
  }
}

/**
 * The project's OWN STATE refuses the transition — a 409, not a 404 and not a
 * server fault.
 *
 * TWO REFUSALS, both about a run already under way: a status of `queued`,
 * `collecting` or `ready` (`"Research project is already running"`), and a
 * completion still being delivered (`"…completion is still being delivered"`,
 * thrown both before the mutation and inside the rerun mutator). Each names a
 * state the caller can read back through the GET and wait out, which is what
 * 409 promises.
 *
 * STILL NARROW, but the boundary moved (DW-651). `"Research project is
 * retired"` is now {@link ResearchProjectNotFoundError} → 404, matching the
 * GET for the same row; the delivery-retry and rerun-baseline CAS losses and
 * `applyResearchProjectMutation`'s `"Research projects were busy; retry the
 * request."` are now {@link ResearchProjectBusyError} → 503, because they are
 * contention rather than a state the caller can inspect. Do not read this class
 * as "every conflict".
 *
 * `ResearchLeaseError` ALONE STAYS UNTYPED here, keeping its 500 deliberately:
 * "The previous research lease could not be retired…" and "Research attempt for
 * <id> was replaced." are storage/operator faults, not the caller's, and no
 * ledger entry asked for them.
 */
export class ResearchProjectConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchProjectConflictError";
  }
}

/**
 * The STORE was busy — a lost or exhausted compare-and-swap (DW-651).
 *
 * THREE SITES: {@link applyResearchProjectMutation} exhausting `CAS_ATTEMPTS`,
 * and `research-runtime`'s two conditional updates whose predicate lost the
 * race — the delivery retry, and the rerun baseline. All three sentences
 * already said `retry` while the run door reported them 500, which is exactly
 * the mismatch this class closes.
 *
 * ONE DOOR READS IT SO FAR: `POST /api/research/[id]/run`, which answers 503 —
 * a retry signal rather than a permanent server fault. The THREE SIBLINGS that
 * reach the very same exhausted ladder through {@link createResearchProject},
 * {@link editResearchProject} and {@link deleteResearchProject} —
 * `POST /api/research`, `PATCH` and `DELETE /api/research/[id]` — still answer
 * 500 for it, deliberately and only because DW-651 named the run door alone.
 * Throwing this class does not change their status; adding the branch to them
 * is recorded as separate work. Do not read "this class means 503" as true of
 * every research route yet.
 *
 * 503 RATHER THAN 409 because nothing here is inspectable. A 409 tells the
 * caller their request conflicts with a state they can go look at and resolve;
 * a contended registry write offers no such state, only a moment to wait. See
 * {@link ResearchProjectConflictError} for the refusals that ARE about the
 * project's own state.
 */
export class ResearchProjectBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchProjectBusyError";
  }
}

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

/**
 * What a CALLER may state about a brief.
 *
 * DW-442: no `sourceUrls`. The stored {@link ResearchProject.sourceUrls} is the
 * RUN's output — the first automated run overwrites it with the provider's own
 * results — so a seed list supplied at creation was collected, stored, then
 * silently discarded. The field now reaches the store only through
 * `updateResearchProject`'s patch, whose one writer is the run.
 */
export interface ResearchProjectInput {
  title: string;
  question: string;
  queries?: readonly string[];
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
  // NO `sourceUrls` KEY, not even an empty one: `mutateProject` `Object.assign`s
  // this result onto a LIVE project, so returning `[]` here would wipe a run's
  // collected URLs on any title edit.
  return {
    title,
    question,
    queries: cleanList(input.queries, 16, 500),
    pageSlugs: cleanList(input.pageSlugs, 50, 240),
    ...(input.vaultId?.trim() ? { vaultId: input.vaultId.trim().slice(0, 240) } : {}),
  };
}

/**
 * Every field the store itself writes on every row, checked one row at a time.
 *
 * Mirrors `isSlot` in `research-concurrency.ts`. Most optional fields
 * (`vaultId`, `synthesis`, `results`, the lifecycle stamps) are deliberately
 * NOT checked: the guard's job is to catch a registry that is not a registry,
 * not to freeze the row's optional surface — a row from a future writer that
 * carries an extra FIELD is still readable, a row missing `updatedAt` is not
 * (the {@link listResearchProjects} sort would die on it with an opaque
 * TypeError).
 *
 * `deleteRequested` is the one optional field that IS checked, because it is
 * load-bearing twice over: {@link filterResearchProjects} hides a truthy row
 * from the panel, and since DW-479 the `MAX_PROJECTS` guard counts that same
 * visible set. A stored `deleteRequested: "false"` is truthy, so an unchecked
 * string would hide the row from its owner forever AND free a cap slot nothing
 * can reclaim. Requiring a real boolean turns that into a loud refusal.
 *
 * WHERE THE NESTED `completion.sources` CHECK LIVES, since this guard is the
 * place a reader looks for it and will not find it (DW-654): its ELEMENTS are
 * validated at the consuming boundary, by `requireCompletionSources` in
 * `research-completion.ts`, not here. Not an oversight — {@link parseRegistry}
 * refuses the WHOLE file when one entry fails this guard, so checking a nested
 * completion here would let a single half-written row make every project for
 * that owner unreadable AND undeletable. Refusing at the door that dereferences
 * the sources stops the one operation that would act on the bad value while the
 * row stays listable and deletable. Keep this guard structural.
 *
 * THE CAVEAT THIS ACCEPTS, NAMED: an extra field is forward-compatible but a
 * new `status` LITERAL is not, because the guard requires `STATUSES`
 * membership. During a rolling deploy or a rollback, a newer isolate that
 * writes a status this build does not know wedges the whole registry for this
 * build — every door for that owner 500s until the newer build is back. The
 * alternative (accepting any string) is what DW-476 was: an unknown literal
 * flows into the `EDITABLE` membership tests around the app and quietly means
 * "locked forever". Refusing loudly is the better failure, but adding a status
 * literal is a two-phase change — teach the readers first, then write it.
 */
function isResearchProject(value: unknown): value is ResearchProject {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const project = value as Record<string, unknown>;
  const isStrings = (v: unknown) => Array.isArray(v) && v.every((s) => typeof s === "string");
  return (
    typeof project.id === "string" &&
    typeof project.title === "string" &&
    typeof project.question === "string" &&
    typeof project.createdAt === "string" &&
    typeof project.updatedAt === "string" &&
    isStrings(project.queries) &&
    isStrings(project.sourceUrls) &&
    isStrings(project.pageSlugs) &&
    typeof project.status === "string" &&
    STATUSES.has(project.status as ResearchProjectStatus) &&
    (project.deleteRequested === undefined || typeof project.deleteRequested === "boolean")
  );
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
 * A list whose ELEMENTS are not projects is refused by the same helper for the
 * same reason (DW-476). The non-array check alone let `[1,2,3]` or `[{}]` be
 * cast straight to `ResearchProject[]`, which then died in
 * {@link listResearchProjects}' `b.updatedAt.localeCompare` as an opaque
 * `TypeError` — far from the file that caused it, and only on the paths that
 * happen to sort. Checking here is what makes every door say the same thing.
 *
 * WHY ONE BAD ELEMENT REFUSES THE WHOLE REGISTRY rather than skipping the row.
 * This is the widest blast radius in this helper — a single malformed row 500s
 * every research door for that owner, the panel included — and it is chosen on
 * purpose, the same fail-closed discipline `parseSlots` applies to a lease
 * file. Skipping the bad row would present a SHORT registry as the tenant's
 * complete one, which is DW-297's "unreadable is not empty" mistake with extra
 * steps: the cap would clear against the short count and the next write would
 * serialize the survivors, silently dropping the skipped rows off disk for
 * good. Refusing loses nothing — the projects are not gone, they are
 * unreadable — so the message below carries the INDEX of the first bad row.
 * With no repair route (deliberately out of scope), that index is the
 * operator's only handle on a registry that now refuses every read and every
 * write for the tenant.
 *
 * The throw is a plain `Error` on purpose — a wrong-shaped stored file is a
 * server fault (500), never a `ClientInputError`. Matches `parseSlots` in
 * `research-concurrency.ts`, which refuses a non-array lease file and an
 * invalid lease entry the same way.
 *
 * The BYTES-ARE-NOT-JSON fault is typed like the other two for that same
 * reason. A bare `JSON.parse` let truncated or non-JSON registry bytes escape
 * as a raw `SyntaxError` — `Unexpected token } in JSON at position 41`, an
 * opaque message naming a byte offset instead of the file, which is exactly
 * the far-from-the-cause shape DW-476 removed from the registry sort. It is
 * refused here, with the file named, so every door says the same thing;
 * `parseSlots` already wraps its own parse identically.
 *
 * The `SyntaxError` is kept as the `cause` rather than dropped. Same argument
 * as the element index above: with no repair route, the operator needs a
 * handle on WHERE the bytes went wrong, and the parser's byte offset is the
 * only one that exists. It rides along without reaching the caller, whose
 * message and 500 are unchanged.
 */
function parseRegistry(raw: string): ResearchProject[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error("Research projects file is unreadable.", { cause: error });
  }
  if (!Array.isArray(parsed)) {
    throw new Error("Research projects file is not a list.");
  }
  const bad = parsed.findIndex((entry) => !isResearchProject(entry));
  if (bad !== -1) {
    throw new Error(`Research project entry ${bad} is invalid.`);
  }
  return parsed;
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
 * The cap is still enforced in exactly one place: `createResearchProject`
 * refuses before anything is pushed, so no create can grow the VISIBLE set
 * past it. What it counts is `filterResearchProjects(projects, null).length`,
 * not `projects.length` (DW-479) — so the STORED array this function writes can
 * transiently sit above `MAX_PROJECTS` while soft-deleted rows are held, by
 * exactly the number of tombstones outstanding. That is not eviction pressure
 * and must not become any: a write that shed rows to get back under the cap
 * would be the same silent data loss the slice was.
 */
function serializeProjects(projects: ResearchProject[]): string {
  return JSON.stringify(projects, null, 2);
}

/**
 * What {@link applyResearchProjectMutation} returns instead of writing when the
 * deployment is read-only (DW-527).
 *
 * A frozen object compared by IDENTITY, not by shape: a caller's own
 * `{ researchWrite: "read-only" }` — or a `result` a `mutate` happened to
 * return — must not be mistaken for the store's refusal. Frozen so no caller
 * can mutate the one shared instance the identity check depends on.
 */
export const RESEARCH_WRITE_REFUSED = Object.freeze({ researchWrite: "read-only" as const });
export type ResearchWriteRefused = typeof RESEARCH_WRITE_REFUSED;

/** Whether a CAS result is the read-only refusal rather than a mutation result. */
export function isResearchWriteRefused(value: unknown): value is ResearchWriteRefused {
  return value === RESEARCH_WRITE_REFUSED;
}

/**
 * Compare-and-set mutation of the project registry.
 *
 * Same-isolate callers still serialize on {@link withFileLock}. Cross-isolate
 * callers race `readFileWithEtag` / `writeFileIfMatch` — the in-process lock
 * is invisible to another Worker isolate, so a queued→collecting claim that
 * only locked in memory could run twice. Exported so tests can race two
 * callers without that lock.
 *
 * READ-ONLY REFUSES HERE, AND DOES NOT THROW (DW-527, replacing DW-385's
 * exemption). When `isReadOnly()` this returns {@link RESEARCH_WRITE_REFUSED}
 * BEFORE the attempt loop — before any `readFileWithEtag`, any
 * `writeFileIfMatch`, and before `mutate` is invoked at all — so a read-only
 * deployment's stored registry is byte-identical afterwards no matter which
 * caller arrived.
 *
 * WHY A SENTINEL RATHER THAN `assertWritable`. This and its wrappers
 * ({@link mutateResearchProject}, {@link updateResearchProjectIf},
 * {@link updateResearchProject}) are mostly an IN-FLIGHT run's own progress
 * recorders, reached from `research-runtime`/`research-completion`. Several of
 * those callers read a `null` return as "lost the CAS race" and compensate; a
 * THROW here would turn that fail-soft path into a stranded run, which is the
 * reason DW-385 left the primitive open in the first place. So the refusal is
 * a value: {@link mutateResearchProject} — the funnel all three fail-soft
 * wrappers pass through — collapses it to the `null` those ~30 call sites
 * already handle, while {@link createResearchProject} and
 * {@link deleteResearchProject} convert it to a `ReadOnlyError` so their
 * throwing contract survives a flag that flips after their own
 * `assertWritable`. A sentinel rather than a bare `null` because at the
 * PRIMITIVE a refusal and a lost race are different facts, and
 * {@link isResearchWriteRefused} is how a direct caller tells them apart.
 *
 * AND NOT ONLY AT THE PRIMITIVE, SINCE DW-661. Every fail-soft wrapper now has
 * a refusal-preserving sibling one line beneath it —
 * {@link mutateResearchProjectOrRefusal} under {@link mutateResearchProject},
 * {@link updateResearchProjectIfOrRefusal} under
 * {@link updateResearchProjectIf} — so a caller whose contract is to THROW can
 * tell the two facts apart without reaching past the wrappers to this
 * function. `research-runtime`'s five throwing entry points
 * (`retireResearchProject`, `queueResearchProject`, `cancelResearchProject`,
 * `updateResearchAttempt` and `note`) take the siblings and convert the
 * sentinel themselves; nothing else moved, and the collapse below is still
 * what the ~30 fail-soft call sites get.
 *
 * WHAT THE OLD EXEMPTION COST, NOW CLOSED. `PATCH /api/research/[id]` used to
 * call {@link updateResearchProjectIf} to edit an owner's title, question and
 * queries, so a DIRECT LIBRARY caller with no route in front could patch a
 * research project's fields while read-only. That door now goes through
 * {@link editResearchProject}, which is gated and THROWS — the owner reads the
 * refusal sentence instead of a `null` mislabelled as 409 "cannot be edited".
 */
export async function applyResearchProjectMutation<T>(
  owner: string,
  mutate: (projects: ResearchProject[]) => { projects: ResearchProject[]; result: T },
): Promise<T | ResearchWriteRefused> {
  // FIRST, ahead of the storage handle and the attempt loop: a refusal that
  // read the registry, took a lease, or ran `mutate` would already have
  // touched the deployment it is about to refuse.
  if (isReadOnly()) return RESEARCH_WRITE_REFUSED;
  const storage = getStorage();
  const path = projectPath(owner);
  const lastError = new ResearchProjectBusyError(
    "Research projects were busy; retry the request.",
  );
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

/**
 * {@link applyResearchProjectMutation} under the owner's in-process file lock.
 *
 * Carries the {@link RESEARCH_WRITE_REFUSED} sentinel through rather than
 * collapsing it here, because the two kinds of caller want opposite things
 * from it: the fail-soft wrappers ({@link mutateResearchProject},
 * {@link updateResearchProjectIf}, {@link updateResearchProject}) turn it into
 * `null`, while every caller whose contract is to THROW turns it into a
 * `ReadOnlyError` — {@link createResearchProject} and
 * {@link deleteResearchProject} directly, and since DW-661 the five
 * `research-runtime` entry points that reach it through
 * {@link mutateResearchProjectOrRefusal} /
 * {@link updateResearchProjectIfOrRefusal}. Collapsing here would take that
 * choice away from all of them.
 */
async function lockedMutation<T>(
  owner: string,
  mutate: (projects: ResearchProject[]) => { projects: ResearchProject[]; result: T },
): Promise<T | ResearchWriteRefused> {
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
 *
 * WHY THE CAP COUNTS THE VISIBLE SET, NOT `projects.length` (DW-479). A
 * `deleteRequested` row is a tombstone {@link filterResearchProjects} hides
 * from the panel, so counting it refused a create the UI said there was room
 * for — a dead end the owner could not clear, because the thing occupying the
 * slot is invisible to them. Counting `filterResearchProjects(projects, null)`
 * makes the cap and the panel read the ONE definition of "visible" so they
 * cannot drift again; `null` scope is deliberate, the cap is per tenant across
 * every Wiki. The residual, named: a tenant holding tombstones can store more
 * than `MAX_PROJECTS` rows. Reaping is the NORMAL path but is not promptly
 * guaranteed — `retireResearchProject` returns `true` with the tombstone still
 * stored whenever a worker owns the row or the slot is not yet confirmed gone,
 * and the follow-up reap runs in `reconcileResearchProjects`, which is driven
 * by `GET /api/research` and so only advances while someone is looking. A
 * `deliveryBlocked` row is skipped by that reconcile entirely and waits on an
 * operator's explicit Retry. So the overhang can persist; it is still the right
 * trade, because the alternative is a PERMANENT refusal at a cap the panel says
 * has room, which the owner cannot clear at all. Nothing here reaps or rewrites
 * a tombstone; the cap only stops counting it.
 */
export async function createResearchProject(
  owner: string,
  input: ResearchProjectInput,
): Promise<ResearchProject> {
  // Deployment read-only (DW-385). FIRST, ahead of the clean and the lock.
  // Today `POST /api/research` and the Review-accept handler are the only
  // callers and both gate already, so this changes no behaviour the app has; it
  // is here for the DIRECT LIBRARY caller added next, which no HTTP gate can
  // reach. Same reasoning as the wiki-lifecycle gates in `read-only.ts`.
  assertWritable(READ_ONLY_REFUSAL.researchCreate);
  const cleaned = cleanInput(input);
  const created = await lockedMutation(owner, (projects) => {
    if (filterResearchProjects(projects, null).length >= MAX_PROJECTS) {
      throw new ClientInputError(
        `This workspace already has the maximum of ${MAX_PROJECTS} research projects.`,
      );
    }
    const now = new Date().toISOString();
    const project: ResearchProject = {
      id: crypto.randomUUID(),
      ...cleaned,
      // AFTER the spread, so the empty list is authoritative in code rather
      // than by convention: `cleanInput` no longer returns this key (DW-442),
      // and if it ever did again, the create must still win. The row's SHAPE is
      // unchanged — the `isResearchProject` guard still requires `string[]` —
      // only the value, which is now always empty because only the run fills it.
      sourceUrls: [],
      status: "draft",
      createdAt: now,
      updatedAt: now,
    };
    projects.push(project);
    return { projects, result: project };
  });
  // The flag flipped between the gate above and the CAS (DW-527). The
  // primitive refuses with a VALUE so the runtime's fail-soft callers are not
  // stranded by a throw; this entry point's contract is to throw, so the
  // sentinel is converted rather than handed back as a fake project.
  //
  // ONE DOOR, ONE SENTENCE (DW-659): the same `researchCreate` the gate above
  // serves, not `researchMutate`. Both refusals leave this function by the
  // same `throw`, and the caller cannot tell which read of the flag lost — so
  // a create that never happened must not be reported with "cannot be
  // changed", which sends the owner looking for the project it thinks it
  // edited. `researchCreate` is the only sentence here that says the thing
  // that matters: nothing was created. `deleteResearchProject` converts to
  // `researchMutate` for the same reason — its own gate's sentence.
  if (isResearchWriteRefused(created)) {
    throw new ReadOnlyError(READ_ONLY_REFUSAL.researchCreate);
  }
  return created;
}

export async function updateResearchProject(
  owner: string,
  id: string,
  patch: Partial<ResearchProjectInput> & {
    /**
     * The run's own output, not a caller's seed list (DW-442). It lives here
     * rather than on {@link ResearchProjectInput} because the ONE writer is
     * `research-runtime`'s `updateResearchAttempt({ results, sourceUrls })`.
     */
    sourceUrls?: readonly string[];
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
 * Apply an in-place mutator under the same CAS as {@link updateResearchProjectIf},
 * WITHOUT collapsing the read-only refusal.
 *
 * Returns `null` when the project is gone or `mutate` returns null (lost claim),
 * and {@link RESEARCH_WRITE_REFUSED} when the deployment refused the write —
 * three outcomes the fail-soft sibling below folds into two.
 *
 * WHY THE SPLIT (DW-661). {@link mutateResearchProject} collapses the sentinel
 * to `null` for its ~30 fail-soft callers, which meant a refusal was
 * distinguishable ONLY at {@link applyResearchProjectMutation} — no runtime
 * caller could tell "refused" from "lost the CAS race", so five throwing entry
 * points in `research-runtime` mislabelled a mid-request refusal as "not
 * found" or "was replaced". This function holds the logic; the fail-soft name
 * is one line over it. Callers whose contract is to THROW take this one and
 * convert the sentinel; everyone else keeps the collapsing wrapper.
 *
 * Still refuses by RETURNING, never by throwing: converting the sentinel is
 * the caller's decision, made where the contract is known.
 */
export async function mutateResearchProjectOrRefusal(
  owner: string,
  id: string,
  mutate: (project: ResearchProject) => ResearchProject | null,
): Promise<ResearchProject | ResearchWriteRefused | null> {
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

/**
 * The fail-soft face of {@link mutateResearchProjectOrRefusal}.
 *
 * THE ONE FUNNEL for the quiet callers, and so the one place the read-only
 * refusal is collapsed (DW-527). {@link updateResearchProject},
 * {@link updateResearchProjectIf} and {@link mutateProject} all reach the CAS
 * through here, so turning {@link RESEARCH_WRITE_REFUSED} into `null` on this
 * line covers every fail-soft caller in
 * `research-runtime`/`research-completion` without editing one of them: they
 * already treat `null` as a lost CAS race and compensate.
 */
export async function mutateResearchProject(
  owner: string,
  id: string,
  mutate: (project: ResearchProject) => ResearchProject | null,
): Promise<ResearchProject | null> {
  const result = await mutateResearchProjectOrRefusal(owner, id, mutate);
  return isResearchWriteRefused(result) ? null : result;
}

/**
 * Edit the OWNER's own fields of a project — the entry point behind
 * `PATCH /api/research/[id]` (DW-527).
 *
 * The loud half of the pair whose quiet half is {@link mutateResearchProject}.
 * Same CAS path, same `null` for "gone, or the predicate said no", but gated:
 * a read-only deployment refuses with a `ReadOnlyError` carrying
 * {@link READ_ONLY_REFUSAL.researchMutate} rather than collapsing to `null`.
 * The collapse would be a LIE at this door — the route reports a `null` as 409
 * "A running or finished research project cannot be edited.", which names the
 * wrong reason for a refusal that is really about the deployment.
 *
 * The patch type is narrowed to the three fields the door accepts, so this
 * cannot become a second, gated way to write `status`, `synthesis` or the
 * run's own bookkeeping.
 */
export async function editResearchProject(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Pick<Partial<ResearchProjectInput>, "title" | "question" | "queries">,
): Promise<ResearchProject | null> {
  // BEFORE the CAS and before its file lock, the `deleteResearchProject`
  // discipline: the refusal must precede every read, lease and write.
  assertWritable(READ_ONLY_REFUSAL.researchMutate);
  const edited = await mutateProject(owner, id, predicate, patch);
  // A `null` normally means "gone, or the predicate said no" — but the CAS
  // ALSO refuses read-only by returning null, because
  // {@link mutateResearchProject} collapses the sentinel for its fail-soft
  // callers. So a flag that flipped between the gate above and the write would
  // leave this door by the route's 409 "A running or finished research project
  // cannot be edited.": the wrong reason, and the exact mislabel this entry
  // point exists to prevent. Re-reading the flag on the null path — the one
  // path where the two facts are indistinguishable — turns that window back
  // into the refusal it is, and costs a writable deployment nothing.
  if (!edited) assertWritable(READ_ONLY_REFUSAL.researchMutate);
  return edited;
}

/**
 * The shared patch-applying mutator, WITHOUT collapsing the read-only refusal.
 *
 * The {@link mutateResearchProjectOrRefusal} split one layer up (DW-661): this
 * holds the patch logic, {@link mutateProject} below is the one collapsing line
 * over it, and {@link updateResearchProjectIfOrRefusal} is the public door for
 * a caller that must tell a refusal from a lost predicate.
 */
async function mutateProjectOrRefusal(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Parameters<typeof updateResearchProject>[2],
): Promise<ResearchProject | ResearchWriteRefused | null> {
  return mutateResearchProjectOrRefusal(owner, id, (project) => {
    if (!predicate(project)) return null;
    if (patch.title !== undefined || patch.question !== undefined) {
      const cleaned = cleanInput({
        title: patch.title ?? project.title,
        question: patch.question ?? project.question,
        queries: patch.queries ?? project.queries,
        pageSlugs: patch.pageSlugs ?? project.pageSlugs,
        vaultId: patch.vaultId === undefined ? project.vaultId : patch.vaultId,
      });
      Object.assign(project, cleaned);
    } else {
      if (patch.queries !== undefined) project.queries = cleanList(patch.queries, 16, 500);
      if (patch.pageSlugs !== undefined) project.pageSlugs = cleanList(patch.pageSlugs, 50, 240);
      if (patch.vaultId !== undefined) {
        if (patch.vaultId?.trim()) project.vaultId = patch.vaultId.trim().slice(0, 240);
        else delete project.vaultId;
      }
    }
    // AFTER both branches, not inside the `else`: the run patches its collected
    // URLs alongside `results`, and a patch that also carries `title` must still
    // land them (DW-442). `cleanInput` no longer returns the key, so the
    // `Object.assign` above cannot clobber what this line writes.
    if (patch.sourceUrls !== undefined) project.sourceUrls = cleanUrls(patch.sourceUrls);
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

/** The fail-soft face of {@link mutateProjectOrRefusal}. */
async function mutateProject(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Parameters<typeof updateResearchProject>[2],
): Promise<ResearchProject | null> {
  const result = await mutateProjectOrRefusal(owner, id, predicate, patch);
  return isResearchWriteRefused(result) ? null : result;
}

/**
 * {@link updateResearchProjectIf} for a caller whose contract is to THROW.
 *
 * Same CAS, same predicate, same patch — but a read-only refusal comes back as
 * {@link RESEARCH_WRITE_REFUSED} instead of the `null` that also means "gone,
 * or the predicate said no". `research-runtime`'s `updateResearchAttempt` and
 * `note` use it so a deployment that flips mid-run stops reporting itself as
 * "Research attempt for <id> was replaced." (DW-658, DW-661).
 */
export async function updateResearchProjectIfOrRefusal(
  owner: string,
  id: string,
  predicate: (project: ResearchProject) => boolean,
  patch: Parameters<typeof updateResearchProject>[2],
): Promise<ResearchProject | ResearchWriteRefused | null> {
  return mutateProjectOrRefusal(owner, id, predicate, patch);
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
  // Deployment read-only (DW-385). BEFORE the fence, not inside it:
  // `withResearchProjectLifecycleFence` is a `withDurableLock`, which writes a
  // CAS lease object on the R2 provider before the callback runs — so a gate
  // one line lower would have written to a deployment it was about to refuse.
  assertWritable(READ_ONLY_REFUSAL.researchMutate);
  return withResearchProjectLifecycleFence(owner, id, async () => {
    // Recheck under the same fence used by lease rotation. A caller's earlier
    // release/confirm can otherwise race a recovery that publishes a successor.
    if (await hasResearchSlot(owner, id)) return false;
    const deleted = await lockedMutation(owner, (projects) => {
      const next = projects.filter((project) => project.id !== id);
      if (next.length === projects.length) return { projects, result: false };
      return { projects: next, result: true };
    });
    // The flag flipped between the gate above and the CAS (DW-527). A silent
    // `false` would read as "no such project" — the caller would stop looking
    // for a row that is still there. Throw, as the gate would have.
    if (isResearchWriteRefused(deleted)) {
      throw new ReadOnlyError(READ_ONLY_REFUSAL.researchMutate);
    }
    return deleted;
  });
}
