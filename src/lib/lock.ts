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
let forceDurableLocksForTests = false;

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

/** Force the R2 lease path under the filesystem test provider. Test-only. */
export function _setDurableLocksForTests(enabled: boolean): void {
  forceDurableLocksForTests = enabled;
}

interface DurableLease {
  token: string;
  until: number;
}

interface LegacyDurableLease {
  until: number;
}

type ParsedDurableLease =
  | { kind: "current"; lease: DurableLease }
  | { kind: "legacy"; lease: LegacyDurableLease }
  | { kind: "invalid" };

const DURABLE_LOCK_CAS_ATTEMPTS = 64;
const DURABLE_LOCK_POLL_MAX_MS = 1_000;
const DURABLE_LOCK_WAIT_MAX_MS = 30 * 60 * 1000;

function parseDurableLease(raw: string): ParsedDurableLease {
  try {
    const value = JSON.parse(raw) as Partial<DurableLease>;
    if (!Number.isFinite(value.until)) return { kind: "invalid" };
    if (typeof value.token === "string" && value.token.length > 0) {
      return { kind: "current", lease: { token: value.token, until: value.until! } };
    }
    // Rolling-deploy compatibility with the original `{ until }` lease. An
    // active old worker still owns this key even though it cannot present a
    // token; after its deadline the CAS below may safely replace it.
    if (!("token" in value)) return { kind: "legacy", lease: { until: value.until! } };
    return { kind: "invalid" };
  } catch {
    return { kind: "invalid" };
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Durable owner-serial lease on top of the in-process lock.
 *
 * Same-isolate callers serialize through {@link withFileLock}. Cross-isolate
 * callers acquire and renew with provider compare-and-set operations, so a
 * raised queue concurrency cannot start two owner-scoped Ingest compiles. A
 * release CASes the lease to an expired tombstone instead of deleting it; that
 * prevents an old holder from deleting a newer holder's lease.
 */
export async function withDurableLock<T>(
  key: string,
  fn: () => Promise<T>,
  ttlMs = 15 * 60 * 1000,
): Promise<T> {
  const { getStorage, _getProviderType } = await import("./storage");
  const { isEnoent } = await import("./errors");
  const safe = key.replace(/[^a-zA-Z0-9._:-]/g, "_");
  // v1 used `locks/` for both tokenless and token leases. v2 has its own
  // namespace so a late tokenless holder cannot delete a replacement lease.
  const legacyRel = `locks/${safe}.json`;
  const rel = `locks-v2/${safe}.json`;

  return withFileLock(key, async () => {
    const storage = getStorage();
    // Local Next.js uses one process and is already serialized by the chain
    // above. The durable CAS lease is specifically for independent Workers
    // sharing R2; avoiding it on fs also avoids four fsyncs per wiki mutation.
    if (_getProviderType() !== "cloudflare-r2" && !forceDurableLocksForTests) {
      return fn();
    }
    const token = crypto.randomUUID();
    let acquired = false;
    const waitStartedAt = Date.now();

    for (let attempt = 0; attempt < DURABLE_LOCK_CAS_ATTEMPTS;) {
      const now = Date.now();
      let legacy: ParsedDurableLease | null = null;
      try {
        legacy = parseDurableLease((await storage.readFileWithEtag(legacyRel)).content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }
      if (legacy?.kind === "invalid") {
        throw new Error(`Durable lock ${key} is malformed; refusing an unsafe takeover`);
      }
      if (
        (legacy?.kind === "legacy" || legacy?.kind === "current")
        && legacy.lease.until > now
      ) {
        if (now - waitStartedAt >= DURABLE_LOCK_WAIT_MAX_MS) {
          throw new Error(`Legacy durable lock ${key} did not become available`);
        }
        await pause(Math.max(
          10,
          Math.min(DURABLE_LOCK_POLL_MAX_MS, legacy.lease.until - now),
        ));
        continue;
      }
      let etag: string | null = null;
      let parsed: ParsedDurableLease | null = null;
      try {
        const read = await storage.readFileWithEtag(rel);
        etag = read.etag;
        parsed = parseDurableLease(read.content);
      } catch (error) {
        if (!isEnoent(error)) throw error;
      }

      if (parsed?.kind === "invalid") {
        throw new Error(`Durable lock ${key} is malformed; refusing an unsafe takeover`);
      }
      if (parsed?.kind === "legacy") {
        throw new Error(`Durable lock ${key} is malformed; refusing an unsafe takeover`);
      }
      const until = parsed?.kind === "current"
        ? parsed.lease.until
        : 0;
      if (until > now) {
        if (now - waitStartedAt >= DURABLE_LOCK_WAIT_MAX_MS) {
          throw new Error(`Durable lock ${key} did not become available`);
        }
        await pause(Math.max(10, Math.min(DURABLE_LOCK_POLL_MAX_MS, until - now)));
        continue;
      }
      const body = JSON.stringify({ token, until: now + ttlMs });
      acquired = etag === null
        ? await storage.writeFileIfAbsent(rel, body)
        : await storage.writeFileIfMatch(rel, body, etag);
      if (acquired) break;
      attempt += 1;
      await pause(Math.min(10 * attempt, 100));
    }

    if (!acquired) throw new Error("ingest lock busy");

    let renewing = false;
    const heartbeat = setInterval(() => {
      if (renewing) return;
      renewing = true;
      void (async () => {
        try {
          const read = await storage.readFileWithEtag(rel);
          const current = parseDurableLease(read.content);
          if (current.kind !== "current" || current.lease.token !== token) return;
          await storage.writeFileIfMatch(
            rel,
            JSON.stringify({ token, until: Date.now() + ttlMs }),
            read.etag,
          );
        } catch {
          // Acquisition remains fail-closed until the current expiry. A later
          // heartbeat retries; TTL is the crash-recovery backstop.
        } finally {
          renewing = false;
        }
      })();
    }, Math.max(1_000, Math.floor(ttlMs / 3)));

    try {
      return await fn();
    } finally {
      clearInterval(heartbeat);
      try {
        const read = await storage.readFileWithEtag(rel);
        const current = parseDurableLease(read.content);
        if (current.kind === "current" && current.lease.token === token) {
          await storage.writeFileIfMatch(
            rel,
            JSON.stringify({ token, until: 0 }),
            read.etag,
          );
        }
      } catch (error) {
        if (!isEnoent(error)) {
          // Lease expiry is the backstop; never replace the callback outcome.
        }
      }
    }
  });
}
