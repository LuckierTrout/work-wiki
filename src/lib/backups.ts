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

/** Why a backup stopped short of the whole tenant. */
export type BackupTruncationReason = "file-count" | "total-bytes";

export interface BackupManifest {
  version: 1;
  id: string;
  owner: string;
  tenant: string;
  createdAt: string;
  files: BackupFileEntry[];
  totalBytes: number;
  /**
   * Present, and always `true`, only when a limit stopped the copy (DW-215).
   * ABSENT on a whole backup — so a manifest written before this field existed
   * and a manifest of a complete tenant are the same shape, and every reader
   * that treats "no flag" as "complete" stays correct.
   */
  truncated?: true;
  /** Which limit stopped it. Only ever set beside `truncated`. */
  truncationReason?: BackupTruncationReason;
  verifiedAt?: string;
  verificationStatus?: "passed" | "failed";
  verificationError?: string;
}

export type BackupSummary = Omit<BackupManifest, "files"> & { fileCount: number };

/**
 * The ceilings a backup copies within.
 *
 * Injectable for the same reason `isOwnerBackupDue`'s `intervalMs` is: both
 * truncation paths must be reachable from a test that writes four small files
 * rather than 10k files or 2 GB. Production never passes them.
 */
export interface BackupLimits {
  maxFiles: number;
  maxBytes: number;
}

const MAX_BACKUP_FILES = 10_000;
const MAX_BACKUP_BYTES = 2 * 1024 * 1024 * 1024;

export const DEFAULT_BACKUP_LIMITS: BackupLimits = {
  maxFiles: MAX_BACKUP_FILES,
  maxBytes: MAX_BACKUP_BYTES,
};

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

/**
 * Every file under `prefix`, stopping at `maxFiles` (DW-215).
 *
 * It used to THROW there, which made one oversized silo — an artifact history
 * that grew past the cap, say — take the owner's whole backup down with it: no
 * manifest, no ledger line, nothing recovered. A partial backup is strictly
 * better than none, so the walk now stops and SAYS it stopped, and the caller
 * carries that fact into the manifest.
 */
async function walkFiles(
  prefix: string,
  maxFiles: number,
): Promise<{ files: string[]; truncated: boolean }> {
  const files: string[] = [];
  let truncated = false;

  const visit = async (dir: string): Promise<void> => {
    const entries = await getStorage().listFiles(dir);
    for (const entry of entries) {
      if (truncated) return;
      const child = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await visit(child);
        continue;
      }
      if (files.length >= maxFiles) {
        truncated = true;
        return;
      }
      files.push(child);
    }
  };

  await visit(prefix);
  return { files, truncated };
}

async function writeManifest(manifest: BackupManifest): Promise<void> {
  await getStorage().writeFile(
    manifestPath(manifest.owner, manifest.id),
    JSON.stringify(manifest, null, 2),
  );
}

/**
 * Copy the owner's tenant into a fresh backup prefix, TRUNCATING at the limits
 * rather than failing there (DW-215).
 *
 * A truncated backup is a real backup: it writes its manifest, records its
 * succeeded ledger line, and verifies — `verifyOwnerBackup` walks
 * `manifest.files`, which is exactly the set that was copied. What it does not
 * do is pretend to be whole; `truncated` / `truncationReason` are how every
 * reader downstream, including the owner's own health desk, learns otherwise.
 */
async function createOwnerBackupUnlocked(
  owner: string,
  now: Date = new Date(),
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): Promise<BackupManifest> {
  const tenant = ownerTenant(owner);
  const id = `bak_${now.toISOString().replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
  const sourceRoot = `tenants/${tenant}`;
  const root = backupRoot(owner, id);
  const walked = await walkFiles(sourceRoot, limits.maxFiles);
  const entries: BackupFileEntry[] = [];
  let totalBytes = 0;
  let truncationReason: BackupTruncationReason | null = walked.truncated
    ? "file-count"
    : null;

  for (const sourcePath of walked.files) {
    // Ask the size before pulling the bytes (DW-542). `stat` is one HEAD on R2,
    // one statx on disk; `readAsset` is the whole object. The trade is one
    // extra stat on every file against at most one avoided read — worth taking
    // only because the read it avoids is, by definition, of a file big enough
    // to break the ceiling.
    //
    // Two things this gate is NOT. It is not symmetric: an UNDER-reporting stat
    // is caught below, but an OVER-reporting one records a tenant that would
    // have fit as `truncated` — wrong in the conservative, visible direction.
    // And it is not the only not-found detector: a file can still vanish in the
    // window this opens between the stat and the read.
    const { size } = await getStorage().stat(sourcePath);
    if (totalBytes + size > limits.maxBytes) {
      // The byte ceiling stops the copy EARLIER in the same list than the file
      // ceiling did, so it is the truer answer to "what stopped this backup".
      truncationReason = "total-bytes";
      break;
    }
    const data = await getStorage().readAsset(sourcePath);
    // The check above is the optimisation; this one owns the invariant. `stat`
    // gates and never accounts — `totalBytes`, the entry's `size` and its
    // `sha256` all come from these bytes — so re-testing the ceiling here is
    // what keeps `totalBytes <= maxBytes` true when stat under-reports. When
    // the two agree, which is always on a healthy provider, this never fires.
    if (totalBytes + data.byteLength > limits.maxBytes) {
      truncationReason = "total-bytes";
      break;
    }
    totalBytes += data.byteLength;
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
    ...(truncationReason !== null && {
      truncated: true as const,
      truncationReason,
    }),
  };
  const partial = backupTruncationLabel(manifest);
  await writeManifest(manifest);
  await recordOperationSafe(owner, {
    kind: "backup",
    operation: "create",
    status: "succeeded",
    subjectId: id,
    detail: `${entries.length} files; ${totalBytes} bytes${
      partial === null ? "" : `; ${partial}`
    }`,
  });
  return manifest;
}

export async function createOwnerBackup(
  owner: string,
  now: Date = new Date(),
  limits: BackupLimits = DEFAULT_BACKUP_LIMITS,
): Promise<BackupManifest> {
  return withFileLock(`owner-backup:${ownerTenant(owner)}`, () =>
    createOwnerBackupUnlocked(owner, now, limits));
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

/**
 * The owner-facing sentence for a backup that stopped at a limit, or null when
 * the backup is whole (DW-215).
 *
 * ONE source for this copy, beside {@link backupSizeLabel}, because three
 * surfaces name the same condition — the manifest field, the operation ledger's
 * detail, and the health desk's row — and they drifted the moment each spelled
 * it for itself. An unrecognised or absent reason still reports PARTIAL: a
 * backup that says it is truncated is truncated whether or not this build knows
 * the word for why, and silently calling it whole would be the one wrong
 * answer.
 */
export function backupTruncationLabel(backup: {
  truncated?: true;
  truncationReason?: BackupTruncationReason;
}): string | null {
  if (!backup.truncated) return null;
  if (backup.truncationReason === "file-count") {
    return "partial — stopped at the file-count limit";
  }
  if (backup.truncationReason === "total-bytes") {
    return "partial — stopped at the total-bytes limit";
  }
  return "partial — stopped at a safety limit";
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
