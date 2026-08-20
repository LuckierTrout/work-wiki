/**
 * The DW-137 migration, whole — the retired tenant-global Workspace Purpose
 * relocated onto the Wikis that lack one, then removed.
 *
 * WHAT THIS REPLACES. `getWorkspaceProfile` used to chain
 * `readOwnProfile ?? readLegacyTenantProfile ?? empty`, so in a tenant holding
 * `tenants/<t>/workspace-profile.json` ONE pre-split purpose rendered under
 * every Wiki that had never saved its own — forever, with no backfill and no
 * removal milestone. A read-through is a courtesy that never ends; a backfill
 * ends. This module copies the bytes where they belong and deletes the original,
 * and the read paths simply read a Wiki's own file.
 *
 * ONE MODULE FOR THE WHOLE MIGRATION, so retiring it later is one delete. The
 * legacy address is spelled HERE and nowhere else — `workspace-profile.ts` no
 * longer knows it, and `wiki-schema-edit.test.ts` pins that split by counting
 * the literal in both files.
 *
 * WHY IT IS ITS OWN MODULE RATHER THAN A FUNCTION IN ONE OF THEM. It needs
 * `listWikis` AND the profile store, and `wikis.ts` already imports
 * `workspace-profile.ts` (the seeder writes the profile), so neither of them
 * can host it without closing an import cycle. It sits above both, for the same
 * reason `workspace-guidance.ts` does — see the layering diagram in
 * `wiki-paths.ts`.
 *
 * FAIL-SOFT END TO END. Its only scheduled caller is the maintenance scan, and
 * a migration courtesy must never be the reason a scan fails: a read-only
 * deployment, an unusable legacy file, an empty registry and a per-Wiki write
 * failure all answer a COUNT with a warn rather than a throw.
 *
 * THE LOCK IS TAKEN ONCE for the whole pass and the token threaded per Wiki,
 * because `withFileLock` is not reentrant — taking `wikis:<tenant>` again from
 * inside the loop would deadlock the tenant.
 */

import { isEnoent } from "./errors";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { withWikiLock } from "./wiki-lock";
import { listWikis } from "./wikis";
import {
  copyWorkspaceProfileIfAbsent,
  parseStoredWorkspaceProfile,
  type WorkspaceProfile,
} from "./workspace-profile";

/**
 * The retired tenant-global singleton — the ONE place this address is spelled.
 *
 * It is not in `wiki-paths.ts` with the live addresses on purpose: nothing
 * outside this migration may address it, and a helper on the shared leaf is an
 * invitation to read through to it again.
 */
function legacyProfilePath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/workspace-profile.json`;
}

/**
 * The retired tenant-global profile, or null when there is nothing usable there.
 *
 * NEVER THROWS. Absent, unreadable (a directory in its place) and unusable
 * (unparseable, not a JSON object, or rejected by the profile schema) all
 * answer null, because this address is a retired one and nothing that degrades
 * may take a scan down with it. The warn is what keeps "we ignored your old
 * purpose" from being silent — and, on the unusable branch, what tells the
 * owner why their file is still sitting there after a scan.
 *
 * "NOT AN OBJECT" IS THIS FUNCTION'S OWN CHECK, and it is load-bearing.
 * {@link parseStoredWorkspaceProfile} answers `[]`, `null`, `42` and `"text"`
 * with an EMPTY profile rather than a throw — correct for `readOwnProfile`,
 * whose caller is about to overwrite the file anyway, and catastrophic here: an
 * empty profile is truthy, so the backfill would write blank bytes onto every
 * profile-less Wiki and then DELETE the legacy file, destroying whatever the
 * owner actually wrote. A migration that cannot read its source must leave the
 * source alone. The JSON is therefore decoded here first, and the shared parser
 * is still what turns usable bytes into a profile so the two addresses agree on
 * what a valid one looks like. The second `JSON.parse` costs one small file per
 * scan, once.
 */
async function readLegacyTenantProfile(
  owner: string,
): Promise<WorkspaceProfile | null> {
  let raw: string;
  try {
    raw = await getStorage().readFile(legacyProfilePath(owner));
  } catch (error) {
    if (isEnoent(error)) return null;
    logger.warn(
      "workspace-profile-backfill",
      `the legacy tenant-global profile for "${owner}" could not be read — leaving it alone`,
      error,
    );
    return null;
  }
  try {
    const decoded: unknown = JSON.parse(raw);
    if (!decoded || typeof decoded !== "object" || Array.isArray(decoded)) {
      throw new TypeError("the legacy profile does not decode to a JSON object");
    }
    return parseStoredWorkspaceProfile(raw);
  } catch (error) {
    logger.warn(
      "workspace-profile-backfill",
      `the legacy tenant-global profile for "${owner}" is not usable (unparseable, not a JSON object, or rejected by the profile schema) — leaving it alone`,
      error,
    );
    return null;
  }
}

/**
 * Copy the legacy profile onto every Wiki that has none of its own, then remove
 * it. Returns how many Wikis were written — 0 whenever there is nothing to do.
 *
 * IDEMPOTENT. A Wiki that already has a file — including a corrupt one — is
 * skipped, so re-running never overwrites anything, and a pass that relocated
 * the file ends with nothing left to read. A tenant whose Wikis ALL had their
 * own profiles is the case that does not settle: nothing is copied, so by the
 * rule below the file is never deleted and every scan re-reads it. That is one
 * small read per scan, and the alternative — deleting bytes no Wiki carries —
 * is the one outcome this must not produce.
 *
 * THE DELETE IS THE REMOVAL MILESTONE DW-137 LACKED, and it is deliberately
 * conservative: the file is removed only after a pass that COPIED at least one
 * Wiki with NO failures.
 *
 *   - Nothing copied means no Wiki carries these bytes — an empty registry, or
 *     a tenant whose Wikis all have their own files (the corrupt one included).
 *     Deleting then would destroy the owner's authored purpose outright, with
 *     no copy anywhere, which is the one outcome a migration must not produce.
 *   - A per-Wiki failure means SOME Wiki that wanted the bytes did not get
 *     them, so the file stays for the next scan to finish the job.
 *
 * Keeping it costs one read a scan. Deleting it wrongly is unrecoverable.
 */
export async function backfillLegacyWorkspaceProfiles(
  owner: string,
): Promise<number> {
  // BEFORE THE LOCK and before the read, like every other gated writer
  // (DW-266): a refused pass must not queue behind the tenant's in-flight
  // operations to say so. It answers 0 rather than propagating, because the
  // caller is a scan that a read-only deployment must not fail — every OTHER
  // gated writer serves a caller that asked for the write and deserves the
  // refusal, while nobody asked for this one.
  try {
    assertWritable(READ_ONLY_REFUSAL.wikiFileWrite);
  } catch (error) {
    logger.warn(
      "workspace-profile-backfill",
      `this deployment is read-only — leaving the legacy tenant-global profile for "${owner}" where it is`,
      error,
    );
    return 0;
  }
  // OUTSIDE THE LOCK ON PURPOSE — the cheap "nothing to do" path. After a
  // completed migration this single missing-file read is the whole cost of the
  // step, and paying for `wikis:<tenant>` to learn that would put every scan in
  // the queue behind the tenant's real work.
  const legacy = await readLegacyTenantProfile(owner);
  if (!legacy) return 0;
  return withWikiLock(owner, async (held) => {
    // THE REGISTRY IS READ UNDER THE LOCK, so the set migrated is the set that
    // was there when the writes happened. Read before it, a `deleteWiki`
    // landing in between would hand this loop an id whose directory has just
    // been removed — and the copy would RE-CREATE that directory holding
    // nothing but a profile, an orphan for the sweep to reclaim carrying the
    // one file the sweep's grace window is least able to date.
    const wikis = await listWikis(owner);
    // An empty registry has nowhere to put the bytes, and the file is KEPT: the
    // owner's first Wiki is created with a profile of its own, but a later scan
    // is what decides that, not this one.
    if (wikis.length === 0) return 0;
    let copied = 0;
    let failed = 0;
    for (const wiki of wikis) {
      try {
        if (await copyWorkspaceProfileIfAbsent(held, owner, wiki.id, legacy)) {
          copied += 1;
        }
      } catch (error) {
        // One Wiki's storage failure is not the other Wikis' problem, and it is
        // certainly not the scan's. Counted, so the delete below knows the pass
        // was incomplete.
        failed += 1;
        logger.warn(
          "workspace-profile-backfill",
          `copying the legacy tenant-global profile onto wiki "${wiki.id}" failed — leaving it for the next scan`,
          error,
        );
      }
    }
    if (copied > 0 && failed === 0) {
      try {
        await getStorage().deleteFile(legacyProfilePath(owner));
      } catch (error) {
        // The copies landed, so the migration succeeded; a file that outlives
        // its own delete is re-read next scan, finds every Wiki already served,
        // and is simply left alone. Not worth failing anything over.
        if (!isEnoent(error)) {
          logger.warn(
            "workspace-profile-backfill",
            `removing the legacy tenant-global profile for "${owner}" failed — its bytes are already on every wiki that lacked one`,
            error,
          );
        }
      }
    }
    return copied;
  });
}
