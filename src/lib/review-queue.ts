/**
 * Workbench Review queue — kernel SoR at tenants/{t}/review-queue.json.
 *
 * Actions are Deep Research · Create Page · Skip only. Extra model actions
 * drop or map to Skip. Skip writes nothing to the wiki.
 */

import { bumpDataVersion } from "./data-version";
import { isEnoent } from "./errors";
import type { IngestAnalysis } from "./ingest-analysis";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { slugify } from "./slugify";
import { getStorage } from "./storage";
import { readWikiPage, tenantForOwner, validateTenant } from "./wiki";

export type ReviewItemKind = "warning" | "lightbulb";
export type ReviewItemStatus = "pending" | "skipped" | "created";

export interface ReviewItem {
  id: string;
  kind: ReviewItemKind;
  title: string;
  summary: string;
  path: string;
  queries: string[];
  status: ReviewItemStatus;
  createdAt: string;
  updatedAt: string;
  pageSlug?: string;
  wikiId?: string;
}

export interface ReviewStore {
  items: ReviewItem[];
}

const MAX_ITEMS = 500;
const CAS_ATTEMPTS = 4;

function queuePath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/review-queue.json`;
}

function lockKey(owner: string): string {
  return `review-queue:${tenantForOwner(owner)}`;
}

function emptyStore(): ReviewStore {
  return { items: [] };
}

function isReviewItem(value: unknown): value is ReviewItem {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  return (
    typeof item.id === "string" &&
    (item.kind === "warning" || item.kind === "lightbulb") &&
    typeof item.title === "string" &&
    typeof item.summary === "string" &&
    typeof item.path === "string" &&
    Array.isArray(item.queries) &&
    (item.status === "pending" || item.status === "skipped" || item.status === "created") &&
    typeof item.createdAt === "string" &&
    typeof item.updatedAt === "string"
  );
}

function parseStore(raw: string): ReviewStore {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) return { items: parsed.filter(isReviewItem) };
    if (!parsed || typeof parsed !== "object") return emptyStore();
    const items = Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items.filter(isReviewItem)
      : [];
    return { items };
  } catch {
    return emptyStore();
  }
}

function wikiPath(slug: string): string {
  const clean = slug.replace(/^\/+/, "").replace(/\.md$/i, "");
  const rest = (clean.startsWith("wiki/") ? clean.slice("wiki/".length) : clean)
    .split("/")
    .filter((part) => part && part !== "." && part !== "..");
  const last = slugify(rest[rest.length - 1] ?? "") || "page";
  return `wiki/${last}.md`;
}

export function isPendingReview(item: ReviewItem): boolean {
  return item.status === "pending";
}

export function mapModelAction(action: string | undefined): "skip" | "keep" {
  if (!action) return "keep";
  const normalized = action.trim().toLowerCase();
  if (
    normalized === "accept" ||
    normalized === "reject" ||
    normalized === "revise" ||
    normalized === "skip"
  ) {
    return "skip";
  }
  if (normalized === "deep research" || normalized === "create page") return "keep";
  return "skip";
}

async function readStore(owner: string): Promise<ReviewStore> {
  try {
    return parseStore(await getStorage().readFile(queuePath(owner)));
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    throw error;
  }
}

async function withQueue<T>(owner: string, mutate: (store: ReviewStore) => T): Promise<T> {
  const result = await withFileLock(lockKey(owner), async () => {
    const storage = getStorage();
    const path = queuePath(owner);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      let store = emptyStore();
      let etag: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        store = parseStore(read.content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const draft: ReviewStore = { items: store.items.map((item) => ({ ...item })) };
      const value = mutate(draft);
      if (draft.items.length > MAX_ITEMS) {
        const pending = draft.items.filter(isPendingReview);
        const done = draft.items.filter((item) => !isPendingReview(item));
        draft.items = [...pending, ...done].slice(0, MAX_ITEMS);
      }
      const next = JSON.stringify(draft, null, 2);
      if (etag === null) {
        try {
          await storage.readFile(path);
          continue;
        } catch (error) {
          if (!isEnoent(error)) throw error;
          await storage.writeFile(path, next);
          return value;
        }
      }
      if (await storage.writeFileIfMatch(path, next, etag)) return value;
    }
    throw new Error("Review queue was busy; retry the request");
  });
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn("review-queue", "data-version bump failed after a Review write", error);
  }
  return result;
}

export async function listReviewItems(owner: string): Promise<ReviewItem[]> {
  return (await readStore(owner)).items
    .filter(isPendingReview)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export async function pendingReviewCount(owner: string): Promise<number> {
  return (await readStore(owner)).items.filter(isPendingReview).length;
}

export async function getReviewItem(owner: string, id: string): Promise<ReviewItem | null> {
  return (await readStore(owner)).items.find((item) => item.id === id) ?? null;
}

export async function skipReviewItem(owner: string, id: string): Promise<ReviewItem | null> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  const now = new Date().toISOString();
  return withQueue(owner, (store) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item || item.status !== "pending") return null;
    item.status = "skipped";
    item.updatedAt = now;
    return item;
  });
}

export async function createPageFromReview(
  owner: string,
  id: string,
  author: string,
): Promise<{ item: ReviewItem; slug: string } | null> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  const item = await getReviewItem(owner, id);
  if (!item || item.status !== "pending") return null;
  const base = slugify(item.title) || `review-${item.id.slice(0, 8)}`;
  let slug = base;
  let n = 2;
  while (await readWikiPage(slug)) {
    slug = `${base}-${n}`;
    n += 1;
  }
  const now = new Date().toISOString();
  const claimed = await withQueue(owner, (store) => {
    const row = store.items.find((candidate) => candidate.id === id && candidate.status === "pending");
    if (!row) return null;
    row.status = "created";
    row.pageSlug = slug;
    row.path = wikiPath(slug);
    row.updatedAt = now;
    return { ...row };
  });
  if (!claimed) return null;
  const body = [
    `# ${item.title}`,
    "",
    item.summary || "Created from Review.",
    "",
  ].join("\n");
  try {
    await writeWikiPageWithSideEffects({
      slug,
      title: item.title,
      content: body,
      summary: item.summary.slice(0, 160) || item.title,
      logOp: "save",
      logDetails: () => "create from Workbench Review",
      crossRefSource: null,
      author: author.trim() || owner,
    });
  } catch (error) {
    await withQueue(owner, (store) => {
      const row = store.items.find((candidate) => candidate.id === id);
      if (row && row.status === "created" && row.pageSlug === slug) {
        row.status = "pending";
        row.updatedAt = new Date().toISOString();
      }
      return row ?? null;
    });
    throw error;
  }
  return { item: claimed, slug };
}

export function reviewItemsFromAnalysis(
  analysis: IngestAnalysis,
  pageSlug: string,
): Array<Omit<ReviewItem, "id" | "status" | "createdAt" | "updatedAt" | "wikiId">> {
  const path = wikiPath(pageSlug);
  const out: Array<Omit<ReviewItem, "id" | "status" | "createdAt" | "updatedAt" | "wikiId">> = [];
  const seen = new Set<string>();

  if (analysis.reviewItems && analysis.reviewItems.length > 0) {
    for (const draft of analysis.reviewItems) {
      const action = mapModelAction(draft.action);
      if (action === "skip" && draft.action) continue;
      const title = draft.title.trim();
      if (!title || seen.has(title.toLowerCase())) continue;
      seen.add(title.toLowerCase());
      out.push({
        kind: draft.kind === "lightbulb" ? "lightbulb" : "warning",
        title: title.slice(0, 160),
        summary: (draft.summary ?? "").trim().slice(0, 2_000),
        path: draft.path?.trim() ? wikiPath(draft.path) : path,
        queries: (draft.queries ?? []).map((query) => query.trim()).filter(Boolean).slice(0, 16),
        pageSlug,
      });
    }
  }

  for (const tension of analysis.tensions) {
    const title = tension.trim();
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push({
      kind: "warning",
      title: title.slice(0, 160),
      summary: title.slice(0, 2_000),
      path,
      queries: (analysis.searchQueries ?? []).map((query) => query.trim()).filter(Boolean).slice(0, 16),
      pageSlug,
    });
  }

  if (out.length === 0 && (analysis.searchQueries ?? []).some((query) => query.trim())) {
    out.push({
      kind: "lightbulb",
      title: `Follow-up research for ${pageSlug}`,
      summary: "Ingest stored follow-up queries that need a human decision.",
      path,
      queries: analysis.searchQueries!.map((query) => query.trim()).filter(Boolean).slice(0, 16),
      pageSlug,
    });
  }

  return out;
}

export async function enqueueReviewFromAnalysis(
  owner: string,
  input: { wikiId: string; pageSlug: string; analysis: IngestAnalysis },
): Promise<ReviewItem[]> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  const drafts = reviewItemsFromAnalysis(input.analysis, input.pageSlug);
  if (drafts.length === 0) return [];
  const now = new Date().toISOString();
  return withQueue(owner, (store) => {
    const created: ReviewItem[] = [];
    for (const draft of drafts) {
      const duplicate = store.items.some(
        (item) =>
          item.status === "pending" &&
          item.pageSlug === draft.pageSlug &&
          item.title.toLowerCase() === draft.title.toLowerCase(),
      );
      if (duplicate) continue;
      const item: ReviewItem = {
        ...draft,
        id: crypto.randomUUID(),
        status: "pending",
        wikiId: input.wikiId,
        createdAt: now,
        updatedAt: now,
      };
      store.items.push(item);
      created.push(item);
    }
    return created;
  });
}
