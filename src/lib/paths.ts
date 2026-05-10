/**
 * Pure path-resolution helpers. Extracted from config.ts to break
 * the circular dependency between config.ts and storage/index.ts.
 */

/** Base data directory: `DATA_DIR` env var or `process.cwd()`. */
export function getDataDir(): string {
  return process.env.DATA_DIR ?? process.cwd();
}

/** Wiki pages directory: `WIKI_DIR` env var or `<dataDir>/wiki`. */
export function getWikiDir(): string {
  return process.env.WIKI_DIR ?? `${getDataDir()}/wiki`;
}

/** Raw sources directory: `RAW_DIR` env var or `<dataDir>/raw`. */
export function getRawDir(): string {
  return process.env.RAW_DIR ?? `${getDataDir()}/raw`;
}
