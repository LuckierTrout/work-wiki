import type { ReactNode } from "react";

/**
 * The text inside a fenced ` ```<lang> ` block, or null when the fence is not
 * that language.
 *
 * A fenced block reaches react-markdown's `pre` override as a `<code
 * class="language-<lang>">` nested inside it, so pulling the source back out is
 * a walk into the child's props rather than a read of `children`. Three
 * surfaces now need the same walk — the article renderer, the Workbench
 * Preview, and Chat (Story 7.8) — and each one uses it to decide whether to
 * render a Mermaid diagram instead of a code block.
 *
 * IT LIVES HERE, ALONE, FOR THAT REASON. Copied per surface, the three would
 * drift the first time react-markdown changed the shape it passes down, and
 * they would drift into the failure that looks like nothing: the diagram
 * silently renders as a code fence on whichever surface was not updated, with
 * no error anywhere. This module holds no JSX and no React import beyond the
 * type, so the Workbench chunk pays nothing for sharing it.
 */
export function fencedCodeText(children: ReactNode, lang: string): string | null {
  const child = Array.isArray(children) ? children[0] : children;
  if (child && typeof child === "object" && "props" in child) {
    const props = (child as { props?: { className?: unknown; children?: unknown } })
      .props;
    const cls = typeof props?.className === "string" ? props.className : "";
    if (new RegExp(`\\blanguage-${lang}\\b`).test(cls)) {
      // The trailing newline is the fence's own terminator, not content: left
      // on, Mermaid parses a blank final statement.
      return String(props?.children ?? "").replace(/\n$/, "");
    }
  }
  return null;
}
