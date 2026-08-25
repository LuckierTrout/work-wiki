import { withFileLock } from "./lock";
import { wikiRelPath, ensureDirectories } from "./wiki";
import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { logger } from "./logger";

// ---------------------------------------------------------------------------
// Append-only log
// ---------------------------------------------------------------------------

/** Allowed operation kinds for log entries. */
export type LogOperation =
  | "ingest"
  | "query"
  | "lint"
  | "save"
  | "edit"
  | "delete"
  | "other";

const ALLOWED_LOG_OPERATIONS: readonly LogOperation[] = [
  "ingest",
  "query",
  "lint",
  "save",
  "edit",
  "delete",
  "other",
];

function validateLogEntry(operation: LogOperation, title: string): void {
  if (!ALLOWED_LOG_OPERATIONS.includes(operation)) {
    throw new Error(
      `Invalid log operation: "${operation}" (must be one of ${ALLOWED_LOG_OPERATIONS.join(", ")})`,
    );
  }
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new Error("Invalid log title: must be a non-empty string");
  }
}

function logBlock(operation: LogOperation, title: string, details?: string, marker?: string): string {
  const date = new Date().toISOString().slice(0, 10);
  const heading = `## [${date}] ${operation} | ${title.trim()}`;
  let block = `${heading}\n\n`;
  if (details && details.trim().length > 0) block += `${details.trim()}\n\n`;
  if (marker) block += `${marker}\n\n`;
  return block;
}

/**
 * Append a structured entry to `wiki/log.md`, following the founding-spec format:
 *
 * ```
 * ## [2026-04-07] ingest | Article Title
 *
 * <optional details line>
 *
 * ```
 *
 * Each entry is a markdown H2 heading, making the log both human-readable
 * (renders as a list of section headings) and grep-friendly:
 * `grep "^## \[" wiki/log.md | tail -5` returns the last 5 entries.
 *
 * @throws {Error} when `operation` is not one of the allowed values.
 * @throws {Error} when `title` is empty (after trimming).
 */
export async function appendToLog(
  operation: LogOperation,
  title: string,
  details?: string,
): Promise<void> {
  validateLogEntry(operation, title);

  await withFileLock("log.md", async () => {
    await ensureDirectories();
    await getStorage().appendFile(wikiRelPath("log.md"), logBlock(operation, title, details));
  });
}

/** Append one lifecycle log entry at most once across crash recovery. */
export async function appendToLogOnce(
  operation: LogOperation,
  title: string,
  details: string | undefined,
  idempotencyKey: string,
): Promise<void> {
  validateLogEntry(operation, title);
  const marker = `<!-- lifecycle-op:${idempotencyKey.replace(/--/g, "-")} -->`;
  await withFileLock("log.md", async () => {
    await ensureDirectories();
    let existing = "";
    try {
      existing = await getStorage().readFile(wikiRelPath("log.md"));
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
    if (existing.includes(marker)) return;
    await getStorage().appendFile(
      wikiRelPath("log.md"),
      logBlock(operation, title, details, marker),
    );
  });
}

/** Read the contents of `wiki/log.md`. Returns `null` if the file doesn't exist. */
export async function readLog(): Promise<string | null> {
  try {
    return await getStorage().readFile(wikiRelPath("log.md"));
  } catch (err: unknown) {
    if (!isEnoent(err)) {
      logger.warn("wiki", "readLog failed to read log.md:", err);
    }
    return null;
  }
}
