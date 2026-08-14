/**
 * Pure graph-relevance scoring shared by graph rendering and retrieval.
 *
 * The score intentionally exposes its evidence instead of collapsing every
 * relationship into an opaque similarity number:
 *   - explicit markdown link: 3
 *   - shared source URL: 4
 *   - Adamic-Adar common-neighbor signal: 1.5 x AA
 *   - matching page type: 1
 */

export interface GraphEvidenceNode {
  id: string;
  directTargets: readonly string[];
  sourceUrls: readonly string[];
  type?: string;
}

export interface WeightedGraphEdge {
  source: string;
  target: string;
  weight: number;
  signals: string[];
}

const DIRECT_LINK_WEIGHT = 3;
const SHARED_SOURCE_WEIGHT = 4;
const ADAMIC_ADAR_WEIGHT = 1.5;
const TYPE_AFFINITY_WEIGHT = 1;

function pairKey(a: string, b: string): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

function normalizedSources(values: readonly string[]): Set<string> {
  const result = new Set<string>();
  for (const value of values) {
    const trimmed = value.trim();
    if (!trimmed || trimmed === "text-paste" || trimmed === "upload" || trimmed === "email") {
      continue;
    }
    try {
      const parsed = new URL(trimmed);
      parsed.hash = "";
      result.add(parsed.toString().replace(/\/$/, ""));
    } catch {
      result.add(trimmed.toLocaleLowerCase());
    }
  }
  return result;
}

/** Build deterministic, undirected, evidence-bearing graph edges. */
export function buildWeightedGraphEdges(
  nodes: readonly GraphEvidenceNode[],
): WeightedGraphEdge[] {
  const sorted = [...nodes].sort((a, b) => a.id.localeCompare(b.id));
  const ids = new Set(sorted.map((node) => node.id));
  const direct = new Map(sorted.map((node) => [node.id, new Set<string>()]));
  for (const node of sorted) {
    for (const target of node.directTargets) {
      if (target === node.id || !ids.has(target)) continue;
      direct.get(node.id)?.add(target);
      direct.get(target)?.add(node.id);
    }
  }
  const sources = new Map(sorted.map((node) => [node.id, normalizedSources(node.sourceUrls)]));
  const directPairs = new Set<string>();
  for (const node of sorted) {
    for (const target of direct.get(node.id) ?? []) directPairs.add(pairKey(node.id, target));
  }

  const edges: WeightedGraphEdge[] = [];
  for (let left = 0; left < sorted.length; left += 1) {
    for (let right = left + 1; right < sorted.length; right += 1) {
      const a = sorted[left];
      const b = sorted[right];
      const signals: string[] = [];
      let weight = 0;

      if (directPairs.has(pairKey(a.id, b.id))) {
        weight += DIRECT_LINK_WEIGHT;
        signals.push("direct link");
      }

      const bSources = sources.get(b.id) ?? new Set<string>();
      const sharedSources = [...(sources.get(a.id) ?? [])].filter((source) => bSources.has(source));
      if (sharedSources.length > 0) {
        weight += SHARED_SOURCE_WEIGHT;
        signals.push(`shared source${sharedSources.length === 1 ? "" : "s"}: ${sharedSources.length}`);
      }

      const aNeighbors = direct.get(a.id) ?? new Set<string>();
      const bNeighbors = direct.get(b.id) ?? new Set<string>();
      let adamicAdar = 0;
      for (const neighbor of aNeighbors) {
        if (!bNeighbors.has(neighbor)) continue;
        const degree = direct.get(neighbor)?.size ?? 0;
        adamicAdar += 1 / Math.log(Math.max(2, degree));
      }
      if (adamicAdar > 0) {
        const contribution = ADAMIC_ADAR_WEIGHT * adamicAdar;
        weight += contribution;
        signals.push(`common-neighbor relevance: ${contribution.toFixed(2)}`);
      }

      if (a.type && b.type && a.type === b.type) {
        weight += TYPE_AFFINITY_WEIGHT;
        signals.push(`same page type: ${a.type}`);
      }

      if (weight <= 0) continue;
      edges.push({
        source: a.id,
        target: b.id,
        weight: Number(weight.toFixed(4)),
        signals,
      });
    }
  }
  return edges.sort(
    (a, b) => b.weight - a.weight || a.source.localeCompare(b.source) || a.target.localeCompare(b.target),
  );
}

/** Add the strongest one/two-hop graph neighbors without escaping allowedIds. */
export function expandGraphSeeds(
  seeds: readonly string[],
  edges: readonly WeightedGraphEdge[],
  allowedIds: ReadonlySet<string>,
  limit: number,
): string[] {
  const selected: string[] = [];
  const seen = new Set<string>();
  for (const seed of seeds) {
    if (!allowedIds.has(seed) || seen.has(seed)) continue;
    seen.add(seed);
    selected.push(seed);
    if (selected.length >= limit) return selected;
  }

  const frontier = new Map<string, number>();
  const scoreNeighbors = (origins: ReadonlySet<string>, decay: number) => {
    for (const edge of edges) {
      const aHit = origins.has(edge.source);
      const bHit = origins.has(edge.target);
      if (aHit === bHit) continue;
      const candidate = aHit ? edge.target : edge.source;
      if (!allowedIds.has(candidate) || seen.has(candidate)) continue;
      frontier.set(candidate, (frontier.get(candidate) ?? 0) + edge.weight * decay);
    }
  };

  scoreNeighbors(new Set(seen), 1);
  const firstHop = [...frontier.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  for (const [slug] of firstHop) {
    if (selected.length >= limit) break;
    seen.add(slug);
    selected.push(slug);
  }

  if (selected.length < limit) {
    frontier.clear();
    scoreNeighbors(new Set(selected), 0.5);
    for (const [slug] of [...frontier.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      if (selected.length >= limit) break;
      if (seen.has(slug)) continue;
      seen.add(slug);
      selected.push(slug);
    }
  }
  return selected;
}
