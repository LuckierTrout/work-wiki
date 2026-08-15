"use client";

import {
  findFileNode,
  findKnowledgePage,
  type FileNode,
  type KnowledgeGroup,
  type TreeSelection,
} from "@/lib/workbench-tree";

/**
 * The docked Preview column — header and frontmatter strip only.
 *
 * `mockups/chat-cited.html:194-208` splits Preview into three parts: `header`,
 * `.fm`, and `.body`. UX-DR2 draws the type line at exactly the same seam — the
 * chrome face for the header and frontmatter, the book face for the body. This
 * story ships the two halves it already has the data for (the page index and
 * the file path) and leaves `.body` to Story 1.5, which owns GFM, wikilinks,
 * the reading face and the confirm-gated markdown escape hatch. That way
 * "selecting a row docks the Preview column" is observably true without this
 * story rendering a line of markdown or inventing placeholder copy 1.5 would
 * delete.
 *
 * The field names below are the page's own frontmatter keys, not authored
 * labels — the same convention the mockup's `.fm` block uses.
 */

export interface PreviewColumnProps {
  selection: TreeSelection | null;
  knowledge: readonly KnowledgeGroup[];
  files: readonly FileNode[];
}

export function PreviewColumn({ selection, knowledge, files }: PreviewColumnProps) {
  if (!selection) return null;

  if (selection.kind === "page") {
    const page = findKnowledgePage(knowledge, selection.slug);
    // A selection can outlive its page (a refresh that dropped it). The slug is
    // still a true statement about what the owner picked, so it stands in for
    // the title rather than blanking the column.
    const name = page?.title ?? selection.slug;
    return (
      <Frame name={name}>
        {/* No `title:` row — the header above already carries it, and printing
            it twice one line apart reads as two different fields. */}
        <p className="wb-preview-fm-row">
          <code className="wb-preview-path">wiki/{selection.slug}.md</code>
        </p>
        {page?.type && <p className="wb-preview-fm-row">type: {page.type}</p>}
        {page?.updated && <p className="wb-preview-fm-row">updated: {page.updated}</p>}
        {typeof page?.sourceCount === "number" && (
          <p className="wb-preview-fm-row">sources: {page.sourceCount}</p>
        )}
      </Frame>
    );
  }

  const node = findFileNode(files, selection.path);
  // `||`, not `??`: `"a/b/".split("/").at(-1)` is the empty string, not
  // `undefined`, so a nullish fallback would leave the header blank.
  const name = node?.name || selection.path.split("/").filter(Boolean).at(-1) || selection.path;
  return (
    <Frame name={name}>
      <p className="wb-preview-fm-row">
        <code className="wb-preview-path">{selection.path}</code>
      </p>
    </Frame>
  );
}

function Frame({ name, children }: { name: string; children: React.ReactNode }) {
  return (
    <aside className="wb-preview" aria-label="Preview" data-no-localize>
      <header className="wb-preview-head">
        <strong className="wb-preview-title">Preview</strong>
        <span className="wb-preview-name">{name}</span>
      </header>
      <div className="wb-preview-fm">{children}</div>
    </aside>
  );
}
