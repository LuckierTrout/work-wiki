import { withDurableLock } from "./lock";
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

/** Longest handle the trigger suffix will carry; see {@link withTriggeredBy}. */
const TRIGGER_HANDLE_MAX = 64;

/**
 * Stamp WHO ASKED for an automated operation onto its log detail line.
 *
 * ONE OWNER FOR THE SUFFIX FORMAT (DW-447). An automated edit is authored by
 * the automation — `"lint-fix"` for every lint auto-fix, an `AUTOMATION_ACTORS`
 * member `normalizeActor` folds into the agent — so the human who pressed the
 * button never becomes the revision `author`, a page `contributor` or a
 * trust-score input. The log detail line is where their handle lands instead:
 * `logBlock` emits it as free prose under the entry heading, and NO PART OF THE
 * CONTRIBUTOR CONTRACT reads it — `contributors.ts`, `normalizeActor` and
 * `pushRecentEvent` all work from the revision sidecar and page frontmatter,
 * never from `log.md`.
 *
 * NOT the same field as `SourceEntry.triggered_by`. That one is structured
 * ingest provenance stored in a page's `sources[]`, and `src/lib/trail.ts`
 * DOES feed it through `normalizeActor` (`normalizeActor(s.triggered_by ||
 * "system")`). This is prose in a log line and reaches no such reader. Do not
 * wire one to the other.
 *
 * Callers on both sides of the lint-fix split use this (`./lifecycle`'s
 * page-less fixes and `./lint-fix`'s ten `logDetails` closures), so the
 * parenthetical cannot drift into two spellings.
 *
 * SANITIZED HERE, because the single owner of the format has to be the single
 * owner of the escaping too. The handle is interpolated raw into markdown that
 * `wiki/log.md` stores and `src/app/wiki/log/page.tsx` renders publicly, and
 * `logBlock` only trims the OUTER ends of `details`. A handle carrying a
 * newline could therefore split one entry into two lines — forging a `## [`
 * heading, or slipping content past that page's LINE-BASED private-page
 * redaction, which drops whole lines that name a hidden slug or title. The
 * handle is not always a Clerk username: `YOPEDIA_SERVICE_PRINCIPAL` and
 * registered agent handles reach here too. So control characters collapse to a
 * single space and the result is capped.
 *
 * An absent, blank, or sanitizes-to-blank handle returns `details` UNCHANGED —
 * the stdio MCP transport resolves no principal, and its log lines must stay
 * byte-identical to what they were before a trigger could be recorded at all.
 */
export function withTriggeredBy(details: string, triggeredBy?: string): string {
  // Collapse every control character (newlines, tabs, NUL, the C1 range) to a
  // single space BEFORE trimming, so a handle that is nothing but control
  // characters ends up blank and takes the unchanged-`details` path.
  const handle = (triggeredBy ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ")
    .trim()
    .slice(0, TRIGGER_HANDLE_MAX)
    .trim();
  return handle ? `${details} (triggered by ${handle})` : details;
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

  await withDurableLock("log.md", async () => {
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
  await withDurableLock("log.md", async () => {
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
