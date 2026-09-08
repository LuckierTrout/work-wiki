/**
 * Per-Wiki artifact history — the recovery path a Schema edit owes (DW-59).
 *
 * `writeWikiArtifact` overwrites `schema.md` in place. Until this module there
 * was no prior read and no snapshot, so an owner's edit destroyed the previous
 * EXECUTABLE Schema permanently — while the page write it is modelled on
 * (`writeWikiPage` → `saveRevision`) has been snapshotting through
 * `GET/POST /api/wiki/[slug]/revisions` since the beginning. This is that same
 * capability for the one artifact an owner may change.
 *
 * WHY NOT `revisions.ts`. That module keys everything by a `validateSlug`ed page
 * slug under `wiki/.revisions/<slug>/`, and an artifact has NO SLUG — it is
 * addressed by `(owner, wikiId, file)`. Forcing one in would either invent a
 * fake slug (which `reconcileSilos` and the page index would then disagree
 * about) or widen the slug silo to hold non-pages. So the namespace is a SIBLING
 * inside the Wiki's own directory instead:
 *
 *   tenants/<t>/wikis/<id>/revisions/<file>/<timestamp>.md
 *   tenants/<t>/wikis/<id>/revisions/<file>/<timestamp>.meta.json
 *
 * That single placement decision buys three things at once, and they are the
 * reason this feature adds no new machinery anywhere else:
 *
 *   1. NO NEW CLEANUP. `deleteWiki`, `discardCreatedWikiDirectory` and
 *      `sweepOrphans` each already `deleteDirectory(wikiDirPath(...))`, so the
 *      history dies with the Wiki. There is no orphan class to invent.
 *   2. NO NEW LOCK ORDER. `wikis:<tenant>` already owns everything under the
 *      Wiki directory, so the snapshot happens inside the SAME
 *      `withWikiLock(owner)` — `wiki-lock.ts`'s one spelling of
 *      `withFileLock(wikiLockKey(owner))` — that wraps the artifact write: one
 *      key, one critical section, history and bytes serialized together.
 *   3. NO NEW VISIBILITY. The Files tab's Wiki branch intersects its listing
 *      with `WIKI_ARTIFACT_FILES` and skips directories, so `revisions/` never
 *      surfaces in the tree — which is why it need not be dot-prefixed like
 *      `.revisions`.
 *
 * The SHAPE mirrors `revisions.ts` deliberately (monotonic timestamp stems, a
 * `.meta.json` sidecar for `author`/`reason`, a concurrent stat+meta listing,
 * ENOENT → null / [] with `logger.warn` on anything else), so the two histories
 * read the same way from a route and neither becomes the odd one out.
 *
 * RETENTION IS WHERE THE TWO DIVERGE (DW-215). Page revisions spread across one
 * directory PER SLUG, so no single directory grows with a user's whole editing
 * life. Artifact revisions do the opposite: every edit of the same `schema.md`
 * lands in ONE directory, which an unbounded history turns into a directory the
 * listing must read in full on every GET — and, worse, into enough files under
 * `tenants/<t>` to push `backups.ts`'s walk past its own limits. So this module
 * carries a cap that `revisions.ts` still does not need:
 *
 *   - {@link MAX_ARTIFACT_REVISIONS} is BOTH the retention cap and the default
 *     listing bound, deliberately the same number: a history sitting at the cap
 *     is shown whole, and only a backlog written before the cap existed is ever
 *     elided from a listing.
 *   - The prune runs at WRITE time, as a tail on {@link saveWikiArtifactRevision}
 *     AFTER the revision `.md` has landed, and is FAIL-SOFT for exactly the
 *     reason the sidecar write is: a snapshot that succeeded must never be
 *     reported as failed because the housekeeping behind it did not. It takes no
 *     lock of its own — every caller already holds `wikis:<tenant>`.
 *   - The listing's bound is applied to the filename STEMS before any `stat`,
 *     which is what makes the read cheap: the stem IS the timestamp, so the
 *     newest N are knowable from `listFiles` alone and only those cost I/O.
 *
 * Still no diffing and no compaction: a revision is whole bytes or it is gone.
 *
 * Nothing in here takes a lock. Every writer already holds `wikis:<tenant>`
 * (`withFileLock` is not reentrant — see `src/lib/lock.ts`), and every reader is
 * a plain read that needs none.
 *
 * BOTH GUARANTEES ARE PER PROCESS. `lock.ts` is explicit that `withFileLock` is
 * in-process only and does not coordinate across server processes, and
 * {@link uniqueTimestamp} below is a module-global counter with exactly the same
 * scope. So under a multi-process deployment two concurrent saves could
 * interleave read-before-write, or mint the same stem inside one millisecond and
 * have the second overwrite the first. Neither is closed here on purpose: PAGE
 * revisions carry the identical exposure through `saveRevision`, and a
 * `fileExists` retry loop in this one module would buy a false sense of
 * durability while leaving the larger half of the history unprotected. Whichever
 * story gives the deployment a cross-process lock closes both at once.
 */

import { isEnoent } from "./errors";
import { logger } from "./logger";
import { getStorage } from "./storage";
import {
  wikiArtifactRevisionPath,
  wikiArtifactRevisionsDir,
} from "./wiki-paths";
import type { WikiArtifactFile } from "./wiki-scenarios";

/** Metadata about one artifact snapshot (the content itself is on disk). */
export interface ArtifactRevision {
  /** Unix timestamp in milliseconds — also the filename stem. */
  timestamp: number;
  /** ISO 8601 date string for display. */
  date: string;
  /** Which artifact this snapshot is of. */
  file: WikiArtifactFile;
  /** Byte length of the revision content. */
  sizeBytes: number;
  /** Who made the change these bytes were replaced by. */
  author?: string;
  /** Why — an edit summary, or the sentence that names a revert. */
  reason?: string;
}

/** Metadata from a revision's `.meta.json` sidecar. */
export interface ArtifactRevisionMeta {
  author?: string;
  reason?: string;
}

// ---------------------------------------------------------------------------
// Monotonic timestamp
// ---------------------------------------------------------------------------

let lastTimestamp = 0;

/**
 * A strictly increasing millisecond stem, so two snapshots inside one
 * millisecond cannot collide onto the same filename. Same primitive as
 * `revisions.ts`; a separate counter because the two namespaces never share a
 * directory, so they cannot collide with each other.
 */
function uniqueTimestamp(): number {
  const now = Date.now();
  lastTimestamp = now > lastTimestamp ? now : lastTimestamp + 1;
  return lastTimestamp;
}

/**
 * A filename stem back as a timestamp, but ONLY when the stem is the timestamp's
 * own canonical spelling.
 *
 * Everything downstream re-serializes this number: the sidecar is looked up at
 * `${timestamp}.meta.json`, and the number is handed to clients that come back
 * with `?timestamp=`, which reads `${timestamp}.md`. So a stem that parses but
 * does not ROUND-TRIP — `1e12.md`, `012.md`, ` 12.md`, `12.5.md` — would be
 * listed under a timestamp whose content read answers 404 and whose meta never
 * resolves: an entry the owner can see and cannot open. Requiring
 * `String(n) === stem` makes "listed" and "readable" the same set.
 *
 * `Number.isSafeInteger` is the other half: beyond 2^53 distinct milliseconds
 * collapse onto one float, so a stem above it cannot round-trip either.
 */
function canonicalStem(stem: string): number | null {
  const timestamp = Number(stem);
  if (!Number.isSafeInteger(timestamp) || timestamp <= 0) return null;
  if (String(timestamp) !== stem) return null;
  return timestamp;
}

/**
 * The most recent canonical stems in a revision directory, newest first.
 *
 * The ORDER is knowable without any I/O — the stem IS the timestamp — which is
 * the whole reason both the prune and the listing can bound their work here,
 * before a single `stat` or read. Non-canonical stems ({@link canonicalStem})
 * are dropped, so neither half ever names a file the readers would refuse.
 */
function sortedCanonicalStems(
  entries: { name: string; isDirectory: boolean }[],
): number[] {
  return entries
    .filter((entry) => !entry.isDirectory && entry.name.endsWith(".md"))
    .map((entry) => canonicalStem(entry.name.slice(0, -3)))
    .filter((timestamp): timestamp is number => timestamp !== null)
    .sort((a, b) => b - a);
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * How many revisions of one artifact are kept, and how many a listing returns
 * by default.
 *
 * ONE constant for both on purpose — see the retention paragraph in the module
 * header. Raising it makes older revisions visible again only if they survived
 * an earlier prune; it does not resurrect anything.
 */
export const MAX_ARTIFACT_REVISIONS = 50;

/**
 * A caller's `limit` as a count this module can `slice` with.
 *
 * `slice` treats a fractional bound loosely and `NaN` as ZERO — which would
 * turn a mis-computed limit into a silently EMPTY history, the one failure mode
 * a history must never have. Non-finite (`NaN`, either Infinity) falls back to
 * the cap; everything else is floored to a whole count, never below zero.
 */
function boundedLimit(limit: number): number {
  if (!Number.isFinite(limit)) return MAX_ARTIFACT_REVISIONS;
  return Math.max(0, Math.floor(limit));
}

/**
 * Delete every revision of `file` beyond the newest {@link MAX_ARTIFACT_REVISIONS},
 * each `.md` together with its `.meta.json` sidecar.
 *
 * TWO ORDERING RULES, both there so a failed prune stays RETRYABLE:
 *
 *   1. THE SIDECAR GOES FIRST, and the `.md` only if the sidecar went. A stem is
 *      discoverable ONLY through its `.md` — {@link sortedCanonicalStems} reads
 *      nothing else — so removing the `.md` first and then failing on the
 *      sidecar would strand that sidecar permanently: no later prune could ever
 *      name it again. In this order a failure leaves the stem whole and the next
 *      write sweeps it again.
 *   2. EVERY DOOMED STEM IS ATTEMPTED, and the failures are thrown as one at the
 *      end. Bailing on the first would let a single undeletable file block the
 *      prune of every OLDER revision behind it — the directory would then grow
 *      without bound, which is the exact failure this cap exists to prevent.
 *
 * A missing file is not a failure: `deleteFile` throws on one
 * (provider-dependent), and a revision saved with neither author nor reason HAS
 * no sidecar, so that absence is the thing being asked for. Anything else is —
 * and the CALLER is what makes it fail-soft, the same division of labour the
 * sidecar write uses.
 *
 * No lock: the only caller runs inside `wikis:<tenant>` already and
 * `withFileLock` is not reentrant.
 */
async function pruneArtifactRevisions(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): Promise<void> {
  const storage = getStorage();
  const entries = await storage.listFiles(
    wikiArtifactRevisionsDir(owner, wikiId, file),
  );

  const deleteIfPresent = async (name: string): Promise<void> => {
    try {
      await storage.deleteFile(
        wikiArtifactRevisionPath(owner, wikiId, file, name),
      );
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  };

  const failed: number[] = [];
  let firstError: unknown;

  for (const timestamp of sortedCanonicalStems(entries).slice(
    MAX_ARTIFACT_REVISIONS,
  )) {
    try {
      await deleteIfPresent(`${timestamp}.meta.json`);
      await deleteIfPresent(`${timestamp}.md`);
    } catch (error) {
      // This stem stays on disk, whole and still discoverable. Keep sweeping:
      // the revisions behind it are older still and no less over the cap.
      if (failed.length === 0) firstError = error;
      failed.push(timestamp);
    }
  }

  if (failed.length > 0) {
    throw new Error(
      `${failed.length} revision(s) beyond the cap could not be deleted (${failed.join(", ")})`,
      { cause: firstError },
    );
  }
}

/**
 * Snapshot `content` as a revision of `file`.
 *
 * Called by `writeWikiArtifact` with the bytes it is ABOUT TO REPLACE, from
 * inside the Wiki lock. THROWS when the REVISION ITSELF cannot be written — the
 * caller is what makes that fail-soft, because only the caller knows that the
 * save it is recording must succeed anyway.
 *
 * THE SIDECAR IS NOT PART OF THAT CONTRACT. It is written second, so once the
 * `.md` has landed the revision EXISTS: it is in the listing and it can be read
 * and reverted to. Letting a failed sidecar write throw would make the caller
 * warn "snapshotting … failed" about a snapshot that succeeded, which is worse
 * than the thing it reports — the owner would believe their bytes were lost
 * while they are sitting in the history. So the sidecar warns on its own and the
 * revision stands UNATTRIBUTED, which is a state the readers already handle
 * (a missing sidecar is the normal shape of a revision saved with neither
 * author nor reason).
 *
 * The sidecar is written only when there is something to record, so an
 * unattributed revision costs one write rather than two and reads back as a
 * plain `{ timestamp, date, file, sizeBytes }`.
 *
 * THE PRUNE IS THE SAME BARGAIN, ONE STEP FURTHER OUT. It runs last, once the
 * revision and its attribution are both on disk, and it warns rather than
 * throws: an owner whose bytes are safely in the history must not be told the
 * save failed because a file from fifty edits ago could not be removed. What a
 * failed prune leaves behind is a directory over the cap by however many stems
 * resisted deletion — every one of them still whole and still discoverable, so
 * the next write attempts them all again.
 */
export async function saveWikiArtifactRevision(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  content: string,
  author?: string,
  reason?: string,
): Promise<void> {
  const storage = getStorage();
  const timestamp = uniqueTimestamp();
  await storage.writeFile(
    wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.md`),
    content,
  );

  if (author !== undefined || reason !== undefined) {
    const meta: ArtifactRevisionMeta = {};
    if (author !== undefined) meta.author = author;
    if (reason !== undefined) meta.reason = reason;
    try {
      await storage.writeFile(
        wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.meta.json`),
        JSON.stringify(meta),
      );
    } catch (error) {
      // The revision above already landed — see the doc comment. Losing the
      // attribution is a smaller, and differently-shaped, failure than losing
      // the bytes, so it is reported as itself and not re-thrown.
      logger.warn(
        "wiki-artifact-revisions",
        `the revision of "${file}" at ${timestamp} in wiki "${wikiId}" was saved, but its author/reason sidecar was not — the revision stands unattributed`,
        error,
      );
    }
  }

  try {
    await pruneArtifactRevisions(owner, wikiId, file);
  } catch (error) {
    logger.warn(
      "wiki-artifact-revisions",
      `the revision of "${file}" at ${timestamp} in wiki "${wikiId}" was saved, but pruning the history back to ${MAX_ARTIFACT_REVISIONS} revisions failed — the directory holds more than the cap until the next write`,
      error,
    );
  }
}

/**
 * The newest `limit` revisions of `file`, newest first, AND whether that bound
 * is what ended the list. Empty when the artifact has never been overwritten
 * (or the Wiki is gone) — an absent directory is the normal first-edit state,
 * not an error.
 *
 * The bound is applied to the STEMS, before any per-revision I/O, and that
 * placement is the point: slicing the built array instead would still `stat`
 * and sidecar-read every file on disk, so the read cost would still grow with
 * the history. Because the stem is the timestamp, the newest `limit` can be
 * chosen from `listFiles` alone.
 *
 * The per-revision work (a `stat`, then the optional sidecar) then runs for
 * those in parallel, the same way `listRevisions` does it: the listing is ~2
 * round-trips DEEP rather than 2 per revision.
 *
 * `limit` defaults to {@link MAX_ARTIFACT_REVISIONS}, the retention cap, so a
 * history written under the cap is returned whole and only a pre-cap backlog is
 * ever elided. Callers pass their own only to see further back.
 *
 * `truncated` IS COUNTED FROM THE STEMS, not from the rows this returns, and
 * that is the whole reason this function exists beside
 * {@link listWikiArtifactRevisions} (DW-541). A stem whose `stat` throws is
 * dropped below — so a directory holding sixty snapshots with one unreadable
 * yields FORTY-NINE rows, and a caller deriving "was this bounded?" from
 * `revisions.length` would answer no in exactly the case a truncation notice
 * exists to catch. Counted here, a dropped row cannot flip it.
 *
 * AT the bound, not past it (`>=`): the prune keeps exactly
 * {@link MAX_ARTIFACT_REVISIONS} on disk, so a history that HAS been swept
 * holds exactly that many stems. A strict `>` would report every pruned
 * history as whole — the defect inverted.
 */
export async function listWikiArtifactRevisionsPage(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  limit = MAX_ARTIFACT_REVISIONS,
): Promise<{ revisions: ArtifactRevision[]; truncated: boolean }> {
  const storage = getStorage();
  const dir = wikiArtifactRevisionsDir(owner, wikiId, file);

  let entries: { name: string; isDirectory: boolean }[];
  try {
    entries = await storage.listFiles(dir);
  } catch (error) {
    if (!isEnoent(error)) {
      logger.warn(
        "wiki-artifact-revisions",
        `unexpected error reading the revision dir for "${file}" in wiki "${wikiId}":`,
        error,
      );
    }
    return { revisions: [], truncated: false };
  }

  // `.meta.json` also ends in `.json`, not `.md`, so the sidecars are skipped
  // here and picked up beside their own `.md` below.
  const bound = boundedLimit(limit);
  const canonical = sortedCanonicalStems(entries);
  const truncated = canonical.length >= bound;
  const stems = canonical.slice(0, bound);

  const built = await Promise.all(
    stems.map(async (timestamp): Promise<ArtifactRevision | null> => {
      try {
        const stat = await storage.stat(
          wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.md`),
        );
        const meta = await readWikiArtifactRevisionMeta(
          owner,
          wikiId,
          file,
          timestamp,
        );
        return {
          timestamp,
          date: new Date(timestamp).toISOString(),
          file,
          sizeBytes: stat.size,
          ...(meta?.author !== undefined && { author: meta.author }),
          ...(meta?.reason !== undefined && { reason: meta.reason }),
        };
      } catch (error) {
        // The file vanished between the listing and the stat — skip it rather
        // than failing the whole history.
        if (!isEnoent(error)) {
          logger.warn(
            "wiki-artifact-revisions",
            `unexpected error stating revision file "${timestamp}.md":`,
            error,
          );
        }
        return null;
      }
    }),
  );

  // Already newest-first: the stems were sorted before the work was bounded,
  // and dropping nulls preserves that order.
  return {
    revisions: built.filter(
      (revision): revision is ArtifactRevision => revision !== null,
    ),
    truncated,
  };
}

/**
 * The same listing, rows only — the shape every caller but the route wants.
 *
 * A thin delegate rather than a second implementation: the signature, the
 * return type and the bound are unchanged, so nothing that already calls this
 * had to move when {@link listWikiArtifactRevisionsPage} was split out to
 * report the bound alongside them.
 */
export async function listWikiArtifactRevisions(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  limit = MAX_ARTIFACT_REVISIONS,
): Promise<ArtifactRevision[]> {
  return (await listWikiArtifactRevisionsPage(owner, wikiId, file, limit)).revisions;
}

/** One revision's content, or null when there is no such revision. */
export async function readWikiArtifactRevision(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  timestamp: number,
): Promise<string | null> {
  try {
    return await getStorage().readFile(
      wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.md`),
    );
  } catch (error) {
    if (!isEnoent(error)) {
      logger.warn(
        "wiki-artifact-revisions",
        `unexpected error reading revision "${file}@${timestamp}" in wiki "${wikiId}":`,
        error,
      );
    }
    return null;
  }
}

/**
 * One revision's `{ author?, reason? }` sidecar, or null when it has none.
 *
 * A missing sidecar is a legitimate state (a snapshot taken with neither
 * attribution nor a summary), so ENOENT is silent; a sidecar that exists but
 * will not parse is warned about rather than swallowed, because losing
 * attribution silently is how history stops being trustworthy.
 */
export async function readWikiArtifactRevisionMeta(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
  timestamp: number,
): Promise<ArtifactRevisionMeta | null> {
  try {
    const raw = await getStorage().readFile(
      wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.meta.json`),
    );
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const meta: ArtifactRevisionMeta = {};
    if (typeof parsed.author === "string") meta.author = parsed.author;
    if (typeof parsed.reason === "string") meta.reason = parsed.reason;
    return meta;
  } catch (error) {
    if (!isEnoent(error)) {
      logger.warn(
        "wiki-artifact-revisions",
        `unexpected error reading revision meta "${file}@${timestamp}" in wiki "${wikiId}":`,
        error,
      );
    }
    return null;
  }
}
