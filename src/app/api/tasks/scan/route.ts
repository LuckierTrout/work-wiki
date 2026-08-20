import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import {
  scanForMaintenance,
  rebuildDerivedIndexes,
  purgeStaleJobs,
  sweepOrphanWikiDirs,
  backfillWorkspaceProfiles,
  DEFAULT_MAINTENANCE_CAP,
} from "@/lib/maintenance";
import { enqueueTask } from "@/lib/tasks";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { listDueScheduledAgents } from "@/lib/agent-runtime";
import { listDueSourceMonitors } from "@/lib/source-monitors";
import {
  createMonitorDigest,
  listDueMonitorDigestOwners,
  listPendingMonitorDigestDeliveries,
  markMonitorDigestQueued,
} from "@/lib/monitor-digests";
import { listDueOutboxEvents } from "@/lib/integration-outbox";
import { isOwnerBackupDue } from "@/lib/backups";

/**
 * POST /api/tasks/scan — the autonomous-maintenance producer (Q2).
 *
 * Service-token only (the sole caller is the task-consumer worker's cron). Scans
 * the wiki for maintenance work and enqueues `maintain` tasks.
 *
 * `AUTONOMOUS_MAINTENANCE` GATES PAGE AUTO-EDITS, NOT THE WHOLE RUN. Anything
 * other than `"on"` means **dry-run** for the `maintain` queue — the scan still
 * runs and logs/returns what it WOULD enqueue, but enqueues nothing — and that
 * is all `dry: true` in the response means. It does NOT mean the request
 * changed nothing: the index rebuild, the ingest-job GC, the orphan
 * wiki-directory sweep and the Workspace Purpose backfill are self-healing
 * upkeep and one-time migration rather than unattended content edits, so they
 * run regardless, as do the scheduled-agent, source-monitor, digest, outbox and
 * backup blocks.
 *
 * `?dry=1` IS THE ONE TRUE INSPECTION SWITCH: it suppresses every one of those
 * side-effecting blocks as well as the enqueue, which is what makes it safe to
 * point at a live deployment to see what a scan would do. `?cap=N` overrides the
 * per-scan task cap.
 *
 * Response fields worth naming: `jobsPurged` (terminal ingest-job status files
 * deleted), `orphanWikiDirsRemoved` (`tenants/<t>/wikis/<uuid>/` directories
 * no registry entry named, reclaimed for good — this route is that sweep's only
 * scheduled trigger) and `workspaceProfilesBackfilled` (Wikis handed a copy of
 * the retired tenant-global Workspace Purpose before it is deleted, DW-137 —
 * this route is that migration's only trigger of any kind, and the count is 0
 * on every scan of a tenant that has nothing left to relocate).
 */
export async function POST(req: Request) {
  const principal = getServicePrincipal(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const url = new URL(req.url);
    const enabled = process.env.AUTONOMOUS_MAINTENANCE === "on";
    const forceDry = url.searchParams.get("dry") === "1";
    // Off (default) → always dry-run; never auto-edits until explicitly enabled.
    const dry = forceDry || !enabled;

    const capParam = Number(url.searchParams.get("cap"));
    const cap =
      Number.isFinite(capParam) && capParam > 0
        ? Math.floor(capParam)
        : DEFAULT_MAINTENANCE_CAP;

    const tasks = await scanForMaintenance(cap);

    // Self-heal the precomputed KV indexes (Phase 2) once per scan run. This is
    // read-derived and idempotent — it never edits pages or enqueues tasks — so
    // it runs even in dry-run mode. Fully fail-soft (each rebuild is isolated).
    const indexRebuild = await rebuildDerivedIndexes();

    // Purge stale ingest-job status files (fail-soft, like the index rebuild).
    const jobsPurged = await purgeStaleJobs();

    let enqueued = 0;
    if (!dry) {
      for (const t of tasks) {
        if (await enqueueTask(t)) enqueued++;
      }
    }

    const dueAgents = (await listDueScheduledAgents()).slice(0, 25);
    let scheduledAgentsEnqueued = 0;
    if (!forceDry) {
      for (const agent of dueAgents) {
        if (!agent.owner || (agent.trigger !== "daily" && agent.trigger !== "weekly")) continue;
        if (await enqueueTask({
          kind: "run-agent",
          agentId: agent.id,
          owner: agent.owner,
          trigger: agent.trigger,
        })) {
          scheduledAgentsEnqueued += 1;
        }
      }
    }

    const dueMonitors = await listDueSourceMonitors(new Date(), 25);
    let sourceMonitorsEnqueued = 0;
    if (!forceDry) {
      for (const monitor of dueMonitors) {
        if (await enqueueTask({
          kind: "monitor-source",
          monitorId: monitor.id,
          owner: monitor.owner,
        })) {
          sourceMonitorsEnqueued += 1;
        }
      }
    }

    const digestNow = new Date();
    const dueDigestOwners = await listDueMonitorDigestOwners(digestNow, 25);
    let monitorDigestsGenerated = 0;
    if (!forceDry) {
      for (const owner of dueDigestOwners) {
        if (await createMonitorDigest(owner, { now: digestNow })) {
          monitorDigestsGenerated += 1;
        }
      }
    }

    const pendingDigests = await listPendingMonitorDigestDeliveries(digestNow, 50);
    let monitorDigestDeliveriesEnqueued = 0;
    if (!forceDry) {
      for (const digest of pendingDigests) {
        if (await enqueueTask({
          kind: "deliver-monitor-digest",
          digestId: digest.id,
          owner: digest.owner,
        })) {
          await markMonitorDigestQueued(digest.owner, digest.id, digestNow);
          monitorDigestDeliveriesEnqueued += 1;
        }
      }
    }

    const dueOutbox = await listDueOutboxEvents(new Date(), 50);
    let outboxDeliveriesEnqueued = 0;
    if (!forceDry) {
      for (const event of dueOutbox) {
        if (await enqueueTask({
          kind: "deliver-integration",
          outboxId: event.id,
          owner: event.owner,
        })) {
          outboxDeliveriesEnqueued += 1;
        }
      }
    }

    const backupOwner = process.env.NEXT_PUBLIC_OWNER_HANDLE?.trim();
    const backupDue = backupOwner ? await isOwnerBackupDue(backupOwner) : false;
    let backupEnqueued = false;
    if (!forceDry && backupOwner && backupDue) {
      backupEnqueued = await enqueueTask({ kind: "create-backup", owner: backupOwner });
    }

    // Reclaim `wikis/<uuid>/` directories no registry entry names. Byte
    // removal, so it is gated like the scheduled-agent/monitor/backup blocks
    // above — skipped only under `?dry=1` inspection, and NOT held back by
    // `AUTONOMOUS_MAINTENANCE`, which gates auto-EDITS of pages rather than GC.
    // This is the only scheduled trigger the sweep has: `deleteWiki` is its
    // other caller, and a tenant that never deletes never reclaims anything.
    let orphanWikiDirsRemoved = 0;
    if (!forceDry) {
      orphanWikiDirsRemoved = await sweepOrphanWikiDirs();
    }

    // Relocate the retired tenant-global Workspace Purpose onto the Wikis that
    // have none of their own, then delete it (DW-137). Gated exactly like the
    // sweep above and for the same reasons: it writes bytes, so `?dry=1`
    // suppresses it, while `AUTONOMOUS_MAINTENANCE` — which gates unattended
    // EDITS of page content — does not. This scan is the migration's only
    // trigger, so a deployment that never scans never finishes migrating.
    let workspaceProfilesBackfilled = 0;
    if (!forceDry) {
      workspaceProfilesBackfilled = await backfillWorkspaceProfiles();
    }

    logger.info(
      "maintenance",
      `scan: enabled=${enabled} dry=${dry} found=${tasks.length} enqueued=${enqueued} jobsPurged=${jobsPurged} orphanWikiDirsRemoved=${orphanWikiDirsRemoved} workspaceProfilesBackfilled=${workspaceProfilesBackfilled}`,
    );

    return NextResponse.json({
      enabled,
      dry,
      found: tasks.length,
      enqueued,
      indexRebuild,
      jobsPurged,
      scheduledAgentsDue: dueAgents.length,
      scheduledAgentsEnqueued,
      sourceMonitorsDue: dueMonitors.length,
      sourceMonitorsEnqueued,
      monitorDigestOwnersDue: dueDigestOwners.length,
      monitorDigestsGenerated,
      monitorDigestDeliveriesDue: pendingDigests.length,
      monitorDigestDeliveriesEnqueued,
      outboxDue: dueOutbox.length,
      outboxDeliveriesEnqueued,
      backupOwnerConfigured: Boolean(backupOwner),
      backupDue,
      backupEnqueued,
      orphanWikiDirsRemoved,
      workspaceProfilesBackfilled,
      // The candidate list — for dry-run inspection of what it would do.
      tasks: tasks.map((t) =>
        t.kind === "maintain"
          ? {
              op: t.op,
              slug: t.slug,
              ...(t.lintType !== undefined ? { lintType: t.lintType } : {}),
              ...(t.targetSlug !== undefined ? { targetSlug: t.targetSlug } : {}),
            }
          : t,
      ),
    });
  } catch (err) {
    logger.error("maintenance", "scan failed", err);
    return NextResponse.json({ error: getErrorMessage(err) }, { status: 500 });
  }
}
