/**
 * Small, pure markdown text helpers shared across render surfaces.
 */

/**
 * Strip a body's own leading `# Title` (an ATX H1) so a caller that renders the
 * title separately (from frontmatter) doesn't show it twice. Anchored to the
 * START of the body — only a genuine leading title is removed, NOT a `# ` that
 * appears later as a section heading. `##`/`###` and `#no-space` are left alone.
 */
export function stripLeadingH1(body: string): string {
  return body.replace(/^\s*#[ \t]+.+(?:\r?\n)?/, "");
}

/**
 * Strip a leading YAML frontmatter block (`---` … `---`) and the blank line
 * after it, returning the input unchanged when there is no TERMINATED block.
 *
 * Shared by the Workbench Preview route and the confirm-gated editor, so the
 * string the owner reads is byte-identical to the string they edit and to the
 * one `PUT /api/wiki/[slug]` expects — that route documents `content` as "the
 * new markdown **body** (no YAML frontmatter)" and owns frontmatter end-to-end
 * (it merges `updated`, appends the contributor and re-serializes). Handing it
 * a full file would double the block.
 *
 * NOT the only frontmatter stripper in the tree: `MarkdownRenderer.tsx` carries
 * its own private `stripFrontmatter` with a different regex (it requires the
 * block to be `\n`-terminated and does not treat an unterminated opener as
 * content). The two are deliberately not unified — the article renderer is a
 * live surface on another route and changing what it strips would change what
 * it shows — so this one governs the Workbench and that one governs `/u/…`.
 *
 * Deliberately never throws and never partially strips: an UNTERMINATED opener
 * is content, not frontmatter — a body that happens to start with a horizontal
 * rule must survive the round trip verbatim rather than losing its first half.
 */
export function stripFrontmatterBlock(content: string): string {
  if (typeof content !== "string") return "";
  return content.replace(
    /^---[ \t]*\r?\n(?:[\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)(?:\r?\n)?/,
    "",
  );
}
