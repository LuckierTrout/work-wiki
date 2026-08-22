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
 * RETENTION IS WHERE THE TWO DIVERGE (DW-215). This silo holds at most
 * {@link MAX_ARTIFACT_REVISIONS} snapshots per artifact: every save prunes the
 * oldest revisions — the `.md` and its `.meta.json` sidecar together, and only
 * stems this module minted — back down to that cap, and
 * {@link listWikiArtifactRevisions} bounds itself to the same number BEFORE it
 * pays a `stat` per entry, so a legacy over-cap directory costs a listing rather
 * than a fan-out. The prune is FAIL-SOFT: it runs after the revision has landed
 * and reports itself through `logger.warn` instead of throwing, because the
 * callers in `wikis.ts` would otherwise announce a stored save as lost history.
 * PAGE revisions still have no cap and no pruning, and neither history does
 * diffing — those remain open decisions in `revisions.ts`, not here.
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
// Retention
// ---------------------------------------------------------------------------

/**
 * How many snapshots one artifact's history keeps.
 *
 * The same number bounds BOTH halves of the silo, and that is the point: a cap
 * the writer enforces but the reader does not know about would still stat a
 * legacy backlog on every GET, and a cap the reader applies alone would leave
 * the directory growing forever underneath it. Pruning and the bounded listing
 * are one decision read from two sides.
 *
 * 50 is deep enough that the recovery path this module exists for still reaches
 * back through a long editing session, and shallow enough that a listing's
 * fan-out is a fixed, small number of round-trips.
 */
export const MAX_ARTIFACT_REVISIONS = 50;

/**
 * One `listFiles` of a revision directory, split into what both halves need:
 * the canonical `<timestamp>.md` stems NEWEST FIRST, and which of those
 * timestamps carry a `.meta.json` sidecar.
 *
 * Same shape as `listRevisionAuthors` in `revisions.ts` — ranking and the cap
 * come out of the FILENAMES, so slicing happens before any per-item read, and
 * the sidecar set means attribution is read only where it actually exists.
 *
 * {@link canonicalStem} gates both sides, which is what makes this safe to hand
 * to the pruner: a name that is not a timestamp's own canonical spelling is not
 * something this module wrote, so it is neither listed nor deleted.
 */
function partitionRevisionEntries(
  entries: { name: string; isDirectory: boolean }[],
): { stems: number[]; sidecars: Set<number> } {
  const stems: number[] = [];
  const sidecars = new Set<number>();
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    if (entry.name.endsWith(".meta.json")) {
      const timestamp = canonicalStem(entry.name.slice(0, -".meta.json".length));
      if (timestamp !== null) sidecars.add(timestamp);
    } else if (entry.name.endsWith(".md")) {
      const timestamp = canonicalStem(entry.name.slice(0, -3));
      if (timestamp !== null) stems.push(timestamp);
    }
  }
  stems.sort((a, b) => b - a);
  return { stems, sidecars };
}

/**
 * Delete everything past the newest {@link MAX_ARTIFACT_REVISIONS} revisions of
 * `file`, oldest first.
 *
 * FAIL-SOFT BY CONSTRUCTION. This runs AFTER the revision has been written, so
 * by the time it can fail the snapshot already exists and is readable. Both
 * callers in `wikis.ts` wrap `saveWikiArtifactRevision` in a `catch` that warns
 * "the replaced bytes are not in this wiki's history" — true of a failed write,
 * a lie about a failed prune. So nothing in here rethrows: the worst outcome is
 * a directory left deeper than the cap until the next save tries again.
 *
 * FAIL-SOFT PER REVISION, NOT PER PRUNE. Each revision gets its own `catch`, so
 * one undeletable pair does not abandon every older pair behind it — the case
 * that matters is a directory that is many revisions over the cap, where giving
 * up on the first rejection would leave the backlog permanently un-trimmed. The
 * outer `catch` covers only the listing, which is the one failure that leaves
 * nothing to iterate.
 *
 * OLDEST FIRST, and the SIDECAR BEFORE ITS `.md`. Both orderings are recovery
 * decisions rather than taste:
 *
 *   - Oldest first means an interrupted prune (a crash, a storage blip part-way
 *     through) has removed the least valuable end of the history, and what
 *     survives is a contiguous newest-N — the same shape a complete prune
 *     leaves.
 *   - The `.md` is what puts a timestamp in `stems`, so it is this module's
 *     handle on the pair. Deleting it first and then failing on the sidecar
 *     would strand a `.meta.json` that no later prune can ever see again.
 *     Deleting the sidecar first inverts that: a failure leaves a revision that
 *     is still listed, still readable, and still a prune candidate next time.
 *
 * Only pairs this module minted are touched — {@link partitionRevisionEntries}
 * gates both halves through {@link canonicalStem}, so a foreign name in the
 * directory is neither listed nor deleted — and every delete goes through
 * `wikiArtifactRevisionPath`, never a hand-joined string.
 *
 * No lock: the callers already hold `wikis:<tenant>` around the save this
 * follows, exactly as the write above it does.
 */
async function pruneWikiArtifactRevisions(
  owner: string,
  wikiId: string,
  file: WikiArtifactFile,
): Promise<void> {
  const storage = getStorage();

  let excess: number[];
  let sidecars: Set<number>;
  try {
    const partitioned = partitionRevisionEntries(
      await storage.listFiles(wikiArtifactRevisionsDir(owner, wikiId, file)),
    );
    sidecars = partitioned.sidecars;
    // `stems` is NEWEST first, so the excess is its tail — reversed so the
    // deletes actually run oldest first, the order the policy above promises.
    excess = partitioned.stems.slice(MAX_ARTIFACT_REVISIONS).reverse();
  } catch (error) {
    logger.warn(
      "wiki-artifact-revisions",
      `the history of "${file}" in wiki "${wikiId}" could not be listed, so it was not pruned to ${MAX_ARTIFACT_REVISIONS} revisions — the new revision is stored, the directory is merely deeper than the cap:`,
      error,
    );
    return;
  }

  for (const timestamp of excess) {
    try {
      if (sidecars.has(timestamp)) {
        await storage.deleteFile(
          wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.meta.json`),
        );
      }
      await storage.deleteFile(
        wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.md`),
      );
    } catch (error) {
      // This revision stays; the older ones behind it are still worth trying.
      logger.warn(
        "wiki-artifact-revisions",
        `the revision of "${file}" at ${timestamp} in wiki "${wikiId}" could not be pruned — it stays in the history, leaving it deeper than ${MAX_ARTIFACT_REVISIONS} revisions:`,
        error,
      );
    }
  }
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
 *
 * RETENTION RUNS LAST. Once the snapshot (and its sidecar) has landed, the
 * history is trimmed to the newest {@link MAX_ARTIFACT_REVISIONS} through
 * {@link pruneWikiArtifactRevisions}, which cannot throw — for the same reason
 * the sidecar cannot: the bytes this call exists to preserve are already stored,
 * and a caller told otherwise would report a save that succeeded as a save whose
 * history was lost.
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

  await pruneWikiArtifactRevisions(owner, wikiId, file);
}

/**
 * The newest {@link MAX_ARTIFACT_REVISIONS} revisions of `file`, newest first.
 * Empty when the artifact has never been overwritten (or the Wiki is gone) — an
 * absent directory is the normal first-edit state, not an error.
 *
 * BOUNDED BEFORE THE READS, NOT AFTER. Ranking comes out of the filenames, so
 * the cap is applied to the stems the single `listFiles` returned and only the
 * survivors cost a `stat`. A directory that predates retention (or that a prune
 * failure left deeper than the cap) therefore costs one listing here, not one
 * `stat` per orphaned revision.
 *
 * The per-revision work (a `stat`, then the sidecar where the listing proved one
 * exists) runs for those revisions in parallel, the same way `listRevisions`
 * does it: the listing is ~2 round-trips DEEP rather than 2 per revision.
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

  // One listing gives BOTH the revisions and which of them are attributed, and
  // the stems come back newest first — so the cap is a `slice` over numbers, not
  // a filter over things already stat-ed.
  const { stems, sidecars } = partitionRevisionEntries(entries);

  const built = await Promise.all(
    stems.slice(0, MAX_ARTIFACT_REVISIONS).map(async (
      timestamp,
    ): Promise<ArtifactRevision | null> => {
      try {
        const stat = await storage.stat(
          wikiArtifactRevisionPath(owner, wikiId, file, `${timestamp}.md`),
        );
        // No sidecar in the listing → unattributed; a valid state, and no read.
        const meta = sidecars.has(timestamp)
          ? await readWikiArtifactRevisionMeta(owner, wikiId, file, timestamp)
          : null;
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
