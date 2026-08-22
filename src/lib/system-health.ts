import { listBackupManifests, summarizeBackup, type BackupSummary } from "./backups";
import { effectiveStatus, listIngestJobs } from "./ingest-jobs";
import { listOutboxEvents } from "./integration-outbox";
import { listOperations, type OperationRecord } from "./operation-ledger";
import { listRetrievalEvalRuns, type RetrievalEvalRun } from "./retrieval-evals";
import { listSourceMonitors } from "./source-monitors";

export interface SystemHealthSnapshot {
  generatedAt: string;
  status: "healthy" | "attention";
  monitors: { total: number; active: number; paused: number; failed: number };
  integrations: { total: number; pending: number; delivered: number; failed: number };
  ingests: { recent: number; processing: number; failed: number };
  operations: {
    observed: number;
    failed: number;
    inputTokens: number;
    outputTokens: number;
    estimatedCostUsd: number | null;
    recent: OperationRecord[];
  };
  backup: { latest: BackupSummary | null; status: "verified" | "failed" | "unverified" | "missing" };
  evaluation: { latest: RetrievalEvalRun | null; privacyPass: boolean | null };
  queue: {
    visibility: "cloudflare-dashboard";
    note: string;
  };
  safeguards: string[];
}

export async function getSystemHealth(owner: string): Promise<SystemHealthSnapshot> {
  const [monitors, outbox, ingests, operations, backups, evaluations] = await Promise.all([
    listSourceMonitors(owner),
    listOutboxEvents(owner),
    listIngestJobs({ owner, limit: 100 }),
    listOperations(owner, 500),
    listBackupManifests(owner),
    listRetrievalEvalRuns(owner),
  ]);
  const ingestStatuses = ingests.map((job) => effectiveStatus(job).status);
  const latestBackup = backups[0] ?? null;
  const backupStatus = !latestBackup
    ? "missing" as const
    : latestBackup.verificationStatus === "passed"
      ? "verified" as const
      : latestBackup.verificationStatus === "failed"
        ? "failed" as const
        : "unverified" as const;
  const latestEvaluation = evaluations[0] ?? null;
  const recentFailureCutoff = Date.now() - 24 * 60 * 60 * 1_000;
  const failedOperations = operations.filter(
    (operation) => operation.status === "failed" && Date.parse(operation.createdAt) >= recentFailureCutoff,
  ).length;
  const estimatedCosts = operations
    .map((operation) => operation.estimatedCostUsd)
    .filter((cost): cost is number => typeof cost === "number" && Number.isFinite(cost));
  const monitorFailures = monitors.filter((monitor) => monitor.state === "error").length;
  const outboxFailures = outbox.filter((event) => event.status === "failed").length;
  const ingestFailures = ingestStatuses.filter((status) => status === "failed").length;
  const privacyPass = latestEvaluation ? latestEvaluation.privacyPassRate === 1 : null;
  const needsAttention = monitorFailures > 0
    || outboxFailures > 0
    || ingestFailures > 0
    || failedOperations > 0
    || backupStatus !== "verified"
    || privacyPass === false;

  return {
    generatedAt: new Date().toISOString(),
    status: needsAttention ? "attention" : "healthy",
    monitors: {
      total: monitors.length,
      active: monitors.filter((monitor) => monitor.state === "active").length,
      paused: monitors.filter((monitor) => monitor.state === "paused").length,
      failed: monitorFailures,
    },
    integrations: {
      total: outbox.length,
      pending: outbox.filter((event) => event.status === "pending" || event.status === "delivering").length,
      delivered: outbox.filter((event) => event.status === "delivered").length,
      failed: outboxFailures,
    },
    ingests: {
      recent: ingests.length,
      processing: ingestStatuses.filter((status) => status === "queued" || status === "processing").length,
      failed: ingestFailures,
    },
    operations: {
      observed: operations.length,
      failed: failedOperations,
      inputTokens: operations.reduce((sum, operation) => sum + (operation.inputTokens ?? 0), 0),
      outputTokens: operations.reduce((sum, operation) => sum + (operation.outputTokens ?? 0), 0),
      estimatedCostUsd: estimatedCosts.length
        ? estimatedCosts.reduce((sum, cost) => sum + cost, 0)
        : null,
      recent: operations.slice(0, 30),
    },
    backup: { latest: latestBackup ? summarizeBackup(latestBackup) : null, status: backupStatus },
    evaluation: { latest: latestEvaluation, privacyPass },
    queue: {
      visibility: "cloudflare-dashboard",
      note: "Queue depth and dead-letter messages remain in Cloudflare operational telemetry; the app reports durable task outcomes and retries.",
    },
    safeguards: [
      "Owner-scoped storage paths",
      "Review required before memory changes",
      "Idempotent integration delivery",
      "Isolated restore verification",
    ],
  };
}
