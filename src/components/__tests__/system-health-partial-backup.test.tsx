import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { SystemHealthDesk } from "@/components/SystemHealthDesk";
import { backupTruncationCopy, type BackupSummary } from "@/lib/backups";
import type { SystemHealthSnapshot } from "@/lib/system-health";

/**
 * The partial-backup marker on the System desk, MOUNTED (DW-215).
 *
 * `createOwnerBackup` used to THROW at `MAX_BACKUP_FILES` / `MAX_BACKUP_BYTES`;
 * it now stops there and flags the manifest instead. That flag is the operator's
 * only remaining signal, and a truncated backup verifies exactly like a complete
 * one — it checks the entries its manifest holds — so without a marker this row
 * reads as a clean, verified, whole-tenant snapshot while the recovery path
 * silently covers less than the tenant.
 *
 * Asserted on the outermost surface: what the row actually says on screen.
 */

const CREATED_AT = "2026-08-20T12:00:00.000Z";

function backup(truncated?: BackupSummary["truncated"]): BackupSummary {
  return {
    version: 1,
    id: "bak_2026-08-20T12-00-00-000Z-abcdefgh",
    owner: "yuanhao",
    tenant: "yopedia",
    createdAt: CREATED_AT,
    totalBytes: 2048,
    fileCount: 12,
    verifiedAt: CREATED_AT,
    verificationStatus: "passed",
    ...(truncated === undefined ? {} : { truncated }),
  };
}

/**
 * The health snapshot the desk's summary cards read.
 *
 * `backup.status` is "verified" even here: verification and COVERAGE are
 * different questions, and a truncated backup passes verification — which is
 * precisely why the cards cannot key off `status` alone.
 */
function health(summary: BackupSummary): SystemHealthSnapshot {
  return {
    generatedAt: CREATED_AT,
    status: summary.truncated?.length ? "attention" : "healthy",
    monitors: { total: 0, active: 0, paused: 0, failed: 0 },
    integrations: { total: 0, pending: 0, delivered: 0, failed: 0 },
    ingests: { recent: 0, processing: 0, failed: 0 },
    operations: {
      observed: 0,
      failed: 0,
      inputTokens: 0,
      outputTokens: 0,
      estimatedCostUsd: null,
      recent: [],
    },
    backup: { latest: summary, status: "verified" },
    evaluation: { latest: null, privacyPass: null },
    queue: { visibility: "cloudflare-dashboard", note: "" },
    safeguards: [],
  };
}

/** Answer every endpoint the desk loads on mount, with one backup in the list. */
function stubFetch(summary: BackupSummary, created?: BackupSummary) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: unknown) => {
      const href = String(url);
      const method = (init as { method?: string } | undefined)?.method ?? "GET";
      const body = href.startsWith("/api/system/backups")
        ? method === "POST"
          ? { backup: created ?? summary }
          : { backups: [summary] }
        : href.startsWith("/api/system/health")
          ? { health: health(summary) }
          : { cases: [], runs: [] };
      return { ok: true, status: 200, json: async () => body } as unknown as Response;
    }),
  );
}

describe("System desk — a truncated backup", () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("marks the row partial and names the limit that stopped it", async () => {
    stubFetch(backup(["file-count"]));
    render(<SystemHealthDesk />);

    const row = await screen.findByText(/12 files/);
    // Human words, not the manifest's storage discriminants — "file-count" on a
    // page is a leaked internal.
    expect(row.textContent).toContain("partial — stopped at the file count limit");
    expect(row.textContent).not.toContain("file-count");
    // Still a verified backup — "partial" describes coverage, not verification.
    expect(screen.getByText("passed")).toBeTruthy();
  });

  it("names BOTH limits when one run reached each of them", async () => {
    stubFetch(backup(["file-count", "total-bytes"]));

    render(<SystemHealthDesk />);

    const row = await screen.findByText(/12 files/);
    // Both named, and the noun pluralised with them.
    expect(row.textContent).toContain(
      "partial — stopped at the file count and total size limits",
    );
    expect(row.textContent).not.toContain("total-bytes");
  });

  it("turns the restore-check card red and says why, though verification passed", async () => {
    stubFetch(backup(["total-bytes"]));
    render(<SystemHealthDesk />);

    // The card keys off `backup.status`, which stays "verified" — so without
    // folding truncation in it reads green while the page banner overhead says
    // ATTENTION NEEDED.
    const value = await screen.findByText("verified");
    expect(value.getAttribute("style")).toContain("var(--rust)");
    const card = value.parentElement;
    expect(card?.textContent).toContain("partial — stopped at the total size limit");
  });

  it("does not call a truncated backup a clean success in the create receipt", async () => {
    stubFetch(backup(), backup(["file-count"]));
    render(<SystemHealthDesk />);

    fireEvent.click(await screen.findByText("Create + verify"));

    // The verification DID pass, so the "passed" branch alone would report a
    // partial snapshot as a whole one at the moment the owner reads the receipt.
    const notice = await screen.findByText(/covered only part of your data/);
    expect(notice.textContent).toContain("partial — stopped at the file count limit");
    expect(notice.textContent).not.toContain("restored successfully");
  });

  it("says nothing at all when the backup covered the whole tenant", async () => {
    stubFetch(backup());

    render(<SystemHealthDesk />);

    const row = await screen.findByText(/12 files/);
    await waitFor(() => expect(row.textContent).toContain("2.0 KB"));
    expect(row.textContent).not.toContain("partial");
    // Empty in → empty out, which is what lets the card render it unguarded.
    expect(backupTruncationCopy(undefined)).toBe("");
    expect(backupTruncationCopy([])).toBe("");
  });
});
