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

import type {
  StorageProvider,
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
   */
  private async atomicWrite(
    absPath: string,
    data: string | Buffer,
  ): Promise<void> {
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
      await fs.rename(tmp, absPath);
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

  async readFileWithEtag(filePath: string): Promise<FileWithEtag> {
    const abs = this.resolve(filePath);
    const [content, st] = await Promise.all([
      fs.readFile(abs, "utf-8"),
      fs.stat(abs),
    ]);
    return {
      content,
      etag: `${st.mtime.getTime()}-${st.size}`,
    };
  }

  async writeFileIfMatch(
    filePath: string,
    content: string,
    etag: string,
  ): Promise<boolean> {
    const abs = this.resolve(filePath);
    try {
      const st = await fs.stat(abs);
      const currentEtag = `${st.mtime.getTime()}-${st.size}`;
      if (currentEtag !== etag) {
        return false;
      }
    } catch (err: unknown) {
      // File doesn't exist — etag can't match
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
        return false;
      }
      throw err;
    }

    await this.atomicWrite(abs, content);
    return true;
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
