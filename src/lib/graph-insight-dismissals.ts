/**
 * Kernel SoR for dismissed Workbench Graph Insights.
 * Path: tenants/{t}/graph-insight-dismissals.json
 */

import { bumpDataVersion } from "./data-version";
import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { logger } from "./logger";
import { assertWritable, READ_ONLY_REFUSAL } from "./read-only";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";
import type { WorkbenchInsight } from "./graph-surprise";
export {
  MAX_INSIGHT_FINGERPRINT_LENGTH,
  MAX_INSIGHT_ID_LENGTH,
} from "./graph-insight-contract";
import {
  MAX_INSIGHT_FINGERPRINT_LENGTH,
  MAX_INSIGHT_ID_LENGTH,
} from "./graph-insight-contract";

export interface InsightDismissal {
  id: string;
  fingerprint: string;
  dismissedAt: string;
}

interface DismissalStore {
  items: InsightDismissal[];
}

const CAS_ATTEMPTS = 4;

function storePath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/graph-insight-dismissals.json`;
}

function lockKey(owner: string): string {
  return `graph-insight-dismissals:${tenantForOwner(owner)}`;
}

function emptyStore(): DismissalStore {
  return { items: [] };
}

export class CorruptDismissalStoreError extends Error {
  constructor(message = "Insight dismissal JSON is corrupt") {
    super(message);
    this.name = "CorruptDismissalStoreError";
  }
}

function isDismissal(value: unknown): value is InsightDismissal {
  if (!value || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.id === "string" &&
    typeof row.fingerprint === "string" &&
    typeof row.dismissedAt === "string" &&
    Number.isFinite(Date.parse(row.dismissedAt)) &&
    new Date(row.dismissedAt).toISOString() === row.dismissedAt
  );
}

function parseStore(raw: string): DismissalStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CorruptDismissalStoreError();
  }
  if (Array.isArray(parsed)) {
    if (!parsed.every(isDismissal)) throw new CorruptDismissalStoreError();
    return { items: parsed };
  }
  if (!parsed || typeof parsed !== "object") throw new CorruptDismissalStoreError();
  const items = (parsed as { items?: unknown }).items;
  if (!Array.isArray(items) || !items.every(isDismissal)) throw new CorruptDismissalStoreError();
  return { items };
}

async function quarantine(path: string, raw: string): Promise<void> {
  try {
    await getStorage().writeFileIfAbsent(`${path}.corrupt`, raw);
  } catch (error) {
    logger.warn("graph-insights", "failed to quarantine corrupt store", error);
  }
}

async function readStore(owner: string): Promise<DismissalStore> {
  const path = storePath(owner);
  const storage = getStorage();
  try {
    const raw = await storage.readFile(path);
    try {
      return parseStore(raw);
    } catch (error) {
      if (error instanceof CorruptDismissalStoreError) await quarantine(path, raw);
      throw error;
    }
  } catch (error) {
    if (isEnoent(error)) return emptyStore();
    throw error;
  }
}

async function withStore<T>(owner: string, mutate: (store: DismissalStore) => T): Promise<T> {
  const result = await withFileLock(lockKey(owner), async () => {
    const storage = getStorage();
    const path = storePath(owner);
    for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
      let store = emptyStore();
      let etag: string | null = null;
      try {
        const read = await storage.readFileWithEtag(path);
        etag = read.etag;
        try {
          store = parseStore(read.content);
        } catch (error) {
          if (error instanceof CorruptDismissalStoreError) await quarantine(path, read.content);
          throw error;
        }
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const draft: DismissalStore = { items: store.items.map((item) => ({ ...item })) };
      const value = mutate(draft);
      if (draft.items.length > 500) {
        draft.items = draft.items
          .slice()
          .sort((a, b) => b.dismissedAt.localeCompare(a.dismissedAt))
          .slice(0, 500);
      }
      const next = JSON.stringify(draft, null, 2);
      if (etag === null) {
        if (await storage.writeFileIfAbsent(path, next)) return value;
        continue;
      }
      if (await storage.writeFileIfMatch(path, next, etag)) return value;
    }
    throw new Error("Insight dismissals were busy; retry the request");
  });
  try {
    await bumpDataVersion();
  } catch (error) {
    logger.warn("graph-insights", "data-version bump failed after a dismissal write", error);
  }
  return result;
}

export async function listInsightDismissals(owner: string): Promise<InsightDismissal[]> {
  return (await readStore(owner)).items;
}

export async function insightDismissalMap(owner: string): Promise<Map<string, string>> {
  return new Map((await listInsightDismissals(owner)).map((item) => [item.id, item.fingerprint]));
}

/** Rewrite matching pre-hash fingerprints once, without resurfacing the Insight. */
function matchingInsight(
  item: InsightDismissal,
  insights: readonly Pick<
    WorkbenchInsight,
    "id" | "fingerprint" | "legacyFingerprint" | "legacyId"
  >[],
): Pick<WorkbenchInsight, "id" | "fingerprint"> | undefined {
  return insights.find((insight) =>
    insight.id === item.id ||
    insight.legacyId === item.id ||
    (insight.legacyFingerprint !== undefined && insight.legacyFingerprint === item.fingerprint),
  );
}

export async function reconcileLegacyInsightDismissals(
  owner: string,
  insights: readonly Pick<
    WorkbenchInsight,
    "id" | "fingerprint" | "legacyFingerprint" | "legacyId"
  >[],
): Promise<Map<string, string>> {
  const current = await readStore(owner);
  const needsMigration = current.items.some((item) => {
    const insight = matchingInsight(item, insights);
    return Boolean(
      insight && (item.id !== insight.id || item.fingerprint !== insight.fingerprint),
    );
  });
  if (!needsMigration) {
    return new Map(current.items.map((item) => [item.id, item.fingerprint]));
  }
  const migrated = await withStore(owner, (store) => {
    for (const item of store.items) {
      const insight = matchingInsight(item, insights);
      if (!insight) continue;
      item.id = insight.id;
      item.fingerprint = insight.fingerprint;
    }
    return store.items.map((item) => ({ ...item }));
  });
  return new Map(migrated.map((item) => [item.id, item.fingerprint]));
}

export async function dismissInsight(
  owner: string,
  id: string,
  fingerprint: string,
): Promise<InsightDismissal> {
  assertWritable(READ_ONLY_REFUSAL.graphInsightDismiss);
  if (!id.trim() || id.length > MAX_INSIGHT_ID_LENGTH) {
    throw new Error("Insight id is too long");
  }
  if (!fingerprint.trim() || fingerprint.length > MAX_INSIGHT_FINGERPRINT_LENGTH) {
    throw new Error("Insight fingerprint is too long");
  }
  const now = new Date().toISOString();
  return withStore(owner, (store) => {
    const existing = store.items.find((item) => item.id === id);
    if (existing) {
      existing.fingerprint = fingerprint;
      existing.dismissedAt = now;
      return existing;
    }
    const row: InsightDismissal = { id, fingerprint, dismissedAt: now };
    store.items.push(row);
    return row;
  });
}
