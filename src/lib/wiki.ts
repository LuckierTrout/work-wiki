import path from "path";
import type { WikiPage, IndexEntry } from "./types";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { saveRevision } from "./revisions";
import { isEnoent } from "./errors";
import { PAGE_UNREADABLE_COPY, PageUnreadableError } from "./page-read-failure";
import { getStorage } from "./storage";
import {
  getWikiDir as _getWikiDir,
  getRawDir as _getRawDir,
  getDataDir,
} from "./config";
import { getTenantWikiDir, getTenantRawDir } from "./paths";
import { DEFAULT_TENANT, ownerToTenant } from "./links";
import { parseSources, dedupeSourcesForDisplay } from "./sources";
import { getPageIndex } from "./page-index";

// ---------------------------------------------------------------------------
// Configurable base directories — delegated to the config layer
// ---------------------------------------------------------------------------

export function getWikiDir(): string {
  return _getWikiDir();
}

export function getRawDir(): string {
  return _getRawDir();
}

// ---------------------------------------------------------------------------
// Storage path helpers
// ---------------------------------------------------------------------------

/**
 * Compute a storage-relative path for a wiki file.
 *
 * The StorageProvider resolves paths relative to `getDataDir()`. This helper
 * computes `path.relative(getDataDir(), absoluteWikiPath)` so that it works
 * regardless of whether WIKI_DIR is overridden (e.g. in tests) or uses the
 * default `{dataDir}/wiki`.
 */
export function wikiRelPath(filename: string): string {
  return path.relative(getDataDir(), path.join(getWikiDir(), filename));
}

// Pure page-type predicates live in a client-safe leaf; re-export so existing
// server importers keep using `@/lib/wiki`.
export { isAgentScopedType, isArtifactType } from "./page-types";

/**
 * Compute a storage-relative path for a raw source file.
 *
 * Same logic as {@link wikiRelPath} but for the `raw/` directory. Used by
 * raw.ts and anywhere else that needs to address raw sources through the
 * StorageProvider.
 */
export function rawRelPath(filename: string): string {
  return path.relative(getDataDir(), path.join(getRawDir(), filename));
}

// ---------------------------------------------------------------------------
// Per-tenant path helpers (tenant-silos groundwork — see work-wiki-concept.md).
//
// Additive and behavior-preserving: the legacy `wikiRelPath`/`rawRelPath`
// above are unchanged, and nothing yet routes through these. Later phases
// thread a `tenant` (the owner handle) through reads/writes and the migration
// relocates existing content under `tenants/<tenant>/…`.
// ---------------------------------------------------------------------------

/**
 * Catch-all tenant for ownerless / seed content (re-exported from the pure
 * `links` module so client and server share one definition). work-wiki is built
 * in public by yoyo, so unattributed/seed pages are the platform's own — they
 * belong to the `work-wiki` tenant; "ownerless" never surfaces in a URL.
 */
export { DEFAULT_TENANT, ownerToTenant };

/**
 * Guard a tenant name against path traversal before using it to build a key.
 * Deliberately lighter than {@link validateSlug} (owner handles need not match
 * the strict slug pattern) — it only blocks traversal and separators.
 */
export function validateTenant(tenant: string): void {
  if (
    typeof tenant !== "string" ||
    tenant.length === 0 ||
    tenant === "." || // a bare dot collapses the segment under path.join
    tenant.includes("..") ||
    tenant.includes("/") ||
    tenant.includes("\\") ||
    // any whitespace or control char would make a malformed/ambiguous key
    /[\s\x00-\x1f]/.test(tenant)
  ) {
    throw new Error(`Invalid tenant: ${JSON.stringify(tenant)}`);
  }
}

/**
 * The canonical tenant for a page owner. Lowercased (owner checks are
 * case-insensitive — see owner.ts — so one owner must not split across
 * "Alice"/"alice" silos), falling back to {@link DEFAULT_TENANT} for
 * ownerless/seed content. This is the SINGLE place tenant-from-owner is
 * derived; commons and the migration both use it so they stay consistent.
 */
export function tenantForOwner(owner: string | undefined | null): string {
  return ownerToTenant(owner);
}

/**
 * Build a slug→tenant map over the whole flat index — used to resolve canonical
 * `/u/<tenant>/<slug>` URLs for in-content wikilinks/backlinks where only the
 * target slug is known. Pre-P5 slugs are globally unique, so each maps to one
 * tenant. Cheap (tens of pages); computed once per server render.
 */
export async function buildSlugTenantMap(): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const p of await listWikiPages()) map[p.slug] = tenantForOwner(p.owner);
  return map;
}

/**
 * Resolve the tenant for a given slug. Fast path: O(1) KV read from
 * the page-metadata index. Fallback: O(N) full scan via buildSlugTenantMap.
 * Returns DEFAULT_TENANT when the slug has no owner or is not found.
 */
export async function tenantForSlug(slug: string): Promise<string> {
  // Fast path: page-metadata KV index
  const pageIdx = await getPageIndex();
  if (pageIdx) {
    const entry = pageIdx[slug];
    if (entry) return tenantForOwner(entry.owner);
    // slug not in index → could be deleted or index stale; fall through
  }
  // Slow path: full scan
  const map = await buildSlugTenantMap();
  return map[slug] ?? tenantForOwner(undefined);
}

/** Storage-relative path for a file in a tenant's wiki tree. */
export function tenantWikiRelPath(tenant: string, filename: string): string {
  validateTenant(tenant);
  return path.relative(
    getDataDir(),
    path.join(getTenantWikiDir(tenant), filename),
  );
}

/** Storage-relative path for a file in a tenant's raw-sources tree. */
export function tenantRawRelPath(tenant: string, filename: string): string {
  validateTenant(tenant);
  return path.relative(
    getDataDir(),
    path.join(getTenantRawDir(tenant), filename),
  );
}

// ---------------------------------------------------------------------------
// Slug validation — path traversal protection
// ---------------------------------------------------------------------------

/**
 * Safe slug pattern: lowercase alphanumeric **or CJK** (Han incl. Ext-A and
 * compatibility ideographs, Japanese kana, Korean hangul), may contain hyphens,
 * cannot start/end with hyphen. CJK is allowed so Chinese/Japanese/Korean
 * titles can have meaningful slugs (matches {@link slugify}); path-safety is
 * enforced separately below (null bytes, separators, `..`).
 */
const SLUG_CHAR = "a-z0-9\\u3400-\\u9fff\\uf900-\\ufaff\\u3040-\\u30ff\\uac00-\\ud7af";
const SAFE_SLUG_RE = new RegExp(
  `^[${SLUG_CHAR}][${SLUG_CHAR}-]*[${SLUG_CHAR}]$|^[${SLUG_CHAR}]$`,
);

/**
 * Validate that a slug is safe to use as a filename inside the wiki/raw dirs.
 *
 * Rejects empty strings, path traversal attempts (`..`, `/`, `\`), null bytes,
 * and anything that doesn't match the safe pattern.
 *
 * @throws {Error} with a descriptive message when the slug is invalid.
 */
export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error("Invalid slug: must be a non-empty string");
  }
  if (slug.includes("\0")) {
    throw new Error("Invalid slug: must not contain null bytes");
  }
  if (slug.includes("/") || slug.includes("\\")) {
    throw new Error("Invalid slug: must not contain path separators");
  }
  if (slug.includes("..")) {
    throw new Error("Invalid slug: must not contain path traversal (..)")
  }
  if (!SAFE_SLUG_RE.test(slug)) {
    throw new Error(
      `Invalid slug: "${slug}" does not match the safe pattern (lowercase alphanumeric and hyphens, cannot start or end with hyphen)`,
    );
  }
}

// ---------------------------------------------------------------------------
// Directory helpers
// ---------------------------------------------------------------------------

/**
 * Ensure the `raw/` and `wiki/` directories exist.
 *
 * Uses the StorageProvider to write a `.gitkeep` marker file in each
 * directory. The filesystem provider's `writeFile` auto-creates parent
 * directories, so this is idempotent and works with any storage backend.
 */
export async function ensureDirectories(): Promise<void> {
  const storage = getStorage();
  await storage.writeFile(wikiRelPath(".gitkeep"), "");
  await storage.writeFile(rawRelPath(".gitkeep"), "");
}

// Re-export frontmatter utilities for backward compatibility
export { parseFrontmatter, serializeFrontmatter } from "./frontmatter";
export type { Frontmatter, ParsedPage } from "./frontmatter";

// Import frontmatter utilities for local use within this module
import { parseFrontmatter } from "./frontmatter";
import type { Frontmatter } from "./frontmatter";

// ---------------------------------------------------------------------------
// Per-operation page cache — opt-in to avoid redundant filesystem reads
// ---------------------------------------------------------------------------

/** Module-level cache state. `null` means caching is inactive. */
let pageCache: Map<string, WikiPage | null> | null = null;
let pageCacheRefCount = 0;

/**
 * Enable per-operation page caching. Returns a cleanup function that
 * deactivates the cache and discards all entries.
 *
 * While active, `readWikiPage()` checks the cache before reading disk and
 * stores its result. `writeWikiPage()` invalidates the cache entry so the
 * next read fetches fresh data.
 *
 * Uses reference counting so multiple concurrent operations can share the
 * same cache — it is only cleaned up when the last user releases it.
 */
export function beginPageCache(): () => void {
  if (pageCacheRefCount === 0) {
    pageCache = new Map();
  }
  pageCacheRefCount++;
  return () => {
    pageCacheRefCount--;
    if (pageCacheRefCount <= 0) {
      pageCache = null;
      pageCacheRefCount = 0;
    }
  };
}

/**
 * Convenience wrapper: run `fn` with page caching enabled, then clean up —
 * even if `fn` throws.
 */
export async function withPageCache<T>(fn: () => Promise<T>): Promise<T> {
  const cleanup = beginPageCache();
  try {
    return await fn();
  } finally {
    cleanup();
  }
}

/** For testing: return the number of entries in the active cache, or 0 if inactive. */
export function _getPageCacheSize(): number {
  return pageCache?.size ?? 0;
}

// ---------------------------------------------------------------------------
// Wiki page I/O
// ---------------------------------------------------------------------------

/**
 * Whether a commons wiki page exists. Unlike {@link readWikiPage} (which
 * swallows ALL read errors as `null`), this RE-THROWS a non-ENOENT storage
 * failure so a caller can tell "the page is genuinely gone" from "the store
 * hiccuped" — e.g. the ingest-status route must not drop a live job's strip
 * entry on a transient blip. A malformed slug is treated as "no such page".
 */
export async function wikiPageExists(slug: string): Promise<boolean> {
  try {
    validateSlug(slug);
  } catch {
    return false;
  }
  const storage = getStorage();

  // Silo-primary: try tenant path first (O(1) page-index lookup only —
  // we must NOT call tenantForSlug here because its slow path triggers
  // listWikiPages → scanWikiPagesUncached → readWikiPage → infinite loop).
  const pageIdx = await getPageIndex();
  if (pageIdx) {
    const entry = pageIdx[slug];
    const tenant = tenantForOwner(entry?.owner);
    const siloPath = tenantWikiRelPath(tenant, `${slug}.md`);
    try {
      await storage.readFile(siloPath);
      return true;
    } catch (e) {
      if (!isEnoent(e)) {
        logger.warn("wiki", `silo existence check failed for "${slug}", falling back to flat:`, e);
      }
      // Fall through to flat
    }
  }

  // Flat fallback
  try {
    await storage.readFile(wikiRelPath(`${slug}.md`));
    return true;
  } catch (err) {
    if (isEnoent(err)) return false;
    throw err; // real storage error — let the caller decide, don't mask as "gone"
  }
}

/**
 * Options for a page read.
 */
export interface ReadWikiPageOptions {
  /**
   * Bypass {@link pageCache} entirely for this read (DW-195).
   *
   * A bypassing read NEITHER CONSULTS NOR MUTATES the cache: it goes to
   * storage, and it leaves whatever entry is there exactly as it was — so a
   * bulk scan holding the cache open across this request keeps the entries it
   * is iterating, and this caller still gets the stored bytes.
   *
   * WHAT IT BYPASSES IS `pageCache`, AND ONLY THAT. The read still resolves
   * which silo path to try through {@link getPageIndex}, which has a cache and
   * a consistency window of its own on the R2 backend — so `fresh` guarantees
   * "not served from the per-operation page cache", not "the freshest bytes any
   * layer could possibly return". That is the right guarantee for the
   * precondition: a version derived here describes the bytes THIS read saw, and
   * the artifact writer re-checks its own under a lock. A page-index lag can
   * still make a write read the flat fallback, which is pre-existing and
   * unchanged by this option.
   *
   * FOR PRECONDITION-BEARING READS. `pageCache` is module-global and
   * ref-counted around bulk scans (`lint.ts`, `search.ts`, `query.ts`,
   * `dataview.ts`), so one of those can be holding a superseded entry open when
   * an unrelated request arrives. A read that SEEDS a precondition (the
   * Preview, the edit screen) would then hand the editor a version of bytes
   * that are no longer stored; a read that CHECKS one (the page `PUT`'s merge
   * base) would compare against a file that is not the one it is about to
   * overwrite. Both produce a 412 against a write nobody made, or a match
   * against bytes that are gone.
   *
   * IT ALSO CHANGES WHAT A FAILED READ ANSWERS (DW-378, DW-380). A fresh read
   * REFUSES rather than lies: a non-ENOENT storage failure throws
   * {@link import("./page-read-failure").PageUnreadableError} instead of
   * widening from a failed silo read to the flat file (which would derive a
   * version from a DIFFERENT file than the write targets) and instead of
   * returning `null` (which the `PUT` door answers as `page not found`, a claim
   * about existence that the failed read did not establish). ENOENT is
   * untouched in both modes: a missing page is still `null`, still a 404.
   *
   * Default `false`: caching stays exactly as it was for every existing caller,
   * AND so does the failure behaviour — an unqualified read still warns, still
   * widens to flat, still caches the negative entry and still answers `null`.
   */
  fresh?: boolean;
}

/**
 * Read a wiki page by slug. Returns `null` when the file doesn't exist or the
 * slug is invalid.
 *
 * Pass `{ fresh: true }` when the bytes (or their version) are about to back a
 * write precondition — see {@link ReadWikiPageOptions.fresh}.
 *
 * THROWS ONLY ON THE FRESH PATH (DW-378, DW-380). An unqualified read never
 * throws for a storage failure: it warns, widens to the flat file, caches the
 * negative entry and answers `null`, exactly as ~40 callers rely on. A FRESH
 * read rejects with
 * {@link import("./page-read-failure").PageUnreadableError} when storage fails
 * with anything other than ENOENT — on either path, and without reading the
 * other one. A page that is genuinely absent is still `null` in both modes.
 */
export async function readWikiPage(
  slug: string,
  options?: ReadWikiPageOptions,
): Promise<WikiPage | null> {
  try {
    validateSlug(slug);
  } catch (err) {
    logger.warn("wiki", `readWikiPage slug validation failed for "${slug}":`, err);
    return null;
  }

  const fresh = options?.fresh === true;

  // Check cache first (when active, and when this read may use it)
  if (!fresh && pageCache !== null && pageCache.has(slug)) {
    return pageCache.get(slug) ?? null;
  }

  const storage = getStorage();
  const flatPath = `${getWikiDir()}/${slug}.md`;

  // Silo-primary: try tenant path first. We use ONLY the O(1) page-index
  // lookup — NOT tenantForSlug() — because its slow path triggers
  // listWikiPages → scanWikiPagesUncached → readWikiPageWithFrontmatter →
  // readWikiPage → infinite recursion.
  let content: string | null = null;
  let actualPath: string = flatPath; // track where content was actually read from
  const pageIdx = await getPageIndex();
  if (pageIdx) {
    const entry = pageIdx[slug];
    const tenant = tenantForOwner(entry?.owner);
    const siloPath = tenantWikiRelPath(tenant, `${slug}.md`);
    try {
      content = await storage.readFile(siloPath);
      // Content came from the silo — resolve the absolute path
      actualPath = path.join(getDataDir(), siloPath);
    } catch (e) {
      if (fresh && !isEnoent(e)) {
        // A precondition-bearing read must not widen to a DIFFERENT file
        // (DW-380): the version would describe the flat file while the write
        // targets the silo one. Absent (ENOENT) still widens — that is the
        // migration fallback working as intended.
        //
        // LOGGED HERE OR NOWHERE. This throw skips the `logger.warn` below, and
        // BOTH doors that consume a fresh read return before their own logging
        // (the `PUT`'s 503 branch sits above the ladder, the Preview's above
        // `logger.error`). Without this line a storage incident on the write
        // path would leave no server-side trace at all, while the unqualified
        // read of the same file still warned.
        logger.error(
          "wiki",
          `fresh silo read failed for "${slug}" at ${siloPath}; refusing rather than falling back to flat:`,
          e,
        );
        throw new PageUnreadableError(PAGE_UNREADABLE_COPY, { cause: e });
      }
      if (!isEnoent(e)) {
        logger.warn("wiki", `silo read failed for "${slug}", falling back to flat:`, e);
      }
      // Fall through to flat fallback
    }
  }

  // Flat fallback
  if (content === null) {
    try {
      content = await storage.readFile(wikiRelPath(`${slug}.md`));
      actualPath = flatPath;
    } catch (err) {
      if (fresh && !isEnoent(err)) {
        // ABSENT and UNREADABLE are not the same answer (DW-378). `null` here
        // becomes `page not found: <slug>` at the `PUT` door, a 404 about
        // existence answered before the precondition is ever consulted — for a
        // page that may well exist. ENOENT still resolves `null`.
        //
        // Logged for the same reason as the silo branch above: this throw skips
        // the `logger.warn` below and neither consuming route logs, so this is
        // the only trace the incident leaves.
        logger.error(
          "wiki",
          `fresh read failed for "${slug}" at ${wikiRelPath(`${slug}.md`)}; refusing rather than answering "not found":`,
          err,
        );
        throw new PageUnreadableError(PAGE_UNREADABLE_COPY, { cause: err });
      }
      if (!isEnoent(err)) {
        logger.warn("wiki", `readWikiPage failed for "${slug}":`, err);
      }
      // A fresh read leaves the cache as it found it — see
      // `ReadWikiPageOptions.fresh`. Poisoning a scan's open cache with a
      // negative entry is exactly the staleness this option exists to avoid,
      // pointed the other way.
      if (!fresh && pageCache !== null) {
        pageCache.set(slug, null);
      }
      return null;
    }
  }

  // Derive title from the first markdown heading, falling back to the slug.
  const titleMatch = content.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : slug;
  const result: WikiPage = { slug, title, content, path: actualPath };

  if (!fresh && pageCache !== null) {
    pageCache.set(slug, result);
  }

  return result;
}

/**
 * Extended read that additionally exposes parsed frontmatter and the
 * body (markdown with the YAML block stripped).
 *
 * This is a separate export so that {@link WikiPage} in `types.ts` stays
 * unchanged and existing call sites continue to work without modification.
 * Callers that specifically need the frontmatter — currently only
 * `ingest()`'s re-ingest path — use this helper.
 *
 * Returns `null` when the page doesn't exist or the slug is invalid.
 * Throws when the file exists but its frontmatter block is malformed.
 *
 * `options` is forwarded verbatim to {@link readWikiPage} — pass
 * `{ fresh: true }` when the bytes are about to back a write precondition. A
 * FRESH read's refusal
 * ({@link import("./page-read-failure").PageUnreadableError}, DW-378/DW-380)
 * propagates through here unchanged; an unqualified read still answers `null`
 * for a failed read exactly as before.
 */
export async function readWikiPageWithFrontmatter(
  slug: string,
  options?: ReadWikiPageOptions,
): Promise<(WikiPage & { frontmatter: Frontmatter; body: string }) | null> {
  const page = await readWikiPage(slug, options);
  if (!page) return null;
  const { data, body } = parseFrontmatter(page.content);
  // Prefer the H1 inside the body so frontmatter lines can never contribute
  // to the derived title.
  const titleMatch = body.match(/^#\s+(.+)$/m);
  const title = titleMatch ? titleMatch[1].trim() : page.title;
  return { ...page, title, frontmatter: data, body };
}

/** Write (or overwrite) a wiki page. Ensures the wiki directory exists first. Throws on invalid slug.
 *
 * When `tenant` is provided, writes to the tenant silo path
 * (`tenants/<tenant>/wiki/<slug>.md`) instead of the flat path. Existing
 * callers that omit `tenant` are unaffected — backward compatible.
 */
export async function writeWikiPage(
  slug: string,
  content: string,
  author?: string,
  reason?: string,
  tenant?: string,
): Promise<void> {
  validateSlug(slug);
  const storagePath = tenant
    ? tenantWikiRelPath(tenant, `${slug}.md`)
    : wikiRelPath(`${slug}.md`);
  const storage = getStorage();

  // Snapshot the current content as a revision before overwriting.
  // Only save a revision if the file already exists (new pages don't have
  // a previous version to save).
  try {
    const existing = await storage.readFile(storagePath);
    await saveRevision(slug, existing, author, reason, tenant);
  } catch (err) {
    // File doesn't exist yet — first write, no revision needed.
    if (!isEnoent(err)) {
      logger.warn("wiki", `unexpected error reading existing page "${slug}" before revision:`, err);
    }
  }

  await storage.writeFile(storagePath, content);

  // Invalidate cache entry so next read fetches fresh data
  if (pageCache !== null) {
    pageCache.delete(slug);
  }
}

// ---------------------------------------------------------------------------
// Index management
// ---------------------------------------------------------------------------

/** Build an enriched {@link IndexEntry} from a base (title/slug/summary) + the
 *  page's frontmatter. The single source of the enrichment rules — used by the
 *  per-page scan AND the `_idx:pages` rebuild so they can't drift. */
export function enrichEntry(
  base: IndexEntry,
  fm: Frontmatter,
): IndexEntry {
  const tags = Array.isArray(fm.tags)
    ? fm.tags.filter((t): t is string => typeof t === "string" && t.length > 0)
    : undefined;

  const updated =
    typeof fm.updated === "string" && fm.updated.length > 0 ? fm.updated : undefined;

  const expiry =
    typeof fm.expiry === "string" && fm.expiry.length > 0 ? fm.expiry : undefined;

  // Displayed source count = number of DISTINCT sources (deduped by URL), so it
  // matches the SOURCES panel. `source_count` frontmatter is an ingest-EVENT
  // counter (re-ingesting one URL bumps it), so it overcounts — only fall back
  // to it for legacy pages that have no structured `sources[]`.
  const distinctSources = dedupeSourcesForDisplay(
    parseSources(fm.sources as string | string[] | undefined),
  ).length;
  const sourceCountRaw = fm.source_count;
  const sourceCountNum =
    typeof sourceCountRaw === "number"
      ? sourceCountRaw
      : typeof sourceCountRaw === "string" && sourceCountRaw.length > 0
        ? Number.parseInt(sourceCountRaw, 10)
        : NaN;
  const legacyCount =
    Number.isFinite(sourceCountNum) && sourceCountNum >= 0 ? sourceCountNum : undefined;
  const sourceCount = distinctSources > 0 ? distinctSources : legacyCount;

  const sourceUrl =
    typeof fm.source_url === "string" && fm.source_url.length > 0
      ? fm.source_url
      : undefined;

  const owner =
    typeof fm.owner === "string" && fm.owner.length > 0 ? fm.owner : undefined;

  const pageType =
    typeof fm.type === "string" && fm.type.length > 0 ? fm.type : undefined;

  // Only "private" is meaningful for read-gating; everything else is public.
  const visibility =
    typeof fm.visibility === "string" && fm.visibility === "private"
      ? "private"
      : undefined;

  const confidenceRaw = fm.confidence;
  const confidenceNum =
    typeof confidenceRaw === "number"
      ? confidenceRaw
      : typeof confidenceRaw === "string" && confidenceRaw.length > 0
        ? Number.parseFloat(confidenceRaw)
        : NaN;
  const confidence =
    Number.isFinite(confidenceNum) && confidenceNum >= 0 && confidenceNum <= 1
      ? confidenceNum
      : undefined;

  return {
    ...base,
    ...(tags && tags.length > 0 ? { tags } : {}),
    ...(updated ? { updated } : {}),
    ...(sourceCount !== undefined ? { sourceCount } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(owner ? { owner } : {}),
    ...(pageType ? { type: pageType } : {}),
    ...(visibility ? { visibility } : {}),
    ...(expiry ? { expiry } : {}),
  };
}

/** Parse the ordered base entries (title/slug/summary) from `wiki/index.md`. */
async function readIndexBaseEntries(): Promise<IndexEntry[]> {
  const storagePath = wikiRelPath("index.md");
  let raw: string;
  try {
    raw = await getStorage().readFile(storagePath);
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      // A transient read failure on index.md makes the WHOLE wiki look empty to
      // every list surface — surface it at error level (ENOENT = genuinely no
      // index yet, which is the normal empty-state and stays quiet).
      logger.error("wiki", "listWikiPages failed to read index.md:", err);
    }
    return [];
  }
  const baseEntries: IndexEntry[] = [];
  const lineRe = /^-\s+\[(.+?)]\((.+?)\.md\)\s*—\s*(.+)$/;
  for (const line of raw.split("\n")) {
    const m = line.match(lineRe);
    if (m) baseEntries.push({ title: m[1], slug: m[2], summary: m[3].trim() });
  }
  return baseEntries;
}

/**
 * The O(pages) scan: read `index.md` then EACH page's frontmatter to enrich.
 * The fallback for {@link listWikiPages} and the source for the `_idx:pages`
 * rebuild. A page that fails to parse falls back to its plain index entry so one
 * malformed page never breaks the whole list.
 */
export async function scanWikiPagesUncached(): Promise<IndexEntry[]> {
  const baseEntries = await readIndexBaseEntries();
  return Promise.all(
    baseEntries.map(async (entry): Promise<IndexEntry> => {
      try {
        const page = await readWikiPageWithFrontmatter(entry.slug);
        if (!page) return entry;
        return enrichEntry(entry, page.frontmatter);
      } catch (err) {
        logger.warn(
          "wiki",
          `listWikiPages: failed to read frontmatter for "${entry.slug}" — falling back to plain entry`,
          err,
        );
        return entry;
      }
    }),
  );
}

/**
 * Parse `wiki/index.md` and return its entries with enriched metadata.
 *
 * Fast path: read the ordered base from `index.md` (1 read) and enrich from the
 * `_idx:pages` metadata index (1 KV read) — O(1) instead of reading every page
 * file. Falls back to the per-page {@link scanWikiPagesUncached} when the index
 * isn't seeded, so behavior is identical with or without the index.
 *
 * Expected `index.md` line format: `- [Title](slug.md) — summary`
 */
export async function listWikiPages(): Promise<IndexEntry[]> {
  const { getPageIndex } = await import("./page-index");
  const meta = await getPageIndex();
  if (meta === null) return scanWikiPagesUncached();

  const baseEntries = await readIndexBaseEntries();
  return baseEntries.map((b) => {
    const m = meta[b.slug];
    // index.md stays authoritative for title/summary; the metadata index
    // supplies the enriched fields. A slug missing from the index (just added,
    // pre-rebuild) falls back to its plain base entry.
    return m ? { ...m, title: b.title, slug: b.slug, summary: b.summary } : b;
  });
}

/**
 * Like {@link listWikiPages} but filtered to the pages `principal` may read —
 * the read-side counterpart used by every list-consuming surface (browse,
 * graph, search, query, export, trail, profiles…). Public pages always pass;
 * `visibility: private` pages pass only for their owner. `principal` is passed
 * explicitly (never an implicit default) so callers fail closed.
 *
 * Imported dynamically to avoid a static cycle (authz → agents → wiki).
 */
export async function listReadableWikiPages(
  principal: import("./auth").Principal | null,
): Promise<IndexEntry[]> {
  const { canReadEntry } = await import("./authz");
  const entries = await listWikiPages();
  return entries.filter((e) => canReadEntry(e, principal));
}

/**
 * Write `wiki/index.md` from an array of entries.
 *
 * Format:
 * ```
 * # Wiki Index
 *
 * - [Title](slug.md) — summary
 * ```
 */
export async function updateIndex(entries: IndexEntry[]): Promise<void> {
  await withFileLock("index.md", async () => {
    await updateIndexUnsafe(entries);
  });
}

/**
 * Write `wiki/index.md` from an array of entries **without** acquiring the
 * `index.md` file lock.
 *
 * This exists so that callers who already hold the lock (e.g.
 * `runPageLifecycleOp` in `lifecycle.ts`) can perform a read → mutate → write
 *
 * **Do not call from outside a `withFileLock("index.md", …)` block** — use
 * {@link updateIndex} instead.
 */
export async function updateIndexUnsafe(entries: IndexEntry[]): Promise<void> {
  const lines = entries.map(
    (e) => `- [${e.title}](${e.slug}.md) — ${e.summary}`,
  );
  const content = `# Wiki Index\n\n${lines.join("\n")}\n`;
  const storagePath = wikiRelPath("index.md");
  await getStorage().writeFile(storagePath, content);
}

// Re-export raw source utilities for backward compatibility
export { saveRawSource, saveRawSourceFor, listRawSources, readRawSource, readRawSourceById } from "./raw";
export type { RawSource, RawSourceWithContent } from "./raw";

// ---------------------------------------------------------------------------
// Append-only log — re-exported from wiki-log.ts for backward compat
// ---------------------------------------------------------------------------

export { appendToLog, readLog } from "./wiki-log";
export type { LogOperation } from "./wiki-log";

// ---------------------------------------------------------------------------
// Search & cross-referencing — re-exported from search.ts for backward compat
// ---------------------------------------------------------------------------

export {
  findRelatedPages,
  findSimilarPages,
  updateRelatedPages,
  findBacklinks,
  searchWikiContent,
  fuzzySearchWikiContent,
  fuzzyMatch,
  levenshteinDistance,
} from "./search";
export type { ContentSearchResult } from "./search";

// ---------------------------------------------------------------------------
// Lifecycle pipeline — re-exported from lifecycle.ts for backward compatibility
// ---------------------------------------------------------------------------

export { writeWikiPageWithSideEffects, deleteWikiPage } from "./lifecycle";
export type {
  WritePageOptions,
  WritePageResult,
  DeletePageResult,
} from "./lifecycle";
