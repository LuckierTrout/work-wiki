"use client";

import { useEffect, useRef, useState, useCallback, type RefObject } from "react";
import type { AppRouterInstance } from "next/dist/shared/lib/app-router-context.shared-runtime";
import { detectCommunities } from "@/lib/graph";
import {
  type GraphNode,
  type GraphEdge,
  type GraphData,
  type ColorPalette,
  DARK_PALETTE,
  VELOCITY_THRESHOLD,
  nodeRadius,
  connectionsLabel,
  getColorPalette,
  stepPhysics,
  renderGraph,
} from "@/lib/graph-render";

export interface UseGraphSimulationReturn {
  loading: boolean;
  empty: boolean;
  fetchError: string | null;
  canvasBg: string;
  handleMouseMove: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  handleMouseLeave: () => void;
  handleClick: (e: React.MouseEvent<HTMLCanvasElement>) => void;
  /** Arrows move the keyboard cursor; Enter/Space activate it. */
  handleKeyDown: (e: React.KeyboardEvent<HTMLCanvasElement>) => void;
  handleFocus: () => void;
  handleBlur: () => void;
  /**
   * What the canvas's sibling live region should say right now — the focused
   * node's label, its connection count, its position in the node set, and the
   * key that opens it. Empty while the canvas is unfocused or has no nodes.
   *
   * State, not a ref, because the announcement is RENDERED: a live region only
   * announces text that changes in the DOM.
   */
  cursorAnnouncement: string;
}

/**
 * What the live region says about the node under the keyboard cursor.
 *
 * Position is spelled "i of N" because the graph is a picture: a reader who
 * cannot see it has no other way to know how many nodes there are or how far
 * through them the cursor has moved. The key is named because `role="img"`
 * advertises no interaction of its own.
 *
 * The connection count comes from `connectionsLabel`, the same function the
 * hover tooltip paints, so the spoken and the drawn description of one node
 * cannot word it two ways.
 */
function describeCursor(
  node: GraphNode,
  index: number,
  total: number,
): string {
  return `${node.label}, ${connectionsLabel(node)}, ${index + 1} of ${total}. Press Enter to open.`;
}

export function useGraphSimulation(
  canvasRef: RefObject<HTMLCanvasElement | null>,
  router: AppRouterInstance,
  /** Optional scope ("mine"/"owner:<h>") → fetches that silo's graph; undefined = commons. */
  scope?: string,
): UseGraphSimulationReturn {
  const dataRef = useRef<GraphData | null>(null);
  const animRef = useRef<number>(0);
  const paletteRef = useRef<ColorPalette>(DARK_PALETTE);
  const hoveredRef = useRef<GraphNode | null>(null);
  const mouseRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const clusterCountRef = useRef<number>(0);
  const nodeMapRef = useRef<Map<string, GraphNode>>(new Map());
  /**
   * The keyboard cursor: an INDEX into `dataRef.current.nodes`, not a node
   * reference. The physics step mutates nodes in place and the fetch replaces
   * the array wholesale, so an index is the thing that stays meaningful across
   * a frame — and `nodeAt()` below is the single place that resolves it, so a
   * stale index can never become a node from a previous fetch.
   */
  const cursorIndexRef = useRef<number | null>(null);
  /** Is the canvas itself focused? Gates BOTH the ring and the announcement. */
  const focusedRef = useRef<boolean>(false);

  const [loading, setLoading] = useState(true);
  const [empty, setEmpty] = useState(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [canvasBg, setCanvasBg] = useState<string>(DARK_PALETTE.bg);
  const [cursorAnnouncement, setCursorAnnouncement] = useState<string>("");

  /**
   * The node the cursor index names, or `null` when it names nothing — no data,
   * no cursor, or an index the current node array is too short for. Every read
   * of the cursor goes through here.
   */
  const nodeAt = useCallback((index: number | null): GraphNode | null => {
    const nodes = dataRef.current?.nodes;
    if (!nodes || index === null) return null;
    return nodes[index] ?? null;
  }, []);

  // Simulation + render loop
  const simulate = useCallback(() => {
    const data = dataRef.current;
    const canvas = canvasRef.current;
    if (!data || !canvas) return;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const palette = paletteRef.current;
    // Use CSS dimensions (not canvas.width/height which are DPR-scaled)
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.width / dpr;
    const H = canvas.height / dpr;
    const cx = W / 2;
    const cy = H / 2;
    const { nodes, edges } = data;
    const nodeMap = nodeMapRef.current;

    // --- Physics step ---
    const { totalVelocity } = stepPhysics(nodes, edges, nodeMap, cx, cy);

    // --- Render ---
    renderGraph({
      nodes,
      edges,
      nodeMap,
      ctx,
      width: W,
      height: H,
      palette,
      hovered: hoveredRef.current,
      mouse: mouseRef.current,
      clusterCount: clusterCountRef.current,
      // Only while the canvas holds focus: a ring left behind on blur would be
      // a focus indication pointing at an element that no longer has focus.
      cursor: focusedRef.current ? nodeAt(cursorIndexRef.current) : null,
    });

    // Continue or stop
    if (totalVelocity > VELOCITY_THRESHOLD) {
      animRef.current = requestAnimationFrame(simulate);
    }
  }, [canvasRef, nodeAt]);

  /**
   * Redraw once, now.
   *
   * The simulation STOPS once it settles (`totalVelocity <= VELOCITY_THRESHOLD`
   * ends the `requestAnimationFrame` chain), so a cursor move on a settled
   * graph would change nothing on screen without this. Same cancel-then-request
   * shape as `handleMouseMove`'s hover redraw, for the same reason: a frame may
   * already be pending, and two queued frames would draw the same scene twice.
   */
  const redraw = useCallback(() => {
    if (!dataRef.current || !canvasRef.current) return;
    cancelAnimationFrame(animRef.current);
    animRef.current = requestAnimationFrame(simulate);
  }, [simulate, canvasRef]);

  // Fetch graph data (re-fetches when the scope lens changes). A `cancelled`
  // guard drops a stale in-flight response when the scope toggles again, so an
  // older request can't overwrite a newer one's data.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setEmpty(false);
    setFetchError(null);
    // The cursor points into the node array this fetch is about to replace, so
    // the whole of its state is dropped BEFORE the request rather than after:
    // between the two, a key press would move a cursor through the previous
    // lens's nodes and Enter would open a page that is not in the graph any
    // more. All THREE outcomes of the fetch need this — the empty graph and the
    // error both render a `<p>` in place of the canvas, so a cursor or a
    // `focusedRef` left standing would survive on a page with no canvas at all.
    cursorIndexRef.current = null;
    focusedRef.current = false;
    setCursorAnnouncement("");
    fetch(`/api/wiki/graph${scope ? `?scope=${encodeURIComponent(scope)}` : ""}`)
      .then((r) => {
        if (!r.ok) throw new Error(`Graph API error: ${r.status}`);
        return r.json();
      })
      .then(
        (raw: {
          nodes: {
            id: string;
            label: string;
            tenant?: string;
            linkCount?: number;
            tags?: string[];
          }[];
          edges: GraphEdge[];
        }) => {
          if (cancelled) return;
          if (!raw.nodes || raw.nodes.length === 0) {
            setEmpty(true);
            setLoading(false);
            return;
          }
          // Initialize positions randomly
          const nodes: GraphNode[] = raw.nodes.map((n) => ({
            id: n.id,
            label: n.label,
            tenant: n.tenant ?? "yopedia",
            linkCount: n.linkCount ?? 0,
            tags: n.tags ?? [],
            cluster: 0,
            x: Math.random() * 400 + 100,
            y: Math.random() * 300 + 100,
            vx: 0,
            vy: 0,
          }));

          // Community detection
          const nodeIds = raw.nodes.map((n) => n.id);
          const edgePairs: [string, string, number?][] = (raw.edges ?? []).map(
            (e: GraphEdge & { weight?: number }) =>
              [e.source, e.target, e.weight] as [string, string, number?],
          );
          const { clusters, count } = detectCommunities({
            nodes: nodeIds,
            edges: edgePairs,
          });
          for (const node of nodes) {
            node.cluster = clusters.get(node.id) ?? 0;
          }
          clusterCountRef.current = count;

          dataRef.current = { nodes, edges: raw.edges ?? [] };
          nodeMapRef.current = new Map(nodes.map((n) => [n.id, n]));
          // Re-asserted against the data that has just landed. The clears at
          // the top of the effect ran before the request; anything that touched
          // the cursor while it was in flight — a key press on the canvas the
          // PREVIOUS lens was still rendering — would otherwise leave an index
          // into an array that no longer exists.
          cursorIndexRef.current = null;
          setCursorAnnouncement("");
          setLoading(false);
        },
      )
      .catch((err) => {
        if (cancelled) return;
        setFetchError(String(err));
        setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [scope]);

  // Detect color scheme and listen for changes
  useEffect(() => {
    const palette = getColorPalette();
    paletteRef.current = palette;
    setCanvasBg(palette.bg);

    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handleChange = () => {
      const newPalette = getColorPalette();
      paletteRef.current = newPalette;
      setCanvasBg(newPalette.bg);
      // Re-trigger a render frame if simulation has stopped
      if (dataRef.current && canvasRef.current) {
        cancelAnimationFrame(animRef.current);
        animRef.current = requestAnimationFrame(simulate);
      }
    };
    mql.addEventListener("change", handleChange);
    return () => mql.removeEventListener("change", handleChange);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Start simulation when data is ready
  useEffect(() => {
    if (!loading && !empty && dataRef.current) {
      animRef.current = requestAnimationFrame(simulate);
    }
    return () => cancelAnimationFrame(animRef.current);
  }, [loading, empty, simulate]);

  // Handle canvas resizing (HiDPI-aware)
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const resizeCanvas = () => {
      const parent = canvas.parentElement;
      if (parent) {
        const dpr = window.devicePixelRatio || 1;
        const w = parent.clientWidth;
        const h = 560;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = `${w}px`;
        canvas.style.height = `${h}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) {
          ctx.setTransform(1, 0, 0, 1, 0, 0);
          ctx.scale(dpr, dpr);
        }
        // Trigger a re-render after resize so content redraws at new resolution
        if (dataRef.current) {
          cancelAnimationFrame(animRef.current);
          animRef.current = requestAnimationFrame(simulate);
        }
      }
    };
    resizeCanvas();
    window.addEventListener("resize", resizeCanvas);
    return () => window.removeEventListener("resize", resizeCanvas);
  }, [loading, simulate, canvasRef]);

  // Mousemove handler — hover detection, cursor change, tooltip trigger
  const handleMouseMove = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const data = dataRef.current;
      const canvas = canvasRef.current;
      if (!data || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      mouseRef.current = { x: mx, y: my };

      let found: GraphNode | null = null;
      for (const n of data.nodes) {
        const r = nodeRadius(n.linkCount);
        const dx = n.x - mx;
        const dy = n.y - my;
        if (dx * dx + dy * dy <= (r + 4) ** 2) {
          found = n;
          break;
        }
      }

      const prev = hoveredRef.current;
      hoveredRef.current = found;
      canvas.style.cursor = found ? "pointer" : "default";

      // If hover state changed, trigger a re-render even if simulation settled
      if (prev?.id !== found?.id) {
        cancelAnimationFrame(animRef.current);
        animRef.current = requestAnimationFrame(simulate);
      }
    },
    [simulate, canvasRef],
  );

  // Mouseleave — clear hover
  const handleMouseLeave = useCallback(() => {
    const canvas = canvasRef.current;
    if (hoveredRef.current) {
      hoveredRef.current = null;
      if (canvas) canvas.style.cursor = "default";
      cancelAnimationFrame(animRef.current);
      animRef.current = requestAnimationFrame(simulate);
    }
  }, [simulate, canvasRef]);

  /**
   * THE activation function — the only place this hook navigates.
   *
   * Both input paths end here: `handleClick` after hit-testing a pointer
   * position, and `handleKeyDown` after resolving the keyboard cursor. Keeping
   * the URL in one expression is what makes "Enter opens the page a click
   * opens" a property of the code rather than of two copies staying in step.
   */
  const openNode = useCallback(
    (node: GraphNode) => {
      router.push(`/u/${node.tenant}/${node.id}`);
    },
    [router],
  );

  // Click handler — hit-test the pointer, then activate
  const handleClick = useCallback(
    (e: React.MouseEvent<HTMLCanvasElement>) => {
      const data = dataRef.current;
      const canvas = canvasRef.current;
      if (!data || !canvas) return;
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      for (const n of data.nodes) {
        const r = nodeRadius(n.linkCount);
        const dx = n.x - mx;
        const dy = n.y - my;
        if (dx * dx + dy * dy <= (r + 4) ** 2) {
          openNode(n);
          return;
        }
      }
    },
    [openNode, canvasRef],
  );

  /**
   * Move the cursor by `delta`, WRAPPING at both ends, and announce where it
   * landed.
   *
   * Wrapping rather than clamping: the node order is the API's, which carries
   * no meaning a reader could use to know they are at "the end", so a silently
   * dead arrow key would read as a broken control rather than as a boundary.
   */
  const moveCursor = useCallback(
    (delta: number) => {
      const nodes = dataRef.current?.nodes;
      if (!nodes || nodes.length === 0) return;
      const total = nodes.length;
      const from = cursorIndexRef.current;
      // A first arrow press with no cursor yet lands on the first node rather
      // than on "one past nothing".
      const next = from === null ? 0 : (((from + delta) % total) + total) % total;
      cursorIndexRef.current = next;
      setCursorAnnouncement(describeCursor(nodes[next], next, total));
      redraw();
    },
    [redraw],
  );

  // Focus — put the cursor on a node and say which one it is
  const handleFocus = useCallback(() => {
    const nodes = dataRef.current?.nodes;
    focusedRef.current = true;
    // No data yet, or an empty graph: no cursor, nothing to announce. The
    // canvas is still a focus stop, so this has to be a quiet no-op rather than
    // a throw on `nodes[0]`.
    if (!nodes || nodes.length === 0) return;
    if (cursorIndexRef.current === null) cursorIndexRef.current = 0;
    const index = Math.min(cursorIndexRef.current, nodes.length - 1);
    cursorIndexRef.current = index;
    setCursorAnnouncement(describeCursor(nodes[index], index, nodes.length));
    redraw();
  }, [redraw]);

  /**
   * Blur — stop drawing the ring and empty the live region.
   *
   * The INDEX survives, so refocusing returns to the node the reader left off
   * on; only its two observable effects are withdrawn. Emptying the region is
   * also what makes the next focus announce at all: a live region re-announces
   * on CHANGE, and returning to the same node would otherwise write the same
   * string it already held.
   */
  const handleBlur = useCallback(() => {
    focusedRef.current = false;
    setCursorAnnouncement("");
    redraw();
  }, [redraw]);

  // Keydown — arrows move the cursor, Enter/Space activate it
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLCanvasElement>) => {
      const nodes = dataRef.current?.nodes;
      if (!nodes || nodes.length === 0) return;

      // A held modifier means the press belongs to the BROWSER, not to this
      // canvas: Alt+ArrowLeft is Back, Cmd/Ctrl+Enter opens in a new tab,
      // Ctrl+ArrowRight is a word jump. Claiming those would move the cursor
      // and cancel the shortcut in one go. Plain Shift is deliberately still
      // handled — it carries no browser shortcut on any of these keys, and
      // Shift+Space is an ordinary way to activate.
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      switch (e.key) {
        case "ArrowRight":
        case "ArrowDown":
          // `preventDefault` on the arrows is what stops the page scrolling
          // underneath a reader who is moving the cursor.
          e.preventDefault();
          moveCursor(1);
          return;
        case "ArrowLeft":
        case "ArrowUp":
          e.preventDefault();
          moveCursor(-1);
          return;
        case "Enter":
        case " ": {
          const node = nodeAt(cursorIndexRef.current);
          // No cursor means nothing is selected to open — and an unhandled key
          // must keep its default, so the guard comes before `preventDefault`.
          if (!node) return;
          e.preventDefault();
          // A HELD activation key auto-repeats, and every repeat would be
          // another `router.push` of the same route. The press is still ours —
          // hence the `preventDefault` above — it just does not navigate twice.
          // Arrows repeat normally: that is how a reader crosses a large graph.
          if (e.repeat) return;
          openNode(node);
          return;
        }
        default:
          // Every other key is the browser's and the page's business: Tab must
          // still leave, and a shortcut listening above must still hear it.
          return;
      }
    },
    [moveCursor, nodeAt, openNode],
  );

  return {
    loading,
    empty,
    fetchError,
    canvasBg,
    handleMouseMove,
    handleMouseLeave,
    handleClick,
    handleKeyDown,
    handleFocus,
    handleBlur,
    cursorAnnouncement,
  };
}
