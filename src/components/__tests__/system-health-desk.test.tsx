import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, within } from "@testing-library/react";
import { SystemHealthDesk } from "@/components/SystemHealthDesk";
import type { BackupSummary } from "@/lib/backups";
import type { SystemHealthSnapshot } from "@/lib/system-health";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SystemHealthDesk backup completeness", () => {
  it("renders whole, limited, and legacy or future backup rows from the load responses", async () => {
    const reasons = [undefined, "file-count", "total-bytes", "file-size", undefined, "future-limit"];
    // The final response represents a reason written by a newer server. JSON
    // can carry it even though this client's type does not yet name it.
    const backups: BackupSummary[] = reasons.map((reason, index) => ({
      version: 1,
      id: `backup-${index}`,
      owner: "alice",
      tenant: "alice",
      createdAt: "2026-09-07T12:00:00.000Z",
      fileCount: index + 1,
      totalBytes: 100,
      verificationStatus: "passed",
      ...(index > 0 && {
        truncated: true as const,
        truncationReason: reason as BackupSummary["truncationReason"],
      }),
    }));
    const health: SystemHealthSnapshot = {
      generatedAt: "2026-09-07T12:00:00.000Z",
      status: "attention",
      monitors: { total: 0, active: 0, paused: 0, failed: 0 },
      integrations: { total: 0, pending: 0, delivered: 0, failed: 0 },
      ingests: { recent: 0, processing: 0, failed: 0 },
      operations: {
        observed: 0, failed: 0, inputTokens: 0, outputTokens: 0,
        estimatedCostUsd: null, recent: [],
      },
      backup: { latest: backups[0], status: "verified" },
      evaluation: { latest: null, privacyPass: null },
      queue: { visibility: "cloudflare-dashboard", note: "Check queue telemetry." },
      safeguards: [],
    };
    const responses: Record<string, unknown> = {
      "/api/system/health": { health },
      "/api/system/backups": { backups },
      "/api/system/evaluations": { cases: [], runs: [] },
    };
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") !== "GET" || !(url in responses)) {
        throw new Error(`Unexpected request: ${init?.method ?? "GET"} ${url}`);
      }
      return Response.json(responses[url]);
    });
    vi.stubGlobal("fetch", fetchMock);

    render(<SystemHealthDesk />);

    await screen.findByText("ATTENTION NEEDED");
    const rows = screen.getAllByRole("article");
    expect(rows).toHaveLength(6);
    const expectedLabels = [
      null,
      "partial — stopped at the file-count limit",
      "partial — stopped at the total-bytes limit",
      "partial — skipped a file over the file-size limit",
      "partial — stopped at a safety limit",
      "partial — stopped at a safety limit",
    ];
    for (const [index, row] of rows.entries()) {
      const label = expectedLabels[index];
      expect(within(row).getByText(
        `${index + 1} files · 100 B${label === null ? "" : ` · ${label}`}`,
      )).toBeTruthy();
      expect(within(row).getByText("passed")).toBeTruthy();
      expect(within(row).getByRole("button", { name: "Verify" })).toBeTruthy();
    }
    expect(rows[0].textContent).not.toContain("partial");
    expect(fetchMock.mock.calls.map(([url]) => url).sort()).toEqual(Object.keys(responses).sort());
  });
});
