/**
 * Which Search hits are IMAGES, and where their pixels come from (Story 7.7).
 *
 * Pure and client-safe: the canvas imports it in the browser and the node suite
 * executes every rule. Nothing here touches storage, auth or the DOM.
 *
 * WHY A PARTITION AND NOT A FLAG PER HIT. The search route answers one ranked
 * list, and the AC asks for an image SECTION beside the existing list — so
 * exactly one thing has to decide, once, which hits leave the list. A predicate
 * called twice (once to build the section, once to filter the list) is how a
 * hit comes to appear in both, or in neither.
 */

import { INTAKE_MEDIA_EXTENSIONS } from "./workbench-intake";
import { previewMediaUrl } from "./workbench-preview";
import type { SearchHit } from "./chat-contract";

/**
 * THE EXTENSION DECIDES, NOT THE DIRECTORY.
 *
 * `wiki/media/` and `raw/assets/` are the two roots the spec names as image
 * locations, and an earlier reading of that made membership of either root
 * sufficient. It is not: a `README.md` filed under `raw/assets/`, or the
 * caption sidecar an exporter drops beside a video, then became an `<img>`
 * pointing at bytes no browser can decode — a broken thumbnail in place of a
 * result the owner could have read. The roots are where images are EXPECTED to
 * live; {@link isImagePath} is what decides that one is.
 */

/** The first markdown image URL in a snippet, or null. */
export function snippetImageUrl(snippet: string): string | null {
  if (typeof snippet !== "string") return null;
  const match = /!\[[^\]]*\]\(\s*([^)\s]+)/.exec(snippet);
  return match ? match[1] : null;
}

/** Does this path name a browser-renderable image by extension? */
export function isImagePath(path: string): boolean {
  if (typeof path !== "string") return false;
  const name = path.slice(path.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return INTAKE_MEDIA_EXTENSIONS[name.slice(dot + 1)] === "image";
}

/**
 * Resolve a markdown image reference to something the browser can load.
 *
 * The same mapping the article renderer applies to an `![](assets/…)` — stored
 * assets are referenced by the relative path `assets/<slug>/<file>` and served
 * by `/api/assets/`. An absolute URL or a data URI is already loadable and is
 * left exactly as it is.
 */
export function resolveSearchImageSrc(ref: string): string {
  if (
    ref.startsWith("data:") ||
    ref.startsWith("http://") ||
    ref.startsWith("https://") ||
    ref.startsWith("/api/")
  ) {
    return ref;
  }
  const relative = ref.startsWith("raw/") ? ref.slice("raw/".length) : ref;
  if (relative.startsWith("assets/")) {
    return `/api/assets/${relative.slice("assets/".length)}`;
  }
  // Anything else that got this far is a path inside the owner's own tree, so
  // it goes through the gated media door rather than a public asset URL.
  return previewMediaUrl(ref);
}

export interface SearchImageHit {
  hit: SearchHit;
  /** Where the `<img>` points. Never empty — a hit with no src is not one. */
  src: string;
}

/**
 * Split one ranked list into the image section and the list that stays.
 *
 * RANK ORDER IS PRESERVED IN BOTH halves: the search route already ordered
 * these, and re-sorting either half here would quietly replace the ranker's
 * answer with this file's opinion.
 *
 * TWO KINDS OF HIT, AND THEY LEAVE THE LIST DIFFERENTLY:
 *
 *   - A hit whose PATH names an image IS the image. It moves to the section,
 *     because a row reading `diagram.png` with a one-line snippet is strictly
 *     worse than the picture.
 *   - A hit whose SNIPPET carries an `![](…)` is a PAGE that shows an image.
 *     It appears in BOTH halves: the words matched, so removing the row would
 *     delete a prose result the owner searched for and replace it with a
 *     thumbnail of a figure that happened to sit near the match.
 */
export function partitionSearchImages(hits: readonly SearchHit[]): {
  images: SearchImageHit[];
  rest: SearchHit[];
} {
  const images: SearchImageHit[] = [];
  const rest: SearchHit[] = [];
  for (const hit of hits) {
    const path = typeof hit.path === "string" ? hit.path : "";
    if (isImagePath(path)) {
      images.push({ hit, src: resolveSearchImageSrc(path) });
      continue;
    }
    const embedded = snippetImageUrl(hit.snippet ?? "");
    if (embedded) images.push({ hit, src: resolveSearchImageSrc(embedded) });
    rest.push(hit);
  }
  return { images, rest };
}

/** The section's heading. One string, so the pin and the pixels agree. */
export const SEARCH_IMAGES_HEADING = "Images";
