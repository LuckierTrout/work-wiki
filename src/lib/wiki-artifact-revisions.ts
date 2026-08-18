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
 *      `withFileLock(wikiLockKey(owner))` that wraps the artifact write — one
 *      key, one critical section, history and bytes serialized together.
 *   3. NO NEW VISIBILITY. The Files tab's Wiki branch intersects its listing
 *      with `WIKI_ARTIFACT_FILES` and skips directories, so `revisions/` never
 *      surfaces in the tree — which is why it need not be dot-prefixed like
 *      `.revisions`.
 *
 * The SHAPE mirrors `revisions.ts` deliberately (monotonic timestamp stems, a
 * `.meta.json` sidecar for `author`/`reason`, a concurrent stat+meta listing,
 * ENOENT → null / [] with `logger.warn` on anything else), so the two histories
 * read the same way from a route and neither becomes the odd one out. What it
 * does NOT copy is retention: page revisions have no cap, no pruning and no
 * diffing, and neither does this.
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

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

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
}

/**
 * Every revision of `file`, newest first. Empty when the artifact has never
 * been overwritten (or the Wiki is gone) — an absent directory is the normal
 * first-edit state, not an error.
 *
 * The per-revision work (a `stat`, then the optional sidecar) runs for ALL
 * revisions in parallel, the same way `listRevisions` does it: the op COUNT is
 * unchanged, but the listing is ~2 round-trips DEEP rather than 2 per revision,
 * so a heavily-revised artifact does not cost latency proportional to its
 * history.
 */
export async function listWikiArtifactRevisions(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): Promise<ArtifactRevision[]> {
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
    return [];
  }

  const built = await Promise.all(
    entries.map(async (entry): Promise<ArtifactRevision | null> => {
      // `.meta.json` also ends in `.json`, not `.md`, so the sidecars are
      // skipped here and picked up beside their own `.md` below.
      if (entry.isDirectory || !entry.name.endsWith(".md")) return null;
      const timestamp = canonicalStem(entry.name.slice(0, -3));
      if (timestamp === null) return null;

      try {
        const stat = await storage.stat(
          wikiArtifactRevisionPath(owner, wikiId, file, entry.name),
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
            `unexpected error stating revision file "${entry.name}":`,
            error,
          );
        }
        return null;
      }
    }),
  );

  return built
    .filter((revision): revision is ArtifactRevision => revision !== null)
    .sort((a, b) => b.timestamp - a.timestamp);
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
