/**
 * The Workbench left column's tree vocabulary and shaping rules (Story 1.4).
 *
 * Pure and client-safe on purpose, exactly like `workbench-modes.ts`: the tree
 * component imports it in the browser, `page.tsx` imports it on the server to
 * shape what it loaded, and the node-environment test imports it to pin every
 * ordering, label and count rule. Nothing here touches storage, auth or the
 * DOM, so "why is this group first?" has one answer in one file.
 *
 * Every sentence the tree can render is a constant here rather than a literal
 * in the component, for the same reason `workbench-modes.ts` owns the mode
 * empty states: the UX handoff fixes the wording, so a second copy is drift.
 */

import { isAgentScopedType } from "./page-types";
import type { IndexEntry } from "./types";
import type { WorkbenchModeId } from "./workbench-modes";

// ---------------------------------------------------------------------------
// Walk limits
// ---------------------------------------------------------------------------
//
// The caps live here, not in the server-only walker, because the truncation
// SENTENCE is derived from one of them and this is the module a client
// component may import. `workbench-files.ts` re-exports both for server
// callers, so there is still one definition of each number.

/** Hard cap on nodes in one file listing. Reaching it sets `truncated`. */
export const WORKBENCH_FILE_LIMIT = 2000;

/**
 * Deepest level the walk descends to, counting the root directory as level 1:
 * `wiki/` is 1, `wiki/a.md` is 2, `raw/<slug>/<hash>.md` is 3 — which is every
 * shape the kernel writes today.
 */
export const WORKBENCH_FILE_MAX_DEPTH = 3;

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

export type TreeTabId = "knowledge" | "files";

export const DEFAULT_TREE_TAB: TreeTabId = "knowledge";

export interface TreeTab {
  id: TreeTabId;
  label: string;
}

/** Tab order, left → right. `DESIGN.md:259` and the mockup fix this sequence. */
export const TREE_TABS: readonly TreeTab[] = [
  { id: "knowledge", label: "Knowledge" },
  { id: "files", label: "Files" },
] as const;

/**
 * Runtime narrowing for a value read back from storage. A tab id from an older
 * build (or a hand-edited one) must not select a panel that does not exist —
 * the tablist would render with nothing selected.
 */
export function isTreeTabId(value: unknown): value is TreeTabId {
  return TREE_TABS.some((tab) => tab.id === value);
}

// ---------------------------------------------------------------------------
// Copy — every user-visible sentence the tree can show
// ---------------------------------------------------------------------------

/** No Wiki exists yet, so neither tab has anything of this Wiki's to show. */
export const TREE_NO_WIKI_COPY = "No wiki yet.";

/**
 * A read the column depends on failed, so it can make no claim about what is
 * there. Deliberately the same OPENING SENTENCE `WikiWorkbench` shows for the
 * same state (its own copy continues "Reload to try again."), because two
 * wordings for one failure read as two different failures.
 */
export const TREE_UNAVAILABLE_COPY = "Your wikis couldn’t be loaded.";

/**
 * What a Wiki switch actually swaps into view, said at the switcher.
 *
 * A Wiki is a LENS, not a partition: `src/lib/wikis.ts:16-17` is the storage
 * fact — Pages and Sources stay in the one tenant silo, and creating or
 * re-templating a Wiki writes only `purpose.md`, `schema.md` and that Wiki's
 * own `workspace-profile.json`. So switching leaves the Knowledge and Files
 * trees showing the same pages and sources, which without this sentence reads
 * as a broken switcher rather than as the design.
 *
 * "shows", never "changes": this same surface already uses the changing verbs
 * for WRITES — the rename dialog's "Pages and Sources are not changed", the
 * canvas card's "This overwrites purpose.md, Schema…" — so "switching changes
 * purpose.md" reads as a warning that the switch rewrites the owner's file.
 * A switch writes nothing; it re-points what is displayed.
 *
 * It lives here with every other left-column sentence for the reason the module
 * docstring gives: one owner per wording, so the claim cannot drift between the
 * render site and the tests that pin it. It renders as a plain muted note, not
 * `role="alert"` — nothing failed, and the switcher's real error already owns
 * that channel.
 */
export const WIKI_SCOPE_COPY =
  "Switching wikis shows that wiki’s purpose.md and Schema. Pages and Sources are shared across your wikis.";

/**
 * The page index — not the registry — is what failed. Named separately because
 * the registry sentence would be a false statement here: the switcher above the
 * tree is at that moment happily listing the wikis it claims could not load.
 */
export const KNOWLEDGE_UNAVAILABLE_COPY = "Your pages couldn’t be loaded.";

/** Same distinction for the file walk (and for the gate it reads). */
export const FILES_UNAVAILABLE_COPY = "Your files couldn’t be loaded.";

/** The Knowledge tab has no readable pages. */
export const KNOWLEDGE_EMPTY_COPY = "No pages yet. Ingest a source to compile one.";

/** The Files tab has nothing under either root. */
export const FILES_EMPTY_COPY = "No files yet.";

/**
 * The bounded walk hit its cap; the tree below is real but incomplete. The
 * numeral is derived from {@link WORKBENCH_FILE_LIMIT} rather than typed, so
 * the sentence cannot outlive the cap it describes. The locale is pinned
 * because this build is English-only and the string must not vary by runtime.
 */
export const FILES_TRUNCATED_COPY = `File list truncated at ${new Intl.NumberFormat(
  "en-US",
).format(WORKBENCH_FILE_LIMIT)} entries.`;

/**
 * The group untyped pages fall into. Named rather than left blank: a disclosure
 * with no label is a control the owner cannot describe to themselves.
 */
export const UNTYPED_GROUP_LABEL = "Pages";

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

/**
 * What the shell remembers when a tree row is picked. A discriminated union
 * rather than a bare string so a page slug and a file path can never be
 * confused for one another — Story 1.5 reads exactly this to decide what to
 * fetch into the Preview body.
 */
export type TreeSelection =
  | { kind: "page"; slug: string }
  | { kind: "file"; path: string };

/**
 * Do two picks name the same row? The shell uses this to make a second click on
 * the selected row DESELECT it — without that there is no way to undock the
 * Preview short of leaving Wiki mode.
 */
export function isSameSelection(
  a: TreeSelection | null,
  b: TreeSelection | null,
): boolean {
  if (!a || !b || a.kind !== b.kind) return false;
  return a.kind === "page"
    ? a.slug === (b as { slug: string }).slug
    : a.path === (b as { path: string }).path;
}

/**
 * Is this pick still a row the trees on screen actually contain? (Story 1.6.)
 *
 * A selection restored from browser storage may name a page that was deleted, a
 * file the walk no longer lists, or a row that belonged to a Wiki the owner has
 * since switched away from. Restoring it anyway docks a Preview that answers
 * `This file couldn’t be loaded.` and puts `aria-current` on nothing — a shell
 * that looks broken rather than one that forgot. Built on the two lookups the
 * Preview column already uses, so "is this row in the tree?" has one answer.
 *
 * A directory is not a row: the file tree renders directories as disclosures,
 * never as selectable buttons, so restoring one would dock a column with no
 * bytes behind it.
 */
export function selectionExists(
  selection: TreeSelection | null,
  knowledge: readonly KnowledgeGroup[],
  files: readonly FileNode[],
): boolean {
  if (!selection) return false;
  if (selection.kind === "page") {
    return findKnowledgePage(knowledge, selection.slug) !== null;
  }
  const node = findFileNode(files, selection.path);
  return node !== null && !node.isDirectory;
}

/**
 * The whole restore decision for a stored pick (Story 1.6): the row to select on
 * mount, or `null` for "restore nothing".
 *
 * Three conditions have to hold together, and spelling them inline in the mount
 * effect would leave them where only a grep could reach them — the Wiki half in
 * particular, whose failure (another Wiki's row restored over the current one) is
 * invisible until the Preview loads somebody else's page. `stored` is typed
 * structurally rather than imported from `workbench-state`, which imports THIS
 * module; the shape is `StoredSelection`.
 */
export function restorableSelection(
  stored: { wikiId: string; selection: TreeSelection } | null,
  currentWikiId: string | null,
  knowledge: readonly KnowledgeGroup[],
  files: readonly FileNode[],
): TreeSelection | null {
  if (!stored || currentWikiId === null) return null;
  if (stored.wikiId !== currentWikiId) return null;
  return selectionExists(stored.selection, knowledge, files) ? stored.selection : null;
}

/**
 * Whether the Preview column docks — the story's headline behaviour, lifted out
 * of JSX so it is executed by a test rather than grepped for in a source scan.
 *
 * Wiki mode only: the trees that produce a selection are the Wiki-mode surface,
 * so a docked column beside any other canvas would show a pick whose source the
 * owner can no longer see.
 */
export function shouldDockPreview(
  mode: WorkbenchModeId,
  selection: TreeSelection | null,
): boolean {
  return mode === "wiki" && selection !== null;
}

/**
 * What following a `[[wikilink]]` should select (Story 1.5).
 *
 * The link names a PAGE, but the tree showing is whichever tab the owner left
 * open — so on the Files tab the equivalent row is `wiki/<slug>.md`, and picking
 * the page instead would leave `aria-current` on a row that tab does not render.
 * Switching the tab for them is not the alternative it looks like: the shell's
 * reset effect undocks the Preview whenever `treeTab` changes, so the jump would
 * clear the selection it just made.
 *
 * The file form is used only when that node actually exists — a page whose file
 * the walk did not list (truncated, gated, or a legacy flat-tree page) still
 * resolves to a page selection rather than to a row nobody can point at.
 */
export function wikilinkSelection(
  tab: TreeTabId,
  files: readonly FileNode[],
  slug: string,
): TreeSelection {
  if (tab === "files") {
    const path = `wiki/${slug}.md`;
    if (findFileNode(files, path)) return { kind: "file", path };
  }
  return { kind: "page", slug };
}

// ---------------------------------------------------------------------------
// Knowledge tree
// ---------------------------------------------------------------------------

/**
 * The subset of an `IndexEntry` the left column and the Preview frontmatter
 * strip actually read. Narrowed on the server so the client payload carries the
 * page index's browse fields and not its whole read model.
 */
export interface KnowledgePage {
  slug: string;
  title: string;
  type?: string;
  updated?: string;
  sourceCount?: number;
}

export interface KnowledgeGroup {
  /** The raw `type` this group collects; `""` for the untyped group. */
  id: string;
  label: string;
  count: number;
  pages: KnowledgePage[];
}

/**
 * Ordering is `Intl.Collator`-based, matching `vault-explorer-view.ts`: a plain
 * `<` comparison sorts by code unit, which puts every capitalised title ahead of
 * every lower-cased one and reads as random to the owner.
 */
const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/**
 * Human label for a page `type`. `type` is a free string in `IndexEntry` — there
 * is no union to switch on — so this is a formatting rule, not a lookup table:
 * separators become spaces and only the first letter is capitalised, leaving
 * `agent-identity` → `Agent identity` rather than Title Case.
 */
export function knowledgeGroupLabel(type?: string): string {
  const spaced = (type ?? "").replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  if (!spaced) return UNTYPED_GROUP_LABEL;
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

function toKnowledgePage(entry: IndexEntry): KnowledgePage {
  // The slug backstops a blank or whitespace-only title. A tree row is a button
  // whose only content is this string, so an empty one is an unlabelled control
  // — and the Preview header beside it would render blank. Done here rather
  // than at each reader so the row, the sort and the Preview agree.
  const page: KnowledgePage = {
    slug: entry.slug,
    title: entry.title?.trim() || entry.slug,
  };
  const type = entry.type?.trim();
  if (type) page.type = type;
  if (entry.updated) page.updated = entry.updated;
  if (typeof entry.sourceCount === "number") page.sourceCount = entry.sourceCount;
  return page;
}

/**
 * Group the readable page index by `type`, untyped first.
 *
 * Agent-scoped pages are dropped here rather than at the call site so the rule
 * cannot be forgotten by a second caller: this matches `/api/wiki`'s default,
 * which is the browse contract the Knowledge tab is a view of.
 *
 * The index this groups is TENANT-WIDE, not per-Wiki (`src/lib/wikis.ts:16-17`,
 * DW-30), so the same pages appear under every Wiki and a switch leaves this
 * tab looking untouched. That is the storage fact, not a grouping bug — the
 * left column says so (`WIKI_SCOPE_COPY`). Repartitioning the index per Wiki is
 * DW-17's migration. Note the artifacts a switch DOES swap — `purpose.md` and
 * `schema.md` — are deliberately kept out of the page index and so never reach
 * this function; only the Files tab lists them.
 */
export function buildKnowledgeTree(entries: readonly IndexEntry[]): KnowledgeGroup[] {
  const groups = new Map<string, KnowledgePage[]>();
  for (const entry of entries) {
    if (isAgentScopedType(entry.type)) continue;
    // Trimmed, so a frontmatter `type: "  "` cannot open a SECOND group that
    // also labels itself `Pages` — the label collapses whitespace, the key
    // would not.
    const id = (entry.type ?? "").trim();
    const bucket = groups.get(id);
    if (bucket) bucket.push(toKnowledgePage(entry));
    else groups.set(id, [toKnowledgePage(entry)]);
  }

  return Array.from(groups, ([id, pages]) => ({
    id,
    label: knowledgeGroupLabel(id),
    count: pages.length,
    // Title order, slug as the tie-break — two pages may legitimately share a
    // title, and an unstable order would reshuffle the tree between reloads.
    pages: pages.sort(
      (a, b) => collator.compare(a.title, b.title) || collator.compare(a.slug, b.slug),
    ),
  })).sort((a, b) => {
    // The untyped group is not "the group whose label sorts to P": it is the
    // catch-all, and it leads regardless of what the typed groups are called.
    if (a.id === "") return -1;
    if (b.id === "") return 1;
    return collator.compare(a.label, b.label);
  });
}

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

export interface FileNode {
  /** Full path from the tree root — unique, and the selection's identity. */
  path: string;
  /** The final segment: what the row renders. */
  name: string;
  isDirectory: boolean;
  children: FileNode[];
}

/**
 * Nest a flat list of `/`-separated paths into a tree.
 *
 * A trailing `/` means "this is a directory" — that is how an EMPTY directory
 * survives the flattening at all (`raw/` with nothing in it yet still has to
 * appear, or the owner cannot tell an empty silo from a missing one).
 * Intermediate segments are materialised as directories whether or not the
 * walk emitted them explicitly.
 */
export function buildFileTree(paths: readonly string[]): FileNode[] {
  const roots: FileNode[] = [];
  const byPath = new Map<string, FileNode>();

  for (const raw of paths) {
    const isDirectory = raw.endsWith("/");
    const segments = raw.split("/").filter(Boolean);
    if (segments.length === 0) continue;

    let parent: FileNode[] = roots;
    let prefix = "";
    for (let i = 0; i < segments.length; i += 1) {
      const name = segments[i];
      prefix = prefix ? `${prefix}/${name}` : name;
      const last = i === segments.length - 1;
      const existing = byPath.get(prefix);
      if (existing) {
        // A path listed both as a parent segment and in its own right — the
        // directory wins, because a file can never have children.
        if (!last) existing.isDirectory = true;
        parent = existing.children;
        continue;
      }
      const node: FileNode = {
        path: prefix,
        name,
        isDirectory: last ? isDirectory : true,
        children: [],
      };
      byPath.set(prefix, node);
      parent.push(node);
      parent = node.children;
    }
  }

  sortNodes(roots);
  return roots;
}

/** Directories before files, each alphabetically — the mockup's own order. */
function sortNodes(nodes: FileNode[]): void {
  nodes.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return collator.compare(a.name, b.name);
  });
  for (const node of nodes) sortNodes(node.children);
}

/** Depth-first lookup by path — the Preview column's only read of the tree. */
export function findFileNode(
  nodes: readonly FileNode[],
  path: string,
): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    const found = findFileNode(node.children, path);
    if (found) return found;
  }
  return null;
}

/**
 * The slug set the Files tab is gated on — read off the RENDERED tree, never
 * off the index it was built from.
 *
 * `buildKnowledgeTree` narrows the readable index further (agent-scoped pages
 * are dropped), so a set derived from the entries would let the Files tab name
 * a page the Knowledge tab hides, and a filename is the same disclosure as a
 * title. A function rather than a `flatMap` typed at the call site because that
 * call site is a server component: inline, the story's privacy rule could only
 * ever be grepped for in source text, and a rewrite that kept the prose and
 * changed the expression would ship the disclosure with a green suite.
 */
export function readableSlugsFromKnowledge(
  groups: readonly KnowledgeGroup[],
): Set<string> {
  const slugs = new Set<string>();
  for (const group of groups) {
    for (const page of group.pages) slugs.add(page.slug);
  }
  return slugs;
}

/** Flat lookup by slug across every group — the Preview column's page read. */
export function findKnowledgePage(
  groups: readonly KnowledgeGroup[],
  slug: string,
): KnowledgePage | null {
  for (const group of groups) {
    const found = group.pages.find((page) => page.slug === slug);
    if (found) return found;
  }
  return null;
}
