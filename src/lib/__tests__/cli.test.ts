import { describe, it, expect, vi, beforeEach, afterEach, type MockInstance } from "vitest";
import { parseArgs } from "../../cli";
import { ollamaBaseUrlRefusedCopy } from "../workbench-settings";
import type { EffectiveSettings } from "../config";

describe("CLI argument parsing", () => {
  describe("ingest command", () => {
    it("parses ingest with URL", () => {
      const result = parseArgs(["ingest", "https://example.com"]);
      expect(result).toEqual({ command: "ingest-url", url: "https://example.com" });
    });

    it("parses ingest with --text flag", () => {
      const result = parseArgs(["ingest", "--text"]);
      expect(result).toEqual({ command: "ingest-text" });
    });

    it("returns error when ingest has no URL and no --text", () => {
      const result = parseArgs(["ingest"]);
      expect(result.command).toBe("error");
    });
  });

  describe("query command", () => {
    it("parses query with question", () => {
      const result = parseArgs(["query", "what is AI?"]);
      expect(result).toEqual({ command: "query", question: "what is AI?" });
    });

    it("joins multiple words into a single question", () => {
      const result = parseArgs(["query", "what", "is", "attention?"]);
      expect(result).toEqual({ command: "query", question: "what is attention?" });
    });

    it("returns error when query has no question", () => {
      const result = parseArgs(["query"]);
      expect(result.command).toBe("error");
    });
  });

  describe("search command", () => {
    it("parses search with query", () => {
      const result = parseArgs(["search", "attention"]);
      expect(result).toEqual({ command: "search", query: "attention", fuzzy: false, limit: 10 });
    });

    it("joins multiple words into a single query", () => {
      const result = parseArgs(["search", "attention", "mechanism"]);
      expect(result).toEqual({ command: "search", query: "attention mechanism", fuzzy: false, limit: 10 });
    });

    it("parses --fuzzy flag", () => {
      const result = parseArgs(["search", "atention", "--fuzzy"]);
      expect(result).toEqual({ command: "search", query: "atention", fuzzy: true, limit: 10 });
    });

    it("parses --scope flag", () => {
      const result = parseArgs(["search", "identity", "--scope", "agent:yoyo"]);
      expect(result).toEqual({ command: "search", query: "identity", fuzzy: false, scope: "agent:yoyo", limit: 10 });
    });

    it("parses --limit flag", () => {
      const result = parseArgs(["search", "wiki", "--limit", "5"]);
      expect(result).toEqual({ command: "search", query: "wiki", fuzzy: false, limit: 5 });
    });

    it("parses all flags together", () => {
      const result = parseArgs(["search", "test", "--fuzzy", "--scope", "agent:yoyo", "--limit", "3"]);
      expect(result).toEqual({ command: "search", query: "test", fuzzy: true, scope: "agent:yoyo", limit: 3 });
    });

    it("defaults limit to 10 for invalid --limit value", () => {
      const result = parseArgs(["search", "test", "--limit", "abc"]);
      expect(result).toEqual({ command: "search", query: "test", fuzzy: false, limit: 10 });
    });

    it("returns error when search has no query", () => {
      const result = parseArgs(["search"]);
      expect(result.command).toBe("error");
    });

    it("returns error when search has only flags", () => {
      const result = parseArgs(["search", "--fuzzy"]);
      expect(result.command).toBe("error");
    });
  });

  describe("lint command", () => {
    it("parses lint without flags", () => {
      const result = parseArgs(["lint"]);
      expect(result).toEqual({ command: "lint", fix: false });
    });

    it("parses lint with --fix flag", () => {
      const result = parseArgs(["lint", "--fix"]);
      expect(result).toEqual({ command: "lint", fix: true });
    });
  });

  describe("list command", () => {
    it("parses list without flags", () => {
      const result = parseArgs(["list"]);
      expect(result).toEqual({ command: "list", raw: false });
    });

    it("parses list with --raw flag", () => {
      const result = parseArgs(["list", "--raw"]);
      expect(result).toEqual({ command: "list", raw: true });
    });
  });

  describe("status command", () => {
    it("parses status", () => {
      const result = parseArgs(["status"]);
      expect(result).toEqual({ command: "status" });
    });
  });

  describe("retired publish command", () => {
    it("no longer parses publish — falls to the unknown-command error", () => {
      // Publish-to-commons is retired; the CLI must not keep a live entry point.
      const result = parseArgs(["publish", "my-topic", "--agent", "alice--yoyo"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Unknown command: publish");
        expect(result.message).toContain('Run "pnpm cli help"');
      }
    });
  });

  describe("history command", () => {
    it("parses history without flags (default limit 20)", () => {
      const result = parseArgs(["history"]);
      expect(result).toEqual({ command: "history", limit: 20 });
    });

    it("parses history with --limit flag", () => {
      const result = parseArgs(["history", "--limit", "10"]);
      expect(result).toEqual({ command: "history", limit: 10 });
    });

    it("defaults limit to 20 for invalid --limit value", () => {
      const result = parseArgs(["history", "--limit", "abc"]);
      expect(result).toEqual({ command: "history", limit: 20 });
    });
  });

  describe("read command", () => {
    it("parses read with slug", () => {
      const result = parseArgs(["read", "attention-mechanisms"]);
      expect(result).toEqual({ command: "read", slug: "attention-mechanisms" });
    });

    it("returns error when read has no slug", () => {
      const result = parseArgs(["read"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });

  describe("reingest command", () => {
    it("parses reingest with slug", () => {
      const result = parseArgs(["reingest", "attention-mechanisms"]);
      expect(result).toEqual({ command: "reingest", slug: "attention-mechanisms" });
    });

    it("returns error when reingest has no slug", () => {
      const result = parseArgs(["reingest"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });

  describe("delete command", () => {
    it("parses delete with slug", () => {
      const result = parseArgs(["delete", "attention-mechanisms"]);
      expect(result).toEqual({ command: "delete", slug: "attention-mechanisms" });
    });

    it("returns error when delete has no slug", () => {
      const result = parseArgs(["delete"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });

  describe("create command", () => {
    it("parses create with slug and title", () => {
      const result = parseArgs(["create", "my-page", "--title", "My Page"]);
      expect(result).toEqual({ command: "create", slug: "my-page", title: "My Page" });
    });

    it("parses create with tags", () => {
      const result = parseArgs(["create", "my-page", "--title", "My Page", "--tags", "ai,ml"]);
      expect(result).toEqual({ command: "create", slug: "my-page", title: "My Page", tags: ["ai", "ml"] });
    });

    it("returns error when create has no slug", () => {
      const result = parseArgs(["create"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });

    it("returns error when create has no --title", () => {
      const result = parseArgs(["create", "my-page"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });

    it("returns error when --title has no value", () => {
      const result = parseArgs(["create", "my-page", "--title"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });

  describe("update command", () => {
    it("parses update with slug only", () => {
      const result = parseArgs(["update", "my-page"]);
      expect(result).toEqual({ command: "update", slug: "my-page" });
    });

    it("parses update with --title", () => {
      const result = parseArgs(["update", "my-page", "--title", "New Title"]);
      expect(result).toEqual({ command: "update", slug: "my-page", title: "New Title" });
    });

    it("parses update with --tags", () => {
      const result = parseArgs(["update", "my-page", "--tags", "ai,ml"]);
      expect(result).toEqual({ command: "update", slug: "my-page", tags: ["ai", "ml"] });
    });

    it("parses update with --title and --tags", () => {
      const result = parseArgs(["update", "my-page", "--title", "New Title", "--tags", "ai,ml"]);
      expect(result).toEqual({ command: "update", slug: "my-page", title: "New Title", tags: ["ai", "ml"] });
    });

    it("returns error when update has no slug", () => {
      const result = parseArgs(["update"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });

  describe("help command", () => {
    it("parses help", () => {
      const result = parseArgs(["help"]);
      expect(result).toEqual({ command: "help" });
    });

    it("parses --help flag", () => {
      const result = parseArgs(["--help"]);
      expect(result).toEqual({ command: "help" });
    });

    it("parses -h flag", () => {
      const result = parseArgs(["-h"]);
      expect(result).toEqual({ command: "help" });
    });

    it("shows help when no args provided", () => {
      const result = parseArgs([]);
      expect(result).toEqual({ command: "help" });
    });
  });

  describe("error handling", () => {
    it("returns error for unknown command", () => {
      const result = parseArgs(["unknown"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Unknown command");
      }
    });

    it("returns error for missing ingest argument", () => {
      const result = parseArgs(["ingest"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });

    it("returns error for missing query argument", () => {
      const result = parseArgs(["query"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });

    it("returns error for missing search argument", () => {
      const result = parseArgs(["search"]);
      expect(result.command).toBe("error");
      if (result.command === "error") {
        expect(result.message).toContain("Usage");
      }
    });
  });
});

// ---------------------------------------------------------------------------
// CLI command execution tests
// ---------------------------------------------------------------------------

vi.mock("../wiki", () => ({
  listWikiPages: vi.fn(),
  readWikiPageWithFrontmatter: vi.fn(),
  readWikiPage: vi.fn(),
  validateSlug: vi.fn(),
}));

vi.mock("../raw", () => ({
  listRawSources: vi.fn(),
  // `list --raw` and `status` union the flat listing with the hashed
  // `raw/sources/<slug>/<id>.md` snapshots (DW-437). The export has to exist
  // here or every listing case dies on `listRawSourceSnapshots is not a
  // function` rather than on an assertion.
  listRawSourceSnapshots: vi.fn(),
}));

vi.mock("../config", () => ({
  getEffectiveSettings: vi.fn(),
  // `runStatus()` warms the sync config cache before reading it (DW-502), and
  // since DW-549 it does that through `readConfig()` — the one door that tells
  // an absent store from an unreadable one. The export has to exist here or
  // every `runStatus` case below dies on `readConfig is not a function` rather
  // than on an assertion.
  //
  // GIVEN A DEFAULT, not left as a bare `vi.fn()`: that returns `undefined` and
  // `runStatus` reads `.status` off the answer, so every case here would die on
  // a TypeError instead. `ok` with an empty config is the readable-and-empty
  // store, which is what this mocked suite's row-shape cases assume.
  readConfig: vi.fn(async () => ({
    status: "ok",
    config: {},
    version: "unstamped",
    etag: null,
  })),
}));

vi.mock("../query", () => ({
  query: vi.fn(),
}));

vi.mock("../lint", () => ({
  lint: vi.fn(),
}));

vi.mock("../ingest", () => ({
  ingestUrl: vi.fn(),
  ingest: vi.fn(),
  reingest: vi.fn(),
  extractSummary: vi.fn(),
}));

vi.mock("../lint-fix", () => ({
  fixLintIssue: vi.fn(),
}));

vi.mock("../search", () => ({
  searchWikiContent: vi.fn(),
  fuzzySearchWikiContent: vi.fn(),
  resolveScope: vi.fn(),
}));

vi.mock("../lifecycle", () => ({
  deleteWikiPage: vi.fn(),
  writeWikiPageWithSideEffects: vi.fn(),
}));

vi.mock("../frontmatter", () => ({
  serializeFrontmatter: vi.fn(),
}));

/**
 * A whole `EffectiveSettings`, configured and clean, for `runStatus()` to read.
 *
 * The resolver returns one object with every field populated, so the fixture is
 * one object too: a partial would let a `runStatus` that reads a NEW field pass
 * against `undefined` rather than against the value the resolver would have
 * supplied.
 */
function effectiveSettings(
  overrides: Partial<EffectiveSettings> = {},
): EffectiveSettings {
  // `satisfies` on the SOURCE LITERAL, the convention `src/app/api/status/route.ts`
  // already uses and explains. A type ASSERTION would permit a missing required
  // property just as silently as a partial does, which would make this block's
  // own claim untrue; `satisfies` makes the next field added to
  // `EffectiveSettings` a compile error right here.
  const base = {
    provider: "anthropic",
    providerSource: "env",
    model: "claude-sonnet-4-20250514",
    modelSource: "default",
    configured: true,
    embeddingSupport: true,
    embeddingModel: null,
    embeddingModelSource: "default",
    embeddingModelInEffect: "text-embedding-3-small",
    embeddingProviderInEffect: "openai",
    embeddingModelOverridden: false,
    hasApiKey: true,
    apiKeySource: "env",
    ollamaBaseUrl: null,
    ollamaBaseUrlSource: "default",
    ollamaBaseUrlIssue: null,
    structuredKnowledgeProvider: "anthropic",
    structuredKnowledgeProviderSource: "default",
    structuredKnowledgeModel: "claude-sonnet-4-20250514",
    structuredKnowledgeModelSource: "default",
    structuredKnowledgeConfigured: true,
    readOnly: false,
  } satisfies EffectiveSettings;
  return { ...base, ...overrides };
}

describe("CLI command execution", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: MockInstance<(code?: number) => never>;

  beforeEach(async () => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => { throw new Error("process.exit"); }) as unknown as () => never);
    // Empty by default so the cases that only care about one of the two raw
    // listings keep saying exactly what they mean; `mockResolvedValueOnce`
    // still takes precedence per case.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValue([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValue([]);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("runList(false) prints wiki pages sorted by title", async () => {
    const { listWikiPages } = await import("../wiki");
    const mock = vi.mocked(listWikiPages);
    mock.mockResolvedValueOnce([
      { slug: "transformers", title: "Transformers", summary: "" },
      { slug: "attention", title: "Attention", summary: "" },
    ]);

    const { runList } = await import("../../cli");
    await runList(false);

    expect(logSpy).toHaveBeenCalledWith("attention\tAttention");
    expect(logSpy).toHaveBeenCalledWith("transformers\tTransformers");
    // Attention sorts before Transformers
    const calls = logSpy.mock.calls.map((c) => c[0]);
    expect(calls.indexOf("attention\tAttention")).toBeLessThan(
      calls.indexOf("transformers\tTransformers"),
    );
  });

  it("runList(true) prints raw sources sorted by slug", async () => {
    const { listRawSources } = await import("../raw");
    const mock = vi.mocked(listRawSources);
    mock.mockResolvedValueOnce([
      { slug: "source-b", filename: "source-b.md", size: 200, modified: "2025-01-02T00:00:00Z" },
      { slug: "source-a", filename: "source-a.md", size: 100, modified: "2025-01-01T00:00:00Z" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy).toHaveBeenCalledWith("source-a\tsource-a.md");
    expect(logSpy).toHaveBeenCalledWith("source-b\tsource-b.md");
  });

  it("runList(true) prints hashed snapshots when there is no flat source", async () => {
    // A workspace built entirely through Workbench Intake has NOTHING at the
    // flat `raw/sources/<id>.md` level — every Source is a hashed
    // `raw/sources/<slug>/<id>.md` arrival. Before DW-437 that printed nothing
    // at all, because `listRawSources` is non-recursive by contract.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy).toHaveBeenCalledWith("alpha\tabc123.md");
  });

  it("runList(true) prints flat sources and snapshots together, sorted by slug", async () => {
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "note", filename: "note.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    const calls = logSpy.mock.calls.map((c) => c[0]);
    expect(calls).toEqual(["alpha\tabc123.md", "note\tnote.md"]);
  });

  it("runList(true) prints ONE row for a slug ingest wrote both ways", async () => {
    // `ingest()` writes BOTH keys for the same slug — the flat blob
    // (`src/lib/ingest.ts:1953`) and the per-source snapshot
    // (`src/lib/ingest.ts:2012`) — so a plain concatenation would print every
    // normally-ingested page twice and roughly double the `status` count. The
    // snapshot is the per-source view of the same page, so it wins and the flat
    // row is dropped.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "alpha", filename: "alpha.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["alpha\tabc123.md"]);
  });

  it("runList(true) keeps the flat row when the only snapshot is BINARY", async () => {
    // The flat row is suppressed because `ingest()` writes the flat blob and
    // the `.md` snapshot from the SAME text. A `.png` dropped on the same slug
    // is a different Source, so suppressing on it would delete a real prose
    // Source from the listing and the count to make room for an image.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "alpha", filename: "alpha.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "alpha",
        rawId: "abc123",
        ext: "png",
        mediaType: "image/png",
        path: "raw/sources/alpha/abc123.png",
      },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
      "alpha\talpha.md",
      "alpha\tabc123.png",
    ]);
  });

  it("runStatus() counts a flat Source and a binary snapshot on one slug as 2", async () => {
    // The count half of the case above: two Sources really are stored, and the
    // suppression must not swallow one of them.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "alpha", filename: "alpha.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "alpha",
        rawId: "abc123",
        ext: "png",
        mediaType: "image/png",
        path: "raw/sources/alpha/abc123.png",
      },
    ]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    expect(logSpy.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "Raw sources:\t2",
    );
  });

  it("runList(true) prints one row per snapshot for a multi-source page", async () => {
    // Dropping the flat row must not collapse the page to a single row: a page
    // built from three sources has three raws, and the per-source view is the
    // whole reason the snapshots are listed at all.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "alpha", filename: "alpha.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "aaa111", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/aaa111.md" },
      { slug: "alpha", rawId: "bbb222", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/bbb222.md" },
      { slug: "alpha", rawId: "ccc333", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/ccc333.md" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual([
      "alpha\taaa111.md",
      "alpha\tbbb222.md",
      "alpha\tccc333.md",
    ]);
  });

  it("runList(true) prints a stored PDF that no Markdown sits beside (DW-569)", async () => {
    // The CLI is the caller that does NOT filter by extension: `list --raw`
    // describes what is STORED, and before the listing carried binaries a
    // PDF-only workspace printed nothing at all.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "paper",
        rawId: "abc123",
        ext: "pdf",
        mediaType: "application/pdf",
        path: "raw/sources/paper/abc123.pdf",
      },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["paper\tabc123.pdf"]);
  });

  it("runList(true) prints ONE row for a PDF and the Markdown extracted from it", async () => {
    // `saveRawSourceBytes` stores the extract at `<slug>/<rawId>.md` beside the
    // bytes under the SAME `rawId` — one arrival, two artefacts. Printing both
    // would show one Source twice and double the `status` count. The original
    // wins the row; the extract is derived from it.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "paper",
        rawId: "abc123",
        ext: "md",
        mediaType: "text/markdown",
        path: "raw/sources/paper/abc123.md",
      },
      {
        slug: "paper",
        rawId: "abc123",
        ext: "pdf",
        mediaType: "application/pdf",
        path: "raw/sources/paper/abc123.pdf",
      },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["paper\tabc123.pdf"]);
  });

  it("runList(true) prefers the original however the two artefacts are ordered", async () => {
    // The walk's order is the provider's, so the preference cannot depend on
    // which of the pair the listing happened to reach first.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "paper",
        rawId: "abc123",
        ext: "pdf",
        mediaType: "application/pdf",
        path: "raw/sources/paper/abc123.pdf",
      },
      {
        slug: "paper",
        rawId: "abc123",
        ext: "md",
        mediaType: "text/markdown",
        path: "raw/sources/paper/abc123.md",
      },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["paper\tabc123.pdf"]);
  });

  it("runStatus() counts a PDF-only workspace as 1, not 0 (DW-569)", async () => {
    const { listWikiPages } = await import("../wiki");
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      {
        slug: "paper",
        rawId: "abc123",
        ext: "pdf",
        mediaType: "application/pdf",
        path: "raw/sources/paper/abc123.pdf",
      },
    ]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    expect(logSpy.mock.calls.map((c) => c[0]).join("\n")).toContain(
      "Raw sources:\t1",
    );
  });

  it("runList(true) still prints snapshots when the flat listing throws", async () => {
    // Each listing gets its own try/catch, as `wiki-retrieve.ts` does: one
    // failing root must not blank the other — and the operator is TOLD, because
    // a silently halved listing reads exactly like a small workspace.
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockRejectedValueOnce(new Error("listing failed"));
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
    ]);

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy).toHaveBeenCalledWith("alpha\tabc123.md");
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "listing failed",
    );
  });

  it("runList(true) still prints flat sources when the snapshot walk throws", async () => {
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "note", filename: "note.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockRejectedValueOnce(
      new Error("snapshot walk failed"),
    );

    const { runList } = await import("../../cli");
    await runList(true);

    expect(logSpy.mock.calls.map((c) => c[0])).toEqual(["note\tnote.md"]);
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "snapshot walk failed",
    );
  });

  it("runStatus() prints page count, source count, and provider info", async () => {
    const { listWikiPages } = await import("../wiki");
    const { listRawSources } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([
      { slug: "page-1", title: "Page 1", summary: "" },
      { slug: "page-2", title: "Page 2", summary: "" },
      { slug: "page-3", title: "Page 3", summary: "" },
    ]);
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "raw-1", filename: "raw-1.md", size: 50, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce({
      provider: "anthropic",
      providerSource: "env",
      model: "claude-sonnet-4-20250514",
      modelSource: "default",
      configured: true,
      embeddingSupport: true,
      embeddingModel: null,
      embeddingModelSource: "default",
      embeddingModelInEffect: "text-embedding-3-small",
      embeddingProviderInEffect: "openai",
      embeddingModelOverridden: false,
      hasApiKey: true,
      apiKeySource: "env",
      ollamaBaseUrl: null,
      ollamaBaseUrlSource: "default",
      ollamaBaseUrlIssue: null,
      structuredKnowledgeProvider: "anthropic",
      structuredKnowledgeProviderSource: "default",
      structuredKnowledgeModel: "claude-sonnet-4-20250514",
      structuredKnowledgeModelSource: "default",
      structuredKnowledgeConfigured: true,
      readOnly: false,
    });

    const { runStatus } = await import("../../cli");
    await runStatus();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Wiki pages:\t3");
    expect(output).toContain("Raw sources:\t1");
    expect(output).toContain("LLM provider:\tanthropic");
    expect(output).toContain("Embeddings:\tavailable");
  });

  it("runStatus() counts hashed snapshots alongside flat sources", async () => {
    // 1 flat + 2 hashed = 3. A count taken from `listRawSources` alone reports
    // 0 Sources for an Intake-only workspace (DW-437).
    const { listWikiPages } = await import("../wiki");
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([
      { slug: "note", filename: "note.md", size: 10, modified: "2025-01-01T00:00:00Z" },
    ]);
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
      { slug: "beta", rawId: "def456", ext: "md", mediaType: "text/markdown", path: "raw/sources/beta/def456.md" },
    ]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Raw sources:\t3");
  });

  it("runStatus() still prints a count when a raw listing throws", async () => {
    // The four rows are a parsed shape, so a failing listing must not remove
    // one — the count degrades to what the surviving listing can see, and the
    // reason goes to stderr where it cannot be mistaken for a data row.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources, listRawSourceSnapshots } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockRejectedValueOnce(new Error("listing failed"));
    vi.mocked(listRawSourceSnapshots).mockResolvedValueOnce([
      { slug: "alpha", rawId: "abc123", ext: "md", mediaType: "text/markdown", path: "raw/sources/alpha/abc123.md" },
    ]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Raw sources:\t1");
    expect(errorSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "listing failed",
    );
  });

  it("runStatus() prints NO extra line when the resolver refused nothing", async () => {
    // The other half of the case above, said out loud. `Label:\tvalue` is a
    // parsed shape, so a clean config has to print exactly the four rows it
    // always has — an unconditional fifth row carrying `null` would be a new
    // field for every reader of this output.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    expect(logSpy.mock.calls).toHaveLength(4);
    expect(logSpy.mock.calls.map((c) => c[0]).join("\n")).not.toContain(
      "Ollama endpoint:",
    );
  });

  it("runStatus() prints the refusal beside the provider verdict (DW-418)", async () => {
    // THE POINT. "not configured" is the same word for "nothing was ever set"
    // and for "what you set was thrown away", and only the second one has an
    // action attached. The resolver already knows which and carries the
    // sentence; the headless operator is the reader least able to go look,
    // since there is no Settings screen on this side of the product.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    const issue = ollamaBaseUrlRefusedCopy("env", "localhost:11434");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(
      effectiveSettings({
        provider: null,
        providerSource: "none",
        model: null,
        modelSource: "none",
        configured: false,
        embeddingSupport: false,
        hasApiKey: false,
        apiKeySource: "none",
        ollamaBaseUrlSource: "none",
        ollamaBaseUrlIssue: issue,
      }),
    );

    const { runStatus } = await import("../../cli");
    await runStatus();

    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines).toContain("LLM provider:\tnot configured");
    expect(lines).toContain(`Ollama endpoint:\t${issue}`);
    // BESIDE the verdict, not somewhere further down the output.
    expect(lines.indexOf(`Ollama endpoint:\t${issue}`)).toBe(
      lines.indexOf("LLM provider:\tnot configured") + 1,
    );
    // The row names its OWN subject. "Provider note" under a `LLM provider:`
    // line reads as a qualification of that line, which is wrong even here and
    // actively misleading on the configured case below.
    expect(lines.join("\n")).not.toContain("Provider note:");
    // The sentence is the resolver's, unchanged — not a second wording composed
    // for the CLI, which would be free to drift from the one the web surface and
    // the warn line already share.
    expect(lines.join("\n")).toContain("OLLAMA_BASE_URL is not an absolute http(s) URL");
  });

  it("runStatus() still prints the endpoint refusal when a provider IS configured", async () => {
    // A deployment running `anthropic` can still carry a typo'd
    // `OLLAMA_BASE_URL`, and the resolver still refuses it. Suppressing the
    // sentence whenever a provider resolved would hide it from the one reader
    // with no Settings screen to go and look at — so the row is gated on the
    // ISSUE, never on the verdict, and its label is what keeps it from reading
    // as a note on a line that succeeded.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources } = await import("../raw");
    const { getEffectiveSettings } = await import("../config");

    const issue = ollamaBaseUrlRefusedCopy("env", "localhost:11434");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(
      effectiveSettings({ ollamaBaseUrlIssue: issue }),
    );

    const { runStatus } = await import("../../cli");
    await runStatus();

    const lines = logSpy.mock.calls.map((c) => c[0] as string);
    expect(lines).toContain("LLM provider:\tanthropic");
    expect(lines).toContain(`Ollama endpoint:\t${issue}`);
    // NOT a note on the verdict above it: the label says what it is about, so
    // the successful `anthropic` line is not read as being qualified.
    expect(lines.join("\n")).not.toContain("Provider note:");
  });

  it("runStatus() warms the config cache BEFORE reading effective settings (DW-502)", async () => {
    // ORDER is the whole assertion. `getEffectiveSettings()` is synchronous and
    // reads the store through `loadConfigSync()`, which answers `{}` until an
    // async load has warmed the cache — so a `readConfig()` that ran after it,
    // or not at all, leaves a cold CLI process reporting env-only settings.
    // `readConfig()` warms that cache exactly as `loadConfig()` did (DW-549);
    // what it adds is the absent/unreadable distinction, not a different read.
    //
    // This suite mocks `../config` wholesale, so it can only pin the CALL, never
    // the effect: a mocked `getEffectiveSettings` returns a full object whatever
    // the cache holds. `cli-status-config-load.test.ts` pins the effect against
    // the real module and a real store.
    const { listWikiPages } = await import("../wiki");
    const { listRawSources } = await import("../raw");
    const { getEffectiveSettings, readConfig } = await import("../config");

    vi.mocked(listWikiPages).mockResolvedValueOnce([]);
    vi.mocked(listRawSources).mockResolvedValueOnce([]);
    vi.mocked(getEffectiveSettings).mockReturnValueOnce(effectiveSettings());

    const { runStatus } = await import("../../cli");
    await runStatus();

    expect(vi.mocked(readConfig)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(getEffectiveSettings)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(readConfig).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(getEffectiveSettings).mock.invocationCallOrder[0],
    );
  });

  it("runQuery() prints answer to stdout and sources to stderr", async () => {
    const { query } = await import("../query");
    vi.mocked(query).mockResolvedValueOnce({
      answer: "Test answer about transformers",
      sources: ["transformers", "attention"],
    });

    const { runQuery } = await import("../../cli");
    await runQuery("What are transformers?");

    expect(logSpy).toHaveBeenCalledWith("Test answer about transformers");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("transformers, attention"),
    );
  });

  it("runLint(false) with issues prints them and exits with code 1", async () => {
    const { lint } = await import("../lint");
    vi.mocked(lint).mockResolvedValueOnce({
      issues: [
        {
          type: "orphan-page",
          slug: "orphan",
          message: "Not linked from index",
          severity: "warning",
        },
      ],
      summary: "1 issue found",
      checkedAt: "2025-01-01T00:00:00Z",
    });

    const { runLint } = await import("../../cli");
    await expect(runLint(false)).rejects.toThrow("process.exit");

    expect(exitSpy).toHaveBeenCalledWith(1);
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("orphan-page");
    expect(output).toContain("orphan");
    expect(output).toContain("1 issue found");
  });

  it("runLint(false) with no issues prints success message", async () => {
    const { lint } = await import("../lint");
    vi.mocked(lint).mockResolvedValueOnce({
      issues: [],
      summary: "All clear",
      checkedAt: "2025-01-01T00:00:00Z",
    });

    const { runLint } = await import("../../cli");
    await runLint(false);

    expect(logSpy).toHaveBeenCalledWith("No issues found.");
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("runLint(true) with issues attempts auto-fix", async () => {
    const { lint } = await import("../lint");
    const { fixLintIssue } = await import("../lint-fix");

    vi.mocked(lint).mockResolvedValueOnce({
      issues: [
        {
          type: "empty-page",
          slug: "empty",
          message: "Page has no content",
          severity: "warning",
        },
      ],
      summary: "1 issue found",
      checkedAt: "2025-01-01T00:00:00Z",
    });
    vi.mocked(fixLintIssue).mockResolvedValueOnce({
      success: true,
      message: "Page populated",
      slug: "empty",
    });

    const { runLint } = await import("../../cli");
    await runLint(true);

    expect(fixLintIssue).toHaveBeenCalledWith("empty-page", "empty", undefined, "Page has no content");
    const output = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(output).toContain("Fixed: 1, Failed: 0");
    // Should NOT call process.exit when all fixes succeed
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("runIngestUrl() prints the primary slug", async () => {
    const { ingestUrl } = await import("../ingest");
    vi.mocked(ingestUrl).mockResolvedValueOnce({
      rawPath: "raw/example-article.md",
      primarySlug: "example-article",
      relatedUpdated: ["related-page"],
      wikiPages: ["example-article", "related-page"],
      indexUpdated: true,
      sourceUrl: "https://example.com/article",
    });

    const { runIngestUrl } = await import("../../cli");
    await runIngestUrl("https://example.com/article");

    expect(logSpy).toHaveBeenCalledWith("example-article");
    expect(logSpy).toHaveBeenCalledWith("related-page");
  });

  it("runIngestText() reads stdin and prints the primary slug", async () => {
    const { ingest } = await import("../ingest");
    vi.mocked(ingest).mockResolvedValueOnce({
      rawPath: "raw/test-title.md",
      primarySlug: "test-title",
      relatedUpdated: [],
      wikiPages: ["test-title"],
      indexUpdated: true,
    });

    // Mock process.stdin to emit data then end
    const originalOn = process.stdin.on;
    const stdinMock = vi.spyOn(process.stdin, "on").mockImplementation(
      function (this: NodeJS.ReadStream, event: string, listener: (...args: unknown[]) => void) {
        if (event === "data") {
          // Schedule data emission
          setTimeout(() => listener(Buffer.from("Test title\nSome body content")), 0);
        } else if (event === "end") {
          // Schedule end after data
          setTimeout(() => (listener as () => void)(), 5);
        }
        return this;
      } as never,
    );

    const { runIngestText } = await import("../../cli");
    await runIngestText();

    expect(ingest).toHaveBeenCalledWith("Test title", "Test title\nSome body content");
    expect(logSpy).toHaveBeenCalledWith("test-title");

    stdinMock.mockRestore();
    process.stdin.on = originalOn;
  });

  it("runSearch() prints tab-separated results", async () => {
    const { searchWikiContent } = await import("../search");
    vi.mocked(searchWikiContent).mockResolvedValueOnce([
      { slug: "attention", title: "Attention", summary: "About attention", snippet: "…the attention mechanism…", score: 2 },
      { slug: "transformers", title: "Transformers", summary: "About transformers", snippet: "…transformer architecture…", score: 1 },
    ]);

    const { runSearch } = await import("../../cli");
    await runSearch("attention", false, 10);

    expect(searchWikiContent).toHaveBeenCalledWith("attention", 10, undefined);
    expect(logSpy).toHaveBeenCalledWith("attention\t2\t…the attention mechanism…");
    expect(logSpy).toHaveBeenCalledWith("transformers\t1\t…transformer architecture…");
  });

  it("runSearch() uses fuzzySearchWikiContent when fuzzy is true", async () => {
    const { fuzzySearchWikiContent } = await import("../search");
    vi.mocked(fuzzySearchWikiContent).mockResolvedValueOnce([
      { slug: "attention", title: "Attention", summary: "About attention", snippet: "…the attention mechanism…", score: 2 },
    ]);

    const { runSearch } = await import("../../cli");
    await runSearch("atention", true, 10);

    expect(fuzzySearchWikiContent).toHaveBeenCalledWith("atention", 10, undefined);
    expect(logSpy).toHaveBeenCalledWith("attention\t2\t…the attention mechanism…");
  });

  it("runSearch() passes resolved scope", async () => {
    const { searchWikiContent, resolveScope } = await import("../search");
    const mockScope = { agentId: "yoyo", slugs: ["identity", "learnings"] };
    vi.mocked(resolveScope).mockResolvedValueOnce(mockScope);
    vi.mocked(searchWikiContent).mockResolvedValueOnce([
      { slug: "identity", title: "Identity", summary: "Agent identity", snippet: "…identity page…", score: 1 },
    ]);

    const { runSearch } = await import("../../cli");
    await runSearch("identity", false, 5, "agent:yoyo");

    expect(resolveScope).toHaveBeenCalledWith("agent:yoyo");
    expect(searchWikiContent).toHaveBeenCalledWith("identity", 5, mockScope);
  });

  it("runSearch() prints message to stderr when no results", async () => {
    const { searchWikiContent } = await import("../search");
    vi.mocked(searchWikiContent).mockResolvedValueOnce([]);

    const { runSearch } = await import("../../cli");
    await runSearch("nonexistent", false, 10);

    expect(errorSpy).toHaveBeenCalledWith("No results found.");
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("runSearch() replaces tabs in snippets to preserve column format", async () => {
    const { searchWikiContent } = await import("../search");
    vi.mocked(searchWikiContent).mockResolvedValueOnce([
      { slug: "test", title: "Test", summary: "Test", snippet: "has\ttab\there", score: 1 },
    ]);

    const { runSearch } = await import("../../cli");
    await runSearch("test", false, 10);

    expect(logSpy).toHaveBeenCalledWith("test\t1\thas tab here");
  });

  it("runRead() prints metadata header and body for existing page", async () => {
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "attention",
      title: "Attention Mechanisms",
      content: "---\ntitle: Attention Mechanisms\nconfidence: 0.85\ntags: [ml, nlp]\nauthors: [yoyo]\nexpiry: 2025-12-01\n---\n\n# Attention Mechanisms\n\nAttention is a key concept.",
      path: "/wiki/attention.md",
      frontmatter: {
        title: "Attention Mechanisms",
        confidence: 0.85,
        tags: ["ml", "nlp"],
        authors: ["yoyo"],
        expiry: "2025-12-01",
      },
      body: "# Attention Mechanisms\n\nAttention is a key concept.",
    });

    const { runRead } = await import("../../cli");
    await runRead("attention");

    expect(readWikiPageWithFrontmatter).toHaveBeenCalledWith("attention");
    // Check metadata header lines
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Title:      Attention Mechanisms"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Confidence: 0.85"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Tags:       ml, nlp"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Authors:    yoyo"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Expiry:     2025-12-01"));
    // Check separator and body
    expect(logSpy).toHaveBeenCalledWith("---");
    expect(logSpy).toHaveBeenCalledWith("# Attention Mechanisms\n\nAttention is a key concept.");
  });

  it("runRead() exits with error for nonexistent page", async () => {
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce(null);

    const { runRead } = await import("../../cli");
    await expect(runRead("nonexistent-slug")).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('page "nonexistent-slug" not found'));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("pnpm cli list"));
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("runRead() omits optional metadata fields when not present", async () => {
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "simple",
      title: "Simple Page",
      content: "---\ntitle: Simple Page\n---\n\n# Simple Page\n\nJust content.",
      path: "/wiki/simple.md",
      frontmatter: { title: "Simple Page" },
      body: "# Simple Page\n\nJust content.",
    });

    const { runRead } = await import("../../cli");
    await runRead("simple");

    // The metadata header should have title and slug but not confidence/tags/authors/expiry
    const headerCall = logSpy.mock.calls[0][0] as string;
    expect(headerCall).toContain("Title:      Simple Page");
    expect(headerCall).toContain("Slug:       simple");
    expect(headerCall).not.toContain("Confidence:");
    expect(headerCall).not.toContain("Tags:");
    expect(headerCall).not.toContain("Authors:");
    expect(headerCall).not.toContain("Expiry:");
  });

  it("runReingest() prints title, source, and expiry on success", async () => {
    const { reingest } = await import("../ingest");
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    vi.mocked(reingest).mockResolvedValueOnce({
      rawPath: "raw/attention-mechanisms.md",
      primarySlug: "attention-mechanisms",
      relatedUpdated: [],
      wikiPages: ["attention-mechanisms"],
      indexUpdated: true,
      sourceUrl: "https://example.com/attention",
    });
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "attention-mechanisms",
      title: "Attention Mechanisms",
      content: "---\ntitle: Attention Mechanisms\nexpiry: 2026-06-01\n---\n\n# Attention Mechanisms",
      path: "/wiki/attention-mechanisms.md",
      frontmatter: { title: "Attention Mechanisms", expiry: "2026-06-01" },
      body: "# Attention Mechanisms",
    });

    const { runReingest } = await import("../../cli");
    await runReingest("attention-mechanisms");

    expect(reingest).toHaveBeenCalledWith("attention-mechanisms");
    expect(logSpy).toHaveBeenCalledWith("Reingest complete: Attention Mechanisms");
    expect(logSpy).toHaveBeenCalledWith("  Source: https://example.com/attention");
    expect(logSpy).toHaveBeenCalledWith("  Expiry: 2026-06-01");
  });

  it("runReingest() omits expiry line when not present", async () => {
    const { reingest } = await import("../ingest");
    const { readWikiPageWithFrontmatter } = await import("../wiki");
    vi.mocked(reingest).mockResolvedValueOnce({
      rawPath: "raw/simple-page.md",
      primarySlug: "simple-page",
      relatedUpdated: [],
      wikiPages: ["simple-page"],
      indexUpdated: true,
      sourceUrl: "https://example.com/simple",
    });
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "simple-page",
      title: "Simple Page",
      content: "---\ntitle: Simple Page\n---\n\n# Simple Page",
      path: "/wiki/simple-page.md",
      frontmatter: { title: "Simple Page" },
      body: "# Simple Page",
    });

    const { runReingest } = await import("../../cli");
    await runReingest("simple-page");

    expect(logSpy).toHaveBeenCalledWith("Reingest complete: Simple Page");
    expect(logSpy).toHaveBeenCalledWith("  Source: https://example.com/simple");
    // Should NOT print expiry line
    const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).not.toContain("Expiry:");
  });

  it("runReingest() propagates error for nonexistent page", async () => {
    const { reingest } = await import("../ingest");
    vi.mocked(reingest).mockRejectedValueOnce(
      new Error('Cannot re-ingest: page "nonexistent" not found'),
    );

    const { runReingest } = await import("../../cli");
    await expect(runReingest("nonexistent")).rejects.toThrow(
      'Cannot re-ingest: page "nonexistent" not found',
    );
  });

  it("runReingest() propagates error for page without source URL", async () => {
    const { reingest } = await import("../ingest");
    vi.mocked(reingest).mockRejectedValueOnce(
      new Error("Cannot re-ingest: no source URL recorded"),
    );

    const { runReingest } = await import("../../cli");
    await expect(runReingest("no-source")).rejects.toThrow(
      "Cannot re-ingest: no source URL recorded",
    );
  });

  // -------------------------------------------------------------------------
  // create command
  // -------------------------------------------------------------------------

  it("runCreate() creates a page and prints result", async () => {
    const { readWikiPage, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPage).mockResolvedValueOnce(null);

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Test Page\n---\nHello world");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("Hello world");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "test-page",
      updatedSlugs: ["related-page"],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("Hello world");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runCreate } = await import("../../cli");
    await runCreate("test-page", "Test Page");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(logSpy).toHaveBeenCalledWith("Created: test-page");
    expect(logSpy).toHaveBeenCalledWith("  Title: Test Page");
    expect(logSpy).toHaveBeenCalledWith("  Cross-referenced: related-page");
  });

  it("runCreate() exits with error when page already exists", async () => {
    const { readWikiPage, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPage).mockResolvedValueOnce({ slug: "existing-page", title: "Existing Page", content: "existing content", path: "wiki/existing-page.md" });

    const { runCreate } = await import("../../cli");
    await expect(runCreate("existing-page", "Existing Page")).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith('Error: page "existing-page" already exists.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  /**
   * Pins the LITERAL at the call site, independent of the behavioural rows in
   * `cli-lifecycle.test.ts`. The conflict guard's `null` is what authorizes the
   * create, so it must neither be served from the ref-counted global
   * `pageCache` (`fresh`, DW-195) nor be a non-ENOENT storage failure flattened
   * into "no page here" (`strict`, DW-378).
   */
  it("runCreate() reads the conflict guard fresh and strict", async () => {
    const { readWikiPage, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPage).mockResolvedValueOnce(null);

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Fresh Page\n---\nBody");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("Body");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "fresh-page",
      updatedSlugs: [],
    });

    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("Body");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runCreate } = await import("../../cli");
    await runCreate("fresh-page", "Fresh Page");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(readWikiPage).toHaveBeenCalledWith("fresh-page", { fresh: true, strict: true });
  });

  it("runCreate() propagates error for invalid slug", async () => {
    const { validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {
      throw new Error('Invalid slug: "BAD SLUG" does not match the safe pattern (lowercase alphanumeric and hyphens, cannot start or end with hyphen)');
    });

    const { runCreate } = await import("../../cli");
    await expect(runCreate("BAD SLUG", "Bad Page")).rejects.toThrow("Invalid slug");
  });

  it("runCreate() exits with error when stdin is empty", async () => {
    const { readWikiPage, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPage).mockResolvedValueOnce(null);

    // Mock empty stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runCreate } = await import("../../cli");
    await expect(runCreate("test-page", "Test Page")).rejects.toThrow("process.exit");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(errorSpy).toHaveBeenCalledWith("Error: no content received on stdin");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("runCreate() passes tags to frontmatter", async () => {
    const { readWikiPage, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPage).mockResolvedValueOnce(null);

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Tagged\n---\nContent");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("Content");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "tagged-page",
      updatedSlugs: [],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("Content");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runCreate } = await import("../../cli");
    await runCreate("tagged-page", "Tagged Page", ["ai", "ml"]);

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    // Verify tags were passed in the frontmatter call
    expect(serializeFrontmatter).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["ai", "ml"] }),
      "Content",
    );
    expect(logSpy).toHaveBeenCalledWith("Created: tagged-page");
  });

  // -------------------------------------------------------------------------
  // update command
  // -------------------------------------------------------------------------

  it("runUpdate() updates a page and prints result", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "test-page",
      title: "Old Title",
      content: "---\ntitle: Old Title\n---\nOld content",
      path: "/wiki/test-page.md",
      frontmatter: { title: "Old Title", tags: ["existing"], confidence: 0.7, updated: "2025-01-01" },
      body: "Old content",
    });

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: New Title\n---\nNew content");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("New content");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "test-page",
      updatedSlugs: ["related-page"],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("New content");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await runUpdate("test-page", "New Title");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(logSpy).toHaveBeenCalledWith("Updated: test-page");
    expect(logSpy).toHaveBeenCalledWith("  Title: New Title");
    expect(logSpy).toHaveBeenCalledWith("  Cross-referenced: related-page");
    expect(writeWikiPageWithSideEffects).toHaveBeenCalledWith(
      expect.objectContaining({ validateNewLinkTargets: true }),
    );
  });

  it("runUpdate() preserves existing title when --title omitted", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "test-page",
      title: "Existing Title",
      content: "---\ntitle: Existing Title\n---\nOld content",
      path: "/wiki/test-page.md",
      frontmatter: { title: "Existing Title", tags: ["tag1"], confidence: 0.5 },
      body: "Old content",
    });

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Existing Title\n---\nUpdated body");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("Updated body");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "test-page",
      updatedSlugs: [],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("Updated body");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await runUpdate("test-page");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(logSpy).toHaveBeenCalledWith("Updated: test-page");
    expect(logSpy).toHaveBeenCalledWith("  Title: Existing Title");
    // Verify frontmatter was called preserving existing tags
    expect(serializeFrontmatter).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Existing Title", tags: ["tag1"] }),
      "Updated body",
    );
  });

  it("runUpdate() preserves existing tags when --tags omitted", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "test-page",
      title: "Page",
      content: "---\ntitle: Page\n---\nContent",
      path: "/wiki/test-page.md",
      frontmatter: { title: "Page", tags: ["keep-me", "also-me"] },
      body: "Content",
    });

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: New Title\n---\nNew body");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("New body");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "test-page",
      updatedSlugs: [],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("New body");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await runUpdate("test-page", "New Title");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    // Verify frontmatter was called preserving existing tags
    expect(serializeFrontmatter).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["keep-me", "also-me"] }),
      "New body",
    );
  });

  it("runUpdate() uses provided --tags over existing", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "test-page",
      title: "Page",
      content: "---\ntitle: Page\n---\nContent",
      path: "/wiki/test-page.md",
      frontmatter: { title: "Page", tags: ["old-tag"] },
      body: "Content",
    });

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Page\n---\nNew body");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("New body");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "test-page",
      updatedSlugs: [],
    });

    // Mock stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("New body");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await runUpdate("test-page", undefined, ["new-tag", "another"]);

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    // Verify frontmatter was called with new tags, not old
    expect(serializeFrontmatter).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["new-tag", "another"] }),
      "New body",
    );
  });

  it("runUpdate() exits with error when page not found", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce(null);

    const { runUpdate } = await import("../../cli");
    await expect(runUpdate("nonexistent-slug")).rejects.toThrow("process.exit");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('page "nonexistent-slug" not found'),
    );
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  /**
   * Pins the LITERAL at the call site. These bytes are the merge base — they
   * become `expectedContent` on the write below — so they must come from
   * storage rather than a superseded entry a bulk scan is holding open
   * (`fresh`, DW-195), and a non-ENOENT blip must not read back as a Page that
   * does not exist (`strict`, DW-378).
   */
  it("runUpdate() reads the merge base fresh and strict", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "fresh-base",
      title: "Fresh Base",
      content: "---\ntitle: Fresh Base\n---\nOld body",
      path: "/wiki/fresh-base.md",
      frontmatter: { title: "Fresh Base" },
      body: "Old body",
    });

    const { serializeFrontmatter } = await import("../frontmatter");
    vi.mocked(serializeFrontmatter).mockReturnValueOnce("---\ntitle: Fresh Base\n---\nNew body");

    const { extractSummary } = await import("../ingest");
    vi.mocked(extractSummary).mockReturnValueOnce("New body");

    const { writeWikiPageWithSideEffects } = await import("../lifecycle");
    vi.mocked(writeWikiPageWithSideEffects).mockResolvedValueOnce({
      slug: "fresh-base",
      updatedSlugs: [],
    });

    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("New body");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await runUpdate("fresh-base");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(readWikiPageWithFrontmatter).toHaveBeenCalledWith("fresh-base", {
      fresh: true,
      strict: true,
    });
  });

  it("runUpdate() exits with error when stdin is empty", async () => {
    const { readWikiPageWithFrontmatter, validateSlug } = await import("../wiki");
    vi.mocked(validateSlug).mockImplementation(() => {});
    vi.mocked(readWikiPageWithFrontmatter).mockResolvedValueOnce({
      slug: "test-page",
      title: "Page",
      content: "---\ntitle: Page\n---\nContent",
      path: "/wiki/test-page.md",
      frontmatter: { title: "Page" },
      body: "Content",
    });

    // Mock empty stdin
    const originalStdin = process.stdin;
    const mockStdin = new (await import("stream")).Readable();
    mockStdin.push("");
    mockStdin.push(null);
    Object.defineProperty(process, "stdin", { value: mockStdin, writable: true });

    const { runUpdate } = await import("../../cli");
    await expect(runUpdate("test-page")).rejects.toThrow("process.exit");

    Object.defineProperty(process, "stdin", { value: originalStdin, writable: true });

    expect(errorSpy).toHaveBeenCalledWith("Error: no content received on stdin");
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("runDelete() prints deletion result with backlinks", async () => {
    const { deleteWikiPage } = await import("../lifecycle");
    vi.mocked(deleteWikiPage).mockResolvedValueOnce({
      slug: "old-page",
      removedFromIndex: true,
      strippedBacklinksFrom: ["page-a", "page-b"],
    });

    const { runDelete } = await import("../../cli");
    await runDelete("old-page");

    expect(logSpy).toHaveBeenCalledWith("Deleted: old-page");
    expect(logSpy).toHaveBeenCalledWith("  Removed from index");
    expect(logSpy).toHaveBeenCalledWith("  Stripped backlinks from: page-a, page-b");
  });

  it("runDelete() prints minimal output when no backlinks stripped", async () => {
    const { deleteWikiPage } = await import("../lifecycle");
    vi.mocked(deleteWikiPage).mockResolvedValueOnce({
      slug: "simple-page",
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    });

    const { runDelete } = await import("../../cli");
    await runDelete("simple-page");

    expect(logSpy).toHaveBeenCalledWith("Deleted: simple-page");
    expect(logSpy).toHaveBeenCalledWith("  Removed from index");
    const allOutput = logSpy.mock.calls.map((c) => c[0]).join("\n");
    expect(allOutput).not.toContain("Stripped backlinks");
  });

  it("runDelete() propagates error for nonexistent page", async () => {
    const { deleteWikiPage } = await import("../lifecycle");
    vi.mocked(deleteWikiPage).mockRejectedValueOnce(
      new Error("page not found: nonexistent"),
    );

    const { runDelete } = await import("../../cli");
    await expect(runDelete("nonexistent")).rejects.toThrow(
      "page not found: nonexistent",
    );
  });
});
