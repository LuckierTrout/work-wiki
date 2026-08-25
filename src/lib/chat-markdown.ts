/**
 * How a Chat answer becomes markup (Story 7.8).
 *
 * Until now an assistant body was rendered as plain text split on `[n]`, so a
 * table arrived as pipes, a Mermaid fence arrived as three backticks and a
 * line of `graph TD`, and `$E=mc^2$` arrived as dollar signs. This module is
 * the half of the fix that has no JSX in it: the `[n]` → citation transform,
 * expressed as a remark pass so it composes with GFM, math and everything else
 * instead of being a `String.split` that runs first and wins.
 *
 * WHY A REMARK PASS AND NOT THE SPLIT. The split cannot survive markdown:
 * `content.split(/(\[[1-9]\d*\])/)` cuts the STRING, so by the time the pieces
 * exist there is no document left to parse — a table straddling a citation is
 * two half-tables. Worse, it reaches inside code: an answer that quotes
 * `arr[1]` in a fence had the `[1]` turned into a button. mdast gives `code`
 * and `inlineCode` their own node types with no children, so a walk that only
 * visits `text` nodes cannot reach into either. That is the same structural
 * guarantee `remarkWikilinks` relies on, and this file deliberately mirrors it
 * rather than inventing a second shape for the same idea.
 *
 * Pure and client-safe. The node suite executes every rule here; the component
 * only maps a citation node to a button.
 */

/**
 * The scheme a citation is carried on between the remark pass and the renderer.
 * A URL scheme rather than a data attribute for the reason `WIKILINK_HREF_PREFIX`
 * documents: a remark plugin can only produce mdast, and mdast's one link shape
 * is `url`.
 */
export const CITATION_HREF_PREFIX = "citation:";

/**
 * `[1]`, `[12]` — the marker the Chat prompt asks the model for, and the same
 * shape `sanitizeCitedAnswer` validates. No leading zero, so `[01]` is prose.
 */
const CITATION_RE = /\[([1-9]\d*)\]/g;

/** One stretch of a text node: either literal text or a citation marker. */
export type CitationRun =
  | { kind: "text"; value: string }
  | { kind: "cite"; n: number };

/** Split one text run into literal text and citation markers. */
export function parseCitationRuns(text: string): CitationRun[] {
  const runs: CitationRun[] = [];
  let cursor = 0;
  let pending = "";

  const flush = () => {
    if (pending) {
      runs.push({ kind: "text", value: pending });
      pending = "";
    }
  };

  CITATION_RE.lastIndex = 0;
  for (let match = CITATION_RE.exec(text); match; match = CITATION_RE.exec(text)) {
    pending += text.slice(cursor, match.index);
    cursor = match.index + match[0].length;
    flush();
    runs.push({ kind: "cite", n: Number(match[1]) });
  }
  pending += text.slice(cursor);
  flush();
  return runs;
}

export function citationHref(n: number): string {
  return `${CITATION_HREF_PREFIX}${n}`;
}

/**
 * The number behind a citation href, or null when the href is an ordinary one.
 *
 * Refuses anything that is not a bare positive integer, so a body that happens
 * to contain a literal `citation:` link cannot be mistaken for one of ours.
 */
export function citationNumberFromHref(href: unknown): number | null {
  if (typeof href !== "string" || !href.startsWith(CITATION_HREF_PREFIX)) return null;
  const rest = href.slice(CITATION_HREF_PREFIX.length);
  if (!/^[1-9]\d*$/.test(rest)) return null;
  return Number(rest);
}

/**
 * The mdast fields this transform reads — structural rather than imported, for
 * the reason `workbench-wikilinks.ts` gives: `@types/mdast` is not a dependency
 * and these four fields are the whole contract.
 */
interface MdastNodeLike {
  type: string;
  value?: string;
  url?: string;
  children?: MdastNodeLike[];
}

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
      const runs = parseCitationRuns(child.value);
      if (runs.some((run) => run.kind === "cite")) {
        replaced = true;
        for (const run of runs) {
          next.push(
            run.kind === "text"
              ? { type: "text", value: run.value }
              : {
                  type: "link",
                  url: citationHref(run.n),
                  // The LABEL keeps the brackets, because the brackets are what
                  // a reader recognises as a citation. The button's text is
                  // this, so what is on screen is byte-identical to what the
                  // old split rendered.
                  children: [{ type: "text", value: `[${run.n}]` }],
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
 * A unified/remark plugin turning `[n]` runs inside mdast `text` nodes into
 * `link` nodes on the {@link CITATION_HREF_PREFIX} scheme.
 *
 * The tree parameter is `unknown` on purpose — see `remarkWikilinks`.
 */
export function remarkChatCitations() {
  return (tree: unknown): void => {
    if (tree && typeof tree === "object") {
      transformChildren(tree as MdastNodeLike, false);
    }
  };
}
