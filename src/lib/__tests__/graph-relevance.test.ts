import { describe, expect, it } from "vitest";
import {
  RELEVANCE_WEIGHTS,
  STRONG_EDGE_WEIGHT,
  buildWeightedGraphEdges,
  expandGraphSeeds,
} from "../graph-relevance";

describe("weighted graph relevance", () => {
  it("pins the v1 Relevance weights", () => {
    expect(RELEVANCE_WEIGHTS).toEqual({
      wikilink: 3,
      sourceOverlap: 4,
      adamicAdar: 1.5,
      typeAffinity: 1,
    });
    expect(STRONG_EDGE_WEIGHT).toBe(4);
  });

  it("ranks a shared Source above a single wikilink", () => {
    const shared = buildWeightedGraphEdges([
      { id: "a", directTargets: [], sourceUrls: ["https://example.com/shared"], type: "note" },
      { id: "b", directTargets: [], sourceUrls: ["https://example.com/shared"], type: "person" },
    ]);
    const linked = buildWeightedGraphEdges([
      { id: "c", directTargets: ["d"], sourceUrls: [], type: "note" },
      { id: "d", directTargets: ["c"], sourceUrls: [], type: "person" },
    ]);
    expect(shared[0]?.weight).toBe(RELEVANCE_WEIGHTS.sourceOverlap);
    expect(linked[0]?.weight).toBe(RELEVANCE_WEIGHTS.wikilink);
    expect(shared[0]!.weight).toBeGreaterThan(linked[0]!.weight);
  });

  it("scores unrelated mixed-type pages with no link, overlap, or neighbors as 0", () => {
    const edges = buildWeightedGraphEdges([
      { id: "alpha", directTargets: [], sourceUrls: ["https://example.com/a"], type: "note" },
      { id: "beta", directTargets: [], sourceUrls: ["https://example.com/b"], type: "person" },
    ]);
    expect(edges).toEqual([]);
  });

  it("combines explainable link, source, neighbor, and type signals", () => {
    const edges = buildWeightedGraphEdges([
      { id: "a", directTargets: ["hub", "b"], sourceUrls: ["https://example.com/report"], type: "project" },
      { id: "b", directTargets: ["hub"], sourceUrls: ["https://example.com/report/"], type: "project" },
      { id: "hub", directTargets: ["a", "b"], sourceUrls: [], type: "person" },
    ]);
    const edge = edges.find((item) => item.source === "a" && item.target === "b");
    expect(edge?.weight).toBeGreaterThan(8);
    expect(edge?.signals).toEqual(expect.arrayContaining([
      "direct link",
      "shared source: 1",
      "same page type: project",
      expect.stringMatching(/^common-neighbor relevance:/),
    ]));
  });

  it("expands through the strongest allowed one and two hop neighbors", () => {
    const edges = [
      { source: "seed", target: "strong", weight: 8, signals: ["shared source"] },
      { source: "seed", target: "weak", weight: 2, signals: ["same page type"] },
      { source: "strong", target: "second", weight: 6, signals: ["direct link"] },
      { source: "seed", target: "forbidden", weight: 100, signals: ["shared source"] },
    ];
    expect(expandGraphSeeds(["seed"], edges, new Set(["seed", "strong", "weak", "second"]), 4))
      .toEqual(["seed", "strong", "weak", "second"]);
  });
});
