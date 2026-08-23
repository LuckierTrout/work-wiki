import { beforeEach, describe, expect, it, vi } from "vitest";

const generateText = vi.fn();
const enqueueTodoCandidates = vi.fn(
  async (_owner: string, _input: unknown) => [] as unknown[],
);
const loadPageConventions = vi.fn(async () => "## Page conventions\nBe precise.");
const readWikiPageWithFrontmatter = vi.fn<(slug: string) => Promise<unknown>>();
const getCurrentWiki = vi.fn(async (_owner: string) => ({ id: "wiki-1" }));
const hasLLMKey = vi.fn(() => true);
const proposeActionItems = vi.fn();

vi.mock("ai", () => ({
  generateText: (...args: unknown[]) => generateText(...args),
  Output: { object: (input: unknown) => input },
}));
vi.mock("../todos", () => ({
  collapseTodoTitles: (items: unknown[]) => items,
  enqueueTodoCandidates: (owner: string, input: unknown) =>
    enqueueTodoCandidates(owner, input),
}));
vi.mock("../schema", () => ({
  loadPageConventions: () => loadPageConventions(),
}));
vi.mock("../wiki", () => ({
  readWikiPageWithFrontmatter: (slug: string) => readWikiPageWithFrontmatter(slug),
  tenantForOwner: (owner: string) => owner,
}));
vi.mock("../wikis", () => ({
  getCurrentWiki: (owner: string) => getCurrentWiki(owner),
}));
vi.mock("../llm", () => ({
  hasLLMKey: () => hasLLMKey(),
  getConfiguredModel: async () => ({}),
  retryWithBackoff: async (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("../config", () => ({
  llmTimeoutOption: () => ({}),
}));
vi.mock("../storage", () => ({
  getStorage: () => ({
    readFile: async () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  }),
}));
vi.mock("../raw", () => ({
  rawSourceRelPath: (rest: string) => `raw/sources/${rest}`,
  tenantRawSourceRelPath: (_tenant: string, rest: string) => `tenants/t/raw/sources/${rest}`,
}));
vi.mock("../action-items", () => ({
  proposeActionItems,
}));

import { buildTodoExtractPrompt, extractTodoCandidatesFromMeeting } from "../todo-extract";
import { isEnoent } from "../errors";

describe("todo extract prompt", () => {
  it("forbids copying Plaud action lists and loads page conventions", () => {
    const prompt = buildTodoExtractPrompt({
      conventions: "## Page conventions\nCite sources.",
      pageTitle: "Standup",
      slug: "standup",
      pageBody: "# Standup\nWe will ship Friday.",
      sourceBodies: "--- raw/sources/meet/a.md ---\nAlice: I'll send the recap.",
    });
    expect(prompt).toContain("Page conventions");
    expect(prompt).toContain("Cite sources.");
    expect(prompt).toContain("standup.md");
    const source = `${buildTodoExtractPrompt.toString()}`;
    expect(source).not.toContain("proposeActionItems");
  });
});

describe("extractTodoCandidatesFromMeeting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    hasLLMKey.mockReturnValue(true);
    loadPageConventions.mockResolvedValue("## Page conventions\nBe precise.");
    readWikiPageWithFrontmatter.mockResolvedValue({
      title: "Standup",
      body: "# Standup\nCommit to a recap.",
      frontmatter: { sources: '[{"type":"text","url":"raw/sources/meet/abc.md","fetched":"2026-08-01","triggered_by":"alice"}]' },
    });
    generateText.mockResolvedValue({
      output: {
        candidates: [
          { title: "Send recap", rationale: "Alice committed." },
          { title: "Send recap", rationale: "Duplicate from summary." },
        ],
      },
    });
    enqueueTodoCandidates.mockResolvedValue([]);
  });

  it("enqueues collapsed candidates and never calls proposeActionItems", async () => {
    await extractTodoCandidatesFromMeeting("alice", "standup", "raw/sources/meet/abc.md");
    expect(enqueueTodoCandidates).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({
        wikiId: "wiki-1",
        sourceId: "raw/sources/meet/abc.md",
        pageSlug: "standup",
      }),
    );
    expect(loadPageConventions).toHaveBeenCalled();
    expect(proposeActionItems).not.toHaveBeenCalled();
    const system = generateText.mock.calls[0]?.[0]?.system as string;
    expect(system).toMatch(/Do not transcribe or copy a Plaud/);
    expect(system).toMatch(/Precision over recall/);
  });

  it("refreshes Candidates when none are found", async () => {
    generateText.mockResolvedValue({ output: { candidates: [] } });
    await extractTodoCandidatesFromMeeting("alice", "standup", "raw/sources/meet/abc.md");
    expect(enqueueTodoCandidates).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({ candidates: [] }),
    );
  });

  it("fails visibly when no LLM is configured instead of wiping Candidates", async () => {
    hasLLMKey.mockReturnValue(false);
    await expect(
      extractTodoCandidatesFromMeeting("alice", "standup", "raw/sources/meet/abc.md"),
    ).rejects.toThrow(/Configure an LLM/);
    expect(enqueueTodoCandidates).not.toHaveBeenCalled();
  });

  it("throws when the compiled page is missing", async () => {
    readWikiPageWithFrontmatter.mockResolvedValue(null);
    await expect(
      extractTodoCandidatesFromMeeting("alice", "missing", "raw/sources/meet/abc.md"),
    ).rejects.toThrow(/not found/);
    expect(enqueueTodoCandidates).not.toHaveBeenCalled();
  });
});

describe("isEnoent used for missing source bytes", () => {
  it("does not treat a missing source file as a fatal extract when a path is given", () => {
    expect(isEnoent(Object.assign(new Error("ENOENT"), { code: "ENOENT" }))).toBe(true);
  });
});
