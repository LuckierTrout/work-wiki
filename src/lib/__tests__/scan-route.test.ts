import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getServicePrincipal: vi.fn() }));
vi.mock("@/lib/maintenance", () => ({
  scanForMaintenance: vi.fn(),
  rebuildDerivedIndexes: vi.fn(),
  purgeStaleJobs: vi.fn(),
  DEFAULT_MAINTENANCE_CAP: 10,
}));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn() }));
vi.mock("@/lib/backups", () => ({ isOwnerBackupDue: vi.fn() }));
vi.mock("@/lib/monitor-digests", () => ({
  createMonitorDigest: vi.fn(),
  listDueMonitorDigestOwners: vi.fn(),
  listPendingMonitorDigestDeliveries: vi.fn(),
  markMonitorDigestQueued: vi.fn(),
}));

import { getServicePrincipal } from "@/lib/auth";
import { scanForMaintenance, rebuildDerivedIndexes, purgeStaleJobs } from "@/lib/maintenance";
import { enqueueTask } from "@/lib/tasks";
import { isOwnerBackupDue } from "@/lib/backups";
import {
  createMonitorDigest,
  listDueMonitorDigestOwners,
  listPendingMonitorDigestDeliveries,
  markMonitorDigestQueued,
} from "@/lib/monitor-digests";

const mockedGetService = vi.mocked(getServicePrincipal);
const mockedScan = vi.mocked(scanForMaintenance);
const mockedRebuild = vi.mocked(rebuildDerivedIndexes);
const mockedPurge = vi.mocked(purgeStaleJobs);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedBackupDue = vi.mocked(isOwnerBackupDue);
const mockedCreateDigest = vi.mocked(createMonitorDigest);
const mockedDueDigestOwners = vi.mocked(listDueMonitorDigestOwners);
const mockedPendingDigests = vi.mocked(listPendingMonitorDigestDeliveries);
const mockedMarkDigestQueued = vi.mocked(markMonitorDigestQueued);

const SAMPLE = [
  { kind: "maintain" as const, op: "staleness" as const, slug: "stale" },
  { kind: "maintain" as const, op: "reconcile" as const, slug: "disp", threadIndex: 0 },
  { kind: "maintain" as const, op: "fix" as const, slug: "page-a", lintType: "broken-link" as const, targetSlug: "dead-link" },
  { kind: "maintain" as const, op: "fix" as const, slug: "page-b", lintType: "orphan-page" as const },
];

async function scan(query = "") {
  const { POST } = await import("@/app/api/tasks/scan/route");
  return POST(
    new Request(`http://localhost/api/tasks/scan${query}`, { method: "POST" }),
  );
}

let savedFlag: string | undefined;
let savedOwnerHandle: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedFlag = process.env.AUTONOMOUS_MAINTENANCE;
  savedOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  delete process.env.AUTONOMOUS_MAINTENANCE;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  mockedGetService.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
  mockedScan.mockResolvedValue(SAMPLE);
  mockedRebuild.mockResolvedValue({});
  mockedPurge.mockResolvedValue(0);
  mockedEnqueue.mockResolvedValue(true);
  mockedBackupDue.mockResolvedValue(false);
  mockedDueDigestOwners.mockResolvedValue([]);
  mockedPendingDigests.mockResolvedValue([]);
  mockedCreateDigest.mockResolvedValue(null);
  mockedMarkDigestQueued.mockResolvedValue(null);
});
afterEach(() => {
  if (savedFlag === undefined) delete process.env.AUTONOMOUS_MAINTENANCE;
  else process.env.AUTONOMOUS_MAINTENANCE = savedFlag;
  if (savedOwnerHandle === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = savedOwnerHandle;
});

describe("POST /api/tasks/scan", () => {
  it("401s without the service token", async () => {
    mockedGetService.mockReturnValue(null);
    expect((await scan()).status).toBe(401);
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it("dry-runs maintenance tasks when AUTONOMOUS_MAINTENANCE is off", async () => {
    const res = await scan();
    const body = await res.json();
    expect(body).toMatchObject({ enabled: false, dry: true, found: 4, enqueued: 0 });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    // Still reports what it WOULD enqueue.
    expect(body.tasks).toHaveLength(4);
  });

  it("enqueues when AUTONOMOUS_MAINTENANCE=on", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    const res = await scan();
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, dry: false, found: 4, enqueued: 4 });
    expect(mockedEnqueue).toHaveBeenCalledTimes(4);
  });

  it("?dry=1 forces a dry-run even when enabled", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    const res = await scan("?dry=1");
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, dry: true, enqueued: 0 });
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("queues a due owner backup independently of maintenance edits", async () => {
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "christianlee";
    mockedBackupDue.mockResolvedValue(true);

    const res = await scan();
    const body = await res.json();

    expect(mockedBackupDue).toHaveBeenCalledWith("christianlee");
    expect(mockedEnqueue).toHaveBeenCalledWith({
      kind: "create-backup",
      owner: "christianlee",
    });
    expect(body).toMatchObject({
      backupOwnerConfigured: true,
      backupDue: true,
      backupEnqueued: true,
    });
  });

  it("?dry=1 suppresses a due owner backup", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "christianlee";
    mockedBackupDue.mockResolvedValue(true);

    const res = await scan("?dry=1");
    const body = await res.json();

    expect(mockedBackupDue).toHaveBeenCalledWith("christianlee");
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(body).toMatchObject({
      backupOwnerConfigured: true,
      backupDue: true,
      backupEnqueued: false,
    });
  });

  it("honors a ?cap override", async () => {
    await scan("?cap=3");
    expect(mockedScan).toHaveBeenCalledWith(3);
  });

  it("creates due monitor digests and queues pending email delivery", async () => {
    mockedDueDigestOwners.mockResolvedValue(["alice"]);
    mockedCreateDigest.mockResolvedValue({ id: "mdg_1234567890abcdef" } as never);
    mockedPendingDigests.mockResolvedValue([{
      id: "mdg_1234567890abcdef",
      owner: "alice",
      status: "pending",
      nextAttemptAt: "2026-08-05T00:00:00.000Z",
    }]);
    const res = await scan();
    const body = await res.json();
    expect(body).toMatchObject({
      monitorDigestOwnersDue: 1,
      monitorDigestsGenerated: 1,
      monitorDigestDeliveriesDue: 1,
      monitorDigestDeliveriesEnqueued: 1,
    });
    expect(mockedEnqueue).toHaveBeenCalledWith({
      kind: "deliver-monitor-digest",
      digestId: "mdg_1234567890abcdef",
      owner: "alice",
    });
    expect(mockedMarkDigestQueued).toHaveBeenCalledWith(
      "alice",
      "mdg_1234567890abcdef",
      expect.any(Date),
    );
  });

  it("self-heals the derived indexes every run (even in dry-run)", async () => {
    mockedRebuild.mockResolvedValue({ "owner-slugs": { ok: true } });
    const res = await scan(); // dry (default)
    const body = await res.json();
    expect(mockedRebuild).toHaveBeenCalledTimes(1);
    expect(body.indexRebuild).toEqual({ "owner-slugs": { ok: true } });
  });

  it("includes lintType and targetSlug for fix tasks in dry-run response", async () => {
    const res = await scan();
    const body = await res.json();
    // broken-link fix includes both lintType and targetSlug
    expect(body.tasks[2]).toEqual({
      op: "fix",
      slug: "page-a",
      lintType: "broken-link",
      targetSlug: "dead-link",
    });
    // orphan-page fix includes lintType but omits targetSlug
    expect(body.tasks[3]).toEqual({
      op: "fix",
      slug: "page-b",
      lintType: "orphan-page",
    });
    // staleness op omits lintType and targetSlug
    expect(body.tasks[0]).toEqual({ op: "staleness", slug: "stale" });
    // reconcile op includes threadIndex but not lintType/targetSlug
    expect(body.tasks[1]).toEqual({ op: "reconcile", slug: "disp", threadIndex: 0 });
  });
});
