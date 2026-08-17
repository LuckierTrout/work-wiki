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
 * The registry idiom (path, lock key, `crypto.randomUUID()`, ENOENT → empty,
 * a hard cap) mirrors `research-projects.ts`.
 */

import { bumpDataVersion } from "./data-version";
import { ClientInputError, isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { getOwnerHandle } from "./owner";
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
import {
  WIKI_ID_RE,
  wikiArtifactPath,
  wikiDirPath,
  wikiLockKey,
  wikisRootPath,
} from "./wiki-paths";
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
 * are reclaimed by {@link sweepOrphanWikiDirectories} rather than avoided here.
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
 * UNLOCKED on purpose. `seedWikiArtifacts` runs inside `withFileLock(
 * wikiLockKey(owner))` already (via {@link createWiki} and
 * {@link applyScenarioTemplate}) and `withFileLock` is NOT reentrant — `lock.ts`
 * chains a new call onto the key's existing promise, so taking
 * `wikis:<tenant>` again from in there would deadlock the whole tenant. Callers
 * that are not already holding it take it themselves; see
 * {@link writeWikiArtifact}.
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
  await getStorage().writeFile(wikiArtifactPath(owner, wikiId, file), content);
}

/**
 * Write the two artifacts and the workspace profile for `wiki`.
 *
 * This is the whole footprint of create and of re-template: nothing under
 * `tenants/<t>/wiki/`, nothing under `tenants/<t>/raw/`, no page index entry,
 * no log line, and no `dataVersion` bump — seeding's half of that signal
 * belongs with whichever story owns create and re-template.
 *
 * All three writes land in `tenants/<t>/wikis/<id>/`, so the footprint is
 * scoped to THIS Wiki: seeding one Wiki cannot touch another's hand-authored
 * Workspace Purpose. The profile goes through the UNLOCKED `putWorkspaceProfile`
 * for the same reason {@link putWikiArtifact} is unlocked — the caller is
 * already holding `wikis:<tenant>`.
 */
async function seedWikiArtifacts(owner: string, wiki: WikiRecord): Promise<void> {
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
  await putWorkspaceProfile(owner, wiki.id, templateProfile(wiki.scenario));
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
): Promise<void> {
  await withFileLock(wikiLockKey(owner), () =>
    putWikiArtifact(owner, wikiId, file, content),
  );

  try {
    // `wiki/log.md` is tenant-global while `schema.md` is PER WIKI, so the
    // heading alone ("Schema — schema.md") is the same sentence for every Wiki
    // the owner has. The id goes on the details line, where `appendToLog`
    // already puts the entry's payload, so the log can still answer "whose
    // Schema moved" once there is more than one.
    await appendToLog("edit", `Schema — ${file}`, `Wiki: ${wikiId}`);
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
 */
export async function createWiki(
  owner: string,
  input: CreateWikiInput,
): Promise<WikiRecord> {
  const { name, scenario } = parseCreateWikiInput(input);
  return withFileLock(wikiLockKey(owner), async () => {
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
    await seedWikiArtifacts(owner, wiki);
    registry.wikis.push(wiki);
    registry.currentId = wiki.id;
    await writeRegistry(owner, registry);
    return wiki;
  });
}

/**
 * Apply a different Scenario Template to an existing Wiki.
 *
 * Confirm-gated in the UI because it overwrites `purpose.md`, `schema.md`, and
 * THIS Wiki's own `workspace-profile.json`. Every other Wiki's profile — and
 * Pages and Sources — are untouched. Returns null when the id is unknown, so
 * the route can answer 404.
 */
export async function applyScenarioTemplate(
  owner: string,
  wikiId: string,
  scenario: CreatableScenario,
): Promise<WikiRecord | null> {
  if (!isCreatableScenario(scenario)) {
    throw new ClientInputError("Choose one Scenario Template.");
  }
  return withFileLock(wikiLockKey(owner), async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    wiki.scenario = scenario;
    wiki.updatedAt = new Date().toISOString();
    await seedWikiArtifacts(owner, wiki);
    await writeRegistry(owner, registry);
    return wiki;
  });
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
  return withFileLock(wikiLockKey(owner), async () => {
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
 * key again (deadlock) and fire a log line and a `dataVersion` bump the sibling
 * lifecycle operations do not have.
 *
 * FAIL-SOFT, and that is the whole design of it. The registry is what the
 * switcher, the workbench heading and every id lookup read; `purpose.md`'s
 * heading is prose. A Wiki with a missing or hand-edited purpose file must
 * still be renameable, so a surprise here is warned about and the rename
 * stands. Only a LEADING `# …` line is replaced — anything else is left exactly
 * as the owner wrote it rather than guessed at.
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
  const parsed = parseWikiName(name);
  return withFileLock(wikiLockKey(owner), async () => {
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
 * AN EMPTY REGISTRY SWEEPS NOTHING. `readRegistry` degrades a missing or
 * unparseable `wikis.json` to {@link emptyRegistry}, so "no entries, but
 * directories on disk" is indistinguishable from "the registry was lost or is
 * half-restored" — and against that state every Wiki the tenant has is an
 * orphan. It also cannot be the legitimate post-delete state: the current Wiki
 * is undeletable, so a delete never empties the registry. Bailing out costs a
 * genuinely-empty tenant one skipped no-op; not bailing out costs a tenant with
 * a lost registry every artifact it owns.
 */
async function sweepOrphans(owner: string, registry: WikiRegistry): Promise<number> {
  if (registry.wikis.length === 0) {
    logger.warn(
      "wikis",
      "skipping the orphan sweep: the registry names no wikis, which is a lost or unreadable wikis.json as often as it is an empty tenant — and a sweep against that would delete every wiki directory on disk",
    );
    return 0;
  }
  const known = new Set(registry.wikis.map((wiki) => wiki.id));
  const entries = await getStorage().listFiles(wikisRootPath(owner));
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory) continue;
    if (!WIKI_ID_RE.test(entry.name)) continue;
    if (known.has(entry.name)) continue;
    await getStorage().deleteDirectory(wikiDirPath(owner, entry.name));
    removed += 1;
    logger.warn(
      "wikis",
      `removed orphaned wiki directory "${entry.name}" — no registry entry referenced it`,
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
 * and is exported here, taking the lock itself, so it is directly testable and
 * callable by a future maintenance task.
 */
export async function sweepOrphanWikiDirectories(owner: string): Promise<number> {
  return withFileLock(wikiLockKey(owner), async () =>
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
  return withFileLock(wikiLockKey(owner), async () => {
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
 * argument. work-wiki is a single-owner deployment, so the owner is resolved
 * from `NEXT_PUBLIC_OWNER_HANDLE`; with no owner, no Wiki, or any read
 * failure this returns null and the caller falls back to the repo-root
 * `SCHEMA.md`.
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
