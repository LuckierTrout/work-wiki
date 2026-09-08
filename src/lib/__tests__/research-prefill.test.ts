import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wikis", () => ({
  getWikiRegistry: vi.fn(),
  readEffectiveWikiArtifact: vi.fn(),
}));
vi.mock("../wiki", () => ({
  readWikiPage: vi.fn(),
}));

import { getWikiRegistry, readEffectiveWikiArtifact } from "../wikis";
import { readWikiPage } from "../wiki";
import {
  RESEARCH_PREFILL_LIMIT,
  RESEARCH_PREFILL_PAGE_LIMIT,
  allocateResearchPrefillSlugs,
  buildResearchPrefill,
  loadResearchPrefillContext,
  loadResearchPrefillPages,
} from "../research-prefill";

const mockedRegistry = vi.mocked(getWikiRegistry);
const mockedArtifact = vi.mocked(readEffectiveWikiArtifact);
const mockedRead = vi.mocked(readWikiPage);

describe("buildResearchPrefill", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockedRegistry.mockResolvedValue({ currentId: "wiki-1" } as never);
    mockedArtifact.mockResolvedValue(
      "# Purpose\n\nThis wiki exists to track hiring decisions for the current search.",
    );
    mockedRead.mockImplementation(async (slug: string) => {
      if (slug === "overview") {
        return {
          slug: "overview",
          title: "Overview",
          content: "# Overview\n\nThe overview of this workspace is long enough to prefill.",
          path: "wiki/overview.md",
        };
      }
      if (slug === "isolated") {
        return {
          slug: "isolated",
          title: "Isolated",
          content: "# Isolated\n\nThis Insight page explains a gap that needs specific research.",
          path: "wiki/isolated.md",
        };
      }
      return null;
    });
  });

  it("reads the current Wiki's effective canonical Purpose", async () => {
    const prefill = await buildResearchPrefill(["isolated"], "Fallback", "alice");
    expect(mockedRegistry).toHaveBeenCalledWith("alice");
    expect(mockedArtifact).toHaveBeenCalledWith("alice", "wiki-1", "purpose.md");
    expect(prefill.queries[0]).toContain("hiring decisions");
    expect(prefill.queries).toEqual(expect.arrayContaining([
      "The overview of this workspace is long enough to prefill.",
      "This Insight page explains a gap that needs specific research.",
    ]));
    expect(RESEARCH_PREFILL_LIMIT).toBe(12);
  });

  it("omits Purpose when its single canonical read fails", async () => {
    mockedArtifact.mockRejectedValue(new Error("artifact unavailable"));
    const context = await loadResearchPrefillContext("alice");
    expect(context.purposeQueries).toEqual([]);

    mockedArtifact.mockResolvedValue(
      "# Purpose\n\nThe canonical artifact purpose remains available.",
    );
    const artifactContext = await loadResearchPrefillContext("alice");
    expect(artifactContext.purposeQueries).toEqual([
      "The canonical artifact purpose remains available.",
    ]);
  });

  it("reserves Overview and Insight-page context before Purpose extras", async () => {
    mockedArtifact.mockResolvedValue(
      "# Purpose\n\nPurpose one is long enough to occupy a research query slot.",
    );
    const prefill = await buildResearchPrefill(["isolated"], "Fallback", "alice");
    expect(prefill.queries).toContain("The overview of this workspace is long enough to prefill.");
    expect(prefill.queries).toContain("This Insight page explains a gap that needs specific research.");
    expect(prefill.queries).toHaveLength(3);
  });

  it("prefills from the current Wiki, not a sibling Wiki's Purpose", async () => {
    mockedRegistry.mockResolvedValue({ currentId: "wiki-b" } as never);
    mockedArtifact.mockImplementation(async (_owner, wikiId) =>
      wikiId === "wiki-b"
        ? "# Purpose\n\nWiki B purpose sentence is long enough to prefill."
        : "# Purpose\n\nWiki A purpose sentence is long enough to prefill.",
    );
    const prefill = await buildResearchPrefill(["isolated"], "Fallback", "alice");
    expect(mockedArtifact).toHaveBeenCalledWith("alice", "wiki-b", "purpose.md");
    expect(prefill.queries[0]).toContain("Wiki B purpose");
    expect(prefill.queries.join("\n")).not.toContain("Wiki A purpose");
  });

  it("deduplicates and bounds request-local Insight Page reads", async () => {
    mockedRead.mockResolvedValue(null);
    const slugs = Array.from({ length: 100 }, (_, index) => `page-${index}`);
    await loadResearchPrefillPages([...slugs, ...slugs]);
    expect(mockedRead).toHaveBeenCalledTimes(RESEARCH_PREFILL_PAGE_LIMIT);
    expect(RESEARCH_PREFILL_PAGE_LIMIT).toBe(48);
  });

  it("allocates the Page budget fairly across selected Insights", () => {
    const sparse = Array.from({ length: 100 }, (_, index) => `sparse-${index}`);
    const isolated = ["isolated-only"];
    const bridge = ["shared", "bridge-only"];
    const selected = allocateResearchPrefillSlugs([sparse, isolated, ["shared"], bridge]);
    expect(selected).toHaveLength(RESEARCH_PREFILL_PAGE_LIMIT);
    expect(selected.slice(0, 4)).toEqual([
      "sparse-0",
      "isolated-only",
      "shared",
      "bridge-only",
    ]);
    expect(selected.filter((slug) => slug === "shared")).toHaveLength(1);
    expect(selected).toContain("sparse-44");
    expect(selected).not.toContain("sparse-45");
  });
});
