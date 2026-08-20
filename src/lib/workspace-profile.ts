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
 *
 * WRITES ARE GUARDED TWICE. {@link putWorkspaceProfile} takes the lock KEY
 * covering this file (`wikis:<tenant>`) as a `WikiLockHeld` token minted by
 * `withWikiLock` — it does not take the lock itself, because the seeder that
 * calls it is already inside one and `withFileLock` is not reentrant — and both
 * it and {@link saveWorkspaceProfile} refuse on a read-only deployment. The
 * token is what makes "the caller already holds it" a compile error to get
 * wrong rather than a docblock request (DW-139); the refusal is what makes any
 * DIRECT LIBRARY CALLER — a CLI command, a future MCP tool — inherit what the
 * HTTP routes already answer (DW-266). Today the Settings route is the only
 * caller, so the refusal changes nothing the app does; it is there for the
 * caller added next.
 *
 * A CORRUPT OWN FILE IS NOT FATAL (DW-144). Bytes this module cannot turn into
 * a profile — unparseable, or parsed but rejected by the profile schema — read
 * as an empty profile with a warn, so the re-template or Settings save that
 * would have overwritten them is not blocked by them. Genuine read failures
 * still throw — see {@link readOwnProfile} for where that line sits and why.
 */

import { isEnoent } from "./errors";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { assertWikiLockHeld, withWikiLock, type WikiLockHeld } from "./wiki-lock";
import { wikiProfilePath } from "./wiki-paths";
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

/**
 * This Wiki's OWN file, or null when it has never been written.
 *
 * READ AND PARSE ARE SPLIT, and the two failures answer differently (DW-144).
 *
 *   - ENOENT → `null`, meaning "no file of its own": the ONE state that may
 *     read through to the retired tenant-global singleton.
 *   - UNUSABLE bytes → a warn and an EMPTY profile. Unusable covers BOTH
 *     failures {@link toProfile} can raise, because both are the same fact
 *     about the file and neither is fixable by reading it again: `JSON.parse`
 *     rejecting the bytes, and `parseWorkspaceProfileInput` rejecting what they
 *     decode to (a retired `scenario` name, a `keyQuestions` that is not a
 *     list, a JSON array where an object belongs). This is the same span
 *     {@link readLegacyTenantProfile}'s second `try` already covers, which is
 *     what keeps the two addresses degrading alike. A corrupt file is
 *     recoverable by the very write that was about to overwrite it, and
 *     rethrowing here blocked that write — {@link putWorkspaceProfile} reads
 *     this for `createdAt`, so a bad file rejected the re-template and the
 *     Settings save that would have replaced it. Empty rather than
 *     `null` on purpose: this Wiki HAS a file, so it must NOT inherit another
 *     Wiki-era profile from the legacy address, and "unknowable `createdAt`"
 *     correctly becomes "stamp now".
 *   - ANY OTHER read error → rethrown. A directory in the file's place or a
 *     storage outage is not fixed by writing, and reporting it as an empty
 *     Workspace Purpose would show the owner a blank purpose — and let a save
 *     stamp a fresh `createdAt` over a profile that is merely unreachable.
 */
async function readOwnProfile(
  owner: string,
  wikiId: string,
): Promise<WorkspaceProfile | null> {
  let raw: string;
  try {
    raw = await getStorage().readFile(wikiProfilePath(owner, wikiId));
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
  try {
    return toProfile(raw);
  } catch (error) {
    logger.warn(
      "workspace-profile",
      `the stored profile for wiki "${wikiId}" is unusable (unparseable, or rejected by the profile schema) — treating it as empty so the next save can replace it`,
      error,
    );
    return emptyWorkspaceProfile();
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
 *
 * ONLY "no file at all" reads through. A Wiki whose own file is UNUSABLE —
 * unparseable, or rejected by the profile schema — answers empty from
 * {@link readOwnProfile} rather than null, so it stops here instead of picking
 * up a tenant-global purpose that was never this Wiki's; see that function for
 * the rest of the degradation rule.
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
 * The profile BYTES for one Wiki, and nothing else — no lock TAKEN.
 *
 * UNLOCKED on purpose, in the same shape as `putWikiArtifact` in `wikis.ts`: the
 * seeder runs inside the Wiki lock already and `withFileLock` is NOT reentrant,
 * so taking `wikis:<tenant>` again from in there would deadlock the whole
 * tenant. Callers that are not already holding the Wiki lock use
 * {@link saveWorkspaceProfile}.
 *
 * BUT NOT UNGUARDED (DW-139). `held` is a {@link WikiLockHeld}, minted only by
 * `withWikiLock`, so "the caller is already holding it" is now proved by the
 * TYPE rather than asked for in this docblock — an unlocked caller cannot
 * produce one and fails to compile. {@link assertWikiLockHeld} adds the one
 * check the type cannot make: that the token was minted for THIS `owner`, not
 * another tenant's. Passing the token acquires nothing; the single
 * `withFileLock` call at the top of the operation is still the only hold.
 *
 * REFUSES ON A READ-ONLY DEPLOYMENT (DW-266), before the read and before the
 * write. Every HTTP door in front of it already gates, so this is a backstop
 * for a direct library caller — a CLI command, a future MCP tool — reaching it
 * with no route at all.
 *
 * Reads THIS Wiki's own file for `createdAt`, not {@link getWorkspaceProfile}:
 * the legacy read-through belongs to the read path alone, or a Wiki created
 * today in a tenant that still has the retired singleton would be stamped with
 * that file's creation date. An UNUSABLE own file reads as empty rather than
 * throwing, so this write is exactly what repairs it.
 */
export async function putWorkspaceProfile(
  held: WikiLockHeld,
  owner: string,
  wikiId: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  assertWikiLockHeld(held, owner);
  assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
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
 *
 * The key is taken through `withWikiLock`, which also mints the
 * {@link WikiLockHeld} {@link putWorkspaceProfile} demands — one spelling, so
 * no form exists that takes the lock without producing the proof.
 */
export async function saveWorkspaceProfile(
  owner: string,
  wikiId: string,
  input: WorkspaceProfileInput,
): Promise<WorkspaceProfile> {
  // BOTH REJECTIONS HAPPEN BEFORE THE LOCK, so neither a refused save nor an
  // invalid one ever waits on, or enters, `wikis:<tenant>` — and neither reads
  // the profile it was not going to replace.
  //
  // Read-only first (DW-266): the deployment's answer does not depend on the
  // input, so a read-only deployment says so rather than complaining about a
  // field. The putter below gates again; this gate is what keeps the refusal
  // off the lock.
  assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
  const cleaned = parseWorkspaceProfileInput(input);
  return withWikiLock(owner, (held) =>
    putWorkspaceProfile(held, owner, wikiId, cleaned),
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
