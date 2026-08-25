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
import {
  deleteWikiPage,
  deleteWikiPageWhileLocked,
  withPageLifecycleLocks,
  writeWikiPageWithSideEffects,
} from "../lifecycle";
import {
  ensureDirectories,
  listWikiPages,
  readWikiPage,
  readWikiPageWithFrontmatter,
  serializeFrontmatter,
  updateIndex,
} from "../wiki";
import { serializeSources } from "../sources";
import { extractSummary } from "../ingest";
import { resetSourceIndex } from "../source-index";
import { resetAliasIndex, resolveAlias } from "../alias-index";
import { rebuildBacklinkIndex } from "../backlink-index";
import { listThreads } from "../talk";
import { _resetStorage, getStorage } from "../storage";
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
  vi.restoreAllMocks();
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
  }, 15_000);

  it("does not move backlinks when the survivor compare-and-set loses", async () => {
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("other", {
      title: "Other",
      body: "# Other\n\nSee the [harness](harness-ai-agents.md) page.",
    });
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    const matchSpy = vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => target === "tenants/alice/wiki/agent-harness.md"
        ? false
        : originalMatch(target, content, etag),
    );

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/changed/i);

    const other = await readWikiPage("other");
    expect(other?.content).toContain("](harness-ai-agents.md)");
    expect(other?.content).not.toContain("](agent-harness.md)");
    expect(await readWikiPage("harness-ai-agents")).not.toBeNull();
    matchSpy.mockRestore();
  });

  it("resumes a partial merge without folding the absorbed body twice", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", {
      title: "Agent Harness",
      body: "# Agent Harness\n\nSURVIVOR UNIQUE.",
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nABSORBED UNIQUE.",
    });
    await seedPage("other", {
      title: "Other",
      body: "# Other\n\nSee [harness](harness-ai-agents.md).",
    });
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let failLinker = true;
    const matchSpy = vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => {
        if (failLinker && target === "tenants/alice/wiki/other.md") {
          failLinker = false;
          return false;
        }
        return originalMatch(target, content, etag);
      },
    );

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/changed/i);
    await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    const survivor = await readWikiPageWithFrontmatter("agent-harness");
    expect(survivor?.body.match(/ABSORBED UNIQUE\./g)).toHaveLength(1);
    expect((await readWikiPage("other"))?.content).toContain("](agent-harness.md)");
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
    matchSpy.mockRestore();
  }, 15_000);

  it("serializes an absorbed-Page edit behind the complete merge lifecycle", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("other", {
      title: "Other",
      body: "# Other\n\nSee [harness](harness-ai-agents.md).",
    });
    const originalFrom = await readWikiPageWithFrontmatter("harness-ai-agents");
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let linkerWrite!: () => void;
    let resumeLinker!: () => void;
    const writeStarted = new Promise<void>((resolve) => { linkerWrite = resolve; });
    const resume = new Promise<void>((resolve) => { resumeLinker = resolve; });
    let pauseOnce = true;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(async (target, content, etag) => {
      if (pauseOnce && target === "tenants/alice/wiki/other.md") {
        pauseOnce = false;
        linkerWrite();
        await resume;
      }
      return originalMatch(target, content, etag);
    });

    const merging = mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });
    await writeStarted;
    const edited = originalFrom!.content.replace(
      "Content about Harness (AI agents).",
      "OWNER EDIT MUST SURVIVE.",
    );
    const editing = writeWikiPageWithSideEffects({
      slug: "harness-ai-agents",
      title: "Harness (AI agents)",
      content: edited,
      summary: "Owner edit",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: originalFrom!.content,
      author: "alice",
    });
    resumeLinker();

    await expect(merging).resolves.toMatchObject({ intoSlug: "agent-harness" });
    await expect(editing).rejects.toThrow(/not found|changed/i);
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
    expect((await readWikiPage("agent-harness"))?.content)
      .toContain("Content about Harness (AI agents).");
  }, 15_000);

  it("does not reuse a completed survivor receipt for a later same-pair merge", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", {
      title: "Agent Harness",
      body: "# Agent Harness\n\nSURVIVOR BASE.",
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nFIRST ABSORBED.",
    });
    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents) again",
      body: "# Harness (AI agents) again\n\nSECOND ABSORBED.",
    });
    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    const survivor = await readWikiPage("agent-harness");
    expect(survivor?.content).toContain("FIRST ABSORBED.");
    expect(survivor?.content).toContain("SECOND ABSORBED.");
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
  }, 15_000);

  it("retires a completed marker that survived cleanup before same-pair reuse", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nFIRST GENERATION.",
    });
    const storage = getStorage();
    const originalDelete = storage.deleteFile.bind(storage);
    let failCompletedMarkerCleanup = true;
    vi.spyOn(storage, "deleteFile").mockImplementation(async (target) => {
      if (
        failCompletedMarkerCleanup
        && target.startsWith("derived-indexes/merge-operations/")
        && target.endsWith(".json")
      ) {
        failCompletedMarkerCleanup = false;
        throw new Error("completed marker cleanup unavailable");
      }
      return originalDelete(target);
    });
    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });
    await seedPage("harness-ai-agents", {
      title: "Harness again",
      body: "# Harness again\n\nSECOND GENERATION.",
    });

    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    expect((await readWikiPage("agent-harness"))?.content).toContain("SECOND GENERATION.");
  }, 15_000);

  it("serializes inverse merges without deadlocking", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("alpha", { title: "Alpha" });
    await seedPage("beta", { title: "Beta" });

    const settled = await Promise.allSettled([
      mergePages({ from: "alpha", into: "beta", actor: "alice" }),
      mergePages({ from: "beta", into: "alpha", actor: "alice" }),
    ]);

    expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(settled.filter((result) => result.status === "rejected")).toHaveLength(1);
  }, 15_000);

  it("serializes disjoint cross-linked merges without a lock cycle", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("alpha", {
      title: "Alpha",
      body: "# Alpha\n\nSee [charlie](charlie.md).",
    });
    await seedPage("beta", { title: "Beta" });
    await seedPage("charlie", {
      title: "Charlie",
      body: "# Charlie\n\nSee [alpha](alpha.md).",
    });
    await seedPage("delta", { title: "Delta" });

    const settled = await Promise.allSettled([
      mergePages({ from: "alpha", into: "beta", actor: "alice" }),
      mergePages({ from: "charlie", into: "delta", actor: "alice" }),
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
  }, 15_000);

  it("serializes a cross-linked merge and ordinary delete without a lock cycle", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("alpha", {
      title: "Alpha",
      body: "# Alpha\n\nSee [zeta](zeta.md).",
    });
    await seedPage("zeta", {
      title: "Zeta",
      body: "# Zeta\n\nSee [alpha](alpha.md).",
    });
    await seedPage("omega", { title: "Omega" });

    const settled = await Promise.allSettled([
      mergePages({ from: "zeta", into: "omega", actor: "alice" }),
      deleteWikiPage("alpha", "alice"),
    ]);

    expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
  }, 15_000);

  it("refuses a completed delete receipt when the source Page reappears", async () => {
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const original = await readWikiPage("harness-ai-agents");
    const receiptPath = "derived-indexes/test-delete-receipt.json";
    await withPageLifecycleLocks(["harness-ai-agents"], (held) =>
      deleteWikiPageWhileLocked(
        "harness-ai-agents",
        held,
        "alice",
        original!.content,
        { key: "test-delete", receiptPath },
      ));
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nContent about Harness (AI agents).",
    });

    await expect(withPageLifecycleLocks(["harness-ai-agents"], (held) =>
      deleteWikiPageWhileLocked(
        "harness-ai-agents",
        held,
        "alice",
        original!.content,
        { key: "test-delete", receiptPath },
      ))).rejects.toThrow(/reappeared/i);
    expect(await readWikiPage("harness-ai-agents")).not.toBeNull();
  }, 15_000);

  it("resumes delete lifecycle side effects when Page bytes were already removed", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const storage = getStorage();
    const originalWrite = storage.writeFile.bind(storage);
    let failDeleteIndex = true;
    vi.spyOn(storage, "writeFile").mockImplementation(async (target, content) => {
      if (
        failDeleteIndex
        && target === "wiki/index.md"
        && !await storage.fileExists("tenants/alice/wiki/harness-ai-agents.md")
      ) {
        failDeleteIndex = false;
        throw new Error("index unavailable after Page delete");
      }
      return originalWrite(target, content);
    });

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/index unavailable/i);
    expect(await readWikiPage("harness-ai-agents")).toBeNull();

    const survivor = await readWikiPageWithFrontmatter("agent-harness", {
      fresh: true,
      strict: true,
    });
    await writeWikiPageWithSideEffects({
      slug: "agent-harness",
      title: "Agent Harness",
      content: `${survivor!.content.trimEnd()}\n\nOwner edit after partial delete.\n`,
      summary: "Owner-edited survivor",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: survivor!.content,
      author: "alice",
    });

    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    expect((await listWikiPages({ strict: true })).map((entry) => entry.slug))
      .not.toContain("harness-ai-agents");
    expect((await readWikiPage("agent-harness"))?.content)
      .toContain("Owner edit after partial delete.");
  }, 15_000);

  it("rejects a recreated survivor after the absorbed Page was already deleted", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const storage = getStorage();
    const originalWrite = storage.writeFile.bind(storage);
    let failDeleteIndex = true;
    vi.spyOn(storage, "writeFile").mockImplementation(async (target, content) => {
      if (
        failDeleteIndex
        && target === "wiki/index.md"
        && !await storage.fileExists("tenants/alice/wiki/harness-ai-agents.md")
      ) {
        failDeleteIndex = false;
        throw new Error("index unavailable after Page delete");
      }
      return originalWrite(target, content);
    });

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/index unavailable/i);
    await deleteWikiPage("agent-harness", "alice");
    await seedPage("agent-harness", {
      title: "Replacement",
      owner: "bob",
      body: "# Replacement\n\nBob's unrelated Page.",
    });

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/replaced/i);
    expect((await readWikiPage("agent-harness"))?.content).toContain("Bob's unrelated Page.");
  }, 15_000);

  it("removes a backlink added after the merge repoint pass", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("late-linker", { title: "Late linker" });
    const storage = getStorage();
    const originalDelete = storage.deleteFile.bind(storage);
    let deleting!: () => void;
    let resumeDelete!: () => void;
    const deleteStarted = new Promise<void>((resolve) => { deleting = resolve; });
    const resume = new Promise<void>((resolve) => { resumeDelete = resolve; });
    let pauseOnce = true;
    vi.spyOn(storage, "deleteFile").mockImplementation(async (target) => {
      if (pauseOnce && target === "tenants/alice/wiki/harness-ai-agents.md") {
        pauseOnce = false;
        deleting();
        await resume;
      }
      return originalDelete(target);
    });

    const merging = mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });
    await deleteStarted;
    const linker = await readWikiPageWithFrontmatter("late-linker");
    const writing = writeWikiPageWithSideEffects({
      slug: "late-linker",
      title: "Late linker",
      content: linker!.content.replace(
        "Content about Late linker.",
        "See [old Page](harness-ai-agents.md).",
      ),
      summary: "Late link",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: linker!.content,
      author: "alice",
    });
    resumeDelete();
    await merging;
    await expect(writing).rejects.toThrow(/missing|replaced/i);

    expect((await readWikiPage("late-linker"))?.content)
      .not.toContain("harness-ai-agents.md");
  }, 15_000);

  it("re-points a fragment backlink from a physical Page missing from index.md", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("orphan-linker", {
      title: "Orphan linker",
      body: "# Orphan linker\n\nSee [details](harness-ai-agents.md#details).",
    });
    await updateIndex(
      (await listWikiPages({ strict: true })).filter((entry) => entry.slug !== "orphan-linker"),
    );

    const result = await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    expect(result.repointedBacklinksFrom).toContain("orphan-linker");
    expect((await readWikiPage("orphan-linker"))?.content)
      .toContain("agent-harness.md#details");
  }, 15_000);

  it("re-points a fragment backlink from a canonical-only tenant Page", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const linker = serializeFrontmatter(
      { owner: "alice", authors: ["alice"], contributors: ["alice"] },
      "# Canonical orphan\n\nSee [details](harness-ai-agents.md#details).",
    );
    await getStorage().writeFile("tenants/alice/wiki/canonical-orphan.md", linker);

    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    expect(await getStorage().readFile("tenants/alice/wiki/canonical-orphan.md"))
      .toContain("agent-harness.md#details");
  }, 15_000);

  it("re-points a fragment backlink inside the survivor body", async () => {
    mockedHasLLMKey.mockReturnValue(false);
    await seedPage("agent-harness", {
      title: "Agent Harness",
      body: "# Agent Harness\n\nSee [details](harness-ai-agents.md#details).",
    });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });

    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

    expect((await readWikiPage("agent-harness"))?.content)
      .toContain("agent-harness.md#details");
    expect((await readWikiPage("agent-harness"))?.content)
      .not.toContain("harness-ai-agents.md#details");
  }, 15_000);

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
  }, 15_000);

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
