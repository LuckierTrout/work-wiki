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
 * `REINGEST_READ_ONLY_COPY`, `REVERT_READ_ONLY_COPY`,
 * `WORKSPACE_PURPOSE_READ_ONLY_COPY`, `BULK_DELETE_READ_ONLY_COPY`,
 * `CREATE_PAGE_READ_ONLY_COPY`, DW-386's `NAMES_TERMS_READ_ONLY_COPY` and
 * `EMAIL_INGEST_READ_ONLY_COPY`, DW-387's
 * `EMBEDDING_REBUILD_READ_ONLY_COPY`, DW-531's
 * `GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY` and `REVIEW_QUEUE_READ_ONLY_COPY`,
 * DW-643's `TODOS_READ_ONLY_COPY`,
 * and the `workbench-tree`/`workbench-preview`
 * pair `WIKI_CREATE_READ_ONLY_COPY`/`WIKI_TEMPLATE_READ_ONLY_COPY` and
 * `PREVIEW_HISTORY_READ_ONLY_COPY`) because this module
 * imports `./config`, which pulls the settings/storage/embeddings graph and
 * reads `process.env` — none of which belongs in a browser bundle. So the
 * boundary is deliberate, not an oversight, and the drift it allows is pinned
 * instead: `src/lib/__tests__/read-only-copy-parity.test.ts` compares each
 * client constant against the server sentence it mirrors.
 *
 * FOUR client mirrors do NOT live beside a component, because more than one
 * surface renders each and a constant beside either consumer would be a second
 * owner of one sentence. `SETTINGS_READ_ONLY_COPY` in `workbench-settings.ts`
 * is rendered by the Workbench save bar and the `/settings` banner and mirrors
 * {@link READ_ONLY_REFUSAL.settingsSave}. DW-386's three research sentences —
 * `RESEARCH_CREATE_READ_ONLY_COPY`, `RESEARCH_MUTATE_READ_ONLY_COPY` and
 * `RESEARCH_COLLECT_READ_ONLY_COPY` — moved out of `KnowledgeStudio.tsx` into
 * `research-panel.ts` at DW-529, once the Workbench's Research, Graph and
 * Review canvases turned out to stand in front of the same doors: a canvas
 * cannot import a page component for a string, and the Research canvas had
 * written a fourth wording of the create sentence inline rather than try. Both
 * modules are already client-safe and already own the rest of their surface's
 * copy, and both sets are pinned like every other mirror.
 *
 * NOT EVERY STUDIO WRITE HAS A SENTENCE TO MIRROR (DW-530). The Studio's
 * Purpose & vaults, Agent skills and Portability panels render no read-only
 * term for THEIR OWN write controls — create vault, rename and delete vault,
 * create/patch/delete skill, restore archive — because the doors behind those
 * controls refuse nothing: `POST /api/vaults`,
 * `PATCH`/`DELETE /api/vaults/[id]`,
 * `POST`/`PATCH`/`DELETE /api/agent-skills[/id]` and
 * `POST /api/archive/import` carry no gate, and neither do `createVault`,
 * `renameVault`, `deleteVault`, the agent-skill writers or
 * `importPortableArchive`. DW-268 records that as this flag's deliberate
 * boundary — vaults and agent profiles still mutate — so a refusal on those
 * controls would be a client-invented one. The parity suite pins those five
 * routes as ungated, and fails the moment that changes.
 *
 * That is NOT the same as "those panels carry no mirror at all". Purpose &
 * vaults embeds `<WorkspacePurposeSettings />`, which stands in front of a
 * DIFFERENT door — `PUT /api/workspace-profile`, which does refuse — and
 * renders {@link WORKSPACE_PURPOSE_READ_ONLY_COPY} accordingly. One panel, two
 * doors, and only one of them answers a refusal.
 *
 * THE WIKI-LIFECYCLE ROUTES KEEP THEIR INLINE LITERALS. `POST /api/wikis`,
 * `POST /api/wikis/[id]/template`, `PATCH`/`DELETE /api/wikis/[id]` and
 * `PUT /api/wikis/current` gate at the HTTP layer on `isReadOnly()` and spell
 * their 403 body in place. DW-266 added {@link READ_ONLY_REFUSAL.wikiCreate},
 * `.wikiTemplate` and `.wikiRename`, and DW-314 added `.wikiDelete` and
 * `.wikiSwitch`, for the KERNEL functions behind them (`createWiki`,
 * `applyScenarioTemplate`, `renameWiki`, `deleteWiki`, `setCurrentWiki`), which
 * any DIRECT LIBRARY CALLER — a CLI command, a future MCP tool, a maintenance
 * script — reaches with no route in front. Today the wiki routes are their only
 * callers, so the gates change no behaviour the app has; they are there for the
 * caller added next. Importing the constant into those handlers would have
 * rewritten route bodies this change is not allowed to touch, so the sentences
 * are duplicated on purpose and the duplication is pinned by TEST rather than
 * by import: `read-only-copy-parity.test.ts` compares each constant against the
 * literal the handler actually serves, so a reworded route fails on the next
 * run.
 *
 * {@link READ_ONLY_REFUSAL.wikiDirectorySweep} is the one wiki-lifecycle key
 * with NO route literal to mirror: `sweepOrphanWikiDirectories` is reached from
 * `deleteWiki` and from `POST /api/tasks/scan`, and neither spells a sentence
 * about it — the scan answers its own {@link READ_ONLY_REFUSAL.maintenanceScan}
 * before the sweep is ever called.
 *
 * {@link READ_ONLY_REFUSAL.scratchFileReap} (DW-292) is the second such key,
 * and it is one for the same reason: `reapStrandedScratchFiles` in
 * `maintenance.ts` is reached only from that same scan, which has already
 * answered `maintenanceScan` before the reaper is called, so no route serves
 * this sentence and none should. It exists for the DIRECT library caller — a
 * CLI command, a future MCP tool, an ops script — that reaches the reaper with
 * no route in front of it, exactly as the sweep's does. The parity suite pins
 * both as mirroring nothing.
 *
 * "THE FOUR KERNEL WRITERS" IS DW-188'S STARTING SET, NOT THE WHOLE LIST. The
 * wiki-lifecycle writers above joined them, and DW-385 added three more stores
 * that had carried HTTP gates only — {@link import("./research-projects").createResearchProject}
 * and {@link import("./research-projects").deleteResearchProject},
 * `createNamesTerm`/`updateNamesTerm`/`deleteNamesTerm` in `names-terms.ts`,
 * and {@link import("./email-ingest").saveEmailIngestConfig} — each reusing the
 * sentence its route already serves ({@link READ_ONLY_REFUSAL.researchCreate},
 * `.researchMutate`, `.namesTerms`, `.emailSettings`), so one deployment state
 * still reads as one sentence whether the caller came through a route or
 * straight into `src/lib`. Their routes KEEP the early `isReadOnly()` gate: it
 * refuses before the body parse, so a malformed body cannot pre-empt the
 * refusal with a 400.
 *
 * THE RESEARCH CAS PRIMITIVES REFUSE WITHOUT THROWING (DW-527), which is the
 * one shape in this module that is not an {@link assertWritable}.
 * `applyResearchProjectMutation` returns a frozen `RESEARCH_WRITE_REFUSED`
 * sentinel before it reads, leases or writes anything, because its wrappers
 * are an in-flight run's own progress recorders and a throw there strands the
 * run — the reason DW-385 left them open at all. `mutateResearchProject`, the
 * single fail-soft funnel, collapses the sentinel to the `null` those callers
 * already read as a lost CAS race; `createResearchProject` and
 * `deleteResearchProject` convert it to a `ReadOnlyError` so their gates still
 * hold when the flag flips underneath them. The OWNER's edit is a separate,
 * gated, throwing entry point — `editResearchProject`, which
 * `PATCH /api/research/[id]` calls — because at that door a `null` is served
 * as 409 "cannot be edited", which names the wrong reason. So the deployment
 * is closed to a direct library caller in every case; what differs is whether
 * the refusal arrives as a value or as a throw.
 *
 * EACH CONVERSION CARRIES THE SENTENCE ITS OWN GATE ALREADY SERVES (DW-659):
 * create {@link READ_ONLY_REFUSAL.researchCreate}, delete
 * {@link READ_ONLY_REFUSAL.researchMutate}. That the two are DIFFERENT sentences
 * is just the two doors being two doors; what DW-659 is about is agreement
 * WITHIN one door. Each of those entry points refuses twice — once at its own
 * `assertWritable`, once by converting the sentinel — and the caller cannot tell
 * which of the two flag reads lost, so both paths out of one door have to answer
 * with the same sentence. Create's conversion carried `researchMutate` until
 * DW-659, reporting a project that was never stored as one that "cannot be
 * changed". The mismatch hid because a conversion sits well below the gate it
 * has to match, with the whole body of the write in between; the comment at
 * create's conversion now names the gate it must agree with, and this note
 * records both pairings in one place.
 *
 * COLLAPSING IS NOW A CHOICE, NOT THE ONLY OPTION (DW-661). While the funnel
 * was the only way up from the primitive, "refused" and "lost the race" were
 * one answer to every runtime caller, and five entry points in
 * `research-runtime` reported a mid-request refusal as something it was not:
 * `retireResearchProject` as 404 "Research project not found.",
 * `queueResearchProject`/`cancelResearchProject` as
 * `ResearchProjectNotFoundError`, and `note`/`updateResearchAttempt` as
 * "Research attempt for <id> was replaced." — a lease race about a row nothing
 * had touched. So each fail-soft wrapper now has a refusal-preserving sibling
 * that carries the sentinel through — `mutateResearchProjectOrRefusal` and
 * `updateResearchProjectIfOrRefusal` — and those five entry points, whose
 * contract is to throw, take the sibling and convert the sentinel to a
 * `ReadOnlyError` carrying {@link READ_ONLY_REFUSAL.researchMutate}. The
 * collapsing wrappers are untouched and still serve the ~30 fail-soft call
 * sites in `research-runtime`/`research-completion`, so the primitive still
 * refuses by RETURNING and nothing in an in-flight run's recovery path
 * acquired a throw. WHERE the sentinel becomes an error is a decision made at
 * the entry point, where the contract is known — never in the CAS layer, which
 * cannot tell one kind of caller from the other.
 *
 * AND FOURTEEN OF THOSE DOORS NOW CARRY A BACKSTOP AS WELL (DW-316, DW-319,
 * DW-526, DW-527's `PATCH /api/research/[id]`, and DW-639/DW-657's
 * `DELETE /api/research/[id]` and `POST /api/research/[id]/run`). The five
 * wiki-lifecycle writes, the three Names & Terms verbs,
 * `PUT /api/email/settings`, `POST /api/research`,
 * `PATCH`/`DELETE /api/research/[id]`, `POST /api/research/[id]/run` and the
 * `PUT /api/workspace-profile` write each classify {@link isReadOnlyError} as
 * the FIRST branch of their catch — the shape `PUT /api/workbench/artifact` and
 * `POST /api/ingest/reingest` already used. Every early gate above is unchanged
 * and still answers first; the branch is reached only when the flag flips
 * MID-request — writable on arrival, refused by the writer — which these doors
 * used to report as a server fault (500) or as the caller's bad input (400).
 * It carries the KERNEL's sentence verbatim rather than re-serving the route's
 * literal, so a mid-request flip is the one path on which the two sentences a
 * door owns can differ: WHICH one a caller reads records WHEN the deployment
 * turned read-only. `PUT /api/workspace-profile` is where that shows most
 * plainly — its gate answers the narrow "Settings are read-only in this
 * deployment." and its backstop the wider
 * {@link READ_ONLY_REFUSAL.wikiFileWrite}.
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
    "Wiki artifacts cannot be edited while this deployment is read-only.",
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
   * `deleteWiki` and `DELETE /api/wikis/[id]`. Character-identical to the
   * sentence the route already serves inline — see the module note on the
   * wiki-lifecycle doors below.
   */
  wikiDelete: "Wikis cannot be deleted while this deployment is read-only.",
  /**
   * `setCurrentWiki` and `PUT /api/wikis/current`. Character-identical to the
   * route's inline literal, for the same reason as {@link wikiDelete}.
   *
   * A switch writes ONE tenant file — `wikis.json`, not one artifact byte —
   * plus the `dataVersion` refresh counter (DW-518), which is exactly why it
   * needs saying: "nothing was deleted" is not "nothing was written", and which
   * Wiki is current decides which `schema.md` every ingest, chat and lint
   * prompt runs on.
   */
  wikiSwitch:
    "The active wiki cannot be changed while this deployment is read-only.",
  /**
   * `sweepOrphanWikiDirectories` — the orphan-directory reclaim, reached from
   * `deleteWiki` and, on a timer, from `POST /api/tasks/scan`.
   *
   * Its own sentence rather than {@link wikiDelete}'s: the sweep removes
   * directories the registry never names, so an owner (or a log line) reading
   * "Wikis cannot be deleted…" beside a scheduled GC pass would be looking for a
   * delete nobody asked for.
   */
  wikiDirectorySweep:
    "Orphaned wiki directories cannot be reclaimed while this deployment is read-only.",
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
   * read-only in this deployment.") for a deployment already read-only when the
   * request arrived, since its `isReadOnly()` gate answers first — but it does
   * reach this sentence on the mid-request flip its catch now backstops
   * (DW-319); `read-only-copy-parity.test.ts` records that divergence.
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
  /** `POST /api/research` — creating a research project. */
  researchCreate:
    "Research projects cannot be created while this deployment is read-only.",
  /**
   * `POST /api/research/[id]/run`, `PATCH`/`DELETE /api/research/[id]`.
   *
   * ONE sentence for all four, the {@link pageWrite} reasoning: they are one
   * capability from where the owner stands — running, editing, cancelling and
   * deleting a research project are the same "change my research" — and four
   * near-identical sentences would be four things to keep in step for no gain
   * the reader can see. `researchCreate` stays its own because it is refused
   * from a different surface (the confirm dialog) and says something the others
   * cannot: that nothing was created.
   */
  researchMutate:
    "Research projects cannot be changed while this deployment is read-only.",
  /**
   * The three Names & Terms writers — `POST /api/names-terms` and
   * `PUT`/`DELETE /api/names-terms/[id]`.
   *
   * ONE sentence for all three, the {@link pageWrite} reasoning: they are one
   * store reached by three verbs, and three near-identical sentences would be
   * three things to keep in step for no gain the owner can act on.
   */
  namesTerms:
    "Names & Terms entries cannot be changed while this deployment is read-only.",
  /** `PUT /api/email/settings` — the owner's email-ingestion configuration. */
  emailSettings:
    "Email ingestion settings cannot be changed while this deployment is read-only.",
  /**
   * Kernel Todos writers and `/api/todos` — Candidates, approve/reject, patch,
   * and owner delete.
   */
  todos: "Todos cannot be changed while this deployment is read-only.",
  /**
   * Mark as meeting — `/api/sources/meeting` and {@link import("./source-meeting").setSourceMeeting}.
   */
  sourceMeeting:
    "Sources cannot be marked as meetings while this deployment is read-only.",
  /** Workbench Review queue writers. */
  reviewQueue: "Review items cannot be changed while this deployment is read-only.",
  /** Dismissed Graph Insights. */
  graphInsightDismiss:
    "Graph insights cannot be dismissed while this deployment is read-only.",
  /**
   * `POST /api/tasks/scan` — the autonomous-maintenance producer.
   *
   * The scan refuses WHOLE rather than degrading to `?dry=1`: `dry` is the
   * documented inspection switch, and answering a dry-looking 200 would report
   * a scan that never ran.
   */
  maintenanceScan:
    "Maintenance scans cannot run while this deployment is read-only.",
  /**
   * `PUT /api/settings` — the deployment's provider, model and endpoint config
   * (DW-387).
   *
   * The door spelled "Settings are read-only in this deployment." inline until
   * this key existed, which made `/settings` state three different sentences
   * for one deployment state: the page banner, this route, and the embeddings
   * rebuild below. One owner ends that; the banner and the Workbench save bar
   * both render {@link import("./workbench-settings").SETTINGS_READ_ONLY_COPY},
   * the character-identical client mirror.
   *
   * `PUT /api/workspace-profile` KEEPS its own narrower literal — the same
   * sentence this route used to serve — because it is a different door with a
   * different scope, and rewriting that handler is out of this change. The
   * parity suite pins both, so the two can no longer be mistaken for one.
   */
  settingsSave:
    "Settings cannot be changed while this deployment is read-only.",
  /**
   * `POST /api/settings/rebuild-embeddings` — re-embedding the whole corpus.
   *
   * Its own sentence rather than {@link settingsSave}'s: a rebuild changes no
   * setting at all, and an owner reading "Settings cannot be changed…" beside a
   * button labelled **Rebuild Vector Index** would go looking for the field
   * they were supposed to have edited.
   */
  embeddingRebuild:
    "Embeddings cannot be rebuilt while this deployment is read-only.",
  /**
   * `reapStrandedScratchFiles` in `maintenance.ts` — the scheduled reclamation
   * of `.tmp-<uuid>.tmp` files a dead process left behind (DW-292).
   *
   * Deletes bytes on a timer, like {@link wikiDirectorySweep}, and like it has
   * no route literal to mirror: `POST /api/tasks/scan` answers
   * {@link maintenanceScan} before the reaper is reached. Its own sentence
   * rather than the sweep's, because an owner reading "Orphaned wiki
   * directories cannot be reclaimed…" for a scratch-file pass would go looking
   * for a Wiki that was never involved.
   */
  scratchFileReap:
    "Stranded scratch files cannot be reclaimed while this deployment is read-only.",
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
