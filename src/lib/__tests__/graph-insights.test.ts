import { describe, expect, it } from "vitest";
import { deriveGraphInsights } from "../graph-insights";
import type { GraphEdge, GraphNode } from "../graph-build";

function node(id: string, tags: string[] = []): GraphNode {
  return { id, label: id.toUpperCase(), tenant: "alice", linkCount: 0, tags };
}

describe("knowledge graph insights", () => {
  it("finds isolated pages, bridge pages, and likely missing links", () => {
    const nodes: GraphNode[] = [
      node("a", ["launch", "decision"]),
      node("b", ["launch", "decision"]),
      node("c", ["launch"]),
      node("d", ["orphan"]),
    ];
    const edges: GraphEdge[] = [
      { source: "a", target: "c", weight: 3, signals: ["direct-link"] },
      { source: "c", target: "b", weight: 3, signals: ["direct-link"] },
    ];
    const insights = deriveGraphInsights(nodes, edges);

    expect(insights).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "isolated", slugs: ["d"] }),
      expect.objectContaining({ kind: "bridge", slugs: ["c"] }),
      expect.objectContaining({ kind: "missing-link", slugs: ["a", "b"] }),
    ]));
  });

  it("flags sparse topic clusters deterministically", () => {
    const insights = deriveGraphInsights([
      node("a", ["strategy"]),
      node("b", ["strategy"]),
      node("c", ["strategy"]),
      node("d", ["strategy"]),
    ], [{ source: "a", target: "b", weight: 3, signals: ["direct-link"] }]);
    expect(insights.find((item) => item.kind === "sparse-topic")).toMatchObject({
      slugs: ["a", "b", "c", "d"],
      signals: ["4 tagged pages", "1 internal links", "density 0.17"],
    });
  });
});
