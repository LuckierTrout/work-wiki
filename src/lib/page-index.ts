/**
 * `_idx:pages` — a precomputed map of every page's enriched {@link IndexEntry}
 * metadata (tags / owner / type / visibility / updated / sourceCount / …). It
 * lets {@link listWikiPages} enrich entries with one derived-index read instead of reading
 * every page file (the O(pages) loop that dominated the article + silo pages).
 *
 * Same hardened pattern as the other derived indexes (`commons.ts`): fail-soft
 * reader that returns `null` when the key is ABSENT (callers fall back to the
 * per-page scan), incremental sync that NO-OPS until a rebuild seeds it (never
 * fabricate a partial map from one write), and a `rebuildPageIndex()` that
 * reconstructs from the authoritative {@link scanWikiPagesUncached}.
 *
 * The authoritative copy is a strongly consistent R2/file object; the legacy
 * KV index is mirrored during migration but is never preferred once that copy
 * exists. This index holds ALL pages (public, private, agent-scoped) — it's the raw
 * metadata layer; visibility filtering happens in `listReadableWikiPages`.
 */
import { getStorage } from "./storage";
import { withDurableLock } from "./lock";
import { logger } from "./logger";
import { isEnoent } from "./errors";
import { sourceSha256 } from "./source-sha256";
import type { IndexEntry } from "./types";

const PAGE_INDEX_KEY = "pages";
const PAGE_INDEX_LOCK = "page-index";
const PAGE_INDEX_PATH = "derived-indexes/pages.json";
const PAGE_INDEX_DIRTY_PATH = "derived-indexes/pages-dirty";
const CURRENT_DIRTY_MARKER = /^\.v2-[0-9a-f]{64}$/;
const PREVIOUS_DIRTY_MARKER = /^v2-[0-9a-f]{64}$/;

export type PageMetaIndex = Record<string, IndexEntry>;

async function dirtyMarkerPath(slug: string): Promise<string> {
  // A leading dot is outside the valid Page-slug namespace, so a current
  // marker can never collide with a legacy root marker whose filename was the
  // raw slug.
  return `${PAGE_INDEX_DIRTY_PATH}/.v2-${await sourceSha256(slug)}`;
}

async function previousDirtyMarkerPath(slug: string): Promise<string> {
  return `${PAGE_INDEX_DIRTY_PATH}/v2-${await sourceSha256(slug)}`;
}

export async function markPageIndexDirty(slug: string): Promise<void> {
  // The slug is the marker payload, not its filename. A fixed-length digest
  // keeps nested and long multibyte slugs below every provider's key/filename
  // component limit while remaining deterministic for clear-on-success.
  await getStorage().writeFile(await dirtyMarkerPath(slug), slug);
}

export async function clearPageIndexDirty(slug: string): Promise<void> {
  try {
    await getStorage().deleteFile(await dirtyMarkerPath(slug));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  // Previous-format root markers are intentionally retained during the rolling
  // window. Their filename is also a valid raw-slug marker, and Storage has no
  // compare-and-delete: an old writer could replace the payload between our
  // read and delete and lose a different Page's privacy fence. A later gated
  // migration can remove these only after old writers are drained.
  // Rolling compatibility for raw-slug markers written by the prior version.
  // Inspect the parent first: `queries` can be both a valid Page slug and the
  // directory holding a nested legacy marker, and unlinking that directory
  // must not turn a successful Page write into EISDIR.
  const slash = slug.lastIndexOf("/");
  const legacyParent = slash < 0
    ? PAGE_INDEX_DIRTY_PATH
    : `${PAGE_INDEX_DIRTY_PATH}/${slug.slice(0, slash)}`;
  const legacyLeaf = slash < 0 ? slug : slug.slice(slash + 1);
  const legacyEntry = (await getStorage().listFiles(legacyParent))
    .find((entry) => entry.name === legacyLeaf);
  if (legacyEntry && !legacyEntry.isDirectory) {
    try {
      const legacyPath = `${legacyParent}/${legacyLeaf}`;
      if (!(slash < 0 && PREVIOUS_DIRTY_MARKER.test(legacyLeaf))) {
        await getStorage().deleteFile(legacyPath);
      }
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

export async function getPageIndexDirtySlugs(): Promise<Set<string>> {
  try {
    const storage = getStorage();
    const slugs = new Set<string>();
    const collect = async (prefix: string, legacyPrefix: string): Promise<void> => {
      for (const entry of await storage.listFiles(prefix)) {
        if (entry.isDirectory) {
          await collect(`${prefix}/${entry.name}`, `${legacyPrefix}${entry.name}/`);
        } else if (legacyPrefix === "" && CURRENT_DIRTY_MARKER.test(entry.name)) {
          const markerPath = `${prefix}/${entry.name}`;
          const slug = await storage.readFile(markerPath);
          if (await dirtyMarkerPath(slug) !== markerPath) {
            // This is either a corrupt current marker or a legacy root slug
            // that happens to look exactly like a marker digest. We cannot
            // distinguish those safely, so force callers onto the fail-closed
            // scan rather than trusting stale visibility metadata.
            throw new Error(`Invalid Page-index dirty marker: ${entry.name}`);
          }
          slugs.add(slug);
        } else if (legacyPrefix === "" && PREVIOUS_DIRTY_MARKER.test(entry.name)) {
          const markerPath = `${prefix}/${entry.name}`;
          const payload = await storage.readFile(markerPath);
          if (await previousDirtyMarkerPath(payload) === markerPath) {
            // Marker written by the immediately previous hashed-marker release.
            slugs.add(payload);
          } else {
            // Ambiguous/corrupt: the filename is also a valid legacy raw slug.
            // Fence both interpretations rather than trusting stale metadata.
            slugs.add(entry.name);
            slugs.add(payload);
          }
        } else {
          // Raw-slug markers from the prior version. Walking directories also
          // recovers the exact nested markers that version failed to surface.
          slugs.add(`${legacyPrefix}${entry.name}`);
        }
      }
    };
    await collect(PAGE_INDEX_DIRTY_PATH, "");
    return slugs;
  } catch (error) {
    if (isEnoent(error)) return new Set();
    // Failure to read the invalidation set must never make stale visibility
    // metadata authoritative. Force callers onto the full Page scan.
    throw error;
  }
}

/** The metadata map, or `null` when the index has never been seeded (caller
 *  should fall back to {@link scanWikiPagesUncached}). */
export async function getPageIndex(
  options?: { strict?: boolean },
): Promise<PageMetaIndex | null> {
  try {
    let idx: PageMetaIndex | null;
    try {
      idx = JSON.parse(await getStorage().readFile(PAGE_INDEX_PATH)) as PageMetaIndex;
    } catch (error) {
      if (!isEnoent(error)) throw error;
      // One-way rolling migration from the old KV-only index. The next sync or
      // rebuild writes the strongly consistent R2/file copy.
      idx = await getStorage().getIndex<PageMetaIndex>(PAGE_INDEX_KEY);
    }
    // Presence check only — per-entry shape is TRUSTED, not validated. Safe
    // because `listWikiPages` drives membership + title/slug/summary from
    // index.md and only pulls enriched (optional) fields from here, so a
    // malformed entry can at worst mis-enrich, never drop or leak a page; the
    // daily rebuild overwrites it.
    if (!idx || typeof idx !== "object") return null;
    return idx;
  } catch (err) {
    if (options?.strict) throw err;
    logger.warn("page-index", "read failed; falling back to scan", err);
    return null;
  }
}

/** Upsert one page's enriched entry. NO-OP until the index is seeded. */
export async function syncPageIndexForPage(entry: IndexEntry): Promise<void> {
  await withDurableLock(PAGE_INDEX_LOCK, async () => {
    const idx = await getPageIndex({ strict: true });
    if (idx === null) return; // not seeded — daily rebuild will seed it
    idx[entry.slug] = entry;
    await getStorage().writeFile(PAGE_INDEX_PATH, JSON.stringify(idx));
    await getStorage().putIndex(PAGE_INDEX_KEY, idx);
  });
}

/** Drop one page's entry (page deleted). NO-OP until seeded. */
export async function removePageIndexForSlug(slug: string): Promise<void> {
  await withDurableLock(PAGE_INDEX_LOCK, async () => {
    const idx = await getPageIndex({ strict: true });
    if (idx === null) return;
    if (slug in idx) {
      delete idx[slug];
      await getStorage().writeFile(PAGE_INDEX_PATH, JSON.stringify(idx));
      await getStorage().putIndex(PAGE_INDEX_KEY, idx);
    }
  });
}

/** Rebuild the whole map from the authoritative per-page scan (daily self-heal). */
export async function rebuildPageIndex(): Promise<number> {
  const { scanWikiPagesUncached } = await import("./wiki");
  return withDurableLock(PAGE_INDEX_LOCK, async () => {
    const all = await scanWikiPagesUncached();
    const map: PageMetaIndex = {};
    for (const entry of all) map[entry.slug] = entry;
    await getStorage().writeFile(PAGE_INDEX_PATH, JSON.stringify(map));
    await getStorage().putIndex(PAGE_INDEX_KEY, map);
    return all.length;
  });
}
