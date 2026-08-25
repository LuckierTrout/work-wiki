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
import type { IndexEntry } from "./types";

const PAGE_INDEX_KEY = "pages";
const PAGE_INDEX_LOCK = "page-index";
const PAGE_INDEX_PATH = "derived-indexes/pages.json";
const PAGE_INDEX_DIRTY_PATH = "derived-indexes/pages-dirty";

export type PageMetaIndex = Record<string, IndexEntry>;

export async function markPageIndexDirty(slug: string): Promise<void> {
  await getStorage().writeFile(`${PAGE_INDEX_DIRTY_PATH}/${slug}`, "1");
}

export async function clearPageIndexDirty(slug: string): Promise<void> {
  try {
    await getStorage().deleteFile(`${PAGE_INDEX_DIRTY_PATH}/${slug}`);
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function getPageIndexDirtySlugs(): Promise<Set<string>> {
  try {
    const entries = await getStorage().listFiles(PAGE_INDEX_DIRTY_PATH);
    return new Set(
      entries.filter((entry) => !entry.isDirectory).map((entry) => entry.name),
    );
  } catch (error) {
    if (isEnoent(error)) return new Set();
    // Failure to read the invalidation set must never make stale visibility
    // metadata authoritative. Force callers onto the full Page scan.
    throw error;
  }
}

/** The metadata map, or `null` when the index has never been seeded (caller
 *  should fall back to {@link scanWikiPagesUncached}). */
export async function getPageIndex(): Promise<PageMetaIndex | null> {
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
    logger.warn("page-index", "read failed; falling back to scan", err);
    return null;
  }
}

/** Upsert one page's enriched entry. NO-OP until the index is seeded. */
export async function syncPageIndexForPage(entry: IndexEntry): Promise<void> {
  await withDurableLock(PAGE_INDEX_LOCK, async () => {
    const idx = await getPageIndex();
    if (idx === null) return; // not seeded — daily rebuild will seed it
    idx[entry.slug] = entry;
    await getStorage().writeFile(PAGE_INDEX_PATH, JSON.stringify(idx));
    await getStorage().putIndex(PAGE_INDEX_KEY, idx);
  });
}

/** Drop one page's entry (page deleted). NO-OP until seeded. */
export async function removePageIndexForSlug(slug: string): Promise<void> {
  await withDurableLock(PAGE_INDEX_LOCK, async () => {
    const idx = await getPageIndex();
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
