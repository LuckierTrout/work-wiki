/**
 * Where one Wiki's files live, and the single lock key that owns them.
 *
 * This module is a LEAF on purpose. `wikis.ts` imports `workspace-profile.ts`
 * (the seeder writes the profile), so the profile store cannot import `wikis.ts`
 * back to learn the Wiki's directory or its lock key without closing a cycle.
 * Both modules import these helpers instead, which keeps the layering strict:
 *
 *   wiki-paths → workspace-profile → workspace-guidance
 *              ↘ wikis ↗
 *
 * Nothing here reads or writes storage, and nothing here imports a module that
 * does — keep it that way, or the cycle comes back through the side door.
 */

import { ClientInputError } from "./errors";
import { tenantForOwner, validateTenant } from "./wiki";
import type { WikiArtifactFile } from "./wiki-scenarios";

function tenantFor(owner: string | null | undefined): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return tenant;
}

/**
 * Guard a Wiki id before it becomes a storage key. Ids are generated with
 * `crypto.randomUUID()`, but the id also arrives from a URL segment, so the
 * shape is enforced rather than assumed.
 */
export const WIKI_ID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function validateWikiId(id: unknown): string {
  if (typeof id !== "string" || !WIKI_ID_RE.test(id)) {
    throw new ClientInputError("Invalid wiki id.");
  }
  return id;
}

/**
 * `tenants/<tenant>/wikis/<wikiId>` — everything that belongs to ONE Wiki.
 *
 * `purpose.md`, `schema.md` and `workspace-profile.json` are all siblings in
 * here, which is what makes {@link wikiLockKey} sufficient to serialize them.
 */
export function wikiDirPath(owner: string, wikiId: string): string {
  return `tenants/${tenantFor(owner)}/wikis/${validateWikiId(wikiId)}`;
}

/** `tenants/<tenant>/wikis/<wikiId>/<file>` — a seeded Wiki artifact. */
export function wikiArtifactPath(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): string {
  return `${wikiDirPath(owner, wikiId)}/${file}`;
}

/**
 * `wikis:<tenant>` — the ONE lock key for Wiki state.
 *
 * It covers `tenants/<t>/wikis.json` AND everything under
 * `tenants/<t>/wikis/<id>/`, including each Wiki's `workspace-profile.json`.
 * `withFileLock` is not reentrant, so code that already holds this key must
 * write through an unlocked internal putter rather than taking it again; see
 * the header of `src/lib/lock.ts` for the full ordering rule.
 */
export function wikiLockKey(owner: string): string {
  return `wikis:${tenantFor(owner)}`;
}
