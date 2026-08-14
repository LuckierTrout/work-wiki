import { isEnoent } from "./errors";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import { recordOperationSafe } from "./operation-ledger";
import { withFileLock } from "./lock";

export interface BackupFileEntry {
  path: string;
  backupPath: string;
  size: number;
  sha256: string;
}

export interface BackupManifest {
  version: 1;
  id: string;
  owner: string;
  tenant: string;
  createdAt: string;
  files: BackupFileEntry[];
  totalBytes: number;
  verifiedAt?: string;
  verificationStatus?: "passed" | "failed";
  verificationError?: string;
}

export type BackupSummary = Omit<BackupManifest, "files"> & { fileCount: number };

const MAX_BACKUP_FILES = 10_000;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

function ownerTenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function validateBackupId(id: string): void {
  if (!/^bak_[a-z0-9-]{8,100}$/i.test(id)) throw new Error("Invalid backup id");
}

function backupRoot(owner: string, id: string): string {
  validateBackupId(id);
  return `backups/${ownerTenant(owner)}/${id}`;
}

function manifestPath(owner: string, id: string): string {
  return `${backupRoot(owner, id)}/manifest.json`;
}

async function sha256(data: ArrayBuffer): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function walkFiles(prefix: string): Promise<string[]> {
  const files: string[] = [];
  const entries = await getStorage().listFiles(prefix);
  for (const entry of entries) {
    const child = `${prefix}/${entry.name}`;
    if (entry.isDirectory) files.push(...await walkFiles(child));
    else files.push(child);
    if (files.length > MAX_BACKUP_FILES) {
      throw new Error(`Backup exceeds the ${MAX_BACKUP_FILES}-file safety limit`);
    }
  }
  return files;
}

async function writeManifest(manifest: BackupManifest): Promise<void> {
  await getStorage().writeFile(
    manifestPath(manifest.owner, manifest.id),
    JSON.stringify(manifest, null, 2),
  );
}

async function createOwnerBackupUnlocked(
  owner: string,
  now: Date = new Date(),
): Promise<BackupManifest> {
  const tenant = ownerTenant(owner);
  const id = `bak_${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const sourceRoot = `tenants/${tenant}`;
  const root = backupRoot(owner, id);
  const files = await walkFiles(sourceRoot);
  const entries: BackupFileEntry[] = [];
  let totalBytes = 0;

  for (const sourcePath of files) {
    const data = await getStorage().readAsset(sourcePath);
    totalBytes += data.byteLength;
    if (totalBytes > MAX_BACKUP_BYTES) {
      throw new Error("Backup exceeds the 2 GB safety limit");
    }
    const relative = sourcePath.slice(sourceRoot.length + 1);
    const destination = `${root}/files/${relative}`;
    await getStorage().writeAsset(destination, data);
    entries.push({
      path: sourcePath,
      backupPath: destination,
      size: data.byteLength,
      sha256: await sha256(data),
    });
  }

  const manifest: BackupManifest = {
    version: 1,
    id,
    owner,
    tenant,
    createdAt: now.toISOString(),
    files: entries,
    totalBytes,
  };
  await writeManifest(manifest);
  await recordOperationSafe(owner, {
    kind: "backup",
    operation: "create",
    status: "succeeded",
    subjectId: id,
    detail: `${entries.length} files; ${totalBytes} bytes`,
  });
  return manifest;
}

export async function createOwnerBackup(
  owner: string,
  now: Date = new Date(),
): Promise<BackupManifest> {
  return withFileLock(`owner-backup:${ownerTenant(owner)}`, () =>
    createOwnerBackupUnlocked(owner, now));
}

export async function getBackupManifest(owner: string, id: string): Promise<BackupManifest | null> {
  try {
    const manifest = JSON.parse(await getStorage().readFile(manifestPath(owner, id))) as BackupManifest;
    return manifest.version === 1 && ownerTenant(manifest.owner) === ownerTenant(owner)
      ? manifest
      : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function listBackupManifests(owner: string): Promise<BackupManifest[]> {
  const entries = await getStorage().listFiles(`backups/${ownerTenant(owner)}`);
  const manifests = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory && /^bak_/.test(entry.name))
      .map((entry) => getBackupManifest(owner, entry.name)),
  );
  return manifests
    .filter((manifest): manifest is BackupManifest => manifest !== null)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function isOwnerBackupDue(
  owner: string,
  now: Date = new Date(),
  intervalMs = 24 * 60 * 60 * 1_000,
): Promise<boolean> {
  const latest = (await listBackupManifests(owner))[0];
  return !latest || now.getTime() - new Date(latest.createdAt).getTime() >= intervalMs;
}

export async function verifyOwnerBackup(
  owner: string,
  id: string,
  now: Date = new Date(),
): Promise<BackupManifest> {
  const manifest = await getBackupManifest(owner, id);
  if (!manifest) throw new Error("Backup not found");
  const verificationRoot = `restore-verification/${ownerTenant(owner)}/${id}`;
  try {
    for (const file of manifest.files) {
      const data = await getStorage().readAsset(file.backupPath);
      if (data.byteLength !== file.size || await sha256(data) !== file.sha256) {
        throw new Error(`Checksum mismatch for ${file.path}`);
      }
      const relative = file.path.slice(`tenants/${manifest.tenant}/`.length);
      const restoredPath = `${verificationRoot}/${relative}`;
      await getStorage().writeAsset(restoredPath, data);
      const restored = await getStorage().readAsset(restoredPath);
      if (await sha256(restored) !== file.sha256) {
        throw new Error(`Restore verification failed for ${file.path}`);
      }
    }
    manifest.verifiedAt = now.toISOString();
    manifest.verificationStatus = "passed";
    delete manifest.verificationError;
    await recordOperationSafe(owner, {
      kind: "backup",
      operation: "verify-restore",
      status: "succeeded",
      subjectId: id,
      detail: `${manifest.files.length} files verified in an isolated prefix`,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    manifest.verifiedAt = now.toISOString();
    manifest.verificationStatus = "failed";
    manifest.verificationError = message.slice(0, 1_000);
    await recordOperationSafe(owner, {
      kind: "backup",
      operation: "verify-restore",
      status: "failed",
      subjectId: id,
      detail: message,
    });
  } finally {
    // This prefix is disposable by definition; production data is never the
    // verification target.
    await getStorage().deleteDirectory(verificationRoot).catch(() => undefined);
    await writeManifest(manifest);
  }
  return manifest;
}

/** Human-readable size used by API/UI without exposing raw backup contents. */
export function backupSizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** API-safe summary. The potentially large internal file manifest stays server-side. */
export function summarizeBackup(manifest: BackupManifest): BackupSummary {
  const { files, ...summary } = manifest;
  return { ...summary, fileCount: files.length };
}
