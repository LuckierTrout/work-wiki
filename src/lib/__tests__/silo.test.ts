import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { syncSiloForPage, removeSiloForPage, reconcileSilos } from "../silo";
import { writeWikiPage, ensureDirectories, updateIndex } from "../wiki";
import { getStorage, _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "silo-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("syncSiloForPage", () => {
  it("mirrors the page md into tenants/<tenant>/wiki", async () => {
    await writeWikiPage("alpha", "# Alpha\n\nBody.");
    const n = await syncSiloForPage("alpha", "alice");
    expect(n).toBe(1); // just the wiki md (no raw/revisions/discuss/assets)
    expect(await getStorage().readFile("tenants/alice/wiki/alpha.md")).toContain(
      "# Alpha",
    );
  });

  it("re-copies the mutable md but SKIPS already-mirrored immutable revisions", async () => {
    await writeWikiPage("beta", "# Beta\n\nv1");
    // Plant two immutable revision files (as saveRevision would).
    await getStorage().writeFile("wiki/.revisions/beta/1.md", "# Beta\n\nv0");
    await getStorage().writeFile(
      "wiki/.revisions/beta/1.meta.json",
      '{"author":"a"}',
    );

    // First sync copies md + both revision files.
    expect(await syncSiloForPage("beta", "bob")).toBe(3);

    // Second sync (no new revisions) copies ONLY the mutable md again — the two
    // already-mirrored revisions are skipped (the O(N) re-copy fix).
    expect(await syncSiloForPage("beta", "bob")).toBe(1);

    // A newly-added revision IS picked up next sync.
    await getStorage().writeFile("wiki/.revisions/beta/2.md", "# Beta\n\nv1");
    expect(await syncSiloForPage("beta", "bob")).toBe(2); // md + the new revision
  });

  it("mirrors a Source from raw/sources/, and removes it again (Story 2.1)", async () => {
    // Sources moved under `raw/sources/` when Workbench Intake landed. This sync
    // knew only the flat `raw/<slug>.md` address, so every ingest whose snapshot
    // went to the new one mirrored the page and silently left the Source behind
    // — and the Files tab reads `raw/` silo-only (DW-40), so "silently left
    // behind" means "not there at all" from the owner's side.
    await writeWikiPage("delta", "# Delta\n\nBody.");
    await getStorage().writeFile("raw/sources/delta.md", "the source bytes");

    // Two copies: the page md and the Source beside it.
    expect(await syncSiloForPage("delta", "alice")).toBe(2);
    expect(
      await getStorage().readFile("tenants/alice/raw/sources/delta.md"),
    ).toBe("the source bytes");

    // And the removal knows the same address. A delete that missed it would
    // leave a Source in the silo for a page that no longer exists — visible in
    // Files, with nothing to open from the other tab.
    await removeSiloForPage("delta", "alice");
    expect(
      await getStorage().fileExists("tenants/alice/raw/sources/delta.md"),
    ).toBe(false);
    expect(await getStorage().fileExists("tenants/alice/wiki/delta.md")).toBe(false);
  });

  it("still mirrors a pre-move Source from the flat raw root", async () => {
    // The other half of the same change: a workspace ingested BEFORE the move
    // has bytes only at the legacy address, and a sync that assumed one address
    // would stop mirroring for it. Both are copied, each skipped when absent.
    await writeWikiPage("epsilon", "# Epsilon");
    await getStorage().writeFile("raw/epsilon.md", "legacy bytes");

    expect(await syncSiloForPage("epsilon", "alice")).toBe(2);
    expect(await getStorage().readFile("tenants/alice/raw/epsilon.md")).toBe(
      "legacy bytes",
    );
  });

  it("removeSiloForPage clears the page from its silo", async () => {
    await writeWikiPage("gamma", "# Gamma");
    await syncSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      true,
    );
    await removeSiloForPage("gamma", "alice");
    expect(await getStorage().fileExists("tenants/alice/wiki/gamma.md")).toBe(
      false,
    );
  });
});

describe("reconcileSilos", () => {
  it("syncs pages that are missing from their tenant silo", async () => {
    // Write two pages with owner frontmatter.
    await writeWikiPage(
      "page-a",
      "---\nowner: alice\n---\n# Page A\n\nContent A.",
    );
    await writeWikiPage(
      "page-b",
      "---\nowner: bob\n---\n# Page B\n\nContent B.",
    );
    // Populate the index so listWikiPages finds them.
    await updateIndex([
      { slug: "page-a", title: "Page A", summary: "A" },
      { slug: "page-b", title: "Page B", summary: "B" },
    ]);

    // Neither silo exists yet — reconcile should sync both.
    const result = await reconcileSilos();
    expect(result.total).toBe(2);
    expect(result.synced).toBe(2);
    expect(result.alreadyCurrent).toBe(0);
    expect(result.errors).toEqual([]);

    // Verify the silo files were actually created.
    expect(await getStorage().fileExists("tenants/alice/wiki/page-a.md")).toBe(
      true,
    );
    expect(await getStorage().fileExists("tenants/bob/wiki/page-b.md")).toBe(
      true,
    );
  });

  it("skips pages that already have a silo copy", async () => {
    await writeWikiPage(
      "page-c",
      "---\nowner: carol\n---\n# Page C\n\nContent C.",
    );
    await updateIndex([
      { slug: "page-c", title: "Page C", summary: "C" },
    ]);
    // Pre-sync so the silo already exists.
    await syncSiloForPage("page-c", "carol");

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("skips infrastructure slugs (index, log)", async () => {
    await writeWikiPage("real-page", "---\nowner: dan\n---\n# Real\n\nContent.");
    // index and log are infra — they should be skipped.
    await updateIndex([
      { slug: "index", title: "Index", summary: "Index" },
      { slug: "log", title: "Log", summary: "Log" },
      { slug: "real-page", title: "Real", summary: "Content" },
    ]);

    const result = await reconcileSilos();
    expect(result.total).toBe(1); // only real-page counted
    expect(result.synced).toBe(1);
  });

  it("returns a mix of synced and already-current pages", async () => {
    await writeWikiPage(
      "existing",
      "---\nowner: eve\n---\n# Existing\n\nExists.",
    );
    await writeWikiPage(
      "missing",
      "---\nowner: eve\n---\n# Missing\n\nNot synced.",
    );
    await updateIndex([
      { slug: "existing", title: "Existing", summary: "Exists" },
      { slug: "missing", title: "Missing", summary: "Not synced" },
    ]);
    // Only sync 'existing' — leave 'missing' without a silo copy.
    await syncSiloForPage("existing", "eve");

    const result = await reconcileSilos();
    expect(result.total).toBe(2);
    expect(result.synced).toBe(1);
    expect(result.alreadyCurrent).toBe(1);
    expect(result.errors).toEqual([]);
  });

  it("uses DEFAULT_TENANT for pages without an owner", async () => {
    await writeWikiPage("orphan", "# Orphan\n\nNo owner frontmatter.");
    await updateIndex([
      { slug: "orphan", title: "Orphan", summary: "No owner" },
    ]);

    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(1);

    // DEFAULT_TENANT is "work-wiki" — the fallback for ownerless pages.
    expect(await getStorage().fileExists("tenants/yopedia/wiki/orphan.md")).toBe(
      true,
    );
  });

  it("detects and re-syncs stale silo content", async () => {
    const storage = getStorage();

    // Write a page and sync it to the silo.
    await writeWikiPage(
      "stale-page",
      "---\nowner: frank\n---\n# Stale\n\nOriginal content.",
    );
    await updateIndex([
      { slug: "stale-page", title: "Stale", summary: "Original" },
    ]);
    await syncSiloForPage("stale-page", "frank");

    // Verify silo matches flat.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Original content.",
    );

    // Simulate stale silo: update flat WITHOUT re-syncing to silo.
    await writeWikiPage(
      "stale-page",
      "---\nowner: frank\n---\n# Stale\n\nUpdated content.",
    );

    // Silo still has old content.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Original content.",
    );

    // reconcileSilos should detect the divergence and repair it.
    const result = await reconcileSilos();
    expect(result.total).toBe(1);
    expect(result.synced).toBe(0);
    expect(result.stale).toBe(1);
    expect(result.alreadyCurrent).toBe(0);
    expect(result.errors).toEqual([]);

    // Silo should now have the updated content.
    expect(await storage.readFile("tenants/frank/wiki/stale-page.md")).toContain(
      "Updated content.",
    );
  });

  it("removes ghost silo files that have no index entry", async () => {
    const storage = getStorage();

    // A real page: in the index and synced to silo.
    await writeWikiPage("real", "---\nowner: alice\n---\n# Real\n\nContent.");
    await updateIndex([{ slug: "real", title: "Real", summary: "Content" }]);
    await syncSiloForPage("real", "alice");

    // A ghost: silo file exists but NO index entry.
    await storage.writeFile("tenants/alice/wiki/ghost.md", "# Ghost");

    const result = await reconcileSilos();
    expect(result.removed).toBe(1);
    expect(await storage.fileExists("tenants/alice/wiki/ghost.md")).toBe(false);
    // Real page's silo is untouched.
    expect(await storage.fileExists("tenants/alice/wiki/real.md")).toBe(true);
  });
});
