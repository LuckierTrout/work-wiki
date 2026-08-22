/**
 * `[[wikilink]]` parsing and resolution for the Workbench Preview (Story 1.5).
 *
 * Pure and client-safe, like `workbench-tree.ts`: the Preview body imports it in
 * the browser and the node-environment suite executes every rule in it. Nothing
 * here touches storage, auth or the DOM.
 *
 * WHY A REMARK PLUGIN AND NOT A SOURCE REWRITE. Rewriting `[[x]]` to
 * `[x](wikilink:x)` in the markdown STRING before parsing is fewer lines, and it
 * corrupts every code fence that mentions the syntax — including this repo's own
 * docs, which do. mdast gives `code` and `inlineCode` their own node types, so a
 * transform that only visits `text` nodes cannot reach inside them. That is a
 * structural guarantee rather than a regex that has to be right about fences.
 *
 * NO NEW DEPENDENCY. The walk below is ~20 lines and replaces `unist-util-visit`
 * plus `@types/mdast`, neither of which this repo depends on directly. The node
 * shapes it touches (`type`, `value`, `children`, `url`) are the mdast fields
 * `react-markdown` already renders, declared structurally here.
 */

import { slugify } from "./slugify";

/**
 * The scheme a wikilink is carried on between the remark pass and the renderer.
 * A real URL scheme rather than a data attribute because a remark plugin can
 * only produce mdast, and mdast's one link shape is `url`.
 */
export const WIKILINK_HREF_PREFIX = "wikilink:";

/** One stretch of a text node: either literal text or a wikilink. */
export type WikilinkRun =
  | { kind: "text"; value: string }
  | { kind: "link"; target: string; label: string };

/**
 * `[[target]]` and `[[target|label]]` — target FIRST, label second, matching
 * what `src/lib/export.ts` emits.
 *
 * The character class excludes brackets so a run cannot straddle two links, and
 * so `[[a` (an unterminated opener) matches nothing at all.
 */
const WIKILINK_RE = /\[\[([^[\]]*)\]\]/g;

/**
 * Split one text run into literal text and wikilinks.
 *
 * A MALFORMED link is not a link: `[[]]`, `[[ | x ]]` (no target) and `[[a`
 * (unterminated) all come back as text, byte-for-byte as they went in. Silently
 * dropping the brackets would edit the owner's prose.
 */
export function parseWikilinkRuns(text: string): WikilinkRun[] {
  const runs: WikilinkRun[] = [];
  let cursor = 0;
  let pending = "";

  const flush = () => {
    if (pending) {
      runs.push({ kind: "text", value: pending });
      pending = "";
    }
  };

  WIKILINK_RE.lastIndex = 0;
  for (let match = WIKILINK_RE.exec(text); match; match = WIKILINK_RE.exec(text)) {
    const [whole, inner] = match;
    pending += text.slice(cursor, match.index);
    cursor = match.index + whole.length;

    const pipe = inner.indexOf("|");
    const target = (pipe === -1 ? inner : inner.slice(0, pipe)).trim();
    const label = (pipe === -1 ? inner : inner.slice(pipe + 1)).trim();
    if (!target) {
      // No target — keep the source text verbatim rather than emitting a link
      // to nowhere or eating the brackets.
      pending += whole;
      continue;
    }
    flush();
    runs.push({ kind: "link", target, label: label || target });
  }

  pending += text.slice(cursor);
  flush();
  // An empty input has no runs at all; every caller treats that as "nothing to
  // replace", which is the same answer as one empty text run.
  return runs;
}

/** Build the href a wikilink travels on. */
export function wikilinkHref(target: string): string {
  return `${WIKILINK_HREF_PREFIX}${encodeURIComponent(target)}`;
}

/**
 * The target behind a link href, or null when the href is an ordinary one.
 *
 * A malformed percent-escape falls back to the raw remainder instead of
 * throwing: the renderer is mid-render and a `URIError` there would blank the
 * whole body over one bad link.
 */
export function wikilinkTargetFromHref(href: string): string | null {
  if (typeof href !== "string" || !href.startsWith(WIKILINK_HREF_PREFIX)) return null;
  return decodeSafe(href.slice(WIKILINK_HREF_PREFIX.length));
}

/**
 * Percent-decode, or hand back the raw string when the escape is malformed.
 *
 * A `URIError` here would blank the whole body over one bad link, and the
 * renderer is mid-render when it would throw.
 */
function decodeSafe(raw: string): string {
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/**
 * The page a RELATIVE markdown link addresses, or null when the href is not one.
 *
 * `[text](slug.md)` is the form the kernel itself writes and `extractWikiLinks`
 * (`src/lib/links.ts:28`) parses, so it is the COMMON in-content link, not an
 * edge case — and left as an `<a href="alpha.md">` it navigates the browser off
 * the Workbench to a URL that does not exist. Treating it exactly like a
 * wikilink is what keeps the reader in one column, which is what the story's
 * "do not navigate" rule is for.
 *
 * Refused: anything carrying a scheme (`https:`, `mailto:`, `data:`), a
 * protocol-relative `//host`, a bare fragment, anything not ending `.md`, and
 * any directory a page does not live in (`raw/notes.md` is a source, not the
 * page `notes`). A query or fragment SUFFIX is dropped before the extension is
 * tested, so `./wiki/alpha.md#top` addresses `alpha`.
 *
 * The segment is percent-DECODED, because a link destination is a URL and most
 * editors escape a space in one: without this `[Alpha Beta](Alpha%20Beta.md)`
 * carries the target `Alpha%20Beta`, which `slugify` cannot map onto the page
 * `[[Alpha Beta]]` reaches. Two spellings of one link must resolve alike.
 */
export function markdownLinkTarget(href: string): string | null {
  if (typeof href !== "string" || href.length === 0) return null;
  // A scheme, a protocol-relative host, or a same-page anchor is not ours.
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith("//") || href.startsWith("#")) {
    return null;
  }
  const stripped = href.split(/[?#]/, 1)[0];
  if (!/\.md$/i.test(stripped)) return null;
  const cut = stripped.lastIndexOf("/");
  // The DIRECTORY has to be one a page can live in. `wiki/` is the tree's own
  // display path for a page and `./` is the same file's own directory, but
  // `raw/notes.md` is a SOURCE — and keeping only the last segment there would
  // resolve it against the page slug `notes`, opening an unrelated page (or
  // labelling a real file "(missing page)"). The kernel's own parser agrees:
  // `extractWikiLinks` reads `[x](raw/notes.md)` as the slug `raw/notes`, which
  // is no page either. Anything else falls through to `previewLinkKind`, which
  // renders it as text rather than as a control that lies about its target.
  const dir = (cut === -1 ? "" : stripped.slice(0, cut + 1)).toLowerCase();
  if (dir !== "" && dir !== "./" && dir !== "wiki/" && dir !== "./wiki/") return null;
  const segment = stripped.slice(cut + 1);
  const target = decodeSafe(segment.slice(0, -".md".length));
  return target.length > 0 ? target : null;
}

/**
 * How a link that is NOT one of ours should be rendered.
 *
 * `external` — a scheme or a protocol-relative host. Following it opens another
 * site in a NEW tab, so the Workbench is still there when the owner comes back.
 * `anchor` — a bare `#fragment`, which is what `remark-gfm` emits for a footnote
 * and its back-reference. It moves the caret inside the page already on screen.
 * `inert` — everything else, and the reason this function exists: a schemeless
 * relative path (`raw/scan.pdf`), a root-relative one (`/u/<handle>/<slug>`),
 * and an href the sanitizer emptied all navigate the SAME tab away from the
 * shell — `<a href>` to `/u/…` from the Preview by name, which the story forbids
 * for the same reason a wikilink is a button. So they render as text.
 *
 * `markdownLinkTarget` gets first refusal: a relative `.md` is a page, and a
 * page is a control, so only what that function declines reaches this one.
 */
export type PreviewLinkKind = "external" | "anchor" | "inert";

export function previewLinkKind(href: unknown): PreviewLinkKind {
  if (typeof href !== "string" || href.length === 0) return "inert";
  if (href.startsWith("#")) return "anchor";
  if (href.startsWith("//")) return "external";
  return /^[a-z][a-z0-9+.-]*:/i.test(href) ? "external" : "inert";
}

/**
 * Resolve a wikilink target against the slug set the client can actually read.
 *
 * `slugify` is the same function ingest used to name the page, so
 * `[[Alpha Beta]]` and `[[alpha-beta]]` address one page — which is what makes
 * a hand-written link work at all.
 */
export function resolveWikilink(
  target: string,
  readableSlugs: ReadonlySet<string>,
): { slug: string; exists: boolean } {
  const slug = slugify(target);
  return { slug, exists: slug.length > 0 && readableSlugs.has(slug) };
}

// ---------------------------------------------------------------------------
// The remark pass
// ---------------------------------------------------------------------------

/**
 * The mdast fields this transform reads. Structural rather than imported:
 * `@types/mdast` is not a dependency of this package, and the four fields below
 * are the whole contract — everything else on a node is carried through
 * untouched because nodes are mutated in place, never rebuilt.
 */
interface MdastNodeLike {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNodeLike[];
}

/** Ancestors whose descendants must not become links — no nested anchors. */
function suppressesLinks(type: string): boolean {
  return type === "link" || type === "linkReference";
}

function transformChildren(node: MdastNodeLike, inLink: boolean): void {
  const children = node.children;
  if (!Array.isArray(children)) return;
  const nested = inLink || suppressesLinks(node.type);

  const next: MdastNodeLike[] = [];
  let replaced = false;
  for (const child of children) {
    if (!nested && child.type === "text" && typeof child.value === "string") {
      const runs = parseWikilinkRuns(child.value);
      if (runs.some((run) => run.kind === "link")) {
        replaced = true;
        for (const run of runs) {
          next.push(
            run.kind === "text"
              ? { type: "text", value: run.value }
              : {
                  type: "link",
                  url: wikilinkHref(run.target),
                  children: [{ type: "text", value: run.label }],
                },
          );
        }
        continue;
      }
    }
    next.push(child);
    transformChildren(child, nested);
  }
  if (replaced) node.children = next;
}

/**
 * A unified/remark plugin that turns `[[target]]` runs inside mdast `text`
 * nodes into `link` nodes on the {@link WIKILINK_HREF_PREFIX} scheme.
 *
 * `code` and `inlineCode` carry their source in `value` and have no children,
 * so the walk never reaches them — that is the whole point (see the module
 * docblock). Text already inside a `link`/`linkReference` is left alone, because
 * an anchor inside an anchor is not renderable markup.
 *
 * The tree parameter is `unknown` on purpose: this file declares its own node
 * shape rather than depending on `unist`, and `unknown` is what keeps the
 * plugin assignable to react-markdown's `PluggableList` without one.
 */
export function remarkWikilinks() {
  return (tree: unknown): void => {
    if (tree && typeof tree === "object") {
      transformChildren(tree as MdastNodeLike, false);
    }
  };
}
