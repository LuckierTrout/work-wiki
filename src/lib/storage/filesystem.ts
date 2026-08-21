/**
 * FilesystemStorageProvider — wraps Node.js `fs` behind the StorageProvider
 * interface.
 *
 * All paths passed to methods are resolved relative to the `basePath` given
 * at construction time. This is the concrete provider used when running on
 * Node.js (i.e. not on Cloudflare Workers).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import type {
  StorageProvider,
  BatchWrite,
  FileInfo,
  FileWithEtag,
  FileEntry,
  EmbeddingEntry,
  EmbeddingMatch,
} from "./types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Scratch files written by {@link FilesystemStorageProvider.atomicWrite}.
 *
 * The shape (`.tmp-<uuid>.tmp`) is chosen so that no path the app itself
 * constructs can collide with it: those come from slugs, ids, and fixed names,
 * none of which is both dot-prefixed and `.tmp`-suffixed. That is a convention,
 * NOT an invariant this layer enforces — nothing validates a path against this
 * pattern on the way in. `src/lib/portable-archive.ts` writes a caller-supplied
 * `entry.path` through `writeAsset` verbatim (only `safeRelativePath` stands in
 * the way, and it is a traversal check, not a name-shape one), so a crafted
 * archive entry named `.tmp-<uuid>.tmp` WOULD be stored and would then be
 * permanently invisible to {@link FilesystemStorageProvider.listFiles}. Callers
 * that accept externally-supplied paths own that check.
 */
const TMP_ARTIFACT = /^\.tmp-[0-9a-f-]+\.tmp$/i;

/**
 * How many entries of a {@link FilesystemStorageProvider.writeBatch} are staged
 * and flushed before any of them is renamed.
 *
 * `fsync` flushes ONE inode; nothing makes N files durable in a single call, and
 * skipping the per-file flush before `rename` is exactly the delayed-allocation
 * hazard that leaves zero-length files after a crash. So this does not reduce
 * the number of fsyncs — it reduces the number of DURABILITY BARRIERS. A
 * window's flushes are issued concurrently and the filesystem group-commits
 * them, costing one round-trip's worth of latency instead of N serialized ones,
 * and nothing in the window is published until that barrier has passed.
 *
 * 32 rather than "the whole batch": every staged entry holds an open handle and
 * a full second copy of its bytes on disk, so an unbounded window would turn a
 * 10,000-file archive import into 10,000 concurrent handles and a transient
 * doubling of the whole import's size.
 */
export const BATCH_SYNC_WINDOW = 32;

/** Cosine similarity between two equal-length vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector dimension mismatch: ${a.length} vs ${b.length}`);
  }
  if (a.length === 0) return 0;

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  if (denom === 0) return 0;

  return dot / denom;
}

// ---------------------------------------------------------------------------
// Provider implementation
// ---------------------------------------------------------------------------

export class FilesystemStorageProvider implements StorageProvider {
  private readonly basePath: string;

  constructor(basePath: string) {
    this.basePath = basePath;
  }

  /** Resolve a relative path against the base. */
  private resolve(rel: string): string {
    return path.resolve(this.basePath, rel);
  }

  /** Ensure parent directory exists for a file path. */
  private async ensureParent(absPath: string): Promise<void> {
    await fs.mkdir(path.dirname(absPath), { recursive: true });
  }

  /**
   * Replace a whole file by rename, so a reader never sees a partial one.
   *
   * Every SINGLE-FILE write in this provider goes through here — `writeFile`,
   * `writeAsset`, `writeFileIfMatch`, `putIndex` and `saveEmbeddings` — which is
   * the point of it being one helper: a bare `fs.writeFile` truncates the
   * destination in place, so a fault mid-write (ENOSPC, process death) leaves a
   * TRUNCATED file, and a truncated `wikis.json` degrades to an empty registry
   * that no compensation can tell from a legitimately empty one.
   *
   * The tmp file is created in the destination's OWN directory so the rename
   * stays within one filesystem and is therefore atomic, and it is fsynced and
   * closed before the rename so the bytes are on disk before any name points at
   * them. On any failure the tmp file is removed, leaving neither an artifact
   * nor a changed destination.
   *
   * What this is NOT: crash-durability for the rename itself. That would need
   * an fsync of the parent directory, which is not portable, so a power loss
   * can still lose the newest bytes. Losing the newest bytes leaves a WHOLE
   * older file, which callers already reason about correctly; a torn one they
   * could not.
   *
   * `appendFile` is deliberately excluded — an append cannot be tmp-and-renamed
   * without reading the whole file back. {@link FilesystemStorageProvider.writeBatch}
   * is excluded for a different reason: it needs the stage and the publish as
   * two separately-timed steps (see {@link FilesystemStorageProvider.stageBatchEntry}),
   * and it holds the SAME per-entry guarantee this one does.
   *
   * SIDE EFFECTS OF REPLACING RATHER THAN TRUNCATING. Each of these is a real
   * difference from the bare `fs.writeFile` this replaced, none of which the
   * app's own callers depend on today:
   *
   *   - The destination gets a NEW inode. Hard links to the old file detach and
   *     keep the old bytes, and a destination that is a SYMLINK is replaced by
   *     a regular file rather than written through to its target.
   *   - Only `mode & 0o777` is carried over. Ownership (uid/gid), the setuid,
   *     setgid and sticky bits, and ACLs/xattrs are not — the replacement gets
   *     whatever the creating process and filesystem give it.
   *   - The write now needs write permission on the destination's DIRECTORY (to
   *     create and rename the tmp file), not just on the destination, and it
   *     needs transient free space for BOTH copies at once.
   *
   * THE OPTIONAL `precondition` is evaluated at the last possible moment: after
   * the replacement is written, flushed and closed, and immediately before the
   * `rename` that publishes it. That ordering is the point — checking first
   * would leave the entire write plus its fsync inside the window between the
   * check and the publish, where a concurrent writer's change goes unnoticed;
   * checking here leaves only the `rename` itself. Answering `false` discards
   * the staged file and publishes nothing, and the call returns `false` rather
   * than throwing. A write with no precondition always returns `true`.
   */
  private async atomicWrite(
    absPath: string,
    data: string | Buffer,
    precondition?: () => Promise<boolean>,
  ): Promise<boolean> {
    await this.ensureParent(absPath);
    const tmp = path.join(
      path.dirname(absPath),
      `.tmp-${crypto.randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(tmp, "wx");
      // Boxed rather than a bare `unknown`, so a thrown `undefined` is still
      // distinguishable from "nothing failed".
      let failure: { error: unknown } | null = null;
      try {
        // Carry the destination's mode over when it already exists; a brand-new
        // file keeps the default `fs.writeFile` would have given it.
        const mode = await fs.stat(absPath).then(
          (st) => st.mode & 0o777,
          () => null,
        );
        if (mode !== null) await handle.chmod(mode);
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        failure = { error };
      }
      // A `finally { await handle.close() }` would let a close rejection
      // REPLACE the write or sync error already in flight — the caller would
      // then see EBADF instead of the ENOSPC that actually stopped the write.
      // The first error wins; a close failure on the otherwise-clean path still
      // surfaces, and still throws BEFORE the rename, so a handle that could
      // not be closed never gets published.
      try {
        await handle.close();
      } catch (error) {
        failure ??= { error };
      }
      if (failure) throw failure.error;
      if (precondition && !(await precondition())) {
        // A refusal is an outcome, not a fault, so the discard must not turn it
        // into one — {@link FilesystemStorageProvider.discardStaged} swallows an
        // unlink failure for the same reason the catch below does.
        await this.discardStaged([tmp]);
        return false;
      }
      await fs.rename(tmp, absPath);
      return true;
    } catch (error) {
      // Cleanup must never change what propagates. `force` only suppresses
      // ENOENT, so an EPERM/EACCES/EBUSY unlink would otherwise replace the
      // original ENOSPC/EISDIR with an unrelated one — and callers branch on
      // error IDENTITY (`wikis.ts`'s compensation re-throws the original; the
      // research-registry suite asserts the very object). A leaked tmp file is
      // the lesser harm: `listFiles` already hides it.
      try {
        await fs.rm(tmp, { force: true });
      } catch {
        // Deliberately swallowed — see above.
      }
      throw error;
    }
  }

  /**
   * Stage one entry of a batch: write it to a sibling tmp file, flush it, close
   * it, and hand the tmp path back UNPUBLISHED.
   *
   * Deliberately NOT {@link FilesystemStorageProvider.atomicWrite} with a
   * "don't rename" flag: the two have different lifetimes. `atomicWrite` owns
   * its scratch file end to end and never returns with one alive, so its cleanup
   * can live in a single `catch`. A staged entry outlives this call by design —
   * it waits for the rest of its window to reach the same point — so ownership
   * passes to {@link FilesystemStorageProvider.writeBatch}, which is the only
   * thing that knows when the whole window is safe to publish or must be
   * discarded together.
   */
  private async stageBatchEntry(
    absPath: string,
    data: string | Buffer,
  ): Promise<string> {
    await this.ensureParent(absPath);
    const tmp = path.join(
      path.dirname(absPath),
      `.tmp-${crypto.randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(tmp, "wx");
      // Boxed rather than a bare `unknown`, so a thrown `undefined` is still
      // distinguishable from "nothing failed" — same reason as in
      // {@link FilesystemStorageProvider.atomicWrite}.
      let failure: { error: unknown } | null = null;
      try {
        // The destination's mode is carried over here exactly as the
        // single-file door carries it, so a batched write to an existing file
        // does not silently widen its permissions.
        const mode = await fs.stat(absPath).then(
          (st) => st.mode & 0o777,
          () => null,
        );
        if (mode !== null) await handle.chmod(mode);
        await handle.writeFile(data);
        await handle.sync();
      } catch (error) {
        failure = { error };
      }
      // NOT a `finally { await handle.close() }`: a close rejection would then
      // REPLACE the write or sync error already in flight, and the caller would
      // see EBADF instead of the ENOSPC that actually stopped the write. The
      // first error wins, and a close failure on the otherwise-clean path still
      // throws — so an entry whose handle could not be closed is never handed
      // back for the window to publish.
      try {
        await handle.close();
      } catch (error) {
        failure ??= { error };
      }
      if (failure) throw failure.error;
      return tmp;
    } catch (error) {
      // Cleanup must never change what propagates — see `atomicWrite`'s catch
      // for why callers branch on error IDENTITY. `discardStaged` swallows its
      // own failures for that reason, and an `open` that rejected created
      // nothing for it to remove.
      await this.discardStaged([tmp]);
      throw error;
    }
  }

  /** Remove staged scratch files without ever changing what propagates. */
  private async discardStaged(tmpPaths: readonly string[]): Promise<void> {
    await Promise.all(
      tmpPaths.map((tmp) => fs.rm(tmp, { force: true }).catch(() => undefined)),
    );
  }

  /**
   * See {@link StorageProvider.writeBatch} for the contract. What this
   * implementation does, window by window of {@link BATCH_SYNC_WINDOW}:
   *
   *   1. stage + flush every entry in the window CONCURRENTLY — one fsync each,
   *      issued together so the filesystem group-commits them;
   *   2. only once the whole window is durable, rename every staged file into
   *      place.
   *
   * Nothing is published before its own bytes are on disk, so per-entry
   * tear-freedom is exactly what it is for `writeFile`. What the window does NOT
   * buy is atomicity ACROSS entries: step 2 renames one path at a time, so a
   * fault there leaves the earlier renames standing. That is why the interface
   * says this is not a transaction.
   *
   * On any fault, every tmp file the window created is removed — including the
   * ones that were staged successfully — and the FIRST failing entry's error
   * propagates unchanged, so a caller branching on error identity sees exactly
   * what the equivalent single write would have thrown.
   */
  async writeBatch(entries: readonly BatchWrite[]): Promise<void> {
    if (entries.length === 0) return;

    // Before ANY file is written. Both refusals below are about the same thing:
    // a window's writes are concurrent, so two entries whose destinations
    // interfere have no defined order, and the ambiguity is refused rather than
    // resolved into whichever one happened to finish last.
    //
    // Keyed on the RESOLVED path, not the literal one, so `a/b.md` and
    // `./a/b.md` are caught as the one destination they are.
    const destinations = new Map<string, string>();
    for (const entry of entries) {
      const abs = this.resolve(entry.path);
      if (destinations.has(abs)) {
        throw new Error(`writeBatch: duplicate path in one batch: ${entry.path}`);
      }
      destinations.set(abs, entry.path);
    }

    // The second interference is a NESTING one: an entry writing `a` and an
    // entry writing `a/b.md` cannot both succeed, because `a` has to be a file
    // for one and a directory for the other. Which of the two fails depends on
    // which staging call reached `mkdir`/`open` first, so left alone it is a
    // race with two different errors rather than an answer. A separate pass
    // because an ancestor may be listed AFTER its own descendant.
    for (const [abs, given] of destinations) {
      for (
        let dir = path.dirname(abs);
        dir !== path.dirname(dir);
        dir = path.dirname(dir)
      ) {
        const ancestor = destinations.get(dir);
        if (ancestor !== undefined) {
          throw new Error(
            `writeBatch: "${ancestor}" is a directory prefix of "${given}" in ` +
              `one batch`,
          );
        }
      }
    }

    for (let start = 0; start < entries.length; start += BATCH_SYNC_WINDOW) {
      const window = entries.slice(start, start + BATCH_SYNC_WINDOW);
      const staged = await Promise.allSettled(
        window.map(async (entry) => {
          const abs = this.resolve(entry.path);
          const data =
            typeof entry.body === "string" ? entry.body : Buffer.from(entry.body);
          return { abs, tmp: await this.stageBatchEntry(abs, data) };
        }),
      );

      // `allSettled` rather than `all` so a fault cannot leave the OTHER
      // in-flight entries' tmp files behind, unreferenced and unremovable.
      const alive = staged.flatMap((result) =>
        result.status === "fulfilled" ? [result.value] : [],
      );
      const stageFault = staged.find((result) => result.status === "rejected");
      if (stageFault) {
        await this.discardStaged(alive.map((entry) => entry.tmp));
        throw (stageFault as PromiseRejectedResult).reason;
      }

      const published = await Promise.allSettled(
        alive.map((entry) => fs.rename(entry.tmp, entry.abs)),
      );
      const publishFault = published.find((result) => result.status === "rejected");
      if (publishFault) {
        // A successful rename left no tmp behind, so `force` makes those no-ops.
        await this.discardStaged(alive.map((entry) => entry.tmp));
        throw (publishFault as PromiseRejectedResult).reason;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Text files
  // -------------------------------------------------------------------------

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(this.resolve(filePath), "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    await this.atomicWrite(this.resolve(filePath), content);
  }

  async deleteFile(filePath: string): Promise<void> {
    await fs.unlink(this.resolve(filePath));
  }

  async listFiles(prefix: string): Promise<FileEntry[]> {
    const abs = this.resolve(prefix);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        // In-flight and crash-leftover `atomicWrite` scratch files are not
        // content and must never surface. Every OTHER dot-prefixed entry still
        // does — `.discarded` is a real marker `sweepOrphans` depends on.
        .filter((entry) => !TMP_ARTIFACT.test(entry.name))
        .map((entry) => ({
          name: entry.name,
          isDirectory: entry.isDirectory(),
        }));
    } catch (err: unknown) {
      // If the directory doesn't exist, return empty list
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(this.resolve(filePath));
      return true;
    } catch {
      return false;
    }
  }

  async appendFile(filePath: string, content: string): Promise<void> {
    const abs = this.resolve(filePath);
    await this.ensureParent(abs);
    await fs.appendFile(abs, content, "utf-8");
  }

  async stat(filePath: string): Promise<FileInfo> {
    const st = await fs.stat(this.resolve(filePath));
    return {
      size: st.size,
      lastModified: st.mtime,
    };
  }

  async deleteDirectory(dirPath: string): Promise<void> {
    await fs.rm(this.resolve(dirPath), { recursive: true, force: true });
  }

  // -------------------------------------------------------------------------
  // Assets (binary data)
  // -------------------------------------------------------------------------

  async writeAsset(filePath: string, data: ArrayBuffer): Promise<void> {
    await this.atomicWrite(this.resolve(filePath), Buffer.from(data));
  }

  async readAsset(filePath: string): Promise<ArrayBuffer> {
    const buf = await fs.readFile(this.resolve(filePath));
    return buf.buffer.slice(
      buf.byteOffset,
      buf.byteOffset + buf.byteLength,
    ) as ArrayBuffer;
  }

  // -------------------------------------------------------------------------
  // Optimistic concurrency
  // -------------------------------------------------------------------------

  /**
   * The version tag: a hash OF THE CONTENT, prefixed with the scheme that
   * produced it.
   *
   * It used to be `${mtime}-${size}`, which is a description of the file rather
   * than of its bytes, and two properties of that made a losing
   * compare-and-set win. `mtime` has millisecond resolution here, so a rewrite
   * that landed in the same millisecond at the same byte length produced an
   * IDENTICAL tag — `saveConfig` writes a fixed-shape JSON object, so equal
   * length is the common case, not a contrived one. And reading the tag needed a
   * `stat` beside the `readFile`, two syscalls describing two different moments:
   * a write landing between them handed the caller old content with a fresh tag.
   * A content hash has neither problem — it is computed from the exact bytes
   * being returned, in the one read that returns them.
   *
   * OVER BYTES, NOT OVER THE DECODED STRING. `fs.readFile(…, "utf-8")` maps every
   * invalid UTF-8 sequence to U+FFFD, so two files that differ only in such
   * bytes decode identically and would share a tag — the interface states the
   * guarantee over content without qualification, so it has to hold over the
   * bytes on disk and not over one lossy reading of them.
   *
   * The `h1:` prefix is a scheme marker, not decoration. No etag outlives the
   * request that read it — both consumers (`config.ts`'s settings save,
   * `graphify-jobs.ts`'s retry loop) read one and hand it straight back, and the
   * value the browser holds across requests is the config's own version token,
   * not this — so nothing needs migrating. The prefix is for the NEXT scheme:
   * `h1:` cannot collide with `mtime-size` or with whatever replaces it, so a
   * tag from another scheme loses its compare-and-set rather than matching by
   * accident.
   */
  private etagFor(bytes: Buffer): string {
    return `h1:${createHash("sha256").update(bytes).digest("hex")}`;
  }

  /**
   * The current tag for a path, or `null` when there is nothing there this
   * compare-and-set could ever match.
   *
   * EISDIR COUNTS AS NOTHING, deliberately. The check this replaced was a
   * `stat`, which SUCCEEDS on a directory and produced a tag that simply never
   * matched, so `writeFileIfMatch` against a directory answered `false`. A
   * `readFile` throws EISDIR instead, and letting that propagate would turn a
   * settled `false` into an exception at every caller that has been treating
   * "not a file I can replace" as a lost compare-and-set. Every OTHER error
   * still propagates: a tag that cannot be read for any other reason is a fault,
   * not a refusal.
   */
  private async currentEtag(absPath: string): Promise<string | null> {
    try {
      return this.etagFor(await fs.readFile(absPath));
    } catch (err: unknown) {
      const code =
        err instanceof Error && "code" in err
          ? (err as NodeJS.ErrnoException).code
          : undefined;
      if (code === "ENOENT" || code === "EISDIR") return null;
      throw err;
    }
  }

  async readFileWithEtag(filePath: string): Promise<FileWithEtag> {
    // ONE read, and the tag is derived from what it returned. The `stat` this
    // used to pair with the read described a different instant, so a write
    // landing between the two produced old content carrying a fresh tag — a
    // compare-and-set built on that pair could be handed a stale merge base and
    // still match on the way back out.
    const bytes = await fs.readFile(this.resolve(filePath));
    return { content: bytes.toString("utf-8"), etag: this.etagFor(bytes) };
  }

  /**
   * Compare-and-set: publish `content` only if the file still holds exactly what
   * `etag` described.
   *
   * THE COMPARISON HAPPENS TWICE, on purpose.
   *
   * The cheap pre-check is what makes the COMMON refusal cost one read instead
   * of a staged write plus an fsync, and it is also what keeps a call against a
   * path that does not exist from creating that path's parent directory — the
   * staging step would `mkdir -p` before discovering there was nothing to
   * replace. It answers `false` rather than throwing for a destination that is a
   * directory, matching what the `stat` it replaced did — see
   * {@link FilesystemStorageProvider.currentEtag}.
   *
   * The re-check inside {@link FilesystemStorageProvider.atomicWrite} is the one
   * that decides. It runs after the replacement is written, flushed and closed,
   * so what remains between "the file still matches" and "the file is replaced"
   * is a single `rename` — not a read, a write and an fsync, which is what the
   * check-then-write shape used to leave exposed.
   *
   * WHAT IS STILL OPEN: that `rename`. A writer whose own rename lands inside it
   * is overwritten without being noticed. Closing that would take a lock or a
   * storage primitive this provider does not have — see
   * {@link StorageProvider.writeFileIfMatch}, which records the residue for both
   * providers, and `saveConfig`, which records what it means for a settings save.
   */
  async writeFileIfMatch(
    filePath: string,
    content: string,
    etag: string,
  ): Promise<boolean> {
    const abs = this.resolve(filePath);
    if ((await this.currentEtag(abs)) !== etag) return false;
    return this.atomicWrite(
      abs,
      content,
      async () => (await this.currentEtag(abs)) === etag,
    );
  }

  // -------------------------------------------------------------------------
  // Derived indexes
  // -------------------------------------------------------------------------

  private indexPath(key: string): string {
    return this.resolve(path.join(".indexes", `${key}.json`));
  }

  async getIndex<T = unknown>(key: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.indexPath(key), "utf-8");
      return JSON.parse(raw) as T;
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  async putIndex<T = unknown>(key: string, value: T): Promise<void> {
    await this.atomicWrite(this.indexPath(key), JSON.stringify(value));
  }

  async listIndexKeys(prefix: string): Promise<string[]> {
    const indexDir = this.resolve(".indexes");
    try {
      const entries = await fs.readdir(indexDir);
      const suffix = ".json";
      return entries
        .filter((f) => f.startsWith(prefix) && f.endsWith(suffix))
        .map((f) => f.slice(0, -suffix.length));
    } catch (err: unknown) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Embeddings / vector search
  // -------------------------------------------------------------------------

  private embeddingsPath(): string {
    return this.indexPath("embeddings");
  }

  private async loadEmbeddings(): Promise<EmbeddingEntry[]> {
    try {
      const raw = await fs.readFile(this.embeddingsPath(), "utf-8");
      return JSON.parse(raw) as EmbeddingEntry[];
    } catch (err: unknown) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw err;
    }
  }

  private async saveEmbeddings(entries: EmbeddingEntry[]): Promise<void> {
    await this.atomicWrite(this.embeddingsPath(), JSON.stringify(entries));
  }

  async upsertEmbedding(
    id: string,
    vector: number[],
    metadata: Record<string, string>,
  ): Promise<void> {
    const entries = await this.loadEmbeddings();
    const idx = entries.findIndex((e) => e.id === id);
    const entry: EmbeddingEntry = { id, vector, metadata };
    if (idx >= 0) {
      entries[idx] = entry;
    } else {
      entries.push(entry);
    }
    await this.saveEmbeddings(entries);
  }

  /**
   * See {@link StorageProvider.upsertEmbeddings}. Every vector lives in ONE JSON
   * blob here, so the per-vector door pays a whole-blob load, rewrite and fsync
   * each time — a 64-page rebuild wrote a growing blob 64 times. This loads it
   * once, applies the whole batch in memory, and saves once.
   *
   * The id→position map is built before the merge and kept current as entries
   * are appended, so a repeated id inside one call updates the entry the earlier
   * one created rather than appending a second copy — "later wins", as the
   * interface says, and never a duplicate id in the stored blob.
   */
  async upsertEmbeddings(entries: readonly EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const stored = await this.loadEmbeddings();
    const positions = new Map(stored.map((entry, index) => [entry.id, index]));
    for (const { id, vector, metadata } of entries) {
      const at = positions.get(id);
      if (at === undefined) {
        positions.set(id, stored.length);
        stored.push({ id, vector, metadata });
      } else {
        stored[at] = { id, vector, metadata };
      }
    }
    await this.saveEmbeddings(stored);
  }

  async queryEmbeddings(
    vector: number[],
    topK: number,
  ): Promise<EmbeddingMatch[]> {
    const entries = await this.loadEmbeddings();
    const scored = entries.map((e) => ({
      id: e.id,
      score: cosineSimilarity(vector, e.vector),
      metadata: e.metadata,
    }));
    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, topK);
  }

  async getEmbeddingById(id: string): Promise<EmbeddingEntry | null> {
    const entries = await this.loadEmbeddings();
    return entries.find((e) => e.id === id) ?? null;
  }

  async removeEmbedding(id: string): Promise<void> {
    const entries = await this.loadEmbeddings();
    const filtered = entries.filter((e) => e.id !== id);
    await this.saveEmbeddings(filtered);
  }

  async clearEmbeddings(): Promise<void> {
    await this.saveEmbeddings([]);
  }
}
