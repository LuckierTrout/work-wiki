import { slugify } from "./slugify";

/** The research Page's slug. Flat, because only `queries/` may nest. */
export function researchPageSlug(project: { title: string; id: string }): string {
  const title = slugify(project.title) || "untitled";
  return `research-${title}-${shortDigest(project.id)}`;
}

/**
 * A short, stable, sync digest of a string. FNV-1a, hex, 8 characters.
 *
 * Sync on purpose: {@link researchSourceSlug} is called from a `map` and from
 * assertions, and `crypto.subtle.digest` would make the slug async everywhere to
 * disambiguate a query string. Not a security boundary — nothing authenticates
 * on this value, it only has to differ when its input differs.
 */
function shortDigest(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/**
 * The Source slug for one fetched URL: derived from the URL, not the run.
 *
 * THE QUERY STRING COUNTS. Host and path alone collided every URL that carries
 * its identity in the query onto one slug, and because `saveRawSourceFor` is
 * first-write-only the second document silently kept the first one's body.
 */
export function researchSourceSlug(url: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const base = slugify(`${parsed.hostname}${parsed.pathname}`).slice(0, 80).replace(/-+$/, "");
  if (!base) return null;
  return parsed.search ? `research-${base}-${shortDigest(parsed.search)}` : `research-${base}`;
}
