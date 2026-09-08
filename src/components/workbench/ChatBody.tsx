"use client";

// The default import is load-bearing under the node suite for the reason
// `PreviewBody` states: `jsx: "preserve"` sends vitest's esbuild transform down
// the classic runtime, which needs `React` in scope.
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import { Mermaid } from "@/components/Mermaid";
import { fencedCodeText } from "@/lib/markdown-fence";
import { urlTransform } from "@/lib/markdown-url";
import {
  CITATION_HREF_PREFIX,
  citationNumberFromHref,
  remarkChatCitations,
} from "@/lib/chat-markdown";

/**
 * A Chat answer, rendered (Story 7.8): GFM tables and code, Mermaid diagrams,
 * KaTeX math — and `[n]` still a button that docks the citation.
 *
 * THE TYPE LOCK IS WHY THIS IS NOT THE ARTICLE RENDERER. Chat stays on the
 * shell's chrome face; that component opens with a prose wrapper and is where
 * the article's reading treatment is applied. The face here comes from
 * `.wb-chat-body` in `globals.css` and from nothing in this file, exactly as
 * the Preview's comes from `.wb-preview-body`. What the two share with the
 * article is the mechanism — the same math plugins, the same `Mermaid`
 * boundary, the same fence walk — never the chrome.
 *
 * STREAMED AND SETTLED BODIES RENDER THROUGH THE SAME COMPONENT, so a diagram
 * does not appear only after the turn lands. A partial fence mid-stream simply
 * has not closed yet: react-markdown renders the text it has, and the diagram
 * appears on the token that closes the fence.
 */

export interface ChatBodyProps {
  content: string;
  /**
   * Dock the citation the owner clicked. Optional: a streamed body has no
   * citation list yet, and a marker that cannot resolve to anything renders as
   * text rather than as a button that does nothing.
   */
  onCite?: (n: number) => void;
}

/**
 * The app's URL policy plus the one scheme the citation pass just wrote.
 *
 * Without this react-markdown's sanitizer drops `citation:1` — it keeps only
 * schemes it recognises — and the plugin's own links would reach the renderer
 * with an empty href. The same shape as `previewUrlTransform`, for the same
 * reason.
 */
export function chatUrlTransform(url: string): string {
  return url.startsWith(CITATION_HREF_PREFIX) ? url : urlTransform(url);
}

export function ChatBody({ content, onCite }: ChatBodyProps) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath, remarkChatCitations]}
      rehypePlugins={[rehypeKatex]}
      urlTransform={chatUrlTransform}
      components={{
        // `node` is destructured out of every override for the reason
        // `PreviewBody` documents: spread onto a DOM element it emits a literal
        // `node="[object Object]"` attribute.
        a: ({ href, children, node: _node, ...props }) => {
          const n = citationNumberFromHref(href);
          if (n !== null) {
            // Still a BUTTON, and still `wb-chat-cite`: docking a citation
            // re-points the Preview column, it does not navigate.
            if (!onCite) return <span className="wb-chat-cite">{children}</span>;
            return (
              <button
                type="button"
                className="wb-chat-cite"
                onClick={() => onCite(n)}
              >
                {children}
              </button>
            );
          }
          const external =
            typeof href === "string" && /^(?:https?:)?\/\//i.test(href);
          return (
            <a
              href={href}
              {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
              {...props}
            >
              {children}
            </a>
          );
        },
        pre: ({ children, node: _node, ...props }) => {
          const chart = fencedCodeText(children, "mermaid");
          if (chart !== null) return <Mermaid chart={chart} />;
          return <pre {...props}>{children}</pre>;
        },
        table: ({ children, node: _node, ...props }) => (
          // The Chat canvas is narrower than a wide GFM table, so the table
          // scrolls inside its own box rather than widening the column — the
          // rule `PreviewBody` already keeps.
          <div className="wb-chat-table">
            <table {...props}>{children}</table>
          </div>
        ),
      }}
    >
      {content}
    </ReactMarkdown>
  );
}
