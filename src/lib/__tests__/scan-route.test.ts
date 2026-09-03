import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getServicePrincipal: vi.fn() }));
vi.mock("@/lib/maintenance", () => ({
  scanForMaintenance: vi.fn(),
  rebuildDerivedIndexes: vi.fn(),
  purgeStaleJobs: vi.fn(),
  sweepOrphanWikiDirs: vi.fn(),
  reconcileWikiScenarios: vi.fn(),
  backfillWorkspaceProfiles: vi.fn(),
  reapStrandedScratchFiles: vi.fn(),
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
import {
  scanForMaintenance,
  rebuildDerivedIndexes,
  purgeStaleJobs,
  sweepOrphanWikiDirs,
  reconcileWikiScenarios,
  backfillWorkspaceProfiles,
  reapStrandedScratchFiles,
} from "@/lib/maintenance";
import { enqueueTask } from "@/lib/tasks";
import { isOwnerBackupDue } from "@/lib/backups";
import {
  createMonitorDigest,
  listDueMonitorDigestOwners,
  listPendingMonitorDigestDeliveries,
  markMonitorDigestQueued,
} from "@/lib/monitor-digests";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";

const mockedGetService = vi.mocked(getServicePrincipal);
const mockedScan = vi.mocked(scanForMaintenance);
const mockedRebuild = vi.mocked(rebuildDerivedIndexes);
const mockedPurge = vi.mocked(purgeStaleJobs);
const mockedSweepOrphanWikiDirs = vi.mocked(sweepOrphanWikiDirs);
const mockedReconcileWikiScenarios = vi.mocked(reconcileWikiScenarios);
const mockedBackfillProfiles = vi.mocked(backfillWorkspaceProfiles);
const mockedReapScratch = vi.mocked(reapStrandedScratchFiles);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedBackupDue = vi.mocked(isOwnerBackupDue);
const mockedCreateDigest = vi.mocked(createMonitorDigest);
const mockedDueDigestOwners = vi.mocked(listDueMonitorDigestOwners);
const mockedPendingDigests = vi.mocked(listPendingMonitorDigestDeliveries);
const mockedMarkDigestQueued = vi.mocked(markMonitorDigestQueued);

const SAMPLE = [
  { kind: "maintain" as const, op: "staleness" as const, slug: "stale" },
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
let savedReadOnly: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedFlag = process.env.AUTONOMOUS_MAINTENANCE;
  savedOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  savedReadOnly = process.env.YOPEDIA_READONLY;
  delete process.env.AUTONOMOUS_MAINTENANCE;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  // Cleared rather than inherited: a value exported in a developer's shell
  // would otherwise turn every case below into a 403.
  delete process.env.YOPEDIA_READONLY;
  mockedGetService.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
  mockedScan.mockResolvedValue(SAMPLE);
  mockedRebuild.mockResolvedValue({});
  mockedPurge.mockResolvedValue(0);
  mockedSweepOrphanWikiDirs.mockResolvedValue(0);
  mockedReconcileWikiScenarios.mockResolvedValue(0);
  mockedBackfillProfiles.mockResolvedValue(0);
  mockedReapScratch.mockResolvedValue(0);
  mockedEnqueue.mockResolvedValue(true);
  mockedBackupDue.mockResolvedValue(false);
  mockedDueDigestOwners.mockResolvedValue([]);
  mockedPendingDigests.mockResolvedValue([]);
  mockedCreateDigest.mockResolvedValue(null);
  mockedMarkDigestQueued.mockResolvedValue(null);
});
afterEach(() => {
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
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
    expect(body).toMatchObject({ enabled: false, dry: true, found: 3, enqueued: 0 });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    // Still reports what it WOULD enqueue.
    expect(body.tasks).toHaveLength(3);
  });

  it("enqueues when AUTONOMOUS_MAINTENANCE=on", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    const res = await scan();
    const body = await res.json();
    expect(body).toMatchObject({ enabled: true, dry: false, found: 3, enqueued: 3 });
    expect(mockedEnqueue).toHaveBeenCalledTimes(3);
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

  it.each([
    ["unset", undefined],
    ["empty", ""],
    ["blank", "   "],
  ])(
    "skips the backup check entirely when the owner handle is %s",
    async (_label, handle) => {
      // DW-157 — the owner is read through `getOwnerHandle()`, which treats an
      // unset, an empty AND a whitespace-only value as "no owner configured",
      // exactly as the inline `process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim()` it
      // replaced did. Enqueueing runs (AUTONOMOUS_MAINTENANCE=on), so "no
      // create-backup task" below is an assertion about the backup block, not
      // about a dry-run swallowing every enqueue.
      process.env.AUTONOMOUS_MAINTENANCE = "on";
      if (handle === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
      else process.env.NEXT_PUBLIC_OWNER_HANDLE = handle;
      mockedBackupDue.mockResolvedValue(true);

      const res = await scan();
      const body = await res.json();

      // POSITIVE CONTROL, and the reason the negative assertions below mean
      // anything: the maintenance tasks DID enqueue on this run. Without it,
      // a route that short-circuited before the backup block — or before any
      // enqueue at all — would satisfy every `not.toHaveBeenCalled` here and
      // the case would pass vacuously.
      expect(body).toMatchObject({ enabled: true, dry: false, enqueued: 3 });
      expect(mockedEnqueue).toHaveBeenCalledTimes(3);

      expect(mockedBackupDue).not.toHaveBeenCalled();
      expect(mockedEnqueue).not.toHaveBeenCalledWith(
        expect.objectContaining({ kind: "create-backup" }),
      );
      expect(body).toMatchObject({
        backupOwnerConfigured: false,
        backupDue: false,
        backupEnqueued: false,
      });
    },
  );

  it("trims the configured owner handle before using it as a storage key", async () => {
    // DW-157 — the case that actually distinguishes `getOwnerHandle()` from a
    // bare `process.env.NEXT_PUBLIC_OWNER_HANDLE` read. The handle is not a
    // label here: `isOwnerBackupDue` resolves it to a TENANT PATH SEGMENT, and
    // the enqueued task carries it to the backup worker, so an untrimmed
    // `"  christianlee  "` would address a different manifest than every other
    // owner-scoped read on the deployment.
    process.env.NEXT_PUBLIC_OWNER_HANDLE = "  christianlee  ";
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

  it("sweeps orphaned wiki directories on a normal scan and reports the count", async () => {
    // The sweep's ONLY scheduled trigger. It removes bytes nothing references
    // rather than editing pages, so — like the scheduled-agent, monitor and
    // backup blocks — it runs with AUTONOMOUS_MAINTENANCE off; a tenant that
    // never deletes a wiki would otherwise never reclaim a single directory.
    mockedSweepOrphanWikiDirs.mockResolvedValue(2);

    const res = await scan();
    const body = await res.json();

    expect(mockedSweepOrphanWikiDirs).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: false, dry: true, orphanWikiDirsRemoved: 2 });
  });

  it("sweeps orphaned wiki directories in the enabled production configuration", async () => {
    // The row the cron actually runs: AUTONOMOUS_MAINTENANCE=on, no ?dry. The
    // two cases either side of this one both hold the sweep's gate in its
    // non-production position, so without this nothing pins the configuration
    // the feature exists for.
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedSweepOrphanWikiDirs.mockResolvedValue(3);

    const res = await scan();
    const body = await res.json();

    expect(mockedSweepOrphanWikiDirs).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: true, dry: false, orphanWikiDirsRemoved: 3 });
  });

  it("?dry=1 suppresses the orphan-directory sweep", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedSweepOrphanWikiDirs.mockResolvedValue(2);

    const res = await scan("?dry=1");
    const body = await res.json();

    expect(mockedSweepOrphanWikiDirs).not.toHaveBeenCalled();
    expect(body.orphanWikiDirsRemoved).toBe(0);
  });

  it("reconciles wiki scenario drift on a normal scan and reports the count", async () => {
    // DW-676's repair, and this scan is its ONLY trigger of any kind: the
    // divergence is written by a re-template that reported failure, and nothing
    // on the request path revisits it. It rewrites `wikis.json` rather than
    // editing pages, so — like the sweep beside it — it runs with
    // AUTONOMOUS_MAINTENANCE off; otherwise a deployment on the default flag
    // would keep a switcher label its own artifacts contradict, forever.
    mockedReconcileWikiScenarios.mockResolvedValue(2);

    const res = await scan();
    const body = await res.json();

    expect(mockedReconcileWikiScenarios).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: false, dry: true, wikiScenariosReconciled: 2 });
  });

  it("reconciles wiki scenario drift in the enabled production configuration", async () => {
    // The row the cron actually runs: AUTONOMOUS_MAINTENANCE=on, no ?dry. The
    // two cases either side of this one both hold the reconciler's gate in its
    // non-production position, so without this nothing pins the configuration
    // the feature exists for.
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedReconcileWikiScenarios.mockResolvedValue(3);

    const res = await scan();
    const body = await res.json();

    expect(mockedReconcileWikiScenarios).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: true, dry: false, wikiScenariosReconciled: 3 });
  });

  it("?dry=1 suppresses the wiki scenario-drift reconcile", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedReconcileWikiScenarios.mockResolvedValue(2);

    const res = await scan("?dry=1");
    const body = await res.json();

    expect(mockedReconcileWikiScenarios).not.toHaveBeenCalled();
    expect(body.wikiScenariosReconciled).toBe(0);
  });

  it("backfills workspace profiles on a normal scan and reports the count", async () => {
    // The DW-137 migration's ONLY trigger of any kind. It writes bytes rather
    // than editing page content, so it runs with AUTONOMOUS_MAINTENANCE off
    // exactly like the orphan sweep — a deployment that leaves that flag at its
    // default would otherwise never finish migrating.
    mockedBackfillProfiles.mockResolvedValue(2);

    const res = await scan();
    const body = await res.json();

    expect(mockedBackfillProfiles).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      enabled: false,
      dry: true,
      workspaceProfilesBackfilled: 2,
    });
  });

  it("backfills workspace profiles in the enabled production configuration", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedBackfillProfiles.mockResolvedValue(3);

    const res = await scan();
    const body = await res.json();

    expect(mockedBackfillProfiles).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({
      enabled: true,
      dry: false,
      workspaceProfilesBackfilled: 3,
    });
  });

  it("?dry=1 suppresses the workspace-profile backfill", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedBackfillProfiles.mockResolvedValue(2);

    const res = await scan("?dry=1");
    const body = await res.json();

    expect(mockedBackfillProfiles).not.toHaveBeenCalled();
    expect(body.workspaceProfilesBackfilled).toBe(0);
  });

  it("reaps stranded scratch files with AUTONOMOUS_MAINTENANCE off and reports the count", async () => {
    // The reaper's ONLY trigger of any kind (DW-292). It removes bytes nothing
    // can reach — stranded `.tmp-<uuid>.tmp` files are hidden from `listFiles`
    // — rather than editing pages, so like the orphan sweep it runs with
    // `AUTONOMOUS_MAINTENANCE` at its default. A deployment that left that flag
    // alone would otherwise never reclaim a single one.
    mockedReapScratch.mockResolvedValue(4);

    const res = await scan();
    const body = await res.json();

    expect(mockedReapScratch).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: false, dry: true, scratchFilesReaped: 4 });
  });

  it("reaps stranded scratch files in the enabled production configuration", async () => {
    // The row the cron actually runs: AUTONOMOUS_MAINTENANCE=on, no ?dry.
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedReapScratch.mockResolvedValue(5);

    const res = await scan();
    const body = await res.json();

    expect(mockedReapScratch).toHaveBeenCalledTimes(1);
    expect(body).toMatchObject({ enabled: true, dry: false, scratchFilesReaped: 5 });
  });

  it("?dry=1 suppresses the scratch-file reap", async () => {
    process.env.AUTONOMOUS_MAINTENANCE = "on";
    mockedReapScratch.mockResolvedValue(4);

    const res = await scan("?dry=1");
    const body = await res.json();

    expect(mockedReapScratch).not.toHaveBeenCalled();
    expect(body.scratchFilesReaped).toBe(0);
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
    expect(body.tasks[1]).toEqual({
      op: "fix",
      slug: "page-a",
      lintType: "broken-link",
      targetSlug: "dead-link",
    });
    // orphan-page fix includes lintType but omits targetSlug
    expect(body.tasks[2]).toEqual({
      op: "fix",
      slug: "page-b",
      lintType: "orphan-page",
    });
    // staleness op omits lintType and targetSlug
    expect(body.tasks[0]).toEqual({ op: "staleness", slug: "stale" });
  });
});

/**
 * The scan on a read-only deployment (DW-314).
 *
 * This route wrote bytes ON A TIMER with no gate at all: the index rebuild and
 * the ingest-job GC run every pass, the orphan sweep DELETES `wikis/<uuid>/`
 * directories, and the DW-137 backfill relocates workspace profiles. None of
 * them reaches a kernel writer, so nothing behind the handler would have
 * refused — a cron against a read-only deployment simply kept working.
 */
describe("POST /api/tasks/scan on a read-only deployment", () => {
  beforeEach(() => {
    process.env.YOPEDIA_READONLY = "1";
  });

  it("403s without scanning, sweeping, reaping, backfilling or enqueuing", async () => {
    const res = await scan();

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_REFUSAL.maintenanceScan });
    expect(mockedScan).not.toHaveBeenCalled();
    expect(mockedRebuild).not.toHaveBeenCalled();
    expect(mockedPurge).not.toHaveBeenCalled();
    expect(mockedSweepOrphanWikiDirs).not.toHaveBeenCalled();
    expect(mockedReapScratch).not.toHaveBeenCalled();
    expect(mockedBackfillProfiles).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("refuses WHOLE — `?dry=1` does not buy an inspection 200", async () => {
    // The decision this case exists to pin. `dry` is documented as the one true
    // inspection switch and its 200 says "here is what a scan would do"; a
    // read-only deployment answering that shape would be reporting a scan that
    // never ran. So the refusal wins: `?dry=1` gets the same 403 and the same
    // sentence as a plain scan, and `scanForMaintenance` is never called.
    const res = await scan("?dry=1");

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_REFUSAL.maintenanceScan });
    expect(mockedScan).not.toHaveBeenCalled();
  });

  it("refuses with AUTONOMOUS_MAINTENANCE=on too", async () => {
    // The two flags are independent: `AUTONOMOUS_MAINTENANCE` gates page
    // auto-EDITS, and read-only gates every byte. Turning the first on must not
    // reach past the second.
    process.env.AUTONOMOUS_MAINTENANCE = "on";

    expect((await scan()).status).toBe(403);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("still 401s without the service token, so the gate stays behind auth", async () => {
    mockedGetService.mockReturnValue(null);

    const res = await scan();

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});
