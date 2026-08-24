/**
 * Workbench Review queue — kernel SoR at tenants/{t}/review-queue.json.
 *
 * Actions are Deep Research · Create Page · Skip only. Extra model actions
 * drop or map to Skip. Skip writes nothing to the wiki.
 */

import { bumpDataVersion } from "./data-version";
import { isReadOnly } from "./config";
import { isEnoent } from "./errors";
import { parseFrontmatter } from "./frontmatter";
import type { IngestAnalysis } from "./ingest-analysis";
import { loadIngestAnalysis } from "./ingest-analysis";
import { writeWikiPageWithSideEffects } from "./lifecycle";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { slugify } from "./slugify";
import { getStorage } from "./storage";
import {
  readWikiPage,
  tenantForOwner,
  tenantWikiRelPath,
  validateSlug,
  validateTenant,
} from "./wiki";
import { getWikiRegistry } from "./wikis";
import { contentVersion } from "./write-precondition";

export type ReviewItemKind = "warning" | "lightbulb";
export type ReviewItemStatus = "pending" | "creating" | "skipped" | "created";

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
  sourcePath?: string;
  operationId?: string;
  claimExpiresAt?: string;
  deliveryId?: string;
}

export interface ReviewStore {
  items: ReviewItem[];
}

export class CorruptReviewStoreError extends Error {
  constructor(message = "Review queue JSON is corrupt") {
    super(message);
    this.name = "CorruptReviewStoreError";
  }
}

export class ReviewQueueFullError extends Error {
  constructor(message = "Review queue is full; delivery was retained for retry") {
    super(message);
    this.name = "ReviewQueueFullError";
  }
}

export class ReviewDeliveryUnretainedError extends Error {
  constructor(message = "Review delivery was not retained") {
    super(message);
    this.name = "ReviewDeliveryUnretainedError";
  }
}

const MAX_PENDING = 500;
const MAX_DONE = 200;
const CAS_ATTEMPTS = 4;
const CREATE_LEASE_MS = 5 * 60 * 1_000;
const CLAIM_RENEW_INTERVAL_MS = Math.floor(CREATE_LEASE_MS / 3);
const OUTBOX_MAX_ATTEMPTS = 5;
const OUTBOX_RETRY_BASE_MS = 1_000;
const MAX_OUTBOX_DEAD_LETTERS = 200;
const MAX_REVIEW_PAGE_SLUG_BYTES = 200;
const RESERVED_PAGE_SLUGS = new Set(["purpose", "schema", "index", "log", "overview"]);

function queuePath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/review-queue.json`;
}

function outboxPath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/review-outbox.json`;
}

function lockKey(owner: string): string {
  return `review-queue:${tenantForOwner(owner)}`;
}

function outboxLockKey(owner: string): string {
  return `review-outbox:${tenantForOwner(owner)}`;
}

function emptyStore(): ReviewStore {
  return { items: [] };
}

function isCanonicalTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value;
}

function isValidPersistedSlug(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    validateSlug(value);
    return true;
  } catch {
    return false;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function fitReviewSlug(base: string, suffix = ""): string {
  const maxBaseBytes = MAX_REVIEW_PAGE_SLUG_BYTES - utf8Length(suffix);
  let result = "";
  for (const char of base) {
    if (utf8Length(result + char) > maxBaseBytes) break;
    result += char;
  }
  result = result.replace(/-+$/g, "") || "review";
  return `${result}${suffix}`;
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
    item.queries.every((query) => typeof query === "string") &&
    (item.status === "pending" ||
      item.status === "creating" ||
      item.status === "skipped" ||
      item.status === "created") &&
    isCanonicalTimestamp(item.createdAt) &&
    isCanonicalTimestamp(item.updatedAt) &&
    (item.pageSlug === undefined || isValidPersistedSlug(item.pageSlug)) &&
    (item.wikiId === undefined ||
      (typeof item.wikiId === "string" && item.wikiId.trim().length > 0)) &&
    (item.sourcePath === undefined || typeof item.sourcePath === "string") &&
    (item.operationId === undefined || typeof item.operationId === "string") &&
    (item.deliveryId === undefined || typeof item.deliveryId === "string") &&
    (item.claimExpiresAt === undefined ||
      isCanonicalTimestamp(item.claimExpiresAt))
  );
}

function parseStore(raw: string): ReviewStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptReviewStoreError();
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isReviewItem)) throw new CorruptReviewStoreError();
    return { items: parsed };
  }
  if (!parsed || typeof parsed !== "object") throw new CorruptReviewStoreError();
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || !items.every(isReviewItem)) {
    throw new CorruptReviewStoreError();
  }
  return { items };
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

function isActiveReview(item: ReviewItem): boolean {
  return item.status === "pending" || item.status === "creating";
}

/**
 * Process-loss recovery for Create Page. A crash after the claim but before
 * the Page write leaves `creating`; a crash after the write leaves `creating`
 * with a Page on disk. Listing and retry converge those rows to pending or
 * created so the card is never stuck.
 */
async function readClaimedPageOperation(
  owner: string,
  item: Pick<ReviewItem, "pageSlug" | "operationId">,
): Promise<string | null> {
  if (!item.pageSlug || !item.operationId) return null;
  try {
    const content = await getStorage().readFile(
      tenantWikiRelPath(tenantForOwner(owner), `${item.pageSlug}.md`),
    );
    const operationId = parseFrontmatter(content).data.review_operation_id;
    return typeof operationId === "string" ? operationId : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function readClaimedPageContent(
  owner: string,
  item: Pick<ReviewItem, "pageSlug" | "operationId">,
): Promise<string | null> {
  if (!item.pageSlug || !item.operationId) return null;
  try {
    const content = await getStorage().readFile(
      tenantWikiRelPath(tenantForOwner(owner), `${item.pageSlug}.md`),
    );
    return parseFrontmatter(content).data.review_operation_id === item.operationId
      ? content
      : null;
  } catch (error) {
    if (isEnoent(error)) return null;
    throw error;
  }
}

async function claimPageMatches(owner: string, item: ReviewItem): Promise<boolean> {
  return (await readClaimedPageOperation(owner, item)) === item.operationId;
}

function claimedPageBody(owner: string, item: ReviewItem): string | null {
  if (!item.operationId) return null;
  const provenance = item.sourcePath ?? item.path;
  return [
    "---",
    `owner: ${owner}`,
    `sources: [${JSON.stringify(provenance)}]`,
    `review_operation_id: ${JSON.stringify(item.operationId)}`,
    "---",
    "",
    `# ${item.title}`,
    "",
    item.summary || "Created from Review.",
    "",
    `Created from Review of ${provenance}.`,
    "",
  ].join("\n");
}

/** Finish every shared lifecycle side effect before a recovered claim is terminal. */
async function repairClaimedPageLifecycle(
  owner: string,
  item: ReviewItem,
  author = owner,
): Promise<boolean> {
  if (!item.pageSlug) return false;
  const content = await readClaimedPageContent(owner, item);
  if (!content) return false;
  await writeWikiPageWithSideEffects({
    slug: item.pageSlug,
    title: item.title,
    content,
    expectedContent: content,
    summary: item.summary.slice(0, 160) || item.title,
    logOp: "save",
    logDetails: () => "repair create from Workbench Review",
    crossRefSource: null,
    author: author.trim() || owner,
  });
  return true;
}

async function renewReviewClaim(
  owner: string,
  id: string,
  operationId: string,
): Promise<boolean> {
  return withQueue(
    owner,
    (store) => {
      const row = store.items.find((candidate) => candidate.id === id);
      if (row?.status !== "creating" || row.operationId !== operationId) return false;
      row.claimExpiresAt = new Date(Date.now() + CREATE_LEASE_MS).toISOString();
      row.updatedAt = new Date().toISOString();
      return true;
    },
    { bump: false },
  );
}

async function recoverInterruptedCreates(owner: string): Promise<void> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  const store = await readStore(owner);
  const nowMs = Date.now();
  const interrupted = store.items.filter(
    (item) =>
      item.status === "creating" &&
      (!item.claimExpiresAt || Date.parse(item.claimExpiresAt) <= nowMs),
  );
  if (interrupted.length === 0) return;
  const interruptedClaims = new Map(
    interrupted.map((item) => [
      item.id,
      {
        pageSlug: item.pageSlug,
        operationId: item.operationId,
        claimExpiresAt: item.claimExpiresAt,
      },
    ]),
  );
  const finished = new Set<string>();
  const repairPending = new Set<string>();
  for (const item of interrupted) {
    try {
      if (!(await claimPageMatches(owner, item))) continue;
      if (await repairClaimedPageLifecycle(owner, item)) finished.add(item.id);
    } catch (error) {
      repairPending.add(item.id);
      logger.warn("review-queue", `lifecycle repair failed for ${item.id}`, error);
    }
  }
  await withQueue(owner, (draft) => {
    const now = new Date().toISOString();
    for (const item of draft.items) {
      const observed = interruptedClaims.get(item.id);
      if (
        item.status !== "creating" ||
        !observed ||
        item.pageSlug !== observed.pageSlug ||
        item.operationId !== observed.operationId ||
        item.claimExpiresAt !== observed.claimExpiresAt
      ) {
        continue;
      }
      if (finished.has(item.id) && item.pageSlug) {
        item.status = "created";
        item.path = wikiPath(item.pageSlug);
        item.updatedAt = now;
        delete item.claimExpiresAt;
        continue;
      }
      if (repairPending.has(item.id)) {
        item.claimExpiresAt = new Date(Date.now() + CREATE_LEASE_MS).toISOString();
        item.updatedAt = now;
        continue;
      }
      item.status = "pending";
      delete item.pageSlug;
      delete item.operationId;
      delete item.claimExpiresAt;
      if (item.sourcePath) item.path = item.sourcePath;
      item.updatedAt = now;
    }
    return null;
  });
}

function matchesWiki(item: ReviewItem, wikiId?: string): boolean {
  if (!wikiId) return true;
  return !item.wikiId || item.wikiId === wikiId;
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

async function quarantine(path: string, raw: string): Promise<void> {
  try {
    await getStorage().writeFile(`${path}.corrupt-${Date.now()}`, raw);
  } catch (error) {
    logger.warn("review-queue", "failed to quarantine corrupt store", error);
  }
}

async function readStore(
  owner: string,
  options?: { quarantineCorrupt?: boolean },
): Promise<ReviewStore> {
  const path = queuePath(owner);
  let raw: string | null = null;
  try {
    raw = await getStorage().readFile(path);
    return parseStore(raw);
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    if (error instanceof CorruptReviewStoreError) {
      if (raw !== null && options?.quarantineCorrupt !== false) await quarantine(path, raw);
      throw error;
    }
    throw error;
  }
}

function applyBounds(draft: ReviewStore, acceptedIds: Set<string>): Set<string> {
  const creating = draft.items.filter((item) => item.status === "creating");
  const pending = draft.items.filter(isPendingReview);
  const done = draft.items.filter(
    (item) => item.status === "skipped" || item.status === "created",
  );
  const pendingCapacity = Math.max(0, MAX_PENDING - creating.length);
  const keptPending = pending.slice(0, pendingCapacity);
  const rejected = new Set<string>();
  for (const item of pending.slice(pendingCapacity)) {
    if (acceptedIds.has(item.id)) rejected.add(item.id);
  }
  const keptDone = done
    .slice()
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, MAX_DONE);
  draft.items = [...creating, ...keptPending, ...keptDone];
  return rejected;
}

async function withQueue<T>(
  owner: string,
  mutate: (store: ReviewStore) => T,
  options?: { bump?: boolean },
): Promise<T> {
  const result = await withFileLock(lockKey(owner), async () => {
    const storage = getStorage();
    const path = queuePath(owner);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      let store = emptyStore();
      let etag: string | null = null;
      let raw: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        raw = read.content;
        store = parseStore(raw);
      } catch (error) {
        if (error instanceof CorruptReviewStoreError) {
          if (raw !== null) await quarantine(path, raw);
          throw error;
        }
        if (!isEnoent(error)) throw error;
      }
      const draft: ReviewStore = { items: store.items.map((item) => ({ ...item })) };
      const before = new Set(draft.items.map((item) => item.id));
      const value = mutate(draft);
      const accepted = new Set(
        draft.items.filter((item) => !before.has(item.id)).map((item) => item.id),
      );
      const rejected = applyBounds(draft, accepted);
      if (Array.isArray(value)) {
        const filtered = value.filter((item) => item && typeof item === "object" && "id" in item && !rejected.has((item as ReviewItem).id));
        (value as unknown[]).splice(0, value.length, ...filtered);
      }
      const next = JSON.stringify(draft, null, 2);
      if (etag === null) {
        if (await storage.writeFileIfAbsent(path, next)) return value;
        continue;
      }
      if (await storage.writeFileIfMatch(path, next, etag)) return value;
    }
    throw new Error("Review queue was busy; retry the request");
  });
  if (options?.bump !== false) {
    try {
      await bumpDataVersion();
    } catch (error) {
      logger.warn("review-queue", "data-version bump failed after a Review write", error);
    }
  }
  return result;
}

export async function reviewSnapshot(
  owner: string,
  wikiId?: string,
): Promise<{ items: ReviewItem[]; pendingCount: number }> {
  const readOnly = isReadOnly();
  if (!readOnly) {
    await drainReviewOutbox(owner);
    await recoverInterruptedCreates(owner);
  }
  const snapshot = await readStore(owner, { quarantineCorrupt: !readOnly });
  const items = snapshot.items
    .filter(isActiveReview)
    .filter((item) => matchesWiki(item, wikiId))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { items, pendingCount: items.length };
}

export async function listReviewItems(owner: string, wikiId?: string): Promise<ReviewItem[]> {
  return (await reviewSnapshot(owner, wikiId)).items;
}

export async function pendingReviewCount(owner: string, wikiId?: string): Promise<number> {
  return (await reviewSnapshot(owner, wikiId)).pendingCount;
}

export async function getReviewItem(owner: string, id: string): Promise<ReviewItem | null> {
  return (await readStore(owner)).items.find((item) => item.id === id) ?? null;
}

export async function skipReviewItem(
  owner: string,
  id: string,
  wikiId?: string,
): Promise<ReviewItem | null> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  await recoverInterruptedCreates(owner);
  const now = new Date().toISOString();
  return withQueue(owner, (store) => {
    const item = store.items.find((candidate) => candidate.id === id);
    if (!item || !isPendingReview(item) || !matchesWiki(item, wikiId)) return null;
    item.status = "skipped";
    item.updatedAt = now;
    return item;
  });
}

export async function createPageFromReview(
  owner: string,
  id: string,
  author: string,
  wikiId?: string,
): Promise<{ item: ReviewItem; slug: string } | null> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  await recoverInterruptedCreates(owner);
  const item = await getReviewItem(owner, id);
  if (item?.status === "created" && item.pageSlug) {
    return matchesWiki(item, wikiId) && (await claimPageMatches(owner, item))
      ? { item, slug: item.pageSlug }
      : null;
  }
  if (item?.status === "creating" && item.pageSlug) {
    if (matchesWiki(item, wikiId) && (await claimPageMatches(owner, item))) {
      const completed = await withQueue(owner, (store) => {
        const row = store.items.find((candidate) => candidate.id === id);
        if (!row || !matchesWiki(row, wikiId)) return null;
        row.status = "created";
        row.pageSlug = item.pageSlug;
        row.operationId = item.operationId;
        row.path = wikiPath(item.pageSlug!);
        row.updatedAt = new Date().toISOString();
        delete row.claimExpiresAt;
        return { ...row };
      });
      if (completed?.pageSlug) return { item: completed, slug: completed.pageSlug };
    }
    return null;
  }
  if (!item || item.status !== "pending" || !matchesWiki(item, wikiId)) return null;
  const base = fitReviewSlug(slugify(item.title) || `review-${item.id.slice(0, 8)}`);
  const originalPath = item.sourcePath ?? item.path;
  const snapshot = await readStore(owner);
  const existing = snapshot.items.find(
    (candidate) =>
      candidate.id === id &&
      candidate.status === "pending" &&
      matchesWiki(candidate, wikiId),
  );
  if (!existing) return null;
  const reserved = {
    taken: new Set(
      snapshot.items
        .filter((candidate) => candidate.id !== id)
        .map((candidate) => candidate.pageSlug)
        .filter((value): value is string => Boolean(value)),
    ),
  };
  let slug = base;
  let n = 2;
  while (
    reserved.taken.has(slug) ||
    RESERVED_PAGE_SLUGS.has(slug) ||
    (await readWikiPage(slug))
  ) {
    slug = fitReviewSlug(base, `-${n}`);
    n += 1;
  }
  const now = new Date().toISOString();
  const operationId = crypto.randomUUID();
  const claimExpiresAt = new Date(Date.now() + CREATE_LEASE_MS).toISOString();
  const locked = await withQueue(owner, (store) => {
    const row = store.items.find(
      (candidate) =>
        candidate.id === id &&
        candidate.status === "pending" &&
        matchesWiki(candidate, wikiId),
    );
    if (!row) return null;
    const taken = new Set(
      store.items
        .filter((candidate) => candidate.id !== id)
        .map((candidate) => candidate.pageSlug)
        .filter((value): value is string => Boolean(value)),
    );
    let nextSlug = slug;
    let extra = n;
    while (taken.has(nextSlug) || RESERVED_PAGE_SLUGS.has(nextSlug)) {
      nextSlug = fitReviewSlug(base, `-${extra}`);
      extra += 1;
    }
    row.status = "creating";
    row.pageSlug = nextSlug;
    row.operationId = operationId;
    row.claimExpiresAt = claimExpiresAt;
    row.path = wikiPath(nextSlug);
    row.updatedAt = now;
    return { ...row };
  });
  if (!locked?.pageSlug) return null;
  const pageSlug = locked.pageSlug;
  const body = claimedPageBody(owner, locked);
  if (!body) throw new Error("Review claim lost its operation identity");

  const finish = async (): Promise<ReviewItem | null> =>
    withQueue(owner, (store) => {
      const row = store.items.find((candidate) => candidate.id === id);
      if (!row) return null;
      if (
        row.status === "created" &&
        row.pageSlug === pageSlug &&
        row.operationId === operationId
      ) {
        return { ...row };
      }
      if (
        row.status !== "creating" ||
        row.pageSlug !== pageSlug ||
        row.operationId !== operationId
      ) {
        return null;
      }
      row.status = "created";
      row.path = wikiPath(pageSlug);
      row.updatedAt = new Date().toISOString();
      delete row.claimExpiresAt;
      return { ...row };
    });

  const renewTimer = setInterval(async () => {
    await renewReviewClaim(owner, id, operationId).catch((error) => {
      logger.warn("review-queue", `claim renewal failed for ${id}`, error);
    });
  }, CLAIM_RENEW_INTERVAL_MS);
  try {
    await writeWikiPageWithSideEffects({
      slug: pageSlug,
      title: item.title,
      content: body,
      summary: item.summary.slice(0, 160) || item.title,
      logOp: "save",
      logDetails: () => "create from Workbench Review",
      crossRefSource: null,
      author: author.trim() || owner,
      createOnly: true,
    });
  } catch (error) {
    // The primary Page may have landed before a later lifecycle side effect
    // failed. Repair those side effects before making the row terminal.
    if (await claimPageMatches(owner, locked)) {
      await repairClaimedPageLifecycle(owner, locked, author);
      const repaired = await finish();
      if (repaired) return { item: repaired, slug: pageSlug };
    }
    await withQueue(owner, (store) => {
      const row = store.items.find((candidate) => candidate.id === id);
      if (
        row?.status === "creating" &&
        row.pageSlug === pageSlug &&
        row.operationId === operationId
      ) {
        row.status = "pending";
        delete row.pageSlug;
        delete row.operationId;
        delete row.claimExpiresAt;
        row.path = originalPath;
        row.updatedAt = new Date().toISOString();
      }
      return row ?? null;
    });
    throw error;
  } finally {
    clearInterval(renewTimer);
  }
  const finished = await finish();
  if (finished) return { item: finished, slug: pageSlug };
  if (await claimPageMatches(owner, locked)) {
    await repairClaimedPageLifecycle(owner, locked, author);
    const repaired = await finish();
    if (repaired) return { item: repaired, slug: pageSlug };
    const recovered = await withQueue(owner, (store) => {
      const row = store.items.find((candidate) => candidate.id === id);
      if (!row || !matchesWiki(row, wikiId)) return null;
      row.status = "created";
      row.pageSlug = pageSlug;
      row.operationId = operationId;
      row.path = wikiPath(pageSlug);
      row.updatedAt = new Date().toISOString();
      delete row.claimExpiresAt;
      return { ...row };
    });
    if (recovered) return { item: recovered, slug: pageSlug };
  }
  return null;
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
        sourcePath: path,
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
      sourcePath: path,
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
      sourcePath: path,
    });
  }

  return out;
}

export async function enqueueReviewFromAnalysis(
  owner: string,
  input: {
    wikiId?: string;
    pageSlug: string;
    analysis: IngestAnalysis;
    deliveryId?: string;
  },
): Promise<ReviewItem[]> {
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  validateSlug(input.pageSlug);
  if (input.wikiId !== undefined && input.wikiId.trim().length === 0) {
    throw new Error("Review wikiId must be nonempty when provided");
  }
  const drafts = reviewItemsFromAnalysis(input.analysis, input.pageSlug);
  if (drafts.length === 0) return [];
  const now = new Date().toISOString();
  let hitCapacity = false;
  const created = await withQueue(owner, (store) => {
    const created: ReviewItem[] = [];
    const activeCount = store.items.filter(isActiveReview).length;
    for (const draft of drafts) {
      const deliveryId = input.deliveryId
        ? `${input.deliveryId}:${contentVersion(JSON.stringify([
            draft.kind,
            draft.title,
            draft.path,
          ]))}`
        : undefined;
      const duplicate = store.items.some(
        (item) =>
          (deliveryId && item.deliveryId === deliveryId) ||
          (isActiveReview(item) &&
            item.pageSlug === draft.pageSlug &&
            item.title.toLowerCase() === draft.title.toLowerCase() &&
            (item.wikiId ?? "") === (input.wikiId ?? "")),
      );
      if (duplicate) continue;
      if (activeCount + created.length >= MAX_PENDING) {
        hitCapacity = true;
        continue;
      }
      const item: ReviewItem = {
        ...draft,
        id: crypto.randomUUID(),
        status: "pending",
        wikiId: input.wikiId,
        ...(deliveryId ? { deliveryId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      store.items.push(item);
      created.push(item);
    }
    return created;
  });
  if (hitCapacity) throw new ReviewQueueFullError();
  return created;
}

interface ReviewOutboxItem {
  wikiId?: string;
  pageSlug: string;
  jobId: string;
  deliveryId: string;
  createdAt: string;
  attempts: number;
  nextAttemptAt?: string;
  lastError?: string;
  deadLetteredAt?: string;
}

function reviewDeliveryId(item: {
  wikiId?: string;
  pageSlug: string;
  jobId: string;
}): string {
  return `review:${contentVersion(JSON.stringify([
    item.jobId,
    item.pageSlug,
    item.wikiId ?? null,
  ]))}`;
}

function parseOutbox(raw: string): ReviewOutboxItem[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptReviewStoreError("Review outbox JSON is corrupt");
  }
  if (!parsed || typeof parsed !== "object") {
    throw new CorruptReviewStoreError("Review outbox JSON is corrupt");
  }
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items)) {
    throw new CorruptReviewStoreError("Review outbox JSON is corrupt");
  }
  const valid = items.every((item) => {
    if (!item || typeof item !== "object") return false;
    const row = item as Record<string, unknown>;
    return (
      (row.wikiId === undefined ||
        (typeof row.wikiId === "string" && row.wikiId.trim().length > 0)) &&
      isValidPersistedSlug(row.pageSlug) &&
      typeof row.jobId === "string" && row.jobId.trim().length > 0 &&
      isCanonicalTimestamp(row.createdAt) &&
      (row.deliveryId === undefined || typeof row.deliveryId === "string") &&
      (row.attempts === undefined ||
        (typeof row.attempts === "number" &&
          Number.isInteger(row.attempts) &&
          row.attempts >= 0)) &&
      (row.nextAttemptAt === undefined || isCanonicalTimestamp(row.nextAttemptAt)) &&
      (row.lastError === undefined || typeof row.lastError === "string") &&
      (row.deadLetteredAt === undefined || isCanonicalTimestamp(row.deadLetteredAt))
    );
  });
  if (!valid) throw new CorruptReviewStoreError("Review outbox JSON is corrupt");
  return (items as Array<Partial<ReviewOutboxItem> & Pick<ReviewOutboxItem, "pageSlug" | "jobId" | "createdAt">>)
    .map((item) => ({
      ...item,
      deliveryId: item.deliveryId ?? reviewDeliveryId(item),
      attempts: item.attempts ?? 0,
    }));
}

async function readOutbox(owner: string): Promise<ReviewOutboxItem[]> {
  const path = outboxPath(owner);
  let raw: string | null = null;
  try {
    raw = await getStorage().readFile(path);
    return parseOutbox(raw);
  } catch (error) {
    if (isEnoent(error)) return [];
    if (error instanceof CorruptReviewStoreError && raw !== null) {
      await quarantineOutbox(path, raw);
    }
    throw error;
  }
}

async function quarantineOutbox(path: string, raw: string): Promise<void> {
  try {
    await getStorage().writeFileIfAbsent(`${path}.corrupt`, raw);
  } catch (error) {
    logger.warn("review-queue", "failed to quarantine corrupt outbox", error);
  }
}

function applyOutboxBounds(items: ReviewOutboxItem[]): void {
  const active = items.filter((item) => !item.deadLetteredAt);
  const dead = items
    .filter((item) => item.deadLetteredAt)
    .sort((a, b) => b.deadLetteredAt!.localeCompare(a.deadLetteredAt!))
    .slice(0, MAX_OUTBOX_DEAD_LETTERS);
  items.splice(0, items.length, ...active, ...dead);
}

async function withOutbox<T>(
  owner: string,
  mutate: (items: ReviewOutboxItem[]) => T,
): Promise<T> {
  return withFileLock(outboxLockKey(owner), async () => {
    const storage = getStorage();
    const path = outboxPath(owner);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      let items: ReviewOutboxItem[] = [];
      let etag: string | null = null;
      let raw: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        raw = read.content;
        items = parseOutbox(raw);
      } catch (error) {
        if (error instanceof CorruptReviewStoreError && raw !== null) {
          await quarantineOutbox(path, raw);
          throw error;
        }
        if (!isEnoent(error)) throw error;
      }
      const draft = items.map((item) => ({ ...item }));
      const value = mutate(draft);
      applyOutboxBounds(draft);
      const next = JSON.stringify({ items: draft }, null, 2);
      if (etag === null) {
        if (await storage.writeFileIfAbsent(path, next)) return value;
        continue;
      }
      if (await storage.writeFileIfMatch(path, next, etag)) return value;
    }
    throw new Error("Review outbox was busy; retry the request");
  });
}

async function retainReviewDelivery(
  owner: string,
  item: { wikiId?: string; pageSlug: string; jobId: string },
  cause: unknown,
): Promise<never> {
  try {
    await rememberReviewOutbox(owner, item);
  } catch (outboxError) {
    logger.warn("review-queue", `outbox write failed for ${item.jobId}`, outboxError);
    throw new ReviewDeliveryUnretainedError(
      cause instanceof Error ? cause.message : "Review delivery was not retained",
    );
  }
  throw cause instanceof Error ? cause : new Error(String(cause));
}

export async function rememberReviewOutbox(
  owner: string,
  item: { wikiId?: string; pageSlug: string; jobId: string },
): Promise<void> {
  validateSlug(item.pageSlug);
  if (!item.jobId.trim()) throw new Error("Review outbox jobId is required");
  if (item.wikiId !== undefined && item.wikiId.trim().length === 0) {
    throw new Error("Review wikiId must be nonempty when provided");
  }
  const deliveryId = reviewDeliveryId(item);
  await withOutbox(owner, (items) => {
    if (items.some((row) => row.deliveryId === deliveryId)) return;
    items.push({
      ...item,
      deliveryId,
      attempts: 0,
      createdAt: new Date().toISOString(),
    });
  });
}

function outboxRetryDelay(attempts: number): number {
  return Math.min(60_000, OUTBOX_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1));
}

async function recordOutboxFailure(
  owner: string,
  deliveryId: string,
  error: unknown,
): Promise<void> {
  await withOutbox(owner, (items) => {
    const row = items.find((item) => item.deliveryId === deliveryId);
    if (!row || row.deadLetteredAt) return;
    row.lastError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
    const now = Date.now();
    if (error instanceof ReviewQueueFullError) {
      row.nextAttemptAt = new Date(now + OUTBOX_RETRY_BASE_MS).toISOString();
      return;
    }
    row.attempts += 1;
    if (row.attempts >= OUTBOX_MAX_ATTEMPTS) {
      row.deadLetteredAt = new Date(now).toISOString();
      delete row.nextAttemptAt;
      return;
    }
    row.nextAttemptAt = new Date(now + outboxRetryDelay(row.attempts)).toISOString();
  });
}

export async function drainReviewOutbox(owner: string): Promise<void> {
  const items = await readOutbox(owner);
  if (items.length === 0) return;
  for (const item of items) {
    if (item.deadLetteredAt) continue;
    if (item.nextAttemptAt && Date.parse(item.nextAttemptAt) > Date.now()) continue;
    try {
      const analysis = await loadIngestAnalysis(item.jobId);
      if (!analysis) {
        await recordOutboxFailure(
          owner,
          item.deliveryId,
          new Error("Ingest analysis is not available yet"),
        );
        continue;
      }
      await enqueueReviewFromAnalysis(owner, {
        wikiId: item.wikiId,
        pageSlug: item.pageSlug,
        analysis,
        deliveryId: item.deliveryId,
      });
      await withOutbox(owner, (current) => {
        const index = current.findIndex((row) => row.deliveryId === item.deliveryId);
        if (index >= 0) current.splice(index, 1);
      });
    } catch (error) {
      await recordOutboxFailure(owner, item.deliveryId, error).catch((writeError) => {
        logger.warn("review-queue", `outbox retry state failed for ${item.jobId}`, writeError);
      });
      logger.warn("review-queue", `outbox drain failed for ${item.jobId}`, error);
    }
  }
}

export async function enqueueReviewAfterIngest(input: {
  owner: string;
  pageSlug: string;
  jobId?: string;
  wikiId?: string;
}): Promise<void> {
  const owner = input.owner.trim();
  if (!owner || !input.pageSlug) return;
  assertWritable(READ_ONLY_REFUSAL.reviewQueue);
  if (!input.jobId?.trim()) {
    throw new ReviewDeliveryUnretainedError("Review delivery needs an ingest job id");
  }
  let wikiId = input.wikiId?.trim() || undefined;
  if (!wikiId) {
    try {
      wikiId = (await getWikiRegistry(owner)).currentId ?? undefined;
    } catch {
      /* unresolved scope remains omitted; never synthesize a queue identity */
    }
  }
  const delivery = {
    wikiId,
    pageSlug: input.pageSlug,
    jobId: input.jobId,
  };
  const deliveryId = reviewDeliveryId(delivery);
  let analysis: IngestAnalysis | null = null;
  try {
    analysis = await loadIngestAnalysis(input.jobId);
  } catch (error) {
    await retainReviewDelivery(owner, delivery, error);
  }
  if (!analysis) {
    try {
      await rememberReviewOutbox(owner, delivery);
    } catch (outboxError) {
      logger.warn("review-queue", `outbox write failed for ${input.jobId}`, outboxError);
      throw new ReviewDeliveryUnretainedError("Review delivery was not retained");
    }
    return;
  }
  try {
    await enqueueReviewFromAnalysis(owner, {
      wikiId,
      pageSlug: input.pageSlug,
      analysis,
      deliveryId,
    });
  } catch (error) {
    await retainReviewDelivery(owner, delivery, error);
  }
}

export { wikiPath as reviewWikiPath };
