/**
 * Story 1.4 — the left column's only real logic: what groups exist, what order
 * rows come in, how deep and how wide the file walk is allowed to go, and which
 * tab comes back after a reload.
 *
 * `buildKnowledgeTree` and `buildFileTree` are pure, so they are exercised
 * directly. `listWorkbenchFilePaths` is not — it walks the storage provider —
 * so it runs against a real temp directory through the filesystem provider,
 * which is what `raw.test.ts` already does for `listRawSources`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  DEFAULT_TREE_TAB,
  FILES_TRUNCATED_COPY,
  TREE_TABS,
  WIKI_SCOPE_COPY,
  buildFileTree,
  buildKnowledgeTree,
  findFileNode,
  findKnowledgePage,
  isSameSelection,
  isTreeTabId,
  knowledgeGroupLabel,
  readableSlugsFromKnowledge,
  selectionName,
  selectionRefreshAction,
  shouldDockPreview,
  type FileNode,
  type KnowledgeGroup,
  type TreeSelection,
} from "../workbench-tree";
import {
  WORKBENCH_FILE_LIMIT,
  WORKBENCH_FILE_MAX_DEPTH,
  listWorkbenchFilePaths,
  readWorkbenchFile,
} from "../workbench-files";
import {
  WORKBENCH_TREE_TAB_KEY,
  readStoredTreeTab,
  writeStoredTreeTab,
} from "../workbench-state";
import { wikiArtifactPath } from "../wikis";
import { tenantForOwner, tenantRawRelPath, tenantWikiRelPath } from "../wiki";
import { getDataDir } from "../paths";
import type { IndexEntry } from "../types";

function entry(partial: Partial<IndexEntry> & { slug: string }): IndexEntry {
  return { title: partial.slug, summary: "", ...partial };
}

// ---------------------------------------------------------------------------
// Knowledge tree
// ---------------------------------------------------------------------------

describe("buildKnowledgeTree", () => {
  it("groups by type and puts the untyped group first", () => {
    const groups = buildKnowledgeTree([
      entry({ slug: "a", type: "concept" }),
      entry({ slug: "b", type: "concept" }),
      entry({ slug: "c" }),
    ]);
    expect(groups.map((g) => ({ label: g.label, count: g.count }))).toEqual([
      { label: "Pages", count: 1 },
      { label: "Concept", count: 2 },
    ]);
  });

  it("orders the typed groups by label, after the untyped one", () => {
    const groups = buildKnowledgeTree([
      entry({ slug: "z", type: "zeta" }),
      entry({ slug: "a", type: "alpha" }),
      entry({ slug: "u" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Pages", "Alpha", "Zeta"]);
  });

  it("sentence-cases a hyphenated type rather than title-casing it", () => {
    expect(knowledgeGroupLabel("agent-identity")).toBe("Agent identity");
    expect(knowledgeGroupLabel("concept")).toBe("Concept");
    expect(knowledgeGroupLabel(undefined)).toBe("Pages");
    expect(knowledgeGroupLabel("  ")).toBe("Pages");
  });

  it("sorts pages by title, breaking ties on slug", () => {
    const [group] = buildKnowledgeTree([
      entry({ slug: "z", title: "Zeta", type: "concept" }),
      entry({ slug: "a", title: "Alpha", type: "concept" }),
    ]);
    expect(group.pages.map((p) => p.title)).toEqual(["Alpha", "Zeta"]);

    const [tied] = buildKnowledgeTree([
      entry({ slug: "second", title: "Same", type: "concept" }),
      entry({ slug: "first", title: "Same", type: "concept" }),
    ]);
    expect(tied.pages.map((p) => p.slug)).toEqual(["first", "second"]);
  });

  it("has no groups at all for an empty index", () => {
    expect(buildKnowledgeTree([])).toEqual([]);
  });

  it("folds a whitespace-only type into the untyped group, not beside it", () => {
    // The LABEL collapses whitespace, so an untrimmed key would open a second
    // group also calling itself `Pages`.
    const groups = buildKnowledgeTree([
      entry({ slug: "a", type: "  " }),
      entry({ slug: "b" }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ id: "", label: "Pages", count: 2 });
    expect(groups[0].pages.every((p) => p.type === undefined)).toBe(true);
  });

  it("excludes agent-scoped pages, matching /api/wiki's default feed", () => {
    const groups = buildKnowledgeTree([
      entry({ slug: "a", type: "agent-identity" }),
      entry({ slug: "b", type: "concept" }),
    ]);
    expect(groups.map((g) => g.label)).toEqual(["Concept"]);
  });

  it("carries only the frontmatter fields the Preview strip reads", () => {
    const [group] = buildKnowledgeTree([
      entry({
        slug: "a",
        title: "A",
        type: "concept",
        updated: "2026-08-15",
        sourceCount: 3,
        visibility: "private",
        owner: "someone",
      }),
    ]);
    expect(group.pages[0]).toEqual({
      slug: "a",
      title: "A",
      type: "concept",
      updated: "2026-08-15",
      sourceCount: 3,
    });
  });

  it("falls back to the slug when a title is blank or whitespace", () => {
    // A tree row is a button whose only content is the title, so an empty one is
    // an unlabelled control — and the Preview header beside it renders blank.
    const [group] = buildKnowledgeTree([entry({ slug: "a-page", title: "   " })]);
    expect(group.pages[0].title).toBe("a-page");
  });

  it("derives the Files gate from the rendered tree, not from the index", () => {
    // The exact set `page.tsx` hands the file walk. Executed here rather than
    // grepped for in `page.tsx`, because a source scan cannot tell this set
    // apart from one built over `pageIndex.entries` — which would name an
    // agent-scoped page's FILE while the Knowledge tab hides its title.
    const knowledge = buildKnowledgeTree([
      entry({ slug: "kept", type: "concept" }),
      entry({ slug: "untyped" }),
      entry({ slug: "agent-memory", type: "agent-identity" }),
    ]);
    expect([...readableSlugsFromKnowledge(knowledge)].sort()).toEqual(["kept", "untyped"]);
    expect(readableSlugsFromKnowledge([])).toEqual(new Set());
  });

  it("finds a page by slug across every group", () => {
    const groups = buildKnowledgeTree([
      entry({ slug: "a", type: "concept" }),
      entry({ slug: "b" }),
    ]);
    expect(findKnowledgePage(groups, "a")?.slug).toBe("a");
    expect(findKnowledgePage(groups, "missing")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// File tree
// ---------------------------------------------------------------------------

describe("buildFileTree", () => {
  it("nests paths under materialised directories", () => {
    const tree = buildFileTree(["wiki/a.md", "raw/x/y.md", "purpose.md"]);
    expect(tree.map((n) => n.name)).toEqual(["raw", "wiki", "purpose.md"]);

    const raw = tree.find((n) => n.name === "raw")!;
    expect(raw.isDirectory).toBe(true);
    expect(raw.children.map((n) => n.name)).toEqual(["x"]);
    expect(raw.children[0].children.map((n) => n.path)).toEqual(["raw/x/y.md"]);

    const wiki = tree.find((n) => n.name === "wiki")!;
    expect(wiki.children.map((n) => n.name)).toEqual(["a.md"]);
    expect(wiki.children[0].isDirectory).toBe(false);
  });

  it("puts directories before files, each alphabetically", () => {
    const tree = buildFileTree(["wiki/b.md", "raw/", "schema.md"]);
    expect(tree.map((n) => `${n.name}${n.isDirectory ? "/" : ""}`)).toEqual([
      "raw/",
      "wiki/",
      "schema.md",
    ]);
  });

  it("keeps an empty directory, so a bare silo is visible", () => {
    const tree = buildFileTree(["raw/"]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ name: "raw", isDirectory: true, children: [] });
  });

  it("is empty for no paths, and ignores a blank one", () => {
    expect(buildFileTree([])).toEqual([]);
    expect(buildFileTree(["", "/"])).toEqual([]);
  });

  it("finds a node by its full path at any depth", () => {
    const tree = buildFileTree(["raw/x/y.md"]);
    expect(findFileNode(tree, "raw/x/y.md")?.name).toBe("y.md");
    expect(findFileNode(tree, "raw/x")?.isDirectory).toBe(true);
    expect(findFileNode(tree, "nope")).toBeNull();
  });

  it("resolves a leaf/parent conflict as a directory, in either order", () => {
    // A path listed as a leaf AND used as a parent segment must end up a
    // directory: a file cannot have children, so the file reading would drop
    // everything under it.
    for (const paths of [
      ["raw/x", "raw/x/y.md"],
      ["raw/x/y.md", "raw/x"],
    ]) {
      const tree = buildFileTree(paths);
      const x = findFileNode(tree, "raw/x")!;
      expect(x.isDirectory).toBe(true);
      expect(x.children.map((n) => n.path)).toEqual(["raw/x/y.md"]);
    }
  });

  it("collapses a duplicated path into one node", () => {
    const tree = buildFileTree(["a.md", "a.md", "raw/", "raw/"]);
    expect(tree.map((n) => n.path)).toEqual(["raw", "a.md"]);
  });
});

// ---------------------------------------------------------------------------
// Selection and the Preview dock
// ---------------------------------------------------------------------------

describe("the Preview dock rule", () => {
  const page: TreeSelection = { kind: "page", slug: "a" };
  const file: TreeSelection = { kind: "file", path: "wiki/a.md" };

  it("docks only in Wiki mode, and only with something selected", () => {
    expect(shouldDockPreview("wiki", page)).toBe(true);
    expect(shouldDockPreview("wiki", file)).toBe(true);
    expect(shouldDockPreview("wiki", null)).toBe(false);
    // Every other mode keeps its own canvas; the trees are not on screen.
    for (const mode of ["chat", "sources", "search", "graph", "lint"] as const) {
      expect(shouldDockPreview(mode, page)).toBe(false);
      expect(shouldDockPreview(mode, null)).toBe(false);
    }
  });

  it("tells identical picks apart from same-shaped different ones", () => {
    expect(isSameSelection(page, { kind: "page", slug: "a" })).toBe(true);
    expect(isSameSelection(file, { kind: "file", path: "wiki/a.md" })).toBe(true);
    expect(isSameSelection(page, { kind: "page", slug: "b" })).toBe(false);
    // A page slug and a file path are never the same pick, whatever they read.
    expect(isSameSelection(page, { kind: "file", path: "a" })).toBe(false);
    expect(isSameSelection(null, page)).toBe(false);
    expect(isSameSelection(page, null)).toBe(false);
    expect(isSameSelection(null, null)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// What a pick is CALLED, and whether it is still real (DW-34, DW-53)
// ---------------------------------------------------------------------------

const NAMED_KNOWLEDGE: KnowledgeGroup[] = [
  {
    id: "note",
    label: "Note",
    count: 1,
    pages: [{ slug: "alpha", title: "Alpha", type: "note" }],
  },
];

const NAMED_FILES: FileNode[] = buildFileTree(["wiki/alpha.md", "raw/", "raw/deep/x.md"]);

describe("selectionName", () => {
  it("calls a page by its title", () => {
    expect(selectionName({ kind: "page", slug: "alpha" }, NAMED_KNOWLEDGE, NAMED_FILES)).toBe(
      "Alpha",
    );
  });

  it("falls back to the slug for a page the trees no longer carry", () => {
    // A selection can outlive its page — a refresh that dropped it, or a
    // reconciliation that has not run yet. The slug is still a true statement
    // about what the owner picked, and it is what the Preview header shows, so
    // the spoken sentence and the visible one agree.
    expect(selectionName({ kind: "page", slug: "ghost" }, NAMED_KNOWLEDGE, NAMED_FILES)).toBe(
      "ghost",
    );
  });

  it("calls a file by its node's name", () => {
    expect(
      selectionName({ kind: "file", path: "raw/deep/x.md" }, NAMED_KNOWLEDGE, NAMED_FILES),
    ).toBe("x.md");
  });

  it("derives a name for a path the walk does not list", () => {
    expect(
      selectionName({ kind: "file", path: "raw/absent/y.md" }, NAMED_KNOWLEDGE, NAMED_FILES),
    ).toBe("y.md");
  });

  it("survives a trailing slash, which is the reason this is `||` and not `??`", () => {
    // `"a/b/".split("/").at(-1)` is the EMPTY STRING, not `undefined`. A nullish
    // fallback leaves the header blank and the announcement reading `Preview, `
    // — a control with no accessible content, spoken as nothing.
    expect(selectionName({ kind: "file", path: "a/b/" }, [], [])).toBe("b");
    expect(selectionName({ kind: "file", path: "solo.md" }, [], [])).toBe("solo.md");
    // Nothing left after filtering: the whole path is the last honest answer.
    expect(selectionName({ kind: "file", path: "/" }, [], [])).toBe("/");
  });
});

describe("selectionRefreshAction", () => {
  const present: TreeSelection = { kind: "page", slug: "alpha" };
  const gone: TreeSelection = { kind: "page", slug: "ghost" };
  const goneFile: TreeSelection = { kind: "file", path: "wiki/left.md" };
  const base = {
    knowledge: NAMED_KNOWLEDGE,
    files: NAMED_FILES,
    docked: true,
    knowledgeUnavailable: false,
    filesUnavailable: false,
    filesTruncated: false,
    layoutMoved: false,
  };

  it("keeps a pick that is still in a tree, and one that never existed", () => {
    expect(selectionRefreshAction({ ...base, selection: null })).toBe("keep");
    expect(selectionRefreshAction({ ...base, selection: present })).toBe("keep");
    expect(
      selectionRefreshAction({ ...base, selection: { kind: "file", path: "wiki/alpha.md" } }),
    ).toBe("keep");
  });

  it("reports the row a refreshed tree no longer contains", () => {
    expect(selectionRefreshAction({ ...base, selection: gone })).toBe("report");
    expect(selectionRefreshAction({ ...base, selection: goneFile })).toBe("report");
  });

  it("clears WITHOUT a sentence when no column is on screen", () => {
    // Settings takes the left column, so the shell holds a live pick with
    // `previewOpen === false` for as long as it is open. Announcing
    // `Preview closed — that item was removed.` there reports the
    // disappearance of a panel the owner cannot see — but the stale pick still
    // must not survive, or closing Settings would dock a column onto a row that
    // is gone.
    expect(selectionRefreshAction({ ...base, selection: gone, docked: false })).toBe("clear");
    // …and `docked` decides ONLY the sentence, never whether the pick is real.
    expect(selectionRefreshAction({ ...base, selection: present, docked: false })).toBe("keep");
  });

  it("treats a directory as lost, because it was never a row", () => {
    // The file tree renders directories as disclosures, never as selectable
    // buttons — the same rule `selectionExists` already applies to a restore.
    expect(
      selectionRefreshAction({ ...base, selection: { kind: "file", path: "raw" } }),
    ).toBe("report");
  });

  it("matches the unavailable flag to the selection's own kind", () => {
    // A failed index read hands the KNOWLEDGE tree down empty; reading that as
    // "every page was deleted" would close the Preview after one bad minute on
    // the server.
    expect(
      selectionRefreshAction({
        ...base,
        selection: gone,
        knowledge: [],
        knowledgeUnavailable: true,
      }),
    ).toBe("keep");
    // …but a failed FILE walk says nothing whatsoever about whether a page
    // exists. Suppressing both would leave a genuinely deleted page docked for
    // as long as an unrelated read stayed broken.
    expect(
      selectionRefreshAction({ ...base, selection: gone, files: [], filesUnavailable: true }),
    ).toBe("report");
    // And the mirror image, so neither half is a coincidence.
    expect(
      selectionRefreshAction({
        ...base,
        selection: goneFile,
        files: [],
        filesUnavailable: true,
      }),
    ).toBe("keep");
    expect(
      selectionRefreshAction({
        ...base,
        selection: goneFile,
        knowledge: [],
        knowledgeUnavailable: true,
      }),
    ).toBe("report");
  });

  it("refuses to call a truncated walk a deletion", () => {
    // The walk listed real files and then stopped at WORKBENCH_FILE_LIMIT, so
    // the selected file may simply be one it never reached. "Absent from this
    // list" is not evidence of removal.
    expect(
      selectionRefreshAction({ ...base, selection: goneFile, filesTruncated: true }),
    ).toBe("keep");
    // The cap is the FILE walk's alone — the page index is not bounded by it,
    // so a page selection is still reconciled while it is set.
    expect(
      selectionRefreshAction({ ...base, selection: gone, filesTruncated: true }),
    ).toBe("report");
  });

  it("stands down when the layout moved in the same commit", () => {
    // A Wiki, mode or tab change and a server re-render can land together, and
    // the shell's reset effect owns the clear in that case. Clearing again with
    // a sentence about removal would report something that did not happen —
    // the owner switched tabs, nobody deleted anything.
    expect(selectionRefreshAction({ ...base, selection: gone, layoutMoved: true })).toBe(
      "keep",
    );
    // The guard is a refusal to ACT, not a claim the row is fine: the next
    // refresh at a settled layout still answers truthfully. (The shell keeps
    // that true by recording the signature on every layout change, so a later
    // tree-only refresh is never mistaken for the switch that preceded it.)
    expect(selectionRefreshAction({ ...base, selection: gone, layoutMoved: false })).toBe(
      "report",
    );
  });
});

// ---------------------------------------------------------------------------
// The bounded walk
// ---------------------------------------------------------------------------

describe("listWorkbenchFilePaths", () => {
  const OWNER = "yuanhao";
  const WIKI_ID = "11111111-2222-4333-8444-555555555555";
  // Every path this suite touches lives under `root`, and `DATA_DIR` points at
  // it for the whole file. Deleting `<DATA_DIR>/tenants` per test would
  // otherwise reach outside the fixture — `vitest.setup.ts` only DEFAULTS
  // `DATA_DIR`, so a developer running with it set at real data would lose it.
  // `DATA_DIR` is set once because the filesystem provider is a singleton that
  // captures its base path on first use.
  let root: string;
  let tmpDir: string;
  let caseIndex = 0;
  let originalDataDir: string | undefined;
  let originalWikiDir: string | undefined;
  let originalRawDir: string | undefined;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "wb-files-"));
    originalDataDir = process.env.DATA_DIR;
    process.env.DATA_DIR = root;
  });

  afterAll(async () => {
    if (originalDataDir === undefined) delete process.env.DATA_DIR;
    else process.env.DATA_DIR = originalDataDir;
    await fs.rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    caseIndex += 1;
    tmpDir = path.join(root, `case-${caseIndex}`);
    originalWikiDir = process.env.WIKI_DIR;
    originalRawDir = process.env.RAW_DIR;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    await fs.mkdir(process.env.WIKI_DIR, { recursive: true });
    await fs.mkdir(process.env.RAW_DIR, { recursive: true });
  });

  afterEach(async () => {
    if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
    else process.env.WIKI_DIR = originalWikiDir;
    if (originalRawDir === undefined) delete process.env.RAW_DIR;
    else process.env.RAW_DIR = originalRawDir;
    // Only inside the fixture: `tmpDir` and the tenant tree this file wrote.
    await fs.rm(tmpDir, { recursive: true, force: true });
    await fs.rm(path.join(root, "tenants"), { recursive: true, force: true });
  });

  /**
   * The read gate, holding exactly the slugs named — so `gate()` with no
   * arguments is a CLOSED gate (no page is readable), not an open one.
   */
  function gate(...slugs: string[]) {
    return { readableSlugs: new Set(slugs) };
  }

  async function seedArtifacts(): Promise<void> {
    for (const file of ["purpose.md", "schema.md"] as const) {
      const rel = wikiArtifactPath(OWNER, WIKI_ID, file);
      const abs = path.join(getDataDir(), rel);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, `# ${file}\n`, "utf-8");
    }
  }

  /** Write a file into the owner's tenant silo, the PRIMARY location. */
  async function writeSilo(kind: "wiki" | "raw", name: string): Promise<void> {
    const rel =
      kind === "wiki"
        ? tenantWikiRelPath(tenantForOwner(OWNER), name)
        : tenantRawRelPath(tenantForOwner(OWNER), name);
    const abs = path.join(getDataDir(), rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "x", "utf-8");
  }

  it("puts the seeded artifacts at the root, above both silo roots", async () => {
    await seedArtifacts();
    await fs.writeFile(path.join(tmpDir, "wiki", "a.md"), "a", "utf-8");

    const { paths, truncated } = await listWorkbenchFilePaths(
      OWNER,
      WIKI_ID,
      gate("a"),
    );
    expect(truncated).toBe(false);
    expect(paths.slice(0, 2)).toEqual(["purpose.md", "schema.md"]);
    expect(paths).toContain("raw/");
    expect(paths).toContain("wiki/");
    expect(paths).toContain("wiki/a.md");

    // The RENDERED order is `buildFileTree`'s — directories first — even though
    // the artifacts are emitted before either root.
    const tree = buildFileTree(paths);
    expect(tree.map((n) => n.name)).toEqual(["raw", "wiki", "purpose.md", "schema.md"]);
  });

  it("never lists the wiki's workspace-profile.json, its third sibling", async () => {
    // The Workspace Purpose is stored per wiki, IN this directory, beside the
    // two markdown artifacts — but it is a JSON store, not one of the owner's
    // editable files, and `WIKI_ARTIFACT_FILES` is what the tab and the dialog
    // copy both speak for. Without a case that puts the file on disk, the
    // allowlist intersection could become a plain directory listing and every
    // other artifact test would stay green.
    await seedArtifacts();
    const profileAbs = path.join(
      getDataDir(),
      wikiArtifactPath(OWNER, WIKI_ID, "purpose.md").replace(
        /purpose\.md$/,
        "workspace-profile.json",
      ),
    );
    await fs.writeFile(profileAbs, '{"version":1}', "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, WIKI_ID, gate());
    expect(paths).toContain("purpose.md");
    expect(paths).toContain("schema.md");
    expect(paths).not.toContain("workspace-profile.json");
    expect(paths.some((p) => p.endsWith(".json"))).toBe(false);
    expect(buildFileTree(paths).map((n) => n.name)).not.toContain(
      "workspace-profile.json",
    );
  });

  it("lists only the artifacts that were actually written", async () => {
    // The tab must not assert a file the template never wrote: `seedWikiArtifacts`
    // is two separate writes, and an unreadable artifact directory degrades to an
    // empty listing. Without this case the presence check could be deleted and
    // the suite would stay green — every other artifact test seeds BOTH files.
    const rel = wikiArtifactPath(OWNER, WIKI_ID, "purpose.md");
    const abs = path.join(getDataDir(), rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await fs.writeFile(abs, "# purpose\n", "utf-8");

    const half = await listWorkbenchFilePaths(OWNER, WIKI_ID, gate());
    expect(half.paths).toContain("purpose.md");
    expect(half.paths).not.toContain("schema.md");

    // And a Wiki whose artifact directory does not exist at all claims neither.
    const none = await listWorkbenchFilePaths(
      OWNER,
      "22222222-3333-4444-8555-666666666666",
      gate(),
    );
    expect(none.paths).toEqual(["raw/", "wiki/"]);
  });

  it("shows the SAME silo under either Wiki, and only the artifacts differ", async () => {
    // The product now TELLS the owner "Pages and Sources are shared across your
    // wikis" (`WIKI_SCOPE_COPY`), and this is the listing that has to make that
    // true. Every other silo case here passes `wikiId = null`, so the claim was
    // pinned nowhere: partitioning the walk per Wiki would leave the suite green
    // while turning the shipped sentence into a lie.
    const OTHER_ID = "33333333-4444-4555-8666-777777777777";
    await writeSilo("wiki", "shared-page.md");
    await writeSilo("raw", "shared-source.md");
    // Both Wikis exist on disk, each with its own artifact pair — the one thing
    // a switch is allowed to change.
    for (const id of [WIKI_ID, OTHER_ID]) {
      for (const file of ["purpose.md", "schema.md"] as const) {
        const abs = path.join(getDataDir(), wikiArtifactPath(OWNER, id, file));
        await fs.mkdir(path.dirname(abs), { recursive: true });
        await fs.writeFile(abs, `# ${id} ${file}\n`, "utf-8");
      }
    }

    const first = await listWorkbenchFilePaths(OWNER, WIKI_ID, gate("shared-page"));
    const second = await listWorkbenchFilePaths(OWNER, OTHER_ID, gate("shared-page"));

    // Identical, entry for entry and in the same order — not merely overlapping.
    const silo = (listing: { paths: string[] }) =>
      listing.paths.filter((p) => p.startsWith("wiki/") || p.startsWith("raw/"));
    expect(silo(first)).toEqual(["raw/", "raw/shared-source.md", "wiki/", "wiki/shared-page.md"]);
    expect(silo(second)).toEqual(silo(first));
    // And the whole listing is identical too: the artifacts a switch DOES swap
    // are per-Wiki in CONTENT, not in path, so nothing at all moves in the tree.
    expect(second.paths).toEqual(first.paths);
    expect(first.paths.slice(0, 2)).toEqual(["purpose.md", "schema.md"]);

    // What actually differs is on the other side of those two paths: each Wiki's
    // own file. Read them back THROUGH the reader the Preview uses, not with
    // `fs` — reading the fixture back with `fs` would compare the bytes this
    // test just wrote and pass no matter what the product resolves. This is the
    // per-Wiki half of the shipped sentence: the same display path, under two
    // ids, must reach two different files.
    const read = (id: string) => readWorkbenchFile(OWNER, id, "purpose.md", gate());
    expect((await read(WIKI_ID))?.content).toBe(`# ${WIKI_ID} purpose.md\n`);
    expect((await read(OTHER_ID))?.content).toBe(`# ${OTHER_ID} purpose.md\n`);
  });

  it("shows no artifacts when there is no current Wiki, but still both roots", async () => {
    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate());
    expect(paths).toEqual(["raw/", "wiki/"]);
  });

  it("logs and carries on when the wiki id cannot become a path", async () => {
    // `wikiArtifactPath` rejects a non-UUID id. The artifacts are then unknown,
    // but the two silo roots are still real and still render.
    const { paths } = await listWorkbenchFilePaths(OWNER, "not-a-uuid", gate());
    expect(paths).toEqual(["raw/", "wiki/"]);
  });

  it("prefers the tenant silo over the flat roots", async () => {
    // `silo.ts` documents `tenants/<tenant>/…` as PRIMARY; the flat tree is the
    // transitional copy. When both exist, the silo is what the tab shows.
    await writeSilo("wiki", "silo-page.md");
    await writeSilo("raw", "silo-source.md");
    await fs.writeFile(path.join(tmpDir, "wiki", "flat-page.md"), "x", "utf-8");
    await fs.writeFile(path.join(tmpDir, "raw", "flat-source.md"), "x", "utf-8");

    const { paths } = await listWorkbenchFilePaths(
      OWNER,
      null,
      gate("silo-page", "flat-page"),
    );
    expect(paths).toContain("wiki/silo-page.md");
    expect(paths).toContain("raw/silo-source.md");
    expect(paths).not.toContain("wiki/flat-page.md");
    expect(paths).not.toContain("raw/flat-source.md");
  });

  it("falls back to the flat roots when the silo is empty", async () => {
    await fs.writeFile(path.join(tmpDir, "wiki", "flat-page.md"), "x", "utf-8");
    await fs.writeFile(path.join(tmpDir, "raw", "flat-source.md"), "x", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate("flat-page"));
    expect(paths).toContain("wiki/flat-page.md");
    expect(paths).toContain("raw/flat-source.md");
  });

  it("does not fall back to the flat roots when the silo read FAILED", async () => {
    // A missing silo answers with an empty list; only a real error rejects. So a
    // rejection here must not be read as "the silo is empty" — answering a
    // transient failure by widening the tab to the shared transitional tree is
    // the opposite of degrading, and it is the same "a failed read is not an
    // empty read" rule the two tabs' own failure copy exists to keep.
    const siloWiki = path.join(getDataDir(), tenantWikiRelPath(tenantForOwner(OWNER), ""));
    await fs.mkdir(path.dirname(siloWiki), { recursive: true });
    await fs.writeFile(siloWiki, "not a directory", "utf-8"); // ENOTDIR on readdir
    await fs.writeFile(path.join(tmpDir, "wiki", "flat-page.md"), "x", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate("flat-page"));
    expect(paths).toContain("wiki/");
    expect(paths).not.toContain("wiki/flat-page.md");
  });

  it("lists only the pages the read gate returned, in either branch", async () => {
    // The Knowledge tab excludes agent-scoped and unreadable pages. A filename
    // in the Files tab is the same disclosure, so the same set governs both.
    for (const name of ["mine.md", "theirs.md", "index.md", "notes.txt"]) {
      await fs.writeFile(path.join(tmpDir, "wiki", name), "x", "utf-8");
    }
    const flat = await listWorkbenchFilePaths(OWNER, null, gate("mine"));
    expect(flat.paths).toContain("wiki/mine.md");
    expect(flat.paths).not.toContain("wiki/theirs.md");
    // The generated index is not a page and has no slug, so it does not survive.
    expect(flat.paths).not.toContain("wiki/index.md");
    // Non-markdown under the root is not a page at all — it is not gated.
    expect(flat.paths).toContain("wiki/notes.txt");

    await writeSilo("wiki", "mine.md");
    await writeSilo("wiki", "theirs.md");
    const silo = await listWorkbenchFilePaths(OWNER, null, gate("mine"));
    expect(silo.paths).toContain("wiki/mine.md");
    expect(silo.paths).not.toContain("wiki/theirs.md");
  });

  it("hides the filename of a page the Knowledge tab drops as agent-scoped", async () => {
    // `page.tsx` derives the gate from the KNOWLEDGE TREE, not from the raw
    // index: `buildKnowledgeTree` also drops agent-scoped pages, and a filename
    // in the Files tab is the same disclosure as a title in the Knowledge tab.
    // Through the SAME function `page.tsx` calls, not a copy of its expression:
    // a re-implementation here would keep passing while the real call site drifted.
    const knowledge = buildKnowledgeTree([
      entry({ slug: "concept-page", type: "concept" }),
      entry({ slug: "agent-memory", type: "agent-identity" }),
    ]);
    const readableSlugs = readableSlugsFromKnowledge(knowledge);
    await fs.writeFile(path.join(tmpDir, "wiki", "concept-page.md"), "x", "utf-8");
    await fs.writeFile(path.join(tmpDir, "wiki", "agent-memory.md"), "x", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, { readableSlugs });
    expect(paths).toContain("wiki/concept-page.md");
    expect(paths).not.toContain("wiki/agent-memory.md");
  });

  it("skips dotfiles, so storage bookkeeping stays out of the tree", async () => {
    await fs.mkdir(path.join(tmpDir, "wiki", ".revisions"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", ".hidden"), "x", "utf-8");
    await fs.writeFile(path.join(tmpDir, "raw", "shown.md"), "x", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate());
    expect(paths).toContain("raw/shown.md");
    expect(paths).not.toContain("raw/.hidden");
    expect(paths.some((p) => p.includes(".revisions"))).toBe(false);
  });

  it("nests a per-source raw subdirectory", async () => {
    await fs.mkdir(path.join(tmpDir, "raw", "topic"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", "topic", "abc.md"), "x", "utf-8");

    const { paths, truncated } = await listWorkbenchFilePaths(OWNER, null, gate());
    expect(paths).toContain("raw/topic/");
    expect(paths).toContain("raw/topic/abc.md");
    expect(truncated).toBe(false);
  });

  it("omits anything past the depth cap and reports the truncation", async () => {
    // raw/ (1) → a/ (2) → b/ (3) → deep.md (4): the file is one level too far.
    await fs.mkdir(path.join(tmpDir, "raw", "a", "b"), { recursive: true });
    await fs.writeFile(path.join(tmpDir, "raw", "a", "b", "deep.md"), "x", "utf-8");

    const { paths, truncated } = await listWorkbenchFilePaths(OWNER, null, gate());
    expect(paths).toContain("raw/a/b/");
    expect(paths).not.toContain("raw/a/b/deep.md");
    expect(truncated).toBe(true);
  });

  it("does not cry truncation over an empty directory at the depth cap", async () => {
    await fs.mkdir(path.join(tmpDir, "raw", "a", "b"), { recursive: true });
    const { truncated } = await listWorkbenchFilePaths(OWNER, null, gate());
    expect(truncated).toBe(false);
  });

  it("stops at the node cap and reports it", async () => {
    for (const name of ["a.md", "b.md", "c.md", "d.md"]) {
      await fs.writeFile(path.join(tmpDir, "raw", name), "x", "utf-8");
    }
    const { paths, truncated } = await listWorkbenchFilePaths(OWNER, null, {
      ...gate(),
      limit: 4,
    });
    // Not just `<= 4` — that also passes for a walk that returned NOTHING, and
    // "listed nothing" is the failure a cap must never be confused with. So:
    // under the ceiling, both roots still present, and something really listed.
    expect(paths.length).toBeLessThanOrEqual(4);
    expect(paths).toContain("raw/");
    expect(paths).toContain("wiki/");
    expect(paths.filter((p) => p.endsWith(".md")).length).toBeGreaterThan(0);
    expect(truncated).toBe(true);
  });

  it("reserves budget for wiki/ so a huge raw/ cannot starve it", async () => {
    // Without a per-root share the whole cap is spent walking `raw/`, and
    // `wiki/` renders as an empty directory — indistinguishable from a missing
    // silo rather than from a truncated one.
    for (let i = 0; i < 12; i += 1) {
      await fs.writeFile(path.join(tmpDir, "raw", `s${i}.md`), "x", "utf-8");
    }
    await fs.writeFile(path.join(tmpDir, "wiki", "kept.md"), "x", "utf-8");

    const { paths, truncated } = await listWorkbenchFilePaths(OWNER, null, {
      ...gate("kept"),
      limit: 6,
    });
    expect(truncated).toBe(true);
    expect(paths).toContain("wiki/");
    expect(paths).toContain("wiki/kept.md");
  });

  it("degrades one unreadable root to an empty branch, keeping the other", async () => {
    // A regular file where a directory is expected: `readdir` rejects with
    // ENOTDIR, which is exactly the "listing failed" case.
    await fs.rm(path.join(tmpDir, "raw"), { recursive: true, force: true });
    await fs.writeFile(path.join(tmpDir, "raw"), "not a directory", "utf-8");
    await fs.writeFile(path.join(tmpDir, "wiki", "a.md"), "a", "utf-8");

    const { paths } = await listWorkbenchFilePaths(OWNER, null, gate("a"));
    expect(paths).toContain("raw/");
    expect(paths).toContain("wiki/a.md");
  });

  it("ships the caps the truncation sentence advertises", () => {
    expect(WORKBENCH_FILE_LIMIT).toBe(2000);
    expect(WORKBENCH_FILE_MAX_DEPTH).toBe(3);
    // Derived, not typed: the numeral cannot outlive the cap.
    expect(FILES_TRUNCATED_COPY).toBe("File list truncated at 2,000 entries.");
  });

  it("says at the switcher what a Wiki switch actually changes", () => {
    // The tenant-flat invariant this suite exercises above (one `wiki/` and one
    // `raw/` under either Wiki) is only honest if the product admits it. This
    // pins BOTH halves so a later edit cannot quietly turn the sentence back
    // into a partitioning promise: what is per-Wiki, and what is shared.
    expect(WIKI_SCOPE_COPY).toContain("purpose.md");
    expect(WIKI_SCOPE_COPY).toContain("Schema");
    expect(WIKI_SCOPE_COPY).toContain("Pages and Sources are shared");
    expect(WIKI_SCOPE_COPY).toBe(
      "Switching wikis shows that wiki’s purpose.md and Schema. Pages and Sources are shared across your wikis.",
    );
    // "shows", never "changes": the changing verbs belong to the WRITES this
    // same surface performs (the rename dialog's "Pages and Sources are not
    // changed", the canvas card's "This overwrites purpose.md, Schema…"), so
    // "switching changes purpose.md" reads as a warning that the switch
    // rewrites the owner's file. A switch writes nothing.
    expect(WIKI_SCOPE_COPY).not.toMatch(/\bchanges\b|\boverwrites\b|\breplaces\b/);
  });
});

// ---------------------------------------------------------------------------
// Tab persistence
// ---------------------------------------------------------------------------

interface FakeWindow {
  localStorage: {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
  };
}

function withWindow(fake: FakeWindow | null, run: () => void): void {
  const holder = globalThis as unknown as { window?: unknown };
  const had = "window" in holder;
  const previous = holder.window;
  if (fake) holder.window = fake;
  else delete holder.window;
  try {
    run();
  } finally {
    if (had) holder.window = previous;
    else delete holder.window;
  }
}

function fakeWindow(store: Map<string, string>): FakeWindow {
  return {
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => void store.set(key, value),
    },
  };
}

describe("tree tab persistence", () => {
  it("keeps the runtime `yopedia` prefix the rebrand does not touch", () => {
    expect(WORKBENCH_TREE_TAB_KEY.startsWith("yopedia_")).toBe(true);
    expect(DEFAULT_TREE_TAB).toBe("knowledge");
    expect(TREE_TABS.map((tab) => tab.label)).toEqual(["Knowledge", "Files"]);
  });

  it("narrows a stored id and rejects anything else", () => {
    expect(isTreeTabId("knowledge")).toBe(true);
    expect(isTreeTabId("files")).toBe(true);
    for (const bad of ["filez", "", "[1]", null, 1, undefined]) {
      expect(isTreeTabId(bad)).toBe(false);
    }
  });

  it("round-trips a stored tab", () => {
    const store = new Map<string, string>();
    withWindow(fakeWindow(store), () => {
      writeStoredTreeTab("files");
      expect(store.get(WORKBENCH_TREE_TAB_KEY)).toBe("files");
      expect(readStoredTreeTab()).toBe("files");
    });
  });

  it("falls back to Knowledge for an unknown or corrupt value", () => {
    for (const bad of ["filez", "", "[1]"]) {
      const store = new Map<string, string>([[WORKBENCH_TREE_TAB_KEY, bad]]);
      withWindow(fakeWindow(store), () => {
        expect(readStoredTreeTab()).toBe("knowledge");
      });
    }
  });

  it("swallows a throwing accessor on both the read and the write", () => {
    const throwing: FakeWindow = {
      localStorage: {
        getItem() {
          throw new Error("denied");
        },
        setItem() {
          throw new Error("quota");
        },
      },
    };
    withWindow(throwing, () => {
      expect(readStoredTreeTab()).toBe("knowledge");
      expect(() => writeStoredTreeTab("files")).not.toThrow();
    });
  });

  it("is a no-op on the server, where there is no window at all", () => {
    withWindow(null, () => {
      expect(readStoredTreeTab()).toBe("knowledge");
      expect(() => writeStoredTreeTab("files")).not.toThrow();
    });
  });
});
