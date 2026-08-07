import { describe, expect, it } from "vitest";
import { buildWeightedGraphEdges, expandGraphSeeds } from "../graph-relevance";

describe("weighted graph relevance", () => {
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
