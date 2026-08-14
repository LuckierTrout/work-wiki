import type { IndexEntry } from "./types";
import { commonsPath, ownerToTenant, pagePath } from "./links";
import { isArtifactType } from "./page-types";

export interface BrowsePageKind {
  label: string;
}

/** Resolve a browse result to the same canonical destination used by article rows. */
export function browsePageHref(page: IndexEntry): string {
  const isCommons =
    page.visibility !== "private" &&
    !page.type?.startsWith("agent-") &&
    !isArtifactType(page.type);
  return isCommons
    ? commonsPath(page.slug)
    : pagePath(ownerToTenant(page.owner), page.slug);
}

/** A compact, honest file-kind label using metadata available in the index. */
export function browsePageKind(page: IndexEntry): BrowsePageKind {
  if (page.type?.startsWith("agent-")) {
    return { label: "Agent knowledge" };
  }
  if (isArtifactType(page.type)) {
    return { label: "Artifact" };
  }
  return { label: "Wiki document" };
}

/** Remove ingest scaffolding that otherwise makes the register hard to scan. */
export function browsePageExcerpt(page: IndexEntry): string {
  const clean = (page.summary ?? "")
    .replace(/^#{1,6}\s*summary\s*/i, "")
    .replace(/^#{1,6}\s*/g, "")
    .trim();
  if (!clean || clean === page.slug || clean === page.title) {
    return "No summary has been generated yet.";
  }
  return clean;
}

export function humanizeBrowseTag(tag: string): string {
  return tag.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
}
