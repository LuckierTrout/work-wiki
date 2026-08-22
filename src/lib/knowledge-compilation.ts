import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { serializeFrontmatter } from "./frontmatter";
import { callLLM, hasLLMKey } from "./llm";
import { withFileLock } from "./lock";
import { createMemoryChangeProposal } from "./memory-proposals";
import { buildContext, selectPagesForQuery } from "./query";
import { parseSources } from "./sources";
import { buildSourceEntry, serializeSources } from "./sources";
import { getStorage } from "./storage";
import { getStructuredKnowledge } from "./structured-knowledge";
import { slugify } from "./slugify";
import {
  listReadableWikiPages,
  readWikiPageWithFrontmatter,
  tenantForOwner,
  validateSlug,
  validateTenant,
} from "./wiki";

export type KnowledgeCompilationStatus = "processing" | "complete" | "failed";

export interface SourceContribution {
  id: string;
  sourceUrl: string;
  sourceType: string;
  rawId?: string;
  pageSlug: string;
  pageContentHash: string;
  structuredRecordIds: string[];
  structuredRelationIds: string[];
  observedAt: string;
}

export interface KnowledgeCompilationRun {
  version: 1;
  id: string;
  owner: string;
  pageSlug: string;
  inputHash: string;
  status: KnowledgeCompilationStatus;
  pass1: {
    contributionIds: string[];
    recordIds: string[];
    relationIds: string[];
  };
  pass2: {
    relatedSlugs: string[];
    proposalId?: string;
    proposalIds: string[];
    changed: boolean;
  };
  createdAt: string;
  updatedAt: string;
  error?: string;
}

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function runPath(owner: string, slug: string): string {
  validateSlug(slug);
  return `tenants/${tenant(owner)}/knowledge-compilation/${slug}.json`;
}

function contributionPath(owner: string): string {
  return `tenants/${tenant(owner)}/knowledge-contributions.json`;
}

async function readRun(owner: string, slug: string): Promise<KnowledgeCompilationRun | null> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(runPath(owner, slug))) as KnowledgeCompilationRun & {
      pass2?: KnowledgeCompilationRun["pass2"] & { proposalIds?: string[] };
    };
    if (!parsed.pass2) return null;
    return {
      ...parsed,
      pass2: {
        ...parsed.pass2,
        proposalIds: parsed.pass2.proposalIds
          ?? (parsed.pass2.proposalId ? [parsed.pass2.proposalId] : []),
      },
    };
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readContributions(owner: string): Promise<SourceContribution[]> {
  try {
    const value = JSON.parse(await getStorage().readFile(contributionPath(owner)));
    return Array.isArray(value) ? value as SourceContribution[] : [];
  } catch (error) {
    if (isEnoent(error)) return [];
    throw error;
  }
}

export async function listSourceContributions(owner: string): Promise<SourceContribution[]> {
  return (await readContributions(owner)).sort((a, b) => b.observedAt.localeCompare(a.observedAt));
}

export async function getKnowledgeCompilation(
  owner: string,
  slug: string,
): Promise<KnowledgeCompilationRun | null> {
  return readRun(owner, slug);
}

function cleanCompiledBody(raw: string): string {
  let body = raw.trim()
    .replace(/^```(?:markdown|md)?\s*/i, "")
    .replace(/\s*```$/, "")
    .trim();
  // The model is asked for a body only. If it echoes frontmatter anyway, drop
  // it so the trusted current frontmatter remains authoritative.
  body = body.replace(/^---\n[\s\S]*?\n---\n?/, "").trim();
  return body;
}

function recordSlug(kind: string, name: string, id: string): string {
  const named = slugify(name);
  return `${kind}-${named || id.replace(/^kr_/, "").slice(0, 16)}`.slice(0, 220);
}

function recordPageContent(
  owner: string,
  source: { slug: string; title: string },
  record: Awaited<ReturnType<typeof getStructuredKnowledge>>["records"][number],
  graph: Awaited<ReturnType<typeof getStructuredKnowledge>>,
): string {
  const today = new Date().toISOString().slice(0, 10);
  const byId = new Map(graph.records.map((item) => [item.id, item]));
  const relationships = graph.relations
    .filter((relation) => relation.sourceSlugs.includes(source.slug) && (relation.fromId === record.id || relation.toId === record.id))
    .slice(0, 20)
    .flatMap((relation) => {
      const outbound = relation.fromId === record.id;
      const other = byId.get(outbound ? relation.toId : relation.fromId);
      if (!other) return [];
      const target = recordSlug(other.kind, other.name, other.id);
      return [`- ${outbound ? "**" + relation.type + "**" : `**${relation.type} from**`} [${other.name}](${target}.md)`];
    });
  const details = [
    record.status ? `- **Status:** ${record.status}` : "",
    record.validFrom ? `- **Valid from:** ${record.validFrom}` : "",
    record.validTo ? `- **Valid to:** ${record.validTo}` : "",
  ].filter(Boolean);
  const body = [
    `# ${record.name}`,
    "",
    record.summary,
    details.length ? "\n## Details\n\n" + details.join("\n") : "",
    relationships.length ? "\n## Relationships\n\n" + relationships.join("\n") : "",
    `\n## Source page\n\n- [${source.title}](${source.slug}.md)`,
  ].filter(Boolean).join("\n");
  return serializeFrontmatter({
    created: today,
    updated: today,
    owner,
    visibility: "private",
    authors: ["knowledge-compiler"],
    contributors: [],
    tags: [record.kind, "compiled-knowledge"],
    type: record.kind,
    sources: serializeSources([buildSourceEntry(`wiki:${source.slug}`, "wiki-ref", owner)]),
    confidence: 0.7,
    disputed: false,
    supersedes: "",
    aliases: [],
    valid_from: record.validFrom ?? today,
  }, body);
}

/**
 * Pass 1 records exactly which raw sources contributed to derived knowledge.
 * Pass 2 compares the newly accepted page with related owner pages and creates
 * a review proposal for a consolidated canonical body. It never writes a wiki
 * page directly.
 */
export async function compileKnowledgePage(
  owner: string,
  slug: string,
): Promise<KnowledgeCompilationRun> {
  validateSlug(slug);
  return withFileLock(`knowledge-compilation:${tenant(owner)}:${slug}`, async () => {
    const page = await readWikiPageWithFrontmatter(slug);
    if (!page || tenantForOwner(String(page.frontmatter.owner ?? "")) !== tenant(owner)) {
      throw new Error("Owner page not found");
    }
    const graph = await getStructuredKnowledge(owner);
    const records = graph.records.filter((record) => record.sourceSlugs.includes(slug));
    const relations = graph.relations.filter((relation) => relation.sourceSlugs.includes(slug));
    const ownerEntries = (await listReadableWikiPages({
      id: `knowledge-compiler:${tenant(owner)}`,
      handle: owner,
    })).filter((entry) => tenantForOwner(entry.owner) === tenant(owner));
    const query = `${page.title}\n${page.body.slice(0, 4_000)}`;
    const selected = (await selectPagesForQuery(query, ownerEntries))
      .filter((candidate) => candidate !== slug)
      .slice(0, 6);
    const relatedPages = (await Promise.all(
      // Wrapped rather than passed point-free: `readWikiPageWithFrontmatter`
      // now takes an options object as its second parameter, and `map` would
      // hand it the array INDEX.
      selected.map((candidate) => readWikiPageWithFrontmatter(candidate)),
    ))
      .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate));
    const inputHash = contentHash([
      page.content,
      ...relatedPages.map((candidate) => `${candidate.slug}:${contentHash(candidate.content)}`),
      ...records.map((record) => `${record.id}:${record.updatedAt}`),
      ...relations.map((relation) => `${relation.id}:${relation.updatedAt}`),
    ].join("\n"));
    const prior = await readRun(owner, slug);
    if (prior?.inputHash === inputHash && prior.status === "complete") return prior;

    const now = new Date().toISOString();
    const sources = parseSources(page.frontmatter.sources as string | string[] | undefined);
    const contributionIds = sources.map((source) => `kc_${contentHash([
      slug,
      source.url,
      source.raw_id ?? "",
      contentHash(page.content),
    ].join(":"))}`);
    const run: KnowledgeCompilationRun = {
      version: 1,
      id: `kcr_${crypto.randomUUID()}`,
      owner,
      pageSlug: slug,
      inputHash,
      status: "processing",
      pass1: {
        contributionIds,
        recordIds: records.map((record) => record.id),
        relationIds: relations.map((relation) => relation.id),
      },
      pass2: { relatedSlugs: relatedPages.map((candidate) => candidate.slug), proposalIds: [], changed: false },
      createdAt: now,
      updatedAt: now,
    };
    await getStorage().writeFile(runPath(owner, slug), JSON.stringify(run, null, 2));

    try {
      // A compilation run is the current contribution state for this page.
      // Remove stale source rows from a prior re-ingest while preserving rows
      // contributed by every other page.
      const existingContributions = (await readContributions(owner))
        .filter((contribution) => contribution.pageSlug !== slug);
      const byId = new Map(existingContributions.map((contribution) => [contribution.id, contribution]));
      sources.forEach((source, index) => {
        byId.set(contributionIds[index], {
          id: contributionIds[index],
          sourceUrl: source.url,
          sourceType: source.type,
          ...(source.raw_id ? { rawId: source.raw_id } : {}),
          pageSlug: slug,
          pageContentHash: contentHash(page.content),
          structuredRecordIds: records.map((record) => record.id),
          structuredRelationIds: relations.map((relation) => relation.id),
          observedAt: now,
        });
      });
      await getStorage().writeFile(
        contributionPath(owner),
        JSON.stringify([...byId.values()].slice(-10_000), null, 2),
      );

      // Materialize missing structured objects as separate, reviewable pages.
      // Existing pages are left alone here; the target consolidation below is
      // the safer place to reconcile overlapping accepted knowledge.
      for (const record of records.slice(0, 12)) {
        const targetSlug = recordSlug(record.kind, record.name, record.id);
        if (targetSlug === slug || await readWikiPageWithFrontmatter(targetSlug)) continue;
        const proposal = await createMemoryChangeProposal(owner, {
          targetSlug,
          title: `Create ${record.kind}: ${record.name}`,
          summary: `A ${record.kind} page derived from ${page.title}.`,
          reason: "The first compilation pass found a structured object that does not yet have its own wiki page. Review before creating it.",
          proposedContent: recordPageContent(owner, page, record, graph),
          evidenceIds: record.evidenceIds,
          actor: "knowledge-compiler",
          risk: "medium",
        });
        run.pass2.proposalIds.push(proposal.id);
        run.pass2.changed = true;
      }

      if (hasLLMKey() && relatedPages.length > 0) {
        const { context } = await buildContext(relatedPages.map((candidate) => candidate.slug));
        const output = cleanCompiledBody(await callLLM(
          "You are the second-pass compiler for a private, evidence-first wiki. Return the complete replacement MARKDOWN BODY for the target page and nothing else. Reconcile only facts supported by the target or related-page context. Preserve the target H1, useful detail, internal markdown links, uncertainty, dates, and source distinctions. Do not invent facts, erase conflicts, include YAML frontmatter, or claim actions were completed.",
          `# Target page\n\n${page.body}\n\n# Related owner knowledge\n\n${context}`,
          { maxOutputTokens: 6_000 },
        ));
        if (output && contentHash(output) !== contentHash(page.body)) {
          const proposal = await createMemoryChangeProposal(owner, {
            targetSlug: slug,
            title: `Compile ${page.title}`,
            summary: "Second-pass consolidation with related owner knowledge.",
            reason: `New source contribution was compared with ${relatedPages.length} related page${relatedPages.length === 1 ? "" : "s"}. Review before applying.`,
            proposedContent: serializeFrontmatter(page.frontmatter, output),
            evidenceIds: records.flatMap((record) => record.evidenceIds),
            actor: "knowledge-compiler",
            risk: "medium",
          });
          run.pass2.proposalId = proposal.id;
          run.pass2.proposalIds.push(proposal.id);
          run.pass2.changed = true;
        }
      }
      run.status = "complete";
      run.updatedAt = new Date().toISOString();
      await getStorage().writeFile(runPath(owner, slug), JSON.stringify(run, null, 2));
      return run;
    } catch (error) {
      run.status = "failed";
      run.error = error instanceof Error ? error.message.slice(0, 2_000) : String(error).slice(0, 2_000);
      run.updatedAt = new Date().toISOString();
      await getStorage().writeFile(runPath(owner, slug), JSON.stringify(run, null, 2));
      throw error;
    }
  });
}
