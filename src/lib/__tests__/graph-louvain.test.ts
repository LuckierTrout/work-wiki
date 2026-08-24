import { describe, expect, it } from "vitest";
import { assignCommunities, COHESION_WARN, cohesionOf, cohesionWarns } from "../graph-louvain";
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

  it("warns on cohesion below 0.15 regardless of community size", () => {
    expect(cohesionWarns(0)).toBe(true);
    expect(cohesionWarns(0.149)).toBe(true);
    expect(cohesionWarns(COHESION_WARN)).toBe(false);
    expect(cohesionOf(["p1", "p2"], [])).toBe(0);
  });

  it("assigns the same communities for the same topology", () => {
    const nodes = ["a", "b", "c", "d", "e", "f", "g", "h"].map((id) => node(id));
    const edges = [
      edge("a", "b"),
      edge("b", "c"),
      edge("c", "a"),
      edge("d", "e"),
      edge("e", "f"),
      edge("f", "d"),
      edge("g", "h"),
    ];
    const first = assignCommunities(nodes, edges);
    const second = assignCommunities(nodes.slice().reverse(), edges.slice().reverse());
    expect(first.bySlug).toEqual(second.bySlug);
  });

  it("seeds and scores only the canonical effective graph", () => {
    const nodes = [node("a"), node("b"), node("c"), node("d")];
    const clean = [edge("a", "b"), edge("c", "d")];
    const noisy = [
      edge("d", "c", 99),
      edge("a", "a", 99),
      edge("missing", "a", 99),
      edge("b", "a", 1),
      ...clean,
    ];
    expect(assignCommunities([...nodes, node("a")], noisy)).toEqual(assignCommunities(nodes, clean));
  });
});
