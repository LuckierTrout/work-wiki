/**
 * Workbench Graph Insights: surprising connections and knowledge gaps.
 */

import type { GraphEdge, GraphNode } from "./graph-build";
import {
  COHESION_WARN,
  type CommunityAssignment,
  type CommunityInfo,
} from "./graph-louvain";

export type WorkbenchInsightKind = "surprise" | "isolated" | "sparse" | "bridge";

export type SurpriseClass = "cross-community" | "cross-type" | "peripheral-hub";

export interface WorkbenchInsight {
  id: string;
  kind: WorkbenchInsightKind;
  title: string;
  summary: string;
  slugs: string[];
  edges: Array<{ source: string; target: string }>;
  class?: SurpriseClass;
  /** Isolated / sparse / bridge offer Deep Research; surprises do not require it. */
  offersDeepResearch: boolean;
  /** Stable while the same structure is present; dismissal keys on this. */
  fingerprint: string;
  topic: string;
  queries: string[];
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function degreeMap(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): Map<string, number> {
  const degree = new Map(nodes.map((node) => [node.id, 0]));
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  return degree;
}

function labelOf(byId: ReadonlyMap<string, GraphNode>, slug: string): string {
  return byId.get(slug)?.label ?? slug;
}

function surpriseScore(
  edge: GraphEdge,
  a: GraphNode,
  b: GraphNode,
  communities: CommunityAssignment,
  degree: ReadonlyMap<string, number>,
): { score: number; classes: SurpriseClass[] } {
  const classes: SurpriseClass[] = [];
  let score = 0;
  const aComm = communities.bySlug[a.id];
  const bComm = communities.bySlug[b.id];
  if (aComm !== undefined && bComm !== undefined && aComm !== bComm) {
    classes.push("cross-community");
    score += 4;
  }
  if (a.type && b.type && a.type !== b.type) {
    classes.push("cross-type");
    score += 3;
  }
  const aDeg = degree.get(a.id) ?? 0;
  const bDeg = degree.get(b.id) ?? 0;
  const hi = Math.max(aDeg, bDeg);
  const lo = Math.min(aDeg, bDeg);
  if (hi >= 4 && lo <= 1) {
    classes.push("peripheral-hub");
    score += 2;
  }
  score += Math.min(edge.weight, 4) * 0.1;
  return { score, classes };
}

export function computeWorkbenchInsights(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
  communities: CommunityAssignment,
): WorkbenchInsight[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const degree = degreeMap(nodes, edges);
  const insights: WorkbenchInsight[] = [];

  const surprises: Array<{ insight: WorkbenchInsight; score: number }> = [];
  for (const edge of edges) {
    const a = byId.get(edge.source);
    const b = byId.get(edge.target);
    if (!a || !b) continue;
    const { score, classes } = surpriseScore(edge, a, b, communities, degree);
    if (classes.length === 0) continue;
    const slugs = [a.id, b.id].sort((left, right) => left.localeCompare(right));
    const primary = classes[0];
    surprises.push({
      score,
      insight: {
        id: `surprise:${slugs.join(":")}:${primary}`,
        kind: "surprise",
        title: `${labelOf(byId, slugs[0])} ↔ ${labelOf(byId, slugs[1])}`,
        summary: classes
          .map((item) =>
            item === "cross-community"
              ? "Cross-community link"
              : item === "cross-type"
                ? "Cross-type link"
                : "Peripheral hub",
          )
          .join(" · "),
        slugs,
        edges: [{ source: edge.source, target: edge.target }],
        class: primary,
        offersDeepResearch: false,
        fingerprint: `surprise:${slugs.join(":")}:${classes.slice().sort().join(",")}`,
        topic: `${labelOf(byId, slugs[0])} and ${labelOf(byId, slugs[1])}`,
        queries: [],
      },
    });
  }
  surprises
    .sort((a, b) => b.score - a.score || a.insight.id.localeCompare(b.insight.id))
    .slice(0, 12)
    .forEach((row) => insights.push(row.insight));

  for (const node of nodes) {
    const deg = degree.get(node.id) ?? 0;
    if (deg > 1) continue;
    insights.push({
      id: `isolated:${node.id}`,
      kind: "isolated",
      title: `${node.label} is isolated`,
      summary:
        deg === 0
          ? "This page has no graph links."
          : "This page has only one graph link.",
      slugs: [node.id],
      edges: edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => ({ source: edge.source, target: edge.target })),
      offersDeepResearch: true,
      fingerprint: `isolated:${node.id}:${deg}`,
      topic: node.label,
      queries: [`What else should connect to ${node.label}?`],
    });
  }

  for (const community of communities.communities) {
    if (community.count < 3) continue;
    if (community.cohesion >= COHESION_WARN) continue;
    const slugs = community.slugs.slice().sort((a, b) => a.localeCompare(b));
    insights.push({
      id: `sparse:${community.id}`,
      kind: "sparse",
      title: `${community.label} is sparse`,
      summary: `Cohesion ${community.cohesion.toFixed(2)} across ${community.count} pages.`,
      slugs,
      edges: edges
        .filter((edge) => slugs.includes(edge.source) && slugs.includes(edge.target))
        .map((edge) => ({ source: edge.source, target: edge.target })),
      offersDeepResearch: true,
      fingerprint: `sparse:${slugs.join(",")}:${community.cohesion.toFixed(2)}`,
      topic: community.label,
      queries: [`What is missing from the ${community.label} cluster?`],
    });
  }

  const communityOf = communities.bySlug;
  for (const node of nodes) {
    const neighborCommunities = new Set<number>();
    for (const edge of edges) {
      const other = edge.source === node.id ? edge.target : edge.target === node.id ? edge.source : null;
      if (!other) continue;
      const id = communityOf[other];
      if (id !== undefined && id !== communityOf[node.id]) neighborCommunities.add(id);
    }
    if (neighborCommunities.size < 3) continue;
    const slugs = [node.id];
    insights.push({
      id: `bridge:${node.id}`,
      kind: "bridge",
      title: `${node.label} is a bridge`,
      summary: `Links ${neighborCommunities.size} communities.`,
      slugs,
      edges: edges
        .filter((edge) => edge.source === node.id || edge.target === node.id)
        .map((edge) => ({ source: edge.source, target: edge.target })),
      offersDeepResearch: true,
      fingerprint: `bridge:${node.id}:${[...neighborCommunities].sort((a, b) => a - b).join(",")}`,
      topic: node.label,
      queries: [`How does ${node.label} connect these areas of the wiki?`],
    });
  }

  return insights;
}

export function filterDismissedInsights(
  insights: readonly WorkbenchInsight[],
  dismissed: ReadonlyMap<string, string>,
): WorkbenchInsight[] {
  return insights.filter((insight) => dismissed.get(insight.id) !== insight.fingerprint);
}

export function typeLegend(
  nodes: readonly GraphNode[],
): Array<{ id: string; label: string; count: number }> {
  const counts = new Map<string, number>();
  for (const node of nodes) {
    const key = node.type?.trim() || "page";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([id, count]) => ({
      id,
      label: id === "page" ? "Page" : id.replace(/-/g, " ").replace(/\b\w/g, (ch) => ch.toUpperCase()),
      count,
    }));
}

export function communityLegend(communities: readonly CommunityInfo[]): CommunityInfo[] {
  return communities.slice().sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}
