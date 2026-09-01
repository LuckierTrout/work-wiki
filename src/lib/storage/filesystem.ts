/**
 * FilesystemStorageProvider — wraps Node.js `fs` behind the StorageProvider
 * interface.
 *
 * All paths passed to methods are resolved relative to the `basePath` given
 * at construction time. This is the concrete provider used when running on
 * Node.js (i.e. not on Cloudflare Workers).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

import type {
  StorageProvider,
  BatchWriter,
  FileInfo,
  FileWithEtag,
  FileEntry,
  EmbeddingEntry,
  EmbeddingMatch,
} from "./types";
import { mergeEmbeddingEntries } from "./types";
import { narrowIndexInteger } from "./index-integer";
import { withFileLock } from "../lock";
import { logger } from "../logger";

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
const LOCK_DIR = ".storage-locks";

/**
 * Errno values that mean "this platform/filesystem will not fsync a directory",
 * not "the barrier failed".
 *
 * fsync on a directory fd is a POSIX-ism the spec does not require and Windows
 * has no analogue for: darwin and Linux answer it, but a directory fd opened
 * elsewhere can refuse with any of these. A refusal is not a durability
 * failure a caller can do anything about — it is the same "not portable" fact
 * `atomicWriteUnlocked`'s docblock already names — so the batch swallows these
 * and propagates everything else (an EIO from a dying disk is real).
 */
const UNSUPPORTED_DIRECTORY_FSYNC_CODES = new Set([
  "EPERM",
  "EISDIR",
  "EINVAL",
  "EACCES",
  "ENOTSUP",
  // The plausible refusals on FUSE and network mounts, where the fsync simply
  // is not implemented for a directory fd. Without them every batched path in
  // the app throws on such a mount — for a barrier the mount was never going to
  // give, which is the definition of a refusal rather than a failure.
  "ENOSYS",
  "EOPNOTSUPP",
]);

/**
 * Errno values that mean the directory is no longer there to barrier.
 *
 * The barrier opens the directory at SCOPE EXIT, not at write time, so a batch
 * whose body deliberately removed a directory it wrote into — a temporary
 * prefix, a tree the body itself cleaned up — would otherwise turn a fully
 * successful body into a thrown ENOENT from the barrier loop. There is nothing
 * left to make durable, and "the name is gone" is not a durability failure.
 */
const VANISHED_DIRECTORY_CODES = new Set(["ENOENT", "ENOTDIR"]);
const LOCK_WAIT_MS = 5;
const LOCK_TIMEOUT_MS = 15_000;
const STALE_LOCK_MS = 5 * 60_000;

function contentEtag(content: string | Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

function publicationLockKey(absPath: string): string {
  return `filesystem-publication:${absPath}`;
}

function publicationLockPath(basePath: string, absPath: string): string {
  const digest = createHash("sha256").update(absPath).digest("hex");
  return path.join(basePath, LOCK_DIR, `${digest}.lock`);
}

async function withFilesystemPublicationLock<T>(
  basePath: string,
  absPath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFileLock(publicationLockKey(absPath), async () => {
    const lockPath = publicationLockPath(basePath, absPath);
    await fs.mkdir(path.dirname(lockPath), { recursive: true });
    const started = Date.now();
    let handle: fs.FileHandle | null = null;
    while (!handle) {
      try {
        const candidate = await fs.open(lockPath, "wx");
        try {
          await candidate.writeFile(JSON.stringify({
            pid: process.pid,
            createdAt: new Date().toISOString(),
          }));
          // Deliberately NOT fsynced. Nothing ever reads this file's contents:
          // exclusion comes from the `wx` create above (the name either appears
          // or it does not), and staleness reclamation below is decided by
          // `mtimeMs`, never by the pid/createdAt JSON inside. Forcing those
          // bytes to stable storage bought a second real barrier on every
          // whole-file write in the provider and bought nothing with it.
          handle = candidate;
        } catch (error) {
          try {
            await candidate.close();
          } catch {
            // Preserve the acquisition failure.
          }
          await fs.rm(lockPath, { force: true }).catch(() => {});
          throw error;
        }
      } catch (error) {
        if (!(error instanceof Error && "code" in error &&
          (error as NodeJS.ErrnoException).code === "EEXIST")) throw error;
        const stale = await fs.stat(lockPath).then(
          (stat) => Date.now() - stat.mtimeMs > STALE_LOCK_MS,
          () => false,
        );
        if (stale) {
          await fs.rm(lockPath, { force: true }).catch(() => {});
          continue;
        }
        if (Date.now() - started >= LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for filesystem publication lock: ${absPath}`);
        }
        await wait(LOCK_WAIT_MS);
      }
    }
    try {
      return await fn();
    } finally {
      try {
        await handle.close();
      } catch {
        // Lock cleanup cannot replace the publication result.
      }
      await fs.rm(lockPath, { force: true }).catch(() => {});
    }
  });
}

/** Test-only deterministic interleaving seam for cooperating provider writers. */
export async function withFilesystemPublicationLockForTest<T>(
  basePath: string,
  filePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return withFilesystemPublicationLock(basePath, path.resolve(basePath, filePath), fn);
}

interface NewFileHandle {
  writeFile(content: string | Buffer): Promise<unknown>;
  sync(): Promise<unknown>;
  close(): Promise<unknown>;
}

/**
 * Write, sync and close while preserving the first publication failure.
 *
 * `sync` defaults to `true` and every caller outside a batch leaves it there:
 * the bytes are on disk before any name points at them. A batch member passes
 * `false` because the scope issues one directory-level barrier for all of its
 * members at exit instead — see {@link FilesystemStorageProvider.withBatchedWrites}
 * for what that trades. The close, and the "first failure wins" rule around it,
 * are identical either way.
 */
export async function writeSyncedNewFile(
  handle: NewFileHandle,
  content: string | Buffer,
  sync = true,
): Promise<void> {
  let failure: { error: unknown } | null = null;
  try {
    await handle.writeFile(content);
    if (sync) await handle.sync();
  } catch (error) {
    failure = { error };
  }
  try {
    await handle.close();
  } catch (error) {
    failure ??= { error };
  }
  if (failure) throw failure.error;
}

/**
 * Sync and close a complete replacement before publishing its name.
 *
 * `sync` is forwarded to {@link writeSyncedNewFile} and defaults to `true`.
 * Publication is the same `rename` either way — a batch member defers the
 * durability of its bytes, never the atomicity of its name.
 */
export async function writeSyncedAndPublish(
  handle: NewFileHandle,
  content: string | Buffer,
  publish: () => Promise<unknown>,
  sync = true,
): Promise<void> {
  await writeSyncedNewFile(handle, content, sync);
  await publish();
}

/**
 * Force a directory's entries to stable storage — the barrier a batch issues
 * once per touched directory instead of one fsync per member file.
 *
 * A directory fsync makes the NAMES durable. It says nothing about the file
 * CONTENTS behind those names, which is the whole of what a batch trades away.
 */
async function syncDirectory(dir: string): Promise<void> {
  const handle = await fs.open(dir, "r");
  try {
    await handle.sync();
  } finally {
    try {
      await handle.close();
    } catch {
      // Closing the barrier's fd cannot replace the barrier's own result.
    }
  }
}

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
   * Every whole-file write in this provider goes through here — `writeFile`,
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
   * without reading the whole file back.
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
   * `syncPayload` defaults to `true` and is `false` for exactly one caller:
   * {@link withBatchedWrites}, which barriers the whole scope's directories
   * once at exit. Everything above still holds when it is off — the tmp file is
   * still complete and closed before the rename, and the rename is still
   * atomic. What is off is only the fsync that would force the tmp file's bytes
   * to stable storage before the name is published.
   */
  private async atomicWriteUnlocked(
    absPath: string,
    data: string | Buffer,
    syncPayload = true,
  ): Promise<void> {
    await this.ensureParent(absPath);
    const tmp = path.join(
      path.dirname(absPath),
      `.tmp-${crypto.randomUUID()}.tmp`,
    );
    try {
      const handle = await fs.open(tmp, "wx");
      // Carry the destination's mode over when it already exists; a brand-new
      // file keeps the default `fs.writeFile` would have given it.
      const mode = await fs.stat(absPath).then(
        (st) => st.mode & 0o777,
        () => null,
      );
      if (mode !== null) {
        try {
          await handle.chmod(mode);
        } catch (error) {
          try {
            await handle.close();
          } catch {
            // Preserve the chmod failure as the first publication error.
          }
          throw error;
        }
      }
      await writeSyncedAndPublish(
        handle,
        data,
        () => fs.rename(tmp, absPath),
        syncPayload,
      );
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

  // -------------------------------------------------------------------------
  // Text files
  // -------------------------------------------------------------------------

  async readFile(filePath: string): Promise<string> {
    return fs.readFile(this.resolve(filePath), "utf-8");
  }

  async writeFile(filePath: string, content: string): Promise<void> {
    const abs = this.resolve(filePath);
    await withFilesystemPublicationLock(this.basePath, abs, () =>
      this.atomicWriteUnlocked(abs, content));
  }

  async deleteFile(filePath: string): Promise<void> {
    const abs = this.resolve(filePath);
    await withFilesystemPublicationLock(this.basePath, abs, () => fs.unlink(abs));
  }

  async listFiles(prefix: string): Promise<FileEntry[]> {
    const abs = this.resolve(prefix);
    try {
      const entries = await fs.readdir(abs, { withFileTypes: true });
      return entries
        // In-flight and crash-leftover `atomicWrite` scratch files are not
        // content and must never surface. Every OTHER dot-prefixed entry still
        // does — `.discarded` is a real marker `sweepOrphans` depends on.
        .filter((entry) => !TMP_ARTIFACT.test(entry.name) && entry.name !== LOCK_DIR)
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
    await withFilesystemPublicationLock(this.basePath, abs, async () => {
      await this.ensureParent(abs);
      await fs.appendFile(abs, content, "utf-8");
    });
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
    const abs = this.resolve(filePath);
    await withFilesystemPublicationLock(this.basePath, abs, () =>
      this.atomicWriteUnlocked(abs, Buffer.from(data)));
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

  async readFileWithEtag(filePath: string): Promise<FileWithEtag> {
    const abs = this.resolve(filePath);
    const content = await fs.readFile(abs, "utf-8");
    return {
      content,
      etag: contentEtag(content),
    };
  }

  /**
   * The one create-only publication both `*IfAbsent` methods run on.
   *
   * `writeSyncedNewFile` already takes `string | Buffer`, so the string and
   * binary doors differ in nothing but the payload — and the parts that must
   * NOT drift are exactly the parts that are easy to copy wrong: the EEXIST
   * branch that answers `false` instead of replacing bytes, the rethrow of
   * every other error, and the tmp cleanup in `finally`.
   *
   * Hard-linking a complete, fsynced tmp inode is what makes the create
   * exclusive without a second read: the name either appears whole or the link
   * fails, so two concurrent creators cannot both win.
   */
  private async createOnlyWrite(
    filePath: string,
    content: string | Buffer,
  ): Promise<boolean> {
    const abs = this.resolve(filePath);
    return withFilesystemPublicationLock(this.basePath, abs, async () => {
      await this.ensureParent(abs);
      const tmp = path.join(path.dirname(abs), `.tmp-${crypto.randomUUID()}.tmp`);
      try {
        const handle = await fs.open(tmp, "wx");
        await writeSyncedNewFile(handle, content);
        try {
          // Hard-linking the complete tmp inode publishes the name atomically and
          // fails with EEXIST without replacing a concurrent creator's bytes.
          await fs.link(tmp, abs);
          return true;
        } catch (error) {
          if (error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "EEXIST") {
            return false;
          }
          throw error;
        }
      } finally {
        try {
          await fs.rm(tmp, { force: true });
        } catch {
          // Scratch cleanup must not replace the create result.
        }
      }
    });
  }

  /**
   * Create `filePath` only when nothing holds that name, per the
   * `StorageProvider` contract: `true` for the creator, `false` when the path
   * exists, and the existing bytes never touched either way.
   */
  async writeFileIfAbsent(filePath: string, content: string): Promise<boolean> {
    return this.createOnlyWrite(filePath, content);
  }

  /**
   * The binary twin of {@link writeFileIfAbsent} — same shape, same guarantee,
   * `Buffer.from(data)` instead of a UTF-8 string because a PDF is not text.
   *
   * The payload is the ONLY difference, which is why both delegate to
   * {@link createOnlyWrite}: the exclusivity comes from `fs.link` publishing a
   * complete inode under a name that cannot be taken twice, which is what
   * removes the check-then-write window a separate `fileExists` left.
   */
  async writeAssetIfAbsent(filePath: string, data: ArrayBuffer): Promise<boolean> {
    return this.createOnlyWrite(filePath, Buffer.from(data));
  }

  async writeFileIfMatch(
    filePath: string,
    content: string,
    etag: string,
  ): Promise<boolean> {
    const abs = this.resolve(filePath);
    return withFilesystemPublicationLock(this.basePath, abs, async () => {
      try {
        const current = await fs.readFile(abs);
        if (contentEtag(current) !== etag) return false;
      } catch (err: unknown) {
        // File doesn't exist — etag can't match
        if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
          return false;
        }
        throw err;
      }
      await this.atomicWriteUnlocked(abs, content);
      return true;
    });
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
    const abs = this.indexPath(key);
    await withFilesystemPublicationLock(this.basePath, abs, () =>
      this.atomicWriteUnlocked(abs, JSON.stringify(value)));
  }

  async incrementIndex(key: string): Promise<number> {
    // A different key from the app-level `DATA_VERSION_LOCK` so a caller that
    // still holds that lock (none should) cannot deadlock on a reentrant
    // acquire. Two processes on one DATA_DIR still serialize here via the
    // in-process chain; local next-dev is one process.
    return withFileLock(`index:${key}`, async () => {
      const next = narrowIndexInteger(await this.getIndex(key)) + 1;
      await this.putIndex(key, next);
      return next;
    });
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
    const abs = this.embeddingsPath();
    await withFilesystemPublicationLock(this.basePath, abs, () =>
      this.atomicWriteUnlocked(abs, JSON.stringify(entries)));
  }

  /**
   * One vector, through the bulk door.
   *
   * Delegating rather than duplicating is the point: the merge rule (position
   * by first appearance, value by last write) has exactly ONE implementation,
   * so a single upsert and a bulk upsert can never disagree about where an id
   * lands or which value survives.
   */
  async upsertEmbedding(
    id: string,
    vector: number[],
    metadata: Record<string, string>,
  ): Promise<void> {
    await this.upsertEmbeddings([{ id, vector, metadata }]);
  }

  /**
   * One load, one merge, one store for the whole set.
   *
   * This file's embeddings live in a single `.indexes/embeddings.json` blob, so
   * the per-vector door reloads, rewrites and fsyncs that entire blob once per
   * vector — `rebuildVectorStore` over N pages paid N full index rewrites. The
   * set collapses to one.
   *
   * An empty set writes NOTHING: no store, no barrier, the stored bytes and
   * their mtime untouched. That matters because a rebuild that embedded nothing
   * must not be able to rewrite the index it never contributed to.
   */
  async upsertEmbeddings(entries: EmbeddingEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const stored = await this.loadEmbeddings();
    await this.saveEmbeddings(mergeEmbeddingEntries(stored, entries));
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

  // -------------------------------------------------------------------------
  // Batched writes
  // -------------------------------------------------------------------------

  /**
   * Run `fn` with a writer whose members share one barrier per touched
   * directory, issued here at scope exit.
   *
   * Each member still goes through {@link withFilesystemPublicationLock} and
   * {@link atomicWriteUnlocked} — the same tmp file in the destination's own
   * directory, the same `rename`, the same cleanup that must not change which
   * error propagates. The single difference is `syncPayload: false`: the tmp
   * file's bytes are not forced to disk before the name is published. So
   * publication is unchanged (no torn reads, a rejected write leaves the
   * destination exactly as it was, a resolved write is immediately readable)
   * and only the durability point moves — see the interface docblock for who
   * may take that trade.
   *
   * A directory is recorded BEFORE its write is attempted, so a member that
   * throws still gets its directory barriered: a failed rename may still have
   * left the destination's parent dirty from the tmp file's create and unlink.
   *
   * EXIT ORDER. The barrier runs whether the body resolved or threw, because a
   * body that threw may have landed writes before it did. If the body threw,
   * the body's error is what the caller can act on, so any barrier failure is
   * logged and swallowed; if it resolved, a barrier failure propagates unless
   * its code says this filesystem simply does not fsync directories, or says
   * the directory is no longer there to barrier at all.
   *
   * THE WRITER IS CLOSED AT EXIT. A body that leaks `batch` — stores it, or
   * returns a promise it never awaited — would otherwise get a write that is
   * neither individually synced NOR covered by any barrier, which is strictly
   * worse than either mode. A member call after the scope has exited throws.
   */
  async withBatchedWrites<T>(fn: (batch: BatchWriter) => Promise<T>): Promise<T> {
    const directories = new Set<string>();
    let closed = false;
    const batchWrite = async (
      filePath: string,
      data: string | Buffer,
    ): Promise<void> => {
      if (closed) {
        throw new Error(
          `withBatchedWrites: the batch writer was used after its scope exited (${filePath}). ` +
            "Every write must be awaited inside the body; the barrier has already run.",
        );
      }
      const abs = this.resolve(filePath);
      directories.add(path.dirname(abs));
      await withFilesystemPublicationLock(this.basePath, abs, () =>
        this.atomicWriteUnlocked(abs, data, false));
    };
    const batch: BatchWriter = {
      writeFile: (filePath, content) => batchWrite(filePath, content),
      writeAsset: (filePath, data) => batchWrite(filePath, Buffer.from(data)),
    };

    // Definite-assignment: `result` is read only on the path where the body
    // resolved, which is the path that assigned it.
    let result!: T;
    let bodyFailure: { error: unknown } | null = null;
    try {
      result = await fn(batch);
    } catch (error) {
      bodyFailure = { error };
    } finally {
      // Before the barrier loop, so nothing can slip a write in between the
      // last barrier and the return.
      closed = true;
    }

    let barrierFailure: unknown = null;
    for (const dir of directories) {
      try {
        await syncDirectory(dir);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code !== undefined && (
          UNSUPPORTED_DIRECTORY_FSYNC_CODES.has(code)
          || VANISHED_DIRECTORY_CODES.has(code)
        )) {
          continue;
        }
        // Keep going: every OTHER directory in the scope still deserves its
        // barrier, and only the first real failure is reported.
        barrierFailure ??= error;
      }
    }

    if (bodyFailure) {
      if (barrierFailure !== null) {
        logger.warn(
          "storage",
          "withBatchedWrites: directory barrier failed while the batch body was already failing; " +
            "reporting the body's error:",
          barrierFailure,
        );
      }
      throw bodyFailure.error;
    }
    if (barrierFailure !== null) throw barrierFailure;
    return result;
  }
}
