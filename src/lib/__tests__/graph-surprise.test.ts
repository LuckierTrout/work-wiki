import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../graph-build";
import type { CommunityAssignment } from "../graph-louvain";
import {
  computeWorkbenchInsights,
  filterDismissedInsights,
} from "../graph-surprise";

function node(id: string, type?: string): GraphNode {
  return { id, label: id, tenant: "yopedia", linkCount: 0, tags: [], ...(type ? { type } : {}) };
}

function edge(source: string, target: string, weight = 3): GraphEdge {
  return { source, target, weight, signals: ["direct link"] };
}

describe("Workbench Insights", () => {
  it("marks degree ≤ 1 as isolated", () => {
    const nodes = [node("alone"), node("spoke"), node("hub", "concept"), node("other", "note")];
    const edges = [edge("spoke", "hub"), edge("hub", "other", 4)];
    const communities: CommunityAssignment = {
      bySlug: { alone: 0, spoke: 1, hub: 1, other: 2 },
      communities: [],
    };
    const insights = computeWorkbenchInsights(nodes, edges, communities);
    const isolated = insights.filter((item) => item.kind === "isolated").map((item) => item.slugs[0]);
    expect(isolated).toEqual(expect.arrayContaining(["alone", "spoke"]));
    expect(isolated).not.toContain("hub");
  });

  it("does not treat a 2-page low-cohesion cluster as sparse", () => {
    const nodes = [node("a"), node("b")];
    const communities: CommunityAssignment = {
      bySlug: { a: 0, b: 0 },
      communities: [
        {
          id: 0,
          label: "a",
          slugs: ["a", "b"],
          count: 2,
          cohesion: 0.05,
          color: "#111",
          warn: false,
        },
      ],
    };
    const insights = computeWorkbenchInsights(nodes, [], communities);
    expect(insights.some((item) => item.kind === "sparse")).toBe(false);
  });

  it("emits sparse when cohesion is low across at least 3 pages", () => {
    const slugs = ["a", "b", "c"];
    const nodes = slugs.map((id) => node(id));
    const communities: CommunityAssignment = {
      bySlug: { a: 0, b: 0, c: 0 },
      communities: [
        {
          id: 0,
          label: "a",
          slugs,
          count: 3,
          cohesion: 0.1,
          color: "#111",
          warn: true,
        },
      ],
    };
    const insights = computeWorkbenchInsights(nodes, [edge("a", "b")], communities);
    expect(insights.some((item) => item.kind === "sparse")).toBe(true);
  });

  it("marks a page linking 3+ communities as a bridge", () => {
    const nodes = [node("hub"), node("c1"), node("c2"), node("c3")];
    const edges = [edge("hub", "c1"), edge("hub", "c2"), edge("hub", "c3")];
    const communities: CommunityAssignment = {
      bySlug: { hub: 0, c1: 1, c2: 2, c3: 3 },
      communities: [],
    };
    const insights = computeWorkbenchInsights(nodes, edges, communities);
    expect(insights.some((item) => item.kind === "bridge" && item.slugs[0] === "hub")).toBe(true);
  });

  it("hides a dismissed insight until its fingerprint changes", () => {
    const nodes = [node("alone")];
    const insights = computeWorkbenchInsights(nodes, [], {
      bySlug: { alone: 0 },
      communities: [],
    });
    const isolated = insights.find((item) => item.id === "isolated:alone");
    expect(isolated).toBeTruthy();
    const hidden = filterDismissedInsights(insights, new Map([[isolated!.id, isolated!.fingerprint]]));
    expect(hidden.some((item) => item.id === isolated!.id)).toBe(false);
    const changed = filterDismissedInsights(insights, new Map([[isolated!.id, "stale-fingerprint"]]));
    expect(changed.some((item) => item.id === isolated!.id)).toBe(true);
  });
});
