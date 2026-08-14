/**
 * The public **commons** — a derived index of every PUBLIC page across all
 * tenants (tenant-silos groundwork; see work-wiki-concept.md). In the per-tenant
 * model each page lives in its owner's silo and the commons is *not* separate
 * storage but this persisted index over the public ones.
 *
 * RETIRED (AD-21): the commons product surface is gone. `syncCommonsForPage` is
 * a no-op, so the persisted index is no longer refreshed on the write path, and
 * `listCommonsPages` always derives from the live wiki index rather than reading
 * it. The module and its storage helpers stay on disk for the callers that later
 * epics still need (`belongsInCommons`, `listCommonsPages`); any stored index
 * left over from before the retirement is inert.
 */

import { getStorage } from "./storage";
import { withFileLock } from "./lock";
import { listWikiPages, isAgentScopedType, isArtifactType, tenantForOwner } from "./wiki";
import { logger } from "./logger";
import type { IndexEntry } from "./types";

/** KV/derived-index key (resolves to `_idx:commons` on R2, a JSON file on fs). */
const COMMONS_KEY = "commons";
/** Single global lock — commons writes are cross-tenant. */
const COMMONS_LOCK = "commons-index";

/** One public page in the commons, addressed by `(tenant, slug)`. */
export interface CommonsEntry {
  /** Lowercased owner handle — the storage key + silo identity. */
  tenant: string;
  /** Original-case owner handle for display (`tenant` is the normalized key). */
  owner?: string;
  slug: string;
  title: string;
  summary: string;
  tags?: string[];
  updated?: string;
  sourceCount?: number;
  confidence?: number;
  type?: string;
}

/**
 * A page belongs in the commons iff it's public, not agent-scoped, and not a
 * rendered artifact (e.g. a saved `html` query output — a personal artifact, not
 * collective knowledge; see {@link isArtifactType}).
 */
export function belongsInCommons(meta: {
  visibility?: string;
  type?: string;
}): boolean {
  return (
    meta.visibility !== "private" &&
    !isAgentScopedType(meta.type) &&
    !isArtifactType(meta.type)
  );
}

/**
 * A page may be CURATED into a vault iff it's public and not agent-scoped.
 * Unlike {@link belongsInCommons}, artifacts (rendered `html`/`slides` outputs)
 * ARE eligible — a vault can collect them for Browse (they remain excluded from
 * Query/Graph retrieval, which is keyed on knowledge pages). Private pages stay
 * excluded: a vault references pages by slug, so a private one would leak.
 */
export function isVaultEligible(meta: {
  visibility?: string;
  type?: string;
}): boolean {
  return meta.visibility !== "private" && !isAgentScopedType(meta.type);
}

/**
 * Read the full commons index (empty array when absent). Fail-soft: a missing
 * or corrupt index returns `[]` so reads fall back to deriving the public set
 * rather than crashing a page render.
 */
export async function getCommonsIndex(): Promise<CommonsEntry[]> {
  try {
    const idx = await getStorage().getIndex<CommonsEntry[]>(COMMONS_KEY);
    return Array.isArray(idx) ? idx : [];
  } catch (err) {
    logger.warn("commons", "commons index unreadable; treating as empty:", err);
    return [];
  }
}

/**
 * The set of slugs that live in the PUBLIC commons. Used by link resolution to
 * decide whether a target resolves to the global `/wiki/<slug>` (public) vs the
 * owner-scoped `/u/<tenant>/<slug>`, and by the public route to gate which slugs
 * are even addressable globally. Fail-soft: a missing/corrupt index yields an
 * empty set (no slug is treated as commons), which is the SECURE default — link
 * resolution falls back to owner-scoped URLs rather than over-exposing.
 */
export async function getCommonsSlugSet(): Promise<Set<string>> {
  try {
    const entries = await getCommonsIndex();
    return new Set(entries.map((e) => e.slug));
  } catch (err) {
    logger.warn("commons", "commons slug set unreadable; treating as empty:", err);
    return new Set();
  }
}

/**
 * The public, non-agent page set as {@link IndexEntry}[] — what the surviving
 * readers (`/wiki/graph`, `/wiki/log`, unscoped MCP `wiki_graph`, `browse.ts`,
 * `search.ts`) list.
 *
 * ALWAYS derived live from the flat wiki index. It used to prefer the stored
 * commons index and fall back to a scan only when that was empty, but
 * {@link syncCommonsForPage} is now a no-op (AD-21) while
 * {@link removeCommonsEntryBySlug} still runs on delete — so a populated
 * production index would freeze at its last synced state and then monotonically
 * shrink, and every reader above would serve a stale page set forever. Deriving
 * is O(index) and always current; the stored index survives only as data other
 * code may still repair or migrate.
 */
export async function listCommonsPages(): Promise<IndexEntry[]> {
  return (await listWikiPages()).filter((p) => belongsInCommons(p));
}

async function putCommonsIndex(entries: CommonsEntry[]): Promise<void> {
  await getStorage().putIndex(COMMONS_KEY, entries);
}

/** Insert or update a commons entry, keyed by `(tenant, slug)`. */
export async function upsertCommonsEntry(entry: CommonsEntry): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const i = entries.findIndex(
      (e) => e.tenant === entry.tenant && e.slug === entry.slug,
    );
    if (i === -1) entries.push(entry);
    else entries[i] = entry;
    await putCommonsIndex(entries);
  });
}

/** Remove a commons entry (no-op if absent). */
export async function removeCommonsEntry(
  tenant: string,
  slug: string,
): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const next = entries.filter(
      (e) => !(e.tenant === tenant && e.slug === slug),
    );
    if (next.length !== entries.length) await putCommonsIndex(next);
  });
}

/**
 * Remove any commons entry for a slug regardless of tenant. Safe while slugs
 * are globally unique (pre-migration); used by the delete path where the
 * owner may not be readily available.
 */
export async function removeCommonsEntryBySlug(slug: string): Promise<void> {
  await withFileLock(COMMONS_LOCK, async () => {
    const entries = await getCommonsIndex();
    const next = entries.filter((e) => e.slug !== slug);
    if (next.length !== entries.length) await putCommonsIndex(next);
  });
}

/**
 * Sync one page into/out of the commons after a write.
 *
 * RETIRED (AD-21): the commons is no longer a product surface, so this performs
 * no storage I/O — it neither reads nor writes the commons index. The signature
 * and the `lifecycle.ts` call site are deliberately unchanged so the write
 * path's shape stays stable for Epic 2; it resolves and never throws.
 */
export async function syncCommonsForPage(
  _slug: string,
  _meta: {
    owner?: string;
    visibility?: string;
    type?: string;
    title: string;
    summary: string;
    tags?: string[];
    updated?: string;
    sourceCount?: number;
    confidence?: number;
  },
): Promise<void> {
  // Intentionally does nothing.
}

/**
 * Rebuild the entire commons index from the current (flat) wiki index. Used by
 * the migration and as a repair tool. Scans every page, keeps the public,
 * non-agent ones, and replaces the stored index in one write.
 */
export async function rebuildCommonsIndex(): Promise<number> {
  const pages = await listWikiPages();
  const entries: CommonsEntry[] = pages
    .filter((p) => belongsInCommons(p))
    .map((p) => ({
      tenant: tenantForOwner(p.owner),
      owner: p.owner?.trim() || undefined,
      slug: p.slug,
      title: p.title,
      summary: p.summary,
      tags: p.tags,
      updated: p.updated,
      sourceCount: p.sourceCount,
      confidence: p.confidence,
      type: p.type,
    }));
  await withFileLock(COMMONS_LOCK, async () => {
    await putCommonsIndex(entries);
  });
  return entries.length;
}
