import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

/**
 * The Deep Research concurrency lease: at most {@link MAX_CONCURRENT_RESEARCH}
 * runs per workspace at once, everything else queued.
 *
 * LINEARIZABLE ADMISSION. Same-isolate callers serialize on {@link withFileLock}.
 * Cross-isolate callers race `readFileWithEtag` / `writeFileIfMatch`. A lost
 * compare-and-set retries; after the budget it refuses rather than granting a
 * slot the durable file never recorded. Unreadable or unwritable lease state
 * fails closed — a mangled counter must not admit a fourth search.
 *
 * WHY SLOTS EXPIRE. A run that dies between acquire and release would otherwise
 * hold a slot until someone edited a JSON file by hand. A TTL is what makes
 * that failure self-healing; {@link renewResearchSlot} keeps a long but live
 * run from being reaped by that same TTL.
 */

/** AD-18: at most three concurrent research runs per workspace. */
export const MAX_CONCURRENT_RESEARCH = 3;

/**
 * How long a slot survives without a renewal.
 *
 * Long enough that a slow multi-query run holding one is not reaped mid-search
 * even if it never renews, short enough that a workspace wedged by three dead
 * runs recovers inside a coffee break rather than needing an operator.
 */
export const RESEARCH_SLOT_TTL_MS = 10 * 60 * 1000;

const CAS_ATTEMPTS = 8;

export class ResearchLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResearchLeaseError";
  }
}

interface ResearchSlot {
  projectId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface ResearchSlotGrant {
  granted: boolean;
  /** True only when this call added the slot; false for an existing lease. */
  acquired: boolean;
  /** How many slots are held INCLUDING this one when granted. */
  active: number;
  limit: number;
}

function leasePath(owner: string): string {
  const tenant = tenantForOwner(owner);
  validateTenant(tenant);
  return `tenants/${tenant}/research-leases.json`;
}

function lockKey(owner: string): string {
  return `research-leases:${tenantForOwner(owner)}`;
}

function isSlot(value: unknown): value is ResearchSlot {
  if (!value || typeof value !== "object") return false;
  const slot = value as Record<string, unknown>;
  return (
    typeof slot.projectId === "string" &&
    typeof slot.acquiredAt === "number" &&
    typeof slot.expiresAt === "number"
  );
}

function parseSlots(raw: string, now: number): ResearchSlot[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ResearchLeaseError("Research lease file is unreadable.");
  }
  if (!Array.isArray(parsed)) {
    throw new ResearchLeaseError("Research lease file is not a list.");
  }
  if (!parsed.every(isSlot)) {
    throw new ResearchLeaseError("Research lease entry is invalid.");
  }
  return parsed.filter((slot) => slot.expiresAt > now);
}

/**
 * Compare-and-set mutation of the lease file.
 *
 * Exported so tests can race two callers without the in-process lock, which is
 * the cross-isolate shape Cloudflare Workers actually have.
 */
export async function applyResearchLeaseMutation<T>(
  owner: string,
  mutate: (slots: ResearchSlot[], now: number) => { slots: ResearchSlot[]; result: T },
): Promise<T> {
  const storage = getStorage();
  const path = leasePath(owner);
  let lastError: Error = new ResearchLeaseError("Research lease was busy; retry the request.");
  for (let attempt = 0; attempt < CAS_ATTEMPTS; attempt += 1) {
    const now = Date.now();
    let etag: string | null = null;
    let slots: ResearchSlot[] = [];
    try {
      const read = await storage.readFileWithEtag(path);
      etag = read.etag;
      slots = parseSlots(read.content, now);
    } catch (error) {
      if (error instanceof ResearchLeaseError) throw error;
      if (!isEnoent(error)) {
        throw new ResearchLeaseError("Research lease file could not be read.");
      }
    }
    const next = mutate(slots, now);
    const body = JSON.stringify(next.slots, null, 2);
    const wrote = etag === null
      ? await storage.writeFileIfAbsent(path, body)
      : await storage.writeFileIfMatch(path, body, etag);
    if (wrote) return next.result;
    lastError = new ResearchLeaseError("Research lease was busy; retry the request.");
  }
  throw lastError;
}

async function lockedMutation<T>(
  owner: string,
  mutate: (slots: ResearchSlot[], now: number) => { slots: ResearchSlot[]; result: T },
): Promise<T> {
  return withFileLock(lockKey(owner), () => applyResearchLeaseMutation(owner, mutate));
}

/**
 * Take a slot for `projectId`, or report that the workspace is at its ceiling.
 *
 * IDEMPOTENT PER PROJECT. A project that already holds a slot gets it renewed
 * and granted again rather than counted twice.
 *
 * FAIL-CLOSED on a storage fault: a grant the durable file never recorded is
 * how a fourth run starts.
 */
export async function acquireResearchSlot(
  owner: string,
  projectId: string,
): Promise<ResearchSlotGrant> {
  return lockedMutation<ResearchSlotGrant>(owner, (slots, now) => {
    const existing = slots.find((slot) => slot.projectId === projectId);
    if (existing) {
      existing.expiresAt = now + RESEARCH_SLOT_TTL_MS;
      return {
        slots,
        result: { granted: true, acquired: false, active: slots.length, limit: MAX_CONCURRENT_RESEARCH },
      };
    }
    if (slots.length >= MAX_CONCURRENT_RESEARCH) {
      return {
        slots,
        result: { granted: false, acquired: false, active: slots.length, limit: MAX_CONCURRENT_RESEARCH },
      };
    }
    const next = [
      ...slots,
      { projectId, acquiredAt: now, expiresAt: now + RESEARCH_SLOT_TTL_MS },
    ];
    return {
      slots: next,
      result: { granted: true, acquired: true, active: next.length, limit: MAX_CONCURRENT_RESEARCH },
    };
  });
}

/** Push this project's slot expiry out. Called as a run makes progress. */
export async function renewResearchSlot(owner: string, projectId: string): Promise<void> {
  await lockedMutation(owner, (slots, now) => {
    const existing = slots.find((slot) => slot.projectId === projectId);
    if (!existing) return { slots, result: undefined };
    existing.expiresAt = now + RESEARCH_SLOT_TTL_MS;
    return { slots, result: undefined };
  });
}

/**
 * Give the slot back.
 *
 * Never throws: this runs in a `finally`, and a release that threw would
 * replace the run's real outcome with a storage complaint about a counter.
 * The TTL covers a release that does not land.
 */
export async function releaseResearchSlot(owner: string, projectId: string): Promise<void> {
  try {
    await lockedMutation(owner, (slots) => {
      const next = slots.filter((slot) => slot.projectId !== projectId);
      return { slots: next, result: undefined };
    });
  } catch {
    // The TTL is the backstop.
  }
}

/** How many runs currently hold a slot, expired ones excluded. */
export async function activeResearchCount(owner: string): Promise<number> {
  const storage = getStorage();
  try {
    const read = await storage.readFileWithEtag(leasePath(owner));
    return parseSlots(read.content, Date.now()).length;
  } catch (error) {
    if (isEnoent(error)) return 0;
    throw error instanceof ResearchLeaseError
      ? error
      : new ResearchLeaseError("Research lease file could not be read.");
  }
}

/**
 * Is a live run holding a slot for this project?
 *
 * Unreadable lease state is treated as held: fail closed so reconcile cannot
 * reap a run whose counter it cannot read.
 */
export async function holdsResearchSlot(owner: string, projectId: string): Promise<boolean> {
  try {
    const storage = getStorage();
    const read = await storage.readFileWithEtag(leasePath(owner));
    return parseSlots(read.content, Date.now()).some((slot) => slot.projectId === projectId);
  } catch (error) {
    if (isEnoent(error)) return false;
    return true;
  }
}
