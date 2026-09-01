/**
 * The Wiki entity: a named, template-seeded workspace.
 *
 * Story 1.2. A Wiki is a first-class multi-instance record — a UUID id, a
 * name, the Scenario Template it was created from, and timestamps — held in a
 * per-tenant registry with a `current` pointer:
 *
 *   tenants/<tenant>/wikis.json                 { version, wikis, currentId }
 *   tenants/<tenant>/wikis/<wikiId>/purpose.md
 *   tenants/<tenant>/wikis/<wikiId>/schema.md
 *
 * The artifacts deliberately do NOT live under `tenants/<tenant>/wiki/`:
 * `reconcileSilos()` sweeps that tree and deletes any `.md` that is not in the
 * page index, so a seeded file there would vanish on the next reconcile.
 *
 * Pages and Sources are NOT partitioned per Wiki — they stay in the tenant
 * silo exactly where they are. Creating or re-templating a Wiki writes
 * `purpose.md`, `schema.md`, and THAT WIKI'S OWN `workspace-profile.json`
 * (a third sibling in the same directory), and nothing else. The profile is
 * per-Wiki, so seeding one Wiki never disturbs another's hand-authored
 * Workspace Purpose; which one reaches the seven prompt sites that consume
 * `buildWorkspaceGuidance(owner)` follows the `current` pointer, resolved by
 * `workspace-guidance.ts`.
 *
 * One lock key, `wikis:<tenant>`, owns the registry AND everything under
 * `tenants/<t>/wikis/<id>/` — including the profile. `withFileLock` is not
 * reentrant, so anything running inside it writes through an unlocked putter
 * ({@link putWikiArtifact}, `putWorkspaceProfile`). See `src/lib/lock.ts`.
 *
 * The key is always taken through `withWikiLock` (`wiki-lock.ts`), never as a
 * bare `withFileLock(wikiLockKey(owner), …)`: one spelling, and it is the one
 * that mints the `WikiLockHeld` token the cross-module putter demands (DW-139).
 * `putWikiArtifact` needs no token because it is module-private and every
 * caller is visible here; `putWorkspaceProfile` is not, so the token rides down
 * through {@link seedWikiArtifacts}.
 *
 * READ-ONLY (DW-266, DW-314): {@link createWiki}, {@link applyScenarioTemplate},
 * {@link renameWiki}, {@link deleteWiki}, {@link setCurrentWiki} and
 * {@link sweepOrphanWikiDirectories} each refuse BEFORE taking the lock and
 * before reading a byte, so a refusal on a stably read-only deployment never
 * reaches a compensation path; the putters refuse again as a backstop. The wiki
 * routes keep their own inline 403s and gate first, so these gates change
 * nothing the app does today — they exist for a DIRECT LIBRARY CALLER (a CLI
 * command, a future MCP tool, the maintenance scan) reaching the kernel with no
 * route in front.
 *
 * THE WHOLE LIFECYCLE IS COVERED NOW, which the earlier note said it was not.
 * DW-266 gated the three creating writers and recorded the other three as a
 * known gap; DW-314 closed it. {@link deleteWiki} is the one that most needed
 * it: it swallows BOTH byte-removal failures, so a refusal raised inside the
 * lock would land after `wikis.json` had already been rewritten and would be
 * logged rather than surfaced. {@link sweepOrphanWikiDirectories} needed it for
 * a different reason — `POST /api/tasks/scan` reaches it on a TIMER, so an
 * ungated sweep deleted directories on a read-only deployment with nobody
 * asking.
 *
 * The registry idiom (path, lock key, `crypto.randomUUID()`, ENOENT → empty,
 * a hard cap) mirrors `research-projects.ts`.
 */

import { bumpDataVersion } from "./data-version";
import { ClientInputError, isEnoent } from "./errors";
import { logger } from "./logger";
import { getOwnerHandle } from "./owner";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { readEnginePageConventions } from "./schema-source";
import { getStorage } from "./storage";
import { appendToLog } from "./wiki-log";
import {
  CREATABLE_SCENARIOS,
  EDITABLE_ARTIFACT_FILES,
  MAX_WIKI_NAME_CHARS,
  SCENARIO_LABELS,
  WIKI_ARTIFACT_FILES,
  isCreatableScenario,
  renderPurposeMarkdown,
  renderSchemaMarkdown,
  scenarioTemplate,
  type CreatableScenario,
  type EditableArtifactFile,
  type WikiArtifactFile,
} from "./wiki-scenarios";
import { tenantForOwner, validateTenant } from "./wiki";
import { withWikiLock, type WikiLockHeld } from "./wiki-lock";
import {
  WIKI_ID_RE,
  wikiArtifactPath,
  wikiDirPath,
  wikisRootPath,
} from "./wiki-paths";
import { saveWikiArtifactRevision } from "./wiki-artifact-revisions";
import {
  WRITE_CONFLICT_STATUS,
  WriteConflictError,
  checkVersionPrecondition,
  scopedContentVersion,
} from "./write-precondition";
import {
  putWorkspaceProfile,
  readWorkspaceProfileEvidence,
} from "./workspace-profile";
import {
  workspaceProfileHasGuidance,
  type WorkspaceProfileInput,
} from "./workspace-profile-schema";
import {
  ARTIFACT_AUTHORITY_VERSION,
  appendLegacyPageConventions,
  renderCanonicalPurposeMarkdown,
} from "./workspace-purpose";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiRecord {
  id: string;
  name: string;
  scenario: CreatableScenario;
  createdAt: string;
  updatedAt: string;
  /** Present only after purpose.md/schema.md become the sole guidance source. */
  artifactAuthority?: typeof ARTIFACT_AUTHORITY_VERSION;
}

export interface WikiRegistry {
  version: 1;
  wikis: WikiRecord[];
  /** The active Wiki's id, or null when the registry is empty. */
  currentId: string | null;
}

export interface CreateWikiInput {
  name: string;
  scenario: CreatableScenario;
}

export interface RenameWikiInput {
  name: string;
}

// The artifact list and the name cap are declared in the pure, client-safe
// `wiki-scenarios` module so the dialog and the workbench share one copy;
// re-exported here so server callers keep a single import.
export { WIKI_ARTIFACT_FILES, MAX_WIKI_NAME_CHARS, type WikiArtifactFile };

/** Hard cap on Wikis per tenant. Reaching it is a 400, never a silent drop. */
export const MAX_WIKIS = 100;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

function tenantFor(owner: string | null | undefined): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return tenant;
}

/** `tenants/<tenant>/wikis.json` — the per-tenant Wiki registry. */
export function wikiRegistryPath(owner: string): string {
  return `tenants/${tenantFor(owner)}/wikis.json`;
}

// The id guard, the Wiki directory address and the Wiki lock key live in the
// leaf `wiki-paths` module so `workspace-profile.ts` can reach them without
// importing this file back (this one imports IT). Re-exported here because five
// existing suites still address artifacts through `wikis.wikiArtifactPath`
// (`wikis`, `wiki-schema-edit`, `wiki-schema-source`, `workbench-preview`,
// `workbench-tree`); every non-test caller now imports `wiki-paths` directly,
// and new callers should too.
export { wikiArtifactPath };

// ---------------------------------------------------------------------------
// Input parsing — every rejection is a ClientInputError so routes answer 400
// ---------------------------------------------------------------------------

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ClientInputError("Request body must be an object.");
  }
  return value as Record<string, unknown>;
}

/**
 * Parse a scenario. `custom` and anything unknown are rejected — there is no
 * blank Wiki (FR-38), so the only accepted values are the five creatable ones.
 */
export function parseScenarioInput(value: unknown): CreatableScenario {
  const scenario = asObject(value).scenario;
  if (!isCreatableScenario(scenario)) {
    throw new ClientInputError(
      `Choose one Scenario Template: ${CREATABLE_SCENARIOS.map(
        (item) => SCENARIO_LABELS[item],
      ).join(", ")}.`,
    );
  }
  return scenario;
}

/**
 * The Wiki-name rules, in ONE place: text, trimmed, inner whitespace collapsed,
 * non-blank, at most {@link MAX_WIKI_NAME_CHARS}.
 *
 * Create and rename both go through here so the cap and the collapse cannot
 * drift apart — a rename that accepted 200 characters would put a name in the
 * registry that create would have refused, and `# <name>` at the top of
 * `purpose.md` would carry it.
 */
export function parseWikiName(value: unknown): string {
  if (typeof value !== "string") {
    throw new ClientInputError("Wiki name must be text.");
  }
  const name = value.trim().replace(/\s+/g, " ");
  if (!name) throw new ClientInputError("Wiki name is required.");
  if (name.length > MAX_WIKI_NAME_CHARS) {
    throw new ClientInputError(
      `Wiki name must be ${MAX_WIKI_NAME_CHARS} characters or fewer.`,
    );
  }
  return name;
}

/** Parse a create-Wiki body: a non-blank name of at most 80 chars, plus a scenario. */
export function parseCreateWikiInput(value: unknown): CreateWikiInput {
  const scenario = parseScenarioInput(value);
  return { name: parseWikiName(asObject(value).name), scenario };
}

/** Parse a rename body: `{ name }`, under the same rules as create. */
export function parseRenameWikiInput(value: unknown): RenameWikiInput {
  return { name: parseWikiName(asObject(value).name) };
}

// ---------------------------------------------------------------------------
// Registry read / write
// ---------------------------------------------------------------------------

/** A registry with no Wikis — the shape a failed read degrades to. */
export function emptyRegistry(): WikiRegistry {
  return { version: 1, wikis: [], currentId: null };
}

function normalizeRegistry(parsed: unknown): WikiRegistry {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyRegistry();
  }
  const record = parsed as Record<string, unknown>;
  const candidates = Array.isArray(record.wikis) ? record.wikis : [];
  const wikis = candidates.filter((entry): entry is WikiRecord => {
    if (!entry || typeof entry !== "object") return false;
    const item = entry as Record<string, unknown>;
    // Every field the UI and the seeder render must be present: a truncated
    // or hand-edited wikis.json otherwise yields `undefined` in the workbench
    // heading, the switcher options, and `# undefined` at the top of a
    // re-templated purpose.md. The id is checked for SHAPE, not just type,
    // because it becomes a storage path segment — an entry whose id
    // `wikiArtifactPath` would reject must never reach the client as a
    // selectable Wiki that 400s on every operation.
    return (
      typeof item.id === "string" &&
      WIKI_ID_RE.test(item.id) &&
      typeof item.name === "string" &&
      item.name.length > 0 &&
      typeof item.createdAt === "string" &&
      typeof item.updatedAt === "string" &&
      isCreatableScenario(item.scenario)
    );
  });
  if (wikis.length !== candidates.length) {
    // Dropping a record hides a Wiki and orphans its `wikis/<id>/` artifacts.
    // Every other degradation path here logs; this one must not be the silent
    // exception, or a damaged registry makes Wikis vanish undiagnosably.
    logger.warn(
      "wikis",
      `dropped ${candidates.length - wikis.length} unusable registry entr${
        candidates.length - wikis.length === 1 ? "y" : "ies"
      } from wikis.json`,
    );
  }
  const stored = typeof record.currentId === "string" ? record.currentId : null;
  const currentId =
    stored !== null && wikis.some((wiki) => wiki.id === stored)
      ? stored
      : (wikis[0]?.id ?? null);
  if (stored !== null && stored !== currentId) {
    // Re-pointing `current` changes which `schema.md` executes in every
    // ingest, chat, and lint prompt. Silently is the one way it must not
    // happen — the drop above logs, and this is the same class of repair.
    logger.warn(
      "wikis",
      `wikis.json names an unknown current wiki "${stored}" — falling back to ${
        currentId ?? "no active wiki"
      }`,
    );
  }
  return { version: 1, wikis, currentId };
}

async function readRegistry(owner: string): Promise<WikiRegistry> {
  try {
    return normalizeRegistry(
      JSON.parse(await getStorage().readFile(wikiRegistryPath(owner))),
    );
  } catch (error) {
    if (isEnoent(error)) return emptyRegistry();
    throw error;
  }
}

/**
 * Persist the registry as-is. Deliberately does NOT cap the list: silently
 * dropping the oldest record would orphan its `wikis/<id>/` artifacts on disk
 * with no error. {@link createWiki} enforces {@link MAX_WIKIS} up front instead.
 *
 * Orphans that DO arise — a `normalizeRegistry` drop, or an interrupted delete —
 * are reclaimed by {@link sweepOrphanWikiDirectories}, which the maintenance
 * scan runs on a schedule (`sweepOrphanWikiDirs` in `maintenance.ts`), so
 * reclamation no longer waits on the tenant happening to delete a Wiki.
 */
async function writeRegistry(owner: string, registry: WikiRegistry): Promise<void> {
  await getStorage().writeFile(
    wikiRegistryPath(owner),
    JSON.stringify(registry, null, 2),
  );
}

// ---------------------------------------------------------------------------
// Seeding — purpose.md + schema.md + the workspace profile, together
// ---------------------------------------------------------------------------

/** The template's profile half: everything except its display name/description. */
function templateProfile(scenario: CreatableScenario): WorkspaceProfileInput {
  const template = scenarioTemplate(scenario);
  return {
    scenario: template.scenario,
    purpose: template.purpose,
    keyQuestions: [...template.keyQuestions],
    inScope: [...template.inScope],
    outOfScope: [...template.outOfScope],
    outputLanguage: template.outputLanguage,
    pageConventions: template.pageConventions,
  };
}

/**
 * The BYTES of one artifact, and nothing else — no lock, no log, no bump.
 *
 * UNLOCKED on purpose. `seedWikiArtifacts` runs inside `withWikiLock(owner)`
 * already (via {@link createWiki} and {@link applyScenarioTemplate}) and
 * `withFileLock` is NOT reentrant — `lock.ts` chains a new call onto the key's
 * existing promise, so taking `wikis:<tenant>` again from in there would
 * deadlock the whole tenant. Callers that are not already holding it take it
 * themselves; see {@link writeWikiArtifact}.
 *
 * MODULE-PRIVATE, which is why it takes no `WikiLockHeld` while
 * `putWorkspaceProfile` does: every caller is in this file and visible in one
 * read, so the compile-time proof DW-139 asked for buys nothing here. What it
 * does carry is the read-only refusal (DW-266) — the three entry points below
 * gate before the lock, and this is the backstop that keeps a FUTURE caller in
 * this module from writing bytes on a read-only deployment by forgetting to.
 *
 * This is also the ONE place artifact bytes are written. Both the seeder and
 * the Schema editor address them through {@link wikiArtifactPath}, so
 * `tenants/<t>/wikis/<id>/…` has a single expression in the repo.
 */
async function putWikiArtifact(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  content: string,
): Promise<void> {
  assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
  await getStorage().writeFile(wikiArtifactPath(owner, wikiId, file), content);
}

/**
 * Write the two artifacts and the workspace profile for `wiki`.
 *
 * This is the whole footprint of create and of re-template: nothing under
 * `tenants/<t>/wiki/`, nothing under `tenants/<t>/raw/`, no page index entry
 * and no log line — create and re-template are registry operations, not edits,
 * and only {@link writeWikiArtifact}'s log tail names a Schema edit.
 *
 * NO `dataVersion` BUMP HERE, but the operation does bump: {@link createWiki}
 * and {@link applyScenarioTemplate} each fire one fail-soft
 * {@link bumpDataVersion} after releasing `wikis:<tenant>`. BOTH artifacts go
 * stale across a re-apply — `purpose.md` is rewritten from the new template
 * just as `schema.md` is — so a Preview reading either one refetches the newly
 * seeded bytes instead of showing the old template's. It cannot be fired
 * from in here for the same reason {@link putWikiArtifact} is unlocked: this
 * function always runs while `wikis:<tenant>` is held, `bumpDataVersion` takes
 * `DATA_VERSION_LOCK`, and nesting those two keys would invent a lock order
 * nothing else in the repo takes. The callers own it also because only they
 * know whether the whole operation COMMITTED — a run that reaches their
 * compensation restored or discarded the bytes and must not move the signal.
 *
 * All three writes land in `tenants/<t>/wikis/<id>/`, so the footprint is
 * scoped to THIS Wiki: seeding one Wiki cannot touch another's hand-authored
 * Workspace Purpose. The profile goes through the UNLOCKED `putWorkspaceProfile`
 * for the same reason {@link putWikiArtifact} is unlocked — the caller is
 * already holding `wikis:<tenant>`.
 *
 * `held` IS THE PROOF OF THAT, THREADED not re-derived. `putWorkspaceProfile`
 * lives in another module and cannot see which lock this call stack is under,
 * so the token minted by `withWikiLock` in {@link createWiki} /
 * {@link applyScenarioTemplate} rides down to it (DW-139). This function takes
 * it rather than minting one so that a future caller outside a lock cannot
 * reach the seeder either.
 *
 * THREE SEQUENTIAL WRITES, NO TRANSACTION, and deliberately none here: a fault
 * at ANY of them — and at the caller's registry write that follows — is undone
 * by the CALLER's compensation, because what the undo is depends on whether the
 * directory is new (discard it) or being overwritten (restore the snapshot).
 * See the compensation block below.
 */
async function seedWikiArtifacts(
  held: WikiLockHeld,
  owner: string,
  wiki: WikiRecord,
  options: { seedProfile: boolean },
): Promise<void> {
  const template = scenarioTemplate(wiki.scenario);
  // The seeded Schema embeds the engine's own page conventions ahead of the
  // scenario's, so the Wiki's file IS the whole executable Schema and
  // activating it never strips the structural contract from a prompt.
  const engineConventions = await readEnginePageConventions();
  await putWikiArtifact(
    owner,
    wiki.id,
    "purpose.md",
    renderPurposeMarkdown(wiki.name, template),
  );
  await putWikiArtifact(
    owner,
    wiki.id,
    "schema.md",
    renderSchemaMarkdown(template, engineConventions),
  );
  if (options.seedProfile) {
    await putWorkspaceProfile(held, owner, wiki.id, templateProfile(wiki.scenario));
  }
}

// ---------------------------------------------------------------------------
// Compensating cleanup for a half-finished seed (DW-20, DW-143)
// ---------------------------------------------------------------------------

/*
 * The storage provider has NO transaction, and this deliberately does not add
 * one — no journal, no write-ahead log, no two-phase commit. `seedWikiArtifacts`
 * plus `writeRegistry` is four sequential `writeFile` calls, each atomic on its
 * own (tmp + rename in the filesystem provider, single-object PUT in R2) and
 * none atomic together, so a fault at ANY ONE of the four used to leave durable
 * wreckage: a create left a `wikis/<id>/` directory no registry entry named,
 * and a re-template left `purpose.md`/`schema.md` on the NEW template beside a
 * `workspace-profile.json` still on the old one — one Wiki describing two
 * templates to every prompt that reads it.
 *
 * What closes it is a compensation around each caller, and the two callers need
 * DIFFERENT ones:
 *
 *   - CREATE is building a directory that did not exist a moment ago (the id
 *     comes straight from `crypto.randomUUID()`), so the undo is to discard the
 *     whole directory — one `deleteDirectory`, scoped to an id this call minted,
 *     safe whether or not any byte landed.
 *   - RE-TEMPLATE is OVERWRITING files an owner may have edited, so the undo has
 *     to be a byte snapshot taken BEFORE the seed and written back after, with
 *     "the file did not exist" restored as a delete rather than as an empty file.
 *
 * Both run inside the already-held `wikis:<tenant>` lock and therefore go
 * through `getStorage()` directly — `withFileLock` is not reentrant, so taking
 * the Wiki lock again from in here would deadlock the whole tenant. They also
 * bypass the putters' read-only gate on purpose: a compensation only ever runs
 * on a deployment that was already writing, and while the flag holds STILL the
 * entry-point gates above mean a refused call never reaches one. `isReadOnly()`
 * re-reads `process.env` per call, though, so a flag flipped mid-operation can
 * land here — with a seed already part-written, which is exactly the state a
 * compensation must be allowed to clean up rather than refuse.
 *
 * Both are FAIL-SOFT in the same shape as `deleteWiki`'s tail: a cleanup that
 * itself throws is warned about and swallowed, because the caller must receive
 * the ORIGINAL storage failure. Compensation removes wreckage; it never turns a
 * failure into a success, and never replaces the diagnosis with its own.
 */

/** One seeded file's pre-seed bytes, or null when it did not exist. */
interface SeededFileSnapshot {
  path: string;
  content: string | null;
}

/**
 * The three paths a seed writes: both artifacts and this Wiki's profile.
 *
 * The profile address comes from `wikiProfilePath` rather than a literal, so
 * `workspace-profile.ts`'s putter and this restore cannot drift onto different
 * files — that drift would silently make the restore a no-op.
 */
function seededFilePaths(owner: string, wikiId: string): string[] {
  return WIKI_ARTIFACT_FILES.map((file) => wikiArtifactPath(owner, wikiId, file));
}

/**
 * Read the pre-seed bytes of everything {@link seedWikiArtifacts} will overwrite.
 *
 * DELIBERATELY NOT FAIL-SOFT, and it is the one step here that isn't: it runs
 * BEFORE the first write, so a throw leaves the Wiki exactly as it was. Warning
 * and carrying on would mean seeding with no way back — the precise state
 * DW-143 is about.
 *
 * Missing reads ENOENT → null, the {@link readWikiArtifact} shape, because a
 * Wiki whose profile file has never been written is an ordinary state (the
 * legacy tenant-global read-through covers it) and restoring it must mean
 * DELETING the file again, not leaving the new template's bytes behind.
 */
async function snapshotSeededFiles(
  owner: string,
  wikiId: string,
): Promise<SeededFileSnapshot[]> {
  const storage = getStorage();
  return Promise.all(
    seededFilePaths(owner, wikiId).map(async (path) => {
      try {
        return { path, content: await storage.readFile(path) };
      } catch (error) {
        if (isEnoent(error)) return { path, content: null };
        throw error;
      }
    }),
  );
}

/**
 * Put every snapshotted file back, byte for byte. NEVER THROWS.
 *
 * RETURNS WHETHER THE ROLLBACK WAS COMPLETE — true only when every entry was
 * restored (DW-210). The per-entry fail-soft below is deliberate and unchanged,
 * but "some of the new template's bytes are still on disk" is a materially
 * different outcome from "the wiki is exactly as it was", and the only caller
 * re-throws either way. Without this answer the caller cannot tell the two
 * apart, so the partial case moved bytes an open Preview is never told about.
 *
 * The bytes are written back RAW rather than re-seeded through
 * `putWorkspaceProfile`: re-seeding would re-stamp `updatedAt` and re-serialize
 * through the parser, so "identical to before the call" would stop being true
 * of the file even when it was true of the meaning.
 *
 * Each entry is attempted independently — one unwritable file must not skip the
 * restore of the other two — and `content === null` restores "did not exist" as
 * a delete, tolerating ENOENT because a seed that faulted before that write
 * never created it.
 */
async function restoreSeededFiles(
  snapshot: SeededFileSnapshot[],
): Promise<boolean> {
  const storage = getStorage();
  let complete = true;
  for (const entry of snapshot) {
    try {
      if (entry.content === null) {
        try {
          await storage.deleteFile(entry.path);
        } catch (error) {
          // The seed never got as far as creating it — nothing to undo.
          if (!isEnoent(error)) throw error;
        }
      } else {
        await storage.writeFile(entry.path, entry.content);
      }
    } catch (error) {
      // Recorded, not raised: the loop still attempts every remaining entry —
      // one unwritable file must not skip the restore of the other two.
      complete = false;
      logger.warn(
        "wikis",
        `restoring "${entry.path}" after a failed re-template failed — this wiki may now describe two different scenario templates`,
        error,
      );
    }
  }
  return complete;
}

/**
 * What the sidecar says a re-template's revision was (DW-213).
 *
 * Exported so the surface that lists the entry and the test that pins it read
 * the same sentence rather than two copies of it. It names BOTH halves of the
 * event — that a Scenario Template was applied, and WHICH one replaced the
 * bytes — because in the list beside an owner's own edit summaries "re-applied
 * a template" alone would not say what the file now holds.
 *
 * `SCENARIO_LABELS` rather than the raw id, for the reason
 * {@link describeWiki} uses it: `personal-growth` is a key, not a name.
 */
export function retemplateRevisionReason(scenario: CreatableScenario): string {
  return `replaced by the ${SCENARIO_LABELS[scenario]} Scenario Template`;
}

/**
 * Record what a COMMITTED re-template overwrote, as artifact history (DW-213).
 *
 * DW-59 gave `writeWikiArtifact` a read-before-write snapshot, and left this
 * hole open on purpose: `applyScenarioTemplate` writes through
 * {@link seedWikiArtifacts} → `putWikiArtifact`, which owns no tail, so a
 * SUCCESSFUL re-template overwrote an owner-edited `schema.md` with template
 * bytes and kept no copy of what it replaced. `snapshotSeededFiles` /
 * {@link restoreSeededFiles} is not that copy — it is rollback for a FAILED
 * seed, reachable only from the `catch` — so the one path that always destroys
 * bytes was the one path with no history.
 *
 * WHY IT REUSES THE SNAPSHOT RATHER THAN READING AGAIN. Those bytes were read
 * inside this same `wikis:<tenant>` lock, BEFORE the first overwrite, and are
 * exactly what the new template replaced; a second read after the seed would
 * return the TEMPLATE's bytes and file them as the owner's. The entry is matched
 * by {@link wikiArtifactPath} rather than by array index, so a reordering of
 * `seededFilePaths` cannot silently file the profile as a Schema.
 *
 * WHY AFTER THE COMMIT. Written before the seed, a seed that then failed would
 * leave a revision identical to the bytes `restoreSeededFiles` put back —
 * history recording an event that did not happen. The failure path already has
 * its compensation; this is history for the path that succeeded.
 *
 * WHY ONLY {@link EDITABLE_ARTIFACT_FILES}. That is the set
 * `GET/POST /api/workbench/artifact/revisions` can list and revert. A
 * `purpose.md` revision would be bytes no surface can reach, and `purpose.md`
 * has no editor for an owner to have personalised it through — so the allowlist
 * is the compiler's rather than a literal here, and widening the editable type
 * widens this with it.
 *
 * FAIL-SOFT, in the same shape as `writeWikiArtifact`'s own snapshot: a throw is
 * warned about and swallowed. The seed and the registry write have both already
 * landed by the time this runs, and a re-template that reached storage must not
 * be reported as failed because history could not be recorded.
 *
 * THE WHOLE BODY IS INSIDE THAT ENVELOPE, not only the revision write. A `try`
 * drawn tightly around `saveWikiArtifactRevision` leaves `wikiArtifactPath`'s
 * `validateTenant` and the reason's normalization outside it, so a throw from
 * either would reject a COMMITTED re-template — reporting a stored one as
 * failed, which is exactly what the paragraph above promises cannot happen.
 * Nothing this function can do is worth that, so nothing it does escapes.
 *
 * `content === null` is the pre-seed read finding nothing — the FIRST-WRITE
 * case, where there is nothing to snapshot and nothing to warn about.
 *
 * Takes no lock of its own: `saveWikiArtifactRevision` takes none by design and
 * the caller is already inside `withWikiLock`, which is not reentrant.
 */
async function recordRetemplatedArtifacts(
  owner: string,
  wikiId: string,
  snapshot: SeededFileSnapshot[],
  scenario: CreatableScenario,
): Promise<void> {
  try {
    const reason = normalizeArtifactEditReason(retemplateRevisionReason(scenario));
    for (const file of EDITABLE_ARTIFACT_FILES) {
      const path = wikiArtifactPath(owner, wikiId, file);
      const entry = snapshot.find((item) => item.path === path);
      // Absent from the snapshot at all would be a `seededFilePaths` that no
      // longer covers the editable set — nothing to record, and the seed above
      // did not overwrite anything either.
      if (!entry || entry.content === null) continue;
      try {
        await saveWikiArtifactRevision(owner, wikiId, file, entry.content, owner, reason);
      } catch (error) {
        // PER FILE, so one unwritable history does not skip the next — the same
        // independence `restoreSeededFiles` keeps between its three entries.
        logger.warn(
          "wikis",
          `snapshotting "${file}" before re-templating wiki "${wikiId}" failed — the new template is stored, but the replaced bytes are not in this wiki's history`,
          error,
        );
      }
    }
  } catch (error) {
    // …and once around everything else, so no line in here can turn a committed
    // re-template into a rejected promise.
    logger.warn(
      "wikis",
      `recording the replaced artifacts of wiki "${wikiId}" after re-templating failed — the new template is stored, but this wiki's history did not move`,
      error,
    );
  }
}

/**
 * The marker a failed half-create compensation leaves inside the directory it
 * could not remove: `tenants/<t>/wikis/<id>/.discarded`.
 *
 * THIS FILE IS EVIDENCE, and it is the only evidence {@link sweepOrphans} has
 * that a directory is unclaimed when the registry names nothing at all. Nothing
 * else in the repo writes it — only {@link discardCreatedWikiDirectory}'s catch,
 * for an id `crypto.randomUUID()` minted moments earlier and that no registry
 * entry has ever named. So "this directory carries a tombstone" is a fact about
 * a create that provably failed, not an inference from a registry that may
 * itself be the thing that was lost.
 *
 * Dot-prefixed so the Files tab's dotfile filter (`workbench-files.ts`) hides
 * it, and hung off {@link wikiDirPath} rather than spelled as a literal so it is
 * reclaimed by the same `deleteDirectory` every other per-Wiki byte is.
 *
 * ITS CONTENTS ARE DIAGNOSTIC ONLY — an ISO timestamp, there to tell a human
 * reading the bucket when the failed create happened. {@link sweepOrphans} reads
 * EXISTENCE and nothing else, so the format is free to change and a truncated or
 * empty marker still means exactly what a full one does.
 */
const WIKI_DISCARD_TOMBSTONE = ".discarded";

function wikiDiscardTombstonePath(owner: string, wikiId: string): string {
  return `${wikiDirPath(owner, wikiId)}/${WIKI_DISCARD_TOMBSTONE}`;
}

/**
 * Discard the whole directory a {@link createWiki} was building. NEVER THROWS.
 *
 * Scoped to an id this call just minted with `crypto.randomUUID()`, so it can
 * only ever remove a directory this call created — no other Wiki's directory,
 * and never `wikis.json`, `tenants/<t>/wiki/**` or `tenants/<t>/raw/**`.
 * `deleteDirectory` is a no-op when the directory is absent, so this is also
 * correct when the fault came before the first byte landed.
 *
 * WHEN THE REMOVAL ITSELF FAILS it leaves a {@link WIKI_DISCARD_TOMBSTONE}
 * behind instead, which is what makes those bytes reclaimable on a FIRST create
 * — the case where the tenant's registry still names nothing and
 * {@link sweepOrphans} therefore refuses to treat an unmarked directory as
 * garbage. The tombstone write is best-effort: it warns on failure and never
 * replaces the original diagnosis, because this whole function is compensation
 * and `createWiki` must re-throw what actually broke.
 */
async function discardCreatedWikiDirectory(
  owner: string,
  wikiId: string,
): Promise<void> {
  try {
    await getStorage().deleteDirectory(wikiDirPath(owner, wikiId));
  } catch (error) {
    // ORDER MATTERS, and it is the order of events: the removal failed (which
    // is WHY a tombstone is about to be written), then the marker either landed
    // or did not, and only then can anything true be said about what happens
    // next. Announcing the outcome up front would print a promise this function
    // has not yet earned — and would contradict the failure warn below it.
    logger.warn(
      "wikis",
      `removing the directory of half-created wiki "${wikiId}" failed — no registry entry names it, so its bytes are an orphan`,
      error,
    );
    // The registry never named this id, so the leftovers ARE an orphan — and
    // the tombstone is how the sweep learns that without the registry's help.
    let tombstoned = false;
    try {
      await getStorage().writeFile(
        wikiDiscardTombstonePath(owner, wikiId),
        `${new Date().toISOString()}\n`,
      );
      tombstoned = true;
    } catch (tombstoneError) {
      // Best-effort by design: without the marker the bytes are merely
      // unreclaimable, which is exactly where they were before this existed.
      logger.warn(
        "wikis",
        `marking half-created wiki "${wikiId}" as discarded failed`,
        tombstoneError,
      );
    }
    logger.warn(
      "wikis",
      tombstoned
        ? `half-created wiki "${wikiId}" is marked discarded — the orphan sweep reclaims its directory once the directory is older than the grace window`
        : `half-created wiki "${wikiId}" is NOT marked discarded — its directory stays on disk until this tenant owns a wiki and a sweep runs`,
    );
  }
}

/**
 * Longest `reason` recorded for an artifact edit. Not a validation error — the
 * value is app-supplied (the revert route's own sentence), never typed by a
 * caller — so an over-long one is trimmed rather than refused.
 */
const MAX_ARTIFACT_EDIT_REASON_CHARS = 200;

/**
 * ONE canonical form of an edit `reason`, used for BOTH the revision sidecar and
 * the activity-log details line.
 *
 * Two failures this closes, and both come from the two records being derived
 * independently. (1) `wiki/log.md` is parsed by `readLog`'s
 * `^## \[date\] op \|` line grammar, so a newline inside `reason` would inject a
 * line into the log that the trail reads as STRUCTURE — a log-injection through
 * a field nothing else validates. (2) A whitespace-only `reason` used to be
 * written into the sidecar while `appendToLog` silently dropped it, so history
 * and trail disagreed about whether the edit had a summary at all.
 *
 * Collapsing every whitespace run (newlines included) to a single space, then
 * trimming, then capping, makes the value a single bounded line; an empty result
 * is `undefined`, i.e. ABSENT in both records rather than empty in one.
 */
function normalizeArtifactEditReason(
  reason: string | undefined,
): string | undefined {
  if (typeof reason !== "string") return undefined;
  const collapsed = reason.replace(/\s+/g, " ").trim();
  if (collapsed.length === 0) return undefined;
  // CAPPED BY CODE POINT, not by UTF-16 unit: a plain `slice` can cut between
  // the two halves of a surrogate pair and leave a LONE SURROGATE, which is not
  // valid text — it would be written into the sidecar's JSON and into the
  // tenant-global `wiki/log.md` and read back as a replacement character
  // forever. Spreading the string iterates code points, so the cut can only
  // fall between whole characters.
  return [...collapsed].slice(0, MAX_ARTIFACT_EDIT_REASON_CHARS).join("");
}

/**
 * Move `dataVersion` after a write an already-open Preview cannot otherwise
 * learn about. NEVER THROWS.
 *
 * THE ONE COPY OF A TAIL THIS MODULE CARRIES EIGHT TIMES, ACROSS SEVEN
 * WRITERS. `writeWikiArtifact`, {@link createWiki},
 * {@link applyScenarioTemplate} (twice — its failed-rollback path bumps as
 * well), {@link renameWiki}, {@link deleteWiki},
 * {@link canonicalizeWikiPurpose} and {@link setCurrentWiki} would each
 * otherwise spell the same four lines with one word changed. Eight copies of a
 * fail-soft `try/catch` is eight places for the next one to forget the `catch`,
 * so the shape lives here and the callers supply only the phrase that names
 * what just landed.
 *
 * `after` completes the sentence "the refresh signal did not move after …", so
 * it is a gerund phrase (`creating wiki "…"`), not a noun.
 *
 * CALL IT OUTSIDE `wikis:<tenant>`. `bumpDataVersion` takes
 * `DATA_VERSION_LOCK` and `withFileLock` is not reentrant, so a call from
 * inside a locked body would nest two lock keys in an order nothing else in the
 * repo takes them in. This helper cannot enforce that — only the call sites
 * can, and `workbench-data-version.test.ts` pins each of them.
 *
 * FAIL-SOFT, because every caller has already written its bytes by the time it
 * gets here: a counter that did not move leaves a stale tree, which the next
 * poll or reload fixes, while a rejected call reports a landed write as failed
 * and sends the owner into a retry. (`bumpDataVersion` swallows its own
 * failures today, so this `catch` is redundant defence — kept so the tail stays
 * correct if it ever stops.)
 */
async function bumpRefreshSignal(after: string): Promise<void> {
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn("wikis", `the refresh signal did not move after ${after}`, error);
  }
}

/**
 * Overwrite one seeded artifact — the write half of Story 1.8's Schema editing.
 *
 * WHY THIS IS NOT `writeWikiPageWithSideEffects`. The epic's one-write-path rule
 * exists so index, backlink, cross-reference and embedding side effects cannot
 * be skipped by a second markdown writer. An artifact has NONE of those: it has
 * no slug, no page-index entry, nothing links to it, and it is not embedded.
 * Routing it through the page pipeline would not add those effects — it would
 * MOVE the file into `tenants/<t>/wiki/`, where `readActiveWikiSchema()` does
 * not look and where `reconcileSilos()` would delete it as an unindexed orphan.
 * The two tail effects an artifact genuinely HAS are the activity log and the
 * refresh counter, and this function fires both, so "an artifact write has a
 * tail" is true for every future caller rather than for one route.
 *
 * WHY THE TAIL IS OUTSIDE THE LOCK. `appendToLog` takes `"log.md"` and
 * `bumpDataVersion` takes `DATA_VERSION_LOCK`; holding `wikis:<tenant>` across
 * either would nest two lock keys in an order nothing else in the codebase
 * takes them in. The bytes have already landed by then, which is what makes the
 * two effects fail-soft rather than transactional.
 *
 * READ BEFORE WRITE (DW-59). Before the new bytes land, the current ones are
 * snapshotted into `tenants/<t>/wikis/<id>/revisions/<file>/` — the same
 * read-then-`saveRevision` that has always guarded a page write, for the one
 * artifact that is executable. `reason` is {@link normalizeArtifactEditReason}d
 * ONCE and then recorded in the snapshot's sidecar (with `owner` as the author)
 * AND appended to the log line — one value in two places, which is what makes a
 * revert distinguishable from an edit in the trail without the two records
 * being able to disagree. Both are optional, and an omitted or
 * whitespace-only `reason` reads exactly as this function did before.
 *
 * FAIL-SOFT, in the same shape as the lifecycle pipeline's own tail: a log or
 * counter hiccup is warned about, never surfaced. A save that already reached
 * storage must not be reported as failed — a stale tree is recoverable by the
 * next poll or reload, a rejected save the owner then retypes is not.
 *
 * `file` is the EDITABLE subset, not the seeded set, so the COMPILER carries the
 * allowlist instead of the route being the only thing holding it: a future
 * caller cannot reach `purpose.md` through this function without first widening
 * {@link EditableArtifactFile} — which is also what keeps the log line below
 * honest, since it names the Schema. The seeder writes both artifacts through
 * {@link putWikiArtifact}, which takes the wider type and owns no tail.
 *
 * THE WRITE PRECONDITION LIVES IN HERE (DW-193). A route that checked
 * `If-Match` against its own pre-lock read left a check-to-write gap: two saves
 * carrying the same valid version both passed the check and both landed, the
 * second silently clobbering the first. The mismatch half of the guard
 * therefore moved INSIDE the one `withWikiLock` acquisition this function
 * already makes, above the revision snapshot and above the put, comparing
 * against the bytes it already reads for that snapshot — one read, one critical
 * section, no new lock key and no new ordering.
 *
 * `expectedVersion` is a {@link scopedContentVersion} over `wikiId` and the
 * stored bytes, and it is OPTIONAL: a caller that supplies none writes exactly
 * as this function did before. When one IS supplied, the pre-write read stops
 * being fail-soft — a read that throws refuses the save with its own error
 * rather than being read as "absent", because "absent" would be answered as a
 * conflict and a storage blip is not one. A mismatch (or a genuinely missing
 * file, which matches no version) throws {@link WriteConflictError}, so nothing
 * is written: no snapshot, no bytes, no log line, no `dataVersion` bump.
 *
 * WHY AN OPTIONS OBJECT. `reason` is a free string; a second free string beside
 * it invites the two to be swapped at a call site, silently turning a
 * precondition into a log line. Two named fields cannot be transposed.
 */
export async function writeWikiArtifact(
  owner: string,
  wikiId: string,
  file: EditableArtifactFile,
  content: string,
  options?: {
    /** What the activity log and the snapshot's sidecar say this edit was. */
    reason?: string;
    /**
     * The {@link scopedContentVersion} the caller believes is stored. Supplied
     * → the save is refused with {@link WriteConflictError} unless the bytes
     * read inside the lock still hash to it. Omitted → an unconditional write.
     */
    expectedVersion?: string;
  },
): Promise<void> {
  const { reason, expectedVersion } = options ?? {};
  // Deployment read-only (DW-188), answered BEFORE the lock is taken and before
  // a single byte is read. The Schema is EXECUTABLE at runtime, so a read-only
  // deployment must not rewrite it through any caller — both of today's callers
  // are already-gated routes, which makes this a backstop rather than a
  // behaviour change, and a backstop is exactly what the next caller will need.
  assertWritable(READ_ONLY_REFUSAL.artifactEdit);

  // Normalized ONCE, here, so the sidecar and the log line below cannot record
  // two different sentences for the same edit.
  const editReason = normalizeArtifactEditReason(reason);

  await withWikiLock(owner, async () => {
    // READ BEFORE WRITE (DW-59). The bytes about to be replaced are the
    // owner's previous EXECUTABLE Schema, and this is the only moment they
    // still exist. The snapshot is INSIDE this callback on purpose: the same
    // `wikis:<tenant>` key owns both the artifact and its history, so history
    // and bytes are serialized together without a second lock key — and
    // `saveWikiArtifactRevision` takes none of its own for that reason.
    //
    // TWO CATCHES, NOT ONE, and the split is the whole point. A single
    // `isEnoent`-filtered catch around both halves would silence a
    // NOT-FOUND-shaped failure of the WRITE as well as of the read — and R2's
    // not-found error carries `code = "ENOENT"`, so on that provider a failed
    // revision write would drop the history entry with no warning at all. That
    // is precisely the silent loss this story exists to end. So: the read
    // reports "absent" as `null` ({@link readWikiArtifact} already owns that
    // ENOENT → null shape, which is also why this is not a second raw spelling
    // of the artifact read) and anything else is warned; the snapshot write
    // warns UNCONDITIONALLY, because it has no legitimate absent case.
    //
    // BOTH ARE FAIL-SOFT AS FAR AS HISTORY GOES, in the same spirit as
    // `writeWikiPage`: neither a failed read nor a failed snapshot stops the
    // save, because a save that reaches storage must never be reported as
    // failed merely because history could not be recorded — the alternative
    // loses the owner's new bytes to protect their old ones.
    //
    // WITH ONE EXCEPTION, AND IT IS THE READ (DW-193). This read also serves
    // the PRECONDITION: when `expectedVersion` was supplied these are the bytes
    // the guard compares, read here inside the lock so the fact they establish
    // is still true when `putWikiArtifact` runs a few lines below. Its result
    // is then no longer only history's input, and "the read failed" and "there
    // is nothing there" — the same value to the snapshot, which wants no
    // history entry either way — are OPPOSITE answers to the guard, where
    // `null` means the artifact is gone and the save is refused. So the catch
    // below is conditional: a storage blip must never be reported to the owner
    // as somebody else's save. The SNAPSHOT stays fail-soft unconditionally;
    // only the read changes, and only for a precondition-bearing caller.
    let existing: string | null = null;
    try {
      existing = await readWikiArtifact(owner, wikiId, file);
    } catch (error) {
      if (expectedVersion !== undefined) throw error;
      logger.warn(
        "wikis",
        `reading "${file}" before overwriting it failed — the save proceeds, but the replaced bytes are not in this wiki's history`,
        error,
      );
    }

    // Purpose has one transitional read shape: before the authority marker, a
    // valid profile is projected as the bytes the owner saw. The precondition
    // must compare against THAT effective body, while history still snapshots
    // the raw artifact bytes this save is actually replacing.
    let versionContent = existing;
    let registryToMark: WikiRegistry | null = null;
    let wikiToMark: WikiRecord | null = null;
    if (file === "purpose.md") {
      const registry = await readRegistry(owner);
      const wiki = registry.wikis.find((item) => item.id === wikiId) ?? null;
      if (wiki && wiki.artifactAuthority !== ARTIFACT_AUTHORITY_VERSION) {
        try {
          const evidence = await readWorkspaceProfileEvidence(owner, wikiId);
          if (evidence && workspaceProfileHasGuidance(evidence.profile)) {
            versionContent = renderCanonicalPurposeMarkdown(wiki.name, evidence.profile);
          }
        } catch {
          // The effective reader falls back to raw purpose.md for unusable
          // evidence, so the writer compares against the same raw bytes.
        }
        registryToMark = registry;
        wikiToMark = wiki;
      }
    }

    // THE COMPARISON, above the snapshot and above the put, so a refusal writes
    // NOTHING. The version is scoped by `wikiId` (DW-200): two Wikis seeded
    // from one template hold byte-identical artifacts, and an unscoped token
    // read from one would match the other's file exactly.
    //
    // ONE comparison function, shared with the route that answers the 428 half
    // — neither side re-types the conflict sentence.
    if (expectedVersion !== undefined) {
      const outcome = checkVersionPrecondition(
        expectedVersion,
        versionContent === null
          ? null
          : scopedContentVersion(wikiId, versionContent),
      );
      if (!outcome.ok) {
        // THE OUTCOME IS ASSERTED, NOT COLLAPSED. `checkVersionPrecondition`
        // has a 428 branch for a `null` supplied version, which cannot be
        // reached here — `expectedVersion` is a `string` inside this guard —
        // but throwing `WriteConflictError` for ANY non-ok outcome would pair
        // the 412 status with the 428 sentence if that ever stopped being true.
        // A status and a sentence that disagree is worse than a crash, so the
        // impossible branch is a programmer error with its own name.
        if (outcome.status !== WRITE_CONFLICT_STATUS) {
          throw new Error(
            `writeWikiArtifact: unexpected precondition outcome ${outcome.status} for "${file}"`,
          );
        }
        throw new WriteConflictError(outcome.error);
      }
    }

    // `null` is the FIRST WRITE: there is nothing to snapshot and nothing to
    // warn about.
    if (existing !== null) {
      try {
        await saveWikiArtifactRevision(
          owner,
          wikiId,
          file,
          existing,
          owner,
          editReason,
        );
      } catch (error) {
        logger.warn(
          "wikis",
          `snapshotting "${file}" before overwriting it failed — the save proceeds, but the replaced bytes are not in this wiki's history`,
          error,
        );
      }
    }
    await putWikiArtifact(owner, wikiId, file, content);

    if (registryToMark && wikiToMark) {
      wikiToMark.artifactAuthority = ARTIFACT_AUTHORITY_VERSION;
      try {
        // Marker LAST: only after the canonical bytes landed may profile
        // evidence become permanently non-live.
        await writeRegistry(owner, registryToMark);
      } catch (error) {
        // The marker did not commit, so put the raw artifact back. Effective
        // reads then keep serving the legacy projection and a retry is safe.
        try {
          if (existing === null) {
            await getStorage().deleteFile(wikiArtifactPath(owner, wikiId, file));
          } else {
            await getStorage().writeFile(
              wikiArtifactPath(owner, wikiId, file),
              existing,
            );
          }
        } catch (restoreError) {
          logger.warn(
            "workspace-purpose",
            `restoring purpose.md after its authority marker failed for wiki "${wikiId}"`,
            restoreError,
          );
        }
        throw error;
      }
    }
  });

  try {
    // `wiki/log.md` is tenant-global while `schema.md` is PER WIKI, so the
    // heading alone ("Schema — schema.md") is the same sentence for every Wiki
    // the owner has. The id goes on the details line, where `appendToLog`
    // already puts the entry's payload, so the log can still answer "whose
    // Schema moved" once there is more than one.
    //
    // `reason` rides the SAME line rather than a second entry: a revert is an
    // edit — it snapshots what it replaces and moves the same counter — so what
    // the trail needs is the sentence that tells the two apart, not a new
    // operation the log's readers would have to learn.
    const artifactLabel = file === "purpose.md" ? "Purpose" : "Schema";
    await appendToLog(
      "edit",
      `${artifactLabel} — ${file}`,
      editReason === undefined
        ? `Wiki: ${wikiId}`
        : `Wiki: ${wikiId} · ${editReason}`,
    );
  } catch (error) {
    logger.warn("wikis", `logging the artifact edit of "${file}" failed`, error);
  }
  await bumpRefreshSignal(`editing "${file}"`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Every Wiki in the owner's tenant, oldest first. */
export async function listWikis(owner: string): Promise<WikiRecord[]> {
  return (await readRegistry(owner)).wikis;
}

/** The registry as the UI consumes it: `{ wikis, currentId }`. */
export async function getWikiRegistry(owner: string): Promise<WikiRegistry> {
  return readRegistry(owner);
}

/** The active Wiki, or null when the registry is empty. */
export async function getCurrentWiki(owner: string): Promise<WikiRecord | null> {
  const registry = await readRegistry(owner);
  return registry.wikis.find((wiki) => wiki.id === registry.currentId) ?? null;
}

/**
 * Create a Wiki from a Scenario Template and make it current.
 *
 * `input` is re-parsed here with {@link parseCreateWikiInput} rather than
 * trusted from the route, so a rejected input never reaches the lock and never
 * writes anything — including when a non-route caller skips the parser.
 *
 * The `bumpDataVersion` tail is the same shape {@link writeWikiArtifact} uses,
 * for the same reasons: OUTSIDE the lock, because `bumpDataVersion` takes
 * `DATA_VERSION_LOCK` and `withFileLock` is not reentrant; fail-soft, because a
 * create whose four writes landed must not be reported as failed just because
 * the counter did not move; and only on the success path, because the
 * `discardCreatedWikiDirectory` branch re-throws and there is then nothing new
 * for a client to refresh to.
 */
export async function createWiki(
  owner: string,
  input: CreateWikiInput,
): Promise<WikiRecord> {
  // Deployment read-only (DW-188/DW-266), answered BEFORE the lock and before
  // the registry is read. Ordering matters more here than at a plain writer: a
  // gate placed inside the locked body would sit above `discardCreatedWikiDirectory`,
  // so a refusal would run the compensating `deleteDirectory` on a deployment
  // that is not supposed to touch a byte. `POST /api/wikis` already refuses
  // first, so this is a backstop for a direct library caller — a CLI command, a
  // future MCP tool — reaching the kernel with no route in front.
  assertWritable(READ_ONLY_REFUSAL.wikiCreate);
  const { name, scenario } = parseCreateWikiInput(input);
  const created = await withWikiLock(owner, async (held) => {
    const registry = await readRegistry(owner);
    if (registry.wikis.length >= MAX_WIKIS) {
      throw new ClientInputError(
        `This workspace already has the maximum of ${MAX_WIKIS} wikis.`,
      );
    }
    const now = new Date().toISOString();
    const wiki: WikiRecord = {
      id: crypto.randomUUID(),
      name,
      scenario,
      createdAt: now,
      updatedAt: now,
      artifactAuthority: ARTIFACT_AUTHORITY_VERSION,
    };
    // The cap check above throws BEFORE this point on purpose: it writes
    // nothing, so it must not be inside the compensation.
    try {
      await seedWikiArtifacts(held, owner, wiki, { seedProfile: true });
      registry.wikis.push(wiki);
      registry.currentId = wiki.id;
      await writeRegistry(owner, registry);
    } catch (error) {
      // Any of the four writes may have landed and any may not have. The id is
      // this call's own, and no registry entry names it, so discarding the
      // whole directory is the exact undo — see the compensation block above.
      await discardCreatedWikiDirectory(owner, wiki.id);
      throw error;
    }
    return wiki;
  });

  // Only reached when the locked body committed — the compensation branch above
  // re-throws, so a discarded create never moves the signal.
  await bumpRefreshSignal(`creating wiki "${created.id}"`);
  return created;
}

/**
 * Does the STORED registry record for `wikiId` now name `scenario` (DW-484)?
 *
 * `StorageProvider.writeFile` is specified atomic from the caller's view, but
 * atomic is not all-or-nothing about the THROW: a provider can land the bytes
 * and then fail on the way back — a flush, a close, an ack lost after the
 * object was stored — so a `writeRegistry` that rejected is not by itself proof
 * the registry is still on the old scenario. Reading it back is.
 *
 * {@link readRegistry} rather than the in-memory registry the caller closed
 * over: the locked body mutates `wiki.scenario` in place BEFORE the seed, so
 * that object always shows the new scenario. `readRegistry` re-reads and
 * re-parses `wikis.json`, so it reports what is actually stored.
 *
 * DETECTS, DOES NOT RECONCILE. No `updatedAt` comparison and no re-write: this
 * path's whole job is to decide whether an open Preview must be told, and a
 * repair attempted from inside a failure it is already re-throwing would be a
 * second write nobody asked for.
 *
 * FAIL-SOFT, AND TOWARDS "LANDED". It runs on a path that already holds the
 * diagnosis it owes the caller, so a read that throws must never replace it —
 * and of the two ways to be wrong, claiming the registry moved costs one
 * spurious refetch while claiming it did not leaves a Preview rendering a
 * template the stored record no longer names.
 *
 * SO THE READ HAS THREE ANSWERS, NOT TWO. Finding the record and reading a
 * DIFFERENT scenario is the only one that means "did not land" — it is positive
 * evidence that the old bytes are still there. A record that is ABSENT is not
 * that: {@link readRegistry} turns ENOENT into an empty registry and
 * `normalizeRegistry` silently drops an entry whose shape or scenario no longer
 * parses, so "no record" says the registry stopped naming, inside this very
 * lock, a wiki it named moments ago — unknown, and unknown resolves towards
 * landed like every other uncertainty here. A raw I/O or `JSON.parse` throw is
 * the third, and resolves the same way. Comparing the found record's scenario
 * with `?.` would have collapsed the first two into one and answered "did not
 * land" to the unknown, which is the exact under-signal the paragraph above
 * swears off.
 *
 * A POSITIVE DETECTION WARNS, and says what was OBSERVED rather than what it
 * implies: `wikis.json` naming the requested template after a call that
 * reported failure is also what re-applying a Wiki's CURRENT scenario looks
 * like, so "the restored artifacts MAY describe a different one" is true of
 * both readings and "the registry diverged" is true of only one.
 *
 * Reads `wikis.json` only, which {@link restoreSeededFiles} does not touch, so
 * the caller's `wikis:<tenant>` is enough — no second lock key is taken.
 */
async function registryNamesScenario(
  owner: string,
  wikiId: string,
  scenario: CreatableScenario,
): Promise<boolean> {
  try {
    const registry = await readRegistry(owner);
    const stored = registry.wikis.find((item) => item.id === wikiId);
    if (!stored) {
      logger.warn(
        "wikis",
        `the registry no longer names wiki "${wikiId}" after a re-template that reported failure — treating its bytes as landed`,
      );
      return true;
    }
    // The one answer that is evidence of NOT landing: the record is there and
    // still on the scenario the snapshot belongs to.
    if (stored.scenario !== scenario) return false;
    logger.warn(
      "wikis",
      `the registry names the ${SCENARIO_LABELS[scenario]} Scenario Template for wiki "${wikiId}" after a re-template that reported failure — the restored artifacts may describe a different one`,
    );
    return true;
  } catch (error) {
    logger.warn(
      "wikis",
      `reading the registry back after a failed re-template of wiki "${wikiId}" failed — assuming its bytes landed`,
      error,
    );
    return true;
  }
}

/**
 * What {@link applyScenarioTemplate}'s locked body hands back to its tail.
 *
 * Three exits, and the tail owes each a different thing: `unknown` wrote
 * nothing and answers `null`; `applied` bumps and returns the record; `failed`
 * re-throws `error` unchanged, having first bumped IF AND ONLY IF the disk
 * moved under the reported failure — because the compensation could not put
 * every file back (`rollbackIncomplete`, DW-210), or because the registry write
 * landed before reporting failure (`registryLanded`, DW-484). Private — the
 * shape exists so the bump can sit outside `wikis:<tenant>`, not as an API.
 *
 * TWO BOOLEANS RATHER THAN ONE RENAMED FLAG. They are different observations
 * with different remedies — "a restore entry failed" against "the stored
 * scenario moved under a reported failure" — and collapsing them would lose
 * which one the log line should name. The tail composes ONE reason from
 * whichever fired, so the failure path still bumps at most once.
 *
 * WHAT `registryLanded` PROVES, EXACTLY: that `wikis.json` NOW names the
 * requested scenario. What it deliberately cannot tell that apart from is
 * re-applying a Wiki's CURRENT scenario, where the stored record already named
 * it and the write never ran — over-signalling, the same side of the trade the
 * DW-210 paragraphs below argue for. The canvas keeps the OWNER off that path
 * with `confirmDisabled={pendingScenario === current?.scenario}`, but that is a
 * client-side courtesy, not a gate: `POST /api/wikis/[id]/template` parses the
 * scenario and nothing more, and a library or MCP caller has no guard at all,
 * so a direct re-apply that then fails does take this branch. It costs the same
 * one spurious refetch of bytes that did not change.
 */
type RetemplateOutcome =
  | { kind: "unknown" }
  | { kind: "applied"; wiki: WikiRecord }
  | {
      kind: "failed";
      error: unknown;
      rollbackIncomplete: boolean;
      registryLanded: boolean;
    };

/**
 * Apply a different Scenario Template to an existing Wiki.
 *
 * Confirm-gated in the UI because it overwrites `purpose.md`, `schema.md`, and
 * THIS Wiki's own `workspace-profile.json`. Every other Wiki's profile — and
 * Pages and Sources — are untouched. Returns null when the id is unknown, so
 * the route can answer 404.
 *
 * WHY THE TAIL MATTERS MOST HERE. A re-apply moves no selection, no mode and no
 * tree tab, so `dataVersion` is the ONLY thing that can tell an already-open
 * Preview its `purpose.md` or `schema.md` bytes are stale — the fetch effect is
 * keyed on `[selection, dataVersion, editing]`, and a re-apply would otherwise
 * touch none of the three. Without the bump a READING Preview goes on showing
 * the old template's bytes until the owner reselects the row or reloads.
 *
 * WHAT THE BUMP DOES NOT DO. A Preview with an unsaved draft is deliberately
 * NOT refetched: `previewFetchPlan` answers `{fetch:false}` while `editing`, so
 * the bump is deferred to when the editor closes and the draft is never taken
 * from the owner. What stops that draft being saved over the new template is
 * the If-Match write precondition (DW-38), which answers 412 — not this tail.
 *
 * The tail is outside the lock, fail-soft, and skipped on the empty-handed
 * path: the unknown-id `null` writes nothing, so there is nothing to refresh to.
 *
 * THE FAILURE PATH BUMPS TOO, BUT ONLY WHEN THE ROLLBACK WAS INCOMPLETE
 * (DW-210). {@link restoreSeededFiles} is fail-soft PER ENTRY, so a restore
 * that cannot write one of the three files can leave NEW template bytes on disk
 * under a call that reports failure — the one state where a re-template both
 * changed what a Preview renders and told nobody. It now answers whether every
 * entry went back, and an incomplete answer earns the same bump a success does
 * before the original error is re-thrown. A CLEAN rollback still bumps nothing:
 * the old bytes are back, so a refetch would be churn.
 *
 * WHAT THE FLAG PROVES, EXACTLY: that at least one restore entry FAILED — not
 * that the disk diverged. A seed that faulted on its first write leaves the
 * later files untouched, so the entry whose restore then failed would have
 * rewritten identical bytes and nothing moved. Deliberately the safe way round:
 * over-signalling costs one spurious refetch of bytes that did not change,
 * under-signalling leaves a Preview rendering a template the owner never
 * applied. "A restore entry failed" is the strongest thing this path can
 * cheaply know, and it is the side of the trade to be wrong on.
 *
 * AND WHEN THE REGISTRY WRITE ITSELF LANDED (DW-484). That flag answers for the
 * FILES alone, which left the compensation's other assumption unchecked: that a
 * `writeRegistry` which threw never stored its bytes. A provider may land the
 * object and still fail on the way back, and the stored record would then name
 * the NEW scenario while the restored artifacts describe the old one — a
 * re-template that moved what the tree and the guidance report and, before
 * this, told nobody. So the `catch` reads `wikis.json` back
 * ({@link registryNamesScenario}) and carries that as a SECOND fact.
 *
 * ONE BUMP, EITHER FACT. The tail fires when `rollbackIncomplete` OR
 * `registryLanded` is true and names whichever fired in the one reason it
 * passes, so the failure path keeps exactly one call site — a clean rollback
 * whose registry write did not land still bumps nothing, because the old bytes
 * are back and the stored record never moved.
 *
 * Both flags are carried OUT of the locked callback rather than bumped inside
 * it, for the reason the success tail is outside:
 * `bumpDataVersion` takes `DATA_VERSION_LOCK` and `withFileLock` is not
 * reentrant. The read-back itself stays INSIDE — it reads `wikis.json`, which
 * this callback's own lock already covers and the restore does not touch.
 */
export async function applyScenarioTemplate(
  owner: string,
  wikiId: string,
  scenario: CreatableScenario,
): Promise<WikiRecord | null> {
  // Before the lock, before `snapshotSeededFiles` and therefore before
  // `restoreSeededFiles` could ever run (DW-266). A re-template is the most
  // destructive operation in this module — it overwrites files the owner may
  // have edited — so a read-only deployment must not even take the snapshot.
  // `POST /api/wikis/[id]/template` already refuses first.
  assertWritable(READ_ONLY_REFUSAL.wikiTemplate);
  if (!isCreatableScenario(scenario)) {
    throw new ClientInputError("Choose one Scenario Template.");
  }
  // WHY THE LOCKED BODY RETURNS THE FAILURE INSTEAD OF THROWING IT. The bump
  // the compensation path now owes (DW-210) has to run OUTSIDE `wikis:<tenant>`
  // like every other tail in this module, so the one fact only the `catch`
  // knows — whether `restoreSeededFiles` put every file back — has to reach the
  // post-lock scope. Carrying it out as a value keeps the error itself
  // untouched: it is re-thrown below, unwrapped and unreplaced, exactly as a
  // caller saw it before.
  const outcome = await withWikiLock(owner, async (held): Promise<RetemplateOutcome> => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return { kind: "unknown" };
    // Snapshot BEFORE the first overwrite. The in-memory mutation below needs
    // no undo — the registry is re-read on every call, so a failed write simply
    // leaves the stored `scenario` where it was; the FILES are what persist.
    const snapshot = await snapshotSeededFiles(owner, wiki.id);
    wiki.scenario = scenario;
    wiki.updatedAt = new Date().toISOString();
    // The registry write below is the semantic commit. Until it lands, an old
    // unmarked Wiki still resolves its valid legacy profile as effective.
    wiki.artifactAuthority = ARTIFACT_AUTHORITY_VERSION;
    // Set IMMEDIATELY BEFORE the write, so a throw from the write itself still
    // counts as attempted while a seed that faulted first does not. Control
    // flow answers this exactly — it is not a heuristic about which error came
    // back — and most failures here are seed faults, which reach the `catch`
    // with `writeRegistry` never called and therefore nothing to read back.
    let registryWriteAttempted = false;
    try {
      // Re-template replaces the two canonical artifacts and leaves the legacy
      // profile bytes untouched as rollback evidence. The marker makes those
      // bytes permanently non-live once the registry write commits.
      await seedWikiArtifacts(held, owner, wiki, { seedProfile: false });
      registryWriteAttempted = true;
      await writeRegistry(owner, registry);
    } catch (error) {
      // What makes "put the old artifacts back" the correct undo rather than a
      // guess: `StorageProvider.writeFile` is SPECIFIED atomic from the
      // caller's view (`storage/types.ts`), so a throw from the registry write
      // means those bytes never landed and the stored `scenario` is still the
      // old one the snapshot belongs to.
      //
      // Both providers honour that contract: R2 does a single-object PUT and
      // `FilesystemStorageProvider` writes a sibling tmp file and renames it
      // over the destination (DW-161), so no write this compensation reasons
      // about can leave a truncated file it would restore around. What the
      // contract still does not promise is durability of the newest bytes
      // across a power loss — but that leaves the PREVIOUS whole file, which is
      // exactly the state this branch already handles.
      //
      // A restore that could not put EVERY file back leaves some of the new
      // template's bytes on disk under a call that reports failure — the one
      // state where a re-template changed what a Preview renders and told
      // nobody (DW-210). That is the flag; the compensation itself is
      // unchanged, still fail-soft per entry and still attempting all three.
      const rollbackIncomplete = !(await restoreSeededFiles(snapshot));
      // …and the atomicity the paragraph above leans on is a claim about the
      // FILE, not about the throw: bytes that landed can still be followed by a
      // rejection (DW-484). So the other half of "did the disk move" is read,
      // not assumed — after the restore, because the restore does not touch
      // `wikis.json` and the answer is the same either side of it.
      //
      // Guarded by the flag rather than asked unconditionally: a read-back on a
      // seed fault would be a read nobody needs, and — because the helper
      // resolves every uncertainty towards "landed" — could answer "landed" and
      // put "a registry write that landed" in the log for a write that was
      // never issued.
      const registryLanded =
        registryWriteAttempted && (await registryNamesScenario(owner, wikiId, scenario));
      return { kind: "failed", error, rollbackIncomplete, registryLanded };
    }
    // COMMITTED — the seed and the registry write both landed, so the bytes the
    // snapshot above holds are gone from the artifact path for good unless they
    // are recorded now (DW-213). Inside the lock this callback already holds,
    // after the `try/catch` so it runs on the committed path ONLY, and fail-soft
    // so a history miss cannot turn a stored re-template into a reported
    // failure. The `catch` keeps `restoreSeededFiles` as its only compensation.
    await recordRetemplatedArtifacts(owner, wiki.id, snapshot, scenario);
    return { kind: "applied", wiki };
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (outcome.kind === "unknown") return null;
  if (outcome.kind === "failed") {
    // A CLEAN rollback whose registry write did not land bumps nothing: the old
    // bytes are back and the stored record never moved, so telling an open
    // Preview to refetch would be churn. Either other fact earns the same
    // fail-soft tail a success does, because the disk really did move — and the
    // reason names whichever fired, so the log line says which remedy applies.
    const moved = [
      outcome.rollbackIncomplete ? "an incomplete rollback" : null,
      outcome.registryLanded ? "a registry write that landed" : null,
    ].filter((fact): fact is string => fact !== null);
    if (moved.length > 0) {
      await bumpRefreshSignal(
        `${moved.join(" and ")} under the failed re-template of wiki "${wikiId}"`,
      );
    }
    // The original diagnosis, unwrapped and unreplaced.
    throw outcome.error;
  }
  await bumpRefreshSignal(`re-templating wiki "${outcome.wiki.id}"`);
  return outcome.wiki;
}

/**
 * Point `current` at an existing Wiki. Returns null when the id is unknown.
 *
 * NON-DESTRUCTIVE, and that is the whole point: `wikis.json` is the ONLY
 * tenant file this writes. A switch used to re-seed a tenant-global profile
 * from the newly active Wiki's template, which silently discarded whatever the
 * owner had authored in Settings; there is nothing left here to discard.
 *
 * IT DOES BUMP `dataVersion` (DW-518, implementing DW-429's recorded
 * decision), the same fail-soft tail {@link renameWiki} and
 * {@link deleteWiki} carry. Writing one tenant file is not the same as writing
 * nothing a Preview renders: the Workbench resolves every artifact THROUGH the
 * `current` pointer, so moving it changes what each `purpose.md`/`schema.md`
 * read ANSWERS without changing an artifact byte. The switcher's own
 * `router.refresh()` reaches only the tab that drove the switch, which leaves
 * the counter as the ONLY thing that can tell ANOTHER open tab — or any
 * surface not keyed on that refresh — that its reads now resolve against a
 * different Wiki.
 *
 * The tail is OUTSIDE the lock (`bumpDataVersion` takes `DATA_VERSION_LOCK` and
 * `withFileLock` is not reentrant, so a bump inside the locked body would nest
 * two lock keys), fail-soft (`wikis.json` is already written by the time it
 * runs, so a counter that did not move must never turn a landed switch into a
 * rejected one), and fires only when the locked body returned a record — an
 * unknown id writes nothing, and a read-only refusal throws before the lock.
 *
 * A SWITCH TO THE WIKI THAT IS ALREADY CURRENT still writes `wikis.json` and
 * still bumps — the same shape {@link renameWiki} has, which bumps a rename to
 * the name the Wiki already had. The switching tab therefore takes one
 * `DataVersionWatcher` refresh on top of `WikiSwitcher`'s own
 * `router.refresh()`. That is ACCEPTED, not short-circuited: the counter is
 * monotonic and every consumer is forward-only, so a redundant forward move
 * costs one render and can never produce a wrong answer, while a short-circuit
 * would add a second registry-state branch to a path whose whole value is
 * being trivial.
 *
 * WHAT THIS FIXES, EXACTLY. The profile is per-Wiki and lives beside that
 * Wiki's `schema.md`, so the profile `buildWorkspaceGuidance(owner)` renders
 * and the `schema.md` `loadPageConventions()` reads can no longer come from two
 * DIFFERENT Wikis. It does NOT make them agree: within one Wiki, a Settings
 * save can set `scenario: "custom"` while `schema.md` still spells out
 * Business, and nothing here reconciles the two representations. Story 1.8 owns
 * that; a Settings edit still does not rewrite `schema.md`.
 */
export async function setCurrentWiki(
  owner: string,
  wikiId: string,
): Promise<WikiRecord | null> {
  // Deployment read-only (DW-314), BEFORE the lock and before the registry is
  // read. `wikis.json` is the only tenant file a switch writes, and that is
  // exactly why it is gated: which Wiki is current decides which `schema.md`
  // executes in every ingest, chat and lint prompt, so a switch is a change to
  // what the whole workspace runs on. `PUT /api/wikis/current` already refuses
  // first, so this is the backstop for a direct library caller.
  assertWritable(READ_ONLY_REFUSAL.wikiSwitch);
  const switched = await withWikiLock(owner, async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    registry.currentId = wiki.id;
    await writeRegistry(owner, registry);
    return wiki;
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!switched) return null;
  await bumpRefreshSignal(`switching to wiki "${switched.id}"`);
  return switched;
}

/**
 * Retitle a renamed Wiki's `purpose.md` — the artifact half of {@link renameWiki}.
 *
 * UNLOCKED, like {@link putWikiArtifact}: the caller is already holding
 * `wikis:<tenant>`. Deliberately NOT `writeWikiArtifact`, which would take that
 * key again (deadlock) and fire an activity-log line naming a Schema edit this
 * is not.
 *
 * NO `dataVersion` BUMP HERE, but the rename does carry one: {@link renameWiki}
 * bumps once at its own tail, outside the lock, after this returns (DW-209) —
 * the same shape {@link createWiki} and {@link applyScenarioTemplate} grew in
 * DW-49. Putting it here instead would be wrong twice over: this runs INSIDE
 * `wikis:<tenant>`, where taking `DATA_VERSION_LOCK` would nest two keys; and a
 * fail-soft retitle would then skip the bump on exactly the path where the
 * registry name moved and the heading did not, which is when an open Preview
 * most needs telling.
 *
 * FAIL-SOFT, and that is the whole design of it. The registry is what the
 * switcher, the workbench heading and every id lookup read; `purpose.md`'s
 * heading is prose. A Wiki with a missing or hand-edited purpose file must
 * still be renameable, so a surprise here is warned about and the rename
 * stands. Only a LEADING `# …` line is replaced — anything else is left exactly
 * as the owner wrote it rather than guessed at.
 *
 * WHICH IS ALSO WHY THE READ-ONLY GATE IS NOT HERE. This catch would swallow
 * the `ReadOnlyError` {@link putWikiArtifact} raises, leaving a rename that had
 * already written `wikis.json` reporting success on a deployment that refuses
 * writes. {@link renameWiki} therefore refuses at its own entry, before the
 * lock — which is what keeps that swallow unreachable rather than merely
 * unlikely (DW-266).
 */
async function retitlePurpose(
  owner: string,
  wikiId: string,
  name: string,
): Promise<void> {
  try {
    const purpose = await readWikiArtifact(owner, wikiId, "purpose.md");
    if (purpose === null) {
      logger.warn(
        "wikis",
        `renamed wiki "${wikiId}" has no purpose.md to retitle — the registry name is the rename`,
      );
      return;
    }
    const lines = purpose.split("\n");
    if (!/^#\s+/.test(lines[0] ?? "")) {
      logger.warn(
        "wikis",
        `purpose.md for wiki "${wikiId}" does not open with a "# " heading — leaving the file untouched`,
      );
      return;
    }
    lines[0] = `# ${name}`;
    await putWikiArtifact(owner, wikiId, "purpose.md", lines.join("\n"));
  } catch (error) {
    logger.warn("wikis", `retitling purpose.md for wiki "${wikiId}" failed`, error);
  }
}

/**
 * Rename a Wiki: the registry entry, and the `# <name>` heading `purpose.md`
 * was seeded with. Returns null when the id is unknown, so the route can 404.
 *
 * `name` is re-parsed here with {@link parseWikiName} rather than trusted from
 * the route, so a rejected name never reaches the lock and never writes
 * anything. Nothing else moves: the Scenario Template, the Schema, the
 * workspace profile, Pages and Sources are all untouched — a rename is a label
 * change, not a re-seed.
 *
 * IT DOES BUMP `dataVersion` (DW-209), the same tail {@link createWiki} and
 * {@link applyScenarioTemplate} carry. A rename changes no `currentWikiId`, so
 * the Workbench's selection-reset effect does not fire, and the Preview's fetch
 * is keyed on `[selection, dataVersion, editing]` — which leaves the counter as
 * the ONLY thing that can tell a Preview left open on `purpose.md` its heading
 * moved. Without it the stale heading stands until the owner reselects or
 * reloads.
 *
 * The tail is OUTSIDE the lock (`bumpDataVersion` takes `DATA_VERSION_LOCK` and
 * `withFileLock` is not reentrant), fail-soft (a rename whose registry write
 * landed must not be reported as failed because the counter did not move), and
 * fires only when the locked body returned a record — an unknown id writes
 * nothing, and a rejected name throws before the lock.
 *
 * It bumps even when {@link retitlePurpose} failed: the registry name has moved,
 * and that name is what the switcher and the Workbench heading render, so there
 * is genuinely something new to refetch.
 */
export async function renameWiki(
  owner: string,
  wikiId: string,
  name: string,
): Promise<WikiRecord | null> {
  // Before the lock and before the registry write (DW-266). This gate is what
  // makes the refusal REACHABLE at all: {@link retitlePurpose} below is
  // fail-soft by design, so the `ReadOnlyError` `putWikiArtifact` would raise
  // inside it is warned about and swallowed — a rename gated only at the putter
  // would still rewrite `wikis.json` and then report success.
  // `PATCH /api/wikis/[id]` already refuses first.
  assertWritable(READ_ONLY_REFUSAL.wikiRename);
  const parsed = parseWikiName(name);
  const renamed = await withWikiLock(owner, async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    wiki.name = parsed;
    wiki.updatedAt = new Date().toISOString();
    await writeRegistry(owner, registry);
    await retitlePurpose(owner, wiki.id, parsed);
    return wiki;
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!renamed) return null;
  await bumpRefreshSignal(`renaming wiki "${renamed.id}"`);
  return renamed;
}

/**
 * How long a candidate directory's newest write must have been sitting still
 * before {@link sweepOrphans} will remove it. Fifteen minutes.
 *
 * WHY A WINDOW AT ALL: `withFileLock` is in-process only, so on a multi-isolate
 * deployment the lock isolate A holds while it seeds `wikis/<id>/` is invisible
 * to isolate B. B reads a registry that does not yet name the id — because A has
 * not reached `writeRegistry` — and, without this, would delete the bytes A is
 * still writing. That is byte removal, not a lost entry, and no retry recovers
 * it.
 *
 * WHY MTIME AND NOT A LOCK: {@link createWiki} seeds the directory BEFORE it
 * pushes the registry entry, so an in-flight create's directory always carries
 * writes from seconds ago. Anything that has been untouched for minutes is
 * therefore not a create in progress. This is a safety margin over the gap
 * between the seed and the registry write, generously sized for a slow or
 * suspended isolate; it does not pretend to be a cross-process lock, and a
 * pause longer than the window would still lose the race. Trading a bounded
 * delay in reclaiming dead bytes for that margin is the right way round: the
 * bytes cost storage, the race costs a Wiki.
 */
export const ORPHAN_SWEEP_GRACE_MS = 15 * 60 * 1000;

/**
 * How many candidate directories one {@link sweepOrphans} pass will consider.
 *
 * A COST AND BLAST-RADIUS BOUND, NOT A CORRECTNESS GUARD, in the same spirit as
 * every other block in `POST /api/tasks/scan`, each of which bounds its own work
 * — `DEFAULT_MAINTENANCE_CAP` (10), `.slice(0, 25)` on the due-agent and
 * monitor lists, `listDueOutboxEvents(…, 50)`. The sweep walks, stats and
 * deletes each candidate while HOLDING `wikis:<tenant>`, so every create, rename
 * and delete for that tenant queues behind it; without a cap the length of that
 * queue is set by however many orphan directories happen to exist. There is no
 * single right number — those three siblings disagree by 5×. 25 is the middle
 * one and the one the neighbouring per-request `.slice(0, 25)` blocks already
 * use, which against a population bounded in practice by {@link MAX_WIKIS} (100)
 * and by orphans being rare costs nothing in the healthy case and caps the
 * pathological one.
 *
 * WHY NO CURSOR: removal IS the progress. A reclaimed directory is gone from the
 * next pass's `listFiles`, so the next scheduled tick starts on the remainder
 * with no resume state to persist, corrupt or reconcile.
 *
 * THE RESIDUAL, AND WHAT ROTATION DOES ABOUT IT (DW-383): a candidate that is
 * SKIPPED rather than removed is still listed next pass and still occupies a
 * slot. That is only the AGE skips — too young, an age that could not be read,
 * or a write dated in the future — because the tombstone probe is resolved
 * BEFORE the cap, so an untombstoned directory against a lost registry never
 * reaches it. The young case is self-clearing by construction; the other two
 * are not, and a cap that always took the SAME head of the list meant a large
 * enough set of permanently unsweepable directories starved everything sorting
 * behind them forever. {@link rotatingSweepWindow} is the answer: the window
 * still holds at most this many, but WHICH ones advances by exactly this many
 * per UTC day, so every candidate is reached within `ceil(n / cap)` days.
 */
export const ORPHAN_SWEEP_CANDIDATE_CAP = 25;

/**
 * One UTC day, the period {@link rotatingSweepWindow} advances on.
 *
 * NOT {@link ORPHAN_SWEEP_GRACE_MS}, and the difference is the whole design.
 * Grace is a delete-age gate measured against one directory's mtime; this is a
 * rotation clock shared by every caller of the sweep, and the two answer
 * different questions. Keying rotation on a 15-minute bucket would make the
 * window depend on how often the caller happens to sample the clock, and — with
 * the deployed cron at one tick a day — advance it 96 buckets per pass, where
 * `gcd(96 * cap, n)` can exceed `cap` and freeze the window on a subset of the
 * list forever (at `n = MAX_WIKIS`, exactly the pathological population the cap
 * exists for). A day is the deployed cadence, so one scheduled tick is one
 * step; and any caller sampling more often than daily simply sees the SAME
 * window twice, which is the correct answer for `deleteWiki` running twice in a
 * minute.
 *
 * Exported for the same reason {@link ORPHAN_SWEEP_GRACE_MS} and
 * {@link ORPHAN_SWEEP_CANDIDATE_CAP} are: the suite advances a fake clock by
 * exactly this period, and a hardcoded `86_400_000` there would go on passing
 * against a rotation keyed on something else entirely.
 */
export const ORPHAN_SWEEP_ROTATION_MS = 86_400_000;

/**
 * At most {@link ORPHAN_SWEEP_CANDIDATE_CAP} of `names`, rotating once per UTC
 * day. Stateless — no cursor is persisted, read or reconciled.
 *
 * SORTED FIRST, because `listFiles` order is not a storage contract: the
 * filesystem provider hands back whatever `readdir` gives and R2 paginates by
 * key, so an unsorted rotation would step through an order that can change
 * between passes and could revisit the same subset indefinitely. Sorting makes
 * "advance by `cap`" mean the same thing on every pass.
 *
 * BY CODE UNIT, NOT BY `localeCompare`. The order has to be identical on every
 * isolate that sweeps this tenant, and `localeCompare` with no locale argument
 * is ICU collation keyed on the RUNTIME's default locale — two isolates
 * configured differently would take different windows on the same UTC day, so
 * "advance by `cap`" would stop meaning one thing. It also disagrees with the
 * byte order the paragraph above reasons about: {@link WIKI_ID_RE} accepts
 * uppercase hex, and `"BBBB…"` sorts BEFORE `"aaaa…"` by code unit and AFTER it
 * under collation. A plain `<`/`>` comparator is the deterministic one, and it
 * is the one that matches what a provider listing by key would hand back.
 *
 * `start` is `(day * cap) % n`, so the window advances by exactly `cap` per day
 * and wraps; two passes on the SAME UTC day see the same window, which is what
 * keeps repeated deletes in one afternoon from re-shuffling the work. When the
 * list fits the cap there is nothing to rotate and every name is returned, so
 * this is a no-op for every healthy tenant.
 */
function rotatingSweepWindow(names: string[], now: number): string[] {
  const sorted = [...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  if (sorted.length <= ORPHAN_SWEEP_CANDIDATE_CAP) return sorted;
  const day = Math.floor(now / ORPHAN_SWEEP_ROTATION_MS);
  const start = (day * ORPHAN_SWEEP_CANDIDATE_CAP) % sorted.length;
  return Array.from(
    { length: ORPHAN_SWEEP_CANDIDATE_CAP },
    (_, offset) => sorted[(start + offset) % sorted.length],
  );
}

/**
 * The most recent write anywhere under `dir`, in epoch millis — or NULL when
 * that cannot be established.
 *
 * `FileEntry` carries no mtime and R2 has no directory objects, so age has to
 * come from `stat` per FILE; the directory's own `stat` is only a fallback for
 * the filesystem provider, where an empty or file-less directory still has one.
 * The walk recurses (a Wiki directory holds `revisions/<file>/<name>`), and one
 * unreadable descendant poisons the whole answer rather than being skipped:
 * this value gates a delete, so "the newest write I could see" must never be
 * mistaken for "the newest write there is". THE DEPTH BOUND OBEYS THAT RULE TOO
 * — exceeding it throws rather than returning, because a truncated walk that
 * reported the shallow mtime it did see could age-qualify a directory whose
 * deeper, newer writes it never looked at.
 */
async function newestWriteTime(dir: string): Promise<number | null> {
  const storage = getStorage();
  let newest: number | null = null;
  const walk = async (prefix: string, depth: number): Promise<void> => {
    // `revisions/<file>/<name>` is the deepest shape a Wiki directory has; the
    // bound is belt-and-braces against a provider that reports a cycle. Deeper
    // than that is UNKNOWN, not empty — the outer catch turns this into null.
    if (depth > 4) {
      throw new Error(`wiki directory "${dir}" is nested deeper than expected`);
    }
    for (const entry of await storage.listFiles(prefix)) {
      const child = `${prefix}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(child, depth + 1);
        continue;
      }
      const at = (await storage.stat(child)).lastModified.getTime();
      if (Number.isFinite(at) && (newest === null || at > newest)) newest = at;
    }
  };
  try {
    await walk(dir, 0);
    if (newest !== null) return newest;
    // No files: on the filesystem provider the directory itself still has an
    // mtime; on R2 there is no such object and this throws → unknown → skip.
    const at = (await storage.stat(dir)).lastModified.getTime();
    return Number.isFinite(at) ? at : null;
  } catch (error) {
    logger.warn(
      "wikis",
      `could not read the age of wiki directory "${dir}" — treating it as too young to sweep`,
      error,
    );
    return null;
  }
}

/** Per-pass options for {@link sweepOrphans}. */
interface SweepOrphansOptions {
  /**
   * True only for {@link sweepOrphanWikiDirectories}, the cron entry point.
   * `deleteWiki`'s inline sweep leaves it unset, which is what keeps the
   * tombstone reclaim off a user-facing request path.
   */
  scheduled?: boolean;
}

/**
 * Future-dated orphan directories already reported, keyed `${owner}/${name}`
 * and holding the future instant the warn NAMED (DW-483).
 *
 * The warn this backs is STANDING STATE, not an event: a directory dated past
 * the horizon can never age out on its own, so the condition holds until the
 * wall clock catches up — months, for a restored archive — while the scheduled
 * sweep re-reaches the same directory on every cron tick. Emitted per candidate
 * per pass, that is precisely the noise the `tombstonedOnly` warn a few lines
 * below is keyed against; emitted once per FACT it is one line an operator can
 * act on.
 *
 * A MAP, NOT A SET, AND KEYED ON THE DIRECTORY RATHER THAN THE OBSERVATION. The
 * sentence names the date, so a directory whose newest write moves to a
 * DIFFERENT future instant is a different fact and gets said again — which is
 * the rule `config.ts` states (the key is the identity AND the value, because
 * the sentence names the value), applied here to a value that is unbounded.
 * Folding the instant into the key would say the same things, but a churning
 * mtime would then grow the collection without limit; carried as a VALUE, a
 * directory costs one entry however often its mtime moves.
 *
 * WHAT ACTUALLY BOUNDS IT IS THE PRUNE, not that shape. One entry per directory
 * is still unbounded over an isolate's life, because a directory STOPS being an
 * orphan — reclaimed by this sweep, deleted out of band, or claimed again by a
 * restored `wikis.json` — and then falls out of `found` and is never revisited,
 * so nothing here would look at its key again.
 * {@link pruneFutureDatedWarnings} runs on every pass of both callers, and
 * leaves at most one entry per directory the last pass for that owner actually
 * listed as an orphan.
 *
 * AND "ONCE" MEANS ONCE PER ISOLATE, not once ever. This is module state: a
 * recycled isolate starts empty and says every standing fact again — the same
 * assumption the sweep's other comments make about isolates coming and going.
 * That is precisely the bound `config.ts` and `embeddings.ts` accept for their
 * warn-once records, and it is the right one here: the alternative is persisting
 * operator-log bookkeeping to storage, a write per pass to save a line the
 * operator otherwise sees once per deploy.
 */
const reportedFutureDatedWrites = new Map<string, number>();

/** `reportedFutureDatedWrites`' key: one directory of one tenant. */
function futureDatedKey(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/**
 * Emit the future-dated skip the first time this directory is seen at this
 * instant; a later pass reading the SAME newest write is silent.
 *
 * Mirrors `warnOnceAbout` in `src/lib/config.ts` and `src/lib/embeddings.ts` —
 * one module-level collection, one emitter, one `@internal` reset. The sentence
 * is byte-identical to the one DW-290 landed, because that is what the operator
 * reading logs and the rows asserting it both match on.
 */
function warnOnceAboutFutureDatedWrite(
  owner: string,
  name: string,
  newest: number,
): void {
  const key = futureDatedKey(owner, name);
  if (reportedFutureDatedWrites.get(key) === newest) return;
  reportedFutureDatedWrites.set(key, newest);
  logger.warn(
    "wikis",
    `skipped orphaned wiki directory "${name}": its newest write is dated ${new Date(
      newest,
    ).toISOString()}, further into the future than the ${
      ORPHAN_SWEEP_GRACE_MS / 60_000
    }-minute grace window allows for clock skew — its bytes stay until the clock passes that date`,
  );
}

/**
 * Forget `name`, so the next future-dated read of it speaks again.
 *
 * The counterpart `config.ts` has no use for and `embeddings.ts` does: this
 * caller can see EVIDENCE the condition ended from inside the process. A pass
 * that reads an age AT OR BEFORE the horizon has watched the skew clear — and
 * it cleared whether the directory then aged out and was reclaimed or is merely
 * young, which is why the re-arm sits before the age gate rather than on either
 * branch under it.
 *
 * AN UNREADABLE AGE IS NOT THAT EVIDENCE. `null` is "I could not look", the
 * same non-answer that refuses to authorise a delete; treating it as the skew
 * ending would re-arm on exactly the passes that learned nothing, and the next
 * readable future date would then repeat a line the operator already has. So
 * `null` neither warns nor re-arms and the record is left exactly as it was.
 * Deleting a key that was never set is a silent no-op, so the call site re-arms
 * unconditionally without first asking whether it ever warned.
 */
function rearmFutureDatedWarning(owner: string, name: string): void {
  reportedFutureDatedWrites.delete(futureDatedKey(owner, name));
}

/**
 * Forget every directory of `owner` that `found` no longer lists as an orphan.
 *
 * The eviction that makes the record's size a property of the tenant rather
 * than of the isolate's uptime. {@link rearmFutureDatedWarning} only ever fires
 * for a directory the pass REACHED, and a reached directory is one this pass
 * still calls an orphan; the keys that leak are the ones for directories that
 * quietly stopped being candidates between passes, which no per-candidate hook
 * can see. Running over `found` — the pre-tombstone, pre-cap orphan list — is
 * what does see them: anything absent from it is, by this pass's own reading,
 * not a directory the future-dated sentence can be true of.
 *
 * DELIBERATELY OVER `found` RATHER THAN `candidates`. The cap means most passes
 * reach only a window of the list, so pruning against what was WALKED would
 * evict every entry outside today's window and re-warn the whole tail tomorrow —
 * turning the per-day rotation into the per-pass repetition DW-483 removed.
 *
 * Other owners' keys are left alone: this is a per-tenant pass, and it has
 * observed nothing about any other tenant's directories.
 */
function pruneFutureDatedWarnings(owner: string, found: string[]): void {
  if (reportedFutureDatedWrites.size === 0) return;
  const orphaned = new Set(found);
  const prefix = `${owner}/`;
  for (const key of reportedFutureDatedWrites.keys()) {
    if (!key.startsWith(prefix)) continue;
    if (!orphaned.has(key.slice(prefix.length))) {
      reportedFutureDatedWrites.delete(key);
    }
  }
}

/**
 * Forget every reported future-dated directory so the next pass warns again.
 *
 * Mirrors `_resetConfigWarnings`/`_resetEmbeddingWarnings`: without it the first
 * row to assert this warning would silence it for every row after, and the
 * warn-once COUNT is exactly what those rows are about. There is no central
 * reset registry in `vitest.setup.ts`, so it is wired into the `beforeEach` of
 * the suite that asserts it, beside `_resetLocks` and `_resetStorage`.
 * @internal
 */
export function _resetWikiSweepWarnings(): void {
  reportedFutureDatedWrites.clear();
}

/**
 * Remove one orphaned `wikis/<uuid>/` directory per entry that no registry
 * record claims. Returns how many were removed.
 *
 * UNLOCKED — the caller holds `wikis:<tenant>`. `registry` is passed in rather
 * than re-read so {@link deleteWiki} sweeps against the registry it has just
 * WRITTEN; re-reading would be a second round trip that can only be staler.
 *
 * ONLY directories whose name is a Wiki id and which the registry does not
 * name are removed. A loose file under `tenants/<t>/wikis/`, or a directory
 * with any other shape of name, is left alone — a future sibling there must
 * not become collateral damage of a delete.
 *
 * NOTHING YOUNGER THAN {@link ORPHAN_SWEEP_GRACE_MS} IS REMOVED, and neither is
 * anything whose age cannot be read at all — unknown age is treated as too
 * young. That is the multi-isolate guard: the lock is in-process, so a
 * concurrent isolate's in-flight `createWiki` looks exactly like an orphan from
 * here until its registry write lands.
 *
 * AN EMPTY REGISTRY SWEEPS ONLY TOMBSTONED DIRECTORIES. `readRegistry` degrades
 * a missing or unparseable `wikis.json` to {@link emptyRegistry}, so "no
 * entries, but directories on disk" is indistinguishable from "the registry was
 * lost or is half-restored" — and against that reading every Wiki the tenant has
 * is an orphan. It also cannot be the legitimate post-delete state: the current
 * Wiki is undeletable, so a delete never empties the registry. So the registry
 * gets no vote here; the only thing that does is a {@link WIKI_DISCARD_TOMBSTONE},
 * which only {@link discardCreatedWikiDirectory} writes and only for an id whose
 * create provably failed. That reclaims the DW-162 case — a first-ever create
 * whose seed AND whose discard both failed — without letting a lost `wikis.json`
 * cost the tenant a single artifact.
 *
 * AT MOST {@link ORPHAN_SWEEP_CANDIDATE_CAP} CANDIDATES PER PASS (DW-289). The
 * cap is applied to the candidate LIST, after the O(1) tombstone probe and
 * before the first age read, so the PER-CANDIDATE work under `wikis:<tenant>` —
 * `newestWriteTime`'s recursive stat walk and `deleteDirectory` — is bounded by
 * the cap rather than by however many orphan directories exist. It does NOT
 * bound the `listFiles` enumeration above it, which still lists every entry
 * under `wikis/` (and paginates on R2) inside the lock; that is one round trip
 * per page rather than per candidate, and bounding it would need the cursor this
 * deliberately does not keep. Truncation is warned about naming how many were
 * deferred, and the next scheduled pass picks them up. The return value is
 * unchanged — how many directories THIS pass removed.
 *
 * THE WINDOW ROTATES ONCE PER UTC DAY (DW-383). Which `cap` candidates a pass
 * considers is {@link rotatingSweepWindow}'s answer, not the first `cap` of
 * whatever order the provider listed. Removal is still the progress — a
 * reclaimed directory is simply gone from the next listing — but a candidate
 * that can never be removed (an unreadable or future-dated age) is listed again
 * every pass, and against a fixed head those stragglers starved everything
 * sorting behind them permanently.
 *
 * A SCHEDULED PASS ALSO CLEARS STALE TOMBSTONES (DW-291), from directories the
 * registry DOES name — see {@link clearStaleDiscardTombstones} for why that is
 * scheduled-only and why it is not a delete candidate.
 *
 * Residual, and documented rather than fixed: an isolate killed BETWEEN the seed
 * and the registry write on a first-ever create leaves an UNTOMBSTONED directory
 * (the catch never ran), which stays unreclaimable until the tenant owns a Wiki.
 * Bounded by the same guard, and the safe side of it.
 */
async function sweepOrphans(
  owner: string,
  registry: WikiRegistry,
  options: SweepOrphansOptions = {},
): Promise<number> {
  // ONE clock reading for the whole pass. The rotation bucket, the delete-age
  // cutoff and the forward-skew horizon all have to agree about when "now" is,
  // or a pass that straddles midnight could take one window and log against
  // another.
  const now = Date.now();
  const tombstonedOnly = registry.wikis.length === 0;
  const known = new Set(registry.wikis.map((wiki) => wiki.id));
  const entries = await getStorage().listFiles(wikisRootPath(owner));
  const directories = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .filter((name) => WIKI_ID_RE.test(name));
  const found = directories.filter((name) => !known.has(name));
  // HERE, above every branch, so BOTH callers evict: `deleteWiki`'s inline sweep
  // is the one that reclaims directories on a tenant the schedule never visits,
  // so a prune hung off the scheduled path would leak exactly the keys that pass
  // had just made unreachable. It costs one Set build over a list this function
  // has already materialised, and nothing at all when the record is empty.
  pruneFutureDatedWarnings(owner, found);
  // The complement of `found`, and the ONLY set the tombstone reclaim below
  // touches: a directory the registry names is by definition not an orphan, so
  // nothing in this list is ever a delete candidate. Computed ONLY when that
  // reclaim will actually run — `deleteWiki`'s inline sweep is a user-facing
  // request holding `wikis:<tenant>`, and this branch is required to add
  // nothing to it.
  const claimed = options.scheduled
    ? directories.filter((name) => known.has(name))
    : [];
  if (tombstonedOnly && found.length > 0) {
    // Only when there is actually something being held back — and keyed on the
    // PRE-CAP list, so the line fires for the same states it always did rather
    // than for whatever survived the truncation below. A scheduled sweep runs on
    // every cron tick, and a brand-new tenant with no wikis and no directories
    // is a healthy state — warning about it every few minutes would train the
    // operator to ignore the line that matters.
    logger.warn(
      "wikis",
      "the registry names no wikis, which is a lost or unreadable wikis.json as often as it is an empty tenant — sweeping only directories marked discarded by a failed half-create",
    );
  }
  // THE TOMBSTONE PROBE RESOLVES OVER THE FULL LIST, BEFORE THE CAP. In
  // `tombstonedOnly` mode an untombstoned directory is skipped on EVERY pass
  // forever, so letting one occupy a slot would delay a genuinely tombstoned
  // DW-162 directory that sorts after it — and "after" is a fixed position,
  // because `rotatingSweepWindow` sorts by code unit before it takes a window.
  // Rotation would eventually reach it, but a probe that is one `fileExists`
  // has no business costing a DW-162 directory days it does not need to wait.
  // It also
  // keeps the truncation warn below honest: it counts directories this pass
  // would really have reclaimed, not every directory a LOST registry makes look
  // like an orphan.
  //
  // Affordable because the probe is a single `fileExists` per candidate — O(1),
  // unlike `newestWriteTime`'s recursive walk or `deleteDirectory`. What the cap
  // is there to bound is the per-candidate WALK, and that stays bounded.
  let eligible = found;
  if (tombstonedOnly) {
    const marked: string[] = [];
    for (const name of found) {
      let tombstoned = false;
      try {
        tombstoned = await getStorage().fileExists(
          wikiDiscardTombstonePath(owner, name),
        );
      } catch (error) {
        // Unreadable is not evidence. Skip, exactly as unknown age does.
        logger.warn(
          "wikis",
          `could not check whether wiki directory "${name}" is marked discarded — leaving it alone`,
          error,
        );
      }
      if (tombstoned) marked.push(name);
    }
    eligible = marked;
  }
  // Capped HERE, on the candidate list, before a single `newestWriteTime` or
  // `deleteDirectory` below — capping the REMOVALS instead would leave the
  // per-candidate walk that holds `wikis:<tenant>` unbounded, which is the cost
  // this bounds (DW-289). ROTATING rather than always the first `cap` of
  // whatever order the provider listed, so a head of permanently unsweepable
  // directories cannot starve the tail (DW-383).
  const candidates = rotatingSweepWindow(eligible, now);
  if (eligible.length > candidates.length) {
    logger.warn(
      "wikis",
      `${eligible.length} orphaned wiki directory candidates found, which is more than the ${ORPHAN_SWEEP_CANDIDATE_CAP} one pass considers — deferring ${
        eligible.length - candidates.length
      } to a later UTC day, since the considered window advances by ${ORPHAN_SWEEP_CANDIDATE_CAP} per day and every pass within one day sees the same one`,
    );
  }
  const cutoff = now - ORPHAN_SWEEP_GRACE_MS;
  // The far side of the same tolerance. A provider clock (`head.uploaded`, or
  // an mtime) and this isolate's can disagree by a little, and the grace window
  // is already the size of that allowance; a write dated FURTHER ahead than the
  // whole window is not jitter, it is a skewed clock or a restored archive.
  const horizon = now + ORPHAN_SWEEP_GRACE_MS;
  let removed = 0;
  for (const name of candidates) {
    const dir = wikiDirPath(owner, name);
    const newest = await newestWriteTime(dir);
    // BEFORE the age gate, because a read at or inside the horizon settles the
    // skew question whichever side of `cutoff` the directory then lands on: an
    // aged one is about to be reclaimed and a young one is merely young, and in
    // both cases the future date this once reported is no longer true. `null`
    // is excluded deliberately — see {@link rearmFutureDatedWarning}.
    if (newest !== null && newest <= horizon) rearmFutureDatedWarning(owner, name);
    if (newest === null || newest > cutoff) {
      // The in-flight-create guard. `newestWriteTime` already warned when the
      // age was unreadable, so only the two READ ages need a line of their own.
      if (newest !== null && newest > horizon) {
        // NOT the info line: a future-dated directory can never age out on its
        // own, so this is not the benign, self-clearing case the info line
        // describes — the bytes sit there until the wall clock catches up,
        // which for a restored archive can be months. The age still refuses to
        // authorise a delete (an age that cannot be trusted must never gate one
        // (DW-290)), so warning is the whole remedy the sweep has.
        //
        // WARN-ONCE PER FACT (DW-483), for the same reason it is not the info
        // line: the condition cannot self-clear, so a line per pass would repeat
        // this sentence on every cron tick for as long as the clock needs. The
        // skip below is unconditional either way — dedupe changes what is SAID,
        // never what is done.
        warnOnceAboutFutureDatedWrite(owner, name, newest);
      } else if (newest !== null) {
        // INFO, because it is the expected, benign outcome that repeats on
        // every pass for as long as the directory stays young.
        logger.info(
          "wikis",
          `skipped orphaned wiki directory "${name}": its newest write is younger than the ${
            ORPHAN_SWEEP_GRACE_MS / 60_000
          }-minute grace window, so it may be a create still in flight on another isolate`,
        );
      }
      continue;
    }
    try {
      await getStorage().deleteDirectory(dir);
    } catch (error) {
      // Per candidate, like the age read and the tombstone probe above. One
      // stuck directory must not abort the pass: the caller
      // (`sweepOrphanWikiDirs`) turns a throw into 0, so propagating here would
      // report "removed nothing" for a pass that had already removed N.
      logger.warn(
        "wikis",
        `removing orphaned wiki directory "${name}" failed — leaving it for the next sweep`,
        error,
      );
      continue;
    }
    removed += 1;
    logger.warn(
      "wikis",
      `removed orphaned wiki directory "${name}" — no registry entry referenced it`,
    );
  }
  // AFTER the removals, because removal is the pass's actual work and this is
  // housekeeping for directories that are not going anywhere.
  if (options.scheduled) await clearStaleDiscardTombstones(owner, claimed, now);
  return removed;
}

/**
 * Remove `.discarded` from directories the registry DOES name (DW-291).
 * NEVER THROWS.
 *
 * {@link discardCreatedWikiDirectory} writes the marker for an id no registry
 * entry named — a create that provably failed. It can nonetheless end up on a
 * LIVE Wiki: `writeRegistry` is atomic from the caller's view but not
 * infallible in its reporting, so a registry write whose bytes landed and whose
 * acknowledgement did not sends `createWiki` into its compensation for an id
 * the registry now names. The directory delete then fails too (it is the same
 * unhealthy provider), and the tombstone lands on a Wiki that works.
 *
 * WHY THAT MATTERS ENOUGH TO CLEAN UP: the marker is the ONE thing that
 * outranks the empty-registry rule in {@link sweepOrphans}. Left in place, it
 * arms a delete of a real Wiki's artifacts for the day that tenant's
 * `wikis.json` is lost or unreadable — precisely the state the empty-registry
 * rule exists to survive. Nothing else ever clears it: no code path rewrites or
 * removes the file, and the directory it sits in is not an orphan, so the sweep
 * above never reaches it.
 *
 * SCHEDULED SWEEPS ONLY. Clearing costs one `fileExists` per registry-claimed
 * directory, and {@link deleteWiki} runs its sweep on a user-facing request
 * while holding `wikis:<tenant>` — where the healthy case costs a single
 * `listFiles` today and every create, rename and delete for the tenant queues
 * behind it. The cron tick already tolerates the full walk, and the fault needs
 * three unlikely failures in a row, so a few minutes' delay costs nothing.
 *
 * Bounded by the SAME {@link rotatingSweepWindow} as the orphan candidates, for
 * the same two reasons: the per-pass round trips stay capped, and a tenant with
 * more directories than the cap still has every one of them probed within
 * `ceil(n / cap)` days.
 *
 * FAIL-SOFT PER DIRECTORY, like every other step in the pass: an unreadable
 * probe or an undeletable marker warns and the loop continues. A stale
 * tombstone left one more day is exactly where it already was. The two failures
 * are reported SEPARATELY, for the reason the probe in {@link sweepOrphans}
 * distinguishes them: "could not clear the marker" asserts a marker is there,
 * and a probe that threw never said so.
 *
 * THE RESIDUAL, and it is the reason this narrows the fault rather than closing
 * it: `claimedDirectories` is empty exactly when the registry is lost or
 * unreadable — the one state in which a stale marker is dangerous — so a marker
 * still on disk when `wikis.json` goes is a marker this never gets to see. What
 * this buys is the window between the bad half-create and that loss, which for
 * a daily cron is normally the whole of it; two independent rare faults landing
 * in the same day is what it does not cover. Closing that would mean trusting
 * an empty registry, which is the one thing {@link sweepOrphans} must never do.
 *
 * A SECOND RESIDUAL FOLLOWS FROM "SCHEDULED SWEEPS ONLY" AND IS RECORDED
 * ELSEWHERE (DW-488): the schedule resolves the single configured owner, so a
 * tenant created before the DW-159 creation gate landed has no clearer for its
 * stale markers at all — this never sees that tenant, and the inline sweep that
 * does reach it is exactly the caller the paragraph above keeps this off.
 * Accepted, with the arithmetic, in the SCOPE docblock on `sweepOrphanWikiDirs`
 * in `maintenance.ts`, beside the orphan-directory residual it sits next to.
 */
async function clearStaleDiscardTombstones(
  owner: string,
  claimedDirectories: string[],
  now: number,
): Promise<void> {
  for (const name of rotatingSweepWindow(claimedDirectories, now)) {
    const marker = wikiDiscardTombstonePath(owner, name);
    let marked = false;
    try {
      marked = await getStorage().fileExists(marker);
    } catch (error) {
      // Unreadable is not evidence, the same way it is not in `sweepOrphans` —
      // and it is emphatically not evidence that there is a marker to clear.
      logger.warn(
        "wikis",
        `could not check whether wiki directory "${name}" carries a stale discard marker — leaving it for the next scheduled sweep`,
        error,
      );
      continue;
    }
    if (!marked) continue;
    try {
      await getStorage().deleteFile(marker);
    } catch (error) {
      logger.warn(
        "wikis",
        `could not clear the stale discard marker on wiki directory "${name}" — leaving it for the next scheduled sweep`,
        error,
      );
      continue;
    }
    // WARN rather than INFO: unlike the grace-window skip this cannot repeat —
    // the marker is gone — and it records that a live Wiki was one lost
    // wikis.json away from being swept.
    logger.warn(
      "wikis",
      `cleared the stale discard marker on wiki directory "${name}" — the registry names it, so a failed half-create had marked a wiki that is in use`,
    );
  }
}

/**
 * Reclaim every `tenants/<t>/wikis/<uuid>/` directory the registry does not
 * name. Returns how many were removed.
 *
 * `normalizeRegistry` drops unusable entries during a plain READ, so the sweep
 * cannot live there without making reads destructive. It runs from
 * {@link deleteWiki} — the one moment a Wiki directory is legitimately removed —
 * and, since a tenant that never deletes would otherwise never reclaim
 * anything, it is exported here (taking the lock itself) so the maintenance
 * scan can run it on a schedule: `sweepOrphanWikiDirs` in `maintenance.ts`,
 * called by `POST /api/tasks/scan`.
 *
 * See {@link sweepOrphans} for what it will and will not remove — in particular
 * {@link ORPHAN_SWEEP_GRACE_MS}, which is what makes a scheduled caller safe
 * beside a concurrent create.
 */
export async function sweepOrphanWikiDirectories(owner: string): Promise<number> {
  // Deployment read-only (DW-314), BEFORE the lock. This one is not reached by
  // an owner pressing anything: `POST /api/tasks/scan` runs it on a cron, so
  // ungated it deleted Wiki directories on a read-only deployment on a timer.
  // The scan refuses whole now, so this is the backstop — and, since the sweep
  // is also called from `deleteWiki`'s locked body through `sweepOrphans`, the
  // gate here is what a DIRECT caller of this exported entry point meets.
  assertWritable(READ_ONLY_REFUSAL.wikiDirectorySweep);
  // `scheduled` is set HERE and nowhere else: this is the cron tick, which
  // already tolerates a full walk of the tenant's directories, so it is the one
  // caller that can afford the stale-tombstone probe (DW-291). `deleteWiki`'s
  // inline sweep leaves it unset.
  return withWikiLock(owner, async () =>
    sweepOrphans(owner, await readRegistry(owner), { scheduled: true }),
  );
}

/**
 * Delete a Wiki: its registry entry AND its `tenants/<t>/wikis/<id>/`
 * directory. Returns null when the id is unknown, so the route can 404.
 *
 * REFUSES THE CURRENT WIKI, with a `ClientInputError` the route answers 400 —
 * and does NOT re-point `currentId` to make the delete succeed. Which Wiki is
 * active decides which `schema.md` executes in every ingest, chat and lint
 * prompt; moving that pointer as a side effect of a delete would silently
 * change what the whole workspace runs on. The owner switches first.
 *
 * ORDER: registry, then the directory. A crash between the two leaves an orphan
 * directory, which {@link sweepOrphanWikiDirectories} is built to reclaim. The
 * reverse order leaves a registry entry pointing at artifacts that are gone —
 * the failure the UI cannot recover from.
 *
 * WHICH IS ALSO WHY BOTH BYTE-REMOVAL STEPS ARE FAIL-SOFT. Once the registry
 * write lands the Wiki is gone from every read in the app, so a throw from
 * either `deleteDirectory` or the sweep would 500 a delete that has effectively
 * happened — and the owner's retry would then 404. The leftovers are exactly
 * what the sweep reclaims on the next delete — up to
 * {@link ORPHAN_SWEEP_CANDIDATE_CAP} of them, since the inline sweep below is a
 * user-facing request path and carries the same per-pass bound the scheduled
 * caller does; anything past the cap waits for the next delete or the next cron
 * tick rather than lengthening this one under the tenant lock.
 *
 * IT DOES BUMP `dataVersion` (DW-382), the same tail {@link createWiki},
 * {@link applyScenarioTemplate} and {@link renameWiki} carry — a delete is a
 * Preview-visible byte move like any other. The Workbench's Files tree and the
 * Wiki switcher both render from data this removes, and a delete moves no
 * `currentWikiId` (the current Wiki is undeletable), so the selection-reset
 * effect never fires and the counter is the only thing that can tell ANOTHER
 * client's open tab that a Wiki and its artifacts are gone. Without it that tab
 * keeps listing a Wiki whose bytes no longer exist until the owner reloads.
 *
 * The tail is OUTSIDE the lock (`bumpDataVersion` takes `DATA_VERSION_LOCK` and
 * `withFileLock` is not reentrant), fail-soft (both byte-removal steps above
 * are; a counter that did not move must not turn a landed delete into a 500 the
 * owner retries into a 404), and fires only when the locked body returned a
 * record — an unknown id writes nothing, and the current Wiki throws before the
 * registry write.
 *
 * It bumps even when `deleteDirectory` failed: the registry entry is gone, and
 * that is what every list, switcher and lookup in the app reads.
 *
 * Pages, Sources, the page index and `tenants/<t>/wiki/**` are untouched: they
 * are tenant-wide, not per-Wiki, so a delete never removes content.
 */
export async function deleteWiki(
  owner: string,
  wikiId: string,
): Promise<WikiRecord | null> {
  // Deployment read-only (DW-314), BEFORE the lock — and the ordering matters
  // more here than at any other wiki writer. Both byte-removal steps below are
  // FAIL-SOFT by design, so a gate inside the locked body would raise its
  // refusal only after `writeRegistry` had already removed the entry: the Wiki
  // would be gone from every read in the app, and the refusal would be caught
  // by one of the two `logger.warn` handlers rather than reaching the caller.
  // `DELETE /api/wikis/[id]` already refuses first, so this is the backstop for
  // a direct library caller.
  assertWritable(READ_ONLY_REFUSAL.wikiDelete);
  const deleted = await withWikiLock(owner, async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    if (registry.currentId === wiki.id) {
      throw new ClientInputError(
        "Switch to a different wiki before deleting this one.",
      );
    }
    registry.wikis = registry.wikis.filter((item) => item.id !== wiki.id);
    await writeRegistry(owner, registry);
    try {
      await getStorage().deleteDirectory(wikiDirPath(owner, wiki.id));
    } catch (error) {
      // The entry is already gone, so the Wiki is gone from every read in the
      // app. Reporting that as a failure would send the owner into a retry that
      // 404s; the bytes stay behind for the next sweep to reclaim instead.
      logger.warn(
        "wikis",
        `removing the directory of deleted wiki "${wiki.id}" failed — leaving it for the orphan sweep`,
        error,
      );
    }
    try {
      await sweepOrphans(owner, registry);
    } catch (error) {
      // Same reasoning, one step further out: leftovers from some EARLIER
      // interruption must not fail the delete the owner actually asked for.
      logger.warn("wikis", "sweeping orphaned wiki directories failed", error);
    }
    return wiki;
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!deleted) return null;
  await bumpRefreshSignal(`deleting wiki "${deleted.id}"`);
  return deleted;
}

/** Read one seeded artifact, or null when it is missing. */
export async function readWikiArtifact(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): Promise<string | null> {
  try {
    return await getStorage().readFile(wikiArtifactPath(owner, wikiId, file));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * Read an artifact through the Wiki's authority boundary.
 *
 * Only Purpose has a compatibility projection. An unmarked Wiki keeps using a
 * valid legacy profile until migration commits its registry marker; after the
 * marker, a missing or corrupt purpose.md is returned as missing and the
 * profile can never become live again.
 */
export async function readEffectiveWikiArtifact(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  knownWiki?: WikiRecord,
): Promise<string | null> {
  if (file !== "purpose.md") return readWikiArtifact(owner, wikiId, file);
  const wiki = knownWiki?.id === wikiId
    ? knownWiki
    : (await readRegistry(owner)).wikis.find((item) => item.id === wikiId);
  if (!wiki) return null;
  if (wiki.artifactAuthority === ARTIFACT_AUTHORITY_VERSION) {
    return readWikiArtifact(owner, wikiId, file);
  }
  try {
    const evidence = await readWorkspaceProfileEvidence(owner, wikiId);
    if (evidence && workspaceProfileHasGuidance(evidence.profile)) {
      return renderCanonicalPurposeMarkdown(wiki.name, evidence.profile);
    }
  } catch (error) {
    // Corrupt legacy evidence must not block reading recoverable artifact bytes.
    // The migration logs and remains unmarked when it encounters the same file.
    logger.warn(
      "workspace-purpose",
      `the legacy profile for wiki "${wikiId}" is unusable — serving its stored purpose.md until migration can be repaired`,
      error,
    );
  }
  return readWikiArtifact(owner, wikiId, file);
}

/** Effective purpose.md bytes keyed by their tenant-relative storage path. */
export async function effectivePurposeOverrides(
  owner: string,
): Promise<Map<string, string>> {
  const registry = await readRegistry(owner);
  const entries = await Promise.all(
    registry.wikis.map(async (wiki) => {
      const content = await readEffectiveWikiArtifact(
        owner,
        wiki.id,
        "purpose.md",
        wiki,
      );
      return content === null
        ? null
        : ([wikiArtifactPath(owner, wiki.id, "purpose.md"), content] as const);
    }),
  );
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== null));
}

/** Outcome of one idempotent artifact-authority migration. */
export type PurposeCanonicalizationResult =
  | "migrated"
  | "already-authoritative"
  | "missing-wiki";

/**
 * Project one unmarked Wiki's supported legacy profile into its artifacts and
 * commit the authority marker last, under the existing process-local Wiki lock.
 *
 * Every overwritten artifact is snapshotted before the first write. A failure
 * restores the prior artifact bytes best-effort and leaves the registry
 * unmarked, so effective reads keep serving the valid legacy profile and the
 * next maintenance pass can retry. The profile file itself is never written or
 * deleted. This is compensation, not a durable multi-object transaction.
 */
export async function canonicalizeWikiPurpose(
  owner: string,
  wikiId: string,
): Promise<PurposeCanonicalizationResult> {
  assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
  const result = await withWikiLock(owner, async (): Promise<PurposeCanonicalizationResult> => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return "missing-wiki";
    if (wiki.artifactAuthority === ARTIFACT_AUTHORITY_VERSION) {
      return "already-authoritative";
    }

    // Strict on purpose: invalid/unreadable bytes abort before an artifact or
    // marker moves. Missing evidence is allowed; in that case existing artifact
    // bytes become authoritative without a synthetic profile projection.
    const evidence = await readWorkspaceProfileEvidence(owner, wikiId);
    const currentPurpose = await readWikiArtifact(owner, wikiId, "purpose.md");
    const currentSchema = await readWikiArtifact(owner, wikiId, "schema.md");
    const desiredPurpose = evidence && workspaceProfileHasGuidance(evidence.profile)
      ? renderCanonicalPurposeMarkdown(wiki.name, evidence.profile)
      : currentPurpose;
    const desiredSchema = evidence && currentSchema !== null
      ? appendLegacyPageConventions(
          currentSchema,
          evidence.profile.pageConventions,
        )
      : currentSchema;

    if (desiredPurpose === null) {
      throw new Error(`cannot canonicalize wiki "${wikiId}" without purpose.md`);
    }
    if (desiredSchema === null) {
      throw new Error(`cannot canonicalize wiki "${wikiId}" without schema.md`);
    }

    const changes: Array<{
      file: WikiArtifactFile;
      before: string;
      after: string;
    }> = [];
    if (currentPurpose !== desiredPurpose) {
      changes.push({ file: "purpose.md", before: currentPurpose ?? "", after: desiredPurpose });
    }
    if (currentSchema !== desiredSchema) {
      changes.push({ file: "schema.md", before: currentSchema ?? "", after: desiredSchema });
    }

    // Snapshot ALL changed artifacts before the first canonical byte lands.
    for (const change of changes) {
      await saveWikiArtifactRevision(
        owner,
        wikiId,
        change.file,
        change.before,
        owner,
        "migrated legacy Workspace Purpose guidance",
      );
    }

    const written: typeof changes = [];
    try {
      for (const change of changes) {
        await putWikiArtifact(owner, wikiId, change.file, change.after);
        written.push(change);
      }
      wiki.artifactAuthority = ARTIFACT_AUTHORITY_VERSION;
      // This write is deliberately last: it is the irreversible semantic
      // boundary after which no profile byte can guide runtime behavior.
      await writeRegistry(owner, registry);
    } catch (error) {
      for (const change of [...written].reverse()) {
        try {
          await getStorage().writeFile(
            wikiArtifactPath(owner, wikiId, change.file),
            change.before,
          );
        } catch (restoreError) {
          logger.warn(
            "workspace-purpose",
            `restoring "${change.file}" after a failed canonicalization of wiki "${wikiId}" failed`,
            restoreError,
          );
        }
      }
      throw error;
    }
    return "migrated";
  });

  if (result === "migrated") {
    await bumpRefreshSignal(`canonicalizing Workspace Purpose for wiki "${wikiId}"`);
  }
  return result;
}

/**
 * The active Wiki's `schema.md`, for the schema loader — which has no owner
 * argument.
 *
 * INVARIANT (DW-19, single-owner tenancy resolution): this function resolves
 * the tenant DEPLOYMENT-GLOBALLY from `NEXT_PUBLIC_OWNER_HANDLE`, not from a
 * caller — the only place the SCHEMA path turns that env value into a storage
 * key. (The env var has exactly one PRODUCTION reader, `getOwnerHandle()` in
 * `src/lib/owner.ts`: the backup scheduler in
 * `src/app/api/tasks/scan/route.ts` and `e2eOwnerHandle()` in
 * `src/lib/e2e-identity.ts` both go through that helper (DW-157), so grepping
 * for `getOwnerHandle` finds every site-owner resolution in the shipped code.
 * Test files are the exception and read and write `process.env` directly —
 * arming an owner is what a fixture DOES. The production half of that is
 * mechanized by `src/lib/__tests__/owner-single-reader.test.ts`, which scans
 * `src/` and fails on the next inline read.) Every other tenant-scoped
 * read/write — `workspace-profile.ts`, `research-projects.ts`,
 * `portable-archive.ts`, and `createWiki`/`getCurrentWiki` above — takes a
 * passed-in `owner` instead.
 * That asymmetry is deliberate and correct ONLY because work-wiki ships as a
 * single-owner deployment (see `src/lib/owner.ts`): the site owner's Schema is
 * the site's Schema, so every caller gets it regardless of who they are.
 *
 * MIGRATION (a second tenant): opening a NEW non-owner tenant is refused, but
 * by a stack of doors, not by one — state the guarantee at the surface it
 * actually holds at. The OUTER gate is `handlePrivateRequest` in
 * `src/middleware.ts`: it runs on every request and 403s any `/api/*` call
 * whose Clerk `userId` is not `YOPEDIA_OWNER_USER_ID` (404 for non-API
 * navigation), and `/api/wikis` is neither in `IN_ROUTE_AUTH_PATHS` nor matched
 * by `authenticatesInRoute`, so a non-owner never reaches the route at all on a
 * configured deployment. The SECOND door is the route's own `isOwnerPrincipal`
 * check (DW-159) — defense-in-depth behind the middleware, and the same gate
 * `src/app/api/workbench/artifact/route.ts` puts on Schema edits. The KERNEL,
 * {@link createWiki} below, is deliberately NOT owner-asserted: it still takes
 * any `owner` string, exactly as it keeps `assertWritable` as an explicit
 * backstop for a direct library caller. What holds today is that the route is
 * its only caller — a CLI command or a future MCP tool reaching the kernel
 * directly would open a tenant with nothing to stop it, so that is the line to
 * re-check before adding one. The only non-owner tenants reachable now are ones
 * created before that gate landed; they are inert, because this function never
 * resolves them and the artifact route 403s their Schema edits. What does not
 * exist is multi-tenant SERVING. So the trigger is not "a second owner
 * appears" — it is "a non-owner's Wiki must actually serve that non-owner". At
 * that moment this must stop reading `getOwnerHandle()` and instead take a
 * tenant argument, threaded through `loadPageConventions()` in `schema.ts` and
 * supplied at every one of its no-argument call sites. Those sites are not equally ready for it:
 *   - `query.ts` (`buildQuerySystemPrompt`) and `ingest.ts`
 *     (`buildIngestSystemPrompt`) already have a per-caller `owner` in scope —
 *     but note it is a PRINCIPAL, not necessarily a tenant (it can be
 *     `"system"` or an agent handle), so it cannot simply be forwarded.
 *   - `checkContradictions()` and `checkMissingConceptPages()` in
 *     `lint-checks.ts` have NO owner at all. Threading a tenant there means
 *     carrying it down through `lint()` in `lint.ts` from both of its entry
 *     points, `src/app/api/lint/route.ts` and `src/cli.ts`.
 * Leaving the deployment-global resolution in place through such a migration
 * is what would silently hand a non-owner caller the site owner's Scenario
 * Template conventions.
 *
 * Pinned by the "single-owner Schema resolution invariant" describe block in
 * `src/lib/__tests__/wiki-schema-source.test.ts`: behavioral pins (another
 * tenant's Wiki never wins), consumer-surface pins on the ingest and query
 * prompt builders, a catch-branch pin (a corrupt `wikis.json` warns and falls
 * back to the root `SCHEMA.md` rather than throwing — DW-155), case-
 * normalization pins on both sides of the handle (`"Alice"` and `"alice"`
 * resolve the same tenant, so case never splits the silo — DW-156), and a
 * signature pin that reads the DECLARED parameter list so a defaulted tenant
 * parameter cannot slip past. Adding a tenant parameter must be a deliberate,
 * test-updating change. The two `lint-checks.ts` detectors — the no-argument
 * call sites with no owner in scope — are pinned at their own surface by the
 * "resolve the ACTIVE Wiki's Schema" block in
 * `src/lib/__tests__/lint.test.ts` (DW-158).
 *
 * With no owner, no Wiki, or any read failure this returns null and the
 * caller falls back to the repo-root `SCHEMA.md`.
 */
export async function readActiveWikiSchema(): Promise<string | null> {
  const owner = getOwnerHandle();
  if (!owner) return null;
  try {
    const wiki = await getCurrentWiki(owner);
    if (!wiki) return null;
    return await readWikiArtifact(owner, wiki.id, "schema.md");
  } catch (error) {
    // Falling back to the root SCHEMA.md is correct, but doing it silently
    // means a misconfigured owner handle or an unreadable registry serves the
    // wrong Schema forever with nothing to diagnose from.
    logger.warn(
      "wikis",
      `resolving the active wiki Schema for "${owner}" failed — falling back to the root SCHEMA.md`,
      error,
    );
    return null;
  }
}
