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
  /** @type {Map<string, {
   *   kind: string,
   *   payload: unknown,
   *   expiresAt: number,
   *   conversationId: string,
   *   wikiId: string,
   * }>} */
  const items = new Map();

  return {
    /**
     * Store one pause and return the id the client may hold.
     * @param {string} kind
     * @param {unknown} payload
     * @param {{ conversationId?: string, wikiId?: string }} [scope]
     */
    issue(kind, payload, scope = {}) {
      const capabilityId = id();
      items.set(capabilityId, {
        kind,
        payload,
        expiresAt: now() + ttlMs,
        conversationId:
          typeof scope.conversationId === "string" ? scope.conversationId : "",
        wikiId: typeof scope.wikiId === "string" ? scope.wikiId : "",
      });
      return capabilityId;
    },

    /**
     * Take the payload exactly once. Fabricated, replayed, expired,
     * cross-kind, or cross-scope ids return `null`.
     * @param {unknown} capabilityId
     * @param {string} kind
     * @param {{ conversationId?: string, wikiId?: string }} [scope]
     */
    consume(capabilityId, kind, scope = {}) {
      const taken = this.take(capabilityId, scope);
      if (!taken || taken.kind !== kind) return null;
      return taken.payload;
    },

    /**
     * Take any live ticket. Kind is checked by the caller so a resume
     * cannot invent `shell_approval` for a form pause. A ticket that
     * stored a conversation or Wiki only matches that same pair.
     * @param {unknown} capabilityId
     * @param {{ conversationId?: string, wikiId?: string }} [scope]
     */
    take(capabilityId, scope = {}) {
      if (typeof capabilityId !== "string" || capabilityId.length === 0) {
        return null;
      }
      const entry = items.get(capabilityId);
      if (!entry) return null;
      if (entry.expiresAt <= now()) {
        items.delete(capabilityId);
        return null;
      }
      const conversationId =
        typeof scope.conversationId === "string" ? scope.conversationId : "";
      const wikiId = typeof scope.wikiId === "string" ? scope.wikiId : "";
      // Compare unconditionally. A falsy stored conversationId used to skip
      // this check, so a ticket issued with no conversationId was resumable
      // from any conversation. Empty matches empty (unit tests); HTTP mints
      // a key when the body omits one. Scope mismatch must NOT burn the
      // ticket: a resume posted to the wrong Wiki would otherwise destroy
      // the owner's pending approval.
      if (entry.conversationId !== conversationId) return null;
      if (entry.wikiId !== wikiId) return null;
      items.delete(capabilityId);
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
