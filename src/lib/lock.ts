// ---------------------------------------------------------------------------
// In-process file-level write lock
// ---------------------------------------------------------------------------
//
// Prevents TOCTOU races on shared wiki files (index.md, log.md) when multiple
// concurrent requests (e.g. two browser tabs ingesting at the same time) hit
// the same Next.js server process.
//
// Design: a Map of promise chains keyed by an arbitrary string (typically a
// file path or logical resource name). Each call to `withFileLock(key, fn)`
// chains `fn` after the previous promise for that key, guaranteeing serial
// execution per key while allowing unrelated keys to proceed in parallel.
//
// Limitations:
// - In-process only — does not protect against multiple server processes
//   (which would require OS-level lockfiles). Next.js dev and single-instance
//   production deployments run a single process, so this covers the common case.
// - The map grows one entry per unique key and is never pruned. In practice
//   the wiki has very few shared files (index.md, log.md, cross-ref), so this
//   is not a concern.
// - NOT REENTRANT. `withFileLock(k, …)` chains onto whatever is already queued
//   for `k`, so taking the same key again from inside the callback waits on
//   itself forever. Code running under a lock writes through an UNLOCKED
//   internal putter instead (see `putWikiArtifact` in `wikis.ts` and
//   `putWorkspaceProfile` in `workspace-profile.ts`).
//
//   HOW AN UNLOCKED PUTTER PROVES THE HOLD (DW-139). `putWorkspaceProfile` is
//   exported and reached from another module, so "the caller is already holding
//   `wikis:<tenant>`" used to be a request in a docblock — an unlocked caller
//   compiled and ran. It now demands a `WikiLockHeld`, a token only
//   `withWikiLock` (`wiki-lock.ts`) can mint, so the hold is proved at COMPILE
//   time and the tenant the token names is checked at runtime. The token is
//   evidence, never a second acquisition: passing it takes no lock, and
//   `withFileLock` is still not reentrant.
//
// LOCK ORDERING — `wikis:<tenant>`:
//   This key is the OUTERMOST lock for Wiki state. It owns
//   `tenants/<t>/wikis.json` AND everything under `tenants/<t>/wikis/<id>/` —
//   `purpose.md`, `schema.md`, and that Wiki's `workspace-profile.json`. One
//   key covers all of it deliberately: the profile used to have its own
//   `workspace-profile:<tenant>` key, and holding that one inside
//   `wikis:<tenant>` let a Settings save interleave with a re-template and
//   leave `schema.md` naming one template while the profile named another.
//   Take it through `withWikiLock(owner, …)` rather than
//   `withFileLock(wikiLockKey(owner), …)` — one spelling in the repo, and the
//   only one that mints the token described above.
//   So: never take a second lock key while holding `wikis:<tenant>`. Effects
//   that need another key (`appendToLog` → "log.md", `bumpDataVersion` →
//   DATA_VERSION_LOCK) run AFTER it is released, fail-soft, once the bytes
//   have landed.
// ---------------------------------------------------------------------------

const locks = new Map<string, Promise<unknown>>();

/**
 * Execute `fn` while holding an in-process lock for `key`.
 *
 * If another call with the same key is already in flight, `fn` will wait
 * until that call settles (resolves or rejects) before starting. Calls
 * with different keys run concurrently.
 *
 * @param key  Logical lock name — typically a file path or resource id.
 * @param fn   Async function to execute under the lock.
 * @returns    The resolved value of `fn`.
 * @throws     Re-throws whatever `fn` throws, after releasing the lock.
 */
export async function withFileLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = locks.get(key) ?? Promise.resolve();

  // Chain fn after the previous holder. `then(fn, fn)` ensures fn runs
  // regardless of whether the previous holder resolved or rejected.
  const next = prev.then(fn, fn);

  // Store a silenced version on the chain so an unhandled-rejection
  // warning is never triggered on the *chain itself* (callers still get
  // the real rejection via the `next` they await).
  locks.set(key, next.catch(() => {}));

  return next;
}

/**
 * Reset all locks. **Test-only** — exported so tests can start with a clean
 * slate without leaking state between test files.
 */
export function _resetLocks(): void {
  locks.clear();
}
