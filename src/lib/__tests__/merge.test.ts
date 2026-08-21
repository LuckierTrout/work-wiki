import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// Mock the LLM so reconcilePage is deterministic (overridable per test).
vi.mock("../llm", () => ({
  hasLLMKey: vi.fn(() => true),
  callLLM: vi.fn(async () => "# Merged\n\nFolded body covering both sources."),
}));

import { mergePages } from "../merge";
import { aliasRedirectForMissing } from "../page-redirect";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import {
  beginPageCache,
  ensureDirectories,
  readWikiPage,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
} from "../wiki";
import { serializeSources } from "../sources";
import { extractSummary } from "../ingest";
import { resetSourceIndex } from "../source-index";
import { resetAliasIndex, resolveAlias } from "../alias-index";
import { rebuildBacklinkIndex } from "../backlink-index";
import { listThreads } from "../talk";
import { _resetStorage } from "../storage";
import { hasLLMKey, callLLM } from "../llm";
import type { SourceEntry } from "../types";

const mockedHasLLMKey = vi.mocked(hasLLMKey);
const mockedCallLLM = vi.mocked(callLLM);

let tmpDir: string;
const saved: Record<string, string | undefined> = {};

function src(url: string): SourceEntry {
  return { type: "url", url, fetched: "2026-01-01", triggered_by: "alice" };
}

async function seedPage(
  slug: string,
  opts: {
    title: string;
    owner?: string;
    visibility?: string;
    type?: string;
    created?: string;
    sources?: SourceEntry[];
    body?: string;
  },
): Promise<void> {
  const owner = opts.owner ?? "alice";
  const created = opts.created ?? "2026-01-01";
  const fm: Record<string, string | string[] | number | boolean> = {
    created,
    updated: created,
    owner,
    authors: [owner],
    contributors: [owner],
  };
  if (opts.visibility) fm.visibility = opts.visibility;
  if (opts.type) fm.type = opts.type;
  if (opts.sources) {
    fm.sources = serializeSources(opts.sources);
    fm.source_count = opts.sources.length;
  }
  const body = opts.body ?? `# ${opts.title}\n\nContent about ${opts.title}.`;
  // Seed through the side-effecting write path so the wiki/alias/backlink
  // indexes populate exactly as a real write would.
  await writeWikiPageWithSideEffects({
    slug,
    title: opts.title,
    content: serializeFrontmatter(fm, body),
    summary: extractSummary(body.replace(/^#\s+.+$/m, "").trim()) || opts.title,
    logOp: "ingest",
    crossRefSource: null,
    author: owner,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "merge-test-"));
  for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) saved[k] = process.env[k];
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  _resetStorage();
  resetSourceIndex();
  resetAliasIndex();
  vi.clearAllMocks();
  mockedHasLLMKey.mockReturnValue(true);
  mockedCallLLM.mockResolvedValue("# Merged\n\nFolded body covering both sources.");
  await ensureDirectories();
});

afterEach(async () => {
  for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetSourceIndex();
  resetAliasIndex();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mergePages", () => {
  it("folds bodies, unions provenance + aliases, and deletes the absorbed page", async () => {
    await seedPage("agent-harness", {
      title: "Agent Harness",
      created: "2026-02-01",
      sources: [src("https://x.com/i/status/1")],
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      created: "2026-01-15", // earlier
      sources: [src("https://example.com/article")],
    });

    const result = await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    expect(result).toMatchObject({
      fromSlug: "harness-ai-agents",
      intoSlug: "agent-harness",
      disputed: false,
    });

    // Absorbed page is gone; survivor remains with the folded body.
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
    const into = await readWikiPageWithFrontmatter("agent-harness");
    expect(into).not.toBeNull();
    expect(into!.body).toContain("Folded body covering both sources.");

    // Provenance unioned; from's title + slug recorded as aliases of the survivor.
    const aliases = into!.frontmatter.aliases as string[];
    expect(aliases).toContain("Harness (AI agents)");
    expect(aliases).toContain("harness-ai-agents"); // slug alias powers the redirect
    expect(into!.frontmatter.source_count).toBe(2);
    // Earlier created date wins; two distinct sources raise confidence above a lone 0.6.
    expect(into!.frontmatter.created).toBe("2026-01-15");
    expect(into!.frontmatter.confidence as number).toBeGreaterThan(0.6);

    // The absorbed slug still resolves to the survivor via the alias index,
    // and the owner route's miss path forwards it (one 308) to the survivor's
    // canonical owner-scoped URL.
    resetAliasIndex();
    expect(await resolveAlias("harness-ai-agents")).toBe("agent-harness");
    expect(await aliasRedirectForMissing("harness-ai-agents", null)).toBe(
      "/u/alice/agent-harness",
    );
  });

  it("re-points internal backlinks from the absorbed slug to the survivor BEFORE deleting", async () => {
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("other", {
      title: "Other",
      body: "# Other\n\nSee the [harness](harness-ai-agents.md) page.",
    });

    const result = await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    expect(result.repointedBacklinksFrom).toContain("other");
    const other = await readWikiPage("other");
    expect(other!.content).toContain("](agent-harness.md)");
    expect(other!.content).not.toContain("](harness-ai-agents.md)");
  });

  it("re-points via the precomputed backlink index when it's present (the production fast path)", async () => {
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("other", {
      title: "Other",
      body: "# Other\n\nSee the [harness](harness-ai-agents.md) page.",
    });
    // Build the index so getBacklinkIndex() is non-null → exercises the
    // `index[fromSlug]` fast path rather than the full-scan fallback.
    await rebuildBacklinkIndex();

    const result = await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    expect(result.repointedBacklinksFrom).toContain("other");
    const other = await readWikiPage("other");
    expect(other!.content).toContain("](agent-harness.md)");
    expect(other!.content).not.toContain("](harness-ai-agents.md)");
  });

  it("escalates `disputed` (and caps confidence) when the fold finds a contradiction", async () => {
    await seedPage("agent-harness", {
      title: "Agent Harness",
      sources: [src("https://x.com/i/status/1")],
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      sources: [src("https://example.com/article")],
    });
    mockedCallLLM.mockResolvedValue(
      "DISPUTED: yes\n\n# Agent Harness\n\nSources disagree on the definition.",
    );

    const result = await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    expect(result.disputed).toBe(true);
    const into = await readWikiPageWithFrontmatter("agent-harness");
    expect(into!.frontmatter.disputed).toBe(true);
    expect(into!.frontmatter.confidence as number).toBeLessThanOrEqual(0.5);

    // A disputed fold used to open a reconciliation thread on the survivor.
    // Removed with the other two call sites (DW-230): the talk HTTP surfaces are
    // retired, so no surface could read it. `disputed` on the survivor — and in
    // the returned result above — is the whole record, and the write must stay
    // gone.
    expect(await listThreads("agent-harness")).toEqual([]);
  });

  it("appends both bodies (no reconcile) when there's no LLM key", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", {
      title: "Agent Harness",
      body: "# Agent Harness\n\nThe harness loop.",
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nContext window management.",
    });

    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    const into = await readWikiPageWithFrontmatter("agent-harness");
    expect(into!.body).toContain("The harness loop.");
    expect(into!.body).toContain("Context window management.");
    expect(mockedCallLLM).not.toHaveBeenCalled();
  });

  it("rejects merging a page into itself and a missing page", async () => {
    await seedPage("agent-harness", { title: "Agent Harness" });
    await expect(mergePages({ from: "agent-harness", into: "agent-harness" })).rejects.toThrow(
      /into itself/,
    );
    await expect(
      mergePages({ from: "ghost", into: "agent-harness", actor: "alice" }),
    ).rejects.toThrow(/not found/);
  });

  it("rejects an artifact survivor and a public→private merge", async () => {
    await seedPage("deck", { title: "Deck", type: "slides" });
    await seedPage("note", { title: "Note" });
    await expect(
      mergePages({ from: "note", into: "deck", actor: "alice" }),
    ).rejects.toThrow(/artifact/);

    await seedPage("public-pg", { title: "Public Pg" });
    await seedPage("private-pg", { title: "Private Pg", visibility: "private" });
    await expect(
      mergePages({ from: "public-pg", into: "private-pg", actor: "alice" }),
    ).rejects.toThrow(/private/);
  });

  it("rejects a cross-owner merge without an admin caller", async () => {
    await seedPage("alice-pg", { title: "Alice Pg", owner: "alice" });
    await seedPage("bob-pg", { title: "Bob Pg", owner: "bob" });
    await expect(
      mergePages({ from: "bob-pg", into: "alice-pg", actor: "alice" }),
    ).rejects.toThrow(/same owner/);
    // An admin caller bypasses the owner guard AND unions both pages'
    // contributors/authors (deduped) onto the survivor.
    const result = await mergePages({ from: "bob-pg", into: "alice-pg", bypassOwnerCheck: true });
    expect(result.intoSlug).toBe("alice-pg");
    const into = await readWikiPageWithFrontmatter("alice-pg");
    expect(into!.frontmatter.contributors as string[]).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
    expect((into!.frontmatter.contributors as string[]).length).toBe(2); // deduped
    expect(into!.frontmatter.authors as string[]).toEqual(
      expect.arrayContaining(["alice", "bob"]),
    );
  });
});

describe("aliasRedirectForMissing (alias redirect safety)", () => {
  it("never forwards an anonymous viewer to a private page, but forwards its owner", async () => {
    // A private page that happens to carry an alias must not be reachable by a
    // viewer who can't read it — forwarding would be an existence oracle. The
    // owner, though, must reach their own private survivor.
    const fm = serializeFrontmatter(
      {
        created: "2026-01-01",
        updated: "2026-01-01",
        owner: "alice",
        visibility: "private",
        aliases: ["ghost-alias"],
      },
      "# Secret\n\nPrivate body.",
    );
    await writeWikiPageWithSideEffects({
      slug: "secret",
      title: "Secret",
      content: fm,
      summary: "secret",
      logOp: "ingest",
      crossRefSource: null,
      author: "alice",
    });
    resetAliasIndex();
    expect(await aliasRedirectForMissing("ghost-alias", null)).toBeNull();
    expect(
      await aliasRedirectForMissing("ghost-alias", { id: "user_alice", handle: "alice" }),
    ).toBe("/u/alice/secret");
  });

  it("returns null for a slug with no alias", async () => {
    await seedPage("real", { title: "Real" });
    resetAliasIndex();
    expect(await aliasRedirectForMissing("nonexistent", null)).toBeNull();
  });

  it("forwards an alias of an ownerless page to the DEFAULT_TENANT canonical URL", async () => {
    // Ownerless/seed content lives under the default tenant, so its aliases
    // forward there — via tenantForOwner(undefined), never an empty segment.
    const fm = serializeFrontmatter(
      {
        created: "2026-01-01",
        updated: "2026-01-01",
        aliases: ["seed-alias"],
      },
      "# Seed\n\nSeed body.",
    );
    await writeWikiPageWithSideEffects({
      slug: "seed-page",
      title: "Seed",
      content: fm,
      summary: "seed",
      logOp: "ingest",
      crossRefSource: null,
    });
    resetAliasIndex();
    expect(await aliasRedirectForMissing("seed-alias", null)).toBe(
      "/u/yopedia/seed-page",
    );
  });

  it("never self-redirects an existing-but-unreadable page (canonical !== slug guard)", async () => {
    // The alias index maps every LIVE slug to itself, so a private page whose
    // slug is looked up by a viewer who can't read it resolves to its own slug.
    // Without the guard that would 308 the miss path to its own URL forever.
    await seedPage("locked", { title: "Locked", visibility: "private" });
    resetAliasIndex();
    expect(await resolveAlias("locked")).toBe("locked");
    expect(await aliasRedirectForMissing("locked", null)).toBeNull();
  });

  it("fails closed (null, not a throw) when a page file has malformed frontmatter", async () => {
    // Building the alias index parses every page's frontmatter, so one corrupt
    // file would otherwise turn every missing-page request into a 500. The
    // resolver must degrade to the 404 UI (null), never propagate the error.
    await seedPage("healthy", { title: "Healthy" });
    const files = (await fs.readdir(process.env.WIKI_DIR!, {
      recursive: true,
    })) as string[];
    const target = files.find((f) => f.endsWith("healthy.md"));
    expect(target).toBeDefined();
    await fs.writeFile(
      path.join(process.env.WIKI_DIR!, target!),
      "---\ncreated: 2026-01-01\n# no closing delimiter",
      "utf8",
    );
    resetAliasIndex();
    // The corruption genuinely breaks index building (guards against this test
    // passing vacuously)...
    await expect(resolveAlias("anything")).rejects.toThrow();
    // ...and the resolver still fails closed instead of rejecting.
    await expect(aliasRedirectForMissing("anything", null)).resolves.toBeNull();
  });
});

// ===========================================================================
// Both merge bases are the STORED files, not cached ones (DW-379)
// ===========================================================================

describe("mergePages — a stale page cache is open", () => {
  it("folds the STORED bytes of both sides, not the cached copies", async () => {
    // `pageCache` is module-global and ref-counted around bulk scans, so one
    // can be holding superseded entries open when a merge runs. This is the
    // worst of the read-modify-write paths: the fold is written to the survivor
    // and then `from` is HARD-deleted, taking its revisions with it — so a
    // stale side loses whatever was saved to it in between with no copy of it
    // anywhere.
    mockedHasLLMKey.mockReturnValue(false); // fold = `into.body` + `from.body`, verbatim

    await seedPage("survivor", { title: "Survivor", body: "# Survivor\n\nCached survivor body." });
    await seedPage("absorbed", { title: "Absorbed", body: "# Absorbed\n\nCached absorbed body." });

    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the cache for BOTH sides.
      const cachedInto = (await readWikiPageWithFrontmatter("survivor"))!;
      const cachedFrom = (await readWikiPageWithFrontmatter("absorbed"))!;
      expect(cachedInto.body).toContain("Cached survivor body.");
      expect(cachedFrom.body).toContain("Cached absorbed body.");

      // Both files move underneath it. Written DIRECTLY, past the write path —
      // which invalidates — because STALE entries are what this row is about.
      await fs.writeFile(
        cachedInto.path,
        serializeFrontmatter(
          { ...cachedInto.frontmatter, tags: ["stored-into"] },
          "# Survivor\n\nStored survivor body, LATER.",
        ),
        "utf-8",
      );
      await fs.writeFile(
        cachedFrom.path,
        serializeFrontmatter(
          { ...cachedFrom.frontmatter },
          "# Absorbed\n\nStored absorbed body, LATER.",
        ),
        "utf-8",
      );
      // The cache is genuinely stale: cached reads still serve the old bytes.
      expect((await readWikiPageWithFrontmatter("survivor"))!.body).toContain(
        "Cached survivor body.",
      );
      expect((await readWikiPageWithFrontmatter("absorbed"))!.body).toContain(
        "Cached absorbed body.",
      );

      await mergePages({ from: "absorbed", into: "survivor", actor: "alice" });

      const merged = (await readWikiPageWithFrontmatter("survivor", {
        fresh: true,
      }))!;
      // Both sides came from storage…
      expect(merged.body).toContain("Stored survivor body, LATER.");
      expect(merged.body).toContain("Stored absorbed body, LATER.");
      // …and neither cached copy was folded back in, which is what would have
      // reverted the two intervening saves.
      expect(merged.body).not.toContain("Cached survivor body.");
      expect(merged.body).not.toContain("Cached absorbed body.");
      // The survivor's frontmatter merge base is the stored one too.
      expect(merged.frontmatter.tags).toEqual(["stored-into"]);
    } finally {
      cleanup();
    }
  });
});

// ===========================================================================
// The backlink re-point reads past the cache too, and names its own abort
// (DW-379, P1/P5)
// ===========================================================================

describe("mergePages — re-pointing backlinks", () => {
  it("re-points from the STORED bytes of the linker, not a cached copy", async () => {
    // The third fresh read in this file (`merge.ts`'s `repointBacklinks`), and
    // the one the `into`/`from` row above cannot reach: with only two pages
    // seeded there is no linker to iterate, so that row leaves this call site
    // covered by nothing. Here the linker's bytes are rewritten and written
    // straight back — a merge base like any other, and a stale one reverts
    // whatever was saved to that page in between while re-pointing its link.
    mockedHasLLMKey.mockReturnValue(false);

    await seedPage("survivor-b", { title: "Survivor B" });
    await seedPage("absorbed-b", { title: "Absorbed B" });
    await seedPage("linker-b", {
      title: "Linker B",
      body: "# Linker B\n\nCached linker body. See [it](absorbed-b.md).",
    });

    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the linker's cache entry…
      const cached = (await readWikiPageWithFrontmatter("linker-b"))!;
      expect(cached.content).toContain("Cached linker body.");

      // …then someone edits that page. Written DIRECTLY, past the write path —
      // which invalidates — because a STALE entry is what this row is about.
      // The link survives the edit, so there is still something to re-point.
      await fs.writeFile(
        cached.path,
        cached.content.replace(
          "Cached linker body.",
          "Stored linker body, LATER.",
        ),
        "utf-8",
      );
      expect((await readWikiPageWithFrontmatter("linker-b"))!.content).toContain(
        "Cached linker body.",
      );

      const result = await mergePages({
        from: "absorbed-b",
        into: "survivor-b",
        actor: "alice",
      });
      expect(result.repointedBacklinksFrom).toContain("linker-b");

      const after = (await readWikiPage("linker-b", { fresh: true }))!;
      // The re-point landed…
      expect(after.content).toContain("](survivor-b.md)");
      expect(after.content).not.toContain("](absorbed-b.md)");
      // …on top of the STORED body. Without the fresh read the cached copy is
      // written back and the intervening edit is gone — and unlike the survivor,
      // this page is not even a party to the merge.
      expect(after.content).toContain("Stored linker body, LATER.");
      expect(after.content).not.toContain("Cached linker body.");
    } finally {
      cleanup();
    }
  });

  it("aborts with its OWN message when a linker cannot be read, not the save-door sentence", async () => {
    // The fresh read refuses a non-ENOENT fault by throwing
    // `PageUnreadableError`, whose message is `PAGE_UNREADABLE_COPY` — "so
    // nothing was changed". Relayed raw from here that is FALSE: this loop may
    // already have re-pointed and written earlier linkers. `repointBacklinks`
    // catches it and rethrows the accurate abort it has always thrown, naming
    // the page and the merge, with the refusal kept as `cause`.
    mockedHasLLMKey.mockReturnValue(false);

    await seedPage("survivor-c", { title: "Survivor C" });
    await seedPage("absorbed-c", { title: "Absorbed C" });
    await seedPage("linker-c", {
      title: "Linker C",
      body: "# Linker C\n\nSee [it](absorbed-c.md).",
    });

    // Fail ONLY the linker's reads — the two merge sides still read for real, so
    // the failure lands where this row claims it does: inside the re-point loop.
    const { getStorage } = await import("../storage");
    const { tenantForOwner, tenantWikiRelPath, wikiRelPath } = await import("../wiki");
    const targets = new Set([
      wikiRelPath("linker-c.md"),
      tenantWikiRelPath(tenantForOwner("alice"), "linker-c.md"),
    ]);
    const storage = getStorage();
    const real = storage.readFile.bind(storage);
    const spy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (targets.has(target)) {
          const err = new Error(`EIO: i/o error, read '${target}'`) as NodeJS.ErrnoException;
          err.code = "EIO";
          throw err;
        }
        return real(target);
      });

    try {
      const rejection = await mergePages({
        from: "absorbed-c",
        into: "survivor-c",
        actor: "alice",
      }).then(
        () => null,
        (err: unknown) => err as Error,
      );

      expect(rejection).toBeInstanceOf(Error);
      // The accurate sentence: which linker, which merge.
      expect(rejection!.message).toBe(
        'merge aborted: backlink source "linker-c" could not be read while re-pointing links from "absorbed-c" to "survivor-c"',
      );
      // NOT the save-door copy, which would claim nothing was changed.
      const { PAGE_UNREADABLE_COPY } = await import("../page-read-failure");
      expect(rejection!.message).not.toBe(PAGE_UNREADABLE_COPY);
      // The refusal is still reachable underneath, so the EIO is not lost.
      const cause = (rejection as Error & { cause?: unknown }).cause;
      expect((cause as Error | undefined)?.name).toBe("PageUnreadableError");
    } finally {
      spy.mockRestore();
    }

    // And the merge really did abort: `from` is intact rather than hard-deleted
    // with an un-re-pointed link left behind.
    expect(await readWikiPage("absorbed-c")).not.toBeNull();
  });
});
