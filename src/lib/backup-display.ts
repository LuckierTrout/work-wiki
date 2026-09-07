/**
 * Shared backup display copy for the browser and server operation ledger.
 * Keep this module dependency-free: importing server backup storage from a
 * client component pulls Node builtins into production browser compilation.
 */

/**
 * Why a backup stopped short of the whole tenant.
 * `file-size` skips an oversized object and keeps copying; it is weaker than
 * either ceiling that stops the copy (see BackupLimits in the server module).
 */
export type BackupTruncationReason = "file-count" | "total-bytes" | "file-size";

/**
 * One owner-facing sentence for operation details and health desk rows.
 * An absent or unknown reason still reports partial when the flag is present.
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
  if (backup.truncationReason === "file-size") {
    // This limit skips one object without stopping the copy.
    return "partial — skipped a file over the file-size limit";
  }
  return "partial — stopped at a safety limit";
}
