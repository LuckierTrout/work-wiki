import { describe, expect, it } from "vitest";
import type { GraphEdge, GraphNode } from "../graph-build";
import type { CommunityAssignment } from "../graph-louvain";
import {
  DISMISSAL_FINGERPRINT_FIELDS,
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
    const legacyHidden = filterDismissedInsights(
      insights,
      new Map([[isolated!.id, isolated!.legacyFingerprint!]]),
    );
    expect(legacyHidden.some((item) => item.id === isolated!.id)).toBe(false);
    const remapped = { ...isolated!, id: "isolated:bounded", legacyId: isolated!.id };
    const remappedHidden = filterDismissedInsights(
      [remapped],
      new Map([[isolated!.id, isolated!.fingerprint]]),
    );
    expect(remappedHidden).toEqual([]);
  });

  it("bounds fingerprints even when an Insight has many incident edges", () => {
    const leaves = Array.from({ length: 200 }, (_, index) => node(`leaf-${index}`));
    const nodes = [node("a", "person"), node("b", "concept"), ...leaves];
    const edges = [
      edge("a", "b"),
      ...leaves.map((leaf, index) => edge("a", leaf.id, index + 1)),
    ];
    const bySlug = Object.fromEntries(nodes.map((item, index) => [item.id, index === 1 ? 1 : 0]));
    const surprise = computeWorkbenchInsights(nodes, edges, {
      bySlug,
      communities: [],
    }).find((item) => item.id.startsWith("surprise:a:b:"));
    expect(surprise?.legacyFingerprint).toBe(
      "surprise:a:b:cross-community,cross-type,peripheral-hub",
    );
    expect(surprise?.fingerprint.length).toBeLessThanOrEqual(40);
  });

  it("reproduces every committed legacy fingerprint format exactly", () => {
    const surprise = computeWorkbenchInsights(
      [node("b", "note"), node("a", "person")],
      [edge("b", "a")],
      { bySlug: { a: 0, b: 1 }, communities: [] },
    ).find((item) => item.kind === "surprise");
    expect(surprise?.legacyFingerprint).toBe("surprise:a:b:cross-community,cross-type");

    const isolated = computeWorkbenchInsights(
      [node("alone")],
      [],
      { bySlug: { alone: 0 }, communities: [] },
    ).find((item) => item.kind === "isolated");
    expect(isolated?.legacyFingerprint).toBe("isolated:alone:0");

    const sparse = computeWorkbenchInsights(
      [node("c"), node("a"), node("b")],
      [edge("a", "b")],
      {
        bySlug: { a: 0, b: 0, c: 0 },
        communities: [{
          id: 0,
          label: "cluster",
          slugs: ["c", "a", "b"],
          count: 3,
          cohesion: 0.1,
          color: "#111",
          warn: true,
        }],
      },
    ).find((item) => item.kind === "sparse");
    expect(sparse?.legacyFingerprint).toBe("sparse:a,b,c:0.10");

    const bridge = computeWorkbenchInsights(
      [node("hub"), node("c3"), node("c1"), node("c2")],
      [edge("hub", "c3"), edge("hub", "c1"), edge("hub", "c2")],
      { bySlug: { hub: 0, c1: 1, c2: 2, c3: 3 }, communities: [] },
    ).find((item) => item.kind === "bridge");
    expect(bridge?.legacyFingerprint).toBe("bridge:hub:1,2,3");
  });

  it("bounds generated Insight ids for long slugs", () => {
    const longA = `a-${"x".repeat(260)}`;
    const longB = `b-${"y".repeat(260)}`;
    const insights = computeWorkbenchInsights(
      [node(longA, "person"), node(longB, "note"), node("c1"), node("c2"), node("c3")],
      [edge(longA, longB), edge(longA, "c1"), edge(longA, "c2"), edge(longA, "c3")],
      { bySlug: { [longA]: 0, [longB]: 1, c1: 1, c2: 2, c3: 3 }, communities: [] },
    );
    expect(insights.length).toBeGreaterThan(0);
    expect(insights.every((insight) => insight.id.length <= 200)).toBe(true);
    expect(insights.some((insight) => insight.id.startsWith("isolated:w1:"))).toBe(true);
    expect(insights.some((insight) => insight.id.startsWith("bridge:w1:"))).toBe(true);
    expect(insights.some((insight) => insight.id.startsWith("surprise:w1:"))).toBe(true);
  });

  it("changes a dismissal fingerprint when incident topology changes", () => {
    const nodes = [node("alone"), node("hub")];
    const first = computeWorkbenchInsights(nodes, [], {
      bySlug: { alone: 0, hub: 1 },
      communities: [],
    }).find((item) => item.id === "isolated:alone");
    const second = computeWorkbenchInsights(nodes, [edge("alone", "hub")], {
      bySlug: { alone: 0, hub: 1 },
      communities: [],
    }).find((item) => item.id === "isolated:alone");
    expect(first?.fingerprint).toBeTruthy();
    expect(second?.fingerprint).toBeTruthy();
    expect(first!.fingerprint).not.toBe(second!.fingerprint);
  });

  it("changes a surprise fingerprint when another incident edge changes", () => {
    const nodes = [node("a", "person"), node("b", "concept"), node("c")];
    const communities: CommunityAssignment = {
      bySlug: { a: 0, b: 1, c: 0 },
      communities: [],
    };
    const surprise = (edges: GraphEdge[]) => computeWorkbenchInsights(nodes, edges, communities)
      .find((item) => item.id.startsWith("surprise:a:b:"));
    const first = surprise([edge("a", "b"), edge("a", "c", 1)]);
    const second = surprise([edge("a", "b"), edge("a", "c", 2)]);
    expect(first?.fingerprint).toBeTruthy();
    expect(first?.fingerprint).not.toBe(second?.fingerprint);
  });

  it("invalidates only the approved fingerprint fields", () => {
    expect(DISMISSAL_FINGERPRINT_FIELDS).toEqual([
      "kind",
      "sorted slugs",
      "community ids of those slugs",
      "incident undirected edges and weights",
      "kind-specific extra: surprise classes | isolated degree | sparse cohesion | bridge neighbor communities",
    ]);
    const isolated = (communities: CommunityAssignment, edges: GraphEdge[] = []) =>
      computeWorkbenchInsights(
        [node("alone"), node("zeta"), node("hub")],
        edges,
        communities,
      ).find((item) => item.id === "isolated:alone");
    const base = isolated({ bySlug: { alone: 0, zeta: 1, hub: 2 }, communities: [] });
    const unrelated = isolated({ bySlug: { alone: 0, zeta: 1, hub: 2 }, communities: [] }, [
      edge("zeta", "hub"),
    ]);
    const remapped = isolated({ bySlug: { alone: 1, zeta: 0, hub: 2 }, communities: [] });
    const weighted = isolated({ bySlug: { alone: 0, zeta: 1, hub: 2 }, communities: [] }, [
      edge("alone", "hub", 1),
    ]);
    expect(base?.fingerprint).toBe(unrelated?.fingerprint);
    expect(base?.fingerprint).not.toBe(remapped?.fingerprint);
    expect(base?.fingerprint).not.toBe(weighted?.fingerprint);
  });
});
