import type { GraphEdge, GraphNode } from "./graph-build";

export type GraphInsightKind = "isolated" | "bridge" | "missing-link" | "sparse-topic";

export interface GraphInsight {
  id: string;
  kind: GraphInsightKind;
  title: string;
  summary: string;
  slugs: string[];
  signals: string[];
  priority: number;
}

function edgeKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function buildAdjacency(nodes: readonly GraphNode[], edges: readonly GraphEdge[]) {
  const adjacency = new Map(nodes.map((node) => [node.id, new Set<string>()]));
  for (const edge of edges) {
    if (!adjacency.has(edge.source) || !adjacency.has(edge.target)) continue;
    adjacency.get(edge.source)?.add(edge.target);
    adjacency.get(edge.target)?.add(edge.source);
  }
  return adjacency;
}

function articulationPoints(adjacency: ReadonlyMap<string, ReadonlySet<string>>): Set<string> {
  const visited = new Set<string>();
  const discovery = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const points = new Set<string>();
  let time = 0;

  function visit(node: string) {
    visited.add(node);
    discovery.set(node, ++time);
    low.set(node, time);
    let children = 0;
    for (const neighbor of adjacency.get(node) ?? []) {
      if (!visited.has(neighbor)) {
        children += 1;
        parent.set(neighbor, node);
        visit(neighbor);
        low.set(node, Math.min(low.get(node) ?? time, low.get(neighbor) ?? time));
        if (parent.get(node) === null && children > 1) points.add(node);
        if (
          parent.get(node) !== null &&
          (low.get(neighbor) ?? 0) >= (discovery.get(node) ?? 0)
        ) {
          points.add(node);
        }
      } else if (neighbor !== parent.get(node)) {
        low.set(node, Math.min(low.get(node) ?? time, discovery.get(neighbor) ?? time));
      }
    }
  }

  for (const node of adjacency.keys()) {
    if (visited.has(node)) continue;
    parent.set(node, null);
    visit(node);
  }
  return points;
}

export function deriveGraphInsights(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): GraphInsight[] {
  const adjacency = buildAdjacency(nodes, edges);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const existingEdges = new Set(edges.map((edge) => edgeKey(edge.source, edge.target)));
  const insights: GraphInsight[] = [];

  for (const node of nodes) {
    if ((adjacency.get(node.id)?.size ?? 0) !== 0) continue;
    insights.push({
      id: `isolated:${node.id}`,
      kind: "isolated",
      title: `${node.label} is disconnected`,
      summary: "This page has no graph links, so related knowledge cannot currently reach it.",
      slugs: [node.id],
      signals: ["0 direct links"],
      priority: 90,
    });
  }

  for (const slug of articulationPoints(adjacency)) {
    const node = byId.get(slug);
    if (!node) continue;
    const degree = adjacency.get(slug)?.size ?? 0;
    insights.push({
      id: `bridge:${slug}`,
      kind: "bridge",
      title: `${node.label} is a bridge`,
      summary: "Removing this page would split part of the current knowledge graph.",
      slugs: [slug],
      signals: [`${degree} neighboring pages`, "articulation point"],
      priority: 70 + Math.min(degree, 10),
    });
  }

  const sortedNodes = nodes.slice().sort((a, b) => a.id.localeCompare(b.id));
  for (let left = 0; left < sortedNodes.length; left += 1) {
    for (let right = left + 1; right < sortedNodes.length; right += 1) {
      const a = sortedNodes[left];
      const b = sortedNodes[right];
      if (existingEdges.has(edgeKey(a.id, b.id))) continue;
      const bTags = new Set(b.tags.map((tag) => tag.toLocaleLowerCase()));
      const shared = a.tags.filter((tag) => bTags.has(tag.toLocaleLowerCase()));
      if (shared.length < 2) continue;
      insights.push({
        id: `missing-link:${a.id}:${b.id}`,
        kind: "missing-link",
        title: `${a.label} may belong with ${b.label}`,
        summary: "These pages share several topic signals but have no direct relationship.",
        slugs: [a.id, b.id],
        signals: shared.slice(0, 5).map((tag) => `shared tag: ${tag}`),
        priority: 50 + shared.length * 5,
      });
    }
  }

  const tagGroups = new Map<string, string[]>();
  for (const node of nodes) {
    for (const tag of node.tags) {
      const key = tag.toLocaleLowerCase();
      const members = tagGroups.get(key) ?? [];
      members.push(node.id);
      tagGroups.set(key, members);
    }
  }
  for (const [tag, members] of tagGroups) {
    if (members.length < 3) continue;
    const memberSet = new Set(members);
    const internalEdges = edges.filter(
      (edge) => memberSet.has(edge.source) && memberSet.has(edge.target),
    ).length;
    const possible = (members.length * (members.length - 1)) / 2;
    const density = possible > 0 ? internalEdges / possible : 0;
    if (density >= 0.25) continue;
    insights.push({
      id: `sparse-topic:${tag}`,
      kind: "sparse-topic",
      title: `${tag} is a sparse topic`,
      summary: "Several pages share this topic, but few relationships connect them.",
      slugs: members.slice(0, 12),
      signals: [`${members.length} tagged pages`, `${internalEdges} internal links`, `density ${density.toFixed(2)}`],
      priority: 45 + Math.min(members.length, 10),
    });
  }

  return insights
    .sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
    .slice(0, 40);
}
