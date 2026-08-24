import { isEnoent } from "./errors";
import { withFileLock } from "./lock";
import { getStorage } from "./storage";
import { tenantForOwner, validateTenant } from "./wiki";

/**
 * The Deep Research concurrency lease: at most {@link MAX_CONCURRENT_RESEARCH}
 * runs per workspace at once, everything else queued.
 *
 * WHY A LEASE AND NOT A LOCK. `withDurableLock` is one holder — it is the AD-9
 * ingest compile lock's shape, and research deliberately does NOT take that
 * lock (a research run must not block ingest, and three research runs must not
 * serialise behind each other). This is a counted lease over the same
 * primitives: an in-process lock for same-isolate serialisation of the
 * read-modify-write, and a file the other isolates can see.
 *
 * WHY SLOTS EXPIRE. A run that dies between acquire and release — an isolate
 * evicted mid-flight, a queue delivery that never returns — would otherwise
 * hold a slot until someone edited a JSON file by hand, and three such deaths
 * would wedge Deep Research permanently with no surface to unwedge it from.
 * A TTL is what makes the failure self-healing; {@link renewResearchSlot} is
 * what keeps a long but LIVE run from being reaped by that same TTL.
 *
 * NOT LINEARIZABLE, and it does not need to be. `withDurableLock` says the same
 * of itself. R2 gives no compare-and-set here, so two isolates racing the
 * read-modify-write can both see two active slots and both take the third: the
 * ceiling can be exceeded by the number of racing isolates, briefly. The
 * ceiling exists to stop a burst of confirmations from opening twenty
 * simultaneous provider searches and twenty LLM syntheses, and it does that at
 * 3-or-occasionally-4 exactly as well as at a hard 3. What it must never do is
 * DROP a run, and it does not: a refused acquire queues.
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

interface ResearchSlot {
  projectId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface ResearchSlotGrant {
  granted: boolean;
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

/**
 * Read the lease file, dropping expired and malformed entries.
 *
 * A corrupt or unreadable file reads as EMPTY rather than throwing. The
 * alternative is refusing every research run on a workspace whose lease file
 * got mangled, which is a worse failure than briefly over-admitting: the file
 * holds no user data, it is rewritten by the next acquire, and the ceiling it
 * enforces is a throttle rather than a correctness invariant.
 */
async function readSlots(owner: string, now: number): Promise<ResearchSlot[]> {
  try {
    const parsed = JSON.parse(await getStorage().readFile(leasePath(owner)));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isSlot).filter((slot) => slot.expiresAt > now);
  } catch (error) {
    if (isEnoent(error)) return [];
    return [];
  }
}

async function writeSlots(owner: string, slots: ResearchSlot[]): Promise<void> {
  await getStorage().writeFile(leasePath(owner), JSON.stringify(slots, null, 2));
}

/**
 * Take a slot for `projectId`, or report that the workspace is at its ceiling.
 *
 * IDEMPOTENT PER PROJECT. A project that already holds a slot gets it RENEWED
 * and granted again rather than counted twice — Cloudflare Queues can deliver
 * the same task more than once, and a redelivery that consumed a second slot
 * would let one project eat the ceiling by itself.
 *
 * FAIL-OPEN on a storage fault, which is the same choice `readSlots` makes and
 * for the same reason: this is a throttle, and a workspace whose R2 is briefly
 * unwritable should still be able to research. The alternative refuses the
 * user's action to protect a counter.
 */
export async function acquireResearchSlot(
  owner: string,
  projectId: string,
): Promise<ResearchSlotGrant> {
  return withFileLock(lockKey(owner), async () => {
    const now = Date.now();
    const slots = await readSlots(owner, now);
    const existing = slots.find((slot) => slot.projectId === projectId);
    if (existing) {
      existing.expiresAt = now + RESEARCH_SLOT_TTL_MS;
      try {
        await writeSlots(owner, slots);
      } catch {
        // The slot is already ours; a failed renewal only shortens its life.
      }
      return { granted: true, active: slots.length, limit: MAX_CONCURRENT_RESEARCH };
    }
    if (slots.length >= MAX_CONCURRENT_RESEARCH) {
      return { granted: false, active: slots.length, limit: MAX_CONCURRENT_RESEARCH };
    }
    const next = [...slots, { projectId, acquiredAt: now, expiresAt: now + RESEARCH_SLOT_TTL_MS }];
    try {
      await writeSlots(owner, next);
    } catch {
      // Fail open — see the docblock.
    }
    return { granted: true, active: next.length, limit: MAX_CONCURRENT_RESEARCH };
  });
}

/** Push this project's slot expiry out. Called as a run makes progress. */
export async function renewResearchSlot(owner: string, projectId: string): Promise<void> {
  await withFileLock(lockKey(owner), async () => {
    const now = Date.now();
    const slots = await readSlots(owner, now);
    const existing = slots.find((slot) => slot.projectId === projectId);
    if (!existing) return;
    existing.expiresAt = now + RESEARCH_SLOT_TTL_MS;
    try {
      await writeSlots(owner, slots);
    } catch {
      // The TTL is the backstop.
    }
  });
}

/**
 * Give the slot back.
 *
 * Never throws: this runs in a `finally`, and a release that threw would
 * replace the run's real outcome — success or a useful error — with a storage
 * complaint about a counter. The TTL covers a release that does not land.
 */
export async function releaseResearchSlot(owner: string, projectId: string): Promise<void> {
  await withFileLock(lockKey(owner), async () => {
    const now = Date.now();
    const slots = await readSlots(owner, now);
    const next = slots.filter((slot) => slot.projectId !== projectId);
    if (next.length === slots.length) return;
    try {
      await writeSlots(owner, next);
    } catch {
      // The TTL is the backstop.
    }
  });
}

/** How many runs currently hold a slot, expired ones excluded. */
export async function activeResearchCount(owner: string): Promise<number> {
  return (await readSlots(owner, Date.now())).length;
}

/**
 * Is a LIVE run holding a slot for this project?
 *
 * The one honest signal that a project the store still calls `collecting` is
 * actually being worked on. False means either the run released the slot — so
 * the terminal status is already written — or the isolate died and the TTL
 * reaped it, which is the case `reconcileResearchProjects` turns into a visible
 * failure rather than a row that says "collecting" forever.
 */
export async function holdsResearchSlot(owner: string, projectId: string): Promise<boolean> {
  const slots = await readSlots(owner, Date.now());
  return slots.some((slot) => slot.projectId === projectId);
}
