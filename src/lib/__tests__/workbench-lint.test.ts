import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { resetAliasIndex } from "../alias-index";
import { _resetStorage } from "../storage";
import { checkInboundWikilinkOrphans, runWorkbenchLint } from "../workbench-lint";
import { ensureDirectories, updateIndex, writeWikiPage } from "../wiki";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workbench-lint-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  resetAliasIndex();
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  resetAliasIndex();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("inbound-wikilink orphans", () => {
  it("lists a page with no inbound wikilink and excludes bookkeeping pages", async () => {
    for (const slug of ["purpose", "schema", "index", "log", "overview", "lonely"]) {
      await writeWikiPage(
        slug,
        `# ${slug}\n\nEnough body copy for this ${slug} page to exist as a node.`,
      );
    }
    await writeWikiPage(
      "hub",
      "# Hub\n\nThis page points at [Purpose](purpose.md) only.",
    );
    const slugs = ["purpose", "schema", "index", "log", "overview", "lonely", "hub"];
    const issues = await checkInboundWikilinkOrphans(slugs);
    const found = issues.map((issue) => issue.slug).sort();
    expect(found).toContain("lonely");
    expect(found).toContain("hub");
    expect(found).not.toContain("purpose");
    expect(found).not.toContain("schema");
    expect(found).not.toContain("index");
    expect(found).not.toContain("log");
    expect(found).not.toContain("overview");
  });

  it("does not count a self-link as inbound reachability", async () => {
    await writeWikiPage("loop", "# Loop\n\nThis page only points at [[loop]].\n");
    const issues = await checkInboundWikilinkOrphans(["loop"]);
    expect(issues.map((issue) => issue.slug)).toContain("loop");
  });

  it("counts an alias inbound link toward the canonical page", async () => {
    await writeWikiPage(
      "current-name",
      "---\ntitle: Current\naliases: [old-name]\n---\n\n# Current\n\nCanonical page.\n",
    );
    await writeWikiPage("hub", "# Hub\n\nSee [[old-name]].\n");
    await updateIndex([
      { slug: "current-name", title: "Current", summary: "canonical" },
      { slug: "hub", title: "Hub", summary: "linker" },
    ]);
    resetAliasIndex();
    const issues = await checkInboundWikilinkOrphans(["current-name", "hub"]);
    expect(issues.map((issue) => issue.slug)).not.toContain("current-name");
  });

  it("does not count an alias-resolved self-link as inbound reachability", async () => {
    await writeWikiPage(
      "current-name",
      "---\ntitle: Current\naliases: [old-name]\n---\n\n# Current\n\nOnly [[old-name]] points here.\n",
    );
    await updateIndex([{ slug: "current-name", title: "Current", summary: "canonical" }]);
    resetAliasIndex();
    const issues = await checkInboundWikilinkOrphans(["current-name"]);
    expect(issues.map((issue) => issue.slug)).toContain("current-name");
  });
});

describe("runWorkbenchLint", () => {
  it("omits semantic LLM classes when the toggle is off", async () => {
    await writeWikiPage("alpha", "# Alpha\n\nA short page with enough words to stay.");
    await updateIndex([{ slug: "alpha", title: "Alpha", summary: "A page" }]);
    const issues = await runWorkbenchLint({ semantic: false });
    const types = new Set(issues.map((issue) => issue.type));
    expect(types.has("contradiction")).toBe(false);
    expect(types.has("missing-concept-page")).toBe(false);
    expect(types.has("incomplete-coverage")).toBe(false);
    expect(types.has("uncited-claims")).toBe(false);
  });

  it("promotes a leftover renamed-slug link instead of calling it broken", async () => {
    await writeWikiPage(
      "current-name",
      "---\ntitle: Current\naliases: [old-name]\n---\n\n# Current\n\nThe renamed page.\n",
    );
    await writeWikiPage(
      "linker",
      "# Linker\n\nSee [[old-name]] and [Old](old-name.md) for the rest of this sentence.\n",
    );
    await updateIndex([
      { slug: "current-name", title: "Current", summary: "renamed" },
      { slug: "linker", title: "Linker", summary: "still points at old-name" },
    ]);
    resetAliasIndex();
    const issues = await runWorkbenchLint({ semantic: false });
    const renamed = issues.filter((issue) => issue.type === "renamed-slug" && issue.target === "old-name");
    const broken = issues.filter((issue) => issue.type === "broken-link" && issue.target === "old-name");
    expect(renamed.length).toBeGreaterThan(0);
    expect(renamed.every((issue) => issue.fix === "renamed-slug")).toBe(true);
    expect(broken).toHaveLength(0);
  });

  it("only offers a dangling-link fix for a real prose wikilink", async () => {
    await writeWikiPage(
      "linker",
      "# Linker\n\nSee [Markdown only](missing-markdown.md) and [[missing-wiki]].\n",
    );
    await updateIndex([{ slug: "linker", title: "Linker", summary: "broken links" }]);
    const issues = await runWorkbenchLint({ semantic: false });
    const markdown = issues.find(
      (issue) => issue.type === "broken-link" && issue.target === "missing-markdown",
    );
    const wikilink = issues.find(
      (issue) => issue.type === "broken-link" && issue.target === "missing-wiki",
    );
    expect(markdown).toBeDefined();
    expect(markdown?.fix).toBeUndefined();
    expect(wikilink?.fix).toBe("dangling-wikilink");
  });

  it("points semantic gaps at Graph Insights instead of listing them", async () => {
    await writeWikiPage("alpha", "# Alpha\n\nA short page with enough words to stay.");
    await updateIndex([{ slug: "alpha", title: "Alpha", summary: "A page" }]);
    const issues = await runWorkbenchLint({ semantic: true });
    const types = new Set(issues.map((issue) => issue.type));
    expect(types.has("missing-concept-page")).toBe(false);
    expect(types.has("incomplete-coverage")).toBe(false);
    expect(types.has("insight-pointer")).toBe(true);
  });
});
