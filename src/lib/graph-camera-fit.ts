/**
 * Sigma camera fit: framed display coordinates for the center, graph
 * coordinates for the ratio. Matches `getCameraStateToFitViewportToNodes`.
 */

function hashId(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Id-stable coordinates for one uncached reduced-motion Graph node. */
export function stableNodePosition(
  id: string,
  origin: { x: number; y: number },
  salt = 0,
): { x: number; y: number } {
  const angleHash = hashId(`${id}\0angle\0${salt}`);
  const radiusHash = hashId(`${id}\0radius\0${salt}`);
  const angle = (angleHash / 0x1_0000_0000) * Math.PI * 2;
  const radius = 36 + (radiusHash / 0x1_0000_0000) * 220;
  return {
    x: origin.x + Math.cos(angle) * radius,
    y: origin.y + Math.sin(angle) * radius,
  };
}

/**
 * Resolve the vanishingly rare hash collision without making ordinary node
 * positions depend on API order or on which other nodes have cached layouts.
 */
export function stableNodePositions(
  ids: readonly string[],
  origin: { x: number; y: number },
): Map<string, { x: number; y: number }> {
  const positions = new Map<string, { x: number; y: number }>();
  const occupied = new Set<string>();
  for (const id of [...new Set(ids)].sort()) {
    let salt = 0;
    let position = stableNodePosition(id, origin, salt);
    let key = `${position.x}:${position.y}`;
    while (occupied.has(key)) {
      salt += 1;
      position = stableNodePosition(id, origin, salt);
      key = `${position.x}:${position.y}`;
    }
    occupied.add(key);
    positions.set(id, position);
  }
  return positions;
}

export function getCorrectionRatio(
  viewport: { width: number; height: number },
  graph: { width: number; height: number },
): number {
  const viewportRatio = Math.max(viewport.height, 1) / Math.max(viewport.width, 1);
  const graphRatio = (graph.height || 1) / (graph.width || 1);
  if ((viewportRatio < 1 && graphRatio > 1) || (viewportRatio > 1 && graphRatio < 1)) {
    return 1;
  }
  return Math.min(
    Math.max(graphRatio, 1 / graphRatio),
    Math.max(viewportRatio, 1 / viewportRatio),
  );
}

export function cameraStateToFitNodes(input: {
  nodes: Array<{ framedX: number; framedY: number }>;
  graphBBox: { x: [number, number]; y: [number, number] };
  width: number;
  height: number;
}): { x: number; y: number; ratio: number } {
  const graphWidth = input.graphBBox.x[1] - input.graphBBox.x[0] || 1;
  const graphHeight = input.graphBBox.y[1] - input.graphBBox.y[0] || 1;
  let framedMinX = Infinity;
  let framedMaxX = -Infinity;
  let framedMinY = Infinity;
  let framedMaxY = -Infinity;
  for (const node of input.nodes) {
    framedMinX = Math.min(framedMinX, node.framedX);
    framedMaxX = Math.max(framedMaxX, node.framedX);
    framedMinY = Math.min(framedMinY, node.framedY);
    framedMaxY = Math.max(framedMaxY, node.framedY);
  }
  if (!Number.isFinite(framedMinX)) {
    return { x: 0.5, y: 0.5, ratio: 1 };
  }
  const groupWidth = framedMaxX - framedMinX;
  const groupHeight = framedMaxY - framedMinY;
  const correction = getCorrectionRatio(
    { width: input.width, height: input.height },
    { width: graphWidth, height: graphHeight },
  );
  const smallestDimension = Math.max(Math.min(input.width, input.height), 1);
  const ratio = Math.max(
    (groupWidth * smallestDimension * correction) / Math.max(input.width, 1),
    (groupHeight * smallestDimension * correction) / Math.max(input.height, 1),
  );
  return {
    x: (framedMinX + framedMaxX) / 2,
    y: (framedMinY + framedMaxY) / 2,
    ratio: Math.max(ratio, 0.05),
  };
}
