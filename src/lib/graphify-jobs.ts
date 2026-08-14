/**
 * Owner-scoped, durable progress for whole-wiki structured-knowledge rebuilds.
 *
 * One job is stored as a single R2 object. Page workers update it with an ETag
 * compare-and-swap loop so parallel queue deliveries cannot overwrite each
 * other's progress. The graph itself remains derived and rebuildable; this file
 * only gives the owner an honest view of what was queued, completed, or failed.
 */

import { getErrorMessage, isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { listWikiPages, tenantForOwner, validateSlug, validateTenant } from "./wiki";

export const MAX_GRAPHIFY_PAGES = 1_000;
export const GRAPHIFY_JOB_STALE_MS = 30 * 60 * 1_000;

export type GraphifyItemStatus = "queued" | "processing" | "done" | "failed";
export type GraphifyJobStatus =
  | "queued"
  | "processing"
  | "done"
  | "completed_with_errors"
  | "stalled";

export interface GraphifyJobItem {
  slug: string;
  status: GraphifyItemStatus;
  attempts: number;
  error?: string;
}

export interface GraphifyJob {
  version: 1;
  jobId: string;
  owner: string;
  scope: "wiki";
  status: GraphifyJobStatus;
  total: number;
  queued: number;
  processing: number;
  succeeded: number;
  failed: number;
  items: GraphifyJobItem[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

function ownerTenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function validateJobId(jobId: string): void {
  if (!/^graphify_[a-f0-9-]{36}$/i.test(jobId)) {
    throw new Error(`invalid graphify job id: ${jobId}`);
  }
}

function jobPath(owner: string, jobId: string): string {
  validateJobId(jobId);
  return `tenants/${ownerTenant(owner)}/graphify-jobs/${jobId}.json`;
}

function latestPath(owner: string): string {
  return `tenants/${ownerTenant(owner)}/graphify-jobs/latest.json`;
}

function jobLock(owner: string, jobId: string): string {
  return `graphify-job:${ownerTenant(owner)}:${jobId}`;
}

function sameOwner(left: string, right: string): boolean {
  return ownerTenant(left) === ownerTenant(right);
}

function summarize(job: GraphifyJob, now: string): GraphifyJob {
  let queued = 0;
  let processing = 0;
  let succeeded = 0;
  let failed = 0;
  for (const item of job.items) {
    if (item.status === "queued") queued += 1;
    else if (item.status === "processing") processing += 1;
    else if (item.status === "done") succeeded += 1;
    else failed += 1;
  }

  const active = queued + processing;
  const status: GraphifyJobStatus = active > 0
    ? processing > 0 || succeeded > 0 || failed > 0
      ? "processing"
      : "queued"
    : failed > 0
      ? "completed_with_errors"
      : "done";

  return {
    ...job,
    status,
    total: job.items.length,
    queued,
    processing,
    succeeded,
    failed,
    updatedAt: now,
    ...(active === 0
      ? { completedAt: job.completedAt ?? now }
      : { completedAt: undefined }),
  };
}

function parseJob(raw: string, owner: string): GraphifyJob {
  const job = JSON.parse(raw) as GraphifyJob;
  if (
    job.version !== 1 ||
    !Array.isArray(job.items) ||
    !sameOwner(job.owner, owner)
  ) {
    throw new Error("Graphify job is invalid or belongs to another owner");
  }
  return job;
}

export async function listGraphifiableWikiPages(owner: string): Promise<string[]> {
  const tenant = ownerTenant(owner);
  const pages = await listWikiPages();
  return pages
    .filter(
      (page) =>
        page.slug !== "index" &&
        page.slug !== "log" &&
        typeof page.owner === "string" &&
        tenantForOwner(page.owner) === tenant,
    )
    .map((page) => page.slug)
    .sort((a, b) => a.localeCompare(b));
}

export async function createGraphifyJob(
  owner: string,
  slugs: readonly string[],
): Promise<GraphifyJob> {
  const unique = [...new Set(slugs.map((slug) => slug.trim()).filter(Boolean))];
  if (unique.length === 0) throw new Error("There are no owner pages to graphify");
  if (unique.length > MAX_GRAPHIFY_PAGES) {
    throw new Error(`A Graphify job may contain at most ${MAX_GRAPHIFY_PAGES} pages`);
  }
  for (const slug of unique) validateSlug(slug);

  const now = new Date().toISOString();
  const jobId = `graphify_${crypto.randomUUID()}`;
  const job = summarize({
    version: 1,
    jobId,
    owner,
    scope: "wiki",
    status: "queued",
    total: unique.length,
    queued: unique.length,
    processing: 0,
    succeeded: 0,
    failed: 0,
    items: unique.map((slug) => ({ slug, status: "queued", attempts: 0 })),
    createdAt: now,
    updatedAt: now,
  }, now);

  await getStorage().writeFile(jobPath(owner, jobId), JSON.stringify(job));
  await getStorage().writeFile(latestPath(owner), JSON.stringify({ jobId }));
  return job;
}

export async function getGraphifyJob(
  owner: string,
  jobId: string,
): Promise<GraphifyJob | null> {
  try {
    return parseJob(await getStorage().readFile(jobPath(owner, jobId)), owner);
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export async function getLatestGraphifyJob(owner: string): Promise<GraphifyJob | null> {
  try {
    const latest = JSON.parse(
      await getStorage().readFile(latestPath(owner)),
    ) as { jobId?: unknown };
    return typeof latest.jobId === "string"
      ? getGraphifyJob(owner, latest.jobId)
      : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

export function effectiveGraphifyJob(job: GraphifyJob): GraphifyJob {
  if (job.status !== "queued" && job.status !== "processing") return job;
  const age = Date.now() - Date.parse(job.updatedAt);
  return Number.isFinite(age) && age > GRAPHIFY_JOB_STALE_MS
    ? { ...job, status: "stalled" }
    : job;
}

async function mutateGraphifyJob(
  owner: string,
  jobId: string,
  mutate: (job: GraphifyJob) => GraphifyJob,
): Promise<GraphifyJob> {
  return withFileLock(jobLock(owner, jobId), async () => {
    const storage = getStorage();
    const path = jobPath(owner, jobId);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const current = await storage.readFileWithEtag(path);
      const job = parseJob(current.content, owner);
      const updated = summarize(mutate(job), new Date().toISOString());
      if (await storage.writeFileIfMatch(path, JSON.stringify(updated), current.etag)) {
        return updated;
      }
    }
    throw new Error("Graphify progress was busy; retry the status update");
  });
}

export async function startGraphifyPage(
  owner: string,
  jobId: string,
  slug: string,
): Promise<{ job: GraphifyJob; shouldRun: boolean }> {
  validateSlug(slug);
  let shouldRun = true;
  const job = await mutateGraphifyJob(owner, jobId, (current) => {
    const item = current.items.find((entry) => entry.slug === slug);
    if (!item) throw new Error(`Page ${slug} is not part of Graphify job ${jobId}`);
    if (item.status === "done") {
      shouldRun = false;
      return current;
    }
    item.status = "processing";
    item.attempts += 1;
    delete item.error;
    return current;
  });
  return { job, shouldRun };
}

export async function completeGraphifyPage(
  owner: string,
  jobId: string,
  slug: string,
): Promise<GraphifyJob> {
  validateSlug(slug);
  return mutateGraphifyJob(owner, jobId, (job) => {
    const item = job.items.find((entry) => entry.slug === slug);
    if (!item) throw new Error(`Page ${slug} is not part of Graphify job ${jobId}`);
    item.status = "done";
    delete item.error;
    return job;
  });
}

export async function failGraphifyPages(
  owner: string,
  jobId: string,
  slugs: readonly string[],
  error: unknown,
): Promise<GraphifyJob> {
  const targets = new Set(slugs);
  const message = getErrorMessage(error, "Graphify failed").slice(0, 500);
  return mutateGraphifyJob(owner, jobId, (job) => {
    for (const item of job.items) {
      if (!targets.has(item.slug) || item.status === "done") continue;
      item.status = "failed";
      item.error = message;
    }
    return job;
  });
}

export async function prepareGraphifyRetry(
  owner: string,
  jobId: string,
): Promise<{ job: GraphifyJob; slugs: string[] }> {
  const existing = await getGraphifyJob(owner, jobId);
  if (!existing) throw new Error("Graphify job not found");
  const stalled = effectiveGraphifyJob(existing).status === "stalled";
  const slugs = existing.items
    .filter((item) => item.status === "failed" || (stalled && item.status !== "done"))
    .map((item) => item.slug);
  if (slugs.length === 0) throw new Error("This Graphify job has no pages to retry");

  const targets = new Set(slugs);
  const job = await mutateGraphifyJob(owner, jobId, (current) => {
    for (const item of current.items) {
      if (!targets.has(item.slug)) continue;
      item.status = "queued";
      delete item.error;
    }
    return current;
  });
  return { job, slugs };
}
