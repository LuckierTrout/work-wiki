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

function parseStore(raw: string): DismissalStore {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return emptyStore();
    const items = Array.isArray((parsed as { items?: unknown }).items)
      ? (parsed as { items: unknown[] }).items
      : Array.isArray(parsed)
        ? parsed
        : [];
    return {
      items: items.filter((item): item is InsightDismissal => {
        if (!item || typeof item !== "object") return false;
        const row = item as Record<string, unknown>;
        return (
          typeof row.id === "string" &&
          typeof row.fingerprint === "string" &&
          typeof row.dismissedAt === "string"
        );
      }),
    };
  } catch {
    return emptyStore();
  }
}

async function readStore(owner: string): Promise<DismissalStore> {
  try {
    return parseStore(await getStorage().readFile(storePath(owner)));
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
        store = parseStore(read.content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      const draft: DismissalStore = { items: store.items.map((item) => ({ ...item })) };
      const value = mutate(draft);
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

export async function dismissInsight(
  owner: string,
  id: string,
  fingerprint: string,
): Promise<InsightDismissal> {
  assertWritable(READ_ONLY_REFUSAL.graphInsightDismiss);
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
