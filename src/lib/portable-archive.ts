import { strToU8, unzipSync, zipSync } from "fflate";
import { isEnoent, isEnotdir } from "./errors";
import { rebuildDerivedIndexes } from "./maintenance";
import { buildAliasIndex } from "./alias-index";
import { buildSourceIndex } from "./source-index";
import { getStorage } from "./storage";
import { withDurableLock } from "./lock";
import { tenantForOwner, validateTenant } from "./wiki";
import { rawRelPath, wikiRelPath } from "./wiki";
import { enrichEntry, listWikiPages, updateIndexUnsafe, validateSlug } from "./wiki";
import { parseFrontmatter } from "./frontmatter";
import type { IndexEntry } from "./types";
import { effectivePurposeOverrides } from "./wikis";

export interface PortableArchiveManifest {
  format: "workwiki-portable-archive";
  version: 1;
  owner: string;
  tenant: string;
  createdAt: string;
  files: Array<{ path: string; size: number; sha256: string }>;
}

export interface PortableArchiveInspection {
  manifest: PortableArchiveManifest;
  fileCount: number;
  totalBytes: number;
  collisions: string[];
  newFiles: string[];
}

const MAX_FILES = 10_000;
const MAX_BYTES = 500 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 5 * 1024 * 1024;
const ARCHIVE_INFRASTRUCTURE_PATHS = new Set(["wiki/index.md", "wiki/log.md"]);

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

async function walk(prefix: string, base = prefix): Promise<string[]> {
  const result: string[] = [];
  for (const entry of await getStorage().listFiles(prefix)) {
    const child = `${prefix}/${entry.name}`;
    if (entry.isDirectory) result.push(...await walk(child, base));
    else result.push(child.slice(base.length + 1));
    if (result.length > MAX_FILES) throw new Error("Archive exceeds the file-count safety limit");
  }
  return result;
}

async function sha256(bytes: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function bytesBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function safeRelativePath(path: string): boolean {
  return Boolean(path) &&
    path.length <= 1_000 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment && segment !== "." && segment !== "..");
}

export async function buildPortableArchive(owner: string): Promise<{
  manifest: PortableArchiveManifest;
  bytes: Uint8Array;
}> {
  const ownerTenant = tenant(owner);
  const root = `tenants/${ownerTenant}`;
  // The index is rebuilt after import and the log is append-only global audit
  // infrastructure. Neither is a portable Page payload.
  const paths = (await walk(root)).filter((path) => !ARCHIVE_INFRASTRUCTURE_PATHS.has(path));
  const purposeOverrides = await effectivePurposeOverrides(owner);
  const archiveFiles: Record<string, Uint8Array> = {};
  const manifest: PortableArchiveManifest = {
    format: "workwiki-portable-archive",
    version: 1,
    owner,
    tenant: ownerTenant,
    createdAt: new Date().toISOString(),
    files: [],
  };
  let totalBytes = 0;
  for (const path of paths.sort()) {
    const sourcePath = `${root}/${path}`;
    const effectivePurpose = purposeOverrides.get(sourcePath);
    // Ask the size before pulling the bytes (DW-679), in the same two-check
    // shape `createOwnerBackupUnlocked` carries (DW-542). `stat` is one statx on
    // disk, one HEAD on R2; `readAsset` is the whole object. Without this, the
    // file that trips the 500 MB ceiling is materialised in full to copy zero
    // bytes of it — the worst case is exactly the case that cannot afford it.
    //
    // THE COST, stated plainly: one extra `stat` on EVERY file — one extra HEAD
    // per object on R2 — bought against AT MOST ONE avoided read. It is worth
    // taking only because the read it avoids is, by definition, of a file big
    // enough to break a 500 MB ceiling inside one isolate.
    //
    // AND IT IS NOT SYMMETRIC. An UNDER-reporting stat is caught by the retained
    // post-read check below. An OVER-reporting one rejects an archive that would
    // actually have fit — and unlike the backup loop, which truncates and says
    // so in its manifest, this path THROWS, so there is no partial archive and
    // no record of why: the owner just cannot export. Wrong in the conservative
    // and visible direction, but louder here than there.
    //
    // Only the READING path is gated: a purpose override supplies its own bytes
    // from memory, so there is no read to avoid and `stat` would measure the
    // wrong thing (the file on disk, not the bytes being archived).
    //
    // `stat` GATES; it never ACCOUNTS. `totalBytes`, each manifest entry's
    // `size` and its `sha256` still come only from the bytes actually read, so
    // the post-read test below is what keeps the invariant true when `stat`
    // under-reports. The message is identical either way, so which check fired
    // is invisible to every caller.
    if (effectivePurpose === undefined) {
      const { size } = await getStorage().stat(sourcePath);
      if (totalBytes + size > MAX_BYTES) {
        throw new Error("Archive exceeds the 500 MB safety limit");
      }
    }
    const data = effectivePurpose === undefined
      ? await getStorage().readAsset(sourcePath)
      : new TextEncoder().encode(effectivePurpose).buffer;
    totalBytes += data.byteLength;
    // The check above is the optimisation; this one owns the invariant.
    if (totalBytes > MAX_BYTES) throw new Error("Archive exceeds the 500 MB safety limit");
    const bytes = new Uint8Array(data);
    archiveFiles[`files/${path}`] = bytes;
    manifest.files.push({ path, size: bytes.byteLength, sha256: await sha256(data) });
  }
  const obsidianStubs: Record<string, string> = {
    ".obsidian/app.json": JSON.stringify({ legacyEditor: false, livePreview: true }, null, 2),
    ".obsidian/appearance.json": JSON.stringify({ baseFontSize: 16 }, null, 2),
    ".obsidian/core-plugins.json": JSON.stringify({
      "file-explorer": true,
      "global-search": true,
      "backlink": true,
      "graph": true,
      "outline": true,
    }, null, 2),
  };
  for (const [path, text] of Object.entries(obsidianStubs)) {
    if (archiveFiles[`files/${path}`]) continue;
    const bytes = strToU8(text);
    archiveFiles[`files/${path}`] = bytes;
    manifest.files.push({
      path,
      size: bytes.byteLength,
      sha256: await sha256(bytesBuffer(bytes)),
    });
  }
  archiveFiles["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
  return { manifest, bytes: zipSync(archiveFiles, { level: 6 }) };
}

async function parseArchive(owner: string, bytes: ArrayBuffer): Promise<{
  inspection: PortableArchiveInspection;
  files: Record<string, Uint8Array>;
}> {
  if (bytes.byteLength > MAX_BYTES) throw new Error("Archive exceeds the 500 MB safety limit");
  let files: Record<string, Uint8Array>;
  let safetyError: Error | null = null;
  let expandedBytes = 0;
  let expandedFiles = 0;
  try {
    files = unzipSync(new Uint8Array(bytes), {
      filter: (file) => {
        expandedFiles += 1;
        if (expandedFiles > MAX_FILES + 1) {
          safetyError = new Error("Archive exceeds the file-count safety limit");
          throw safetyError;
        }
        if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0) {
          safetyError = new Error("Archive contains an invalid expanded size");
          throw safetyError;
        }
        if (file.name === "manifest.json" && file.originalSize > MAX_MANIFEST_BYTES) {
          safetyError = new Error("Archive manifest exceeds the safety limit");
          throw safetyError;
        }
        expandedBytes += file.originalSize;
        if (expandedBytes > MAX_BYTES + MAX_MANIFEST_BYTES) {
          safetyError = new Error("Archive expands beyond the 500 MB safety limit");
          throw safetyError;
        }
        return true;
      },
    });
  } catch {
    if (safetyError) throw safetyError;
    throw new Error("The file is not a valid ZIP archive");
  }
  const manifestBytes = files["manifest.json"];
  if (!manifestBytes) throw new Error("Archive manifest is missing");
  const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as PortableArchiveManifest;
  if (
    manifest.format !== "workwiki-portable-archive" ||
    manifest.version !== 1 ||
    !Array.isArray(manifest.files) ||
    manifest.files.length > MAX_FILES
  ) throw new Error("Archive manifest is unsupported or invalid");
  if (manifest.tenant !== tenant(owner)) {
    throw new Error("Archive belongs to a different owner tenant");
  }
  const collisions: string[] = [];
  const newFiles: string[] = [];
  let totalBytes = 0;
  for (const entry of manifest.files) {
    if (!safeRelativePath(entry.path)) throw new Error(`Unsafe archive path: ${entry.path}`);
    const data = files[`files/${entry.path}`];
    if (!data || data.byteLength !== entry.size || await sha256(bytesBuffer(data)) !== entry.sha256) {
      throw new Error(`Archive checksum failed: ${entry.path}`);
    }
    const pageMatch = /^wiki\/(.+)\.md$/.exec(entry.path);
    if (pageMatch && !["index", "log"].includes(pageMatch[1])) {
      validateSlug(pageMatch[1]);
      const parsed = parseFrontmatter(new TextDecoder().decode(data));
      const pageOwner = typeof parsed.data.owner === "string" ? parsed.data.owner : undefined;
      if (tenantForOwner(pageOwner) !== tenant(owner)) {
        throw new Error(`Archive page owner does not match archive tenant: ${pageMatch[1]}`);
      }
    }
    totalBytes += data.byteLength;
    if (totalBytes > MAX_BYTES) throw new Error("Archive expands beyond the 500 MB safety limit");
    try {
      // A yes/no question deserves a yes/no call: this probe only asks whether
      // the tenant path is occupied, and `readAsset` answered it by pulling the
      // entire existing object into memory and discarding it — once per
      // manifest entry, for every inspection and every import. `stat` is the
      // metadata call, and it raises the SAME ENOENT the branching below reads.
      //
      // But "occupied" is two different answers, and only one of them is a
      // collision. `readAsset` raised EISDIR on a DIRECTORY and fell through to
      // the rethrow below, failing the whole archive loudly; `stat` SUCCEEDS
      // there, so a tenant path blocked by a directory would be filed as an
      // ordinary collision — silently skipped under `collision: "skip"` — and
      // the entry would simply never import (DW-701). `FileInfo.isDirectory`
      // keeps the loud failure without the second round trip DW-679 removed:
      // no write this import can make will ever land at that path, so refusing
      // the archive is the only honest answer.
      const info = await getStorage().stat(`tenants/${tenant(owner)}/${entry.path}`);
      if (info.isDirectory) {
        // Leaves through the catch below, which rethrows anything that is not
        // ENOENT — a plain Error carries no errno, so it propagates unchanged.
        throw new Error(
          `Archive path is blocked by an existing directory: ${entry.path}`,
        );
      }
      collisions.push(entry.path);
    } catch (error) {
      if (isEnoent(error)) newFiles.push(entry.path);
      // AN ANCESTOR SEGMENT IS A FILE (DW-745). `stat` walks the whole path, so
      // a regular file at `raw/atlas` makes `raw/atlas/source.bin` raise
      // ENOTDIR rather than the ENOENT above — the same unwritable-forever
      // situation the `isDirectory` refusal names, arriving as an errno instead
      // of as a verdict. Rethrown RAW it carried the storage layer's message,
      // which `FilesystemStorage.stat` builds from `this.resolve(filePath)` —
      // an ABSOLUTE host path, echoed to the caller by
      // `/api/archive/import`'s catch. Same loud refusal as the directory case,
      // same archive-relative vocabulary, and the errno rides as `cause`.
      else if (isEnotdir(error)) {
        throw new Error(
          `Archive path is blocked by an existing file in its folder path: ${entry.path}`,
          { cause: error },
        );
      } else throw error;
    }
  }
  return {
    inspection: { manifest, fileCount: manifest.files.length, totalBytes, collisions, newFiles },
    files,
  };
}

export async function inspectPortableArchive(
  owner: string,
  bytes: ArrayBuffer,
): Promise<PortableArchiveInspection> {
  return (await parseArchive(owner, bytes)).inspection;
}

export async function importPortableArchive(
  owner: string,
  bytes: ArrayBuffer,
  collision: "skip" | "overwrite",
): Promise<PortableArchiveInspection & { imported: number; skipped: number; indexes: Record<string, { ok: boolean; error?: string }> }> {
  return withDurableLock("merge-pages", async () => {
    const { inspection, files } = await parseArchive(owner, bytes);
    const collisionSet = new Set(inspection.collisions);
    const existingEntries = await listWikiPages({ strict: true });
    const archivePageSlugs = inspection.manifest.files.flatMap((entry) => {
      const match = /^wiki\/(.+)\.md$/.exec(entry.path);
      return match && !["index", "log"].includes(match[1]) ? [match[1]] : [];
    });
    const tenantEntries = await getStorage().listFiles("tenants");
    for (const slug of archivePageSlugs) {
      validateSlug(slug);
      await withDurableLock(`page-lifecycle:${slug}`, async () => {
        for (const tenantEntry of tenantEntries) {
          if (!tenantEntry.isDirectory || tenantEntry.name.startsWith(".")) continue;
          try {
            const canonical = await getStorage().readFile(
              `tenants/${tenantEntry.name}/wiki/${slug}.md`,
            );
            const parsed = parseFrontmatter(canonical);
            const canonicalOwner = typeof parsed.data.owner === "string"
              ? parsed.data.owner
              : undefined;
            if (
              tenantForOwner(canonicalOwner) !== tenantEntry.name
              || tenantEntry.name !== tenant(owner)
            ) {
              throw new Error(`Archive page conflicts with another owner: ${slug}`);
            }
          } catch (error) {
            if (!isEnoent(error)) throw error;
          }
        }
        try {
          const flat = await getStorage().readFile(wikiRelPath(`${slug}.md`));
          const parsed = parseFrontmatter(flat);
          const flatOwner = typeof parsed.data.owner === "string" ? parsed.data.owner : undefined;
          if (tenantForOwner(flatOwner) !== tenant(owner)) {
            throw new Error(`Archive page conflicts with another owner: ${slug}`);
          }
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        const conflict = existingEntries.find((entry) => entry.slug === slug);
        if (conflict && tenantForOwner(conflict.owner) !== tenant(owner)) {
          throw new Error(`Archive page conflicts with another owner: ${slug}`);
        }
      });
    }
  let imported = 0;
  let skipped = 0;
  // Every entry is written through ONE batch: the manifest loop is the path
  // that paid an fsync per entry (two, with the compatibility copy), and it is
  // exactly the kind of caller the door is for — if the process dies mid-import
  // the recovery is to re-run the import from the same archive bytes, which are
  // still sitting in `files`. Publication is unchanged: each entry is still
  // tmp+renamed under its own publication lock, so a reader never sees a torn
  // page and the per-slug `withDurableLock` around a page write still holds.
  await getStorage().withBatchedWrites(async (batch) => {
    for (const entry of inspection.manifest.files) {
      // Version 1 exports historically included these files. Accept those
      // backups for compatibility, but never restore global/rebuilt
      // infrastructure from archive bytes.
      if (ARCHIVE_INFRASTRUCTURE_PATHS.has(entry.path)) {
        skipped += 1;
        continue;
      }
      if (collision === "skip" && collisionSet.has(entry.path)) {
        skipped += 1;
        continue;
      }
      const writeEntry = async () => {
        await batch.writeAsset(
          `tenants/${tenant(owner)}/${entry.path}`,
          bytesBuffer(files[`files/${entry.path}`]),
        );
        // Tenant storage is canonical, but the current transition still rebuilds
        // global indexes from flat compatibility paths. Restore those copies for
        // page, raw, and discussion artifacts before invoking the rebuild.
        const compatibilityPath = entry.path.startsWith("wiki/")
          ? wikiRelPath(entry.path.slice("wiki/".length))
          : entry.path.startsWith("raw/")
            ? rawRelPath(entry.path.slice("raw/".length))
            : entry.path.startsWith("discuss/")
              ? entry.path
              : null;
        if (compatibilityPath) {
          await batch.writeAsset(
            compatibilityPath,
            bytesBuffer(files[`files/${entry.path}`]),
          );
        }
      };
      const pageMatch = /^wiki\/(.+)\.md$/.exec(entry.path);
      if (pageMatch && !["index", "log"].includes(pageMatch[1])) {
        await withDurableLock(`page-lifecycle:${pageMatch[1]}`, writeEntry);
      } else {
        await writeEntry();
      }
      imported += 1;
    }
  });
  // The batch is flushed by the line above, BEFORE the reconstruction below —
  // which reads every page it just wrote back off the provider. Those reads
  // would succeed either way (a batch member is published, only its durability
  // is deferred), but the index this reconstruction writes is the pointer that
  // makes the restored pages discoverable, so it must not be made durable ahead
  // of the pages it names.
  //
  // THE WINDOW THIS STILL LEAVES. `updateIndexUnsafe` below is a NORMAL fsynced
  // write, and so are the derived-index rebuilds after it, while the pages they
  // name were made durable only by their batch's directory barriers. A crash in
  // between can therefore leave a rebuilt index naming pages whose bytes were
  // lost. Nothing here detects that; the recovery is the same as for any other
  // half-finished import — RE-RUN THE IMPORT from the same archive, which
  // rewrites every entry and rebuilds the index over them.
  //
  // Reconstruct the flat index from every canonical page in this tenant. The
  // current transition still uses wiki/index.md as ordered discovery ground
  // truth, so a restore must seed it before rebuilding the derived indexes.
  await withDurableLock("index.md", async () => {
    const ownerEntries: IndexEntry[] = [];
    const wikiRoot = `tenants/${tenant(owner)}/wiki`;
    const listPagePaths = async (prefix: string, relative = ""): Promise<string[]> => {
      const found: string[] = [];
      for (const entry of await getStorage().listFiles(prefix)) {
        if (entry.name.startsWith(".")) continue;
        const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
        if (entry.isDirectory) {
          found.push(...await listPagePaths(`${prefix}/${entry.name}`, nextRelative));
        } else if (entry.name.endsWith(".md")) {
          found.push(nextRelative);
        }
      }
      return found;
    };
    for (const pagePath of await listPagePaths(wikiRoot)) {
      const slug = pagePath.slice(0, -3);
      if (["index", "log"].includes(slug)) continue;
      validateSlug(slug);
      const content = await getStorage().readFile(`${wikiRoot}/${pagePath}`);
      const parsed = parseFrontmatter(content);
      if (tenantForOwner(typeof parsed.data.owner === "string" ? parsed.data.owner : undefined) !== tenant(owner)) {
        throw new Error(`Restored page owner does not match archive tenant: ${slug}`);
      }
      const title = parsed.body.match(/^#\s+(.+)$/m)?.[1]?.trim() || slug;
      const summary = parsed.body
        .replace(/^#\s+.+$/m, "")
        .split(/\n\s*\n/)
        .map((value) => value.replace(/[#*_`>\[\]]/g, "").trim())
        .find(Boolean)?.slice(0, 500) || "Restored from owner archive";
      ownerEntries.push(enrichEntry({ slug, title, summary }, parsed.data));
    }
    const currentEntries = await listWikiPages({ strict: true });
    await updateIndexUnsafe([
      ...currentEntries.filter((entry) => tenantForOwner(entry.owner) !== tenant(owner)),
      ...ownerEntries.sort((a, b) => a.title.localeCompare(b.title)),
    ]);
  });
  const indexes = await rebuildDerivedIndexes();
  await Promise.all([buildAliasIndex(), buildSourceIndex()]);
    return { ...inspection, imported, skipped, indexes };
  });
}
