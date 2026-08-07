import type { Principal } from "./auth";
import { canReadSlug } from "./authz";
import { listActionItems, type ActionItemStatus } from "./action-items";
import { mapWithConcurrency, READ_CONCURRENCY } from "./concurrency";
import { listDocumentSources } from "./document-sources";
import { getKnowledgeCompilation } from "./knowledge-compilation";
import { browsePageHref } from "./browse-explorer-view";
import {
  getMemoryChangeProposal,
  type MemoryProposalStatus,
} from "./memory-proposals";
import { isArtifactType } from "./page-types";
import {
  dedupeSourcesForDisplay,
  parseSources,
  sourceLabel,
} from "./sources";
import { getStructuredKnowledge } from "./structured-knowledge";
import {
  listReadableWikiPages,
  readWikiPageWithFrontmatter,
  tenantForOwner,
} from "./wiki";
import { rawPath } from "./links";

export interface DocumentLineageSource {
  type: string;
  label: string;
  fetched: string;
}

export interface DocumentLineageProposal {
  id: string;
  title: string;
  status: MemoryProposalStatus;
  targetSlug: string;
  risk: "low" | "medium" | "high";
}

export interface DocumentLineageTask {
  id: string;
  title: string;
  status: ActionItemStatus;
  assignee?: string;
  dueDate?: string;
}

export interface DocumentLineageArtifact {
  slug: string;
  title: string;
  type: "html" | "slides";
  href: string;
}

export interface DocumentLineage {
  slug: string;
  isArtifact: boolean;
  sources: {
    count: number;
    items: DocumentLineageSource[];
    originalFiles: string[];
    href: string | null;
  };
  knowledge: {
    records: number;
    relations: number;
    compilationStatus: "not-started" | "processing" | "complete" | "failed";
  };
  proposals: {
    total: number;
    pending: number;
    accepted: number;
    items: DocumentLineageProposal[];
  };
  tasks: {
    total: number;
    proposed: number;
    accepted: number;
    done: number;
    dismissed: number;
    items: DocumentLineageTask[];
  };
  artifacts: DocumentLineageArtifact[];
}

function referencesSlug(sourceUrl: string, slug: string): boolean {
  return sourceUrl
    .trim()
    .replace(/^wiki:/, "")
    .replace(/\.md$/, "") === slug;
}

/**
 * Resolve every owner-private output derived from one readable page. The page
 * read check is performed before owner stores are opened so a caller cannot use
 * lineage counts to probe a private slug.
 */
export async function getDocumentLineage(
  principal: Principal,
  slug: string,
): Promise<DocumentLineage | null> {
  if (!(await canReadSlug(slug, principal))) return null;

  const page = await readWikiPageWithFrontmatter(slug);
  if (!page) return null;

  const pageOwner =
    typeof page.frontmatter.owner === "string" && page.frontmatter.owner.trim()
      ? page.frontmatter.owner
      : principal.handle;
  const pageType =
    typeof page.frontmatter.type === "string" ? page.frontmatter.type : undefined;
  const isArtifact = isArtifactType(pageType);
  const sourceEntries = dedupeSourcesForDisplay(
    parseSources(
      page.frontmatter.sources as string | string[] | undefined,
    ),
  );

  const [graph, compilation, actionItems, readablePages, originalFiles] =
    await Promise.all([
      getStructuredKnowledge(principal.handle),
      getKnowledgeCompilation(principal.handle, slug),
      listActionItems(principal.handle),
      listReadableWikiPages(principal),
      listDocumentSources(slug, principal.handle).catch(() => []),
    ]);

  const records = graph.records.filter((record) =>
    record.sourceSlugs.includes(slug),
  );
  const relations = graph.relations.filter((relation) =>
    relation.sourceSlugs.includes(slug),
  );

  const proposalIds = compilation?.pass2.proposalIds ?? [];
  const proposalResults = await mapWithConcurrency(
    proposalIds,
    READ_CONCURRENCY,
    (id) => getMemoryChangeProposal(principal.handle, id),
  );
  const proposals = proposalResults
    .filter((proposal): proposal is NonNullable<typeof proposal> => Boolean(proposal))
    .map((proposal) => ({
      id: proposal.id,
      title: proposal.title,
      status: proposal.status,
      targetSlug: proposal.targetSlug,
      risk: proposal.risk,
    }));

  const tasks = actionItems
    .filter((item) => item.sourceSlug === slug)
    .map((item) => ({
      id: item.id,
      title: item.title,
      status: item.status,
      ...(item.assignee ? { assignee: item.assignee } : {}),
      ...(item.dueDate ? { dueDate: item.dueDate } : {}),
    }));

  const artifactEntries = readablePages.filter(
    (entry) => entry.slug !== slug && isArtifactType(entry.type),
  );
  const artifactPages = await mapWithConcurrency(
    artifactEntries,
    READ_CONCURRENCY,
    async (entry) => ({ entry, page: await readWikiPageWithFrontmatter(entry.slug) }),
  );
  const artifacts = artifactPages.flatMap(({ entry, page: artifactPage }) => {
    if (!artifactPage || !isArtifactType(entry.type)) return [];
    const citesSelectedPage = parseSources(
      artifactPage.frontmatter.sources as string | string[] | undefined,
    ).some(
      (source) =>
        source.type === "wiki-ref" && referencesSlug(source.url, slug),
    );
    if (!citesSelectedPage) return [];
    return [{
      slug: entry.slug,
      title: entry.title,
      type: entry.type as "html" | "slides",
      href: browsePageHref(entry),
    }];
  });

  const declaredSourceCount = Number(page.frontmatter.source_count ?? 0);
  const sourceCount = Math.max(
    Number.isFinite(declaredSourceCount) ? declaredSourceCount : 0,
    sourceEntries.length,
    originalFiles.length,
  );
  const hasRawSource = !isArtifact && sourceCount > 0;

  return {
    slug,
    isArtifact,
    sources: {
      count: sourceCount,
      items: sourceEntries.map((source) => ({
        type: source.type,
        label: sourceLabel(source),
        fetched: source.fetched,
      })),
      originalFiles: originalFiles.map((source) => source.filename),
      href: hasRawSource ? rawPath(tenantForOwner(pageOwner), slug) : null,
    },
    knowledge: {
      records: records.length,
      relations: relations.length,
      compilationStatus: compilation?.status ?? "not-started",
    },
    proposals: {
      total: proposals.length,
      pending: proposals.filter((proposal) => proposal.status === "pending").length,
      accepted: proposals.filter((proposal) => proposal.status === "accepted").length,
      items: proposals,
    },
    tasks: {
      total: tasks.length,
      proposed: tasks.filter((task) => task.status === "inbox").length,
      accepted: tasks.filter((task) => task.status === "accepted").length,
      done: tasks.filter((task) => task.status === "done").length,
      dismissed: tasks.filter((task) => task.status === "dismissed").length,
      items: tasks,
    },
    artifacts,
  };
}
