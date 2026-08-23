/**
 * Client-safe Source-delete copy and path helpers (Epic 2).
 *
 * Workbench imports this module. Cascade execution stays in `source-cascade.ts`,
 * which is server-only (storage and todo pipelines).
 */

export const SOURCE_DELETE_TITLE = "Delete this source?";
export const SOURCE_DELETE_BODY =
  "This removes the Source and pages that only cite it. Shared pages keep their other sources.";
export const SOURCE_DELETE_CONFIRM = "Delete source";
export const SOURCE_DELETE_CANCEL = "Cancel";
export const SOURCE_ROUTE = "/api/workbench/source";

export const FILES_ROUTE = "/api/workbench/files";

const RAW_SOURCES_PREFIX = "raw/sources/";

export function sourceRestFromPath(path: string): string | null {
  const normalized = path.trim().replace(/\\/g, "/");
  const idx = normalized.indexOf(RAW_SOURCES_PREFIX);
  if (idx < 0) return null;
  const rest = normalized.slice(idx + RAW_SOURCES_PREFIX.length);
  if (
    !rest ||
    rest.includes("\0") ||
    rest.split("/").some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return null;
  }
  return rest;
}

/** Workbench identity: always `raw/sources/<rest>`, never a filesystem path. */
export function workbenchSourcePath(path: string): string | null {
  const rest = sourceRestFromPath(path);
  return rest ? `${RAW_SOURCES_PREFIX}${rest}` : null;
}

/** Exact cascade identity keys — path, rest, and the stored raw address. */
export function sourceIdentityKeys(path: string): string[] {
  const rest = sourceRestFromPath(path);
  if (!rest) return [];
  return [...new Set([path, rest, `raw/sources/${rest}`])];
}
