import { slugify } from "./slugify";
import { sourceSha256 } from "./source-sha256";

/** The research Page's slug. Flat, because only `queries/` may nest. */
export function researchPageSlug(project: { title: string; id: string }): string {
  const title = slugify(project.title) || "untitled";
  return `research-${title}-${shortDigest(project.id)}`;
}

/**
 * A short, stable digest for the Page id suffix. FNV-1a, hex, 8 characters.
 * Not a security boundary — nothing authenticates on this value.
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
export async function researchSourceSlug(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  parsed.hash = "";
  const normalized = parsed.href;
  const base = slugify(`${parsed.host}${parsed.pathname}`).slice(0, 80).replace(/-+$/, "");
  if (!base) return null;
  return `research-${base}-${(await sourceSha256(normalized)).slice(0, 20)}`;
}
