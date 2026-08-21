import { strToU8, unzipSync, zipSync } from "fflate";
import { isEnoent } from "./errors";
import { rebuildDerivedIndexes } from "./maintenance";
import { buildAliasIndex } from "./alias-index";
import { buildSourceIndex } from "./source-index";
import { getStorage } from "./storage";
import type { BatchWrite } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { rawRelPath, wikiRelPath } from "./wiki";
import { enrichEntry, listWikiPages, updateIndex, validateSlug } from "./wiki";
import { parseFrontmatter } from "./frontmatter";
import type { IndexEntry } from "./types";

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
  const paths = await walk(root);
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
    const data = await getStorage().readAsset(`${root}/${path}`);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_BYTES) throw new Error("Archive exceeds the 500 MB safety limit");
    const bytes = new Uint8Array(data);
    archiveFiles[`files/${path}`] = bytes;
    manifest.files.push({ path, size: bytes.byteLength, sha256: await sha256(data) });
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
  try { files = unzipSync(new Uint8Array(bytes)); } catch { throw new Error("The file is not a valid ZIP archive"); }
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
    totalBytes += data.byteLength;
    if (totalBytes > MAX_BYTES) throw new Error("Archive expands beyond the 500 MB safety limit");
    try {
      await getStorage().readAsset(`tenants/${tenant(owner)}/${entry.path}`);
      collisions.push(entry.path);
    } catch (error) {
      if (isEnoent(error)) newFiles.push(entry.path);
      else throw error;
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
  const { inspection, files } = await parseArchive(owner, bytes);
  const collisionSet = new Set(inspection.collisions);
  const existingEntries = await listWikiPages();
  const archivePageSlugs = inspection.manifest.files.flatMap((entry) => {
    const match = /^wiki\/([^/]+)\.md$/.exec(entry.path);
    return match && !["index", "log"].includes(match[1]) ? [match[1]] : [];
  });
  for (const slug of archivePageSlugs) {
    validateSlug(slug);
    const conflict = existingEntries.find((entry) => entry.slug === slug);
    if (conflict && tenantForOwner(conflict.owner) !== tenant(owner)) {
      throw new Error(`Archive page conflicts with another owner: ${slug}`);
    }
  }
  let imported = 0;
  let skipped = 0;
  // Collected rather than written one at a time: an archive can carry thousands
  // of entries, and each `writeAsset` is its own fsync round-trip. `writeBatch`
  // keeps the per-entry whole-file guarantee and collapses the barriers. Keyed
  // by destination because the manifest is CALLER-SUPPLIED — two entries naming
  // one path (or a compatibility path that collides with another entry's) used
  // to mean "the later write wins", and `writeBatch` refuses ambiguity rather
  // than resolving it, so resolve it here, the same way, before handing it over.
  const restores = new Map<string, BatchWrite>();
  for (const entry of inspection.manifest.files) {
    if (collision === "skip" && collisionSet.has(entry.path)) {
      skipped += 1;
      continue;
    }
    const tenantPath = `tenants/${tenant(owner)}/${entry.path}`;
    restores.set(tenantPath, {
      path: tenantPath,
      body: bytesBuffer(files[`files/${entry.path}`]),
    });
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
      restores.set(compatibilityPath, {
        path: compatibilityPath,
        body: bytesBuffer(files[`files/${entry.path}`]),
      });
    }
    imported += 1;
  }
  await getStorage().writeBatch([...restores.values()]);
  // Reconstruct the flat index from every canonical page in this tenant. The
  // current transition still uses wiki/index.md as ordered discovery ground
  // truth, so a restore must seed it before rebuilding the derived indexes.
  const ownerEntries: IndexEntry[] = [];
  const compatibilityPages = new Map<string, BatchWrite>();
  for (const entry of await getStorage().listFiles(`tenants/${tenant(owner)}/wiki`)) {
    if (entry.isDirectory || !entry.name.endsWith(".md") || entry.name.startsWith(".")) continue;
    const slug = entry.name.slice(0, -3);
    if (["index", "log"].includes(slug)) continue;
    validateSlug(slug);
    const content = await getStorage().readFile(`tenants/${tenant(owner)}/wiki/${entry.name}`);
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
    const compatibilityPath = wikiRelPath(entry.name);
    compatibilityPages.set(compatibilityPath, {
      path: compatibilityPath,
      body: bytesBuffer(new TextEncoder().encode(content)),
    });
  }
  // Issued after the loop, so an owner mismatch on a later page aborts before
  // any of THIS pass's copies is published rather than partway through it.
  //
  // That is not "before anything is published": the loop above already wrote a
  // compatibility copy for every `wiki/` manifest entry, and this pass rewrites
  // the same paths from the canonical tenant copies it just validated. So an
  // abort here still leaves the first pass's copies in place — which is what the
  // per-write version did too, and why the throw is a hard failure a re-import
  // is expected to follow rather than a rollback.
  await getStorage().writeBatch([...compatibilityPages.values()]);
  await updateIndex([
    ...existingEntries.filter((entry) => tenantForOwner(entry.owner) !== tenant(owner)),
    ...ownerEntries.sort((a, b) => a.title.localeCompare(b.title)),
  ]);
  const indexes = await rebuildDerivedIndexes();
  await Promise.all([buildAliasIndex(), buildSourceIndex()]);
  return { ...inspection, imported, skipped, indexes };
}
