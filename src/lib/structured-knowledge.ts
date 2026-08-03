import { generateText, Output } from "ai";
import { z } from "zod";
import { contentHash } from "./embeddings";
import { isEnoent } from "./errors";
import { buildEvidenceAnchor, buildClaimEvidence, getPageEvidence, savePageEvidence } from "./evidence";
import { parseFrontmatter } from "./frontmatter";
import { getConfiguredModel, hasLLMKey, retryWithBackoff } from "./llm";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, tenantWikiRelPath, validateSlug, validateTenant } from "./wiki";

export type KnowledgeKind =
  | "person"
  | "organization"
  | "project"
  | "decision"
  | "commitment"
  | "risk"
  | "event";

export interface KnowledgeRecord {
  id: string;
  owner: string;
  kind: KnowledgeKind;
  name: string;
  summary: string;
  status?: string;
  validFrom?: string;
  validTo?: string;
  sourceSlugs: string[];
  evidenceIds: string[];
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeRelation {
  id: string;
  owner: string;
  fromId: string;
  toId: string;
  type: string;
  sourceSlugs: string[];
  evidenceIds: string[];
  validFrom?: string;
  validTo?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StructuredKnowledgeGraph {
  version: 1;
  owner: string;
  records: KnowledgeRecord[];
  relations: KnowledgeRelation[];
  updatedAt: string;
}

export interface KnowledgeRecordInput {
  kind: KnowledgeKind;
  name: string;
  summary: string;
  status?: string;
  validFrom?: string;
  validTo?: string;
  sourceSlug: string;
  evidenceIds?: string[];
}

export interface KnowledgeRelationInput {
  fromKind: KnowledgeKind;
  fromName: string;
  toKind: KnowledgeKind;
  toName: string;
  type: string;
  sourceSlug: string;
  evidenceIds?: string[];
  validFrom?: string;
  validTo?: string;
}

const MAX_RECORDS = 5_000;
const MAX_RELATIONS = 10_000;

const extractionSchema = z.object({
  records: z.array(z.object({
    kind: z.enum(["person", "organization", "project", "decision", "commitment", "risk", "event"]),
    name: z.string().min(1).max(240),
    summary: z.string().min(1).max(1_500),
    status: z.string().max(120).optional(),
    validFrom: z.string().max(40).optional(),
    validTo: z.string().max(40).optional(),
    evidenceExcerpt: z.string().min(1).max(2_000),
  })).max(100),
  relations: z.array(z.object({
    fromKind: z.enum(["person", "organization", "project", "decision", "commitment", "risk", "event"]),
    fromName: z.string().min(1).max(240),
    toKind: z.enum(["person", "organization", "project", "decision", "commitment", "risk", "event"]),
    toName: z.string().min(1).max(240),
    type: z.string().min(1).max(120),
    validFrom: z.string().max(40).optional(),
    validTo: z.string().max(40).optional(),
    evidenceExcerpt: z.string().min(1).max(2_000),
  })).max(200),
});

function tenant(owner: string): string {
  const value = tenantForOwner(owner);
  validateTenant(value);
  return value;
}

function graphPath(owner: string): string {
  return `tenants/${tenant(owner)}/structured-knowledge.json`;
}

function graphLock(owner: string): string {
  return `structured-knowledge:${tenant(owner)}`;
}

function normalizedName(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

function recordId(kind: KnowledgeKind, name: string): string {
  return `kr_${contentHash(`${kind}:${normalizedName(name)}`)}`;
}

function relationId(fromId: string, type: string, toId: string): string {
  return `rel_${contentHash(`${fromId}:${normalizedName(type)}:${toId}`)}`;
}

async function readGraph(owner: string): Promise<StructuredKnowledgeGraph> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(graphPath(owner))) as StructuredKnowledgeGraph;
    if (parsed.version === 1 && tenant(parsed.owner) === tenant(owner)) return parsed;
  } catch (error) {
    if (!isEnoent(error)) throw error;
  }
  return { version: 1, owner, records: [], relations: [], updatedAt: new Date(0).toISOString() };
}

export async function getStructuredKnowledge(owner: string): Promise<StructuredKnowledgeGraph> {
  return readGraph(owner);
}

export async function listKnowledgeRecords(
  owner: string,
  kind?: KnowledgeKind,
): Promise<KnowledgeRecord[]> {
  return (await readGraph(owner)).records
    .filter((record) => !kind || record.kind === kind)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function upsertStructuredKnowledge(
  owner: string,
  records: readonly KnowledgeRecordInput[],
  relations: readonly KnowledgeRelationInput[] = [],
  now: Date = new Date(),
): Promise<StructuredKnowledgeGraph> {
  return withFileLock(graphLock(owner), async () => {
    const graph = await readGraph(owner);
    const timestamp = now.toISOString();
    const byId = new Map(graph.records.map((record) => [record.id, record]));

    for (const input of records) {
      validateSlug(input.sourceSlug);
      const name = input.name.trim().slice(0, 240);
      const summary = input.summary.trim().slice(0, 1_500);
      if (!name || !summary) throw new Error("Knowledge records require a name and summary");
      const id = recordId(input.kind, name);
      const existing = byId.get(id);
      byId.set(id, {
        id,
        owner,
        kind: input.kind,
        name,
        summary,
        ...(input.status?.trim() ? { status: input.status.trim().slice(0, 120) } : {}),
        ...(input.validFrom?.trim() ? { validFrom: input.validFrom.trim().slice(0, 40) } : {}),
        ...(input.validTo?.trim() ? { validTo: input.validTo.trim().slice(0, 40) } : {}),
        sourceSlugs: Array.from(new Set([...(existing?.sourceSlugs ?? []), input.sourceSlug])),
        evidenceIds: Array.from(new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])])),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }

    const relationMap = new Map(graph.relations.map((relation) => [relation.id, relation]));
    for (const input of relations) {
      validateSlug(input.sourceSlug);
      const fromId = recordId(input.fromKind, input.fromName);
      const toId = recordId(input.toKind, input.toName);
      if (!byId.has(fromId) || !byId.has(toId)) continue;
      const type = input.type.trim().slice(0, 120);
      if (!type) continue;
      const id = relationId(fromId, type, toId);
      const existing = relationMap.get(id);
      relationMap.set(id, {
        id,
        owner,
        fromId,
        toId,
        type,
        sourceSlugs: Array.from(new Set([...(existing?.sourceSlugs ?? []), input.sourceSlug])),
        evidenceIds: Array.from(new Set([...(existing?.evidenceIds ?? []), ...(input.evidenceIds ?? [])])),
        ...(input.validFrom?.trim() ? { validFrom: input.validFrom.trim().slice(0, 40) } : {}),
        ...(input.validTo?.trim() ? { validTo: input.validTo.trim().slice(0, 40) } : {}),
        createdAt: existing?.createdAt ?? timestamp,
        updatedAt: timestamp,
      });
    }

    graph.records = [...byId.values()].slice(-MAX_RECORDS);
    graph.relations = [...relationMap.values()].slice(-MAX_RELATIONS);
    graph.updatedAt = timestamp;
    await getStorage().writeFile(graphPath(owner), JSON.stringify(graph, null, 2));
    return graph;
  });
}

function findExcerptRange(content: string, excerpt: string): { start: number; end: number } {
  const exact = content.indexOf(excerpt);
  if (exact >= 0) return { start: exact, end: exact + excerpt.length };
  const needle = excerpt.slice(0, 80);
  const partial = content.indexOf(needle);
  return partial >= 0
    ? { start: partial, end: Math.min(content.length, partial + excerpt.length) }
    : { start: 0, end: Math.min(content.length, excerpt.length) };
}

export async function extractStructuredKnowledge(
  owner: string,
  slug: string,
): Promise<StructuredKnowledgeGraph> {
  if (!hasLLMKey()) return readGraph(owner);
  validateSlug(slug);
  const content = await getStorage().readFile(tenantWikiRelPath(tenant(owner), `${slug}.md`));
  const page = parseFrontmatter(content);
  if (typeof page.data.owner !== "string" || tenant(page.data.owner) !== tenant(owner)) {
    throw new Error("Only the page owner may extract structured knowledge");
  }
  const model = await getConfiguredModel();
  const { output } = await retryWithBackoff(() => generateText({
    model,
    output: Output.object({ schema: extractionSchema }),
    maxOutputTokens: 5_000,
    system:
      "Extract only explicit, useful knowledge objects and relationships from a private wiki page. Use people, organizations, projects, decisions, commitments, risks, and dated events. Preserve temporal language. Every item and relationship must include a short exact-or-close supporting excerpt from the page. Do not infer unsupported relationships.",
    prompt: `Page: ${slug}\n\n${page.body.slice(0, 80_000)}`,
  }));

  const anchors = new Map<string, ReturnType<typeof buildEvidenceAnchor>>();
  const evidenceForExcerpt = (excerpt: string) => {
    const anchor = buildEvidenceAnchor({
      source: { type: "wiki-ref", url: `wiki:${slug}` },
      location: { kind: "text-range", ...findExcerptRange(page.body, excerpt) },
      excerpt,
    });
    anchors.set(anchor.id, anchor);
    return anchor.id;
  };
  const recordInputs: KnowledgeRecordInput[] = output.records.map((record) => ({
    kind: record.kind,
    name: record.name,
    summary: record.summary,
    ...(record.status ? { status: record.status } : {}),
    ...(record.validFrom ? { validFrom: record.validFrom } : {}),
    ...(record.validTo ? { validTo: record.validTo } : {}),
    sourceSlug: slug,
    evidenceIds: [evidenceForExcerpt(record.evidenceExcerpt)],
  }));
  const relationInputs: KnowledgeRelationInput[] = output.relations.map((relation) => ({
    fromKind: relation.fromKind,
    fromName: relation.fromName,
    toKind: relation.toKind,
    toName: relation.toName,
    type: relation.type,
    sourceSlug: slug,
    ...(relation.validFrom ? { validFrom: relation.validFrom } : {}),
    ...(relation.validTo ? { validTo: relation.validTo } : {}),
    evidenceIds: [evidenceForExcerpt(relation.evidenceExcerpt)],
  }));

  const existing = await getPageEvidence(owner, slug);
  const pageHash = contentHash(content);
  const canMerge = existing?.pageContentHash === pageHash;
  const evidence = [...anchors.values()];
  const claims = recordInputs.map((record) => buildClaimEvidence({
    claim: `${record.name}: ${record.summary}`,
    relation: "supports",
    evidenceIds: record.evidenceIds ?? [],
  }));
  await savePageEvidence(owner, {
    pageSlug: slug,
    pageContentHash: pageHash,
    claims: [...(canMerge ? existing.claims : []), ...claims],
    evidence: [...(canMerge ? existing.evidence : []), ...evidence],
  });
  return upsertStructuredKnowledge(owner, recordInputs, relationInputs);
}
