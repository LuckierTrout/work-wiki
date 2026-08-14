/** Deterministic weighted Louvain-style community detection. */

export interface ClusterInput {
  nodes: string[]; // node IDs
  edges: [string, string, number?][]; // weighted connected node pairs
}

export interface ClusterResult {
  clusters: Map<string, number>; // node ID → cluster index (0-based)
  count: number; // number of distinct clusters
}

const MAX_ITERATIONS = 24;

function modularity(
  communities: ReadonlyMap<string, string>,
  edges: readonly [string, string, number][],
  degrees: ReadonlyMap<string, number>,
  totalWeight: number,
): number {
  if (totalWeight <= 0) return 0;
  const internal = new Map<string, number>();
  const degreeByCommunity = new Map<string, number>();
  for (const [node, community] of communities) {
    degreeByCommunity.set(
      community,
      (degreeByCommunity.get(community) ?? 0) + (degrees.get(node) ?? 0),
    );
  }
  for (const [a, b, weight] of edges) {
    const community = communities.get(a);
    if (community && community === communities.get(b)) {
      internal.set(community, (internal.get(community) ?? 0) + weight);
    }
  }
  let score = 0;
  for (const [community, degree] of degreeByCommunity) {
    score += (internal.get(community) ?? 0) / totalWeight -
      Math.pow(degree / (2 * totalWeight), 2);
  }
  return score;
}

export function detectCommunities(input: ClusterInput): ClusterResult {
  const { nodes, edges } = input;

  if (nodes.length === 0) {
    return { clusters: new Map(), count: 0 };
  }

  // Build a de-duplicated weighted adjacency list.
  const adj = new Map<string, Map<string, number>>();
  for (const id of nodes) {
    adj.set(id, new Map());
  }
  for (const [a, b, rawWeight] of edges) {
    const weight = Number.isFinite(rawWeight) && (rawWeight ?? 0) > 0 ? rawWeight! : 1;
    if (a !== b && adj.has(a) && adj.has(b)) {
      adj.get(a)!.set(b, (adj.get(a)!.get(b) ?? 0) + weight);
      adj.get(b)!.set(a, (adj.get(b)!.get(a) ?? 0) + weight);
    }
  }
  const weightedEdges: [string, string, number][] = [];
  for (const [a, neighbors] of adj) {
    for (const [b, weight] of neighbors) {
      if (a < b) weightedEdges.push([a, b, weight]);
    }
  }
  const sortedNodes = [...nodes].sort();
  const degrees = new Map(sortedNodes.map((node) => [
    node,
    [...(adj.get(node)?.values() ?? [])].reduce((sum, weight) => sum + weight, 0),
  ]));
  const totalWeight = weightedEdges.reduce((sum, edge) => sum + edge[2], 0);
  const community = new Map(sortedNodes.map((node) => [node, node]));
  let currentScore = modularity(community, weightedEdges, degrees, totalWeight);

  for (let iter = 0; iter < MAX_ITERATIONS; iter++) {
    let changed = false;
    for (const id of sortedNodes) {
      const neighbors = adj.get(id)!;
      if (neighbors.size === 0) continue;
      const current = community.get(id)!;
      const candidates = [...new Set([
        current,
        ...[...neighbors.keys()].map((neighbor) => community.get(neighbor)!),
      ])].sort();
      let best = current;
      let bestScore = currentScore;
      for (const candidate of candidates) {
        if (candidate === current) continue;
        community.set(id, candidate);
        const candidateScore = modularity(community, weightedEdges, degrees, totalWeight);
        if (
          candidateScore > bestScore + 1e-10 ||
          (Math.abs(candidateScore - bestScore) <= 1e-10 && candidate < best)
        ) {
          best = candidate;
          bestScore = candidateScore;
        }
      }
      community.set(id, best);
      if (best !== current) {
        currentScore = bestScore;
        changed = true;
      }
    }
    if (!changed) break;
  }

  // Remap stable community labels to contiguous 0-based cluster indices.
  const labelToCluster = new Map<string, number>();
  const clusters = new Map<string, number>();
  let nextCluster = 0;
  for (const id of sortedNodes) {
    const lbl = community.get(id)!;
    if (!labelToCluster.has(lbl)) {
      labelToCluster.set(lbl, nextCluster++);
    }
    clusters.set(id, labelToCluster.get(lbl)!);
  }

  return { clusters, count: nextCluster };
}
