/**
 * Story 1.4 — the left column's structural invariants, pinned by source scan.
 *
 * Vitest runs `environment: "node"` and only `src/**\/__tests__/**\/*.test.ts`:
 * there is no jsdom and no testing-library, and adding them is out of scope
 * here (DW-24). So this follows the `single-ia.test.ts` / `workbench-chrome.
 * test.ts` convention and reads the sources as text. What it really pins is
 * that nobody turns the tree into routing, drops the tablist semantics, inlines
 * a sentence next to the shared module, leaks Story 1.5's markdown surface into
 * the Preview dock, reintroduces "Open project folder", or lands the docked
 * grid variants ahead of the rules they have to outrank.
 */
import { describe, expect, it } from "vitest";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
  FILES_EMPTY_COPY,
  FILES_TRUNCATED_COPY,
  FILES_UNAVAILABLE_COPY,
  KNOWLEDGE_EMPTY_COPY,
  KNOWLEDGE_UNAVAILABLE_COPY,
  TREE_NO_WIKI_COPY,
  TREE_TABS,
  TREE_UNAVAILABLE_COPY,
} from "../workbench-tree";

const SRC = path.resolve(__dirname, "../..");
const WORKBENCH = path.join(SRC, "components/workbench");

function read(file: string): Promise<string> {
  return readFile(path.join(WORKBENCH, file), "utf8");
}

function globals(): Promise<string> {
  return readFile(path.join(SRC, "app/globals.css"), "utf8");
}

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const dirent of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, dirent.name);
    // `__tests__` is skipped for the same reason `single-ia.test.ts` skips it:
    // a scan that reads its own assertion text can only ever fail.
    if (dirent.isDirectory()) {
      if (dirent.name === "__tests__") continue;
      out.push(...(await walk(full)));
    }
    else if (/\.(tsx?|css)$/.test(dirent.name)) out.push(full);
  }
  return out;
}

describe("the shell wires the left column without routing", () => {
  it("renders the switcher in the header and the tree only in Wiki mode", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("<WikiSwitcher");
    // The tabs and trees describe the Wiki surface; every other mode keeps
    // Story 1.3's muted label rather than a tree that names nothing on screen.
    expect(source).toMatch(/mode === "wiki" \? \(\s*<TreePanel/);
    expect(source).toContain('className="wb-left-surface"');
    // The product title stays exactly where Story 1.3 put it.
    expect(source).toMatch(/<h1 className="wb-title">\{APP_NAME\}<\/h1>/);
  });

  it("restores and persists the tab through the guarded accessor", async () => {
    // Call sites, not identifiers: a bare name is satisfied by the import line
    // alone, so the restore could be unwired below it without moving this.
    const source = await read("Workbench.tsx");
    expect(source).toContain("setTreeTab(readStoredTreeTab())");
    expect(source).toContain("writeStoredTreeTab(next)");
    // The write stays outside every state updater — React runs updaters twice
    // under StrictMode.
    expect(source).toMatch(/setTreeTab\(next\);\s*\n\s*writeStoredTreeTab\(next\);/);
  });

  it("docks the Preview from shell state, after the canvas, with no route change", async () => {
    const source = await read("Workbench.tsx");
    expect(source).toContain("data-preview=");
    expect(source).toContain("<PreviewColumn");
    // DOM order decides the tab order: rail → left column → canvas → Preview.
    expect(source.indexOf("<ModeCanvas")).toBeLessThan(source.indexOf("<PreviewColumn"));
    // The dock rule itself is a pure function the node suite executes, not a
    // condition typed into JSX where only a grep could reach it.
    expect(source).toContain("shouldDockPreview(mode, selection)");
    // Leaving Wiki mode, switching Wikis, or switching tabs undocks it.
    expect(source).toMatch(
      /setSelection\(null\);\s*\n\s*\}, \[mode, currentWikiId, treeTab\]\)/,
    );
    // Re-picking the selected row deselects it, through the shared equality.
    expect(source).toContain("isSameSelection(current, next) ? null : next");
    // Story 1.3's ban still holds in this file.
    expect(source).not.toContain("router.push(");
    expect(source).not.toMatch(/from "next\/link"/);
    expect(source).not.toMatch(/\buseRouter\(/);
  });

  it("distinguishes a failed read from an empty one on every tab", async () => {
    // A tree that flattens a read failure to zero tells the owner to ingest a
    // source — advice premised on a fact nobody has.
    const source = await read("Workbench.tsx");
    expect(source).toContain("knowledgeUnavailable={knowledgeUnavailable}");
    expect(source).toContain("filesUnavailable={filesUnavailable}");
    const data = await read("WorkbenchData.tsx");
    expect(data).toContain("knowledgeUnavailable: boolean;");
    expect(data).toContain("filesUnavailable: boolean;");
  });
});

describe("TreePanel", () => {
  it("is a real tablist over a real tabpanel", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain('role="tablist"');
    expect(source).toContain('role="tab"');
    expect(source).toContain('role="tabpanel"');
    // Exactly one tab is selected, decided by comparison rather than by a
    // hard-coded index, and the two labels come from the shared module.
    expect(source).toContain("aria-selected={tab === entry.id}");
    expect(source).toContain("TREE_TABS.map");
    expect(TREE_TABS.map((tab) => tab.label)).toEqual(["Knowledge", "Files"]);
    // Only the SELECTED tab controls the one panel — an unselected tab claiming
    // it says it is showing content that belongs to its sibling.
    expect(source).toContain("aria-controls={tab === entry.id ? panelId : undefined}");
  });

  it("renders each tab by name, so a third one cannot inherit the file tree", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain('if (tab === "knowledge")');
    expect(source).toContain('if (tab === "files")');
  });

  it("uses disclosures and a marked selection instead of an unverifiable ARIA tree", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain("aria-expanded={open}");
    expect(source).toMatch(/aria-current=\{[\s\S]{0,160}"true"/);
    // Rows are real buttons in nested lists — no `role="tree"`, no roving
    // tabindex, no arrow-key machinery this suite could not verify.
    expect(source).not.toContain('role="tree"');
    expect(source).not.toContain('role="treeitem"');
    expect(source).toContain('className="wb-tree-list"');
    // Each disclosure names the list it toggles, while that list exists…
    expect(source).toContain("aria-controls={open ? listId : undefined}");
    // …and a directory with nothing in it gets no control at all.
    expect(source).toContain("node.children.length === 0");
    expect(source).toContain("wb-tree-row--static");
  });

  it("sources every sentence from the shared module", async () => {
    const source = await read("TreePanel.tsx");
    expect(source).toContain("@/lib/workbench-tree");
    for (const sentence of [
      TREE_NO_WIKI_COPY,
      TREE_UNAVAILABLE_COPY,
      KNOWLEDGE_UNAVAILABLE_COPY,
      FILES_UNAVAILABLE_COPY,
      KNOWLEDGE_EMPTY_COPY,
      FILES_EMPTY_COPY,
      FILES_TRUNCATED_COPY,
    ]) {
      // A sentence typed here is a second definition of copy the handoff fixes.
      expect(source).not.toContain(sentence);
    }
    expect(source).toContain("KNOWLEDGE_EMPTY_COPY");
    expect(source).toContain("FILES_TRUNCATED_COPY");
  });

  it("distinguishes a failed registry read from an owner with no Wiki", async () => {
    const source = await read("TreePanel.tsx");
    // Both tabs share one branch, so neither tab can claim "No wiki yet." while
    // the truth is that the read failed — the order of the two guards is what
    // makes that impossible, so it is pinned rather than merely present.
    expect(source).toMatch(
      /if \(unavailable\) \{[\s\S]{0,160}TREE_UNAVAILABLE_COPY[\s\S]{0,80}if \(!hasWiki\) \{[\s\S]{0,160}TREE_NO_WIKI_COPY/,
    );
    // Same discrimination per tab: a failed page-index or file read must not
    // reach the owner as "nothing here yet, go ingest something" — and each one
    // names the read that actually failed. The registry sentence would be a
    // false statement here, since the switcher above the tree is at that moment
    // listing the wikis it would claim could not load.
    expect(source).toMatch(
      /if \(knowledgeUnavailable\) \{[\s\S]{0,120}KNOWLEDGE_UNAVAILABLE_COPY/,
    );
    expect(source).toMatch(/if \(filesUnavailable\) \{[\s\S]{0,120}FILES_UNAVAILABLE_COPY/);
    expect(KNOWLEDGE_UNAVAILABLE_COPY).not.toBe(TREE_UNAVAILABLE_COPY);
    expect(FILES_UNAVAILABLE_COPY).not.toBe(TREE_UNAVAILABLE_COPY);
  });

  it("keeps every disclosure reference resolvable and free of stray whitespace", async () => {
    const source = await read("TreePanel.tsx");
    // `aria-controls` is an IDREF LIST: an id built from a free-form page
    // `type` or a filename can carry a space, which splits the value into two
    // references that resolve to nothing. Ids are positional instead.
    expect(source).not.toContain("${baseId}-g-${group.id");
    expect(source).not.toContain("${baseId}-d-${node.path}");
    expect(source).toContain("`${baseId}-g-${index}`");
    expect(source).toContain("`${rowPrefix}-${index}`");
    // A closed disclosure does not render its list, so it must not claim to
    // control one — `aria-expanded` already carries the closed state.
    expect(source).not.toMatch(/aria-controls=\{listId\}/);
    expect(source).toContain("aria-controls={open ? listId : undefined}");
  });
});

describe("WikiSwitcher", () => {
  it("opens the existing dialog rather than forking a second create path", async () => {
    const source = await read("WikiSwitcher.tsx");
    expect(source).toContain('from "@/components/CreateWikiDialog"');
    expect(source).toContain("<CreateWikiDialog");
    expect(source).toContain('"/api/wikis"');
    expect(source).toContain('"/api/wikis/current"');
    // `router.refresh()` is the refresh signal until Story 1.7 replaces it —
    // and it lives here, never in the shell.
    expect(source).toContain("router.refresh()");
  });

  it("does not let an optimistic pick outlive the server's answer", async () => {
    const source = await read("WikiSwitcher.tsx");
    // A stale `pendingId` outranks `currentWikiId` forever, so a switch made
    // from the canvas card would leave this control naming the previous Wiki —
    // and re-picking the option it already shows fires no change event.
    expect(source).toMatch(/setPendingId\(null\);\s*\n\s*\}, \[currentWikiId\]\)/);
    // Every request has a deadline, so `switching` cannot be stranded true by a
    // fetch that never settles — `finally` alone cannot rescue that.
    expect(source).toContain("AbortSignal.timeout(REQUEST_TIMEOUT_MS)");
    expect(source).toContain("setSwitching(false)");
  });

  it("labels the switcher for assistive tech and names the create control", async () => {
    const source = await read("WikiSwitcher.tsx");
    expect(source).toContain("Active wiki");
    expect(source).toContain("htmlFor={selectId}");
    expect(source).toContain("New Wiki");
    // A read failure is not "you have no wikis": same state, same sentence as
    // the canvas card already shows.
    expect(source).toContain("TREE_UNAVAILABLE_COPY");
    // An owner with no Wiki gets no switcher — but still gets the one control
    // that ends that state, so `New Wiki` sits outside the gate.
    expect(source).toContain("wikis.length > 0");
    const gate = source.indexOf("{wikis.length > 0 && (");
    expect(gate).toBeGreaterThan(-1);
    const gated = source.slice(gate, source.indexOf("</select>", gate));
    expect(gated).toContain("Active wiki");
    expect(gated).not.toContain("New Wiki");
  });
});

describe("PreviewColumn ships the header and the frontmatter, and nothing of Story 1.5's", () => {
  it("renders no markdown, no book face, and no edit affordance", async () => {
    const source = await read("PreviewColumn.tsx");
    expect(source.replaceAll("sans-serif", "")).not.toContain("serif");
    expect(source).not.toContain("Georgia");
    expect(source).not.toMatch(/react-markdown|remark|rehype|\bmarked\b|renderMarkdown/);
    // No control at all yet: the confirm-gated escape hatch is Story 1.5's.
    expect(source).not.toContain("<button");
    expect(source).toContain('className="wb-preview-fm"');
    expect(source).toContain("Preview");
  });
});

describe("the retired affordance stays retired", () => {
  it("no source under src/ renders `Open project folder`", async () => {
    const offenders: string[] = [];
    for (const file of await walk(SRC)) {
      if ((await readFile(file, "utf8")).includes("Open project folder")) {
        offenders.push(path.relative(SRC, file));
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("page.tsx loads the trees from the authenticated principal", () => {
  it("passes server-loaded data down and never names an owner itself", async () => {
    const source = await readFile(path.join(SRC, "app/page.tsx"), "utf8");
    expect(source).toContain("listReadableWikiPages(principal)");
    expect(source).toContain("listWorkbenchFilePaths(");
    expect(source).toContain("principal.handle");
    expect(source).toContain("buildKnowledgeTree(pageIndex.entries)");
    expect(source).toContain("buildFileTree(fileListing.paths)");
    // The Files tab is gated by the KNOWLEDGE TREE ITSELF, not by the index it
    // was built from: `buildKnowledgeTree` also drops agent-scoped pages, so a
    // set derived from `pageIndex.entries` would let the Files tab name a page
    // the Knowledge tab hides — a filename is the same disclosure as a title.
    // The derivation itself is a shared function the node suite EXECUTES
    // (`workbench-tree.test.ts`), so what is left to pin here is only that this
    // file calls it on the built tree — an inline expression would have made
    // the rule reachable by grep alone, and a rewrite that kept the comment and
    // read `pageIndex.entries` would have stayed green.
    expect(source).toContain("readableSlugsFromKnowledge(knowledge)");
    expect(source).not.toMatch(/readableSlugs\s*=\s*new Set\(/);
    expect(source).toContain("{ readableSlugs }");
    // The gate is the page index, so a failed index read is a failed file read:
    // an empty slug set filters every page out of `wiki/`, and the tab would
    // otherwise show an empty silo where the truth is "we could not find out".
    expect(source).toContain("fileListing.unavailable || pageIndex.unavailable");
    // The registry and the page index are independent, so they share a round.
    expect(source).toContain("await Promise.all([");
    // Story 1.2's card seeds `useState` from its props, so a header switch
    // followed by `router.refresh()` would leave it naming the previous Wiki.
    expect(source).toContain('key={wikiRegistry.registry.currentId ?? "none"}');
    // No client fetch of tree data, and no second listing path.
    expect(source).not.toContain("fetch(");
  });

  it("hands the working set across the boundary as context, not as shell props", async () => {
    const source = await readFile(path.join(SRC, "app/page.tsx"), "utf8");
    const shell = await read("Workbench.tsx");
    // `workbench-chrome.test.ts` asserts page.tsx contains the literal
    // `<Workbench>`. That assertion is only a real mount check while the
    // element stays bare — props would turn it into `<Workbench\n  …`, and the
    // string would then have to be satisfied by prose somewhere in the file.
    // The provider is what keeps it honest, so both halves are pinned here.
    expect(source).toContain("<WorkbenchDataProvider");
    expect(source).toContain("<Workbench>");
    expect(shell).toContain("useWorkbenchData()");
    expect(shell).not.toContain("knowledge?:");
  });
});

describe("globals.css docks the Preview as a fourth column", () => {
  it("declares the width token and the grid variants", async () => {
    const css = await globals();
    expect(css).toContain("--wb-preview: 360px;");
    // Declared with the rest of the spacing scale, in the ONE `.wb-shell` token
    // block — not in a second block carved out to dodge a test's parser.
    expect(css.match(/^\.wb-shell \{$/gm) ?? []).toHaveLength(1);
    expect(css).toContain('.wb-shell[data-preview="true"] {');
    expect(css).toContain('.wb-shell[data-collapsed="true"][data-preview="true"] {');
    expect(css).toMatch(/\.wb-preview \{\s*grid-column: 4;/);
    expect(css).toContain("var(--wb-split-min-preview)");
  });

  it("orders the docked variants after the rules they must outrank", async () => {
    // `[data-preview]` and `[data-collapsed]` have the same specificity, so
    // source order is the whole mechanism.
    const css = await globals();
    expect(css.indexOf('.wb-shell[data-collapsed="true"] {')).toBeLessThan(
      css.indexOf('.wb-shell[data-preview="true"] {'),
    );
  });

  it("carries the docked variants into both responsive blocks", async () => {
    const css = await globals();
    for (const query of ["@media (max-width: 1199px)", "@media (max-width: 899px)"]) {
      const start = css.lastIndexOf(query);
      expect(start).toBeGreaterThan(-1);
      // Bounded at the NEXT `@media`, not at end of file: slicing to EOF let the
      // 899px block satisfy the 1199px assertion, so deleting the 1199px docked
      // variant would have left this green.
      const next = css.indexOf("@media", start + query.length);
      const block = css.slice(start, next === -1 ? undefined : next);
      expect(block).toContain('[data-preview="true"]');
    }
  });

  it("indents the tree from a token, not from a number in the component", async () => {
    const css = await globals();
    expect(css).toContain("--wb-tree-indent: 12px;");
    expect(css).toContain("var(--wb-tree-indent)");
    const panel = await read("TreePanel.tsx");
    expect(panel).toContain('"--wb-depth"');
  });
});
