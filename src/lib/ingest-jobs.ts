/**
 * Status records for ASYNC ingest jobs (currently YouTube — see the queue path
 * in `/api/ingest`). A slow ingest is enqueued to the task queue instead of run
 * synchronously; this lets the UI poll the outcome ("done → here's your page" /
 * "failed → reason") rather than hanging the request. One JSON file per job under
 * `ingest-jobs/<jobId>.json`, owner-stamped so a status read can be gated.
 */

import { getStorage } from "./storage";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import type { EmailIngestMetadata } from "./email-ingest";

/** Default TTL for terminal ingest jobs before GC deletes the file (7 days). */
export const INGEST_JOB_GC_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export type IngestJobStatus =
  | "queued"
  | "processing"
  | "retrying"
  | "done"
  | "failed"
  | "skipped";
export type IngestJobStage =
  | "dispatch-pending"
  | "queued"
  | "extracting"
  | "analysis"
  | "generation"
  | "synthesizing"
  | "indexing"
  | "deriving-knowledge"
  | "complete";

export const INGEST_CANCELLED_COPY = "Cancelled — no pages were written.";

/**
 * `extract` is the Epic 7 arm: a binary arrival's job is created under this
 * kind and parked while the sidecar claims the matching extract record. It
 * becomes `ingest` the moment the extracted text is in the kernel, which is
 * what makes "compile only after extract text exists" a property of the job
 * record rather than of whoever happens to call the queue next.
 */
export type IngestJobKind = "ingest" | "embed" | "extract";
export type IngestJobOrigin = "plaud";

/**
 * A job that's been `queued`/`processing` longer than this is treated as
 * `failed` ON READ — the consumer worker likely died mid-run (a long video can
 * hit the CPU limit) and would never write a terminal status, leaving the UI
 * polling "working…" forever. Generous: well past any real ingest time (a long
 * transcript's map/reduce synthesis runs in a few parallel batches, not tens of
 * minutes), and the queue refreshes `updatedAt` on each retry, so a job actively
 * being retried is never falsely flagged.
 */
export const INGEST_JOB_STALE_MS = 20 * 60 * 1000;

/**
 * The status a reader should act on: a non-terminal job that hasn't advanced in
 * {@link INGEST_JOB_STALE_MS} is reported as `failed` (it stalled), so the UI
 * shows a reason and stops polling instead of waiting on a dead job forever.
 */
export function effectiveStatus(
  job: Pick<IngestJob, "status" | "updatedAt">,
): { status: IngestJobStatus; error?: string } {
  if (
    job.status === "queued" ||
    job.status === "processing" ||
    job.status === "retrying"
  ) {
    const age = Date.now() - Date.parse(job.updatedAt);
    if (Number.isFinite(age) && age > INGEST_JOB_STALE_MS) {
      return { status: "failed", error: "This ingest stalled — please try again." };
    }
  }
  return { status: job.status };
}

export interface IngestJob {
  jobId: string;
  /** The source URL being ingested. Absent for non-URL sources (pasted text,
   *  uploaded PDF/image) — those show only the `title`. */
  url?: string;
  /** Handle of the user who triggered it — only they may read the status. */
  owner: string;
  status: IngestJobStatus;
  /** Current durable pipeline stage for progress UI and operational diagnosis. */
  stage?: IngestJobStage;
  /** Resulting page slug, once `done`. */
  slug?: string;
  /** Failure reason, once `failed`. */
  error?: string;
  /** Display title for the recent-ingests list (best-effort). */
  title?: string;
  /** Submission channel. Absent on older/browser-created jobs. */
  source?: "email";
  /** Owner-only inbound-email details shown in Recent ingests. */
  email?: EmailIngestMetadata;
  /** Plaud-origin Intake. Absent on other doors. */
  origin?: IngestJobOrigin;
  /** Stored Source path (`raw/sources/…`) so retry does not store again. */
  sourceRel?: string;
  relativePath?: string;
  sourceType?: string;
  contentSha256?: string;
  kind?: IngestJobKind;
  /** Workbench Wiki the job was confirmed from. Observability only — not a vault id. */
  wikiId?: string;
  cancelled?: boolean;
  /** Source was cascade-deleted; workers must not write Pages. */
  sourceDeleted?: boolean;
  reuseAnalysis?: boolean;
  progressDone?: number;
  progressTotal?: number;
  createdAt: string;
  updatedAt: string;
}

/** jobIds are UUIDs; reject anything else so a crafted id can't escape the prefix. */
function relPathFor(jobId: string): string {
  if (!/^[a-zA-Z0-9-]{1,64}$/.test(jobId)) {
    throw new Error(`invalid ingest job id: ${jobId}`);
  }
  return `ingest-jobs/${jobId}.json`;
}

function buildIngestJob(input: {
  jobId: string;
  url?: string;
  owner: string;
  title?: string;
  source?: "email";
  email?: EmailIngestMetadata;
  origin?: IngestJobOrigin;
  sourceRel?: string;
  relativePath?: string;
  sourceType?: string;
  contentSha256?: string;
  kind?: IngestJobKind;
  wikiId?: string;
  status?: IngestJobStatus;
  stage?: IngestJobStage;
}): IngestJob {
  const now = new Date().toISOString();
  const status = input.status ?? "queued";
  return {
    jobId: input.jobId,
    ...(input.url ? { url: input.url } : {}),
    owner: input.owner,
    title: input.title,
    ...(input.source ? { source: input.source } : {}),
    ...(input.email ? { email: input.email } : {}),
    ...(input.origin ? { origin: input.origin } : {}),
    ...(input.sourceRel ? { sourceRel: input.sourceRel } : {}),
    ...(input.relativePath ? { relativePath: input.relativePath } : {}),
    ...(input.sourceType ? { sourceType: input.sourceType } : {}),
    ...(input.contentSha256 ? { contentSha256: input.contentSha256 } : {}),
    ...(input.kind ? { kind: input.kind } : {}),
    ...(input.wikiId ? { wikiId: input.wikiId } : {}),
    status,
    stage: input.stage ?? (status === "skipped" ? "complete" : "queued"),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * Create a job only if that id is free. `created: false` means another isolate
 * already owns the record — callers must not enqueue a second Ingest.
 */
export async function createIngestJobIfAbsent(input: Parameters<typeof buildIngestJob>[0]): Promise<{
  job: IngestJob;
  created: boolean;
}> {
  const job = buildIngestJob(input);
  const wrote = await getStorage().writeFileIfAbsent(relPathFor(input.jobId), JSON.stringify(job));
  if (wrote) return { job, created: true };
  const existing = await getIngestJob(input.jobId);
  return { job: existing ?? job, created: false };
}

/** Create a job in the `queued` state. */
export async function createIngestJob(input: Parameters<typeof buildIngestJob>[0]): Promise<IngestJob> {
  return (await createIngestJobIfAbsent(input)).job;
}

/**
 * List tracked jobs for one owner, newest first. Job files are already bounded
 * by the seven-day GC, and malformed/vanished entries are skipped fail-soft.
 */
export async function listIngestJobs(input: {
  owner: string;
  source?: "email";
  wikiId?: string;
  limit?: number;
}): Promise<IngestJob[]> {
  const entries = await getStorage().listFiles(JOBS_PREFIX);
  const jobs: IngestJob[] = [];

  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    try {
      const raw = await getStorage().readFile(`${JOBS_PREFIX}/${entry.name}`);
      const job = JSON.parse(raw) as IngestJob;
      if (job.owner !== input.owner) continue;
      if (input.source && job.source !== input.source) continue;
      if (input.wikiId && job.wikiId && job.wikiId !== input.wikiId) continue;
      jobs.push(job);
    } catch (error) {
      if (!isEnoent(error)) {
        logger.warn("ingest-jobs", `list: failed to read ${entry.name}`, error);
      }
    }
  }

  jobs.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
  return jobs.slice(0, Math.max(1, input.limit ?? 20));
}

/** Read a job, or `null` if it doesn't exist. */
export async function getIngestJob(jobId: string): Promise<IngestJob | null> {
  try {
    const raw = await getStorage().readFile(relPathFor(jobId));
    return JSON.parse(raw) as IngestJob;
  } catch (err) {
    if (isEnoent(err)) return null;
    throw err;
  }
}

/**
 * Merge a patch into an existing job and re-stamp `updatedAt`. No-op (returns
 * `null`) if the job is gone — a status update must never resurrect or partially
 * write a record.
 */
export type IngestJobPatch = Partial<
  Pick<
    IngestJob,
    | "status"
    | "stage"
    | "slug"
    | "error"
    | "title"
    | "cancelled"
    | "sourceDeleted"
    | "reuseAnalysis"
    | "progressDone"
    | "progressTotal"
    | "contentSha256"
    | "sourceRel"
    | "origin"
    | "kind"
  >
>;

export async function updateIngestJob(
  jobId: string,
  patch: IngestJobPatch,
): Promise<IngestJob | null> {
  return withFileLock(`ingest-job:${jobId}`, async () => {
    const existing = await getIngestJob(jobId);
    if (!existing) {
      logger.warn("ingest-jobs", `updateIngestJob: job ${jobId} not found`);
      return null;
    }
    const updated: IngestJob = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
    return updated;
  });
}

/**
 * Merge a patch only while the durable job still satisfies `predicate`.
 * Queue producers use this after enqueue so a fast consumer's processing or
 * terminal checkpoint can never be regressed to queued.
 */
export async function updateIngestJobIf(
  jobId: string,
  predicate: (job: IngestJob) => boolean,
  patch: IngestJobPatch,
): Promise<IngestJob | null> {
  return withFileLock(`ingest-job:${jobId}`, async () => {
    const storage = getStorage();
    const rel = relPathFor(jobId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let read: Awaited<ReturnType<typeof storage.readFileWithEtag>>;
      try {
        read = await storage.readFileWithEtag(rel);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
      const job = JSON.parse(read.content) as IngestJob;
      if (!predicate(job)) return job;
      const updated: IngestJob = {
        ...job,
        ...patch,
        updatedAt: new Date().toISOString(),
      };
      if (await storage.writeFileIfMatch(rel, JSON.stringify(updated), read.etag)) {
        return updated;
      }
    }
    throw new Error("Ingest job was busy; retry the update");
  });
}

/**
 * Claim a queued or retrying job for this isolate. Returns null if another
 * worker already holds it, it is terminal, cancelled, or source-deleted.
 */
export async function claimIngestJob(
  jobId: string,
  owner: string,
): Promise<IngestJob | null> {
  return withFileLock(`ingest-job:${jobId}`, async () => {
    const storage = getStorage();
    const rel = relPathFor(jobId);
    for (let attempt = 0; attempt < 8; attempt += 1) {
      let read: Awaited<ReturnType<typeof storage.readFileWithEtag>>;
      try {
        read = await storage.readFileWithEtag(rel);
      } catch (error) {
        if (isEnoent(error)) return null;
        throw error;
      }
      const job = JSON.parse(read.content) as IngestJob;
      if (!job || job.owner !== owner) return null;
      if (job.cancelled || job.sourceDeleted) return null;
      if (job.status !== "queued" && job.status !== "retrying") return null;
      const updated: IngestJob = {
        ...job,
        status: "processing",
        stage: job.stage === "generation" ? "generation" : "extracting",
        updatedAt: new Date().toISOString(),
      };
      if (await storage.writeFileIfMatch(rel, JSON.stringify(updated), read.etag)) {
        return updated;
      }
    }
    throw new Error("Ingest job was busy; retry the claim");
  });
}

/** Cancel or tombstone every non-terminal job whose Source identity matches. */
export async function cancelJobsForSource(
  owner: string,
  keys: readonly string[],
): Promise<number> {
  const keySet = new Set(keys);
  const jobs = await listIngestJobs({ owner, limit: 500 });
  let n = 0;
  for (const job of jobs) {
    if (!job.sourceRel) continue;
    if (!keySet.has(job.sourceRel) && !keys.some((key) => job.sourceRel?.endsWith(key))) {
      continue;
    }
    if (job.status === "done" || job.status === "skipped") {
      await updateIngestJob(job.jobId, { sourceDeleted: true, cancelled: true });
      n += 1;
      continue;
    }
    await updateIngestJob(job.jobId, {
      cancelled: true,
      sourceDeleted: true,
      status: job.status === "processing" ? "processing" : "failed",
      error: INGEST_CANCELLED_COPY,
    });
    n += 1;
  }
  return n;
}

// ---------------------------------------------------------------------------
// Garbage collection — purge terminal jobs older than a TTL
// ---------------------------------------------------------------------------

const TERMINAL_STATUSES: Set<IngestJobStatus> = new Set([
  "done",
  "failed",
  "skipped",
]);

/**
 * Ask a queued or in-flight job to stop before Page writes. Terminal jobs are
 * left as they are. A queued job becomes failed immediately so Activity can
 * offer Retry; an in-flight job sets `cancelled` and ingest observes it
 * immediately before `writeWikiPageWithSideEffects`.
 */
export async function cancelIngestJob(
  jobId: string,
  owner: string,
): Promise<IngestJob | null> {
  return withFileLock(`ingest-job:${jobId}`, async () => {
    const job = await getIngestJob(jobId);
    if (!job || job.owner !== owner) return null;
    if (job.status === "done" || job.status === "skipped") return job;
    if (job.status === "failed") {
      if (job.cancelled) return job;
      const updated: IngestJob = {
        ...job,
        cancelled: true,
        updatedAt: new Date().toISOString(),
      };
      await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
      return updated;
    }
    if (job.status === "processing") {
      const updated: IngestJob = {
        ...job,
        cancelled: true,
        updatedAt: new Date().toISOString(),
      };
      await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
      return updated;
    }
    const updated: IngestJob = {
      ...job,
      cancelled: true,
      status: "failed",
      error: INGEST_CANCELLED_COPY,
      updatedAt: new Date().toISOString(),
    };
    await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
    return updated;
  });
}

/**
 * Reset a failed job so the same Source can be compiled again. Does not store
 * bytes. Caller re-enqueues the existing `sourceRel`.
 */
export async function retryIngestJob(
  jobId: string,
  owner: string,
): Promise<IngestJob | null> {
  return withFileLock(`ingest-job:${jobId}`, async () => {
    const job = await getIngestJob(jobId);
    if (!job || job.owner !== owner) return null;
    if (job.sourceDeleted) return null;
    if (job.status === "processing" || job.status === "retrying") return null;
    if (job.status !== "failed") return null;
    const updated: IngestJob = {
      ...job,
      status: "queued",
      stage: "queued",
      error: "",
      cancelled: false,
      reuseAnalysis: true,
      updatedAt: new Date().toISOString(),
    };
    await getStorage().writeFile(relPathFor(jobId), JSON.stringify(updated));
    return updated;
  });
}
const JOBS_PREFIX = "ingest-jobs";

/**
 * Delete one terminal ingest-job record owned by `owner`.
 *
 * This clears status/history only; callers that also want to remove a generated
 * wiki page must run the page lifecycle delete first. Non-terminal jobs are
 * deliberately protected because deleting their status file would not cancel
 * the queue message that is still processing.
 */
/**
 * Drop a job that was created in this request and never enqueued.
 * Not a cancel of in-flight work — the queue never saw this id.
 */
export async function abandonFreshIngestJob(
  jobId: string,
  owner: string,
): Promise<void> {
  const job = await getIngestJob(jobId);
  if (!job || job.owner !== owner) return;
  if (job.status !== "queued") return;
  try {
    await getStorage().deleteFile(relPathFor(jobId));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function deleteIngestJob(
  jobId: string,
  owner: string,
): Promise<boolean> {
  const job = await getIngestJob(jobId);
  if (!job || job.owner !== owner) return false;
  if (!TERMINAL_STATUSES.has(job.status)) {
    throw new Error("queued or processing ingest jobs cannot be deleted");
  }

  try {
    await getStorage().deleteFile(relPathFor(jobId));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

/**
 * List all job files and delete terminal (`done` / `failed`) jobs whose
 * `updatedAt` is older than `ttlMs`. Non-terminal jobs are never deleted —
 * they may still be processing or retrying, even if they look old.
 *
 * Returns the number of files deleted.
 */
export async function purgeStaleIngestJobs(
  ttlMs: number = INGEST_JOB_GC_TTL_MS,
): Promise<number> {
  const storage = getStorage();
  const entries = await storage.listFiles(JOBS_PREFIX);
  const cutoff = Date.now() - ttlMs;
  let deleted = 0;

  for (const entry of entries) {
    if (entry.isDirectory || !entry.name.endsWith(".json")) continue;
    const relPath = `${JOBS_PREFIX}/${entry.name}`;
    try {
      const raw = await storage.readFile(relPath);
      const job: IngestJob = JSON.parse(raw);
      if (!TERMINAL_STATUSES.has(job.status)) continue;
      const updatedMs = Date.parse(job.updatedAt);
      if (!Number.isFinite(updatedMs) || updatedMs > cutoff) continue;
      await storage.deleteFile(relPath);
      deleted++;
    } catch (err) {
      // Best-effort: skip files that vanish mid-scan or are unparseable.
      if (!isEnoent(err)) {
        logger.warn("ingest-jobs", `GC: failed to process ${entry.name}:`, err);
      }
    }
  }

  if (deleted > 0) {
    logger.info("ingest-jobs", `GC: purged ${deleted} stale job(s)`);
  }
  return deleted;
}
