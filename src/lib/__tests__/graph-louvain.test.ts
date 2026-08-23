import { describe, expect, it } from "vitest";
import { assignCommunities, COHESION_WARN, cohesionOf } from "../graph-louvain";
import type { GraphEdge, GraphNode } from "../graph-build";

function node(id: string, type?: string): GraphNode {
  return { id, label: id, tenant: "yopedia", linkCount: 0, tags: [], ...(type ? { type } : {}) };
}

function edge(source: string, target: string, weight = 3): GraphEdge {
  return { source, target, weight, signals: ["direct link"] };
}

describe("Louvain communities", () => {
  it("clusters from topology, not page type", () => {
    const nodes = [
      node("a", "concept"),
      node("b", "person"),
      node("c", "concept"),
      node("d", "person"),
    ];
    const edges = [edge("a", "b"), edge("c", "d")];
    const { bySlug } = assignCommunities(nodes, edges);
    expect(bySlug.a).toBe(bySlug.b);
    expect(bySlug.c).toBe(bySlug.d);
    expect(bySlug.a).not.toBe(bySlug.c);
  });

  it("warns on cohesion below 0.15 when a community has at least 3 pages", () => {
    const three = ["p1", "p2", "p3"];
    const noEdges: GraphEdge[] = [];
    expect(cohesionOf(three, noEdges)).toBe(0);
    const assigned = assignCommunities([node("p1"), node("p2"), node("p3")], noEdges);
    for (const community of assigned.communities) {
      if (community.count >= 3 && community.cohesion < COHESION_WARN) {
        expect(community.warn).toBe(true);
      }
    }
  });
});
