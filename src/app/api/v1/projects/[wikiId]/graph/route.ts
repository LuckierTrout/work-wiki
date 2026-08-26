import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { buildWikiGraph } from "@/lib/graph-build";
import { clampGraphLimit, v1WikilinkExport } from "@/lib/v1-contract";
import { resolveV1Caller } from "@/lib/v1-route";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `GET /api/v1/projects/{id}/graph` — nodes and edges (Story 8.2).
 *
 * OWNER-SCOPED, ALWAYS. `buildWikiGraph(null, …)` builds the public commons
 * graph, and this façade exists to answer questions about the owner's private
 * wiki — a route that fell back to the commons would answer a different question
 * than the one asked, with no error to say so. So the scope is fixed at `mine`
 * and there is no `scope` parameter to get wrong.
 *
 * `limit` CLAMPS the node count rather than refusing: an agent asking for the
 * whole graph of a large wiki wants as much as it can have. Edges are then
 * filtered to the surviving nodes, because an edge pointing at a node that was
 * cut is an edge into nothing — a caller laying the graph out would render a
 * dangling arrow or crash on the missing id.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  try {
    const raw = new URL(request.url).searchParams.get("limit");
    const limit = clampGraphLimit(raw === null ? undefined : Number(raw));
    const { nodes, edges } = await buildWikiGraph("mine", caller.principal);
    // Wikilink edges only — the 4-signal weights stay on the Workbench engine.
    const exported = v1WikilinkExport(nodes, edges, limit);
    return NextResponse.json({
      wikiId: caller.requested,
      ...exported,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
