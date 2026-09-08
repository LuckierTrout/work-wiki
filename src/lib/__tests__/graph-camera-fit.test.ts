import { describe, expect, it } from "vitest";
import {
  cameraStateToFitNodes,
  getCorrectionRatio,
  stableNodePosition,
  stableNodePositions,
} from "../graph-camera-fit";

describe("cameraStateToFitNodes", () => {
  it("fits the full framed graph at ratio 1 and centers it", () => {
    const state = cameraStateToFitNodes({
      nodes: [
        { framedX: 0, framedY: 0 },
        { framedX: 1, framedY: 0.5 },
      ],
      graphBBox: { x: [0, 1], y: [0, 0.5] },
      width: 800,
      height: 400,
    });
    expect(state).toEqual({ x: 0.5, y: 0.25, ratio: 1 });
    expect(getCorrectionRatio({ width: 800, height: 400 }, { width: 80, height: 40 })).toBe(2);
  });

  it("is invariant under viewport pixels and graph-coordinate scale", () => {
    const fit = (width: number, height: number, scale: number) => cameraStateToFitNodes({
      nodes: [{ framedX: 0.2, framedY: 0.1 }, { framedX: 0.7, framedY: 0.35 }],
      graphBBox: { x: [0, 80 * scale], y: [0, 40 * scale] },
      width,
      height,
    });
    expect(fit(800, 400, 1)).toEqual(fit(1600, 800, 100));
  });
});

describe("stableNodePosition", () => {
  it("gives uncached reduced-motion nodes distinct stable coordinates", () => {
    const origin = { x: 10, y: 4 };
    const alpha = stableNodePosition("alpha", origin);
    const beta = stableNodePosition("beta", origin);
    expect(alpha).not.toEqual(beta);
    expect(stableNodePosition("alpha", origin)).toEqual(alpha);
    expect(alpha.x).not.toBe(origin.x);
    expect(alpha.y).not.toBe(origin.y);
  });

  it("does not depend on API order and resolves every coordinate distinctly", () => {
    const origin = { x: 0, y: 0 };
    const ids = Array.from({ length: 1_000 }, (_, index) => `node-${index}`);
    const first = stableNodePositions(ids, origin);
    const second = stableNodePositions(ids.slice().reverse(), origin);
    expect(first).toEqual(second);
    expect(new Set([...first.values()].map((position) => `${position.x}:${position.y}`)).size).toBe(ids.length);
  });
});
