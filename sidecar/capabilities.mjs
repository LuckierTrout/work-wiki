/**
 * Server-owned pause tickets for Chat Agent resumes (Epic 8 retro F8-01).
 *
 * THE CLIENT NEVER SUPPLIES THE COMMAND. A resume body that carries
 * `pending.command` is display copy at best; the sidecar looks up a
 * single-use, unguessable capability id and runs only what it stored when
 * it paused. A caller that invents `{ approved: true, pending: { command } }`
 * gets `invalid_resume` and the process is not spawned.
 *
 * Imports nothing from `src/lib` (AD-6).
 */

import { randomBytes } from "node:crypto";

const DEFAULT_TTL_MS = 15 * 60 * 1000;

/**
 * @param {{
 *   ttlMs?: number,
 *   now?: () => number,
 *   id?: () => string,
 * }} [options]
 */
export function createCapabilityStore({
  ttlMs = DEFAULT_TTL_MS,
  now = Date.now,
  id = () => randomBytes(32).toString("hex"),
} = {}) {
  /** @type {Map<string, { kind: string, payload: unknown, expiresAt: number }>} */
  const items = new Map();

  return {
    /**
     * Store one pause and return the id the client may hold.
     * @param {string} kind
     * @param {unknown} payload
     */
    issue(kind, payload) {
      const capabilityId = id();
      items.set(capabilityId, {
        kind,
        payload,
        expiresAt: now() + ttlMs,
      });
      return capabilityId;
    },

    /**
     * Take the payload exactly once. Fabricated, replayed, expired, or
     * cross-kind ids return `null`.
     * @param {unknown} capabilityId
     * @param {string} kind
     */
    consume(capabilityId, kind) {
      const taken = this.take(capabilityId);
      if (!taken || taken.kind !== kind) return null;
      return taken.payload;
    },

    /**
     * Take any live ticket. Kind is checked by the caller so a resume
     * cannot invent `shell_approval` for a form pause.
     * @param {unknown} capabilityId
     */
    take(capabilityId) {
      if (typeof capabilityId !== "string" || capabilityId.length === 0) {
        return null;
      }
      const entry = items.get(capabilityId);
      items.delete(capabilityId);
      if (!entry) return null;
      if (entry.expiresAt <= now()) return null;
      return { kind: entry.kind, payload: entry.payload };
    },
  };
}

/**
 * What the owner-facing client may see. Transcript and prior tool rows stay
 * on the server; they are how a forged resume would reconstruct a turn.
 *
 * @param {Record<string, unknown>} pending
 * @param {string} capabilityId
 * @returns {Record<string, unknown>}
 */
export function publicPending(pending, capabilityId) {
  if (!pending || typeof pending !== "object") {
    return { capabilityId };
  }
  const {
    transcript: _transcript,
    toolCalls: _toolCalls,
    outputs: _outputs,
    rowSeed: _rowSeed,
    ...visible
  } = pending;
  return { ...visible, capabilityId };
}

/**
 * Per-conversation executable memory. Never read from the request body.
 */
export function createConversationApprovals() {
  /** @type {Map<string, Set<string>>} */
  const byConversation = new Map();

  return {
    /** @param {string} conversationId @param {string} key */
    remember(conversationId, key) {
      if (!conversationId || !key) return;
      const set = byConversation.get(conversationId) ?? new Set();
      set.add(key);
      byConversation.set(conversationId, set);
    },
    /** @param {string} conversationId */
    setFor(conversationId) {
      if (!conversationId) return new Set();
      let set = byConversation.get(conversationId);
      if (!set) {
        set = new Set();
        byConversation.set(conversationId, set);
      }
      return set;
    },
  };
}
