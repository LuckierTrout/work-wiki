/**
 * Workbench Graph communities: package Louvain on topology, then Cohesion.
 *
 * Coloring uses `type` only in Type mode — Louvain itself never reads `type`.
 */

import Graph from "graphology";
import louvain from "graphology-communities-louvain";
import type { GraphEdge, GraphNode } from "./graph-build";

export const COMMUNITY_PALETTE = [
  "#1d4ed8",
  "#b45309",
  "#047857",
  "#be123c",
  "#6d28d9",
  "#0f766e",
  "#a16207",
  "#1e40af",
  "#9d174d",
  "#365314",
  "#7c2d12",
  "#334155",
] as const;

export const COHESION_WARN = 0.15;

export interface CommunityInfo {
  id: number;
  label: string;
  slugs: string[];
  count: number;
  cohesion: number;
  color: string;
  warn: boolean;
}

export interface CommunityAssignment {
  bySlug: Record<string, number>;
  communities: CommunityInfo[];
}

export function communityColor(id: number): string {
  return COMMUNITY_PALETTE[id % COMMUNITY_PALETTE.length];
}

export function cohesionOf(
  members: readonly string[],
  edges: readonly GraphEdge[],
): number {
  if (members.length < 2) return 1;
  const set = new Set(members);
  let intra = 0;
  for (const edge of edges) {
    if (set.has(edge.source) && set.has(edge.target)) intra += 1;
  }
  const possible = (members.length * (members.length - 1)) / 2;
  return possible > 0 ? intra / possible : 0;
}

function topLabel(
  slugs: readonly string[],
  byId: ReadonlyMap<string, GraphNode>,
  degree: ReadonlyMap<string, number>,
): string {
  const ranked = [...slugs].sort((a, b) => {
    const deg = (degree.get(b) ?? 0) - (degree.get(a) ?? 0);
    if (deg !== 0) return deg;
    return a.localeCompare(b);
  });
  const winner = ranked[0];
  return byId.get(winner)?.label ?? winner;
}

/** Louvain on undirected topology. Edge weights and page `type` are ignored. */
export function assignCommunities(
  nodes: readonly GraphNode[],
  edges: readonly GraphEdge[],
): CommunityAssignment {
  const graph = new Graph({ type: "undirected", allowSelfLoops: false });
  for (const node of nodes) {
    if (!graph.hasNode(node.id)) graph.addNode(node.id);
  }
  for (const edge of edges) {
    if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
    if (edge.source === edge.target) continue;
    if (!graph.hasEdge(edge.source, edge.target)) {
      graph.addUndirectedEdge(edge.source, edge.target);
    }
  }

  const raw =
    graph.order === 0
      ? {}
      : (louvain(graph, { getEdgeWeight: null }) as Record<string, number>);

  const remap = new Map<number, number>();
  let nextId = 0;
  const bySlug: Record<string, number> = {};
  for (const node of nodes) {
    const rawId = raw[node.id];
    const source = typeof rawId === "number" ? rawId : -1 - nodes.indexOf(node);
    if (!remap.has(source)) {
      remap.set(source, nextId);
      nextId += 1;
    }
    bySlug[node.id] = remap.get(source)!;
  }

  const degree = new Map<string, number>();
  for (const node of nodes) degree.set(node.id, 0);
  for (const edge of edges) {
    degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
    degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
  }
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const groups = new Map<number, string[]>();
  for (const node of nodes) {
    const id = bySlug[node.id];
    const members = groups.get(id) ?? [];
    members.push(node.id);
    groups.set(id, members);
  }

  const communities: CommunityInfo[] = [...groups.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([id, slugs]) => {
      const cohesion = cohesionOf(slugs, edges);
      return {
        id,
        label: topLabel(slugs, byId, degree),
        slugs: slugs.slice().sort((a, b) => a.localeCompare(b)),
        count: slugs.length,
        cohesion: Number(cohesion.toFixed(4)),
        color: communityColor(id),
        warn: cohesion < COHESION_WARN && slugs.length >= 3,
      };
    });

  return { bySlug, communities };
}
