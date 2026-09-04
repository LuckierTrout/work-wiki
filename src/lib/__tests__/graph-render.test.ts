import { describe, it, expect, vi } from "vitest";
import {
  nodeRadius,
  MIN_RADIUS,
  MAX_RADIUS,
  getColorPalette,
  DARK_PALETTE,
  stepPhysics,
  renderGraph,
  CURSOR_RING_GAP,
  connectionsLabel,
  type GraphNode,
  type GraphEdge,
  type RenderOptions,
} from "../graph-render";

function makeNode(overrides: Partial<GraphNode> & { id: string }): GraphNode {
  return {
    label: overrides.id,
    tenant: "yopedia",
    linkCount: 1,
    tags: [],
    cluster: 0,
    x: 0,
    y: 0,
    vx: 0,
    vy: 0,
    ...overrides,
  };
}

describe("graph-render", () => {
  describe("nodeRadius", () => {
    it("returns MIN_RADIUS for nodes with no links", () => {
      expect(nodeRadius(0)).toBe(MIN_RADIUS);
    });

    it("grows with link count", () => {
      expect(nodeRadius(4)).toBeGreaterThan(nodeRadius(1));
      expect(nodeRadius(10)).toBeGreaterThan(nodeRadius(4));
    });

    it("never exceeds MAX_RADIUS", () => {
      expect(nodeRadius(1000)).toBe(MAX_RADIUS);
      expect(nodeRadius(10_000)).toBe(MAX_RADIUS);
    });
  });

  /**
   * The wording the hover tooltip PAINTS and the keyboard cursor's live region
   * SPEAKS — one function since DW-595, because two copies of a pluralisation
   * are two ways for the seen and the announced description of one node to
   * disagree. The singular is the branch that only exists to be right: it is
   * unreachable from the plural cases, and "1 connections" is the exact defect
   * a shared helper is meant to make impossible.
   */
  describe("connectionsLabel", () => {
    it("pluralises everything but one", () => {
      expect(connectionsLabel({ linkCount: 0 })).toBe("0 connections");
      expect(connectionsLabel({ linkCount: 2 })).toBe("2 connections");
    });

    it("says '1 connection', not '1 connections'", () => {
      expect(connectionsLabel({ linkCount: 1 })).toBe("1 connection");
    });
  });

  describe("getColorPalette", () => {
    it("returns DARK_PALETTE when window is undefined (SSR)", () => {
      // vitest runs in node by default, so window is undefined here
      expect(getColorPalette()).toBe(DARK_PALETTE);
    });
  });

  describe("stepPhysics", () => {
    it("two overlapping nodes produces repulsion (nodes move apart)", () => {
      const a = makeNode({ id: "a", x: 100, y: 100 });
      const b = makeNode({ id: "b", x: 101, y: 100 });
      const nodes = [a, b];
      const edges: GraphEdge[] = [];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      stepPhysics(nodes, edges, nodeMap, 100, 100);

      // After repulsion, nodes should have moved apart on the x axis
      expect(a.x).toBeLessThan(100);
      expect(b.x).toBeGreaterThan(101);
    });

    it("connected distant nodes produces attraction (nodes move closer)", () => {
      const a = makeNode({ id: "a", x: 0, y: 200 });
      const b = makeNode({ id: "b", x: 400, y: 200 });
      const nodes = [a, b];
      const edges: GraphEdge[] = [{ source: "a", target: "b" }];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // Run several steps so attraction can dominate over repulsion at distance
      for (let i = 0; i < 50; i++) {
        stepPhysics(nodes, edges, nodeMap, 200, 200);
      }

      // Nodes should be closer together than they started
      const dist = Math.abs(a.x - b.x);
      expect(dist).toBeLessThan(400);
    });

    it("returns totalVelocity > 0 when nodes have forces, approaches 0 over many iterations", () => {
      const a = makeNode({ id: "a", x: 100, y: 100 });
      const b = makeNode({ id: "b", x: 102, y: 100 });
      const nodes = [a, b];
      const edges: GraphEdge[] = [{ source: "a", target: "b" }];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));

      // First step should have non-zero velocity
      const first = stepPhysics(nodes, edges, nodeMap, 100, 100);
      expect(first.totalVelocity).toBeGreaterThan(0);

      // Run many iterations — system should settle
      let last = first;
      for (let i = 0; i < 500; i++) {
        last = stepPhysics(nodes, edges, nodeMap, 100, 100);
      }
      expect(last.totalVelocity).toBeLessThan(first.totalVelocity);
      expect(last.totalVelocity).toBeLessThan(1);
    });

    it("single node applies center gravity (node drifts toward center)", () => {
      const node = makeNode({ id: "solo", x: 300, y: 300 });
      const nodes = [node];
      const edges: GraphEdge[] = [];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const cx = 100;
      const cy = 100;

      for (let i = 0; i < 100; i++) {
        stepPhysics(nodes, edges, nodeMap, cx, cy);
      }

      // Node should have drifted toward (cx, cy)
      expect(Math.abs(node.x - cx)).toBeLessThan(200);
      expect(Math.abs(node.y - cy)).toBeLessThan(200);
      // More specifically, it should be much closer than the starting 300
      expect(Math.abs(node.x - cx)).toBeLessThan(50);
      expect(Math.abs(node.y - cy)).toBeLessThan(50);
    });
  });

  describe("renderGraph", () => {
    /** Create a minimal mock CanvasRenderingContext2D sufficient for renderGraph */
    function mockCtx(): CanvasRenderingContext2D {
      const noop = vi.fn();
      return {
        clearRect: vi.fn(),
        fillRect: vi.fn(),
        fillText: vi.fn(),
        strokeStyle: "",
        fillStyle: "",
        lineWidth: 0,
        font: "",
        textAlign: "",
        beginPath: noop,
        moveTo: noop,
        lineTo: noop,
        stroke: noop,
        fill: noop,
        arc: noop,
        closePath: noop,
        roundRect: noop,
        measureText: vi.fn(() => ({ width: 80 })),
      } as unknown as CanvasRenderingContext2D;
    }

    function baseOpts(overrides?: Partial<RenderOptions>): RenderOptions {
      return {
        nodes: [],
        edges: [],
        nodeMap: new Map(),
        ctx: mockCtx(),
        width: 800,
        height: 600,
        palette: DARK_PALETTE,
        hovered: null,
        mouse: { x: 0, y: 0 },
        clusterCount: 0,
        ...overrides,
      };
    }

    it("renders empty graph without throwing", () => {
      const opts = baseOpts();
      expect(() => renderGraph(opts)).not.toThrow();
      // Should still clear and fill background
      expect(opts.ctx.clearRect).toHaveBeenCalledWith(0, 0, 800, 600);
      expect(opts.ctx.fillRect).toHaveBeenCalledWith(0, 0, 800, 600);
    });

    it("calls clearRect and fillRect for background", () => {
      const ctx = mockCtx();
      const opts = baseOpts({ ctx });
      renderGraph(opts);
      expect(ctx.clearRect).toHaveBeenCalledTimes(1);
      expect(ctx.fillRect).toHaveBeenCalledTimes(1);
    });

    it("renders with a hovered node without throwing", () => {
      const hovered = makeNode({ id: "hover-target", x: 100, y: 100, linkCount: 3 });
      const nodes = [
        hovered,
        makeNode({ id: "other", x: 200, y: 200 }),
      ];
      const nodeMap = new Map(nodes.map((n) => [n.id, n]));
      const opts = baseOpts({
        nodes,
        nodeMap,
        hovered,
        mouse: { x: 120, y: 80 },
        clusterCount: 1,
      });
      expect(() => renderGraph(opts)).not.toThrow();
      // Should have drawn tooltip text
      expect(opts.ctx.fillText).toHaveBeenCalled();
    });

    /**
     * The keyboard cursor's visible half (DW-595).
     *
     * `useGraphSimulation` announces the cursor through a live region, which is
     * what a screen-reader user gets; a SIGHTED keyboard user gets only what is
     * painted, so "there is a ring, and it is around the cursor's node" is the
     * whole of that reader's feedback.
     *
     * `arc` is spied SEPARATELY from the shared `mockCtx` noop, because the
     * node pass and the cluster legend both call it: a bare `toHaveBeenCalled`
     * on the shared spy would be satisfied by the nodes alone. The reads below
     * therefore filter the calls by radius, which is also the property that
     * distinguishes a ring from a node — see `CURSOR_RING_GAP`.
     */
    describe("keyboard cursor ring", () => {
      const cursorNode = makeNode({ id: "cursor", x: 140, y: 220, linkCount: 3 });
      const otherNode = makeNode({ id: "other", x: 300, y: 300, linkCount: 3 });
      const ringRadius = nodeRadius(cursorNode.linkCount) + CURSOR_RING_GAP;

      function arcSpy() {
        return vi.fn();
      }

      function ctxWithArc(arc: ReturnType<typeof arcSpy>): CanvasRenderingContext2D {
        return Object.assign(mockCtx(), { arc });
      }

      /** Every `arc` call made at exactly the cursor's centre. */
      function arcsAt(
        arc: ReturnType<typeof arcSpy>,
        x: number,
        y: number,
      ): number[] {
        return arc.mock.calls
          .filter((call) => call[0] === x && call[1] === y)
          .map((call) => call[2] as number);
      }

      /**
       * The position of an `arc` call in the whole draw sequence, or `-1`.
       *
       * ORDER is a real property here, not bookkeeping: the node pass fills
       * each node opaquely, so a ring stroked before its node is painted over
       * by it and the cursor becomes invisible with every assertion about
       * radius and centre still green. One spy sees every arc the scene makes,
       * so their indices are directly comparable.
       */
      function arcIndex(
        arc: ReturnType<typeof arcSpy>,
        x: number,
        y: number,
        radius: number,
      ): number {
        return arc.mock.calls.findIndex(
          (call) => call[0] === x && call[1] === y && call[2] === radius,
        );
      }

      it("strokes a ring OUTSIDE the cursor node's own radius", () => {
        const arc = arcSpy();
        const nodes = [cursorNode, otherNode];
        renderGraph(
          baseOpts({
            ctx: ctxWithArc(arc),
            nodes,
            nodeMap: new Map(nodes.map((n) => [n.id, n])),
            cursor: cursorNode,
          }),
        );

        const radii = arcsAt(arc, cursorNode.x, cursorNode.y);
        // The node itself is one of them; the ring is the larger.
        expect(
          radii,
          "nothing was drawn at the cursor node's centre at all",
        ).toContain(nodeRadius(cursorNode.linkCount));
        expect(
          radii,
          `no arc at (${cursorNode.x}, ${cursorNode.y}) with the ring radius ${ringRadius} — a ` +
            "sighted keyboard user has no indication of where the cursor is (DW-595)",
        ).toContain(ringRadius);
        expect(ringRadius).toBeGreaterThan(nodeRadius(cursorNode.linkCount));
      });

      it("strokes the ring after every node has been filled", () => {
        const arc = arcSpy();
        // `otherNode` is LAST in the array, so its fill is the last thing the
        // node pass draws — a ring emitted before the loop, or inside it,
        // lands at a lower index than this and the case fails.
        const nodes = [cursorNode, otherNode];
        renderGraph(
          baseOpts({
            ctx: ctxWithArc(arc),
            nodes,
            nodeMap: new Map(nodes.map((n) => [n.id, n])),
            cursor: cursorNode,
          }),
        );

        const ringAt = arcIndex(arc, cursorNode.x, cursorNode.y, ringRadius);
        expect(ringAt, "no ring arc to order against").toBeGreaterThan(-1);
        for (const n of nodes) {
          const nodeAt = arcIndex(arc, n.x, n.y, nodeRadius(n.linkCount));
          expect(nodeAt, `node ${n.id} was never drawn`).toBeGreaterThan(-1);
          expect(
            ringAt,
            `the cursor ring is stroked BEFORE node ${n.id} is filled, so an overlapping node ` +
              "paints over it and a sighted keyboard user sees no cursor at all (DW-595)",
          ).toBeGreaterThan(nodeAt);
        }
      });

      it("rings the cursor node and no other node", () => {
        const arc = arcSpy();
        const nodes = [cursorNode, otherNode];
        renderGraph(
          baseOpts({
            ctx: ctxWithArc(arc),
            nodes,
            nodeMap: new Map(nodes.map((n) => [n.id, n])),
            cursor: cursorNode,
          }),
        );

        expect(
          arcsAt(arc, otherNode.x, otherNode.y),
          "a ring-sized arc was drawn at a node the cursor is not on",
        ).not.toContain(nodeRadius(otherNode.linkCount) + CURSOR_RING_GAP);
      });

      it("draws no ring when there is no cursor", () => {
        const arc = arcSpy();
        const nodes = [cursorNode, otherNode];
        renderGraph(
          baseOpts({
            ctx: ctxWithArc(arc),
            nodes,
            nodeMap: new Map(nodes.map((n) => [n.id, n])),
            cursor: null,
          }),
        );

        expect(
          arcsAt(arc, cursorNode.x, cursorNode.y),
          "a ring was drawn with no cursor passed — the pointer path would then paint a focus " +
            "indication for a cursor nobody is moving",
        ).not.toContain(ringRadius);
      });

      it("draws no ring when `cursor` is omitted entirely", () => {
        // The pre-DW-595 call shape: every existing caller of `renderGraph`
        // passes no `cursor` at all, and an optional field that defaulted to
        // anything but "no ring" would repaint the whole pointer path.
        const arc = arcSpy();
        const nodes = [cursorNode];
        const opts = baseOpts({
          ctx: ctxWithArc(arc),
          nodes,
          nodeMap: new Map(nodes.map((n) => [n.id, n])),
        });
        delete opts.cursor;
        renderGraph(opts);

        expect(arcsAt(arc, cursorNode.x, cursorNode.y)).not.toContain(ringRadius);
      });
    });
  });
});
