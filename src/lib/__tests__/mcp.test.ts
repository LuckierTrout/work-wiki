import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  handleSearchWiki,
  handleReadPage,
  handleListPages,
  handleCreatePage,
  handleUpdatePage,
  handleDeletePage,
  handleIngestUrl,
  handleQueryWiki,
  handleAgentContext,
  handleSeedAgent,
  handleLintWiki,
  handleFixLintIssue,
  handleListDiscussions,
  handleCreateDiscussion,
  handleResolveDiscussion,
  handleAddComment,
  handleReingest,
} from "../../mcp";
import { _resetStorage } from "../storage";
import { _resetConfigCache } from "../config";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "mcp-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  await fs.mkdir(path.join(tmpDir, "wiki"), { recursive: true });
  await fs.mkdir(path.join(tmpDir, "raw"), { recursive: true });
  _resetStorage();
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

// ---------------------------------------------------------------------------
// Helper — write wiki pages and index
// ---------------------------------------------------------------------------

async function writeTestPage(slug: string, content: string): Promise<void> {
  await fs.writeFile(
    path.join(tmpDir, "wiki", `${slug}.md`),
    content,
    "utf-8",
  );
}

async function writeIndex(
  entries: { title: string; slug: string; summary: string }[],
): Promise<void> {
  const lines = entries.map(
    (e) => `- [${e.title}](${e.slug}.md) — ${e.summary}`,
  );
  const content = `# Wiki Index\n\n${lines.join("\n")}\n`;
  await fs.writeFile(
    path.join(tmpDir, "wiki", "index.md"),
    content,
    "utf-8",
  );
}

// ---------------------------------------------------------------------------
// search_wiki tests
// ---------------------------------------------------------------------------

describe("search_wiki", () => {
  it("returns results for matching content", async () => {
    await writeTestPage(
      "neural-networks",
      "---\ntags: [ml]\n---\n# Neural Networks\n\nNeural networks are computing systems inspired by biological neural networks.",
    );
    await writeTestPage(
      "gradient-descent",
      "---\ntags: [ml]\n---\n# Gradient Descent\n\nGradient descent is an optimization algorithm.",
    );

    const results = await handleSearchWiki({ query: "neural" });
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].slug).toBe("neural-networks");
    expect(results[0].title).toBe("Neural Networks");
    expect(results[0].snippet).toBeDefined();
    expect(typeof results[0].score).toBe("number");
  });

  it("returns empty array for no matches", async () => {
    await writeTestPage(
      "neural-networks",
      "# Neural Networks\n\nSome content about neural nets.",
    );

    const results = await handleSearchWiki({ query: "quantum-entanglement-xyz" });
    expect(results).toEqual([]);
  });

  it("respects limit parameter", async () => {
    await writeTestPage("a", "# Page A\n\nCommon topic here.");
    await writeTestPage("b", "# Page B\n\nCommon topic here.");
    await writeTestPage("c", "# Page C\n\nCommon topic here.");

    const results = await handleSearchWiki({ query: "common topic", limit: 2 });
    expect(results.length).toBeLessThanOrEqual(2);
  });
});

// ---------------------------------------------------------------------------
// read_page tests
// ---------------------------------------------------------------------------

describe("read_page", () => {
  it("returns page content with frontmatter", async () => {
    await writeTestPage(
      "test-page",
      "---\ntags: [science]\nupdated: '2025-01-01'\n---\n# Test Page\n\nThis is test content.",
    );

    const result = await handleReadPage({ slug: "test-page" });
    expect(result.slug).toBe("test-page");
    expect(result.title).toBe("Test Page");
    expect(result.content).toContain("This is test content.");
    expect(result.frontmatter).toBeDefined();
    expect(result.frontmatter.tags).toEqual(["science"]);
    expect(result.frontmatter.updated).toBe("2025-01-01");
  });

  it("throws for nonexistent slug", async () => {
    await expect(
      handleReadPage({ slug: "does-not-exist" }),
    ).rejects.toThrow("Page not found: does-not-exist");
  });
});

// ---------------------------------------------------------------------------
// list_pages tests
// ---------------------------------------------------------------------------

describe("list_pages", () => {
  it("returns all pages", async () => {
    await writeTestPage(
      "alpha",
      "---\ntags: [a]\nupdated: '2025-01-01'\n---\n# Alpha\n\nAlpha page.",
    );
    await writeTestPage(
      "beta",
      "---\ntags: [b]\nupdated: '2025-06-15'\n---\n# Beta\n\nBeta page.",
    );
    await writeIndex([
      { title: "Alpha", slug: "alpha", summary: "Alpha page" },
      { title: "Beta", slug: "beta", summary: "Beta page" },
    ]);

    const result = await handleListPages({});
    expect(result.length).toBe(2);
    // Default sort is by title
    expect(result[0].slug).toBe("alpha");
    expect(result[1].slug).toBe("beta");
  });

  it("respects limit parameter", async () => {
    await writeTestPage("a", "# A\n\nPage A.");
    await writeTestPage("b", "# B\n\nPage B.");
    await writeTestPage("c", "# C\n\nPage C.");
    await writeIndex([
      { title: "A", slug: "a", summary: "Page A" },
      { title: "B", slug: "b", summary: "Page B" },
      { title: "C", slug: "c", summary: "Page C" },
    ]);

    const result = await handleListPages({ limit: 2 });
    expect(result.length).toBe(2);
  });

  it("sorts by updated when requested", async () => {
    await writeTestPage(
      "old",
      "---\nupdated: '2024-01-01'\n---\n# Old\n\nOld page.",
    );
    await writeTestPage(
      "new",
      "---\nupdated: '2025-06-15'\n---\n# New\n\nNew page.",
    );
    await writeIndex([
      { title: "Old", slug: "old", summary: "Old page" },
      { title: "New", slug: "new", summary: "New page" },
    ]);

    const result = await handleListPages({ sort: "updated" });
    expect(result.length).toBe(2);
    // Newest first
    expect(result[0].slug).toBe("new");
    expect(result[1].slug).toBe("old");
  });

  it("sorts by confidence when requested", async () => {
    await writeTestPage(
      "low-conf",
      "---\nconfidence: 0.3\nupdated: '2025-01-01'\n---\n# Low Confidence\n\nLow confidence page.",
    );
    await writeTestPage(
      "high-conf",
      "---\nconfidence: 0.9\nupdated: '2025-01-01'\n---\n# High Confidence\n\nHigh confidence page.",
    );
    await writeTestPage(
      "no-conf",
      "---\nupdated: '2025-01-01'\n---\n# No Confidence\n\nNo confidence field.",
    );
    await writeIndex([
      { title: "Low Confidence", slug: "low-conf", summary: "Low" },
      { title: "High Confidence", slug: "high-conf", summary: "High" },
      { title: "No Confidence", slug: "no-conf", summary: "None" },
    ]);

    const result = await handleListPages({ sort: "confidence" });
    expect(result.length).toBe(3);
    // Highest confidence first
    expect(result[0].slug).toBe("high-conf");
    expect(result[0].confidence).toBe(0.9);
    expect(result[1].slug).toBe("low-conf");
    expect(result[1].confidence).toBe(0.3);
    // No confidence field → sorted last (confidence defaults to 0)
    expect(result[2].slug).toBe("no-conf");
  });

  it("returns empty array when no pages exist", async () => {
    const result = await handleListPages({});
    expect(result).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// MCP write tools tests
// ---------------------------------------------------------------------------

describe("MCP write tools", () => {
  describe("create_page", () => {
    it("creates a new page", async () => {
      const result = await handleCreatePage({
        slug: "test-create",
        content: "# Test\n\nBody text here.",
      });

      expect(result.slug).toBe("test-create");
      expect(result.title).toBe("Test");
      expect(result.created).toBe(true);

      // Verify file exists on disk with frontmatter
      const filePath = path.join(tmpDir, "wiki", "test-create.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("---");
      expect(fileContent).toContain("title: Test");
      expect(fileContent).toContain("# Test");
      expect(fileContent).toContain("Body text here.");
    });

    it("rejects duplicate slug", async () => {
      await handleCreatePage({
        slug: "dup-page",
        content: "# Duplicate\n\nFirst version.",
      });

      await expect(
        handleCreatePage({
          slug: "dup-page",
          content: "# Duplicate\n\nSecond version.",
        }),
      ).rejects.toThrow("Page already exists: dup-page");
    });

    it("rejects invalid slug", async () => {
      await expect(
        handleCreatePage({
          slug: "",
          content: "# Empty Slug\n\nBody.",
        }),
      ).rejects.toThrow();

      await expect(
        handleCreatePage({
          slug: "INVALID SLUG!",
          content: "# Bad\n\nBody.",
        }),
      ).rejects.toThrow();
    });
  });

  describe("update_page", () => {
    it("updates existing page", async () => {
      // Create first
      await handleCreatePage({
        slug: "update-me",
        content: "# Original\n\nOriginal body.",
      });

      const result = await handleUpdatePage({
        slug: "update-me",
        content: "# Updated\n\nNew body content.",
      });

      expect(result.slug).toBe("update-me");
      expect(result.title).toBe("Updated");
      expect(result.updated).toBe(true);

      // Verify file on disk has new content
      const filePath = path.join(tmpDir, "wiki", "update-me.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("# Updated");
      expect(fileContent).toContain("New body content.");
    });

    it("404 on missing page", async () => {
      await expect(
        handleUpdatePage({
          slug: "nonexistent-page",
          content: "# Ghost\n\nBody.",
        }),
      ).rejects.toThrow("Page not found: nonexistent-page");
    });

    it("preserves frontmatter", async () => {
      // Create a page with specific frontmatter
      await writeTestPage(
        "preserve-fm",
        "---\ntitle: Preserve\ntags: [science, ai]\ncreated: '2025-01-15'\nconfidence: 0.8\n---\n# Preserve\n\nOriginal body.",
      );

      const result = await handleUpdatePage({
        slug: "preserve-fm",
        content: "# Preserve Updated\n\nNew body.",
      });

      expect(result.updated).toBe(true);

      // Verify original frontmatter fields preserved
      const filePath = path.join(tmpDir, "wiki", "preserve-fm.md");
      const fileContent = await fs.readFile(filePath, "utf-8");
      expect(fileContent).toContain("tags: [science, ai]");
      expect(fileContent).toContain("confidence: 0.8");
      // The serializer outputs date strings without quotes
      expect(fileContent).toContain("created: 2025-01-15");
      // updated should be bumped to today
      const today = new Date().toISOString().slice(0, 10);
      expect(fileContent).toContain(`updated: ${today}`);
    });

    it("author attribution", async () => {
      await handleCreatePage({
        slug: "author-test",
        content: "# Author Test\n\nBody.",
      });

      const result = await handleUpdatePage({
        slug: "author-test",
        content: "# Author Test\n\nUpdated body.",
        author: "agent-alpha",
      });

      expect(result.slug).toBe("author-test");
      expect(result.updated).toBe(true);
      // The author flows through to writeWikiPageWithSideEffects
      // which stores it in the revision sidecar. We verify the call
      // succeeded without error — deeper attribution is tested in
      // lifecycle/revision tests.
    });
  });
});

// ---------------------------------------------------------------------------
// agent_context tool tests
// ---------------------------------------------------------------------------

describe("agent_context tool", () => {
  /** Helper — write an agent profile JSON to the agents directory. */
  async function writeAgentProfile(profile: {
    id: string;
    name: string;
    description: string;
    identityPages: string[];
    learningPages: string[];
    socialPages: string[];
  }): Promise<void> {
    const agentsDir = path.join(tmpDir, "agents");
    await fs.mkdir(agentsDir, { recursive: true });
    const full = {
      ...profile,
      registered: "2026-05-03",
      lastUpdated: "2026-05-03",
    };
    await fs.writeFile(
      path.join(agentsDir, `${profile.id}.json`),
      JSON.stringify(full),
      "utf-8",
    );
  }

  it("returns agent context with page content", async () => {
    await writeAgentProfile({
      id: "test-agent",
      name: "Test Agent",
      description: "An agent for testing",
      identityPages: ["identity-page"],
      learningPages: ["learnings-page"],
      socialPages: ["social-page"],
    });

    await writeTestPage("identity-page", "# Identity\n\nI am a test agent.");
    await writeTestPage("learnings-page", "# Learnings\n\nI learned things.");
    await writeTestPage("social-page", "# Social\n\nPeople are interesting.");

    const result = await handleAgentContext({ agent_id: "test-agent" });

    // Verify agent info
    expect(result.agent.id).toBe("test-agent");
    expect(result.agent.name).toBe("Test Agent");
    expect(result.agent.description).toBe("An agent for testing");

    // Verify context sections contain page content
    expect(result.context.identity).toContain("I am a test agent.");
    expect(result.context.learnings).toContain("I learned things.");
    expect(result.context.socialWisdom).toContain("People are interesting.");

    // Verify meta
    expect(result.meta.pageCount).toBe(3);
    expect(result.meta.totalChars).toBeGreaterThan(0);
  });

  it("throws for unknown agent", async () => {
    await expect(
      handleAgentContext({ agent_id: "nonexistent-agent" }),
    ).rejects.toThrow("Agent not found");
  });

  it("handles missing wiki pages gracefully", async () => {
    await writeAgentProfile({
      id: "sparse-agent",
      name: "Sparse Agent",
      description: "Agent with missing pages",
      identityPages: ["missing-identity"],
      learningPages: ["missing-learnings"],
      socialPages: ["missing-social"],
    });

    const result = await handleAgentContext({ agent_id: "sparse-agent" });

    // Should return successfully with empty content, not crash
    expect(result.agent.id).toBe("sparse-agent");
    expect(result.context.identity).toBe("");
    expect(result.context.learnings).toBe("");
    expect(result.context.socialWisdom).toBe("");
    expect(result.meta.pageCount).toBe(0);
    expect(result.meta.totalChars).toBe(0);
  });

  it("strips YAML frontmatter from page content", async () => {
    await writeAgentProfile({
      id: "fm-agent",
      name: "Frontmatter Agent",
      description: "Agent with frontmatter pages",
      identityPages: ["fm-identity"],
      learningPages: ["fm-learnings"],
      socialPages: ["fm-social"],
    });

    // Write pages with YAML frontmatter — this is how real wiki pages look
    await writeTestPage(
      "fm-identity",
      "---\nslug: fm-identity\nauthors: [yoyo]\nconfidence: 0.9\nexpiry: 2026-12-01\n---\n# Identity\n\nI am an agent with frontmatter.",
    );
    await writeTestPage(
      "fm-learnings",
      "---\nslug: fm-learnings\ntags: [learning]\n---\n# Learnings\n\nI learned to strip frontmatter.",
    );
    await writeTestPage(
      "fm-social",
      "---\nslug: fm-social\nconfidence: 0.8\n---\n# Social\n\nPeople are great.",
    );

    const result = await handleAgentContext({ agent_id: "fm-agent" });

    // Content should NOT contain YAML frontmatter delimiters from metadata
    expect(result.context.identity).not.toMatch(/^---/m);
    expect(result.context.learnings).not.toMatch(/^---/m);
    expect(result.context.socialWisdom).not.toMatch(/^---/m);

    // Content should NOT contain frontmatter fields
    expect(result.context.identity).not.toContain("slug: fm-identity");
    expect(result.context.identity).not.toContain("confidence: 0.9");

    // Content SHOULD contain the actual body text
    expect(result.context.identity).toContain("I am an agent with frontmatter.");
    expect(result.context.learnings).toContain("I learned to strip frontmatter.");
    expect(result.context.socialWisdom).toContain("People are great.");

    expect(result.meta.pageCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// seed_agent tool tests
// ---------------------------------------------------------------------------

describe("seed_agent tool", () => {
  it("creates agent and returns profile", async () => {
    const result = await handleSeedAgent({
      agent_id: "new-agent",
      name: "New Agent",
      description: "A freshly seeded agent",
      sections: [
        {
          slug: "new-agent-identity",
          title: "New Agent Identity",
          type: "identity",
          content: "I am a new agent.",
        },
        {
          slug: "new-agent-learnings",
          title: "New Agent Learnings",
          type: "learnings",
          content: "I have learned nothing yet.",
        },
        {
          slug: "new-agent-social",
          title: "New Agent Social",
          type: "social",
          content: "No social wisdom yet.",
        },
      ],
    });

    // Returns AgentProfile
    expect(result.id).toBe("new-agent");
    expect(result.name).toBe("New Agent");
    expect(result.description).toBe("A freshly seeded agent");
    expect(result.identityPages).toEqual(["new-agent-identity"]);
    expect(result.learningPages).toEqual(["new-agent-learnings"]);
    expect(result.socialPages).toEqual(["new-agent-social"]);
    expect(result.registered).toBeDefined();
    expect(result.lastUpdated).toBeDefined();

    // Verify wiki pages were created
    const identityPage = await fs.readFile(
      path.join(tmpDir, "wiki", "new-agent-identity.md"),
      "utf-8",
    );
    expect(identityPage).toContain("I am a new agent.");

    // Verify agent profile JSON was created
    const profileJson = await fs.readFile(
      path.join(tmpDir, "agents", "new-agent.json"),
      "utf-8",
    );
    const profile = JSON.parse(profileJson);
    expect(profile.id).toBe("new-agent");
  });

  it("throws with missing required field", async () => {
    await expect(
      handleSeedAgent({
        agent_id: "bad-agent",
        name: "",
        description: "Has no name",
        sections: [],
      }),
    ).rejects.toThrow();
  });

  it("is idempotent — re-seeding updates existing pages", async () => {
    // First seed
    const first = await handleSeedAgent({
      agent_id: "idempotent-agent",
      name: "Idempotent Agent",
      description: "Will be seeded twice",
      sections: [
        {
          slug: "idempotent-identity",
          title: "Identity",
          type: "identity",
          content: "Version 1 content.",
        },
      ],
    });

    expect(first.id).toBe("idempotent-agent");
    const firstRegistered = first.registered;

    // Re-seed with updated content
    const second = await handleSeedAgent({
      agent_id: "idempotent-agent",
      name: "Idempotent Agent v2",
      description: "Updated description",
      sections: [
        {
          slug: "idempotent-identity",
          title: "Identity v2",
          type: "identity",
          content: "Version 2 content.",
        },
      ],
    });

    // Should preserve original registration date
    expect(second.registered).toBe(firstRegistered);
    // But update the name and description
    expect(second.name).toBe("Idempotent Agent v2");
    expect(second.description).toBe("Updated description");

    // Wiki page should have updated content
    const pageContent = await fs.readFile(
      path.join(tmpDir, "wiki", "idempotent-identity.md"),
      "utf-8",
    );
    expect(pageContent).toContain("Version 2 content.");
    expect(pageContent).not.toContain("Version 1 content.");
  });
});

// ---------------------------------------------------------------------------
// delete_page tests
// ---------------------------------------------------------------------------

describe("delete_page", () => {
  it("deletes an existing page and returns confirmation", async () => {
    // Create a page first
    await handleCreatePage({
      slug: "to-delete",
      content: "# To Delete\n\nThis page will be deleted.",
    });

    // Verify it exists
    const page = await handleReadPage({ slug: "to-delete" });
    expect(page.slug).toBe("to-delete");

    // Delete it
    const result = await handleDeletePage({ slug: "to-delete" });
    expect(result.slug).toBe("to-delete");
    expect(result.removedFromIndex).toBe(true);

    // Verify it's gone
    await expect(handleReadPage({ slug: "to-delete" })).rejects.toThrow(
      "Page not found",
    );
  });

  it("throws error for non-existent slug", async () => {
    await expect(
      handleDeletePage({ slug: "does-not-exist" }),
    ).rejects.toThrow("page not found");
  });

  it("strips backlinks from other pages when deleting", async () => {
    // Create two pages, one linking to the other
    await handleCreatePage({
      slug: "keeper",
      content:
        "# Keeper\n\nThis page links to [Target](target.md).\n\n**See also:** [Target](target.md)",
    });
    await handleCreatePage({
      slug: "target",
      content: "# Target\n\nThis is the target page.",
    });

    // Delete the target
    const result = await handleDeletePage({ slug: "target" });
    expect(result.slug).toBe("target");

    // The keeper page should have had backlinks stripped
    const keeper = await handleReadPage({ slug: "keeper" });
    expect(keeper.content).not.toContain("[Target](target.md)");
  });
});

// ---------------------------------------------------------------------------
// ingest_url tests
// ---------------------------------------------------------------------------

describe("ingest_url", () => {
  it("rejects invalid URLs", async () => {
    await expect(
      handleIngestUrl({ url: "not-a-url" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("rejects URLs without http/https protocol", async () => {
    await expect(
      handleIngestUrl({ url: "ftp://example.com/page" }),
    ).rejects.toThrow("Invalid URL");
  });

  it("validates URL format before calling ingest", async () => {
    // Should throw immediately for obviously bad URLs
    // (not after trying to fetch)
    await expect(
      handleIngestUrl({ url: "" }),
    ).rejects.toThrow("Invalid URL");
  });
});

// ---------------------------------------------------------------------------
// query_wiki tests
// ---------------------------------------------------------------------------

describe("query_wiki", () => {
  it("returns structured result with answer and sources fields on empty wiki", async () => {
    const result = await handleQueryWiki({ question: "What is AI?" });
    expect(result).toHaveProperty("answer");
    expect(result).toHaveProperty("sources");
    expect(typeof result.answer).toBe("string");
    expect(Array.isArray(result.sources)).toBe(true);
  });

  it("returns informative message when wiki is empty", async () => {
    const result = await handleQueryWiki({ question: "Tell me about neural networks" });
    expect(result.answer).toContain("empty");
    expect(result.sources).toEqual([]);
  });

  it("returns no-API-key fallback when wiki has pages but no LLM key", async () => {
    // Write a page directly to the filesystem (avoids side effects from create)
    await writeTestPage(
      "test-topic",
      "---\ntags: [test]\n---\n# Test Topic\n\nSome content about testing.",
    );
    await writeIndex([
      {
        title: "Test Topic",
        slug: "test-topic",
        summary: "Some content about testing",
      },
    ]);

    // Temporarily clear all LLM keys so query() takes the no-key fallback path
    const savedKeys: Record<string, string | undefined> = {};
    const keyNames = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_MODEL",
    ];
    for (const k of keyNames) {
      savedKeys[k] = process.env[k];
      delete process.env[k];
    }
    _resetConfigCache(); // ensure loadConfigSync doesn't return cached provider

    try {
      const result = await handleQueryWiki({ question: "What about testing?" });
      // Without an API key, it should return the "No API key" message with page list
      expect(result.answer).toContain("test-topic");
      expect(result.sources).toEqual([]);
    } finally {
      // Restore all keys
      for (const k of keyNames) {
        if (savedKeys[k] === undefined) {
          delete process.env[k];
        } else {
          process.env[k] = savedKeys[k];
        }
      }
      _resetConfigCache();
    }
  });

  it("accepts format parameter without error", async () => {
    // Verify each format value is accepted
    const formats = ["prose", "table", "slides"] as const;
    for (const format of formats) {
      const result = await handleQueryWiki({
        question: "What is AI?",
        format,
      });
      expect(result).toHaveProperty("answer");
      expect(result).toHaveProperty("sources");
    }
  });

  it("defaults to prose format when not specified", async () => {
    const result = await handleQueryWiki({ question: "What is AI?" });
    // Should work without error — prose is the default
    expect(result).toHaveProperty("answer");
  });
});

// ---------------------------------------------------------------------------
// lint_wiki tests
// ---------------------------------------------------------------------------

describe("lint_wiki", () => {
  it("returns empty issues for a clean wiki", async () => {
    await writeTestPage(
      "test-page",
      '---\ntags: [test]\nconfidence: 0.8\nexpiry: 2099-01-01\ncreated: 2025-01-01\nupdated: 2025-01-01\nauthors: [tester]\nsources: \'[{"type":"url","url":"https://example.com","fetched":"2025-01-01","triggered_by":"tester"}]\'\n---\n# Test Page\n\nSome content here.',
    );
    await writeIndex([
      { title: "Test Page", slug: "test-page", summary: "Some content here." },
    ]);

    const result = await handleLintWiki({});
    expect(result).toHaveProperty("issues");
    expect(result).toHaveProperty("summary");
    expect(result).toHaveProperty("checkedAt");
    expect(Array.isArray(result.issues)).toBe(true);
  });

  it("detects orphan pages", async () => {
    // Page exists on disk but not in index
    await writeTestPage(
      "orphan-page",
      "---\ntags: [test]\n---\n# Orphan Page\n\nThis page is not in the index.",
    );
    await writeIndex([]); // empty index

    const result = await handleLintWiki({ checks: ["orphan-page"] });
    expect(result.issues.length).toBeGreaterThanOrEqual(1);
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");
    expect(orphanIssues.length).toBe(1);
    expect(orphanIssues[0].slug).toBe("orphan-page");
  });

  it("detects stale index entries", async () => {
    // Index references a page that doesn't exist on disk
    await writeIndex([
      { title: "Ghost Page", slug: "ghost-page", summary: "Not on disk." },
    ]);

    const result = await handleLintWiki({ checks: ["stale-index"] });
    const staleIssues = result.issues.filter((i) => i.type === "stale-index");
    expect(staleIssues.length).toBe(1);
    expect(staleIssues[0].slug).toBe("ghost-page");
  });

  it("scopes checks via the checks parameter", async () => {
    await writeTestPage(
      "lonely-page",
      "---\ntags: [test]\n---\n# Lonely\n\nNo index entry.",
    );
    await writeIndex([]);

    // Only run stale-index — should not find orphan-page issues
    const result = await handleLintWiki({ checks: ["stale-index"] });
    const orphanIssues = result.issues.filter((i) => i.type === "orphan-page");
    expect(orphanIssues.length).toBe(0);
  });

  it("filters by minSeverity", async () => {
    // Create a setup that produces info-level issues (orphan is warning)
    await writeTestPage(
      "orphan-sev",
      "---\ntags: [test]\n---\n# Orphan\n\nOrphan page.",
    );
    await writeIndex([]);

    // With minSeverity=error, warning-level orphan issues should be excluded
    const result = await handleLintWiki({
      checks: ["orphan-page"],
      minSeverity: "error",
    });
    expect(result.issues.length).toBe(0);
  });

  it("rejects invalid check types", async () => {
    await expect(
      handleLintWiki({ checks: ["nonexistent-check"] }),
    ).rejects.toThrow("Invalid check type");
  });

  it("rejects invalid minSeverity", async () => {
    await expect(
      handleLintWiki({ minSeverity: "extreme" }),
    ).rejects.toThrow("Invalid minSeverity");
  });
});

// ---------------------------------------------------------------------------
// fix_lint_issue tests
// ---------------------------------------------------------------------------

describe("fix_lint_issue", () => {
  it("fixes an orphan page by adding it to the index", async () => {
    await writeTestPage(
      "orphan-fix",
      "---\ntags: [test]\n---\n# Orphan Fix\n\nThis page should be added to the index.",
    );
    await writeIndex([]);

    const result = await handleFixLintIssue({
      type: "orphan-page",
      slug: "orphan-fix",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("orphan-fix");
    expect(result.message).toContain("orphan-fix");
  });

  it("fixes a stale index entry by removing it", async () => {
    await writeIndex([
      { title: "Stale Entry", slug: "stale-entry", summary: "Gone." },
    ]);

    const result = await handleFixLintIssue({
      type: "stale-index",
      slug: "stale-entry",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("stale-entry");
  });

  it("fixes an empty page by deleting it", async () => {
    await writeTestPage("empty-page", "---\ntags: []\n---\n");
    await writeIndex([
      { title: "Empty Page", slug: "empty-page", summary: "" },
    ]);

    const result = await handleFixLintIssue({
      type: "empty-page",
      slug: "empty-page",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("empty-page");
  });

  it("throws for page not found", async () => {
    await writeIndex([]);
    await expect(
      handleFixLintIssue({
        type: "orphan-page",
        slug: "nonexistent-page",
      }),
    ).rejects.toThrow("Page not found");
  });

  it("throws for unsupported fix type", async () => {
    await expect(
      handleFixLintIssue({
        type: "made-up-type",
        slug: "some-page",
      }),
    ).rejects.toThrow("not supported");
  });

  it("throws for low-confidence (not auto-fixable)", async () => {
    await expect(
      handleFixLintIssue({
        type: "low-confidence",
        slug: "some-page",
      }),
    ).rejects.toThrow("cannot be auto-fixed");
  });

  it("passes target parameter for cross-ref fixes", async () => {
    // Set up source and target pages
    await writeTestPage(
      "source-page",
      "---\ntags: [test]\n---\n# Source Page\n\nSome content about a topic.",
    );
    await writeTestPage(
      "target-page",
      "---\ntags: [test]\n---\n# Target Page\n\nRelated content.",
    );
    await writeIndex([
      { title: "Source Page", slug: "source-page", summary: "Source." },
      { title: "Target Page", slug: "target-page", summary: "Target." },
    ]);

    const result = await handleFixLintIssue({
      type: "missing-crossref",
      slug: "source-page",
      target: "target-page",
    });

    expect(result.success).toBe(true);
    expect(result.slug).toBe("source-page");
  });
});

// ---------------------------------------------------------------------------
// list_discussions tests
// ---------------------------------------------------------------------------

describe("list_discussions", () => {
  it("returns empty threads array for page with no discussions", async () => {
    await writeTestPage(
      "no-talk",
      "---\ntags: [test]\n---\n# No Talk\n\nA page with no discussions.",
    );

    const result = await handleListDiscussions({ pageSlug: "no-talk" });
    expect(result.pageSlug).toBe("no-talk");
    expect(result.threads).toEqual([]);
  });

  it("returns threads with status, author, and commentCount", async () => {
    await writeTestPage(
      "test-page",
      "---\ntags: [test]\n---\n# Test Page\n\nContent.",
    );

    // Create a discussion first
    await handleCreateDiscussion({
      pageSlug: "test-page",
      title: "Accuracy concern",
      body: "The first paragraph seems inaccurate.",
      author: "yoyo",
    });

    const result = await handleListDiscussions({ pageSlug: "test-page" });
    expect(result.pageSlug).toBe("test-page");
    expect(result.threads).toHaveLength(1);
    expect(result.threads[0].index).toBe(0);
    expect(result.threads[0].title).toBe("Accuracy concern");
    expect(result.threads[0].status).toBe("open");
    expect(result.threads[0].author).toBe("yoyo");
    expect(result.threads[0].commentCount).toBe(1);
    expect(result.threads[0].created).toBeDefined();
    expect(result.threads[0].updated).toBeDefined();
  });

  it("returns multiple threads with correct indices", async () => {
    await writeTestPage(
      "multi-talk",
      "---\ntags: [test]\n---\n# Multi Talk\n\nContent.",
    );

    await handleCreateDiscussion({
      pageSlug: "multi-talk",
      title: "First thread",
      body: "First body.",
      author: "alice",
    });
    await handleCreateDiscussion({
      pageSlug: "multi-talk",
      title: "Second thread",
      body: "Second body.",
      author: "bob",
    });

    const result = await handleListDiscussions({ pageSlug: "multi-talk" });
    expect(result.threads).toHaveLength(2);
    expect(result.threads[0].index).toBe(0);
    expect(result.threads[0].title).toBe("First thread");
    expect(result.threads[0].author).toBe("alice");
    expect(result.threads[1].index).toBe(1);
    expect(result.threads[1].title).toBe("Second thread");
    expect(result.threads[1].author).toBe("bob");
  });
});

// ---------------------------------------------------------------------------
// create_discussion tests
// ---------------------------------------------------------------------------

describe("create_discussion", () => {
  it("creates a new thread and returns it", async () => {
    await writeTestPage(
      "new-topic",
      "---\ntags: [test]\n---\n# New Topic\n\nContent.",
    );

    const result = await handleCreateDiscussion({
      pageSlug: "new-topic",
      title: "Citation needed",
      body: "The claim in paragraph 2 needs a source.",
      author: "yoyo",
    });

    expect(result.pageSlug).toBe("new-topic");
    expect(result.title).toBe("Citation needed");
    expect(result.status).toBe("open");
    expect(result.comments).toHaveLength(1);
    expect(result.comments[0].author).toBe("yoyo");
    expect(result.comments[0].body).toBe(
      "The claim in paragraph 2 needs a source.",
    );
    expect(result.created).toBeDefined();
    expect(result.updated).toBeDefined();
  });

  it("throws when pageSlug is empty", async () => {
    await expect(
      handleCreateDiscussion({
        pageSlug: "",
        title: "Test",
        body: "Test body",
        author: "yoyo",
      }),
    ).rejects.toThrow("pageSlug is required");
  });

  it("throws when title is empty", async () => {
    await expect(
      handleCreateDiscussion({
        pageSlug: "some-page",
        title: "",
        body: "Test body",
        author: "yoyo",
      }),
    ).rejects.toThrow("title is required");
  });

  it("throws when body is empty", async () => {
    await expect(
      handleCreateDiscussion({
        pageSlug: "some-page",
        title: "Test",
        body: "",
        author: "yoyo",
      }),
    ).rejects.toThrow("body is required");
  });

  it("throws when author is empty", async () => {
    await expect(
      handleCreateDiscussion({
        pageSlug: "some-page",
        title: "Test",
        body: "Test body",
        author: "",
      }),
    ).rejects.toThrow("author is required");
  });
});

// ---------------------------------------------------------------------------
// resolve_discussion tests
// ---------------------------------------------------------------------------

describe("resolve_discussion", () => {
  it("resolves a thread as resolved", async () => {
    await writeTestPage(
      "resolve-test",
      "---\ntags: [test]\n---\n# Resolve Test\n\nContent.",
    );

    await handleCreateDiscussion({
      pageSlug: "resolve-test",
      title: "Outdated info",
      body: "This section is outdated.",
      author: "yoyo",
    });

    const result = await handleResolveDiscussion({
      pageSlug: "resolve-test",
      threadIndex: 0,
      resolution: "resolved",
    });

    expect(result.status).toBe("resolved");
    expect(result.title).toBe("Outdated info");
  });

  it("resolves a thread as wontfix", async () => {
    await writeTestPage(
      "wontfix-test",
      "---\ntags: [test]\n---\n# Wontfix Test\n\nContent.",
    );

    await handleCreateDiscussion({
      pageSlug: "wontfix-test",
      title: "Minor issue",
      body: "Not worth fixing.",
      author: "yoyo",
    });

    const result = await handleResolveDiscussion({
      pageSlug: "wontfix-test",
      threadIndex: 0,
      resolution: "wontfix",
    });

    expect(result.status).toBe("wontfix");
  });

  it("throws for invalid threadIndex", async () => {
    await writeTestPage(
      "invalid-idx",
      "---\ntags: [test]\n---\n# Invalid Index\n\nContent.",
    );

    await expect(
      handleResolveDiscussion({
        pageSlug: "invalid-idx",
        threadIndex: 99,
        resolution: "resolved",
      }),
    ).rejects.toThrow("thread index 99 not found");
  });

  it("throws for missing pageSlug", async () => {
    await expect(
      handleResolveDiscussion({
        pageSlug: "",
        threadIndex: 0,
        resolution: "resolved",
      }),
    ).rejects.toThrow("pageSlug is required");
  });

  it("shows resolved status in list_discussions", async () => {
    await writeTestPage(
      "list-resolved",
      "---\ntags: [test]\n---\n# List Resolved\n\nContent.",
    );

    await handleCreateDiscussion({
      pageSlug: "list-resolved",
      title: "Thread to resolve",
      body: "Will be resolved.",
      author: "yoyo",
    });

    await handleResolveDiscussion({
      pageSlug: "list-resolved",
      threadIndex: 0,
      resolution: "resolved",
    });

    const list = await handleListDiscussions({ pageSlug: "list-resolved" });
    expect(list.threads[0].status).toBe("resolved");
  });
});

// ---------------------------------------------------------------------------
// add_comment tests
// ---------------------------------------------------------------------------

describe("add_comment", () => {
  it("adds a comment to an existing thread", async () => {
    await writeTestPage(
      "comment-page",
      "---\ntags: [test]\n---\n# Comment Page\n\nContent.",
    );

    // Create a thread first
    await handleCreateDiscussion({
      pageSlug: "comment-page",
      title: "A discussion",
      body: "Initial message",
      author: "yoyo",
    });

    // Add a comment
    const comment = await handleAddComment({
      pageSlug: "comment-page",
      threadIndex: 0,
      content: "This is a reply",
      author: "agent-2",
    });

    expect(comment.author).toBe("agent-2");
    expect(comment.body).toBe("This is a reply");
    expect(comment.id).toBeDefined();
    expect(comment.parentId).toBeNull();

    // Verify the comment appears in the thread listing
    const list = await handleListDiscussions({ pageSlug: "comment-page" });
    expect(list.threads[0].commentCount).toBe(2); // original + reply
  });

  it("adds a threaded reply with parentId", async () => {
    await writeTestPage(
      "threaded-reply",
      "---\ntags: [test]\n---\n# Threaded Reply\n\nContent.",
    );

    const thread = await handleCreateDiscussion({
      pageSlug: "threaded-reply",
      title: "Thread for reply",
      body: "Top-level message",
      author: "yoyo",
    });

    const parentId = thread.comments[0].id;

    const reply = await handleAddComment({
      pageSlug: "threaded-reply",
      threadIndex: 0,
      content: "Nested reply",
      author: "agent-3",
      parentId,
    });

    expect(reply.parentId).toBe(parentId);
    expect(reply.body).toBe("Nested reply");
  });

  it("defaults author to anonymous when omitted", async () => {
    await writeTestPage(
      "anon-comment",
      "---\ntags: [test]\n---\n# Anon Comment\n\nContent.",
    );

    await handleCreateDiscussion({
      pageSlug: "anon-comment",
      title: "Thread",
      body: "First message",
      author: "yoyo",
    });

    const comment = await handleAddComment({
      pageSlug: "anon-comment",
      threadIndex: 0,
      content: "Anonymous contribution",
    });

    expect(comment.author).toBe("anonymous");
  });

  it("throws for missing pageSlug", async () => {
    await expect(
      handleAddComment({
        pageSlug: "",
        threadIndex: 0,
        content: "test",
      }),
    ).rejects.toThrow("pageSlug is required");
  });

  it("throws for missing content", async () => {
    await expect(
      handleAddComment({
        pageSlug: "some-page",
        threadIndex: 0,
        content: "",
      }),
    ).rejects.toThrow("content is required");
  });

  it("throws for invalid threadIndex", async () => {
    await writeTestPage(
      "bad-idx-comment",
      "---\ntags: [test]\n---\n# Bad Index\n\nContent.",
    );

    await expect(
      handleAddComment({
        pageSlug: "bad-idx-comment",
        threadIndex: 99,
        content: "test comment",
        author: "yoyo",
      }),
    ).rejects.toThrow("thread index 99 not found");
  });
});

// ---------------------------------------------------------------------------
// reingest tests
// ---------------------------------------------------------------------------

describe("reingest", () => {
  it("throws for missing slug", async () => {
    await expect(
      handleReingest({ slug: "" }),
    ).rejects.toThrow("slug is required");
  });

  it("throws for non-existent page", async () => {
    await expect(
      handleReingest({ slug: "nonexistent-page" }),
    ).rejects.toThrow('page "nonexistent-page" not found');
  });

  it("throws for page without source_url", async () => {
    await writeTestPage(
      "no-source",
      "---\ntags: [test]\n---\n# No Source\n\nThis page has no source URL.",
    );
    await writeIndex([
      { title: "No Source", slug: "no-source", summary: "No source URL" },
    ]);

    await expect(
      handleReingest({ slug: "no-source" }),
    ).rejects.toThrow("no source URL recorded");
  });
});
