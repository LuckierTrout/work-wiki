"use client";

import { useEffect, useState } from "react";
import { resolveSlugPath, type SlugTenantMap } from "@/lib/links";

// Session-level cache so the slug→tenant map is fetched at most once across all
// components that use it (search, query sources, lint, batch, ingest).
let cache: SlugTenantMap | null = null;
let inflight: Promise<SlugTenantMap> | null = null;

/**
 * Fetch the readability-gated slug→tenant map from `/api/wiki/routes`.
 * Concurrent callers share the in-flight request and later callers get the
 * cached map. Any failure resolves to `{}` so link building degrades to the
 * DEFAULT_TENANT fallback href instead of breaking, and ALL failure modes are
 * SYMMETRIC: a rejected fetch, a non-OK response and a malformed body each
 * return `{}` WITHOUT caching it, so the next caller retries. A non-OK response
 * therefore throws into the shared `.catch` rather than substituting `{}`
 * inside the chain — otherwise one transient 401/429/500 would pin every
 * in-content link to the DEFAULT_TENANT form (and its extra 308 hop) until a
 * full page reload.
 *
 * Only a successful map is cached; that also means an empty map from a viewer
 * with no readable pages is a legitimate `{}` and caches normally. Exported
 * (rather than kept as a private closure) so the caching contract is directly
 * testable.
 */
export function loadSlugTenants(): Promise<SlugTenantMap> {
  if (cache) return Promise.resolve(cache);
  if (!inflight) {
    inflight = fetch("/api/wiki/routes")
      .then((r) => {
        if (!r.ok) throw new Error(`/api/wiki/routes responded ${r.status}`);
        return r.json();
      })
      .then((parsed: unknown) => {
        // `r.json()` is `any` — the response body is not a typed map just
        // because the route declares one. A `null` body would cache falsy, so
        // `if (cache)` would miss it and EVERY caller would re-fetch forever;
        // an array or a scalar would cache and be handed to every renderer,
        // where `resolveSlugPath`'s own-property guard is the only thing left
        // standing between it and the page. Treat anything that isn't a plain
        // object like the other failure modes: `{}` back, nothing cached.
        if (
          typeof parsed !== "object" ||
          parsed === null ||
          Array.isArray(parsed)
        ) {
          throw new Error("/api/wiki/routes returned a non-object body");
        }
        const m = parsed as SlugTenantMap;
        cache = m;
        return m;
      })
      .catch(() => ({}) as SlugTenantMap)
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

/**
 * Pure map→href resolution: the canonical `/u/<tenant>/<slug>` when the map
 * knows the slug's tenant, else the DEFAULT_TENANT form (which 308-redirects
 * to canonical). Split out of the hook so the load-bearing mapping is directly
 * testable without a renderer.
 */
export function hrefFromMap(map: SlugTenantMap, slug: string): string {
  return resolveSlugPath(slug, map, "");
}

/**
 * Resolve a target slug to its canonical `/u/<tenant>/<slug>` href on the
 * client. Falls back to the default tenant (which 308-redirects to canonical)
 * while the map is loading or for an unknown slug — so links always work, just
 * with one redirect hop in the fallback case.
 *
 * Also exposes the raw `slugTenants` map so callers can hand it to
 * `MarkdownRenderer` (its `slugTenants` prop), letting in-content wikilinks
 * resolve to canonical owner-scoped URLs the same way.
 */
export function useSlugTenants() {
  const [map, setMap] = useState<SlugTenantMap>(cache ?? {});
  useEffect(() => {
    let on = true;
    loadSlugTenants().then((m) => {
      if (on) setMap(m);
    });
    return () => {
      on = false;
    };
  }, []);
  const hrefForSlug = (slug: string): string => hrefFromMap(map, slug);
  return { hrefForSlug, slugTenants: map };
}
