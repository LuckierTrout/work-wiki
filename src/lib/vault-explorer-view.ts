import type { VaultExplorerEntry } from "./vault-explorer";

export type ExplorerFilter =
  | { kind: "all" }
  | { kind: "folder"; value: string }
  | { kind: "format"; value: string }
  | { kind: "tag"; value: string };

export type ExplorerSort = "recent" | "title" | "format";

export interface ExplorerFacet {
  value: string;
  label: string;
  count: number;
  depth?: number;
}

export interface ExplorerFacets {
  folders: ExplorerFacet[];
  formats: ExplorerFacet[];
  tags: ExplorerFacet[];
}

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const FORMAT_LABELS: Record<string, string> = {
  docx: "Word",
  pptx: "PowerPoint",
  xlsx: "Excel",
  csv: "CSV",
  pdf: "PDF",
  md: "Markdown",
  txt: "Text",
  html: "Web page",
  zip: "Archive",
  page: "Wiki page",
};

export function entryFormat(entry: VaultExplorerEntry): string {
  return entry.sources[0]?.format ?? entry.type ?? "page";
}

export function formatLabel(format: string): string {
  return FORMAT_LABELS[format] ?? format.replace(/-/g, " ");
}

function addCount(map: Map<string, number>, value: string): void {
  map.set(value, (map.get(value) ?? 0) + 1);
}

/** Build file-tree, format, and tag counts in one pass over the vault. */
export function buildExplorerFacets(
  entries: readonly VaultExplorerEntry[],
): ExplorerFacets {
  const folders = new Map<string, number>();
  const formats = new Map<string, number>();
  const tags = new Map<string, number>();

  for (const entry of entries) {
    if (entry.folderPath) {
      const segments = entry.folderPath.split("/");
      for (let i = 1; i <= segments.length; i += 1) {
        addCount(folders, segments.slice(0, i).join("/"));
      }
    } else {
      addCount(folders, "__unfiled");
    }
    addCount(formats, entryFormat(entry));
    for (const tag of new Set(entry.tags)) addCount(tags, tag);
  }

  return {
    folders: Array.from(folders, ([value, count]) => ({
      value,
      label:
        value === "__unfiled" ? "Loose files" : value.split("/").at(-1)!,
      count,
      depth: value === "__unfiled" ? 0 : value.split("/").length - 1,
    })).sort((a, b) => {
      if (a.value === "__unfiled") return 1;
      if (b.value === "__unfiled") return -1;
      return collator.compare(a.value, b.value);
    }),
    formats: Array.from(formats, ([value, count]) => ({
      value,
      label: formatLabel(value),
      count,
    })).sort((a, b) => b.count - a.count || collator.compare(a.label, b.label)),
    tags: Array.from(tags, ([value, count]) => ({ value, label: value, count }))
      .sort((a, b) => b.count - a.count || collator.compare(a.label, b.label))
      .slice(0, 12),
  };
}

function matchesFilter(
  entry: VaultExplorerEntry,
  filter: ExplorerFilter,
): boolean {
  if (filter.kind === "all") return true;
  if (filter.kind === "format") return entryFormat(entry) === filter.value;
  if (filter.kind === "tag") return entry.tags.includes(filter.value);
  if (filter.value === "__unfiled") return !entry.folderPath;
  return (
    entry.folderPath === filter.value ||
    Boolean(entry.folderPath?.startsWith(`${filter.value}/`))
  );
}

function searchableText(entry: VaultExplorerEntry): string {
  return [
    entry.title,
    entry.slug,
    entry.summary,
    entry.folderPath,
    ...entry.tags,
    ...entry.sources.flatMap((source) => [source.filename, source.relativePath]),
  ]
    .filter(Boolean)
    .join(" ")
    .toLocaleLowerCase();
}

function recentTime(entry: VaultExplorerEntry): number {
  const value = entry.updated ?? entry.sources[0]?.storedAt;
  const time = value ? Date.parse(value) : 0;
  return Number.isFinite(time) ? time : 0;
}

/** Apply the explorer's active lens and deterministic sort order. */
export function filterAndSortEntries(
  entries: readonly VaultExplorerEntry[],
  query: string,
  filter: ExplorerFilter,
  sort: ExplorerSort,
): VaultExplorerEntry[] {
  const needle = query.trim().toLocaleLowerCase();
  const result = entries.filter(
    (entry) =>
      matchesFilter(entry, filter) &&
      (!needle || searchableText(entry).includes(needle)),
  );

  return result.sort((a, b) => {
    if (sort === "title") return collator.compare(a.title, b.title);
    if (sort === "format") {
      return (
        collator.compare(formatLabel(entryFormat(a)), formatLabel(entryFormat(b))) ||
        collator.compare(a.title, b.title)
      );
    }
    return recentTime(b) - recentTime(a) || collator.compare(a.title, b.title);
  });
}
