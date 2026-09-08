import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { appendToLog, appendToLogOnce, readLog, withTriggeredBy } from "../wiki-log";
import type { LogOperation } from "../wiki-log";
import { ensureDirectories, getWikiDir } from "../wiki";
import { _resetLocks, _setDurableLocksForTests } from "../lock";
import { logger } from "../logger";
import { _resetStorage, getStorage } from "../storage";

// ---------------------------------------------------------------------------
// Temp directory setup
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "wiki-log-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  _setDurableLocksForTests(false);
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  _setDurableLocksForTests(false);
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// appendToLog — happy path
// ---------------------------------------------------------------------------

describe("appendToLog", () => {
  it("writes a log entry with correct date format", async () => {
    await appendToLog("ingest", "My Article");
    const content = await readLog();
    expect(content).not.toBeNull();
    // Check heading format: ## [YYYY-MM-DD] operation | title
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] ingest \| My Article\n/);
  });

  it("uses today's date", async () => {
    await appendToLog("query", "Some Query");
    const content = await readLog();
    const today = new Date().toISOString().slice(0, 10);
    expect(content).toContain(`[${today}]`);
  });

  it("writes all allowed operation types", async () => {
    const ops: LogOperation[] = [
      "ingest",
      "query",
      "lint",
      "save",
      "edit",
      "delete",
      "other",
    ];
    for (const op of ops) {
      await appendToLog(op, `Title for ${op}`);
    }
    const content = await readLog();
    for (const op of ops) {
      expect(content).toContain(`${op} | Title for ${op}`);
    }
  });

  it("trims the title", async () => {
    await appendToLog("ingest", "  padded title  ");
    const content = await readLog();
    expect(content).toContain("| padded title\n");
    expect(content).not.toContain("  padded title  ");
  });

  it("appends multiple entries sequentially", async () => {
    await appendToLog("ingest", "First");
    await appendToLog("query", "Second");
    await appendToLog("edit", "Third");
    const content = await readLog();
    const headings = content!.match(/^## \[.*$/gm);
    expect(headings).toHaveLength(3);
    expect(headings![0]).toContain("ingest | First");
    expect(headings![1]).toContain("query | Second");
    expect(headings![2]).toContain("edit | Third");
  });

  // -------------------------------------------------------------------------
  // appendToLog — with details
  // -------------------------------------------------------------------------

  it("includes details body below heading", async () => {
    await appendToLog("ingest", "Article", "Some extra context here");
    const content = await readLog();
    expect(content).toContain("Some extra context here");
    // Details should come after the heading
    const lines = content!.split("\n");
    const headingIdx = lines.findIndex((l) => l.startsWith("## ["));
    expect(headingIdx).toBeGreaterThanOrEqual(0);
    // After the heading there should be a blank line, then details
    expect(lines[headingIdx + 2]).toBe("Some extra context here");
  });

  it("trims details whitespace", async () => {
    await appendToLog("save", "Page", "  extra whitespace  ");
    const content = await readLog();
    expect(content).toContain("extra whitespace");
    expect(content).not.toContain("  extra whitespace  ");
  });

  it("omits details block when details is empty string", async () => {
    await appendToLog("lint", "Check", "");
    const content = await readLog();
    // Block is "heading\n\n" — no details line present
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] lint \| Check\n\n$/);
    // Verify there's no extra content beyond heading + blank line
    const headings = content!.match(/^## \[.*$/gm);
    expect(headings).toHaveLength(1);
  });

  it("omits details block when details is whitespace-only", async () => {
    await appendToLog("lint", "Check", "   ");
    const content = await readLog();
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] lint \| Check\n\n$/);
  });

  it("omits details block when details is undefined", async () => {
    await appendToLog("other", "Thing");
    const content = await readLog();
    expect(content).toMatch(/^## \[\d{4}-\d{2}-\d{2}\] other \| Thing\n\n$/);
  });

  // -------------------------------------------------------------------------
  // appendToLog — validation
  // -------------------------------------------------------------------------

  it("rejects invalid operation string", async () => {
    await expect(
      appendToLog("invalid" as LogOperation, "title"),
    ).rejects.toThrow(/Invalid log operation/);
  });

  it("rejects another invalid operation", async () => {
    await expect(
      appendToLog("create" as LogOperation, "title"),
    ).rejects.toThrow(/Invalid log operation/);
  });

  it("rejects empty title", async () => {
    await expect(appendToLog("ingest", "")).rejects.toThrow(
      /Invalid log title/,
    );
  });

  it("rejects whitespace-only title", async () => {
    await expect(appendToLog("ingest", "   ")).rejects.toThrow(
      /Invalid log title/,
    );
  });

  it("rejects non-string title (number)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      appendToLog("ingest", 42 as any),
    ).rejects.toThrow(/Invalid log title/);
  });

  it("rejects non-string title (null)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      appendToLog("query", null as any),
    ).rejects.toThrow(/Invalid log title/);
  });

  it("rejects non-string title (undefined)", async () => {
    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      appendToLog("query", undefined as any),
    ).rejects.toThrow(/Invalid log title/);
  });

  // -------------------------------------------------------------------------
  // appendToLog — concurrency
  // -------------------------------------------------------------------------

  it("handles concurrent appends — all entries appear", async () => {
    const count = 10;
    const promises = Array.from({ length: count }, (_, i) =>
      appendToLog("ingest", `Concurrent-${i}`),
    );
    await Promise.all(promises);
    const content = await readLog();
    const headings = content!.match(/^## \[.*$/gm);
    expect(headings).toHaveLength(count);
    for (let i = 0; i < count; i++) {
      expect(content).toContain(`Concurrent-${i}`);
    }
  });

  it("concurrent appends don't corrupt file", async () => {
    const promises = Array.from({ length: 5 }, (_, i) =>
      appendToLog("save", `Item ${i}`, `Details for item ${i}`),
    );
    await Promise.all(promises);
    const content = await readLog();
    // Each entry has a heading line
    const headings = content!.match(/^## \[.*$/gm);
    expect(headings).toHaveLength(5);
    // Each entry has its details
    for (let i = 0; i < 5; i++) {
      expect(content).toContain(`Details for item ${i}`);
    }
  });

  it("serializes append-once read and append across simulated Worker isolates", async () => {
    _setDurableLocksForTests(true);
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    let releaseRead!: () => void;
    let firstRead!: () => void;
    const paused = new Promise<void>((resolve) => { firstRead = resolve; });
    const release = new Promise<void>((resolve) => { releaseRead = resolve; });
    let logReads = 0;
    vi.spyOn(storage, "readFile").mockImplementation(async (rel) => {
      if (String(rel).endsWith("log.md")) {
        logReads += 1;
        if (logReads === 1) {
          firstRead();
          await release;
        }
      }
      return originalRead(rel);
    });

    const first = appendToLogOnce("other", "First isolate", undefined, "first-op");
    await paused;
    _resetLocks();
    const second = appendToLogOnce("other", "Second isolate", undefined, "second-op");
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(logReads).toBe(1);

    releaseRead();
    await Promise.all([first, second]);
    const content = await readLog();
    expect(content).toContain("First isolate");
    expect(content).toContain("Second isolate");
  });
});

// ---------------------------------------------------------------------------
// readLog
// ---------------------------------------------------------------------------

describe("readLog", () => {
  it("reads back what was written", async () => {
    await appendToLog("ingest", "Test Article", "Some details");
    const content = await readLog();
    expect(content).toContain("ingest | Test Article");
    expect(content).toContain("Some details");
  });

  it("returns null when log.md doesn't exist", async () => {
    // Fresh directory with no log.md written yet
    const result = await readLog();
    expect(result).toBeNull();
  });

  it("returns null on read errors (non-ENOENT)", async () => {
    // Make the wiki dir unreadable by replacing log.md with a directory
    // (reading a directory as a file triggers EISDIR, not ENOENT)
    const logPath = path.join(getWikiDir(), "log.md");
    await fs.mkdir(logPath, { recursive: true });

    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const result = await readLog();
    expect(result).toBeNull();
    // Should have logged a warning
    expect(warnSpy).toHaveBeenCalledWith(
      "wiki",
      expect.stringContaining("readLog"),
      expect.anything(),
    );
    warnSpy.mockRestore();
  });

  it("returns string content (not buffer)", async () => {
    await appendToLog("edit", "Page");
    const content = await readLog();
    expect(typeof content).toBe("string");
  });

  it("returns full content with multiple entries", async () => {
    await appendToLog("ingest", "A");
    await appendToLog("query", "B");
    const content = await readLog();
    expect(content).toContain("ingest | A");
    expect(content).toContain("query | B");
  });

  it("preserves entry ordering", async () => {
    await appendToLog("ingest", "First");
    await appendToLog("query", "Second");
    const content = await readLog();
    const firstIdx = content!.indexOf("First");
    const secondIdx = content!.indexOf("Second");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});

// ---------------------------------------------------------------------------
// withTriggeredBy — the single owner of the trigger suffix (DW-447)
// ---------------------------------------------------------------------------

/**
 * Every lint-fix door and both page-less lifecycle ops format their trigger
 * through this one function, so its contract is worth pinning directly rather
 * than only through the callers that happen to exercise it.
 *
 * Two halves. The FORMAT half: a real handle gets one parenthetical, and
 * anything that is not a handle leaves `details` byte-identical — the stdio MCP
 * transport resolves no principal, and its log lines must not shift. The SAFETY
 * half: the handle is interpolated raw into markdown that `wiki/log.md` stores
 * and `/wiki/log` renders publicly with LINE-BASED private-page redaction, and
 * a handle is not always a Clerk username (`YOPEDIA_SERVICE_PRINCIPAL` and
 * registered agent handles reach here too). A newline in one would split the
 * entry, which is both a forged-heading vector and a way past that redaction.
 */
describe("withTriggeredBy", () => {
  const DETAILS = "auto-fix: added orphan page to index";

  it("appends one parenthetical for a real handle", () => {
    expect(withTriggeredBy(DETAILS, "alice")).toBe(`${DETAILS} (triggered by alice)`);
  });

  it.each([
    ["an absent handle", undefined],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a tab and newline only", "\t\n"],
    // Sanitization must not be able to MANUFACTURE a handle out of nothing: a
    // string that reduces to blank takes the same path as an absent one.
    ["a NUL byte only", "\u0000"],
  ])("leaves the line byte-identical for %s", (_label, handle) => {
    expect(withTriggeredBy(DETAILS, handle)).toBe(DETAILS);
  });

  it("collapses control characters so a handle cannot split the log entry", () => {
    // The attack shape: `logBlock` trims only the OUTER ends of `details`, so an
    // embedded newline would end this entry and start a line the log page's
    // per-line redaction filter evaluates on its own — here a forged heading.
    const forged = withTriggeredBy(DETAILS, "alice\n\n## [2026-01-01] ingest | Forged");

    expect(forged).not.toContain("\n");
    expect(forged.split("\n")).toHaveLength(1);
    expect(forged).toBe(`${DETAILS} (triggered by alice ## [2026-01-01] ingest | Forged)`);
  });

  it.each([
    ["a carriage return", "alice\rbob"],
    ["a tab", "alice\tbob"],
    ["a NUL byte", "alice\u0000bob"],
    // U+0085 NEXT LINE is a C1 control that several renderers treat as a break.
    ["a C1 control", "alice\u0085bob"],
  ])("neutralizes %s", (_label, handle) => {
    const line = withTriggeredBy(DETAILS, handle);

    expect(line).toBe(`${DETAILS} (triggered by alice bob)`);
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
  });

  it("caps an overlong handle so one actor cannot flood the line", () => {
    const line = withTriggeredBy(DETAILS, "z".repeat(500));

    expect(line).toBe(`${DETAILS} (triggered by ${"z".repeat(64)})`);
  });

  it("does not leave a dangling space when the cap lands mid-gap", () => {
    // Slicing can end on whitespace; the trailing trim is what keeps the
    // parenthetical from reading "(triggered by alice )".
    const line = withTriggeredBy(DETAILS, `${"z".repeat(63)}   tail`);

    expect(line).toBe(`${DETAILS} (triggered by ${"z".repeat(63)})`);
  });
});
