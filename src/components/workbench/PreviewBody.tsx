"use client";

// The default import is load-bearing under the node test suite, not decoration:
// `tsconfig` sets `jsx: "preserve"` for Next, so vitest's esbuild transform
// falls back to the CLASSIC runtime and needs `React` in scope to render this
// file to a string. The app's long-form article renderer carries it for the
// same reason, which is why the house render-test precedent works at all.
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { urlTransform } from "@/lib/markdown-url";
import {
  WIKILINK_MISSING_COPY,
  type PreviewFormat,
} from "@/lib/workbench-preview";
import {
  WIKILINK_HREF_PREFIX,
  markdownLinkTarget,
  previewLinkKind,
  remarkWikilinks,
  resolveWikilink,
  wikilinkTargetFromHref,
} from "@/lib/workbench-wikilinks";

/**
 * The rendered Preview body: GFM plus `[[wikilinks]]`, and nothing else.
 *
 * Deliberately NOT the app's long-form article renderer, which wires KaTeX
 * unconditionally and reaches the diagram client boundary — both are Epic 7
 * Story 7.8's, and neither belongs in the Workbench chunk. So the plugin list
 * here is exactly `remarkGfm` and the wikilink pass, with no html-stage plugins
 * at all.
 *
 * The reading face is not named here: it is a `--wb-*` token applied by the
 * `.wb-preview-body` rules in `globals.css`, which is what keeps every file in
 * this directory free of a book face.
 */

export interface PreviewBodyProps {
  format: PreviewFormat;
  /** Markdown BODY — the route already stripped the YAML block. */
  content: string;
  /** The slug set a wikilink resolves against, derived from the Knowledge tree. */
  readableSlugs: ReadonlySet<string>;
  /** Re-points the shell's selection at a page. Never a route change. */
  onOpenPage: (slug: string) => void;
}

/**
 * The app's data-URI policy, extended by exactly one scheme.
 *
 * `urlTransform` defers to react-markdown's sanitizer, which drops any scheme it
 * does not recognise — including the one the wikilink pass just wrote. Without
 * this the plugin's own links would arrive at the renderer with an empty href.
 */
export function previewUrlTransform(url: string): string {
  return url.startsWith(WIKILINK_HREF_PREFIX) ? url : urlTransform(url);
}

export function PreviewBody({
  format,
  content,
  readableSlugs,
  onOpenPage,
}: PreviewBodyProps) {
  if (format === "text") {
    // Plain text is shown as it is, not parsed: a `.txt` source that happens to
    // contain `#` or `|` is not a heading or a table.
    return <pre className="wb-preview-plain">{content}</pre>;
  }

  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkWikilinks]}
      urlTransform={previewUrlTransform}
      components={{
        // `node` is react-markdown's own mdast handle. It is destructured out
        // of every override below because spreading it onto a DOM element emits
        // a literal `node="[object Object]"` attribute into the page.
        a: ({ href, children, node: _node, ...props }) => {
          // TWO forms reach the same treatment. `[[target]]` arrives on the
          // wikilink scheme; `[text](slug.md)` is the form the kernel itself
          // writes and `extractWikiLinks` parses, and left as an anchor it would
          // navigate the browser out of the Workbench to a URL that does not
          // exist. Both re-point the selection instead.
          const target =
            typeof href === "string"
              ? (wikilinkTargetFromHref(href) ?? markdownLinkTarget(href))
              : null;
          if (target === null) {
            const kind = previewLinkKind(href);
            if (kind === "inert") {
              // A same-tab jump out of the shell — a root-relative link to the
              // legacy article route, a relative source path, or an href the
              // sanitizer emptied. The story bans navigation from the Preview,
              // and unlike a wikilink there is nothing here to re-point the
              // selection AT, so the text stays and the anchor does not.
              return <span className="wb-preview-deadlink" {...props}>{children}</span>;
            }
            const external = kind === "external" && /^(?:https?:)?\/\//i.test(href as string);
            return (
              <a
                href={href}
                {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                {...props}
              >
                {children}
              </a>
            );
          }
          const { slug, exists } = resolveWikilink(target, readableSlugs);
          if (!exists) {
            // Non-interactive on purpose: a control that cannot do anything is
            // worse than text. The class carries the visible state and the
            // clipped span carries it for a screen reader.
            return (
              <span className="wb-wikilink wb-wikilink--missing">
                {children}
                <span className="wb-sr-only">{WIKILINK_MISSING_COPY}</span>
              </span>
            );
          }
          return (
            // A button, not an anchor: following this must re-point the shell's
            // selection, not navigate out of the Workbench to the article route.
            <button
              type="button"
              className="wb-wikilink"
              onClick={() => onOpenPage(slug)}
            >
              {children}
            </button>
          );
        },
        table: ({ children, node: _node, ...props }) => (
          // The column is 360px at its widest, so a GFM table has to be able to
          // scroll inside its own box rather than widening the shell.
          <div className="wb-preview-table">
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
