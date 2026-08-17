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
  buildFileTree,
  buildKnowledgeTree,
  findFileNode,
  findKnowledgePage,
  isSameSelection,
  isTreeTabId,
  knowledgeGroupLabel,
  readableSlugsFromKnowledge,
  shouldDockPreview,
  type TreeSelection,
} from "../workbench-tree";
import {
  WORKBENCH_FILE_LIMIT,
  WORKBENCH_FILE_MAX_DEPTH,
  listWorkbenchFilePaths,
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
