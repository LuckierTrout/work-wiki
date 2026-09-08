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
let forceCloudflareMigrationGateForTests = false;

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

/** Exercise the Cloudflare rolling-deploy readiness gate on fs. Test-only. */
export function _setCloudflareMigrationGateForTests(enabled: boolean): void {
  forceCloudflareMigrationGateForTests = enabled;
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
    // Rolling-deploy compatibility with the original `{ until }` lease. A
    // tokenless old worker cannot prove release, so the migration bridge waits
    // for deletion even after its advertised deadline.
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
    const cloudflareMigrationGateApplies =
      _getProviderType() === "cloudflare-r2" || forceCloudflareMigrationGateForTests;
    if (
      cloudflareMigrationGateApplies
      && process.env.WORKWIKI_DURABLE_LOCK_V2_READY !== "1"
    ) {
      throw new Error(
        "Durable lock v2 is fail-closed until legacy Workers are drained; "
        + "set WORKWIKI_DURABLE_LOCK_V2_READY=1 only after the two-stage rollout",
      );
    }
    const token = crypto.randomUUID();
    const waitStartedAt = Date.now();
    const acquire = async (path: string, acceptsTokenlessLegacy: boolean): Promise<void> => {
      for (let attempt = 0; attempt < DURABLE_LOCK_CAS_ATTEMPTS;) {
        const now = Date.now();
        let etag: string | null = null;
        let parsed: ParsedDurableLease | null = null;
        try {
          const read = await storage.readFileWithEtag(path);
          etag = read.etag;
          parsed = parseDurableLease(read.content);
        } catch (error) {
          if (!isEnoent(error)) throw error;
        }
        if (parsed?.kind === "invalid" || (parsed?.kind === "legacy" && !acceptsTokenlessLegacy)) {
          throw new Error(`Durable lock ${key} is malformed; refusing an unsafe takeover`);
        }
        const until = parsed?.kind === "current" || parsed?.kind === "legacy"
          ? parsed.lease.until
          : 0;
        // The legacy namespace is the non-expiring migration/exclusivity
        // bridge. Never take over a positive lease there merely because its
        // heartbeat deadline passed: the callback may still be running after
        // a provider renewal failure, and taking over would overlap arbitrary
        // non-CAS index/log mutations. Normal release writes `until: 0`; a
        // crashed holder therefore fails closed for operator recovery.
        const legacyHolderStillOwnsPath = acceptsTokenlessLegacy
          && parsed !== null
          && parsed.lease.until !== 0;
        if (legacyHolderStillOwnsPath && until <= now) {
          // The bridge cannot be taken over safely: a renewal outage can leave
          // the original callback alive past this timestamp. Fail immediately
          // and visibly instead of overlapping it or making a request hang for
          // the full acquisition ceiling.
          throw new Error(
            `Durable lock ${key} expired without release; operator recovery required`,
          );
        }
        if (legacyHolderStillOwnsPath || until > now) {
          if (now - waitStartedAt >= DURABLE_LOCK_WAIT_MAX_MS) {
            throw new Error(`Durable lock ${key} did not become available`);
          }
          await pause(Math.max(10, Math.min(DURABLE_LOCK_POLL_MAX_MS, until - now)));
          continue;
        }
        const body = JSON.stringify({ token, until: now + ttlMs });
        const acquired = etag === null
          ? await storage.writeFileIfAbsent(path, body)
          : await storage.writeFileIfMatch(path, body, etag);
        if (acquired) return;
        attempt += 1;
        await pause(Math.min(10 * attempt, 100));
      }
      throw new Error("ingest lock busy");
    };

    const renew = async (path: string, recreateIfMissing: boolean): Promise<boolean> => {
      const body = JSON.stringify({ token, until: Date.now() + ttlMs });
      try {
        const read = await storage.readFileWithEtag(path);
        const current = parseDurableLease(read.content);
        if (current.kind !== "current" || current.lease.token !== token) return false;
        return storage.writeFileIfMatch(path, body, read.etag);
      } catch (error) {
        if (!isEnoent(error)) throw error;
        return recreateIfMissing ? storage.writeFileIfAbsent(path, body) : false;
      }
    };

    const release = async (path: string): Promise<void> => {
      try {
        const read = await storage.readFileWithEtag(path);
        const current = parseDurableLease(read.content);
        if (current.kind === "current" && current.lease.token === token) {
          await storage.writeFileIfMatch(path, JSON.stringify({ token, until: 0 }), read.etag);
        }
      } catch (error) {
        if (!isEnoent(error)) {
          // Lease expiry is the backstop; never replace the callback outcome.
        }
      }
    };

    // Fence the old namespace first. Once this CAS lands, a previously read v1
    // token lease cannot heartbeat with its stale etag while we acquire v2.
    // Keeping the bridge alive also makes old workers wait for this callback.
    await acquire(legacyRel, true);
    let acquiredV2 = false;

    let renewing = false;
    let heartbeatInFlight: Promise<void> = Promise.resolve();
    const runHeartbeat = (): void => {
      if (renewing) return;
      renewing = true;
      heartbeatInFlight = (async () => {
        try {
          await renew(legacyRel, true);
          if (acquiredV2) await renew(rel, false);
        } catch {
          // Acquisition remains fail-closed until the current expiry. A later
          // heartbeat retries; TTL is the crash-recovery backstop.
        } finally {
          renewing = false;
        }
      })();
    };
    let heartbeat = setInterval(runHeartbeat, Math.max(10, Math.floor(ttlMs / 3)));

    try {
      await acquire(rel, false);
      acquiredV2 = true;
      // A tokenless v1 holder can only delete rather than compare-and-delete.
      // Close that rolling-deploy window immediately before entry by restoring
      // and verifying the bridge. If another holder won it, fail closed.
      clearInterval(heartbeat);
      await heartbeatInFlight;
      if (!await renew(legacyRel, true) || !await renew(rel, false)) {
        throw new Error(`Durable lock ${key} lost its migration fence`);
      }
      heartbeat = setInterval(runHeartbeat, Math.max(10, Math.floor(ttlMs / 3)));
      return await fn();
    } finally {
      clearInterval(heartbeat);
      await heartbeatInFlight;
      if (acquiredV2) await release(rel);
      await release(legacyRel);
    }
  });
}
