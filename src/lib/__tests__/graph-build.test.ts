import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

import { buildWikiGraph } from "../graph-build";
import { writeWikiPage, updateIndex, ensureDirectories } from "../wiki";
import { upsertCommonsEntry } from "../commons";
import { _resetStorage } from "../storage";
import type { IndexEntry } from "../types";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "graph-build-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) {
    delete process.env.WIKI_DIR;
  } else {
    process.env.WIKI_DIR = originalWikiDir;
  }
  if (originalRawDir === undefined) {
    delete process.env.RAW_DIR;
  } else {
    process.env.RAW_DIR = originalRawDir;
  }
  if (originalDataDir === undefined) {
    delete process.env.DATA_DIR;
  } else {
    process.env.DATA_DIR = originalDataDir;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

/** Write multiple commons pages and rebuild the flat index once at the end. */
async function addCommonsPages(
  pages: Array<{
    slug: string;
    title: string;
    body: string;
    tags?: string[];
    owner?: string;
    type?: string;
  }>,
): Promise<void> {
  const entries: IndexEntry[] = [];
  for (const p of pages) {
    const fmLines: string[] = [];
    if (p.tags) fmLines.push(`tags: [${p.tags.join(", ")}]`);
    if (p.owner) fmLines.push(`owner: ${p.owner}`);
    if (p.type) fmLines.push(`type: ${p.type}`);

    const frontmatter =
      fmLines.length > 0 ? `---\n${fmLines.join("\n")}\n---\n\n` : "";
    const content = `${frontmatter}# ${p.title}\n\n${p.body}\n`;
    await writeWikiPage(p.slug, content);

    entries.push({
      slug: p.slug,
      title: p.title,
      summary: `About ${p.title}`,
      ...(p.owner ? { owner: p.owner } : {}),
      ...(p.type ? { type: p.type } : {}),
    });

    await upsertCommonsEntry({
      tenant: p.owner?.toLowerCase() ?? "yopedia",
      slug: p.slug,
      title: p.title,
      summary: `About ${p.title}`,
      ...(p.tags ? { tags: p.tags } : {}),
      ...(p.owner ? { owner: p.owner } : {}),
      ...(p.type ? { type: p.type } : {}),
    });
  }
  await updateIndex(entries);
}

/* ------------------------------------------------------------------ */
/*  Tests                                                              */
/* ------------------------------------------------------------------ */

describe("buildWikiGraph", () => {
  it("returns empty nodes and edges when no pages exist", async () => {
    const { nodes, edges } = await buildWikiGraph(null, null);
    expect(nodes).toEqual([]);
    expect(edges).toEqual([]);
  });

  it("builds an unscoped graph from commons pages", async () => {
    await addCommonsPages([
      {
        slug: "alpha",
        title: "Alpha",
        body: "See [Beta](beta.md) for details.",
      },
      {
        slug: "beta",
        title: "Beta",
        body: "Related to [Alpha](alpha.md).",
      },
      {
        slug: "gamma",
        title: "Gamma",
        body: "Standalone page with no links.",
      },
    ]);

    const { nodes, edges } = await buildWikiGraph(null, null);

    expect(nodes).toHaveLength(3);
    const slugs = nodes.map((n) => n.id).sort();
    expect(slugs).toEqual(["alpha", "beta", "gamma"]);

    // alpha→beta and beta→alpha
    expect(edges).toHaveLength(2);
    expect(edges).toContainEqual({ source: "alpha", target: "beta" });
    expect(edges).toContainEqual({ source: "beta", target: "alpha" });
  });

  it("excludes self-links from edges", async () => {
    await addCommonsPages([
      {
        slug: "self-ref",
        title: "Self Ref",
        body: "Link to [myself](self-ref.md) and [other](other.md).",
      },
      {
        slug: "other",
        title: "Other",
        body: "No outgoing links.",
      },
    ]);

    const { edges } = await buildWikiGraph(null, null);

    // self-ref→self-ref must NOT appear; self-ref→other must
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ source: "self-ref", target: "other" });
  });

  it("computes linkCount as inbound + outbound per node", async () => {
    // hub links to spoke-a and spoke-b; spoke-a links back to hub
    await addCommonsPages([
      {
        slug: "hub",
        title: "Hub",
        body: "See [A](spoke-a.md) and [B](spoke-b.md).",
      },
      {
        slug: "spoke-a",
        title: "Spoke A",
        body: "Back to [Hub](hub.md).",
      },
      {
        slug: "spoke-b",
        title: "Spoke B",
        body: "Isolated spoke.",
      },
    ]);

    const { nodes, edges } = await buildWikiGraph(null, null);

    // Edges: hub→spoke-a, hub→spoke-b, spoke-a→hub
    expect(edges).toHaveLength(3);

    const byId = new Map(nodes.map((n) => [n.id, n]));
    // hub: 2 outbound + 1 inbound = 3
    expect(byId.get("hub")!.linkCount).toBe(3);
    // spoke-a: 1 outbound + 1 inbound = 2
    expect(byId.get("spoke-a")!.linkCount).toBe(2);
    // spoke-b: 0 outbound + 1 inbound = 1
    expect(byId.get("spoke-b")!.linkCount).toBe(1);
  });

  it("excludes artifact and agent-scoped pages from unscoped graph", async () => {
    // Commons only contains pages that pass belongsInCommons — artifacts and
    // agent-scoped types are filtered out at the commons level. Verify that
    // buildWikiGraph (unscoped) does not include them even if they're in the
    // flat index.
    await addCommonsPages([
      { slug: "normal", title: "Normal", body: "A regular page." },
    ]);

    // Write artifact + agent pages to disk and flat index but NOT the commons
    // (belongsInCommons rejects them, so they never enter the commons index).
    for (const p of [
      { slug: "my-slides", title: "Slides", type: "slides" },
      { slug: "my-html", title: "HTML App", type: "html" },
      { slug: "bot-knowledge", title: "Bot", type: "agent-knowledge" },
    ]) {
      await writeWikiPage(
        p.slug,
        `---\ntype: ${p.type}\n---\n\n# ${p.title}\n\nContent.\n`,
      );
    }

    const { nodes } = await buildWikiGraph(null, null);
    const slugs = nodes.map((n) => n.id);
    expect(slugs).toContain("normal");
    expect(slugs).not.toContain("my-slides");
    expect(slugs).not.toContain("my-html");
    expect(slugs).not.toContain("bot-knowledge");
  });

  it("filters scoped graph to resolved scope slugs and excludes artifact/agent types", async () => {
    // Set up pages owned by "alice" — resolveScope("owner:alice") returns
    // slugs owned by alice. buildWikiGraph then filters through
    // listReadableWikiPages and the scope set.
    await addCommonsPages([
      {
        slug: "alice-page",
        title: "Alice Page",
        body: "See [shared](shared.md).",
        owner: "alice",
      },
      {
        slug: "shared",
        title: "Shared",
        body: "Public knowledge.",
        owner: "alice",
      },
      {
        slug: "bobs-page",
        title: "Bobs Page",
        body: "Not in alice scope.",
        owner: "bob",
      },
    ]);

    // Also write an artifact owned by alice — should be excluded from graph
    // even though it's in scope.
    await writeWikiPage(
      "alice-artifact",
      "---\ntype: html\nowner: alice\n---\n\n# Art\n\nRendered.\n",
    );
    // Must be in the flat index for listReadableWikiPages to find it
    await updateIndex([
      { slug: "alice-page", title: "Alice Page", summary: "s", owner: "alice" },
      { slug: "shared", title: "Shared", summary: "s", owner: "alice" },
      { slug: "bobs-page", title: "Bobs Page", summary: "s", owner: "bob" },
      {
        slug: "alice-artifact",
        title: "Art",
        summary: "s",
        owner: "alice",
        type: "html",
      },
    ]);

    const { nodes, edges } = await buildWikiGraph("owner:alice", null);

    const slugs = nodes.map((n) => n.id).sort();
    // alice-page and shared are alice's; bobs-page is not; alice-artifact is
    // excluded because it's an artifact type.
    expect(slugs).toEqual(["alice-page", "shared"]);

    // alice-page→shared edge should exist
    expect(edges).toContainEqual({ source: "alice-page", target: "shared" });
  });

  it("carries tags from frontmatter into graph nodes", async () => {
    await addCommonsPages([
      {
        slug: "tagged",
        title: "Tagged",
        body: "Has tags.",
        tags: ["ai", "llm"],
      },
      {
        slug: "untagged",
        title: "Untagged",
        body: "No tags.",
      },
    ]);

    const { nodes } = await buildWikiGraph(null, null);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    expect(byId.get("tagged")!.tags).toEqual(["ai", "llm"]);
    expect(byId.get("untagged")!.tags).toEqual([]);
  });

  it("only creates edges to slugs that exist in the graph", async () => {
    await addCommonsPages([
      {
        slug: "linker",
        title: "Linker",
        body: "Links to [existing](existing.md) and [ghost](ghost.md).",
      },
      {
        slug: "existing",
        title: "Existing",
        body: "I exist.",
      },
    ]);

    const { edges } = await buildWikiGraph(null, null);

    // linker→existing should exist; linker→ghost should NOT (ghost not in graph)
    expect(edges).toHaveLength(1);
    expect(edges[0]).toEqual({ source: "linker", target: "existing" });
  });

  it("sets tenant from page owner via ownerToTenant", async () => {
    await addCommonsPages([
      {
        slug: "owned",
        title: "Owned",
        body: "Content.",
        owner: "Alice",
      },
      {
        slug: "unowned",
        title: "Unowned",
        body: "Content.",
      },
    ]);

    const { nodes } = await buildWikiGraph(null, null);
    const byId = new Map(nodes.map((n) => [n.id, n]));

    // ownerToTenant lowercases
    expect(byId.get("owned")!.tenant).toBe("alice");
    // ownerToTenant with no owner returns "yopedia" (DEFAULT_TENANT)
    expect(byId.get("unowned")!.tenant).toBe("yopedia");
  });
});
