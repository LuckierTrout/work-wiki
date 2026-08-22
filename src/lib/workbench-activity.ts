/**
 * Workbench Activity vocabulary — display mapping and copy (Stories 2.4–2.12).
 *
 * Pure and client-safe: the dock imports it in the browser and the node suite
 * pins the labels. Durable job records stay `queued | processing | done |
 * failed | skipped`; this module is how those become the Activity row words.
 */

export const ACTIVITY_TITLE = "Activity";
export const ACTIVITY_EMPTY_COPY = "No ingest jobs.";
export const ACTIVITY_CANCEL_LABEL = "Cancel";
export const ACTIVITY_RETRY_LABEL = "Retry";
export const ACTIVITY_CANCEL_TITLE = "Cancel this ingest?";
export const ACTIVITY_CANCEL_BODY =
  "No pages will be written for this job. An in-flight model call may still finish.";
export const ACTIVITY_CANCEL_CONFIRM = "Cancel ingest";
export const ACTIVITY_KEEP_RUNNING = "Keep running";
export const ACTIVITY_EMBED_TITLE = "Embed current pages";
export const ACTIVITY_ROUTE = "/api/workbench/activity";

export const WORKBENCH_ACTIVITY_OPEN_KEY = "yopedia_workbench_activity_open";

export type ActivityDisplayStatus =
  | "pending"
  | "Analysis"
  | "Generation"
  | "succeeded"
  | "skipped"
  | "failed";

export type ActivityJobKind = "ingest" | "embed";

export interface ActivityRow {
  jobId: string;
  title: string;
  displayStatus: ActivityDisplayStatus;
  error?: string;
  progressDone?: number;
  progressTotal?: number;
  canCancel: boolean;
  canRetry: boolean;
}

/**
 * Map a durable job status + stage onto the Activity row label.
 *
 * `effectiveStatus` (stale → failed) is applied by the server before this.
 */
export function activityDisplayStatus(
  status: "queued" | "processing" | "done" | "failed" | "skipped",
  stage?: string,
  kind?: ActivityJobKind,
  cancelled?: boolean,
): ActivityDisplayStatus {
  if (cancelled && status !== "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "done") return "succeeded";
  if (status === "failed") return "failed";
  if (status === "queued") return "pending";
  if (kind === "embed") return "Generation";
  if (
    stage === "generation" ||
    stage === "synthesizing" ||
    stage === "indexing" ||
    stage === "deriving-knowledge"
  ) {
    return "Generation";
  }
  return "Analysis";
}

export function activityQueueProgress(rows: readonly ActivityRow[]): {
  completed: number;
  total: number;
  activeStep: ActivityDisplayStatus | null;
} {
  const total = rows.length;
  const completed = rows.filter((row) =>
    row.displayStatus === "succeeded" ||
    row.displayStatus === "skipped" ||
    row.displayStatus === "failed",
  ).length;
  const active = rows.find(
    (row) =>
      row.displayStatus === "Analysis" || row.displayStatus === "Generation",
  );
  return { completed, total, activeStep: active?.displayStatus ?? null };
}

export function readStoredActivityOpen(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const raw = window.localStorage.getItem(WORKBENCH_ACTIVITY_OPEN_KEY);
    if (raw === "0") return false;
    return true;
  } catch {
    return true;
  }
}

export function writeStoredActivityOpen(open: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKBENCH_ACTIVITY_OPEN_KEY, open ? "1" : "0");
  } catch {
    // private mode / quota — this session still works
  }
}
