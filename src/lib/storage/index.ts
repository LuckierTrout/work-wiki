/**
 * Storage factory — returns the appropriate StorageProvider for the runtime.
 *
 * Detection logic:
 *   1. If `initCloudflareStorage(env)` was called, use R2 provider
 *   2. Explicit override: `STORAGE_PROVIDER=fs|cloudflare-r2`
 *   3. Cloudflare Workers runtime detection (globalThis.caches?.default)
 *   4. Default: filesystem provider
 *
 * For Cloudflare Workers, the bindings (`R2Bucket`, `KVNamespace`,
 * `VectorizeIndex`) are provided via the request `env` parameter.
 * Call `initCloudflareStorage(env)` once early in the request lifecycle
 * (e.g. middleware or layout) to inject them. After that, `getStorage()`
 * remains zero-arg for all consumers.
 */

import type { StorageProvider } from "./types";
import type { CloudflareEnv } from "./cloudflare-types";
import { getCloudflareContext } from "@opennextjs/cloudflare";
import { FilesystemStorageProvider } from "./filesystem";
import { R2StorageProvider } from "./r2";
import { getDataDir } from "../paths";

// ---------------------------------------------------------------------------
// Runtime detection
// ---------------------------------------------------------------------------

type ProviderType = "fs" | "cloudflare-r2";

/**
 * Detect which storage provider to use based on environment.
 *
 * Priority:
 *   1. STORAGE_PROVIDER env var (explicit override for testing / deployment)
 *   2. Cloudflare Workers runtime detection
 *   3. Fallback to filesystem
 */
function detectProvider(): ProviderType {
  // 1. Explicit override
  const override = typeof process !== "undefined" ? process.env?.STORAGE_PROVIDER : undefined;
  if (override === "fs" || override === "cloudflare-r2") {
    return override;
  }

  // 2. Cloudflare Workers runtime heuristic:
  //    Workers have a `caches.default` API that Node.js does not.
  if (
    typeof globalThis !== "undefined" &&
    typeof (globalThis as Record<string, unknown>).caches === "object" &&
    (globalThis as Record<string, unknown>).caches !== null &&
    typeof ((globalThis as Record<string, unknown>).caches as Record<string, unknown>).default === "object"
  ) {
    return "cloudflare-r2";
  }

  // 3. Default
  return "fs";
}

// ---------------------------------------------------------------------------
// Singleton management
// ---------------------------------------------------------------------------

let _instance: StorageProvider | null = null;
let _providerType: ProviderType | null = null;

function getOpenNextCloudflareEnv(): CloudflareEnv | null {
  try {
    const { env } = getCloudflareContext();
    if (
      env &&
      typeof env === "object" &&
      "YOPEDIA_BUCKET" in env &&
      "YOPEDIA_CONFIG" in env
    ) {
      return env as unknown as CloudflareEnv;
    }
  } catch {
    // Outside an OpenNext Cloudflare request context.
  }
  return null;
}

/**
 * Initialize the Cloudflare R2 storage provider with Workers bindings.
 *
 * Call this once early in the request lifecycle (e.g. middleware or layout)
 * before any code calls `getStorage()`. It creates the R2StorageProvider
 * and caches it in the singleton so all consumers get R2-backed storage.
 *
 * @param env — The Cloudflare Workers `env` object containing R2, KV,
 *              and Vectorize bindings
 * @returns The initialized R2StorageProvider
 */
export function initCloudflareStorage(env: CloudflareEnv): StorageProvider {
  const provider = new R2StorageProvider(env);
  _instance = provider;
  _providerType = "cloudflare-r2";
  return provider;
}

/**
 * Get the storage provider for the current runtime.
 *
 * Returns a singleton — the provider is created once and reused. This
 * matches the current codebase pattern where all modules share the same
 * filesystem root.
 *
 * If `initCloudflareStorage(env)` was called beforehand, this returns
 * the R2 provider. Otherwise it auto-detects based on environment.
 *
 * @throws if Cloudflare R2 is detected but `initCloudflareStorage` hasn't been called
 */
/** True when Pages and Sources live on this machine's disk, not R2. */
export function isFilesystemStorage(): boolean {
  return (_providerType ?? detectProvider()) === "fs";
}

export function getStorage(): StorageProvider {
  // If already initialized (e.g. via initCloudflareStorage), return it
  if (_instance) {
    return _instance;
  }

  const desired = detectProvider();

  switch (desired) {
    case "fs": {
      const provider = new FilesystemStorageProvider(getDataDir());
      _instance = provider;
      _providerType = desired;
      return provider;
    }

    case "cloudflare-r2": {
      const env = getOpenNextCloudflareEnv();
      if (env) {
        return initCloudflareStorage(env);
      }
      throw new Error(
        "Cloudflare R2 storage detected but not initialized. " +
        "Call initCloudflareStorage(env) before getStorage()."
      );
    }

    default: {
      const _exhaustive: never = desired;
      throw new Error(`Unknown storage provider: ${_exhaustive}`);
    }
  }
}

/**
 * Is `YOPEDIA_VECTORIZE` bound to this deployment?
 *
 * THE SAME BINDING `R2StorageProvider` HOLDS, read through the same
 * `getOpenNextCloudflareEnv()` the provider is constructed from — which is why
 * it lives here and not beside a caller. `YOPEDIA_VECTORIZE` is declared
 * OPTIONAL on `CloudflareEnv`, every vector call in `r2.ts` guards on it, and
 * nothing else in the codebase can answer the question: a deployment can resolve
 * Workers AI as its embedding provider and still have no index bound, so the
 * binding is a SECOND fact, never implied by the first.
 *
 * THREE ROUTES TO `false`, deliberately collapsed into one answer:
 *
 *   1. Not on Workers at all — `getCloudflareContext()` throws and the helper
 *      above swallows it.
 *   2. On Workers, but the env carries no `YOPEDIA_BUCKET`/`YOPEDIA_CONFIG` —
 *      `getOpenNextCloudflareEnv()` requires BOTH before it will claim the
 *      object is a `CloudflareEnv`, and without them `R2StorageProvider` cannot
 *      be constructed, so there is no deployment here that could use an index.
 *   3. On Workers with those two bound, and `YOPEDIA_VECTORIZE` simply absent.
 *
 * None of the three is an index this deployment can write to, and a caller that
 * needs to tell them apart has a different question than the one this answers.
 * It never throws, so a caller on any runtime gets a boolean rather than a
 * branch.
 *
 * ONE READ, with one caveat worth stating: `R2StorageProvider` can ALSO be built
 * from an env handed straight to `initCloudflareStorage(env)`, which this helper
 * never consults — so the two agree because every production caller reaches the
 * provider through the OpenNext context, not because the code makes divergence
 * impossible. No caller passes its own env today.
 */
export function hasVectorizeBinding(): boolean {
  return getOpenNextCloudflareEnv()?.YOPEDIA_VECTORIZE != null;
}

/**
 * Reset the singleton — useful for testing or provider hot-swap.
 * @internal
 */
export function _resetStorage(): void {
  _instance = null;
  _providerType = null;
}

/**
 * Get the current provider type — useful for diagnostics.
 * @internal
 */
export function _getProviderType(): ProviderType | null {
  return _providerType;
}

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------

export type {
  StorageProvider,
  FileInfo,
  FileWithEtag,
  FileEntry,
  EmbeddingEntry,
  EmbeddingMatch,
  EmbeddingFilter,
  EmbeddingQueryResult,
} from "./types";
export {
  ATOMIC_COUNTER_INDEX_KEYS,
  isAtomicCounterIndexKey,
} from "./types";

export type { CloudflareEnv } from "./cloudflare-types";
export { R2StorageProvider } from "./r2";
export { R2NotFoundError } from "./r2";
