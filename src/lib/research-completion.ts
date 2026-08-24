import { serializeFrontmatter, type Frontmatter } from "./frontmatter";
import { isEnoent } from "./errors";
import { createIngestJobIfAbsent, getIngestJob } from "./ingest-jobs";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { logger } from "./logger";
import { saveRawSourceFor } from "./raw";
import {
  getResearchProject,
  mutateResearchProject,
  updateResearchProject,
  updateResearchProjectIf,
  type ResearchCompletion,
  type ResearchCompletionSource,
  type ResearchProject,
  type ResearchProjectResult,
} from "./research-projects";
import { researchPageSlug, researchSourceSlug } from "./research-slug";
import { sourceSha256 } from "./source-sha256";
import { buildSourceEntry, serializeSources } from "./sources";
import { getStorage } from "./storage";
import { enqueueTask } from "./tasks";
import { tenantForOwner, validateTenant } from "./wiki";

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
  text: string;
}

interface ResearchOutbox {
  pageSlug: string;
  wikiId?: string;
  title: string;
  synthesis: string;
  thinking: string[];
  sources: FetchedSource[];
  evidence: Array<{ url: string; title: string; snippet?: string; query?: string }>;
}

function outboxDir(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-outbox`;
}

function outboxPath(owner: string, id: string): string {
  return `${outboxDir(owner)}/${id}.json`;
}

export async function saveResearchOutbox(
  owner: string,
  id: string,
  outbox: ResearchOutbox,
): Promise<void> {
  await getStorage().writeFile(outboxPath(owner, id), JSON.stringify(outbox));
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
  const sources: ResearchCompletionSource[] = [];
  for (const source of outbox.sources) {
    const slug = researchSourceSlug(source.url);
    if (!slug) continue;
    sources.push({
      url: source.url,
      title: source.title,
      slug,
      sha: await sourceSha256(source.text),
    });
  }
  return sources;
}

/**
 * Persist the outbox and write the Page, or refuse if cancel won the claim.
 *
 * The cancel-versus-commit fence is a CAS on `completion.phase: "page"`.
 * Winning that transition owns the Page write. Cancel that lands afterwards
 * cannot unwind it; cancel that lands first makes this return null.
 */
export async function commitResearchPage(
  owner: string,
  id: string,
  outbox: ResearchOutbox,
): Promise<ResearchProject | null> {
  const existing = await getResearchProject(owner, id);
  if (!existing) return null;
  if (existing.cancelRequested || existing.status === "cancelled") return null;

  await saveResearchOutbox(owner, id, outbox);

  if (existing.completion?.phase === "sources" || existing.completion?.phase === "done") {
    return existing;
  }

  const sources = existing.completion?.sources?.length
    ? existing.completion.sources
    : await completionSourcesFromOutbox(outbox);

  if (!existing.completion) {
    const claimed = await updateResearchProjectIf(
      owner,
      id,
      (project) =>
        !project.cancelRequested
        && project.status !== "cancelled"
        && !project.completion,
      {
        completion: {
          phase: "page",
          pageSlug: outbox.pageSlug,
          ...(outbox.wikiId ? { wikiId: outbox.wikiId } : {}),
          sources,
        },
      },
    );
    if (!claimed) {
      const latest = await getResearchProject(owner, id);
      if (!latest || latest.cancelRequested || latest.status === "cancelled") return null;
      if (latest.completion?.phase === "sources" || latest.completion?.phase === "done") {
        return latest;
      }
      if (latest.completion?.phase !== "page") return null;
    }
  }

  const body = serializeFrontmatter(
    researchFrontmatter(owner, outbox.evidence, outbox.wikiId),
    outbox.synthesis,
  );
  await writeWikiPageWithSideEffects({
    slug: outbox.pageSlug,
    title: outbox.title,
    content: body,
    summary: `Research brief from ${outbox.sources.length} web sources.`,
    logOp: "other",
    author: "research-agent",
    crossRefSource: outbox.synthesis,
    logDetails: ({ updatedSlugs }) =>
      `Deep Research wrote ${outbox.pageSlug} from ${outbox.sources.length} sources${
        updatedSlugs.length > 0 ? `; cross-linked ${updatedSlugs.join(", ")}` : ""
      }.`,
  });

  const latest = await getResearchProject(owner, id);
  return updateResearchProjectIf(
    owner,
    id,
    (project) => project.completion?.phase === "page",
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
  source: FetchedSource,
  meta: ResearchCompletionSource,
  wikiId?: string,
): Promise<ResearchCompletionSource> {
  if (meta.ingested) return meta;
  const jobId = meta.jobId ?? await researchIngestJobId(projectId, meta.slug, meta.sha);
  const claimed = await checkpointSource(owner, projectId, source.url, { jobId });
  const current = claimed ?? { ...meta, jobId };
  if (current.ingested) return current;
  try {
    await saveRawSourceFor(current.slug, current.sha, source.text, { owner });
    const sourcePath = `raw/sources/${current.slug}/${current.sha}.md`;
    const existingJob = await getIngestJob(jobId);
    if (!existingJob) {
      const minted = await createIngestJobIfAbsent({
        jobId,
        owner,
        title: source.title || source.url,
        url: source.url,
        sourceType: "url",
        contentSha256: current.sha,
        ...(wikiId ? { wikiId } : {}),
      });
      if (minted.created) {
        const title = source.title || source.url;
        const enqueued = await enqueueTask({
          kind: "ingest",
          title,
          content: source.text,
          owner,
          author: owner,
          triggeredBy: owner,
          tags: wikiId ? ["research", `wiki:${wikiId}`] : ["research"],
          jobId,
          sourceType: "url",
          sourceUrl: source.url,
          sourcePath,
          contentSha256: current.sha,
        });
        if (!enqueued) {
          const { ingest } = await import("./ingest");
          await ingest(title, source.text, {
            owner,
            author: owner,
            triggeredBy: owner,
            tags: wikiId ? ["research", `wiki:${wikiId}`] : ["research"],
            sourceType: "url",
            sourceUrl: source.url,
            sourcePath,
            contentSha256: current.sha,
            jobId,
          });
        }
      }
    }
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
  if (!project) return null;
  const outbox = await loadResearchOutbox(owner, id);
  if (!outbox) {
    if (project.completion?.phase === "done" || project.status === "complete") return project;
    return project;
  }

  let current = project;
  if (!current.completion || current.completion.phase === "page") {
    const committed = await commitResearchPage(owner, id, outbox);
    if (!committed) return getResearchProject(owner, id);
    current = committed;
  }

  const completion = current.completion;
  if (!completion) return current;

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

  const failed = nextSources.filter((source) => !source.ingested);
  const next: ResearchCompletion = {
    ...completion,
    phase: failed.length === 0 ? "done" : "sources",
    sources: nextSources,
  };

  if (failed.length === 0) {
    return updateResearchProject(owner, id, {
      status: "complete",
      completion: next,
      proposalId: null,
      error: null,
      progress: {
        completedQueries: current.progress?.completedQueries ?? current.queries.length,
        totalQueries: current.progress?.totalQueries ?? current.queries.length,
        message: `Wrote ${completion.pageSlug}. Ingested ${nextSources.length} sources.`,
      },
    });
  }

  return updateResearchProject(owner, id, {
    status: "complete",
    completion: next,
    error: `${failed.length} source${failed.length === 1 ? "" : "s"} did not ingest. The Page was written.`,
    progress: {
      completedQueries: current.progress?.completedQueries ?? current.queries.length,
      totalQueries: current.progress?.totalQueries ?? current.queries.length,
      message: `Wrote ${completion.pageSlug}. ${failed.length} source ingest(s) still pending.`,
    },
  });
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
