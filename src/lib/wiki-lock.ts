/**
 * Proof that `wikis:<tenant>` is already held (DW-139).
 *
 * The Wiki lock covers `tenants/<t>/wikis.json` AND everything under
 * `tenants/<t>/wikis/<id>/`, and `withFileLock` is NOT reentrant — so code
 * running under the lock writes through UNLOCKED internal putters
 * (`putWikiArtifact` in `wikis.ts`, `putWorkspaceProfile` in
 * `workspace-profile.ts`). That arrangement was enforced by DOCBLOCK alone: an
 * exported putter taking `(owner, wikiId, …)` looks exactly like an ordinary
 * store call, so a caller that never took the lock compiled and ran, and the
 * torn interleave the lock exists to prevent came back with no test red.
 *
 * {@link WikiLockHeld} is what closes that. It is a BRAND, not a runtime
 * capability system: an interface keyed by a `unique symbol` this module does
 * not export, so no other module can spell the key and a forgery needs a
 * visible `as` cast. Only {@link withWikiLock} mints one, so a putter that
 * demands one cannot be reached without going through the lock — an unlocked
 * caller fails to COMPILE, which is the exposure DW-139 named.
 *
 * THE TOKEN IS NOT A SECOND ACQUISITION. Passing it takes no lock and releases
 * nothing; it is evidence carried down the call stack while the ONE
 * `withFileLock` call at the top of the operation is still in flight.
 * `withFileLock` remains non-reentrant and nothing here changes that — see the
 * header of `src/lib/lock.ts` for the ordering rule.
 *
 * IT IS ALSO NOT PERMANENT, and that is enforced rather than described. A
 * minted token is an ordinary value: captured in a closure, stored on a module
 * variable, or handed to a promise started inside the lock body and never
 * awaited, it outlives the critical section. A token that still satisfied the
 * check after the lock released would be a compile-time proof asserting exactly
 * what is no longer true — the DW-139 exposure again, now harder to see. So the
 * token carries a LIVENESS closure alongside the key, flipped false in a
 * `finally` once `withFileLock` settles, and {@link assertWikiLockHeld} refuses
 * a released token with its own message.
 *
 * The other value the token carries is the lock KEY, which buys the second
 * runtime mistake worth catching: a token minted for tenant A handed to a write
 * for tenant B.
 *
 * LAYERING: this module imports `lock.ts` and `wiki-paths.ts` and nothing else.
 * `wiki-paths.ts` is a storage-free leaf and must stay one — it never imports
 * back — so `wikis.ts` and `workspace-profile.ts` can both depend on this
 * without closing a cycle (see the diagram in `wiki-paths.ts`).
 */

import { withFileLock } from "./lock";
import { wikiLockKey } from "./wiki-paths";

/**
 * The brand key. Module-private ON PURPOSE — an importable symbol would let any
 * module build a `{ [KEY]: "wikis:t" }` object literal and satisfy the type
 * without ever taking the lock. `Symbol(...)` rather than `Symbol.for(...)` for
 * the same reason: a registry key is spellable from anywhere.
 */
const WIKI_LOCK_HELD = Symbol("wiki-lock-held");

/**
 * The liveness key. Separate from the brand so the token answers two different
 * questions — WHICH lock, and whether it is still held — with two different
 * refusals.
 */
const WIKI_LOCK_LIVE = Symbol("wiki-lock-live");

/**
 * Evidence that the caller is running inside `withWikiLock` for some owner.
 *
 * `[WIKI_LOCK_HELD]` is the held lock key (`wikis:<tenant>`), so the token names
 * WHICH tenant it proves; `[WIKI_LOCK_LIVE]` answers whether that hold is still
 * in force at the moment of the check. See {@link assertWikiLockHeld}.
 */
export interface WikiLockHeld {
  readonly [WIKI_LOCK_HELD]: string;
  readonly [WIKI_LOCK_LIVE]: () => boolean;
}

/**
 * Run `fn` while holding `wikis:<tenant>`, handing it the proof.
 *
 * The ONE sanctioned spelling of the Wiki lock: `wikis.ts` and
 * `workspace-profile.ts` both go through it rather than calling
 * `withFileLock(wikiLockKey(owner), …)` directly, and
 * `wikis.test.ts` scans `src/` to keep it that way — so no non-test module
 * takes the key without minting a token a nested putter can demand.
 *
 * The token is frozen so a callee cannot re-point it at another tenant's key
 * and then pass it on. `live` is deliberately OUTSIDE the frozen object: the
 * token exposes a reader, not the flag, so nothing downstream can revive a
 * token this function has retired.
 *
 * `await` and `finally` rather than a bare `return`: the flag has to flip after
 * `withFileLock` SETTLES, on the throwing path as much as the resolving one —
 * a rejected body releases the lock just the same, and a token that stayed live
 * across a failure is the one most likely to be reused by a retry.
 */
export async function withWikiLock<T>(
  owner: string,
  fn: (held: WikiLockHeld) => Promise<T>,
): Promise<T> {
  const key = wikiLockKey(owner);
  let live = true;
  const held: WikiLockHeld = Object.freeze({
    [WIKI_LOCK_HELD]: key,
    [WIKI_LOCK_LIVE]: () => live,
  });
  try {
    return await withFileLock(key, () => fn(held));
  } finally {
    live = false;
  }
}

/**
 * Refuse a write whose token is for a DIFFERENT tenant, or no longer held.
 *
 * The type system proves "a Wiki lock token exists here". These are the two
 * things it cannot prove, and they fail differently on purpose — the fix for
 * each is different, and one message covering both would name neither:
 *
 *   - WRONG TENANT. A token minted by `withWikiLock("other")` passed to a write
 *     for `owner` would serialize against the wrong key and let two tenants'
 *     operations interleave on one directory.
 *   - RELEASED. A token that escaped its critical section — captured in a
 *     closure, or carried by a promise started inside the body and never
 *     awaited — proves nothing about the present moment, and the write it
 *     authorizes would run with no lock held at all.
 *
 * Order matters: the tenant check runs first, so a token that is both foreign
 * and stale reports the foreign key rather than sending the caller after a
 * lifetime bug in the wrong tenant's code.
 *
 * Throws a plain `Error`: these are programming mistakes in the caller, not
 * input a user can supply, so there is no client-facing sentence to own.
 */
export function assertWikiLockHeld(held: WikiLockHeld, owner: string): void {
  const expected = wikiLockKey(owner);
  const actual = held?.[WIKI_LOCK_HELD];
  if (actual !== expected) {
    throw new Error(
      `wiki lock proof mismatch: holding "${String(actual)}", need "${expected}"`,
    );
  }
  if (held[WIKI_LOCK_LIVE]?.() !== true) {
    throw new Error(
      `wiki lock proof expired: "${expected}" was released before this write`,
    );
  }
}
