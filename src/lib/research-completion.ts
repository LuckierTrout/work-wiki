import { serializeFrontmatter, type Frontmatter } from "./frontmatter";
import { isEnoent } from "./errors";
import {
  createIngestJobIfAbsent,
  getIngestJob,
  updateIngestJob,
  type IngestJob,
} from "./ingest-jobs";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { logger } from "./logger";
import { saveRawSourceFor } from "./raw";
import { withFileLock } from "./lock";
import {
  deleteResearchProject,
  getResearchProject,
  mutateResearchProject,
  updateResearchProjectIf,
  type ResearchCompletionSource,
  type ResearchProject,
  type ResearchProjectResult,
} from "./research-projects";
import { researchPageSlug, researchSourceSlug } from "./research-slug";
import { sourceSha256 } from "./source-sha256";
import { buildSourceEntry, serializeSources } from "./sources";
import { getStorage } from "./storage";
import { enqueueTask } from "./tasks";
import { readWikiPage, tenantForOwner, validateTenant } from "./wiki";

/**
 * Durable Page / Source / Ingest completion.
 *
 * The run loop produces a brief and a set of fetched bodies. THIS module is
 * the operation that makes them exist: persist an outbox, claim the Page
 * write, write the Page, store each Source, enqueue Ingest, then mark
 * `complete`. Every step is idempotent so a crash between any two can be
 * retried from the panel poll or reconcile.
 */

export interface FetchedSource {
  url: string;
  title: string;
  text?: string;
}

export interface ResearchOutboxSource {
  url: string;
  title: string;
  slug: string;
  sha: string;
  sourcePath: string;
  length: number;
}

interface ResearchOutbox {
  pageSlug: string;
  wikiId?: string;
  title: string;
  synthesis: string;
  thinking: string[];
  /** Durable references only. Full bodies live in immutable Source snapshots. */
  sources: ResearchOutboxSource[];
  evidence: Array<{ url: string; title: string; snippet?: string; query?: string }>;
  /**
   * True only after this run won the Page-write claim. An unclaimed outbox
   * is a pre-write staging file: if the project is gone, drop it.
   */
  claimed?: boolean;
}

function outboxDir(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-outbox`;
}

function outboxPath(owner: string, id: string): string {
  return `${outboxDir(owner)}/${id}.json`;
}

function pageWrittenPath(owner: string, id: string): string {
  return `${outboxPath(owner, id)}.page-written`;
}

async function pageWriteAlreadyCompleted(owner: string, id: string): Promise<boolean> {
  try {
    await getStorage().readFile(pageWrittenPath(owner, id));
    return true;
  } catch (error) {
    if (isEnoent(error)) return false;
    throw error;
  }
}

async function clearPageWrittenMarker(owner: string, id: string): Promise<void> {
  try {
    await getStorage().deleteFile(pageWrittenPath(owner, id));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function saveResearchOutbox(
  owner: string,
  id: string,
  outbox: Omit<ResearchOutbox, "sources"> & { sources: Array<ResearchOutboxSource | FetchedSource> },
): Promise<void> {
  const sources: ResearchOutboxSource[] = [];
  for (const source of outbox.sources) {
    if ("sourcePath" in source) {
      sources.push(source);
      continue;
    }
    sources.push(await persistResearchSource(owner, source));
  }
  await getStorage().writeFile(outboxPath(owner, id), JSON.stringify({ ...outbox, sources }));
}

/** Stage a fetched body outside the Source tree until synthesis succeeds. */
export async function stageResearchSource(
  owner: string,
  projectId: string,
  source: FetchedSource,
): Promise<ResearchOutboxSource> {
  if (typeof source.text !== "string") throw new Error(`Source body missing for ${source.url}`);
  const slug = researchSourceSlug(source.url);
  if (!slug) throw new Error(`Invalid research Source URL: ${source.url}`);
  const sha = await sourceSha256(source.text);
  const sourcePath = `${outboxDir(owner)}/staging-${projectId}-${slug}-${sha}.md`;
  await getStorage().writeFile(sourcePath, source.text);
  return { url: source.url, title: source.title, slug, sha, sourcePath, length: source.text.length };
}

export async function clearResearchStaging(
  sources: readonly Partial<ResearchOutboxSource>[],
): Promise<void> {
  for (const source of sources) {
    if (!source.sourcePath?.includes("/research-outbox/staging-")) continue;
    try {
      await getStorage().deleteFile(source.sourcePath);
    } catch (error) {
      if (!isEnoent(error)) logger.warn("research", `staging cleanup skipped for ${source.sourcePath}`, error);
    }
  }
}

/** Spill one fetched body to its immutable Source snapshot. */
export async function persistResearchSource(
  owner: string,
  source: FetchedSource,
): Promise<ResearchOutboxSource> {
  if (typeof source.text !== "string") throw new Error(`Source body missing for ${source.url}`);
  const slug = researchSourceSlug(source.url);
  if (!slug) throw new Error(`Invalid research Source URL: ${source.url}`);
  const sha = await sourceSha256(source.text);
  await saveRawSourceFor(slug, sha, source.text, { owner });
  return {
    url: source.url,
    title: source.title,
    slug,
    sha,
    sourcePath: `raw/sources/${slug}/${sha}.md`,
    length: source.text.length,
  };
}

export async function deleteResearchOutbox(owner: string, id: string): Promise<void> {
  try {
    await getStorage().deleteFile(outboxPath(owner, id));
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
}

export async function loadResearchOutbox(
  owner: string,
  id: string,
): Promise<ResearchOutbox | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(outboxPath(owner, id))) as ResearchOutbox;
    if (!parsed || typeof parsed.pageSlug !== "string" || typeof parsed.synthesis !== "string") {
      return null;
    }
    return parsed;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

/** Project ids that have a persisted outbox, even if the registry lost its pointer. */
export async function listResearchOutboxIds(owner: string): Promise<string[]> {
  try {
    const entries = await getStorage().listFiles(outboxDir(owner));
    return entries
      .filter((entry) => !entry.isDirectory && entry.name.endsWith(".json"))
      .map((entry) => entry.name.replace(/\.json$/, ""));
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export function researchFrontmatter(
  owner: string,
  evidence: readonly { url: string }[],
  wikiId?: string,
): Frontmatter {
  const today = new Date().toISOString().slice(0, 10);
  return {
    created: today,
    updated: today,
    owner,
    visibility: "private",
    authors: ["research-agent"],
    contributors: [],
    tags: ["research"],
    source_count: String(evidence.length),
    sources: serializeSources(evidence.map((result) =>
      buildSourceEntry(result.url, "url", owner))),
    ...(wikiId ? { wiki: wikiId } : {}),
    confidence: evidence.length >= 4 ? 0.75 : 0.65,
    disputed: false,
    supersedes: "",
    aliases: [],
    valid_from: today,
  };
}

/** How long a Page-write claim stays exclusive before a crash resume may steal it. */
export const RESEARCH_PAGE_WRITE_STALE_MS = 2 * 60 * 1000;
/** How often a live writer renews {@link RESEARCH_PAGE_WRITE_STALE_MS}. */
const RESEARCH_PAGE_WRITE_HEARTBEAT_MS = Math.max(
  5_000,
  Math.floor(RESEARCH_PAGE_WRITE_STALE_MS / 6),
);
/** A queued job younger than this is assumed to have a sibling about to enqueue. */
const RESEARCH_INGEST_QUEUE_FRESH_MS = 15_000;

function ingestJobIsFresh(job: Pick<IngestJob, "updatedAt">, now = Date.now()): boolean {
  const age = now - Date.parse(job.updatedAt);
  return Number.isFinite(age) && age < RESEARCH_INGEST_QUEUE_FRESH_MS;
}

/** Stable Ingest job id: same project + source + body always mint the same id. */
export async function researchIngestJobId(
  projectId: string,
  slug: string,
  sha: string,
): Promise<string> {
  return sourceSha256(`${projectId}:${slug}:${sha}`);
}

async function completionSourcesFromOutbox(
  outbox: ResearchOutbox,
): Promise<ResearchCompletionSource[]> {
  return outbox.sources.map(({ url, title, slug, sha }) => ({ url, title, slug, sha }));
}

export function researchWriteClaimIsFresh(
  claimedAt: string | undefined,
  now = Date.now(),
): boolean {
  if (!claimedAt) return false;
  const age = now - Date.parse(claimedAt);
  return Number.isFinite(age) && age < RESEARCH_PAGE_WRITE_STALE_MS;
}

function startWriteClaimHeartbeat(owner: string, id: string, claimId: string): () => void {
  const timer = setInterval(() => {
    void mutateResearchProject(owner, id, (project) => {
      if (project.completion?.writeClaimId !== claimId) return null;
      project.completion.writeClaimedAt = new Date().toISOString();
      return project;
    }).catch(() => undefined);
  }, RESEARCH_PAGE_WRITE_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

function researchPageBody(owner: string, outbox: ResearchOutbox): string {
  return serializeFrontmatter(
    researchFrontmatter(owner, outbox.evidence, outbox.wikiId),
    outbox.synthesis,
  );
}

async function writeResearchPage(owner: string, outbox: ResearchOutbox): Promise<void> {
  const body = researchPageBody(owner, outbox);
  await writeWikiPageWithSideEffects({
    slug: outbox.pageSlug,
    title: outbox.title,
    content: body,
    summary: `Research brief from ${outbox.sources.length} web sources.`,
    logOp: "other",
    author: "research-agent",
    // A recovery must never overwrite an owner edit. The project-specific
    // slug is a create boundary; exact-content recovery is handled before this
    // call and an unrelated existing Page is a hard conflict.
    createOnly: true,
    crossRefSource: outbox.synthesis,
    logDetails: ({ updatedSlugs }) =>
      `Deep Research wrote ${outbox.pageSlug} from ${outbox.sources.length} sources${
        updatedSlugs.length > 0 ? `; cross-linked ${updatedSlugs.join(", ")}` : ""
      }.`,
  });
}

/**
 * Persist the outbox and write the Page, or refuse if cancel won the claim.
 *
 * The exclusive fence is `completion.writeClaimId`. Winning that CAS owns
 * the Page write. A concurrent loser returns without touching the lifecycle
 * writer. A live writer renews `writeClaimedAt` so a crash resume cannot
 * steal the claim while the lifecycle call is still running.
 */
export async function commitResearchPage(
  owner: string,
  id: string,
  input: Omit<ResearchOutbox, "sources"> & { sources: Array<ResearchOutboxSource | FetchedSource> },
): Promise<ResearchProject | null> {
  const existing = await getResearchProject(owner, id);
  if (!existing) return null;
  if (existing.deleteRequested && !existing.completion) {
    await deleteResearchOutbox(owner, id);
    await deleteResearchProject(owner, id);
    return null;
  }
  if ((existing.cancelRequested || existing.status === "cancelled") && !existing.completion) {
    await deleteResearchOutbox(owner, id);
    return null;
  }

  await saveResearchOutbox(owner, id, { ...input, claimed: false });
  const outbox = await loadResearchOutbox(owner, id);
  if (!outbox) throw new Error("Research outbox could not be persisted");
  const afterSave = await getResearchProject(owner, id);
  if (!afterSave) {
    await deleteResearchOutbox(owner, id);
    return null;
  }
  if (
    afterSave.deleteRequested
    && !researchWriteClaimIsFresh(afterSave.completion?.writeClaimedAt)
  ) {
    await deleteResearchOutbox(owner, id);
    await deleteResearchProject(owner, id);
    return null;
  }
  if ((afterSave.cancelRequested || afterSave.status === "cancelled") && !afterSave.completion) {
    await deleteResearchOutbox(owner, id);
    return null;
  }

  if (afterSave.completion?.phase === "sources" || afterSave.completion?.phase === "done") {
    return afterSave;
  }

  const sources = afterSave.completion?.sources?.length
    ? afterSave.completion.sources
    : await completionSourcesFromOutbox(outbox);

  const claimId = crypto.randomUUID();
  const claimed = await mutateResearchProject(owner, id, (project) => {
    if (project.deleteRequested && !project.completion) return null;
    if ((project.cancelRequested || project.status === "cancelled") && !project.completion) {
      return null;
    }
    if (project.completion?.phase === "sources" || project.completion?.phase === "done") {
      return null;
    }
    if (researchWriteClaimIsFresh(project.completion?.writeClaimedAt)) return null;
    project.completion = {
      phase: "page",
      pageSlug: outbox.pageSlug,
      ...(outbox.wikiId ? { wikiId: outbox.wikiId } : {}),
      sources: project.completion?.sources?.length ? project.completion.sources : sources,
      writeClaimedAt: new Date().toISOString(),
      writeClaimId: claimId,
    };
    return project;
  });
  if (!claimed) {
    const latest = await getResearchProject(owner, id);
    if (!latest) {
      await deleteResearchOutbox(owner, id);
      return null;
    }
    if (
      latest.deleteRequested
      && !researchWriteClaimIsFresh(latest.completion?.writeClaimedAt)
    ) {
      await deleteResearchOutbox(owner, id);
      await deleteResearchProject(owner, id);
      return null;
    }
    if ((latest.cancelRequested || latest.status === "cancelled") && !latest.completion) {
      await deleteResearchOutbox(owner, id);
      return null;
    }
    return latest;
  }
  await saveResearchOutbox(owner, id, { ...outbox, claimed: true });
  if (claimed.deleteRequested) {
    await deleteResearchOutbox(owner, id);
    await deleteResearchProject(owner, id);
    return null;
  }

  const stopHeartbeat = startWriteClaimHeartbeat(owner, id, claimId);
  try {
    const authorized = await mutateResearchProject(owner, id, (project) => {
      if (project.completion?.writeClaimId !== claimId) return null;
      if (project.cancelRequested || project.status === "cancelled" || project.deleteRequested) {
        return null;
      }
      project.completion.writeAuthorizedAt = new Date().toISOString();
      return project;
    });
    if (!authorized) {
      const latest = await getResearchProject(owner, id);
      if (!latest) return null;
      if (latest.deleteRequested) {
        await deleteResearchOutbox(owner, id);
        await deleteResearchProject(owner, id);
        return null;
      }
      if (latest.cancelRequested || latest.status === "cancelled") {
        const cancelled = await mutateResearchProject(owner, id, (project) => {
          if (project.completion?.writeClaimId !== claimId) return null;
          delete project.completion;
          project.status = "cancelled";
          project.progress = {
            completedQueries: project.progress?.completedQueries ?? 0,
            totalQueries: project.progress?.totalQueries ?? project.queries.length,
            message: "Cancelled before the Page write.",
          };
          return project;
        });
        await deleteResearchOutbox(owner, id);
        await clearPageWrittenMarker(owner, id);
        return cancelled;
      }
      return latest;
    }
    if (authorized.deleteRequested) {
      await deleteResearchOutbox(owner, id);
      await deleteResearchProject(owner, id);
      return null;
    }
    if (!await pageWriteAlreadyCompleted(owner, id)) {
      const existingPage = await readWikiPage(outbox.pageSlug, { fresh: true, strict: true });
      if (existingPage) {
        if (existingPage.content !== researchPageBody(owner, outbox)) {
          throw new Error(`Page "${outbox.pageSlug}" already exists with different content`);
        }
        // The lifecycle call completed but the process died before its receipt.
        // Exact bytes prove this operation's immutable create landed; do not
        // replay lifecycle side effects or overwrite a later owner edit.
      } else {
        await writeResearchPage(owner, outbox);
      }
      await getStorage().writeFile(
        pageWrittenPath(owner, id),
        JSON.stringify({ completedAt: new Date().toISOString(), claimId }),
      );
    }
  } catch (error) {
    await mutateResearchProject(owner, id, (project) => {
      const completion = project.completion;
      if (!completion || completion.writeClaimId !== claimId) return null;
      delete completion.writeClaimedAt;
      delete completion.writeClaimId;
      return project;
    }).catch(() => undefined);
    throw error;
  } finally {
    stopHeartbeat();
  }

  const marked = await markResearchPageWritten(owner, id, existing, outbox, sources, claimId);
  if (marked?.completion?.phase === "sources" || marked?.completion?.phase === "done") {
    await clearPageWrittenMarker(owner, id);
  }
  return marked;
}

async function markResearchPageWritten(
  owner: string,
  id: string,
  existing: ResearchProject,
  outbox: ResearchOutbox,
  sources: ResearchCompletionSource[],
  claimId: string,
): Promise<ResearchProject | null> {
  const latest = await getResearchProject(owner, id);
  return updateResearchProjectIf(
    owner,
    id,
    (project) =>
      project.completion?.phase === "page"
      && project.completion.writeClaimId === claimId,
    {
      completion: {
        phase: "sources",
        pageSlug: outbox.pageSlug,
        ...(outbox.wikiId ? { wikiId: outbox.wikiId } : {}),
        sources,
      },
      pageSlugs: [...new Set([...(latest?.pageSlugs ?? existing.pageSlugs), outbox.pageSlug])],
      synthesis: outbox.synthesis,
      ...(outbox.thinking.length > 0 ? { thinking: outbox.thinking } : {}),
      progress: {
        completedQueries: latest?.progress?.totalQueries
          ?? existing.progress?.totalQueries
          ?? existing.queries.length,
        totalQueries: latest?.progress?.totalQueries
          ?? existing.progress?.totalQueries
          ?? existing.queries.length,
        message: `Wrote ${outbox.pageSlug}. Ingesting ${sources.length} sources.`,
      },
    },
  ) ?? getResearchProject(owner, id);
}

async function checkpointSource(
  owner: string,
  id: string,
  url: string,
  patch: Partial<ResearchCompletionSource>,
): Promise<ResearchCompletionSource | null> {
  const updated = await mutateResearchProject(owner, id, (project) => {
    if (!project.completion) return null;
    const index = project.completion.sources.findIndex((source) => source.url === url);
    if (index < 0) return null;
    const current = project.completion.sources[index];
    if (patch.jobId && current.jobId && current.jobId !== patch.jobId) return project;
    if (current.ingested && patch.ingested === false) return project;
    const sources = project.completion.sources.slice();
    sources[index] = { ...current, ...patch, jobId: current.jobId ?? patch.jobId };
    project.completion = { ...project.completion, sources };
    return project;
  });
  return updated?.completion?.sources.find((source) => source.url === url) ?? null;
}

async function ingestOneSource(
  owner: string,
  projectId: string,
  source: ResearchOutboxSource,
  meta: ResearchCompletionSource,
  wikiId?: string,
): Promise<ResearchCompletionSource> {
  if (meta.ingested) return meta;
  const jobId = meta.jobId ?? await researchIngestJobId(projectId, meta.slug, meta.sha);
  const claimed = await checkpointSource(owner, projectId, source.url, { jobId });
  const current = claimed ?? { ...meta, jobId };
  if (current.ingested) return current;
  try {
    await dispatchSourceIngest(owner, projectId, source, current, wikiId);
    const ingested = await checkpointSource(owner, projectId, source.url, {
      jobId,
      ingested: true,
      error: undefined,
    });
    return ingested ?? { ...current, jobId, ingested: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("research", `source ingest skipped for ${source.url}`, error);
    const failed = await checkpointSource(owner, projectId, source.url, {
      jobId,
      ingested: false,
      error: message,
    });
    return failed ?? { ...current, jobId, ingested: false, error: message };
  }
}

async function dispatchSourceIngest(
  owner: string,
  projectId: string,
  source: ResearchOutboxSource,
  meta: ResearchCompletionSource,
  wikiId?: string,
): Promise<void> {
  const jobId = meta.jobId ?? await researchIngestJobId(projectId, meta.slug, meta.sha);
  const stagedPath = source.sourcePath;
  const text = await getStorage().readFile(stagedPath);
  await saveRawSourceFor(meta.slug, meta.sha, text, { owner });
  const sourcePath = `raw/sources/${meta.slug}/${meta.sha}.md`;
  await withFileLock(`research-ingest-dispatch:${jobId}`, async () => {
    const existingJob = await getIngestJob(jobId);
    if (existingJob?.status === "done" || existingJob?.status === "skipped") return;
    if (existingJob?.status === "processing" || existingJob?.status === "retrying") return;
    if (existingJob?.status === "queued" && existingJob.stage === "queued" && ingestJobIsFresh(existingJob)) return;
    if (!existingJob) {
      const minted = await createIngestJobIfAbsent({
        jobId,
        owner,
        title: source.title || source.url,
        url: source.url,
        sourceRel: sourcePath,
        sourceType: "url",
        contentSha256: meta.sha,
        stage: "dispatch-pending",
        ...(wikiId ? { wikiId } : {}),
      });
      if (!minted.created) return;
    } else if (existingJob.status === "failed") {
      await updateIngestJob(jobId, { status: "queued", stage: "dispatch-pending", error: undefined });
    }
    const title = source.title || source.url;
    let enqueued: boolean;
    try {
      enqueued = await enqueueTask({
      kind: "ingest",
      title,
      owner,
      author: owner,
      triggeredBy: owner,
      tags: wikiId ? ["research", `wiki:${wikiId}`] : ["research"],
      jobId,
      sourceType: "url",
      sourceUrl: source.url,
      sourcePath,
      contentSha256: meta.sha,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateIngestJob(jobId, { status: "failed", error: message }).catch(() => undefined);
      throw error;
    }
    if (enqueued) {
      await updateIngestJob(jobId, { status: "queued", stage: "queued", error: undefined });
      return;
    }
    const { ingest } = await import("./ingest");
    try {
      const result = await ingest(title, text, {
      owner,
      author: owner,
      triggeredBy: owner,
      tags: wikiId ? ["research", `wiki:${wikiId}`] : ["research"],
      sourceType: "url",
      sourceUrl: source.url,
      sourcePath,
      contentSha256: meta.sha,
      jobId,
      });
      await updateIngestJob(jobId, {
        status: result.skipped ? "skipped" : "done",
        stage: "complete",
        slug: result.primarySlug,
        error: undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await updateIngestJob(jobId, { status: "failed", error: message }).catch(() => undefined);
      throw error;
    }
  });
}

/**
 * Drain a persisted outbox: store Sources and enqueue Ingest, then `complete`.
 *
 * Safe to call on a project that is already `complete` — remaining sources
 * retry, already-ingested ones skip. Does not rewrite the Page once phase
 * has left `"page"`.
 */
export async function drainResearchOutbox(
  owner: string,
  id: string,
): Promise<ResearchProject | null> {
  const project = await getResearchProject(owner, id);
  const outbox = await loadResearchOutbox(owner, id);
  if (!project) {
    if (!outbox) return null;
    await drainOrphanOutbox(owner, id, outbox);
    return null;
  }
  if (project.completion?.phase === "done") {
    if (outbox) await deleteResearchOutbox(owner, id);
    if (project.deleteRequested) {
      await deleteResearchProject(owner, id);
      return null;
    }
    return project;
  }
  if (!outbox) return project;

  let current = project;
  if (!current.completion || current.completion.phase === "page") {
    const committed = await commitResearchPage(owner, id, outbox);
    if (!committed?.completion || committed.completion.phase === "page") {
      return committed ?? getResearchProject(owner, id);
    }
    current = committed;
  }

    const completion = current.completion;
  if (!completion) return current;

  if (current.deleteRequested) {
    await deleteResearchOutbox(owner, id);
    await clearPageWrittenMarker(owner, id);
    await deleteResearchProject(owner, id);
    return null;
  }

  const byUrl = new Map(outbox.sources.map((source) => [source.url, source]));
  const nextSources: ResearchCompletionSource[] = [];
  for (const meta of completion.sources) {
    const fetched = byUrl.get(meta.url);
    nextSources.push(
      fetched
        ? await ingestOneSource(owner, id, fetched, meta, completion.wikiId ?? outbox.wikiId)
        : { ...meta, ingested: meta.ingested ?? false, error: meta.error ?? "Source body missing from outbox." },
    );
  }

  const updated = await mutateResearchProject(owner, id, (project) => {
    if (!project.completion) return null;
    const localByUrl = new Map(nextSources.map((source) => [source.url, source]));
    const sources = project.completion.sources.map((stored) => {
      const local = localByUrl.get(stored.url);
      if (!local) return stored;
      if (stored.ingested) {
        return { ...local, ...stored, ingested: true, error: undefined, jobId: stored.jobId ?? local.jobId };
      }
      return { ...stored, ...local, jobId: stored.jobId ?? local.jobId };
    });
    const failed = sources.filter((source) => !source.ingested);
    project.completion = {
      ...project.completion,
      phase: failed.length === 0 ? "done" : "sources",
      sources,
    };
    project.status = "complete";
    delete project.proposalId;
    if (failed.length === 0) {
      delete project.error;
      project.progress = {
        completedQueries: current.progress?.completedQueries ?? current.queries.length,
        totalQueries: current.progress?.totalQueries ?? current.queries.length,
        message: `Wrote ${completion.pageSlug}. Ingested ${sources.length} sources.`,
      };
    } else {
      project.error = `${failed.length} source${failed.length === 1 ? "" : "s"} did not ingest. The Page was written.`;
      project.progress = {
        completedQueries: current.progress?.completedQueries ?? current.queries.length,
        totalQueries: current.progress?.totalQueries ?? current.queries.length,
        message: `Wrote ${completion.pageSlug}. ${failed.length} source ingest(s) still pending.`,
      };
    }
    return project;
  });

  const done = updated?.completion?.phase === "done";
  if (done) {
    await clearResearchStaging(outbox.sources);
    await deleteResearchOutbox(owner, id);
    await clearPageWrittenMarker(owner, id);
    if (updated.deleteRequested || current.deleteRequested) {
      await deleteResearchProject(owner, id);
    }
  }
  return updated ?? getResearchProject(owner, id);
}

async function drainOrphanOutbox(
  owner: string,
  id: string,
  outbox: ResearchOutbox,
): Promise<void> {
  if (outbox.claimed !== true) {
    await deleteResearchOutbox(owner, id);
    return;
  }
  const claimPath = `${outboxPath(owner, id)}.writing`;
  if (!await claimOrphanWrite(owner, claimPath)) return;
  const stopHeartbeat = startOrphanClaimHeartbeat(claimPath);
  try {
    const writtenPath = `${outboxPath(owner, id)}.page-written`;
    try {
      await getStorage().readFile(writtenPath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
      await writeResearchPage(owner, outbox);
      await getStorage().writeFile(writtenPath, JSON.stringify({ at: new Date().toISOString() }));
    }
    const sources = await completionSourcesFromOutbox(outbox);
    let failed = 0;
    for (const meta of sources) {
      const fetched = outbox.sources.find((source) => source.url === meta.url);
      if (!fetched) {
        failed += 1;
        continue;
      }
      try {
        await dispatchSourceIngest(owner, id, fetched, meta, outbox.wikiId);
      } catch (error) {
        failed += 1;
        logger.warn("research", `orphan source ingest skipped for ${meta.url}`, error);
      }
    }
    if (failed === 0) {
      await clearResearchStaging(outbox.sources);
      await deleteResearchOutbox(owner, id);
      try {
        await getStorage().deleteFile(`${outboxPath(owner, id)}.page-written`);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
    }
  } finally {
    stopHeartbeat();
    try {
      await getStorage().deleteFile(claimPath);
    } catch (error) {
      if (!isEnoent(error)) throw error;
    }
  }
}

function startOrphanClaimHeartbeat(claimPath: string): () => void {
  const timer = setInterval(() => {
    void (async () => {
      try {
        const read = await getStorage().readFileWithEtag(claimPath);
        await getStorage().writeFileIfMatch(
          claimPath,
          JSON.stringify({ at: new Date().toISOString() }),
          read.etag,
        );
      } catch {
        // The write finished or another isolate stole the claim.
      }
    })();
  }, RESEARCH_PAGE_WRITE_HEARTBEAT_MS);
  return () => clearInterval(timer);
}

async function claimOrphanWrite(owner: string, claimPath: string): Promise<boolean> {
  const storage = getStorage();
  const body = JSON.stringify({ at: new Date().toISOString(), owner });
  try {
    const read = await storage.readFileWithEtag(claimPath);
    let claimedAt: string | undefined;
    try {
      const parsed = JSON.parse(read.content) as { at?: unknown };
      claimedAt = typeof parsed.at === "string" ? parsed.at : undefined;
    } catch {
      claimedAt = undefined;
    }
    if (researchWriteClaimIsFresh(claimedAt)) return false;
    return storage.writeFileIfMatch(claimPath, body, read.etag);
  } catch (error) {
    if (!isEnoent(error)) throw error;
    return storage.writeFileIfAbsent(claimPath, body);
  }
}

export { researchPageSlug };

export function evidenceFromFetched(
  sources: readonly FetchedSource[],
  results: readonly ResearchProjectResult[],
): Array<{ url: string; title: string; snippet?: string; query?: string }> {
  const byUrl = new Map(results.map((result) => [result.url, result]));
  return sources.map((source) => {
    const result = byUrl.get(source.url);
    return {
      url: source.url,
      title: source.title,
      ...(result?.snippet ? { snippet: result.snippet } : {}),
      ...(result?.query ? { query: result.query } : {}),
    };
  });
}
