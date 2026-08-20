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
 * READ-ONLY (DW-266): {@link createWiki}, {@link applyScenarioTemplate} and
 * {@link renameWiki} each refuse BEFORE taking the lock and before reading a
 * byte, so a refusal on a stably read-only deployment never reaches a
 * compensation path; the putters refuse again as a backstop. The wiki routes
 * keep their own inline 403s and gate first, so these gates change nothing the
 * app does today — they exist for a DIRECT LIBRARY CALLER (a CLI command, a
 * future MCP tool) reaching the kernel with no route in front.
 *
 * WHAT IS NOT GATED, stated so the coverage is not mistaken for the family.
 * {@link deleteWiki}, {@link setCurrentWiki} and
 * {@link sweepOrphanWikiDirectories} still write `wikis.json` and delete Wiki
 * directories with NO `assertWritable` — a known gap this change did not close,
 * because the bundle that added the three gates above did not name them. Their
 * HTTP doors gate, so the gap is the same direct-library-caller one, one level
 * further out.
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
  wikiProfilePath,
  wikisRootPath,
} from "./wiki-paths";
import { saveWikiArtifactRevision } from "./wiki-artifact-revisions";
import { putWorkspaceProfile } from "./workspace-profile";
import type { WorkspaceProfileInput } from "./workspace-profile-schema";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WikiRecord {
  id: string;
  name: string;
  scenario: CreatableScenario;
  createdAt: string;
  updatedAt: string;
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
  await putWorkspaceProfile(held, owner, wiki.id, templateProfile(wiki.scenario));
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
  return [
    ...WIKI_ARTIFACT_FILES.map((file) => wikiArtifactPath(owner, wikiId, file)),
    wikiProfilePath(owner, wikiId),
  ];
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
async function restoreSeededFiles(snapshot: SeededFileSnapshot[]): Promise<void> {
  const storage = getStorage();
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
      logger.warn(
        "wikis",
        `restoring "${entry.path}" after a failed re-template failed — this wiki may now describe two different scenario templates`,
        error,
      );
    }
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
 */
export async function writeWikiArtifact(
  owner: string,
  wikiId: string,
  file: EditableArtifactFile,
  content: string,
  reason?: string,
): Promise<void> {
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
    // BOTH ARE FAIL-SOFT, in the same spirit as `writeWikiPage`: the save
    // proceeds either way. A save that reaches storage is never reported as
    // failed because history could not be recorded — the alternative loses the
    // owner's new bytes to protect their old ones.
    let existing: string | null = null;
    try {
      existing = await readWikiArtifact(owner, wikiId, file);
    } catch (error) {
      logger.warn(
        "wikis",
        `reading "${file}" before overwriting it failed — the save proceeds, but the replaced bytes are not in this wiki's history`,
        error,
      );
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
    await appendToLog(
      "edit",
      `Schema — ${file}`,
      editReason === undefined
        ? `Wiki: ${wikiId}`
        : `Wiki: ${wikiId} · ${editReason}`,
    );
  } catch (error) {
    logger.warn("wikis", `logging the artifact edit of "${file}" failed`, error);
  }
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn(
      "wikis",
      `the refresh signal did not move after editing "${file}"`,
      error,
    );
  }
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
    };
    // The cap check above throws BEFORE this point on purpose: it writes
    // nothing, so it must not be inside the compensation.
    try {
      await seedWikiArtifacts(held, owner, wiki);
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
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn(
      "wikis",
      `the refresh signal did not move after creating wiki "${created.id}"`,
      error,
    );
  }
  return created;
}

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
 * The tail is outside the lock, fail-soft, and skipped on both throwing or
 * empty-handed paths: the unknown-id `null` (which writes nothing) and the
 * `restoreSeededFiles` branch (which re-throws). "Re-throws" is not quite "wrote
 * nothing", though: `restoreSeededFiles` is fail-soft PER ENTRY, so a restore
 * that cannot write leaves some new template bytes on disk with no bump to
 * announce them (DW-210) — rare, already-degraded, and out of scope here.
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
  const applied = await withWikiLock(owner, async (held) => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    // Snapshot BEFORE the first overwrite. The in-memory mutation below needs
    // no undo — the registry is re-read on every call, so a failed write simply
    // leaves the stored `scenario` where it was; the FILES are what persist.
    const snapshot = await snapshotSeededFiles(owner, wiki.id);
    wiki.scenario = scenario;
    wiki.updatedAt = new Date().toISOString();
    try {
      await seedWikiArtifacts(held, owner, wiki);
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
      await restoreSeededFiles(snapshot);
      throw error;
    }
    return wiki;
  });

  // Unknown id: nothing was written, so there is nothing to refresh to.
  if (!applied) return null;
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn(
      "wikis",
      `the refresh signal did not move after re-templating wiki "${applied.id}"`,
      error,
    );
  }
  return applied;
}

/**
 * Point `current` at an existing Wiki. Returns null when the id is unknown.
 *
 * NON-DESTRUCTIVE, and that is the whole point: `wikis.json` is the ONLY file
 * this writes. A switch used to re-seed a tenant-global profile from the newly
 * active Wiki's template, which silently discarded whatever the owner had
 * authored in Settings; there is nothing left here to discard.
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
  return withWikiLock(owner, async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    registry.currentId = wiki.id;
    await writeRegistry(owner, registry);
    return wiki;
  });
}

/**
 * Retitle a renamed Wiki's `purpose.md` — the artifact half of {@link renameWiki}.
 *
 * UNLOCKED, like {@link putWikiArtifact}: the caller is already holding
 * `wikis:<tenant>`. Deliberately NOT `writeWikiArtifact`, which would take that
 * key again (deadlock) and fire an activity-log line naming a Schema edit this
 * is not.
 *
 * NO `dataVersion` BUMP EITHER, and since DW-49 that is no longer the whole
 * family's rule: {@link createWiki} and {@link applyScenarioTemplate} grew tails
 * because they SEED bytes, while {@link renameWiki} did not. So a Preview left
 * open on `purpose.md` keeps the old heading across a rename until the owner
 * reselects or reloads — logged as DW-209, out of scope for the bundle that
 * added the other two tails.
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
  return withWikiLock(owner, async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    wiki.name = parsed;
    wiki.updatedAt = new Date().toISOString();
    await writeRegistry(owner, registry);
    await retitlePurpose(owner, wiki.id, parsed);
    return wiki;
  });
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
 * Residual, and documented rather than fixed: an isolate killed BETWEEN the seed
 * and the registry write on a first-ever create leaves an UNTOMBSTONED directory
 * (the catch never ran), which stays unreclaimable until the tenant owns a Wiki.
 * Bounded by the same guard, and the safe side of it.
 */
async function sweepOrphans(owner: string, registry: WikiRegistry): Promise<number> {
  const tombstonedOnly = registry.wikis.length === 0;
  const known = new Set(registry.wikis.map((wiki) => wiki.id));
  const entries = await getStorage().listFiles(wikisRootPath(owner));
  const candidates = entries
    .filter((entry) => entry.isDirectory)
    .map((entry) => entry.name)
    .filter((name) => WIKI_ID_RE.test(name) && !known.has(name));
  if (tombstonedOnly && candidates.length > 0) {
    // Only when there is actually something being held back. A scheduled sweep
    // runs on every cron tick, and a brand-new tenant with no wikis and no
    // directories is a healthy state — warning about it every few minutes would
    // train the operator to ignore the line that matters.
    logger.warn(
      "wikis",
      "the registry names no wikis, which is a lost or unreadable wikis.json as often as it is an empty tenant — sweeping only directories marked discarded by a failed half-create",
    );
  }
  const cutoff = Date.now() - ORPHAN_SWEEP_GRACE_MS;
  let removed = 0;
  for (const name of candidates) {
    const dir = wikiDirPath(owner, name);
    if (tombstonedOnly) {
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
      if (!tombstoned) continue;
    }
    const newest = await newestWriteTime(dir);
    if (newest === null || newest > cutoff) {
      // The in-flight-create guard. `newestWriteTime` already warned when the
      // age was unreadable, so only the young case needs a line of its own —
      // and at INFO, because it is the expected, benign outcome that repeats on
      // every pass for as long as the directory stays young.
      if (newest !== null) {
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
  return removed;
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
  return withWikiLock(owner, async () =>
    sweepOrphans(owner, await readRegistry(owner)),
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
 * what the sweep reclaims on the next delete.
 *
 * Pages, Sources, the page index and `tenants/<t>/wiki/**` are untouched: they
 * are tenant-wide, not per-Wiki, so a delete never removes content.
 */
export async function deleteWiki(
  owner: string,
  wikiId: string,
): Promise<WikiRecord | null> {
  return withWikiLock(owner, async () => {
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
 * The active Wiki's `schema.md`, for the schema loader — which has no owner
 * argument.
 *
 * INVARIANT (DW-19, single-owner tenancy resolution): this function resolves
 * the tenant DEPLOYMENT-GLOBALLY from `NEXT_PUBLIC_OWNER_HANDLE`, not from a
 * caller — the only place the SCHEMA path turns that env value into a storage
 * key. (It is not the only reader of the env var repo-wide: the backup
 * scheduler in `src/app/api/tasks/scan/route.ts` also reads it as an owner for
 * manifest reads and the `create-backup` task. Two independent readers, same
 * single-owner assumption.) Every other tenant-scoped read/write —
 * `workspace-profile.ts`, `research-projects.ts`, `portable-archive.ts`, and
 * `createWiki`/`getCurrentWiki` above — takes a passed-in `owner` instead.
 * That asymmetry is deliberate and correct ONLY because work-wiki ships as a
 * single-owner deployment (see `src/lib/owner.ts`): the site owner's Schema is
 * the site's Schema, so every caller gets it regardless of who they are.
 *
 * MIGRATION (a second tenant): note that more than one owner can hold Wikis
 * ALREADY — `POST /api/wikis` gates on `getPrincipal()`, not `isOwnerHandle`,
 * so any signed-in non-owner can create one. What does not exist yet is
 * multi-tenant SERVING: such a Wiki is inert, because this function never
 * resolves it and `src/app/api/workbench/artifact/route.ts` 403s its Schema
 * edits. So the trigger is not "a second owner appears" — it is "a non-owner's
 * Wiki must actually serve that non-owner". At that moment this must stop
 * reading `getOwnerHandle()` and instead take a tenant argument, threaded
 * through `loadPageConventions()` in `schema.ts` and supplied at every one of
 * its no-argument call sites. Those sites are not equally ready for it:
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
 * prompt builders, and a signature pin that reads the DECLARED parameter list
 * so a defaulted tenant parameter cannot slip past. Adding a tenant parameter
 * must be a deliberate, test-updating change.
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
