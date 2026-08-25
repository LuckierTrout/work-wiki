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
  | "Extract"
  | "Analysis"
  | "Generation"
  | "succeeded"
  | "skipped"
  | "failed";

export type ActivityJobKind = "ingest" | "embed" | "extract";

/**
 * What Activity says when extract could not run because nothing was listening
 * on the sidecar's loopback port (Story 7.1).
 *
 * The row carries the kernel's own `error` verbatim, so this constant is what
 * the TEST compares against rather than something the dock interpolates — the
 * one place all three copies of this sentence (kernel, client door, dock test)
 * are checked for agreement.
 */
export const ACTIVITY_EXTRACT_UNAVAILABLE_COPY =
  "Extract is unavailable — the sidecar is down.";

/**
 * The reassurance beside a failed extract: nothing was thrown away.
 *
 * Duplicated deliberately from `./extract-jobs`, which is a SERVER module —
 * this one is imported by the dock in the browser. The pin in
 * `workbench-intake.test.ts` is what keeps the two spellings identical, the
 * same arrangement the sidecar-down sentence already lives under.
 */
export const ACTIVITY_EXTRACT_BYTES_KEPT_COPY = "The stored source was kept.";

/**
 * Retry found no extract record to re-offer.
 *
 * The bytes are still stored — nothing on that path deletes a Source — so the
 * sentence says what the owner can do instead rather than implying the file is
 * gone. It lives here rather than beside the route that answers it because a
 * Next route module may export only its handlers.
 */
export const EXTRACT_RETRY_UNAVAILABLE_COPY =
  "This document has no extract job to retry. Save it again to queue a fresh extract.";

export interface ActivityRow {
  jobId: string;
  title: string;
  displayStatus: ActivityDisplayStatus;
  wikiId?: string;
  error?: string;
  /**
   * A standing fact about the row, beside (never instead of) `error`.
   *
   * Only {@link ACTIVITY_EXTRACT_BYTES_KEPT_COPY} sets it today. It is a second
   * field rather than a suffix on `error` because the error text is the
   * extractor's own words, carried verbatim from the crate or from MinerU, and
   * a door that concatenated onto it would make every failure message a thing
   * this app had edited.
   */
  note?: string;
  progressDone?: number;
  progressTotal?: number;
  canCancel: boolean;
  canRetry: boolean;
}

/**
 * Map a durable job status + stage onto the Activity row label.
 *
 * `effectiveStatus` (stale → failed) is applied by the server before this.
 *
 * EXTRACT IS READ OFF THE KIND, NOT THE STAGE. The durable `extracting` stage
 * was already taken: `claimIngestJob` sets it on every text ingest the moment a
 * worker picks the job up, so mapping that stage to `Extract` would label a
 * pasted note's first second as a document parse. A binary arrival is instead
 * created under `kind: "extract"` and flipped to `"ingest"` when the extracted
 * text lands, which makes the row word track the thing the owner is actually
 * waiting on — the sidecar — and go away exactly when the wait does.
 */
export function activityDisplayStatus(
  status: "queued" | "processing" | "retrying" | "done" | "failed" | "skipped",
  stage?: string,
  kind?: ActivityJobKind,
  cancelled?: boolean,
): ActivityDisplayStatus {
  if (cancelled && status !== "failed") return "failed";
  if (status === "skipped") return "skipped";
  if (status === "done") return "succeeded";
  if (status === "failed") return "failed";
  // Ahead of the `queued` → `pending` line: a binary waiting on the sidecar is
  // queued, and "pending" would hide which of the two queues it is sitting in.
  if (kind === "extract") return "Extract";
  if (status === "queued" || status === "retrying") return "pending";
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
  const activeRows = rows.filter(
    (row) =>
      row.displayStatus === "pending" ||
      row.displayStatus === "Extract" ||
      row.displayStatus === "Analysis" ||
      row.displayStatus === "Generation",
  );
  const total = activeRows.length;
  const completed = 0;
  const active = activeRows.find(
    (row) =>
      row.displayStatus === "Extract" ||
      row.displayStatus === "Analysis" ||
      row.displayStatus === "Generation",
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
