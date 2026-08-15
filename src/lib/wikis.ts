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
 * `purpose.md`, `schema.md`, and the workspace profile, and nothing else. The
 * profile write is what makes a seeded template reach the seven prompt sites
 * that consume `buildWorkspaceGuidance(owner)`.
 *
 * The registry idiom (path, lock key, `crypto.randomUUID()`, ENOENT → empty,
 * a hard cap) mirrors `research-projects.ts`.
 */

import { ClientInputError, isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { getOwnerHandle } from "./owner";
import { readEnginePageConventions } from "./schema-source";
import { getStorage } from "./storage";
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
  type WikiArtifactFile,
} from "./wiki-scenarios";
import { tenantForOwner, validateTenant } from "./wiki";
import { saveWorkspaceProfile } from "./workspace-profile";
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

/**
 * Guard a Wiki id before it becomes a storage key. Ids are generated with
 * `crypto.randomUUID()`, but the id also arrives from a URL segment, so the
 * shape is enforced rather than assumed.
 */
const WIKI_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

function validateWikiId(id: unknown): string {
  if (typeof id !== "string" || !WIKI_ID_RE.test(id)) {
    throw new ClientInputError("Invalid wiki id.");
  }
  return id;
}

/** `tenants/<tenant>/wikis/<wikiId>/<file>` — a seeded Wiki artifact. */
export function wikiArtifactPath(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): string {
  return `tenants/${tenantFor(owner)}/wikis/${validateWikiId(wikiId)}/${file}`;
}

function lockKey(owner: string): string {
  return `wikis:${tenantFor(owner)}`;
}

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

/** Parse a create-Wiki body: a non-blank name of at most 80 chars, plus a scenario. */
export function parseCreateWikiInput(value: unknown): CreateWikiInput {
  const scenario = parseScenarioInput(value);
  const raw = asObject(value).name;
  if (typeof raw !== "string") {
    throw new ClientInputError("Wiki name must be text.");
  }
  const name = raw.trim().replace(/\s+/g, " ");
  if (!name) throw new ClientInputError("Wiki name is required.");
  if (name.length > MAX_WIKI_NAME_CHARS) {
    throw new ClientInputError(
      `Wiki name must be ${MAX_WIKI_NAME_CHARS} characters or fewer.`,
    );
  }
  return { name, scenario };
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
 * Write the two artifacts and the workspace profile for `wiki`.
 *
 * This is the whole footprint of create and of re-template: nothing under
 * `tenants/<t>/wiki/`, nothing under `tenants/<t>/raw/`, no page index entry,
 * no log line.
 */
async function seedWikiArtifacts(owner: string, wiki: WikiRecord): Promise<void> {
  const template = scenarioTemplate(wiki.scenario);
  // The seeded Schema embeds the engine's own page conventions ahead of the
  // scenario's, so the Wiki's file IS the whole executable Schema and
  // activating it never strips the structural contract from a prompt.
  const engineConventions = await readEnginePageConventions();
  const storage = getStorage();
  await storage.writeFile(
    wikiArtifactPath(owner, wiki.id, "purpose.md"),
    renderPurposeMarkdown(wiki.name, template),
  );
  await storage.writeFile(
    wikiArtifactPath(owner, wiki.id, "schema.md"),
    renderSchemaMarkdown(template, engineConventions),
  );
  await saveWorkspaceProfile(owner, templateProfile(wiki.scenario));
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
  return withFileLock(lockKey(owner), async () => {
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
 * the workspace profile. Pages and Sources are untouched. Returns null when
 * the id is unknown, so the route can answer 404.
 */
export async function applyScenarioTemplate(
  owner: string,
  wikiId: string,
  scenario: CreatableScenario,
): Promise<WikiRecord | null> {
  if (!isCreatableScenario(scenario)) {
    throw new ClientInputError("Choose one Scenario Template.");
  }
  return withFileLock(lockKey(owner), async () => {
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
 * Also re-seeds the workspace profile from the newly active Wiki's scenario.
 * The profile is tenant-global while `schema.md` is per-Wiki, so moving the
 * pointer alone would leave `loadPageConventions()` on the new template and
 * `buildWorkspaceGuidance(owner)` on whichever Wiki was created or
 * re-templated last — the ingest prompt would then carry both at once.
 */
export async function setCurrentWiki(
  owner: string,
  wikiId: string,
): Promise<WikiRecord | null> {
  return withFileLock(lockKey(owner), async () => {
    const registry = await readRegistry(owner);
    const wiki = registry.wikis.find((item) => item.id === wikiId);
    if (!wiki) return null;
    const previousId = registry.currentId;
    registry.currentId = wiki.id;
    await writeRegistry(owner, registry);
    try {
      await saveWorkspaceProfile(owner, templateProfile(wiki.scenario));
    } catch (error) {
      // The pointer has already moved, so leaving it there ships exactly the
      // split this function exists to prevent: `loadPageConventions()` on the
      // newly active Wiki's `schema.md` while `buildWorkspaceGuidance()` still
      // renders the old template — and the route answers 500, so the owner is
      // told the switch failed and the UI rolls its selection back. Put the
      // pointer back before rethrowing, inside the same lock.
      registry.currentId = previousId;
      try {
        await writeRegistry(owner, registry);
      } catch (restoreError) {
        logger.warn(
          "wikis",
          `restoring the active wiki after a failed switch failed — the pointer is on "${wiki.id}" while the workspace profile is not`,
          restoreError,
        );
      }
      throw error;
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
