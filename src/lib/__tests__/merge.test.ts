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
import { readDiscussFixture } from "./discuss-fixtures";
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
  mockedHasLLMKey.mockResolvedValue(true);
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
    mockedHasLLMKey.mockResolvedValue(false);
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

  it("resumes an earlier partial merge after a later merge advances the survivor generation", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await seedPage("agent-harness", {
      title: "Agent Harness",
      body: "# Agent Harness\n\nSURVIVOR UNIQUE.",
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      body: "# Harness (AI agents)\n\nFIRST ABSORBED UNIQUE.",
    });
    await seedPage("agent-test-rigs", {
      title: "Agent Test Rigs",
      body: "# Agent Test Rigs\n\nSECOND ABSORBED UNIQUE.",
    });
    const storage = getStorage();
    const originalWrite = storage.writeFile.bind(storage);
    let failFirstIndexCleanup = true;
    vi.spyOn(storage, "writeFile").mockImplementation(async (target, content) => {
      if (
        failFirstIndexCleanup
        && target === "wiki/index.md"
        && !await storage.fileExists("tenants/alice/wiki/harness-ai-agents.md")
      ) {
        failFirstIndexCleanup = false;
        throw new Error("index unavailable after first Page delete");
      }
      return originalWrite(target, content);
    });

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/index unavailable/i);
    await mergePages({
      from: "agent-test-rigs",
      into: "agent-harness",
      actor: "alice",
    });
    await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    const survivor = await readWikiPageWithFrontmatter("agent-harness");
    expect(survivor?.body.match(/FIRST ABSORBED UNIQUE\./g)).toHaveLength(1);
    expect(survivor?.body.match(/SECOND ABSORBED UNIQUE\./g)).toHaveLength(1);
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
    expect(await readWikiPage("agent-test-rigs")).toBeNull();
  }, 15_000);

  it("serializes an absorbed-Page edit behind the complete merge lifecycle", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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

  it("rejects a same-owner recreated survivor even when stale revisions could not be cleaned", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
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
    const originalDeleteDirectory = storage.deleteDirectory.bind(storage);
    vi.spyOn(storage, "deleteDirectory").mockImplementation(async (target) => {
      if (target.includes(".revisions/agent-harness")) {
        throw new Error("revision cleanup unavailable");
      }
      return originalDeleteDirectory(target);
    });
    await expect(deleteWikiPage("agent-harness", "alice"))
      .rejects.toThrow(/revision cleanup unavailable/i);
    expect(await readWikiPage("agent-harness")).not.toBeNull();
    await storage.deleteFile("tenants/alice/wiki/agent-harness.md");
    await storage.deleteFile("wiki/agent-harness.md");
    await updateIndex(
      (await listWikiPages({ strict: true })).filter((entry) => entry.slug !== "agent-harness"),
    );
    await seedPage("agent-harness", {
      title: "Replacement",
      owner: "alice",
      body: "# Replacement\n\nAlice's unrelated replacement.",
    });

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/replaced/i);
    expect((await readWikiPage("agent-harness"))?.content)
      .toContain("Alice's unrelated replacement.");
  }, 15_000);

  it("fails before mutation when a canonical Page is stored under the wrong tenant", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const fromBefore = (await readWikiPage("harness-ai-agents"))!.content;
    const intoBefore = (await readWikiPage("agent-harness"))!.content;
    const malformed = serializeFrontmatter(
      { owner: "alice" },
      "# Misfiled\n\nSee [old](harness-ai-agents.md).",
    );
    await getStorage().writeFile("tenants/bob/wiki/misfiled.md", malformed);

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/wrong tenant/i);

    expect((await readWikiPage("harness-ai-agents"))?.content).toBe(fromBefore);
    expect((await readWikiPage("agent-harness"))?.content).toBe(intoBefore);
    expect(await getStorage().readFile("tenants/bob/wiki/misfiled.md")).toBe(malformed);
    let operationEntries: Array<{ name: string; isDirectory: boolean }> = [];
    try {
      operationEntries = await getStorage().listFiles("derived-indexes/merge-operations");
    } catch (error) {
      if (!(error instanceof Error && "code" in error
        && (error as NodeJS.ErrnoException).code === "ENOENT")) throw error;
    }
    expect(operationEntries).toHaveLength(0);
  }, 15_000);

  it("fails before mutation when one slug exists in multiple tenant silos", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    const fromBefore = (await readWikiPage("harness-ai-agents"))!.content;
    const intoBefore = (await readWikiPage("agent-harness"))!.content;
    const aliceCopy = serializeFrontmatter({ owner: "alice" }, "# Duplicate\n\nAlice.");
    const bobCopy = serializeFrontmatter({ owner: "bob" }, "# Duplicate\n\nBob.");
    await getStorage().writeFile("tenants/alice/wiki/duplicate.md", aliceCopy);
    await getStorage().writeFile("tenants/bob/wiki/duplicate.md", bobCopy);

    await expect(mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    })).rejects.toThrow(/multiple tenant silos/i);

    expect((await readWikiPage("harness-ai-agents"))?.content).toBe(fromBefore);
    expect((await readWikiPage("agent-harness"))?.content).toBe(intoBefore);
    expect(await getStorage().readFile("tenants/alice/wiki/duplicate.md")).toBe(aliceCopy);
    expect(await getStorage().readFile("tenants/bob/wiki/duplicate.md")).toBe(bobCopy);
  }, 15_000);

  it("removes a backlink added after the merge repoint pass", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
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
      validateNewLinkTargets: true,
    });
    resumeDelete();
    await merging;
    await expect(writing).rejects.toThrow(/missing|replaced/i);

    expect((await readWikiPage("late-linker"))?.content)
      .not.toContain("harness-ai-agents.md");
  }, 15_000);

  it("rejects a stale link when the absorbed slug was recreated by another owner", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("late-linker", { title: "Late linker" });
    const staleLinker = await readWikiPageWithFrontmatter("late-linker", {
      fresh: true,
      strict: true,
    });
    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });
    await seedPage("harness-ai-agents", {
      title: "Unrelated replacement",
      owner: "bob",
      body: "# Unrelated replacement\n\nBob's Page.",
    });

    await expect(writeWikiPageWithSideEffects({
      slug: "late-linker",
      title: "Late linker",
      content: staleLinker!.content.replace(
        "Content about Late linker.",
        "See [old Page](harness-ai-agents.md).",
      ),
      summary: "Late link",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: staleLinker!.content,
      author: "alice",
      validateNewLinkTargets: true,
    })).rejects.toThrow(/missing|replaced/i);

    expect((await readWikiPage("late-linker"))?.content)
      .not.toContain("harness-ai-agents.md");
  }, 15_000);

  it("rejects a stale link when the absorbed slug was recreated by the same owner", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
    await seedPage("agent-harness", { title: "Agent Harness" });
    await seedPage("harness-ai-agents", { title: "Harness (AI agents)" });
    await seedPage("late-linker", { title: "Late linker" });
    const staleLinker = await readWikiPageWithFrontmatter("late-linker", {
      fresh: true,
      strict: true,
    });
    await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });
    await seedPage("harness-ai-agents", {
      title: "Unrelated replacement",
      owner: "alice",
      body: "# Unrelated replacement\n\nAlice's new Page.",
    });

    await expect(writeWikiPageWithSideEffects({
      slug: "late-linker",
      title: "Late linker",
      content: staleLinker!.content.replace(
        "Content about Late linker.",
        "See [old Page](harness-ai-agents.md).",
      ),
      summary: "Late link",
      logOp: "edit",
      crossRefSource: null,
      expectedContent: staleLinker!.content,
      author: "alice",
      validateNewLinkTargets: true,
    })).rejects.toThrow(/missing|replaced/i);

    expect((await readWikiPage("late-linker"))?.content)
      .not.toContain("harness-ai-agents.md");
  }, 15_000);

  it("re-points a fragment backlink from a physical Page missing from index.md", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    mockedHasLLMKey.mockResolvedValue(false);
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
    expect(await readDiscussFixture("agent-harness")).toEqual([]);
  });

  it("appends both bodies (no reconcile) when there's no LLM key", async () => {
    mockedHasLLMKey.mockResolvedValue(false);
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

  // At the merge door `newBody` is the ABSORBED page's body, so the ingest-door
  // "fall back to the new body" rule would overwrite the survivor with the
  // absorbed page's prose and then hard-delete the absorbed page. A fold that
  // yields no body must degrade to the lossless append instead. Four shapes are
  // covered: an empty response; a response that is nothing but a marker the
  // parsers strip (which reduces to the same empty body); and the two DW-702
  // shapes that survive stripping yet carry no prose — `DISPUTED: no`, which
  // `parseDisputedMarker` matches only `yes|true` and so returns VERBATIM as
  // the body, and a bare heading. Those two used to pass as a real fold: they
  // were written over the survivor, landed in `MergeOperationReceipt`
  // .mergedContent for Retry to replay, and the absorbed page was then
  // hard-deleted with its revisions.
  for (const [label, foldResponse] of [
    ["comes back empty", "   \n  "],
    ["is nothing but a DISPUTED marker", "DISPUTED: yes\n"],
    ["is nothing but an unrecognised DISPUTED marker (DW-702)", "DISPUTED: no\n"],
    ["is nothing but a heading (DW-702)", "# Agent Harness\n"],
  ] as const) {
    it(`keeps the survivor's prose (appends both bodies) when the fold ${label}`, async () => {
      await seedPage("agent-harness", {
        title: "Agent Harness",
        body: "# Agent Harness\n\nThe harness loop.",
      });
      await seedPage("harness-ai-agents", {
        title: "Harness (AI agents)",
        body: "# Harness (AI agents)\n\nContext window management.",
      });
      mockedCallLLM.mockResolvedValue(foldResponse);

      await mergePages({ from: "harness-ai-agents", into: "agent-harness", actor: "alice" });

      // The fold was actually attempted — this is NOT the no-LLM-key path,
      // whose outcome is byte-identical.
      expect(mockedCallLLM).toHaveBeenCalled();
      const into = await readWikiPageWithFrontmatter("agent-harness");
      // Exactly the `into.body + "\n\n" + from.body` append, survivor first —
      // not merely "both phrases appear somewhere".
      expect(into!.body).toBe(
        "# Agent Harness\n\nThe harness loop.\n\n# Harness (AI agents)\n\nContext window management.",
      );
      // A fold that produced nothing produces no verdict either: `disputed`
      // stays whatever the two pages' frontmatter said (neither was disputed).
      expect(into!.frontmatter.disputed).toBe(false);
      // The absorbed page is still deleted — the merge itself succeeded.
      expect(await readWikiPage("harness-ai-agents")).toBeNull();
    });
  }

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

// ---------------------------------------------------------------------------
// The merge door carries workspace guidance into the fold (DW-323)
// ---------------------------------------------------------------------------

import { DEFAULT_TENANT } from "../links";
import { _resetLocks } from "../lock";
import { createNamesTerm } from "../names-terms";
import { tenantForOwner } from "../wiki";
import { wikiProfilePath } from "../wiki-paths";
import { createWiki, writeWikiArtifact } from "../wikis";

describe("mergePages guides the fold with the survivor owner's workspace standards", () => {
  const SURVIVOR_OWNER = "alice";
  const ABSORBED_OWNER = "bob";
  /**
   * The Purposes and the dictionary labels are deliberately DISJOINT
   * vocabularies: no canonical term or alias asserted below occurs in any
   * Purpose string (or in the base reconcile prompt), so a `toContain(term)`
   * can only be satisfied by the WORKSPACE NAMES & TERMS block itself. The
   * first pass of this work asserted a label that also appeared in the Purpose
   * and so proved nothing about the dictionary.
   */
  const ALICE_PURPOSE = "Track the Beacon rollout and every migration decision.";
  const BOB_PURPOSE = "Summarize quarterly revenue for the finance guild.";
  const REVISED_PURPOSE = "Track the Beacon rollout, and the deprecations behind it.";
  const DEFAULT_TENANT_PURPOSE = "Curate the shared seed encyclopedia.";
  const DEFAULT_TENANT_TERM = "Echidna Registry";
  const ALICE_TERM = "Quokka Platform";
  const ALICE_ALIAS = "Bandicoot";
  const BOB_TERM = "Narwhal Ledger";
  const BOB_ALIAS = "Pangolin";
  /** A stable slice of `RECONCILE_SYSTEM_PROMPT` — the prompt's own identity. */
  const BASE_PROMPT_MARKER =
    "You are a wiki editor maintaining a single canonical page about one concept.";
  const SURVIVOR_SLUG = "agent-harness";
  const ABSORBED_SLUG = "harness-ai-agents";
  const SECOND_SURVIVOR_SLUG = "beacon-rollout";
  const SECOND_ABSORBED_SLUG = "beacon-rollout-notes";
  const ABSORBED_TITLE = "Harness (AI agents)";
  const FOLDED_MARKER = "Folded body covering both sources.";
  const DICTIONARY_PATH = (owner: string) =>
    `tenants/${tenantForOwner(owner)}/names-terms.json`;

  /** Structurally typed: all this block needs from the spy is tearing it down. */
  let readSpy: { mockRestore: () => void } | null = null;

  beforeEach(() => {
    // The outer `beforeEach` already pointed DATA_DIR/WIKI_DIR/RAW_DIR at a
    // fresh `tmpDir`, so the wiki registry, the profile and the dictionary are
    // all real bytes under it. Only the lock registry needs clearing: it is
    // module state that outlives the temp directory it was keyed against.
    _resetLocks();
  });

  afterEach(() => {
    // Restore ONLY the storage spy this block installs. The outer `afterEach`
    // owns everything else it set up.
    readSpy?.mockRestore();
    readSpy = null;
    _resetLocks();
  });

  /** Give `owner` an active Wiki with a Purpose and a one-entry dictionary. */
  async function seedGuidance(
    owner: string,
    purpose: string,
    canonical: string,
    alias: string,
  ): Promise<string> {
    const wiki = await createWiki(owner, { name: `${owner} Ops`, scenario: "business" });
    await writeWikiArtifact(owner, wiki.id, "purpose.md", `# ${owner} Ops\n\n${purpose}\n`);
    await createNamesTerm(owner, { kind: "project", canonical, aliases: [alias] });
    return wiki.id;
  }

  /**
   * A page with NO `owner` in its frontmatter — and an ASSERTED premise. If the
   * write path ever starts stamping an owner, the tests below that depend on an
   * ownerless survivor must fail loudly rather than go green for the wrong
   * reason (the `actor` fallback would then never be the branch under test).
   */
  async function seedOwnerlessPage(slug: string, title: string): Promise<void> {
    const body = `# ${title}\n\nContent about ${title}.`;
    await writeWikiPageWithSideEffects({
      slug,
      title,
      content: serializeFrontmatter(
        { created: "2026-01-01", updated: "2026-01-01" },
        body,
      ),
      summary: title,
      logOp: "ingest",
      crossRefSource: null,
    });
    const written = await readWikiPageWithFrontmatter(slug, { fresh: true });
    expect(written?.frontmatter.owner).toBeUndefined();
  }

  /** The reconcile system prompt — asserting en route that ONE fold happened. */
  function reconcileSystemPrompt(): string {
    expect(mockedCallLLM).toHaveBeenCalledTimes(1);
    return String(mockedCallLLM.mock.calls[0][0]);
  }

  /** Count `readFile` calls per path from here on (setup reads excluded). */
  function countReads(): (relativePath: string) => number {
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    const seen: string[] = [];
    readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        seen.push(target);
        return readFile(target);
      });
    return (relativePath) => seen.filter((p) => p === relativePath).length;
  }

  async function seedMergePair(
    survivorOwner: string | undefined,
    absorbedOwner: string,
  ): Promise<void> {
    if (survivorOwner === undefined) {
      await seedOwnerlessPage(SURVIVOR_SLUG, "Agent Harness");
    } else {
      await seedPage(SURVIVOR_SLUG, { title: "Agent Harness", owner: survivorOwner });
    }
    await seedPage(ABSORBED_SLUG, { title: ABSORBED_TITLE, owner: absorbedOwner });
  }

  async function survivorBody(): Promise<string> {
    const page = await readWikiPageWithFrontmatter(SURVIVOR_SLUG, { fresh: true });
    expect(page).not.toBeNull();
    return page!.body;
  }

  it("puts the survivor owner's Workspace Purpose and dictionary in the reconcile prompt", async () => {
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain(BASE_PROMPT_MARKER);
    expect(prompt).toContain("WORKSPACE PURPOSE");
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain("WORKSPACE NAMES & TERMS");
    expect(prompt).toContain(ALICE_TERM);
    expect(prompt).toContain(ALICE_ALIAS);
  });

  it("reads the HUMAN's standards when the survivor is owned by an agent handle", async () => {
    // DW-543. Guidance is addressed by human owner: `alice--yoyo` keys its own
    // (empty) tenant, so resolving guidance from the raw handle would fold the
    // agent's page with no Purpose and no dictionary — even though the
    // same-owner guard already treats `alice--yoyo` and `alice` as one owner.
    const AGENT_OWNER = `${SURVIVOR_OWNER}--yoyo`;
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedMergePair(AGENT_OWNER, AGENT_OWNER);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: AGENT_OWNER,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain("WORKSPACE PURPOSE");
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain("WORKSPACE NAMES & TERMS");
    expect(prompt).toContain(ALICE_TERM);
    expect(prompt).toContain(ALICE_ALIAS);
    // Addressing is untouched: the survivor still carries the RAW agent handle.
    const survivor = await readWikiPageWithFrontmatter(SURVIVOR_SLUG, {
      fresh: true,
    });
    expect(survivor?.frontmatter.owner).toBe(AGENT_OWNER);
  });

  it("reduces the ACTOR to its human too when the survivor names no owner", async () => {
    // The fallback principal goes through the same reduction as the survivor's.
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedMergePair(undefined, SURVIVOR_OWNER);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: `${SURVIVOR_OWNER}--yoyo`,
      bypassOwnerCheck: true,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain(ALICE_TERM);
  });

  it("uses the SURVIVOR's owner, never the actor, on a cross-owner merge", async () => {
    // The recorded decision: the merged prose is written to `into` and lives on
    // in `into`'s owner's wiki, so alice's standards govern even though bob
    // pressed the button and bob's page is the one being absorbed.
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedGuidance(ABSORBED_OWNER, BOB_PURPOSE, BOB_TERM, BOB_ALIAS);
    await seedMergePair(SURVIVOR_OWNER, ABSORBED_OWNER);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: ABSORBED_OWNER,
      bypassOwnerCheck: true,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain(ALICE_TERM);
    expect(prompt).toContain(ALICE_ALIAS);
    expect(prompt).not.toContain(BOB_PURPOSE);
    expect(prompt).not.toContain(BOB_TERM);
    expect(prompt).not.toContain(BOB_ALIAS);
  });

  it("falls back to the acting principal when the survivor names no owner", async () => {
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedMergePair(undefined, SURVIVOR_OWNER);

    // Ownerless survivor ⇒ `sameHumanOwner` refuses, so this needs the trusted
    // door; the fallback under test is the guidance owner, not the guard.
    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
      bypassOwnerCheck: true,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain(ALICE_TERM);
  });

  it("sends the bare reconcile prompt when neither the survivor nor the actor names an owner", async () => {
    // Guidance EXISTS for alice — it simply must not be reachable from a merge
    // that names no principal at all, so this cannot pass vacuously.
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedOwnerlessPage(SURVIVOR_SLUG, "Agent Harness");
    await seedOwnerlessPage(ABSORBED_SLUG, ABSORBED_TITLE);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      bypassOwnerCheck: true,
    });

    const prompt = reconcileSystemPrompt();
    // POSITIVE: this is the reconcile prompt, minus guidance — not "no prompt".
    expect(prompt).toContain(BASE_PROMPT_MARKER);
    expect(prompt).not.toContain("WORKSPACE PURPOSE");
    expect(prompt).not.toContain("WORKSPACE NAMES & TERMS");
    expect(prompt).not.toContain(ALICE_PURPOSE);
    expect(prompt).not.toContain(ALICE_TERM);
  });

  /**
   * Three ways a dictionary file breaks the fold — and they break it at TWO
   * different layers, which is why the probe has to be `buildNamesTermsGuidance`
   * (read + sort + render) and not `listNamesTerms` (read + sort) alone.
   */
  const CORRUPT_DICTIONARIES: ReadonlyArray<[label: string, bytes: string]> = [
    // Layer 1: `readEntries` → `JSON.parse` throws a SyntaxError.
    ["unparseable JSON", "{not json"],
    // Layer 2: parses as an array, so `listNamesTerms` RESOLVES — `sort` never
    // calls its comparator on a one-element array and `resolveSortedEntries`
    // only skips FREEZING a null element. `renderNamesTermsGuidance` is where
    // `entry.aliases` finally throws.
    ["a null entry", "[null]"],
    // Layer 2 again: a well-formed object missing `aliases`.
    ["a field-less entry", '[{"kind":"project","canonical":"X"}]'],
  ];

  for (const [label, bytes] of CORRUPT_DICTIONARIES) {
    it(`still folds — unguided — when the survivor owner's dictionary is ${label}`, async () => {
      // The regression this story's first pass shipped. The dictionary guidance
      // throws, `reconcilePage` resolves both guidance halves before calling the
      // model, and merge's outer `catch` bakes the raw body concatenation into
      // the DURABLE receipt — so a damaged dictionary would permanently ship an
      // unfolded, double-titled survivor with `from` already deleted.
      await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
      await getStorage().writeFile(DICTIONARY_PATH(SURVIVOR_OWNER), bytes);
      await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);

      await mergePages({
        from: ABSORBED_SLUG,
        into: SURVIVOR_SLUG,
        actor: SURVIVOR_OWNER,
      });

      const prompt = reconcileSystemPrompt();
      const body = await survivorBody();
      expect(body).toContain(FOLDED_MARKER);
      // NOT the appended-bodies fallback.
      expect(body).not.toContain(`Content about ${ABSORBED_TITLE}.`);
      expect(prompt).toContain(BASE_PROMPT_MARKER);
      expect(prompt).not.toContain("WORKSPACE NAMES & TERMS");
      // The Purpose goes with the dictionary — the deliberately coarse degrade.
      expect(prompt).not.toContain(ALICE_PURPOSE);
    });
  }

  it("keeps the Purpose when the survivor owner simply has NO dictionary yet", async () => {
    // The common production shape: a Workspace Purpose saved, no Names & Terms
    // entry ever created. `readEntries` ENOENT-degrades to `[]`, so the probe
    // must resolve and leave the owner alone — dropping guidance here would
    // silently un-guide almost every real merge.
    const wiki = await createWiki(SURVIVOR_OWNER, {
      name: "Ops",
      scenario: "business",
    });
    await writeWikiArtifact(
      SURVIVOR_OWNER,
      wiki.id,
      "purpose.md",
      `# Ops\n\n${ALICE_PURPOSE}\n`,
    );
    await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });

    const prompt = reconcileSystemPrompt();
    expect(await survivorBody()).toContain(FOLDED_MARKER);
    expect(prompt).toContain("WORKSPACE PURPOSE");
    expect(prompt).toContain(ALICE_PURPOSE);
    // An empty dictionary renders to "", so there is no block to carry.
    expect(prompt).not.toContain("WORKSPACE NAMES & TERMS");
  });

  it("treats a whitespace-only actor as no principal, not as the default tenant", async () => {
    // `asString` has to guard the FALLBACK too: a truthy-but-blank `actor`
    // survives `?? actor` and reaches `ownerToTenant`, which trims it to "" and
    // collapses it onto DEFAULT_TENANT — so the default silo's Purpose and
    // dictionary would govern a fold that named no principal at all. The
    // DEFAULT tenant is therefore given REAL guidance here: without the
    // `asString`, that guidance is exactly what the prompt picks up.
    await seedGuidance(
      DEFAULT_TENANT,
      DEFAULT_TENANT_PURPOSE,
      DEFAULT_TENANT_TERM,
      "Echidna",
    );
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedOwnerlessPage(SURVIVOR_SLUG, "Agent Harness");
    await seedOwnerlessPage(ABSORBED_SLUG, ABSORBED_TITLE);

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: "   ",
      bypassOwnerCheck: true,
    });

    const prompt = reconcileSystemPrompt();
    expect(prompt).toContain(BASE_PROMPT_MARKER);
    expect(prompt).not.toContain("WORKSPACE PURPOSE");
    expect(prompt).not.toContain("WORKSPACE NAMES & TERMS");
    expect(prompt).not.toContain(DEFAULT_TENANT_PURPOSE);
    expect(prompt).not.toContain(DEFAULT_TENANT_TERM);
  });

  it("still folds with canonical Purpose when the legacy workspace profile is unreadable", async () => {
    const wikiId = await seedGuidance(
      SURVIVOR_OWNER,
      ALICE_PURPOSE,
      ALICE_TERM,
      ALICE_ALIAS,
    );
    await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);

    const profilePath = wikiProfilePath(SURVIVOR_OWNER, wikiId);
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    readSpy = vi
      .spyOn(storage, "readFile")
      .mockImplementation(async (target: string) => {
        if (target === profilePath) {
          throw Object.assign(new Error("EACCES: permission denied"), {
            code: "EACCES",
          });
        }
        return readFile(target);
      });

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });

    const prompt = reconcileSystemPrompt();
    expect(await survivorBody()).toContain(FOLDED_MARKER);
    // The profile is migration evidence only once this Wiki is marked. A bad
    // legacy file cannot suppress the canonical artifact.
    expect(prompt).toContain("WORKSPACE PURPOSE");
    expect(prompt).toContain(ALICE_PURPOSE);
    expect(prompt).toContain("WORKSPACE NAMES & TERMS");
    expect(prompt).toContain(ALICE_TERM);
  });

  it("reads the survivor owner's dictionary exactly once for the whole merge", async () => {
    // Proves the per-merge handle is not vacuous: the fail-soft probe and
    // `reconcilePage`'s own `buildNamesTermsGuidance` share ONE read.
    await seedGuidance(SURVIVOR_OWNER, ALICE_PURPOSE, ALICE_TERM, ALICE_ALIAS);
    await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);

    const reads = countReads();
    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });

    expect(reads(DICTIONARY_PATH(SURVIVOR_OWNER))).toBe(1);
    expect(reconcileSystemPrompt()).toContain(ALICE_TERM);
  });

  it("picks up a Purpose saved BETWEEN two merges (the handle is per-merge)", async () => {
    // The other half of the handle's contract: it is minted at the call site
    // and dies with the merge. Hoisting it to module scope would make this
    // second fold reuse the first merge's memo and prompt with a stale Purpose.
    const wikiId = await seedGuidance(
      SURVIVOR_OWNER,
      ALICE_PURPOSE,
      ALICE_TERM,
      ALICE_ALIAS,
    );
    await seedMergePair(SURVIVOR_OWNER, SURVIVOR_OWNER);
    await seedPage(SECOND_SURVIVOR_SLUG, { title: "Beacon Rollout", owner: SURVIVOR_OWNER });
    await seedPage(SECOND_ABSORBED_SLUG, { title: "Beacon (rollout)", owner: SURVIVOR_OWNER });

    await mergePages({
      from: ABSORBED_SLUG,
      into: SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });
    expect(String(mockedCallLLM.mock.calls[0][0])).toContain(ALICE_PURPOSE);

    await writeWikiArtifact(
      SURVIVOR_OWNER,
      wikiId,
      "purpose.md",
      `# alice Ops\n\n${REVISED_PURPOSE}\n`,
    );

    await mergePages({
      from: SECOND_ABSORBED_SLUG,
      into: SECOND_SURVIVOR_SLUG,
      actor: SURVIVOR_OWNER,
    });

    expect(mockedCallLLM).toHaveBeenCalledTimes(2);
    const secondPrompt = String(mockedCallLLM.mock.calls[1][0]);
    expect(secondPrompt).toContain(REVISED_PURPOSE);
    expect(secondPrompt).not.toContain(ALICE_PURPOSE);
  });
});

// ---------------------------------------------------------------------------
// The merge delete is the receipt-BEARING delete path (DW-125 / DW-126)
// ---------------------------------------------------------------------------
//
// `mergePages` deletes the absorbed page through `deleteWikiPageWhileLocked`
// WITH an `idempotency` argument — the only path that ever populated the
// `.delete.contributor` idempotency receipt, and the only one that ever ran the
// contributor-index decrement it guarded. (`deleteWikiPage` passes no recovery
// at all, so a receipt assertion there proves nothing: it never minted one, even
// before this change.) Both are now gone, and this is where that has teeth.
// ---------------------------------------------------------------------------

/** Every file under `dir` whose name ends in `suffix`, recursively. */
async function findFilesEndingIn(dir: string, suffix: string): Promise<string[]> {
  const found: string[] = [];
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch {
    return found;
  }
  for (const name of names) {
    const full = path.join(dir, name);
    if ((await fs.stat(full)).isDirectory()) {
      found.push(...(await findFilesEndingIn(full, suffix)));
    } else if (name.endsWith(suffix)) {
      found.push(full);
    }
  }
  return found;
}

describe("mergePages leaves the retired contributor index alone", () => {
  it("mints no .delete.contributor receipt and does not decrement the absorbed page's author", async () => {
    const { getContributorIndex, rebuildContributorIndex, recordEditForAuthor } =
      await import("../contributor-index");

    await seedPage("agent-harness", {
      title: "Agent Harness",
      created: "2026-02-01",
      sources: [src("https://x.com/i/status/1")],
    });
    await seedPage("harness-ai-agents", {
      title: "Harness (AI agents)",
      created: "2026-01-15",
      sources: [src("https://example.com/article")],
    });

    // Seed an index that a resurrected decrement would visibly damage: alice
    // holds one edit on the page the merge is about to absorb.
    await rebuildContributorIndex();
    await recordEditForAuthor("alice", "harness-ai-agents", "2026-01-15T00:00:00Z");
    const before = await getContributorIndex();
    expect(before!.authors.alice.editCount).toBe(1);
    expect(before!.authors.alice.pagesEdited).toContain("harness-ai-agents");

    await mergePages({
      from: "harness-ai-agents",
      into: "agent-harness",
      actor: "alice",
    });

    // The merge really did delete the absorbed page through that path…
    expect(await readWikiPage("harness-ai-agents")).toBeNull();
    // …yet alice's tally is untouched: no decrement ran.
    expect(await getContributorIndex()).toEqual(before);
    // …and the receipt that used to guard the decrement is never minted.
    expect(await findFilesEndingIn(tmpDir, ".delete.contributor")).toEqual([]);
  });
});
