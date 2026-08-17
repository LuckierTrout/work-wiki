/**
 * The Workspace Purpose profile — owner-authored direction for generated work.
 *
 * The profile is PER WIKI. It lives at
 * `tenants/<t>/wikis/<wikiId>/workspace-profile.json`, a sibling of that Wiki's
 * `purpose.md` and `schema.md`, so creating or re-templating one Wiki cannot
 * overwrite a purpose hand-authored for another and switching the active Wiki
 * swaps which profile is live instead of rewriting a shared one.
 *
 * It is deliberately NOT a member of `WIKI_ARTIFACT_FILES`: that list drives the
 * Files-tab tree and the dialog copy, and a JSON store is not one of the owner's
 * editable markdown artifacts.
 *
 * Which Wiki's profile is live is answered by `workspace-guidance.ts`, not here
 * — this module must not import `wikis.ts` (see `wiki-paths.ts` for the cycle).
 */

import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { wikiLockKey, wikiProfilePath } from "./wiki-paths";
import {
  EMPTY_WORKSPACE_PROFILE,
  parseWorkspaceProfileInput,
  workspaceProfileHasGuidance,
  type WorkspaceProfileInput,
} from "./workspace-profile-schema";

export interface WorkspaceProfile extends WorkspaceProfileInput {
  version: 1;
  createdAt: string | null;
  updatedAt: string | null;
}

const MAX_PROMPT_CHARS = 20_000;

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

/**
 * The retired tenant-global singleton. Kept as a READ-ONLY fallback address —
 * nothing in this module ever writes or deletes it.
 *
 * The LIVE address is `wikiProfilePath(owner, wikiId)` from `wiki-paths.ts`,
 * not a literal here: `wikis.ts` snapshots and restores the same file when a
 * re-template fails, and one expression is what keeps the two in step.
 */
function legacyProfilePath(owner: string): string {
  return `tenants/${tenant(owner)}/workspace-profile.json`;
}

export function emptyWorkspaceProfile(): WorkspaceProfile {
  return {
    version: 1,
    ...EMPTY_WORKSPACE_PROFILE,
    keyQuestions: [],
    inScope: [],
    outOfScope: [],
    createdAt: null,
    updatedAt: null,
  };
}

function toProfile(raw: string): WorkspaceProfile {
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return emptyWorkspaceProfile();
  }
  const record = parsed as Record<string, unknown>;
  const cleaned = parseWorkspaceProfileInput(record);
  return {
    version: 1,
    ...cleaned,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

/** This Wiki's OWN file, or null when it has never been written. */
async function readOwnProfile(
  owner: string,
  wikiId: string,
): Promise<WorkspaceProfile | null> {
  try {
    return toProfile(await getStorage().readFile(wikiProfilePath(owner, wikiId)));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/**
 * The retired tenant-global profile, or null when there is nothing usable there.
 *
 * NEVER THROWS for a bad file. Absent, unreadable (a directory in its place) and
 * unparseable all answer null, because this address is a read-only migration
 * courtesy and nothing that degrades may take a caller down with it. It once
 * sat on the WRITE path too — `putWorkspaceProfile` consulted it for `createdAt`
 * until that was corrected — and a throw there rejected `createWiki` and
 * `applyScenarioTemplate` for the whole tenant. It reads for {@link
 * getWorkspaceProfile}, the Settings GET and `workspace-guidance.ts` now, where
 * a throw would 500 the page or fail an ingest turn instead. The warn is what
 * keeps "we ignored your old purpose" from being silent.
 *
 * Exported for the two surfaces that have no `wikiId` to key a read on — see
 * {@link getWorkspaceProfile} and `workspace-guidance.ts`.
 */
export async function readLegacyTenantProfile(
  owner: string,
): Promise<WorkspaceProfile | null> {
  let raw: string;
  try {
    raw = await getStorage().readFile(legacyProfilePath(owner));
  } catch (error) {
    if (isEnoent(error)) return null;
    logger.warn(
      "workspace-profile",
      `the legacy tenant-global profile for "${owner}" could not be read — ignoring it`,
      error,
    );
    return null;
  }
  try {
    return toProfile(raw);
  } catch (error) {
    logger.warn(
      "workspace-profile",
      `the legacy tenant-global profile for "${owner}" is not usable JSON — ignoring it`,
      error,
    );
    return null;
  }
}

/**
 * This Wiki's stored profile, or an empty one when it has never been saved.
 *
 * READ PATH ONLY: a Wiki with no file of its own reads through to the retired
 * tenant-global singleton, so a purpose hand-authored before per-Wiki profiles
 * is not silently lost at deploy. The next save writes the per-Wiki file and the
 * fallback stops being reached for that Wiki. Never written, never deleted — and
 * deliberately NOT consulted by {@link putWorkspaceProfile}, which would
 * otherwise stamp a Wiki created today with the legacy `createdAt`.
 */
export async function getWorkspaceProfile(
  owner: string,
  wikiId: string,
): Promise<WorkspaceProfile> {
  return (
    (await readOwnProfile(owner, wikiId)) ??
    (await readLegacyTenantProfile(owner)) ??
    emptyWorkspaceProfile()
  );
}

/**
 * The profile BYTES for one Wiki, and nothing else — no lock.
 *
 * UNLOCKED on purpose, in the same shape as `putWikiArtifact` in `wikis.ts`: the
 * seeder runs inside `withFileLock(wikiLockKey(owner))` already and
 * `withFileLock` is NOT reentrant, so taking `wikis:<tenant>` again from in
 * there would deadlock the whole tenant. Callers that are not already holding
 * the Wiki lock use {@link saveWorkspaceProfile}.
 *
 * Reads THIS Wiki's own file for `createdAt`, not {@link getWorkspaceProfile}:
 * the legacy read-through belongs to the read path alone, or a Wiki created
 * today in a tenant that still has the retired singleton would be stamped with
 * that file's creation date.
 */
export async function putWorkspaceProfile(
  owner: string,
  wikiId: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  const cleaned = parseWorkspaceProfileInput(input);
  const existing = await readOwnProfile(owner, wikiId);
  const now = new Date().toISOString();
  const profile: WorkspaceProfile = {
    version: 1,
    ...cleaned,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  await getStorage().writeFile(
    wikiProfilePath(owner, wikiId),
    JSON.stringify(profile, null, 2),
  );
  return profile;
}

/**
 * Save this Wiki's profile under the Wiki lock.
 *
 * The key is `wikis:<tenant>` — the same one the registry and the seeded
 * artifacts take — so a Settings save can no longer interleave with a create or
 * a re-template and leave `schema.md` naming one template while the profile
 * names another.
 */
export async function saveWorkspaceProfile(
  owner: string,
  wikiId: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  // Parse before the lock so rejected input never waits on, or enters, it.
  const cleaned = parseWorkspaceProfileInput(input);
  return withFileLock(wikiLockKey(owner), () =>
    putWorkspaceProfile(owner, wikiId, cleaned),
  );
}

export function renderWorkspaceGuidance(profile: WorkspaceProfileInput): string {
  if (!workspaceProfileHasGuidance(profile)) return "";
  const lines = [
    "WORKSPACE PURPOSE",
    "Use this owner-authored profile to decide what matters, how to organize generated knowledge, and what to leave out. It guides prioritization but never overrides source evidence, privacy rules, or required citations. Do not alter quotations or claim the source said something merely because the profile asks about it.",
    profile.purpose ? `Purpose:\n${profile.purpose}` : "",
    profile.keyQuestions.length
      ? `Key questions:\n${profile.keyQuestions.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.inScope.length
      ? `In scope:\n${profile.inScope.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.outOfScope.length
      ? `Out of scope:\n${profile.outOfScope.map((item) => `- ${item}`).join("\n")}`
      : "",
    profile.outputLanguage ? `Preferred output language: ${profile.outputLanguage}` : "",
    profile.pageConventions ? `Page conventions:\n${profile.pageConventions}` : "",
  ].filter(Boolean);
  return lines.join("\n\n").slice(0, MAX_PROMPT_CHARS);
}
