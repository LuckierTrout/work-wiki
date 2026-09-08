import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  belongsInCommons,
  isVaultEligible,
  getCommonsIndex,
  upsertCommonsEntry,
  syncCommonsForPage,
  removeCommonsEntryBySlug,
  rebuildCommonsIndex,
  listCommonsPages,
} from "../commons";
import { ensureDirectories, writeWikiPage } from "../wiki";
import { _resetStorage } from "../storage";

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "commons-test-"));
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) saved[k] = process.env[k];
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  for (const k of ["WIKI_DIR", "RAW_DIR", "DATA_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("belongsInCommons", () => {
  it("public non-agent pages belong; private + agent-scoped do not", () => {
    expect(belongsInCommons({})).toBe(true);
    expect(belongsInCommons({ visibility: "public" })).toBe(true);
    expect(belongsInCommons({ visibility: "private" })).toBe(false);
    expect(belongsInCommons({ type: "agent-knowledge" })).toBe(false);
    expect(belongsInCommons({ type: "agent-identity" })).toBe(false);
    expect(belongsInCommons({ type: "wiki" })).toBe(true);
  });

  it("excludes saved HTML artifacts (personal rendered outputs)", () => {
    expect(belongsInCommons({ type: "html" })).toBe(false);
  });
});

describe("isVaultEligible", () => {
  it("allows public pages INCLUDING artifacts (unlike belongsInCommons)", () => {
    expect(isVaultEligible({})).toBe(true);
    expect(isVaultEligible({ type: "wiki" })).toBe(true);
    // The key difference: artifacts ARE curatable into a vault.
    expect(isVaultEligible({ type: "html" })).toBe(true);
    expect(isVaultEligible({ type: "slides" })).toBe(true);
    expect(belongsInCommons({ type: "html" })).toBe(false); // contrast
  });

  it("excludes private pages (a vault references by slug → would leak) and agent-scoped", () => {
    expect(isVaultEligible({ visibility: "private" })).toBe(false);
    expect(isVaultEligible({ visibility: "private", type: "html" })).toBe(false);
    expect(isVaultEligible({ type: "agent-knowledge" })).toBe(false);
    expect(isVaultEligible({ type: "agent-identity" })).toBe(false);
  });
});

describe("syncCommonsForPage — retired (AD-21)", () => {
  it("performs NO storage I/O for a public page", async () => {
    await syncCommonsForPage("p", {
      owner: "alice",
      visibility: "public",
      title: "P",
      summary: "s",
    });
    expect(await getCommonsIndex()).toHaveLength(0);
  });

  it("performs NO storage I/O for an ownerless page", async () => {
    await syncCommonsForPage("o", { title: "O", summary: "" });
    expect(await getCommonsIndex()).toHaveLength(0);
  });

  it("never removes an existing entry either — it reads and writes nothing", async () => {
    await upsertCommonsEntry({ tenant: "alice", slug: "x", title: "X", summary: "" });
    await syncCommonsForPage("x", {
      owner: "alice",
      visibility: "private",
      title: "X",
      summary: "",
    });
    expect(await getCommonsIndex()).toHaveLength(1);
  });

  it("resolves and never throws", async () => {
    await expect(
      syncCommonsForPage("p", { title: "P", summary: "" }),
    ).resolves.toBeUndefined();
  });
});

describe("entry keying is (tenant, slug)", () => {
  it("the same slug under two tenants is two distinct rows", async () => {
    await upsertCommonsEntry({ tenant: "alice", slug: "p", title: "A", summary: "" });
    await upsertCommonsEntry({ tenant: "bob", slug: "p", title: "B", summary: "" });
    const idx = await getCommonsIndex();
    expect(idx).toHaveLength(2);
    expect(idx.map((e) => e.tenant).sort()).toEqual(["alice", "bob"]);
  });
});

describe("removeCommonsEntryBySlug", () => {
  it("removes an entry regardless of which tenant owns it", async () => {
    // caller doesn't know the tenant; the entry belongs to bob
    await upsertCommonsEntry({ tenant: "bob", slug: "p", title: "P", summary: "" });
    await removeCommonsEntryBySlug("p");
    expect(await getCommonsIndex()).toHaveLength(0);
    // no-op when absent
    await removeCommonsEntryBySlug("nope");
  });
});

describe("rebuildCommonsIndex", () => {
  async function createPage(slug: string, frontmatter: string, title: string) {
    await ensureDirectories();
    await writeWikiPage(slug, `---\n${frontmatter}\n---\n\n# ${title}\n\nBody.`);
    const indexPath = path.join(process.env.WIKI_DIR!, "index.md");
    let existing = "";
    try {
      existing = await fs.readFile(indexPath, "utf-8");
    } catch {
      /* none */
    }
    const line = `- [${title}](${slug}.md) — ${title}`;
    await fs.writeFile(
      indexPath,
      existing ? `${existing.trimEnd()}\n${line}\n` : `# Wiki Index\n\n${line}\n`,
      "utf-8",
    );
  }

  it("indexes public pages only (excludes private + agent)", async () => {
    await createPage("pub", "owner: alice\nvisibility: public", "Public");
    await createPage("priv", "owner: alice\nvisibility: private", "Private");
    await createPage("ag", "owner: alice--yoyo\ntype: agent-knowledge", "Agent");

    const count = await rebuildCommonsIndex();
    const idx = await getCommonsIndex();
    const slugs = idx.map((e) => e.slug).sort();
    expect(count).toBe(1);
    expect(slugs).toEqual(["pub"]);
    expect(idx[0].tenant).toBe("alice");
  });

  it("listCommonsPages derives the public, non-agent set from the flat index", async () => {
    await createPage("pub", "owner: alice\nvisibility: public", "Public");
    await createPage("priv", "owner: alice\nvisibility: private", "Private");
    await createPage("ag", "owner: alice--yoyo\ntype: agent-knowledge", "Agent");
    expect(await getCommonsIndex()).toEqual([]);
    const pages = await listCommonsPages();
    expect(pages.map((p) => p.slug).sort()).toEqual(["pub"]);
  });

  // REGRESSION GUARD: listCommonsPages used to PREFER the stored commons index
  // and only scan when it was empty. With syncCommonsForPage retired to a no-op
  // (AD-21) while deletes still prune the index, a populated production index
  // would freeze and then monotonically shrink — /wiki/graph, /wiki/log,
  // unscoped MCP wiki_graph, browse.ts and search.ts would all serve a stale
  // page set forever. It must ALWAYS derive live.
  it("ignores a populated (stale) commons index and still sees a new page", async () => {
    // A stale index: one entry that no longer corresponds to any live page.
    await upsertCommonsEntry({
      tenant: "alice",
      owner: "alice",
      slug: "ghost",
      title: "Ghost",
      summary: "written before the commons was retired",
    });
    expect(await getCommonsIndex()).toHaveLength(1);

    // A page written AFTER the index froze must still be listed...
    await createPage("fresh", "owner: alice\nvisibility: public", "Fresh");
    const pages = await listCommonsPages();
    expect(pages.map((p) => p.slug)).toContain("fresh");
    // ...and the frozen entry must not resurrect a page that isn't there.
    expect(pages.map((p) => p.slug)).not.toContain("ghost");
  });

  it("keeps a page visible after the stored index entry is pruned", async () => {
    await createPage("kept", "owner: alice\nvisibility: public", "Kept");
    await upsertCommonsEntry({ tenant: "alice", slug: "kept", title: "Kept", summary: "" });
    await removeCommonsEntryBySlug("kept");
    expect(await getCommonsIndex()).toEqual([]);
    // The live page is unaffected by the index pruning.
    expect((await listCommonsPages()).map((p) => p.slug)).toContain("kept");
  });
});
