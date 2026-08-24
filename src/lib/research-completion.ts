import { serializeFrontmatter, type Frontmatter } from "./frontmatter";
import { isEnoent } from "./errors";
import { createIngestJob } from "./ingest-jobs";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { logger } from "./logger";
import { saveRawSourceFor } from "./raw";
import {
  getResearchProject,
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
 * the operation that makes them exist: persist an outbox, write the Page,
 * store each Source, enqueue Ingest, then mark `complete`. Every step is
 * idempotent so a crash between any two can be retried from the panel poll.
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

function outboxPath(owner: string, id: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-outbox/${id}.json`;
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

/**
 * Persist the outbox and write the Page, or refuse if the project was
 * cancelled or deleted after the last check.
 *
 * The cancel-versus-commit fence is the predicate: if `cancelRequested` is
 * already set, this returns null and writes nothing. A second call with the
 * same outbox is a no-op write of the same slug.
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

  const latest = await getResearchProject(owner, id);
  if (!latest || latest.cancelRequested || latest.status === "cancelled") return null;

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

  return updateResearchProjectIf(
    owner,
    id,
    (project) => !project.cancelRequested && project.status !== "cancelled",
    {
      completion: {
        phase: "sources",
        pageSlug: outbox.pageSlug,
        ...(outbox.wikiId ? { wikiId: outbox.wikiId } : {}),
        sources,
      },
      pageSlugs: [...new Set([...latest.pageSlugs, outbox.pageSlug])],
      synthesis: outbox.synthesis,
      ...(outbox.thinking.length > 0 ? { thinking: outbox.thinking } : {}),
      progress: {
        completedQueries: latest.progress?.totalQueries ?? latest.queries.length,
        totalQueries: latest.progress?.totalQueries ?? latest.queries.length,
        message: `Wrote ${outbox.pageSlug}. Ingesting ${sources.length} sources.`,
      },
    },
  );
}

async function ingestOneSource(
  owner: string,
  source: FetchedSource,
  meta: ResearchCompletionSource,
  wikiId?: string,
): Promise<ResearchCompletionSource> {
  if (meta.ingested) return meta;
  try {
    await saveRawSourceFor(meta.slug, meta.sha, source.text, { owner });
    const sourcePath = `raw/sources/${meta.slug}/${meta.sha}.md`;
    const jobId = meta.jobId ?? crypto.randomUUID();
    const title = source.title || source.url;
    await createIngestJob({
      jobId,
      owner,
      title,
      url: source.url,
      sourceType: "url",
      contentSha256: meta.sha,
      ...(wikiId ? { wikiId } : {}),
    });
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
      contentSha256: meta.sha,
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
        contentSha256: meta.sha,
        jobId,
      });
    }
    return { ...meta, jobId, ingested: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("research", `source ingest skipped for ${source.url}`, error);
    return { ...meta, ingested: false, error: message };
  }
}

/**
 * Drain a persisted outbox: store Sources and enqueue Ingest, then `complete`.
 *
 * Safe to call on a project that is already `complete` — remaining sources
 * retry, already-ingested ones skip. Does not rewrite the Page.
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
        ? await ingestOneSource(owner, fetched, meta, completion.wikiId ?? outbox.wikiId)
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
