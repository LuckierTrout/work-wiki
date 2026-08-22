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
 * THE RETIRED TENANT-GLOBAL SINGLETON IS NOT SPELLED HERE (DW-137). This module
 * once read through from a Wiki's own file to that singleton and only then to
 * empty, which made one pre-split purpose appear under EVERY Wiki that had
 * never saved its own, with no end date and no removal milestone. It is now a
 * BACKFILL instead: `workspace-profile-backfill.ts` owns the legacy address,
 * copies its bytes onto each Wiki that lacks a file of its own (through
 * {@link copyWorkspaceProfileIfAbsent}) and then removes it. So no live read
 * path — this module, `GET /api/workspace-profile`, `workspace-guidance.ts` —
 * knows that address any more, and retiring the migration later is one file
 * delete.
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

/**
 * Stored bytes → a profile. THREE outcomes, not two.
 *
 *   - A JSON OBJECT the schema accepts → that profile.
 *   - VALID JSON THAT IS NOT AN OBJECT (`[]`, `null`, `42`, `"text"`) → an
 *     EMPTY profile, RETURNED rather than thrown. There is no field to
 *     recover and nothing to warn twice about; the caller wanted "what does
 *     this Wiki have", and the answer is "nothing usable".
 *   - ANYTHING ELSE → a throw. Two rejections reach callers this way and they
 *     treat them alike, because they are the same fact about the file:
 *     `JSON.parse` refusing the bytes, and {@link parseWorkspaceProfileInput}
 *     refusing what they decode to (a retired `scenario` name, a
 *     `keyQuestions` that is not a list). Neither is fixable by reading again.
 *
 * THE SECOND OUTCOME IS WHY A CALLER MAY NEED MORE THAN THIS FUNCTION. It suits
 * {@link readOwnProfile}, whose caller is about to overwrite the file anyway.
 * It does NOT suit a caller deciding whether a file is worth relocating —
 * `workspace-profile-backfill.ts` reads the retired tenant-global address this
 * module no longer knows, and an empty profile there is truthy, so it decodes
 * the JSON itself before delegating here. Exported for that caller: one parser
 * is what keeps the two addresses agreeing on what a valid profile looks like.
 */
export function parseStoredWorkspaceProfile(raw: string): WorkspaceProfile {
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
 * NULL IS THE "LACKS ITS OWN PROFILE" PREDICATE, and it is the only thing that
 * distinguishes a Wiki the backfill may write from one it must leave alone —
 * see {@link copyWorkspaceProfileIfAbsent}.
 *
 * READ AND PARSE ARE SPLIT, and the two failures answer differently (DW-144).
 *
 *   - ENOENT → `null`, meaning "no file of its own".
 *   - UNUSABLE bytes → a warn and an EMPTY profile. Unusable covers BOTH
 *     failures {@link parseStoredWorkspaceProfile} can raise, because both are
 *     the same fact about the file and neither is fixable by reading it again:
 *     `JSON.parse` rejecting the bytes, and `parseWorkspaceProfileInput`
 *     rejecting what they decode to (a retired `scenario` name, a
 *     `keyQuestions` that is not a list). Bytes that parse but are not an
 *     OBJECT at all — a JSON array where a profile belongs — arrive as an empty
 *     profile from the parser itself rather than as a throw, so they land on
 *     this same answer by a quieter route.
 *     A corrupt file is recoverable by the very write that was about to
 *     overwrite it, and rethrowing here blocked that write — {@link
 *     putWorkspaceProfile} reads this for `createdAt`, so a bad file rejected
 *     the re-template and the Settings save that would have replaced it. Empty
 *     rather than `null` on purpose: this Wiki HAS a file, so "unknowable
 *     `createdAt`" correctly becomes "stamp now" — and the backfill must not
 *     mistake corrupt bytes for an absent file and overwrite them.
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
    return parseStoredWorkspaceProfile(raw);
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
 * This Wiki's stored profile, or an empty one when it has never been saved.
 *
 * THIS WIKI'S FILE AND NOTHING ELSE (DW-137). There was a second link in this
 * chain — a read-through to the retired `tenants/<t>/workspace-profile.json` —
 * so a Wiki that had never saved a profile rendered a purpose authored for a
 * different era of the tenant, under every such Wiki, with no end date. The
 * relocation is a one-time backfill now (`workspace-profile-backfill.ts`), so
 * what a Wiki reads is what a Wiki was written, and a Wiki with no file reads
 * as empty rather than borrowing.
 *
 * A Wiki whose own file is UNUSABLE — unparseable, or rejected by the profile
 * schema — answers empty from {@link readOwnProfile} too, but for its own
 * reason; see that function for the degradation rule.
 */
export async function getWorkspaceProfile(
  owner: string,
  wikiId: string,
): Promise<WorkspaceProfile> {
  return (await readOwnProfile(owner, wikiId)) ?? emptyWorkspaceProfile();
}

/**
 * Copy a profile onto a Wiki that has NO file of its own — the one write the
 * DW-137 backfill makes, and nothing else.
 *
 * WRITES ONLY INTO A GAP. A Wiki whose own file exists is left exactly as it
 * is, usable or not: {@link readOwnProfile} answers `null` for ENOENT alone,
 * so corrupt bytes read as an EMPTY profile and this refuses to overwrite them.
 * That is deliberate — corrupt bytes are the owner's, and the migration's job
 * is to fill an absence, not to adjudicate a damaged file.
 *
 * THE PROFILE IS CARRIED OVER WHOLE, TIMESTAMPS INCLUDED. Unlike {@link
 * putWorkspaceProfile} this stamps nothing: the backfill RELOCATES a profile
 * the owner already authored, so re-dating it `createdAt: now` would erase when
 * it was actually written and make a decade-old purpose look like today's save.
 *
 * What lands is the parsed profile re-serialized, not the source file's bytes:
 * every schema field plus `createdAt`/`updatedAt` survives, while keys the
 * schema does not know are dropped and key order is normalized — the same
 * treatment an ordinary save gives the same file.
 *
 * Guarded exactly like {@link putWorkspaceProfile}: a {@link WikiLockHeld}
 * minted for THIS owner, then the read-only refusal, both before a byte moves.
 * The lock is taken ONCE for the whole pass and this token threaded per Wiki,
 * because `withFileLock` is not reentrant.
 *
 * @returns whether it wrote — the backfill's per-Wiki count.
 */
export async function copyWorkspaceProfileIfAbsent(
  held: WikiLockHeld,
  owner: string,
  wikiId: string,
  profile: WorkspaceProfile,
): Promise<boolean> {
  assertWikiLockHeld(held, owner);
  assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
  if ((await readOwnProfile(owner, wikiId)) !== null) return false;
  await getStorage().writeFile(
    wikiProfilePath(owner, wikiId),
    JSON.stringify(profile, null, 2),
  );
  return true;
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
 * Reads THIS Wiki's own file for `createdAt`, which since DW-137 is the same
 * file {@link getWorkspaceProfile} reads — the distinction mattered while a
 * read-through existed, because consulting the composed reader stamped a Wiki
 * created today with the retired singleton's creation date. An UNUSABLE own
 * file reads as empty rather than throwing, so this write is exactly what
 * repairs it.
 *
 * STAMPS, WHERE {@link copyWorkspaceProfileIfAbsent} DOES NOT: this is an
 * owner's save, so `updatedAt` is now; the backfill is a relocation, so it
 * preserves what it moves.
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
