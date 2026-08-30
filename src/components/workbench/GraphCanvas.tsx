"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { send, writeFailure } from "@/lib/workbench-request";
import { GRAPH_NARROW_COPY, workbenchMode } from "@/lib/workbench-modes";
import { STRONG_EDGE_WEIGHT } from "@/lib/graph-relevance";
import type { GraphEdge, GraphNode } from "@/lib/graph-build";
import type { CommunityInfo } from "@/lib/graph-louvain";
import { COMMUNITY_PALETTE, communityColor } from "@/lib/graph-louvain";
import type { WorkbenchInsight } from "@/lib/graph-surprise";
import {
  readStoredGraphLayout,
  writeStoredGraphLayout,
} from "@/lib/workbench-state";
import { RESEARCH_CREATE_READ_ONLY_COPY, researchWikiId } from "@/lib/research-panel";
import { selectionFromContentPath, type TreeSelection } from "@/lib/workbench-tree";
import { cameraStateToFitNodes, stableNodePositions } from "@/lib/graph-camera-fit";
import { DeepResearchConfirm } from "./DeepResearchConfirm";

export interface GraphCanvasProps {
  wikiId: string;
  readOnly?: boolean;
  active?: boolean;
  dataVersion?: number;
  onDockPreview: (selection: TreeSelection) => void;
  onOpenResearch?: (projectId: string) => void;
}

interface GraphResponse {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  communities?: CommunityInfo[];
  communityBySlug?: Record<string, number>;
  types?: Array<{ id: string; label: string; count: number }>;
  insights?: WorkbenchInsight[];
  prefill?: { limit: number; attempted: number; applied: number; failed: number; remaining: number };
}

type ColorMode = "type" | "community";

/**
 * Why **Dismiss** refuses on a read-only deployment (DW-531).
 *
 * The CLIENT mirror of `READ_ONLY_REFUSAL.graphInsightDismiss` — what
 * `POST /api/graph/insights` answers — character-identical to it and pinned by
 * `read-only-copy-parity.test.ts`. Exported because it is the sentence the
 * refused control POINTS AT through `aria-describedby`.
 *
 * NOT the sentence the insight list's other button carries. **Deep Research**
 * stands in front of `POST /api/research` and names
 * {@link RESEARCH_CREATE_READ_ONLY_COPY} instead: two controls in one card, two
 * doors, two sentences — the policy the DW-386 review settled on.
 *
 * Copy says work-wiki; the runtime identifier stays `YOPEDIA_READONLY`.
 */
export const GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY =
  "Graph insights cannot be dismissed while this deployment is read-only.";

const TYPE_PALETTE = COMMUNITY_PALETTE;

function typeColor(type: string | undefined): string {
  const key = type?.trim() || "page";
  let hash = 0;
  for (let i = 0; i < key.length; i += 1) hash = (hash * 31 + key.charCodeAt(i)) >>> 0;
  return TYPE_PALETTE[hash % TYPE_PALETTE.length];
}

function prefersReducedMotion(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

export function GraphCanvas({
  wikiId,
  readOnly = false,
  active = true,
  dataVersion = 0,
  onDockPreview,
  onOpenResearch,
}: GraphCanvasProps) {
  const empty = workbenchMode("graph").emptyState ?? "No graph yet. Ingest sources to build one.";
  const containerRef = useRef<HTMLDivElement | null>(null);
  const sigmaRef = useRef<{
    kill: () => void;
    refresh: () => void;
    getGraph: () => import("graphology").default;
    getNodeDisplayData: (node: string) => { x: number; y: number } | undefined;
    getDimensions: () => { width: number; height: number };
    getBBox: () => { x: [number, number]; y: [number, number] };
    getCustomBBox: () => { x: [number, number]; y: [number, number] } | null;
    getCamera: () => {
      getState: () => { x: number; y: number; ratio: number };
      setState: (state: { x: number; y: number; ratio: number }) => void;
      animatedZoom: (opts: { duration: number }) => void;
      animatedUnzoom: (opts: { duration: number }) => void;
      animate: (state: { x: number; y: number; ratio: number }, opts: { duration: number }) => void;
    };
  } | null>(null);
  const graphRef = useRef<import("graphology").default | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [nodes, setNodes] = useState<GraphNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [communities, setCommunities] = useState<CommunityInfo[]>([]);
  const [communityBySlug, setCommunityBySlug] = useState<Record<string, number>>({});
  const [types, setTypes] = useState<Array<{ id: string; label: string; count: number }>>([]);
  const [insights, setInsights] = useState<WorkbenchInsight[]>([]);
  const [prefill, setPrefill] = useState<GraphResponse["prefill"]>(undefined);
  const [colorMode, setColorMode] = useState<ColorMode>("community");
  const [showInsights, setShowInsights] = useState(true);
  const hoveredRef = useRef<string | null>(null);
  const [selectedInsight, setSelectedInsight] = useState<string | null>(null);
  const selectedRef = useRef<WorkbenchInsight | null>(null);
  const [research, setResearch] = useState<WorkbenchInsight | null>(null);
  const [researchBusy, setResearchBusy] = useState(false);
  const [researchError, setResearchError] = useState<string | null>(null);
  const loadSeq = useRef(0);
  const researchSeq = useRef(0);
  const wikiScope = useRef(wikiId);
  /**
   * One id per DOOR, not one per canvas.
   *
   * **Dismiss** meets `POST /api/graph/insights` and **Deep Research** meets
   * `POST /api/research`, so a single shared note would announce one door's
   * refusal beside the other's control. Both are rendered only while `readOnly`
   * AND only while an insight of the matching kind is listed, so the attribute
   * is never set without a node of that id to resolve.
   */
  const dismissNoteId = useId();
  const researchNoteId = useId();

  useEffect(() => {
    wikiScope.current = wikiId;
    researchSeq.current += 1;
    setResearch(null);
    setResearchBusy(false);
    setResearchError(null);
  }, [wikiId]);

  const load = useCallback(async () => {
    const seq = ++loadSeq.current;
    try {
      const body = await send<GraphResponse>("/api/graph/workbench", { method: "GET" });
      if (seq !== loadSeq.current) return;
      setNodes(body.nodes ?? []);
      setEdges(body.edges ?? []);
      setCommunities(body.communities ?? []);
      setCommunityBySlug(body.communityBySlug ?? {});
      setTypes(body.types ?? []);
      setInsights(body.insights ?? []);
      setPrefill(body.prefill);
      setError(null);
    } catch (cause) {
      if (seq !== loadSeq.current) return;
      setNodes([]);
      setEdges([]);
      setCommunities([]);
      setCommunityBySlug({});
      setTypes([]);
      setInsights([]);
      setPrefill(undefined);
      setError(cause instanceof Error ? cause.message : "Couldn’t load Graph.");
    }
  }, []);

  useEffect(() => {
    if (!active) return;
    void load();
  }, [active, load, dataVersion]);

  const selected = insights.find((insight) => insight.id === selectedInsight) ?? null;
  selectedRef.current = selected;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || nodes.length === 0) {
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
      return;
    }
    let cancelled = false;
    const reduced = prefersReducedMotion();

    void (async () => {
      try {
      const [{ default: Graph }, { default: Sigma }, forceAtlas2Mod] = await Promise.all([
        import("graphology"),
        import("sigma"),
        import("graphology-layout-forceatlas2"),
      ]);
      if (cancelled || !containerRef.current) return;
      sigmaRef.current?.kill();
      const graph = new Graph({ type: "undirected", allowSelfLoops: false });
      const cached = readStoredGraphLayout();
      const cachedOrigin = Object.values(cached.positions)[0] ?? { x: 0, y: 0 };
      const reducedPositions = stableNodePositions(
        nodes.filter((node) => !cached.positions[node.id]).map((node) => node.id),
        cachedOrigin,
      );
      const degree = new Map<string, number>();
      for (const node of nodes) degree.set(node.id, 0);
      for (const edge of edges) {
        degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
        degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
      }
      let missing = 0;
      for (const node of nodes) {
        const deg = degree.get(node.id) ?? 0;
        const pos = cached.positions[node.id];
        const comm = communityBySlug[node.id] ?? 0;
        const fallback = reduced
          ? reducedPositions.get(node.id) ?? { x: cachedOrigin.x, y: cachedOrigin.y }
          : { x: Math.random(), y: Math.random() };
        graph.addNode(node.id, {
          label: node.label,
          x: pos?.x ?? fallback.x,
          y: pos?.y ?? fallback.y,
          size: Math.max(4, Math.sqrt(Math.max(deg, 0)) * 6 || 4),
          color: colorMode === "community" ? communityColor(comm) : typeColor(node.type),
          typeName: node.type ?? "page",
          fixed: Boolean(pos),
        });
        if (!pos) missing += 1;
      }
      for (const edge of edges) {
        if (!graph.hasNode(edge.source) || !graph.hasNode(edge.target)) continue;
        if (graph.hasEdge(edge.source, edge.target)) continue;
        const signals = edge.signals?.length ? ` · ${edge.signals.join(", ")}` : "";
        graph.addUndirectedEdge(edge.source, edge.target, {
          weight: edge.weight,
          size: edge.weight >= STRONG_EDGE_WEIGHT ? 1.6 : 0.8,
          color: edge.weight >= STRONG_EDGE_WEIGHT ? "#15803d" : "#9ca3af",
          label: `${edge.weight.toFixed(1)}${signals}`,
        });
      }
      if (missing > 0 && !reduced) {
        const layout = forceAtlas2Mod.default;
        layout.assign(graph, {
          iterations: Math.min(80, 20 + missing),
          settings: layout.inferSettings(graph),
        });
      }
      const renderer = new Sigma(graph, containerRef.current, {
        renderEdgeLabels: true,
        labelFont: "system-ui, -apple-system, sans-serif",
        defaultEdgeColor: "#9ca3af",
        allowInvalidContainer: true,
      });
      if (cancelled) {
        renderer.kill();
        return;
      }
      if (cached.camera) {
        const apply = () => renderer.getCamera().setState(cached.camera!);
        if (reduced) apply();
        else renderer.getCamera().animate(cached.camera, { duration: 0 });
        apply();
      }
      renderer.on("clickNode", ({ node }) => {
        onDockPreview(selectionFromContentPath(`wiki/${node}.md`));
      });
      renderer.on("enterNode", ({ node }) => {
        hoveredRef.current = node;
        renderer.refresh();
      });
      renderer.on("leaveNode", () => {
        hoveredRef.current = null;
        renderer.refresh();
      });
      renderer.setSetting("nodeReducer", (node, data) => {
        const next = { ...data };
        const highlight = selectedRef.current;
        const hover = hoveredRef.current;
        if (highlight) {
          if (!highlight.slugs.includes(node)) {
            next.color = "#e5e7eb";
            next.label = "";
          }
        } else if (hover) {
          const neighbor = node === hover || graph.hasEdge(node, hover) || graph.hasEdge(hover, node);
          if (!neighbor) {
            next.color = "#e5e7eb";
            next.label = "";
          }
        }
        return next;
      });
      renderer.setSetting("edgeReducer", (edge, data) => {
        const extremities = graph.extremities(edge);
        const key =
          extremities[0] < extremities[1]
            ? `${extremities[0]}\0${extremities[1]}`
            : `${extremities[1]}\0${extremities[0]}`;
        const next = { ...data };
        const highlight = selectedRef.current;
        const hover = hoveredRef.current;
        if (highlight) {
          const wanted = new Set(
            highlight.edges.map((item) =>
              item.source < item.target
                ? `${item.source}\0${item.target}`
                : `${item.target}\0${item.source}`,
            ),
          );
          if (!wanted.has(key)) {
            next.color = "#f3f4f6";
            next.hidden = true;
            next.label = "";
          } else {
            next.label = String(graph.getEdgeAttribute(edge, "label") ?? "");
            next.forceLabel = true;
          }
          return next;
        }
        if (hover && (extremities[0] === hover || extremities[1] === hover)) {
          next.label = String(graph.getEdgeAttribute(edge, "label") ?? "");
          next.forceLabel = true;
          return next;
        }
        next.label = "";
        if (hover) next.color = "#f3f4f6";
        return next;
      });
      sigmaRef.current = renderer;
      graphRef.current = graph;
      const persist = () => {
        const positions: Record<string, { x: number; y: number }> = {};
        graph.forEachNode((id, attr) => {
          if (typeof attr.x === "number" && typeof attr.y === "number") {
            positions[id] = { x: attr.x, y: attr.y };
          }
        });
        writeStoredGraphLayout({
          camera: renderer.getCamera().getState(),
          positions,
        });
      };
      persist();
      renderer.getCamera().on("updated", persist);
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "Couldn’t render Graph.");
        }
      }
    })();

    return () => {
      cancelled = true;
      sigmaRef.current?.kill();
      sigmaRef.current = null;
      graphRef.current = null;
    };
  }, [nodes, edges, colorMode, communityBySlug, onDockPreview]);

  useEffect(() => {
    sigmaRef.current?.refresh();
  }, [selectedInsight]);

  function zoom(direction: "in" | "out" | "fit") {
    const camera = sigmaRef.current?.getCamera();
    const graph = graphRef.current;
    if (!camera || !graph) return;
    const duration = prefersReducedMotion() ? 0 : 200;
    if (direction === "in") {
      camera.animatedZoom({ duration });
      return;
    }
    if (direction === "out") {
      camera.animatedUnzoom({ duration });
      return;
    }
    const renderer = sigmaRef.current;
    const ids = graph.nodes();
    if (!renderer || ids.length === 0) return;
    const fitted = [];
    for (const id of ids) {
      const display = renderer.getNodeDisplayData(id);
      if (!display) continue;
      fitted.push({
        framedX: display.x,
        framedY: display.y,
      });
    }
    if (fitted.length === 0) return;
    const { width, height } = renderer.getDimensions();
    const bbox = renderer.getCustomBBox() ?? renderer.getBBox();
    camera.animate(cameraStateToFitNodes({ nodes: fitted, graphBBox: bbox, width, height }), {
      duration,
    });
  }

  async function dismissInsight(insight: WorkbenchInsight) {
    if (readOnly) return;
    try {
      await send("/api/graph/insights", {
        method: "POST",
        body: JSON.stringify({ id: insight.id, fingerprint: insight.fingerprint }),
      });
      setInsights((current) => current.filter((item) => item.id !== insight.id));
      if (selectedInsight === insight.id) setSelectedInsight(null);
    } catch (cause) {
      setError(writeFailure(cause, "dismiss the insight").message);
    }
  }

  async function confirmResearch(values: { topic: string; queries: string[] }) {
    // DEFENCE IN DEPTH for a future opener. Today the button that opens this
    // dialog early-returns, so `readOnly` cannot reach here — but this is the
    // door-facing call, the same shape `dismissInsight` and
    // `ResearchCanvas.cancel` carry, and it is the one place a second opener
    // could not route around. It STATES THE REASON rather than dropping the
    // confirm: a bare `return` would leave the dialog open with a spent Confirm
    // and no explanation, which is the silent-refusal shape this whole change
    // exists to remove.
    if (readOnly) {
      setResearchError(RESEARCH_CREATE_READ_ONLY_COPY);
      return;
    }
    const originWikiId = wikiScope.current;
    const seq = ++researchSeq.current;
    setResearchBusy(true);
    setResearchError(null);
    const vaultId = researchWikiId(originWikiId);
    let created: string | null = null;
    try {
      const body = await send<{ project?: { id: string } }>("/api/research", {
        method: "POST",
        body: JSON.stringify({
          title: values.topic,
          question: values.topic,
          queries: values.queries,
          pageSlugs: research?.slugs ?? [],
          // The wiki the confirm came FROM, recorded so the run's auto-Ingest
          // lands there even if the rail moves on before it finishes. Omitted
          // when the rail has no real wiki yet — never the `"current"` sentinel.
          ...(vaultId ? { vaultId } : {}),
        }),
      });
      created = body.project?.id ?? null;
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) {
        if (created) {
          await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" }).catch(
            () => undefined,
          );
        }
        return;
      }
      if (!created) {
        setResearchError("Deep Research did not return a project.");
        return;
      }
      // CREATE THEN RUN — see `ReviewCanvas.confirmResearch` for why the start
      // is a second call rather than folded into the create.
      await send(`/api/research/${encodeURIComponent(created)}/run`, { method: "POST" });
    } catch (cause) {
      // ONE CONFIRM, ONE PROJECT. A refused RUN used to leave this dialog open
      // holding the sentence, and a second Confirm then created a SECOND project
      // for the same topic — one press per refusal, all of them stored. Once the
      // create has landed the confirm is spent: the dialog closes and the panel
      // opens on the project, where `queueResearchProject` has already recorded
      // why the start failed. Only a failed CREATE keeps the dialog, because then
      // there is no project to look at.
      if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
      if (!created) {
        setResearchError(writeFailure(cause, "open Deep Research").message);
        return;
      }
    } finally {
      if (seq === researchSeq.current && wikiScope.current === originWikiId) {
        setResearchBusy(false);
      }
    }
    if (seq !== researchSeq.current || wikiScope.current !== originWikiId) return;
    setResearch(null);
    onOpenResearch?.(created);
  }

  return (
    <div className="wb-graph">
      <p className="wb-empty wb-empty--narrow">{GRAPH_NARROW_COPY}</p>
      <div className="wb-graph-job wb-empty--wide">
        {error && <p className="wb-todos-error">{error}</p>}
        {nodes.length === 0 && !error ? (
          <p className="wb-empty">{empty}</p>
        ) : (
          <>
            <div className="wb-graph-chrome">
              <div className="wb-todos-seg" role="tablist" aria-label="Graph coloring">
                <button
                  type="button"
                  role="tab"
                  aria-selected={colorMode === "type"}
                  className={`wb-todos-seg-btn${colorMode === "type" ? " wb-todos-seg-btn--on" : ""}`}
                  onClick={() => setColorMode("type")}
                >
                  Type
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={colorMode === "community"}
                  className={`wb-todos-seg-btn${colorMode === "community" ? " wb-todos-seg-btn--on" : ""}`}
                  onClick={() => setColorMode("community")}
                >
                  Community
                </button>
              </div>
              <button
                type="button"
                className={`wb-todos-btn${showInsights ? " wb-todos-btn--primary" : ""}`}
                onClick={() => setShowInsights((value) => !value)}
              >
                Insights
              </button>
              <div className="wb-graph-zoom">
                <button type="button" className="wb-todos-btn" onClick={() => zoom("in")}>
                  Zoom in
                </button>
                <button type="button" className="wb-todos-btn" onClick={() => zoom("out")}>
                  Zoom out
                </button>
                <button type="button" className="wb-todos-btn" onClick={() => zoom("fit")}>
                  Fit
                </button>
              </div>
            </div>
            <div className="wb-graph-stage">
              <div ref={containerRef} className="wb-graph-canvas" />
              <div className="wb-graph-side">
              <aside className="wb-graph-legend" aria-label="Graph legend">
                {colorMode === "community"
                  ? communities.map((community) => (
                      <p key={community.id} className="wb-graph-legend-row">
                        <span
                          className="wb-graph-swatch"
                          style={{ background: community.color }}
                        />
                        <span>
                          {community.label} · {community.count} · Cohesion{" "}
                          {community.cohesion.toFixed(2)}
                          {community.warn ? " — low cohesion" : ""}
                        </span>
                      </p>
                    ))
                  : types.map((type) => (
                      <p key={type.id} className="wb-graph-legend-row">
                        <span
                          className="wb-graph-swatch"
                          style={{ background: typeColor(type.id) }}
                        />
                        <span>
                          {type.label} · {type.count}
                        </span>
                      </p>
                    ))}
              </aside>
              {showInsights && (
                <aside className="wb-graph-insights" aria-label="Insights">
                  {prefill && (prefill.remaining > 0 || prefill.failed > 0) && (
                    <p className="wb-todos-meta">
                      Research context prepared for {prefill.applied} insights
                      {prefill.failed > 0 ? `; ${prefill.failed} could not be prepared` : ""}
                      {prefill.remaining > 0 ? `; ${prefill.remaining} use default queries` : ""}.
                    </p>
                  )}
                  {insights.length === 0 ? (
                    <p className="wb-empty">No insights yet.</p>
                  ) : (
                    <ul className="wb-todos-cards">
                      {insights.map((insight) => (
                        <li key={insight.id} className="wb-todos-card">
                          <button
                            type="button"
                            className="wb-graph-insight-hit"
                            aria-pressed={selectedInsight === insight.id}
                            onClick={() =>
                              setSelectedInsight((current) =>
                                current === insight.id ? null : insight.id,
                              )
                            }
                          >
                            <h3 className="wb-todos-title">{insight.title}</h3>
                            <p className="wb-todos-rationale">{insight.summary}</p>
                          </button>
                          {/* STANDING REFUSAL, NOT `disabled` (DW-531, the
                              DW-191/DW-299 shape). `disabled` takes the control
                              out of the tab order and strips its description,
                              so the sentence beside it could never be
                              announced — the owner met a dead button with no
                              reason. `aria-disabled` keeps it focusable and
                              announced; the handler is what refuses. Neither
                              control has any TRANSIENT state of its own, so
                              there is nothing left in `disabled` here. */}
                          <div className="wb-todos-actions">
                            {insight.kind === "surprise" ? (
                              <button
                                type="button"
                                className="wb-todos-btn"
                                aria-disabled={readOnly || undefined}
                                aria-describedby={readOnly ? dismissNoteId : undefined}
                                onClick={() => void dismissInsight(insight)}
                              >
                                Dismiss
                              </button>
                            ) : (
                              <button
                                type="button"
                                className="wb-todos-btn wb-todos-btn--primary"
                                aria-disabled={readOnly || undefined}
                                aria-describedby={readOnly ? researchNoteId : undefined}
                                onClick={() => {
                                  if (readOnly) return;
                                  setResearchError(null);
                                  setResearch(insight);
                                }}
                              >
                                Deep Research
                              </button>
                            )}
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                  {/* Identified so each refused control above can point at its
                      OWN door's sentence. Each is guarded on an insight of the
                      matching kind being listed: a note for a control the owner
                      was never offered would announce the refusal of an
                      operation that is not on screen, and `aria-describedby`
                      would resolve to nothing. Not `role="alert"` — nothing
                      failed; it is the deployment's standing state. */}
                  {readOnly && insights.some((item) => item.kind === "surprise") ? (
                    <p id={dismissNoteId} className="wb-todos-meta">
                      {GRAPH_INSIGHT_DISMISS_READ_ONLY_COPY}
                    </p>
                  ) : null}
                  {readOnly && insights.some((item) => item.kind !== "surprise") ? (
                    <p id={researchNoteId} className="wb-todos-meta">
                      {RESEARCH_CREATE_READ_ONLY_COPY}
                    </p>
                  ) : null}
                </aside>
              )}
              </div>
            </div>
          </>
        )}
      </div>
      <DeepResearchConfirm
        open={research !== null}
        initialTopic={research?.topic ?? ""}
        initialQueries={research?.queries ?? []}
        busy={researchBusy}
        error={researchError}
        onCancel={() => {
          setResearch(null);
          setResearchError(null);
        }}
        onConfirm={(values) => void confirmResearch(values)}
      />
    </div>
  );
}
