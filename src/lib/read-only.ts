/**
 * The read-only refusal — one enforcement helper, one owner per SERVER-SIDE
 * sentence.
 *
 * DW-37 gated read-only door by door at the HTTP layer, which left every door
 * it did not name writing on a read-only deployment — and left `src/mcp.ts`,
 * the CLI and the agent runtime unreachable by any HTTP gate at all. DW-188's
 * recorded decision moves enforcement into the four kernel writers
 * ({@link import("./lifecycle").writeWikiPageWithSideEffects},
 * {@link import("./lifecycle").deleteWikiPage},
 * {@link import("./patch-metadata").patchMetadata},
 * {@link import("./wikis").writeWikiArtifact}) so every caller inherits the
 * refusal, and the routes map it back to the 403 they already answer.
 *
 * THE REFUSAL TRAVELS AS A THROWN ERROR, not a return value. All four writers
 * return success-shaped results that ~30 call sites destructure immediately; a
 * nullable return would be silently ignored at most of them, which is the
 * failure this module exists to make impossible.
 *
 * {@link isReadOnlyError} matches on `err.name` rather than `instanceof` so a
 * duplicated module graph (vitest's two projects, bundler chunking, the stdio
 * MCP entry point) cannot turn a route's 403 back into a 500.
 *
 * WHAT "ONE OWNER" COVERS, AND WHAT IT DOES NOT. {@link READ_ONLY_REFUSAL} owns
 * every sentence a SERVER answers — kernel writers and route handlers alike —
 * so a route and the writer behind it cannot state the same refusal two ways.
 * It does NOT own the sentences client components render beside a dimmed
 * control. Those live as their own exported constants next to the component
 * (`DELETE_PAGE_READ_ONLY_COPY`, `EDIT_PAGE_READ_ONLY_COPY`,
 * `REINGEST_READ_ONLY_COPY`, `REVERT_READ_ONLY_COPY`) because this module
 * imports `./config`, which pulls the settings/storage/embeddings graph and
 * reads `process.env` — none of which belongs in a browser bundle. So the
 * boundary is deliberate, not an oversight, and the drift it allows is pinned
 * instead: `src/lib/__tests__/read-only-copy-parity.test.ts` compares each
 * client constant against the server sentence it mirrors.
 *
 * THE WIKI-LIFECYCLE ROUTES KEEP THEIR INLINE LITERALS. `POST /api/wikis`,
 * `POST /api/wikis/[id]/template` and `PATCH /api/wikis/[id]` gate at the HTTP
 * layer on `isReadOnly()` and spell their 403 body in place. DW-266 added
 * {@link READ_ONLY_REFUSAL.wikiCreate}, `.wikiTemplate` and `.wikiRename` for
 * the KERNEL functions behind them (`createWiki`, `applyScenarioTemplate`,
 * `renameWiki`), which any DIRECT LIBRARY CALLER — a CLI command, a future MCP
 * tool, a maintenance script — reaches with no route in front. Today the four
 * wiki routes are their only callers, so the gates change no behaviour the app
 * has; they are there for the caller added next. Importing the constant into those handlers would have rewritten route
 * bodies this change is not allowed to touch, so the sentences are duplicated
 * on purpose and the duplication is pinned by TEST rather than by import:
 * `read-only-copy-parity.test.ts` compares each constant against the literal
 * the handler actually serves, so a reworded route fails on the next run.
 *
 * A CLIENT SENTENCE MAY BE NARROWER THAN THE SERVER'S. The Revert control is
 * the case: the server refusal it meets is `pageWrite`, the KERNEL's sentence
 * for any page write, because the revert route maps the writer's error rather
 * than spelling a check of its own. "Pages cannot be written…" beside a Revert
 * button would be true and useless, so the component says what the owner was
 * about to do. The parity test records that divergence explicitly.
 */

import { isReadOnly } from "./config";

/**
 * Thrown by {@link assertWritable} when the deployment refuses writes.
 *
 * `name` is set explicitly (rather than relying on the class identity) because
 * {@link isReadOnlyError} is what routes classify on — see the module note.
 */
export class ReadOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReadOnlyError";
  }
}

/**
 * Every server-side read-only refusal sentence, in one place.
 *
 * Each names read-only explicitly: "forbidden" alone would leave the owner
 * hunting a permission they do not lack. Copy says work-wiki; the runtime
 * identifier stays `YOPEDIA_READONLY`.
 */
export const READ_ONLY_REFUSAL = {
  /** `PUT /api/wiki/[slug]` — a body rewrite of an existing page. */
  pageEdit: "Pages cannot be edited while this deployment is read-only.",
  /**
   * The kernel page writer — create, edit, revert, re-ingest and every library
   * caller reach it, so the sentence names the write rather than one verb.
   */
  pageWrite: "Pages cannot be written while this deployment is read-only.",
  /** The kernel page deleter, `DELETE /api/wiki/[slug]`, and `deleteTenant`. */
  pageDelete: "Pages cannot be deleted while this deployment is read-only.",
  /** `patchMetadata` — the shared REST + MCP frontmatter path. */
  pageMetadata:
    "Page metadata cannot be changed while this deployment is read-only.",
  /** `writeWikiArtifact` and the two Workbench artifact routes. */
  artifactEdit:
    "The Schema cannot be edited while this deployment is read-only.",
  /**
   * `createWiki` and `POST /api/wikis`. Character-identical to the sentence the
   * route already serves inline — see the module note on the wiki-lifecycle
   * doors below.
   */
  wikiCreate: "Wikis cannot be created while this deployment is read-only.",
  /**
   * `applyScenarioTemplate` and `POST /api/wikis/[id]/template` — the re-seed
   * that overwrites `purpose.md`, `schema.md` and the Wiki's own profile.
   */
  wikiTemplate: "Templates cannot be applied while this deployment is read-only.",
  /** `renameWiki` and `PATCH /api/wikis/[id]`. */
  wikiRename: "Wikis cannot be renamed while this deployment is read-only.",
  /**
   * The two unlocked byte putters under `tenants/<t>/wikis/<id>/` —
   * `putWikiArtifact` in `wikis.ts` and `putWorkspaceProfile` in
   * `workspace-profile.ts` — plus `saveWorkspaceProfile`, the locked wrapper
   * that gates before taking the lock.
   *
   * ONE sentence for all three because they are one fact: this deployment does
   * not write files inside a Wiki's directory. It names the FILE rather than a
   * verb precisely because the putters are reached by create, re-template,
   * rename and a Settings save alike — the same reasoning as {@link pageWrite}.
   *
   * `PUT /api/workspace-profile` keeps its own narrower 403 ("Settings are
   * read-only in this deployment.") and never reaches this sentence, since its
   * `isReadOnly()` gate answers first; `read-only-copy-parity.test.ts` records
   * that divergence.
   */
  wikiFileWrite:
    "Wiki files cannot be written while this deployment is read-only.",
  /** `DELETE /api/ingest/history` — the bulk page delete. */
  bulkPageDelete:
    "Ingested pages cannot be deleted while this deployment is read-only.",
  /** `POST /api/ingest/reingest`. */
  reingest: "Pages cannot be re-ingested while this deployment is read-only.",
  /**
   * Every `/api/ingest/*` entry point plus the email and agent ingest doors —
   * one sentence, because they are one operation reached by different transports.
   */
  ingest: "Sources cannot be ingested while this deployment is read-only.",
  /** `POST /api/query/save` — saving an answer as a page. */
  savedAnswer: "Answers cannot be saved while this deployment is read-only.",
  /** `POST /api/lint/fix`. */
  lintFix: "Lint issues cannot be auto-fixed while this deployment is read-only.",
  /** `POST /api/tasks/run` — the queue consumer. */
  queuedWork: "Queued work cannot run while this deployment is read-only.",
} as const;

/**
 * Refuse the write when the deployment is read-only.
 *
 * `isReadOnly()` reads `process.env.YOPEDIA_READONLY` at CALL time, so this is
 * evaluated per write rather than pinned at module load — which is also what
 * lets a test flip the flag per case.
 */
export function assertWritable(refusal: string): void {
  if (isReadOnly()) {
    throw new ReadOnlyError(refusal);
  }
}

/**
 * Whether a caught value is the read-only refusal.
 *
 * Matches on `name`, not `instanceof`: a `ReadOnlyError` thrown by a SECOND
 * copy of this module — vitest's two projects, a bundler splitting server and
 * edge chunks, the stdio MCP entry point compiled separately — fails
 * `instanceof` against the copy the route imported, and the 403 would silently
 * become a 500 only in production. So the check is structural on purpose;
 * `read-only-kernel-gate.test.ts` pins it against a foreign error object.
 */
export function isReadOnlyError(err: unknown): boolean {
  return err instanceof Error && err.name === "ReadOnlyError";
}
