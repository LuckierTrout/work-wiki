/**
 * Epic 3 retrieval pipeline shared by Chat assemble and Search hits.
 *
 * Do not call `selectPagesForQuery` from here: that helper stuffs small wikis
 * and falls back to first-N on a miss, which forbids honest no-coverage.
 */

import { tokenize } from "./bm25";
import {
  CHAT_HISTORY_BUDGET_RATIO,
  CHAT_HISTORY_DEPTH_DEFAULT,
  CHAT_INDEX_BUDGET_RATIO,
  CHAT_PAGE_BUDGET_RATIO,
  CHAT_SYSTEM_BUDGET_RATIO,
  CHAT_TOKEN_BUDGET_DEFAULT,
  clampHistoryDepth,
  clampTokenBudget,
  estimateTokens,
  type ChatCitation,
  type SearchHit,
} from "./chat-contract";
import {
  getChatModelSettings,
  getCustomBaseUrl,
  getOllamaBaseUrl,
  getVectorSearchSettings,
  loadConfigSync,
} from "./config";
import { extractBestSnippet } from "./query-search";
import { searchByVector } from "./embeddings";
import { parseFrontmatter } from "./frontmatter";
import { buildWeightedGraphEdges, expandGraphSeeds } from "./graph-relevance";
import { logger } from "./logger";
import { listRawSources, listRawSourceSnapshots, readRawSource, readRawSourceById } from "./raw";
import { loadPageConventions } from "./schema";
import { parseSources } from "./sources";
import type { IndexEntry } from "./types";
import { CHAT_COVERAGE_MISSING_COPY, CHAT_VECTOR_FALLBACK_COPY } from "./workbench-modes";
import { extractAllInternalTargets } from "./links";
import {
  isArtifactType,
  listReadableWikiPages,
  readWikiPage,
} from "./wiki";
import type { Principal } from "./auth";

type RetrievalMode = "wiki" | "sources";

/** Additive title bonus vs a body-only hit with the same token overlap. */
export const TITLE_MATCH_BONUS = 10;

const SPECIAL_SLUGS = new Set(["purpose", "index"]);
const DEFAULT_SEARCH_TOP_K = 10;
const DEFAULT_SEED_LIMIT = 24;
const PAGE_READ_CONCURRENCY = 8;
export type RetrieveDocKind = "page" | "source" | "purpose" | "index";

export interface RetrieveDocument {
  id: string;
  path: string;
  title: string;
  body: string;
  kind: RetrieveDocKind;
  type: string;
  slug?: string;
  sourceUrls?: string[];
}

export interface RetrieveHit {
  id: string;
  path: string;
  title: string;
  score: number;
  kind: RetrieveDocKind;
  type: string;
  body: string;
  snippet: string;
}

export type VectorPhase =
  | { status: "off" }
  | { status: "ok" }
  | { status: "failed"; message: string };

export interface TokenUsage {
  pages: number;
  history: number;
  index: number;
  system: number;
  total: number;
  budget: number;
}

export interface AssembleHistoryMessage {
  role: "user" | "assistant";
  content: string;
}

export interface AssembleOptions {
  principal: Principal | null;
  retrievalMode?: RetrievalMode;
  tokenBudget?: number;
  historyDepth?: number;
  history?: readonly AssembleHistoryMessage[];
  topK?: number;
}

export interface AssembledContext {
  hits: RetrieveHit[];
  citations: ChatCitation[];
  numberedBodies: string;
  systemPrompt: string;
  indexSlice: string;
  historySlice: AssembleHistoryMessage[];
  tokenUsage: TokenUsage;
  coverage: boolean;
  coverageMessage: string | null;
  vectorPhase: VectorPhase;
  chatModel: {
    provider: string | null;
    model: string | null;
    configured: boolean;
    baseUrl?: string;
  };
}

export interface SearchRetrieveResult {
  hits: SearchHit[];
  vectorPhase: VectorPhase;
}

async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const out = new Array<R>(items.length);
  let cursor = 0;
  async function worker() {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      out[index] = await mapper(items[index], index);
    }
  }
  await Promise.all(
    Array.from(
      { length: Math.min(Math.max(1, limit), items.length) },
      () => worker(),
    ),
  );
  return out;
}

export function scoreRetrieveDocument(
  queryTokens: readonly string[],
  title: string,
  body: string,
): number {
  if (queryTokens.length === 0) return 0;
  const bodySet = new Set(tokenize(body));
  const titleSet = new Set(tokenize(title));
  let bodyScore = 0;
  for (const term of queryTokens) {
    if (bodySet.has(term)) bodyScore += 1;
  }
  const titleHit = queryTokens.some((term) => titleSet.has(term));
  if (bodyScore === 0 && !titleHit) return 0;
  return bodyScore + (titleHit ? TITLE_MATCH_BONUS : 0);
}

async function loadPurposeAndIndex(): Promise<{
  purpose: RetrieveDocument | null;
  index: RetrieveDocument | null;
}> {
  const purposePage = await readWikiPage("purpose");
  const indexPage = await readWikiPage("index");
  return {
    purpose: purposePage
      ? {
          id: "purpose",
          path: "wiki/purpose.md",
          title: purposePage.title || "purpose",
          body: purposePage.content,
          kind: "purpose",
          type: "purpose",
          slug: "purpose",
        }
      : null,
    index: indexPage
      ? {
          id: "index",
          path: "wiki/index.md",
          title: indexPage.title || "index",
          body: indexPage.content,
          kind: "index",
          type: "index",
          slug: "index",
        }
      : null,
  };
}

export async function loadRetrieveDocuments(
  principal: Principal | null,
  retrievalMode: RetrievalMode = "wiki",
): Promise<{
  candidates: RetrieveDocument[];
  purpose: RetrieveDocument | null;
  index: RetrieveDocument | null;
  entries: IndexEntry[];
}> {
  const entries = (await listReadableWikiPages(principal)).filter(
    (entry) => !isArtifactType(entry.type),
  );
  const { purpose, index } = await loadPurposeAndIndex();

  const pageEntries = entries.filter((entry) => !SPECIAL_SLUGS.has(entry.slug));
  const pages: RetrieveDocument[] = [];
  if (retrievalMode !== "sources") {
    const loaded = await mapPool(pageEntries, PAGE_READ_CONCURRENCY, async (entry) => {
      const page = await readWikiPage(entry.slug);
      if (!page) return null;
      let parsed: ReturnType<typeof parseFrontmatter>;
      try {
        parsed = parseFrontmatter(page.content);
      } catch {
        parsed = { data: {}, body: page.content };
      }
      const doc: RetrieveDocument = {
        id: entry.slug,
        path: `wiki/${entry.slug}.md`,
        title: entry.title || entry.slug,
        body: page.content,
        kind: "page",
        type: entry.type || "page",
        slug: entry.slug,
        sourceUrls: parseSources(
          parsed.data.sources as string | string[] | undefined,
        ).map((source) => source.url),
      };
      return doc;
    });
    for (const doc of loaded) {
      if (doc) pages.push(doc);
    }
  }

  const sources: RetrieveDocument[] = [];
  try {
    const raw = await listRawSources();
    for (const source of raw) {
      try {
        const loaded = await readRawSource(source.slug);
        sources.push({
          id: `source:${source.slug}`,
          path: `raw/sources/${source.filename}`,
          title: source.slug,
          body: loaded.content,
          kind: "source",
          type: "source",
        });
      } catch (error) {
        logger.warn("retrieve", `raw source read failed for ${source.slug}`, error);
      }
    }
  } catch (error) {
    logger.warn("retrieve", "listRawSources failed", error);
  }
  try {
    const snapshots = await listRawSourceSnapshots();
    for (const snapshot of snapshots) {
      try {
        const loaded = await readRawSourceById(snapshot.slug, snapshot.rawId);
        sources.push({
          id: `source:${snapshot.slug}:${snapshot.rawId}`,
          path: snapshot.path,
          title: snapshot.slug,
          body: loaded.content,
          kind: "source",
          type: "source",
        });
      } catch (error) {
        logger.warn(
          "retrieve",
          `raw snapshot read failed for ${snapshot.slug}/${snapshot.rawId}`,
          error,
        );
      }
    }
  } catch (error) {
    logger.warn("retrieve", "listRawSourceSnapshots failed", error);
  }

  const candidates =
    retrievalMode === "sources" ? sources : [...pages, ...sources];
  return { candidates, purpose, index, entries };
}

function runVectorPhase(): { enabled: boolean; storedOn: boolean } {
  const cfg = loadConfigSync();
  const settings = getVectorSearchSettings();
  return {
    enabled: settings.enabled,
    storedOn: cfg.vectorSearchEnabled === true,
  };
}

async function mergeVectorHits(
  query: string,
  tokenized: RetrieveHit[],
  documents: readonly RetrieveDocument[],
  topK: number,
): Promise<{ hits: RetrieveHit[]; vectorPhase: VectorPhase }> {
  const { enabled, storedOn } = runVectorPhase();
  if (!enabled) {
    if (storedOn) {
      return {
        hits: tokenized,
        vectorPhase: {
          status: "failed",
          message: CHAT_VECTOR_FALLBACK_COPY,
        },
      };
    }
    return { hits: tokenized, vectorPhase: { status: "off" } };
  }

  const byId = new Map(documents.map((doc) => [doc.id, doc]));
  const bySlug = new Map(
    documents.filter((doc) => doc.slug).map((doc) => [doc.slug as string, doc]),
  );
  try {
    const vector = await searchByVector(query, topK);
    const merged = new Map<string, RetrieveHit>();
    for (const hit of tokenized) merged.set(hit.id, hit);
    for (const row of vector) {
      const doc = bySlug.get(row.slug) ?? byId.get(row.slug);
      if (!doc) continue;
      const existing = merged.get(doc.id);
      if (existing) {
        merged.set(doc.id, {
          ...existing,
          score: existing.score + row.score,
        });
        continue;
      }
      merged.set(doc.id, {
        id: doc.id,
        path: doc.path,
        title: doc.title,
        score: row.score,
        kind: doc.kind,
        type: doc.type,
        body: doc.body,
        snippet: extractBestSnippet(doc.body, tokenize(query), 240),
      });
    }
    const hits = [...merged.values()].sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return { hits, vectorPhase: { status: "ok" } };
  } catch (error) {
    logger.warn("retrieve", "vector phase failed", error);
    return {
      hits: tokenized,
      vectorPhase: {
        status: "failed",
        message: CHAT_VECTOR_FALLBACK_COPY,
      },
    };
  }
}

function extractWikiTargets(body: string, allowed: ReadonlySet<string>): string[] {
  return extractAllInternalTargets(body).filter((slug) => allowed.has(slug));
}

async function expandHits(
  seeds: RetrieveHit[],
  documents: readonly RetrieveDocument[],
  entries: readonly IndexEntry[],
  limit: number,
): Promise<RetrieveHit[]> {
  const pageDocs = documents.filter((doc) => doc.kind === "page" && doc.slug);
  if (pageDocs.length === 0) return seeds.slice(0, limit);
  const allowed = new Set(pageDocs.map((doc) => doc.slug as string));
  const bySlug = new Map(pageDocs.map((doc) => [doc.slug as string, doc]));
  const seedSlugs = seeds
    .map((hit) => (hit.kind === "page" ? hit.id : undefined))
    .filter((slug): slug is string => Boolean(slug));
  try {
    const evidence = pageDocs.map((doc) => {
      const entry = entries.find((item) => item.slug === doc.slug);
      return {
        id: doc.slug as string,
        directTargets: extractWikiTargets(doc.body, allowed),
        sourceUrls: doc.sourceUrls ?? [],
        ...(typeof entry?.type === "string" ? { type: entry.type } : {}),
      };
    });
    const expanded = expandGraphSeeds(
      seedSlugs,
      buildWeightedGraphEdges(evidence),
      allowed,
      limit,
    );
    const seen = new Set<string>();
    const out: RetrieveHit[] = [];
    for (const slug of expanded) {
      const existing = seeds.find((hit) => hit.id === slug);
      const doc = bySlug.get(slug);
      if (!doc || seen.has(doc.id)) continue;
      seen.add(doc.id);
      out.push(
        existing ?? {
          id: doc.id,
          path: doc.path,
          title: doc.title,
          score: 0,
          kind: doc.kind,
          type: doc.type,
          body: doc.body,
          snippet: extractBestSnippet(doc.body, [], 240),
        },
      );
    }
    for (const hit of seeds) {
      if (out.length >= limit) break;
      if (seen.has(hit.id)) continue;
      seen.add(hit.id);
      out.push(hit);
    }
    return out;
  } catch (error) {
    logger.warn("retrieve", "graph expansion failed; keeping seeds", error);
    return seeds.slice(0, limit);
  }
}

function tokenizedHits(
  query: string,
  documents: readonly RetrieveDocument[],
): RetrieveHit[] {
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];
  return documents
    .map((doc) => {
      const score = scoreRetrieveDocument(queryTokens, doc.title, doc.body);
      if (score <= 0) return null;
      return {
        id: doc.id,
        path: doc.path,
        title: doc.title,
        score,
        kind: doc.kind,
        type: doc.type,
        body: doc.body,
        snippet: extractBestSnippet(doc.body, queryTokens, 240).replace(/\s+/g, " ").trim(),
      } satisfies RetrieveHit;
    })
    .filter((hit): hit is RetrieveHit => hit !== null)
    .sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
}

export async function retrieveHits(
  query: string,
  options: AssembleOptions,
): Promise<{ hits: RetrieveHit[]; vectorPhase: VectorPhase }> {
  const trimmed = query.trim();
  if (!trimmed) return { hits: [], vectorPhase: { status: "off" } };
  const topK = options.topK ?? DEFAULT_SEED_LIMIT;
  const { candidates, entries } = await loadRetrieveDocuments(
    options.principal,
    options.retrievalMode ?? "wiki",
  );
  const phase1 = tokenizedHits(trimmed, candidates).slice(0, topK);
  const { hits: merged, vectorPhase } = await mergeVectorHits(
    trimmed,
    phase1,
    candidates,
    topK,
  );
  const expanded = await expandHits(merged, candidates, entries, topK);
  return { hits: expanded, vectorPhase };
}

export async function searchWiki(
  query: string,
  options: AssembleOptions,
): Promise<SearchRetrieveResult> {
  const topK = options.topK ?? DEFAULT_SEARCH_TOP_K;
  const { hits, vectorPhase } = await retrieveHits(query, { ...options, topK });
  return {
    vectorPhase,
    hits: hits.slice(0, topK).map((hit) => ({
      path: hit.path,
      title: hit.title,
      snippet: hit.snippet || hit.body.slice(0, 240),
      score: hit.score,
    })),
  };
}

function packSlice(parts: string[], budget: number): string {
  if (budget <= 0) return "";
  const kept: string[] = [];
  let used = 0;
  for (const part of parts) {
    const cost = estimateTokens(part);
    if (used + cost > budget && kept.length > 0) break;
    if (used + cost > budget) {
      const chars = Math.max(0, budget * 4);
      kept.push(part.slice(0, chars));
      used = budget;
      break;
    }
    kept.push(part);
    used += cost;
  }
  return kept.join("\n\n");
}

function numberBodies(hits: readonly RetrieveHit[]): {
  numberedBodies: string;
  citations: ChatCitation[];
} {
  const citations: ChatCitation[] = [];
  const parts: string[] = [];
  hits.forEach((hit, index) => {
    const n = index + 1;
    citations.push({
      n,
      path: hit.path,
      title: hit.title,
      type: hit.type,
    });
    parts.push(`[${n}] ${hit.title}\npath: ${hit.path}\ntype: ${hit.type}\n\n${hit.body}`);
  });
  return { numberedBodies: parts.join("\n\n"), citations };
}

function chatModelForRetrieve(): AssembledContext["chatModel"] {
  const chatModel = getChatModelSettings();
  let baseUrl: string | null = null;
  if (chatModel.provider === "custom") {
    baseUrl = getCustomBaseUrl();
  } else if (chatModel.provider === "ollama" || chatModel.provider === "ollama-cloud") {
    baseUrl = getOllamaBaseUrl() ?? null;
  }
  return {
    provider: chatModel.provider,
    model: chatModel.model,
    configured: chatModel.configured,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

export async function assembleWikiContext(
  query: string,
  options: AssembleOptions,
): Promise<AssembledContext> {
  const tokenBudget = clampTokenBudget(options.tokenBudget ?? CHAT_TOKEN_BUDGET_DEFAULT);
  const historyDepth = clampHistoryDepth(options.historyDepth ?? CHAT_HISTORY_DEPTH_DEFAULT);
  const chatModel = chatModelForRetrieve();
  const emptyUsage = {
    pages: 0,
    history: 0,
    index: 0,
    system: 0,
    total: 0,
    budget: tokenBudget,
  };
  const base = {
    hits: [] as RetrieveHit[],
    citations: [] as ChatCitation[],
    numberedBodies: "",
    systemPrompt: "",
    indexSlice: "",
    historySlice: [] as AssembleHistoryMessage[],
    tokenUsage: emptyUsage,
    coverage: false,
    coverageMessage: CHAT_COVERAGE_MISSING_COPY,
    vectorPhase: { status: "off" } as VectorPhase,
    chatModel,
  };

  const trimmed = query.trim();
  if (!trimmed) return base;

  const { purpose, index } = await loadPurposeAndIndex();
  const { hits: expanded, vectorPhase } = await retrieveHits(trimmed, {
    ...options,
    tokenBudget,
    historyDepth,
  });

  if (expanded.length === 0) {
    return { ...base, vectorPhase };
  }

  const pageBudget = Math.floor(tokenBudget * CHAT_PAGE_BUDGET_RATIO);
  const historyBudget = Math.floor(tokenBudget * CHAT_HISTORY_BUDGET_RATIO);
  const indexBudget = Math.floor(tokenBudget * CHAT_INDEX_BUDGET_RATIO);
  const systemBudget = Math.floor(tokenBudget * CHAT_SYSTEM_BUDGET_RATIO);

  // Full numbered body or exclude. Later smaller pages may still enter.
  const packedPages: RetrieveHit[] = [];
  for (const hit of expanded) {
    const candidate = [...packedPages, hit];
    const numbered = numberBodies(candidate);
    if (estimateTokens(numbered.numberedBodies) > pageBudget) continue;
    packedPages.push(hit);
  }

  if (packedPages.length === 0) {
    return { ...base, vectorPhase };
  }

  const { numberedBodies, citations } = numberBodies(packedPages);
  let historySlice = (options.history ?? []).slice(-historyDepth);
  let historyText = historySlice
    .map((message) => `${message.role}: ${message.content}`)
    .join("\n\n");
  while (
    historySlice.length > 0 &&
    estimateTokens(historyText) > historyBudget
  ) {
    historySlice = historySlice.slice(1);
    historyText = historySlice
      .map((message) => `${message.role}: ${message.content}`)
      .join("\n\n");
  }

  const indexSlice = packSlice(index ? [index.body] : [], indexBudget);
  const conventions = await loadPageConventions();
  const systemParts = [
    "You are work-wiki's cited Chat assistant. Answer only from the numbered Page or Source bodies.",
    "Every non-empty answer must include at least one [n] citation that maps to a numbered body.",
    "Do not invent citations. Do not cite Thinking. Write in English.",
    purpose ? `Wiki purpose:\n${purpose.body}` : "",
    conventions ? `Page conventions:\n${conventions}` : "",
  ].filter(Boolean);
  const systemPrompt = packSlice(systemParts, systemBudget);

  const tokenUsage: TokenUsage = {
    pages: estimateTokens(numberedBodies),
    history: estimateTokens(historyText),
    index: estimateTokens(indexSlice),
    system: estimateTokens(systemPrompt),
    total: 0,
    budget: tokenBudget,
  };
  tokenUsage.total =
    tokenUsage.pages + tokenUsage.history + tokenUsage.index + tokenUsage.system;

  return {
    hits: packedPages,
    citations,
    numberedBodies,
    systemPrompt,
    indexSlice,
    historySlice,
    tokenUsage,
    coverage: packedPages.length > 0,
    coverageMessage: packedPages.length > 0 ? null : CHAT_COVERAGE_MISSING_COPY,
    vectorPhase,
    chatModel: base.chatModel,
  };
}
