import path from "path";
import type { WikiPage, IndexEntry } from "./types";
import { withDurableLock } from "./lock";
import { logger } from "./logger";
import { saveRevision } from "./revisions";
import { isEnoent } from "./errors";
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
import { electWikiLeafNames, wikiPageNames } from "./wiki-file-names";

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
  // Null prototype: keys are content-derived slugs and so are the lookups, so a
  // plain literal answers `map["constructor"]` with an inherited function
  // instead of `undefined`, defeating the `?? tenantForOwner(undefined)`
  // fallback below (DW-232). `JSON.stringify`, spread and `in` are unaffected.
  const map: Record<string, string> = Object.create(null);
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
const QUERIES_SLUG_PREFIX = "queries/";

export function validateSlug(slug: string): void {
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error("Invalid slug: must be a non-empty string");
  }
  if (slug.includes("\0")) {
    throw new Error("Invalid slug: must not contain null bytes");
  }
  if (slug.includes("\\")) {
    throw new Error("Invalid slug: must not contain path separators");
  }
  if (slug.includes("..")) {
    throw new Error("Invalid slug: must not contain path traversal (..)")
  }
  const leaf = slug.startsWith(QUERIES_SLUG_PREFIX)
    ? slug.slice(QUERIES_SLUG_PREFIX.length)
    : slug;
  if (slug.startsWith(QUERIES_SLUG_PREFIX)) {
    if (!leaf || leaf.includes("/")) {
      throw new Error("Invalid slug: must not contain path separators");
    }
  } else if (slug.includes("/")) {
    throw new Error("Invalid slug: must not contain path separators");
  }
  if (!SAFE_SLUG_RE.test(leaf)) {
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
 *
 * IT ANSWERS ABOUT THE OBJECT, NOT THE NAME (DW-741). Each arm resolves through
 * {@link findStoredPageKey}, so on a case-SENSITIVE store a Page held on
 * `wiki/cased.MD` is `true` here for the same reason {@link readWikiPage}
 * serves it. The disagreement that fix removes is a live one: the ingest-status
 * route calls a readable Page `gone` and 404s a completed ingest out of the
 * Recent-ingests strip.
 */
export async function wikiPageExists(slug: string): Promise<boolean> {
  try {
    validateSlug(slug);
  } catch {
    return false;
  }

  // Silo-primary: try tenant path first (O(1) page-index lookup only —
  // we must NOT call tenantForSlug here because its slow path triggers
  // listWikiPages → scanWikiPagesUncached → readWikiPage → infinite loop).
  const pageIdx = await getPageIndex();
  if (pageIdx) {
    const entry = pageIdx[slug];
    const tenant = tenantForOwner(entry?.owner);
    // The resolution is strict, so a non-ENOENT storage error is re-thrown
    // rather than masked as "gone"; a total miss falls through to flat.
    if ((await findStoredPageKey(slug, tenant)) !== null) return true;
  }

  // Flat fallback
  return (await findStoredPageKey(slug, null)) !== null;
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
   * Default `false`: caching stays exactly as it was for every existing caller.
   */
  fresh?: boolean;
  /**
   * Surface non-ENOENT storage failures instead of converting them to a
   * missing Page. Mechanical write preconditions use this so a transient
   * provider error can never authorize a destructive fix.
   *
   * TWO THINGS THIS OPTION IS EASY TO GET WRONG:
   *
   * 1. Its reach is wider than the Page file. It forwards into
   *    `getPageIndex({ strict })`, which rethrows a non-ENOENT failure — and a
   *    `JSON.parse` failure — on `derived-indexes/pages.json` where the default
   *    logs "read failed; falling back to scan" and returns `null`. So a strict
   *    read fails closed when only the INDEX is unreadable, even though the
   *    Page file itself is fine. That is deliberate for a write path: a silent
   *    fallback there can resolve the wrong silo and make the merge base a
   *    different Page. Non-strict callers keep the scan fallback
   *    (`lifecycle.test.ts` pins that contract).
   *
   * 2. It does NOT cover slug validation. An invalid slug still returns `null`
   *    from the early return at the top of {@link readWikiPage}, strict or not,
   *    because that is the caller's bad input rather than a storage failure.
   */
  strict?: boolean;
  /**
   * Owner whose tenant silo should be checked only after global Page identity
   * (the Page index, then the flat compatibility copy) has found no Page.
   * Ingest uses this to recover its own crash-left silo without allowing that
   * hint to displace another owner's committed same-slug Page.
   */
  owner?: string;
}

/**
 * WHICH STORED OBJECT CARRIES THIS SLUG, when the canonical `<slug>.md` does
 * not (DW-490)?
 *
 * On a case-SENSITIVE store `cased.md`, `cased.MD`, `cased.Md` and `cased.mD`
 * are four objects carrying the ONE slug `cased` — the Files tab already elects
 * one of them per slug and, since DW-489, serves only that one. But the page key
 * here was the canonical name unconditionally, so a save whose bytes came from a
 * lone `wiki/cased.MD` would have created a SECOND object and orphaned the
 * first; today it cannot even get that far, because this module only ever reads
 * `${slug}.md` and the save door 404s on a page the Files tab shows as editable.
 *
 * So: probe the three NON-canonical spellings, in parallel, and elect among
 * whatever answered — the SAME {@link electWikiLeafNames} the listing and the
 * read gate use, so all three name the same object. `null` when none of them is
 * there, which is the ordinary "no such page" answer.
 *
 * ONLY EVER ON THE ENOENT BRANCH. Every caller runs this after the canonical
 * spelling already answered ENOENT, which is what makes it free on a
 * case-INSENSITIVE store: there `readFile("cased.md")` resolves the object
 * whatever it is called, so the canonical read HITS and this never runs. The
 * behaviour difference between the two store kinds therefore lives entirely in
 * branches the case-insensitive store cannot reach.
 *
 * BOUNDED AND O(1) — three reads, never a listing. {@link wikiPageNames} is
 * exactly the candidate set because `wikiLeafSlug` lowercases the whole name and
 * tests a `.md` suffix, taking the slug as written.
 *
 * `strict` carries {@link ReadWikiPageOptions.strict}'s meaning verbatim: a
 * non-ENOENT failure is rethrown rather than flattened into "absent", because a
 * transient blip reported as a missing Page is what authorizes a destructive
 * fix. Non-strict logs and treats the spelling as absent, exactly as the
 * canonical read does.
 */
async function readStoredPageVariant(
  slug: string,
  tenant: string | null,
  strict: boolean,
): Promise<{ key: string; content: string } | null> {
  const storage = getStorage();
  const keyFor = (name: string): string =>
    tenant !== null ? tenantWikiRelPath(tenant, name) : wikiRelPath(name);

  // `slice(1)` drops the canonical spelling: the caller already read it and got
  // ENOENT, so re-reading it here would be a wasted round trip on every miss.
  const candidates = wikiPageNames(slug).slice(1);
  const found = await Promise.all(
    candidates.map(async (name) => {
      try {
        return { name, content: await storage.readFile(keyFor(name)) };
      } catch (error) {
        if (isEnoent(error)) return null;
        if (strict) throw error;
        logger.warn("wiki", `variant read failed for "${keyFor(name)}":`, error);
        return null;
      }
    }),
  );

  const hits = found.filter((hit): hit is { name: string; content: string } => hit !== null);
  if (hits.length === 0) return null;
  const elected = electWikiLeafNames(hits.map((hit) => hit.name)).get(slug);
  const winner = hits.find((hit) => hit.name === elected);
  if (!winner) return null;
  return { key: keyFor(winner.name), content: winner.content };
}

/**
 * WHICH STORAGE KEY UNDER THIS ROOT CARRIES THIS SLUG (DW-741)?
 *
 * The ONE resolution the delete door (`lifecycle.ts`) and the existence door
 * ({@link wikiPageExists}) share, so neither restates the candidate set or the
 * election: canonical `<slug>.md` first, and only on its ENOENT the same
 * {@link readStoredPageVariant} probe the read and write doors already use.
 * `null` when no spelling of the slug is present under `tenant` (or under the
 * flat root when `tenant` is `null`).
 *
 * ENOENT-GATED, so a HIT costs exactly what it cost before this existed: one
 * `readFile` on the same key. On a case-INSENSITIVE store the canonical
 * spelling resolves whatever object holds the slug, so that is the only path
 * ever taken there. A MISS is what got more expensive — four reads per root
 * instead of one — and that is the price of the answer being about the object
 * rather than the name. Both callers reach a miss only on a slug that really
 * has no Page under that root.
 *
 * `readFile` RATHER THAN `fileExists`, deliberately: only `readFile`
 * distinguishes a fault from an absence. The filesystem provider's `fileExists`
 * swallows every error, so a blip there would read as "no such page" — and both
 * of these doors turn that answer into a destructive or user-visible verdict (a
 * vacuously "successful" delete; a completed ingest 404'd out of the strip).
 *
 * ALWAYS STRICT, which is the same reason: a non-ENOENT failure is rethrown
 * rather than flattened into "no key here", on the canonical read exactly as
 * {@link readStoredPageVariant} applies it to each variant.
 *
 * DOES NOT VALIDATE `slug` — it builds a storage key from it directly. Callers
 * validate first ({@link wikiPageExists} and `deleteWikiPage` both do), which
 * is the same contract {@link readStoredPageVariant} carries.
 */
export async function findStoredPageKey(
  slug: string,
  tenant: string | null,
): Promise<string | null> {
  const canonicalKey =
    tenant !== null ? tenantWikiRelPath(tenant, `${slug}.md`) : wikiRelPath(`${slug}.md`);
  try {
    await getStorage().readFile(canonicalKey);
    return canonicalKey;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return (await readStoredPageVariant(slug, tenant, true))?.key ?? null;
}

/**
 * Read a wiki page by slug. Returns `null` when the file doesn't exist or the
 * slug is invalid.
 *
 * Pass `{ fresh: true }` when the bytes (or their version) are about to back a
 * write precondition — see {@link ReadWikiPageOptions.fresh}.
 *
 * CAN THROW, but only for a caller that asks it to. Add `{ strict: true }` and
 * a non-ENOENT storage failure — on the Page file, on the silo read, or on the
 * Page index — is rethrown instead of being flattened into `null`. Write paths
 * want that: `null` is indistinguishable from "no such Page", so without it a
 * transient blip is reported as a deletion (a 404 on the save door) and can
 * authorize a destructive fix. An absent Page and an invalid slug still answer
 * `null` under strict — see {@link ReadWikiPageOptions.strict}.
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
  const strict = options?.strict === true;

  // Check cache first (when active, and when this read may use it)
  if (!fresh && pageCache !== null && pageCache.has(slug)) {
    return pageCache.get(slug) ?? null;
  }

  const storage = getStorage();
  const flatPath = `${getWikiDir()}/${slug}.md`;
  let content: string | null = null;
  let actualPath: string = flatPath;
  let authoritativeReadFailed = false;
  // Did the bytes come from the SHARED FLAT root? Tracked explicitly rather
  // than inferred from `actualPath === flatPath`, because since DW-490 a flat
  // hit is not always the canonical name: a recovered `<slug>.MD` sets
  // `actualPath` to a key that compares unequal to `flatPath` and would have
  // silently skipped the frontmatter-inferred silo re-route below — the one
  // rule that keeps a stale public copy from winning over silo bytes after an
  // index outage. A variant is an ORDINARY flat hit and gets the same
  // treatment; that is what makes the recovery lose to everything an ordinary
  // read would have preferred.
  let fromFlatRoot = false;

  // Silo-primary: try tenant path first. We use ONLY the caller's resolved
  // owner and the O(1) page-index lookup — NOT tenantForSlug() — because its
  // slow path triggers listWikiPages -> scanWikiPagesUncached ->
  // readWikiPageWithFrontmatter -> readWikiPage -> infinite recursion.
  const attemptedTenants = new Set<string>();
  const readSilo = async (tenant: string): Promise<boolean> => {
    if (attemptedTenants.has(tenant)) return false;
    attemptedTenants.add(tenant);
    const siloPath = tenantWikiRelPath(tenant, `${slug}.md`);
    try {
      content = await storage.readFile(siloPath);
      actualPath = path.join(getDataDir(), siloPath);
      return true;
    } catch (error) {
      if (isEnoent(error)) return false;
      // Once an owner/index routes a Page to its authoritative silo, a storage
      // failure must not downgrade the read to possibly stale public flat
      // bytes. Strict callers need the error; ordinary callers fail closed.
      if (strict) throw error;
      logger.warn("wiki", `silo read failed for "${slug}"; refusing flat fallback:`, error);
      authoritativeReadFailed = true;
      return true;
    }
  };

  // Silo-primary: try the globally indexed tenant first. We use ONLY the O(1)
  // page-index lookup — NOT tenantForSlug() — because its slow path triggers
  // listWikiPages → scanWikiPagesUncached → readWikiPageWithFrontmatter →
  // readWikiPage → infinite recursion.
  const pageIdx = await getPageIndex({ strict });
  const indexedEntry = pageIdx?.[slug];
  if (indexedEntry) {
    await readSilo(tenantForOwner(indexedEntry.owner));
    if (authoritativeReadFailed) return null;
  }

  // Flat fallback
  if (content === null) {
    try {
      content = await storage.readFile(wikiRelPath(`${slug}.md`));
      actualPath = flatPath;
      fromFlatRoot = true;
    } catch (err) {
      if (!isEnoent(err)) {
        if (strict) throw err;
        logger.warn("wiki", `readWikiPage failed for "${slug}":`, err);
        return null;
      }

      // Only a true global miss may consult the caller's owner hint. This
      // recovers a crash-left first write whose silo landed before its flat
      // compatibility copy/index, while an indexed or flat Page always wins.
      if (!indexedEntry && options?.owner !== undefined) {
        await readSilo(tenantForOwner(options.owner));
        if (authoritativeReadFailed) return null;
      }
      // A TOTAL MISS ON THE CANONICAL SPELLING IS NOT YET A MISSING PAGE
      // (DW-490). On a case-SENSITIVE store the object carrying this slug may
      // be spelled `<slug>.MD`, and the Files tab both lists it and (since
      // DW-489) serves it — so refusing it here is what 404s the save door on a
      // row the tab shows as editable. Probe the same roots that were already
      // tried, in the same order: each attempted silo first, then the flat
      // root, so a recovered variant loses to nothing an ordinary read would
      // have preferred. A hit is an ORDINARY hit whose `path` names the object
      // actually read.
      for (const attempted of attemptedTenants) {
        const recovered = await readStoredPageVariant(slug, attempted, strict);
        if (recovered !== null) {
          content = recovered.content;
          actualPath = path.join(getDataDir(), recovered.key);
          break;
        }
      }
      if (content === null) {
        const recovered = await readStoredPageVariant(slug, null, strict);
        if (recovered !== null) {
          content = recovered.content;
          actualPath = path.join(getDataDir(), recovered.key);
          fromFlatRoot = true;
        }
      }

      if (content === null) {
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

    // An unseeded or incomplete metadata index cannot identify the silo up front. The flat
    // compatibility copy still carries the immutable owner, so use it only as
    // a routing hint and prefer the matching silo bytes when they exist. This
    // keeps a stale flat copy from restoring old public content after an index
    // outage while preserving the migration fallback for truly flat-only
    // Pages.
    if (fromFlatRoot) {
      let inferredTenant: string | null = null;
      try {
        const { data } = parseFrontmatter(content);
        const owner = typeof data.owner === "string" ? data.owner : undefined;
        inferredTenant = tenantForOwner(owner);
      } catch {
        // Malformed frontmatter remains the responsibility of the extended read
        // below; do not convert that established error into a missing Page here.
      }
      if (inferredTenant !== null) {
        await readSilo(inferredTenant);
        if (authoritativeReadFailed) return null;
      }
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
 * `{ fresh: true }` when the bytes are about to back a write precondition.
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
  // `let`, not `const`: on the ENOENT branch below the target is RE-ELECTED
  // onto the object that actually carries this slug (DW-490).
  let storagePath = tenant
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
    } else {
      // ...OR the object carrying this slug is spelled some other casing of
      // `.md`, which only a case-SENSITIVE store can be holding (DW-490). Then
      // this is NOT a first write: retarget the bytes onto the object the
      // reader was shown and snapshot ITS content as the revision, rather than
      // creating a second object for one slug and orphaning the first. Only
      // ever reached once the canonical spelling proved absent, so a
      // case-INSENSITIVE store makes exactly the calls it made before and lands
      // on exactly the key it landed on before. `saveRevision` stays keyed by
      // slug; only the key the bytes land on changes.
      //
      // STRICT, so an INDETERMINATE probe fails the write. Swallowing a
      // non-ENOENT fault here would fall through to the canonical
      // `<slug>.md` and create exactly the second object DW-490 exists to
      // prevent — orphaning the real bytes and skipping their revision, with
      // nothing but a log line to say so. That is strictly worse than the
      // dropped edit `writeWikiPageIfContentMatches` refuses for the same
      // reason, and it is `readWikiPage`'s strict rationale exactly: absence
      // inferred from a blip is what authorizes a destructive fix.
      const recovered = await readStoredPageVariant(slug, tenant ?? null, true);
      if (recovered !== null) {
        storagePath = recovered.key;
        await saveRevision(slug, recovered.content, author, reason, tenant);
      }
    }
  }

  await storage.writeFile(storagePath, content);

  // Invalidate cache entry so next read fetches fresh data
  if (pageCache !== null) {
    pageCache.delete(slug);
  }
}

/**
 * Atomically create a wiki page without overwriting an existing page.
 *
 * Returns `false` when the target already exists. Unlike `writeWikiPage`, this
 * intentionally does not create a revision because a successful call is the
 * first write for the path.
 */
export async function createWikiPage(
  slug: string,
  content: string,
  tenant?: string,
): Promise<boolean> {
  validateSlug(slug);
  const storagePath = tenant
    ? tenantWikiRelPath(tenant, `${slug}.md`)
    : wikiRelPath(`${slug}.md`);
  const created = await getStorage().writeFileIfAbsent(storagePath, content);
  if (created && pageCache !== null) pageCache.delete(slug);
  return created;
}

/**
 * Replace a Page only when the provider still holds the exact bytes the
 * caller transformed. The content comparison binds the caller's source bytes
 * to the provider etag; the conditional write closes the read/write race.
 */
export async function writeWikiPageIfContentMatches(
  slug: string,
  content: string,
  expectedContent: string,
  author?: string,
  reason?: string,
  tenant?: string,
): Promise<boolean> {
  validateSlug(slug);
  // `let` for the same reason {@link writeWikiPage}'s is: the ENOENT branch
  // re-elects the target onto the object carrying this slug (DW-490).
  let storagePath = tenant
    ? tenantWikiRelPath(tenant, `${slug}.md`)
    : wikiRelPath(`${slug}.md`);
  const storage = getStorage();
  let current: { content: string; etag: string };
  try {
    current = await storage.readFileWithEtag(storagePath);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    // The canonical spelling is absent, which on a case-SENSITIVE store does
    // not mean the page is: retarget the etag read, the comparison AND the CAS
    // onto the elected object, so this compares against the same bytes the
    // caller was shown and rewrites the same object. `strict` is true because
    // this is a write precondition — a transient blip flattened into `false`
    // here reads as "someone else won the race" and silently drops the edit.
    const recovered = await readStoredPageVariant(slug, tenant ?? null, true);
    if (recovered === null) return false;
    storagePath = recovered.key;
    try {
      current = await storage.readFileWithEtag(storagePath);
    } catch (retry) {
      if (isEnoent(retry)) return false;
      throw retry;
    }
  }
  if (current.content !== expectedContent) return false;

  // Preserve the source snapshot before publication, matching writeWikiPage's
  // history contract. A losing CAS may leave a harmless duplicate snapshot,
  // but it can never overwrite the competing Page.
  await saveRevision(slug, expectedContent, author, reason, tenant);
  const written = await storage.writeFileIfMatch(storagePath, content, current.etag);
  if (written && pageCache !== null) pageCache.delete(slug);
  return written;
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
async function readIndexBaseEntries(options?: { strict?: boolean }): Promise<IndexEntry[]> {
  const storagePath = wikiRelPath("index.md");
  let raw: string;
  try {
    raw = await getStorage().readFile(storagePath);
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      if (options?.strict) throw err;
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
 * rebuild. A page whose authoritative metadata cannot be read is represented
 * as private + unowned so a transient failure can reduce availability but can
 * never turn unknown visibility into public access.
 */
export async function scanWikiPagesUncached(options?: { strict?: boolean }): Promise<IndexEntry[]> {
  const baseEntries = await readIndexBaseEntries(options);
  return Promise.all(
    baseEntries.map(async (entry): Promise<IndexEntry> => {
      try {
        const page = await readWikiPageWithFrontmatter(
          entry.slug,
          { fresh: true, strict: true },
        );
        if (!page) return { ...entry, visibility: "private" };
        return enrichEntry(entry, page.frontmatter);
      } catch (err) {
        logger.warn(
          "wiki",
          `listWikiPages: failed to read frontmatter for "${entry.slug}" — hiding it`,
          err,
        );
        return { ...entry, visibility: "private" };
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
export async function listWikiPages(options?: { strict?: boolean }): Promise<IndexEntry[]> {
  const { getPageIndex, getPageIndexDirtySlugs } = await import("./page-index");
  const meta = await getPageIndex();
  if (meta === null) return scanWikiPagesUncached(options);

  let dirty: Set<string>;
  try {
    dirty = await getPageIndexDirtySlugs();
  } catch (error) {
    if (options?.strict) throw error;
    logger.warn("page-index", "dirty-set read failed; falling back to scan", error);
    return scanWikiPagesUncached(options);
  }

  const baseEntries = await readIndexBaseEntries(options);
  return Promise.all(baseEntries.map(async (b) => {
    if (dirty.has(b.slug)) {
      try {
        const page = await readWikiPageWithFrontmatter(
          b.slug,
          { fresh: true, strict: true },
        );
        // Missing/unreadable authoritative bytes are not permission to expose
        // a stale public row. Private + unowned is denied to every non-admin.
        return page
          ? enrichEntry(b, page.frontmatter)
          : { ...b, visibility: "private" as const };
      } catch (error) {
        logger.warn("page-index", `dirty Page read failed for "${b.slug}"; hiding it`, error);
        return { ...b, visibility: "private" as const };
      }
    }
    const m = meta[b.slug];
    // index.md stays authoritative for title/summary; the metadata index
    // supplies the enriched fields. A slug missing from the index (just added,
    // pre-rebuild) falls back to its plain base entry.
    return m ? { ...m, title: b.title, slug: b.slug, summary: b.summary } : b;
  }));
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
  await withDurableLock("index.md", async () => {
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
 * **Do not call from outside a `withDurableLock("index.md", …)` block** — use
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
