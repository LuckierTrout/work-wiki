import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import { buildWikiGraph } from "@/lib/graph-build";
import { deriveGraphInsights } from "@/lib/graph-insights";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const scope = new URL(request.url).searchParams.get("scope") || "mine";
    const graph = await buildWikiGraph(scope, principal);
    return NextResponse.json({
      insights: deriveGraphInsights(graph.nodes, graph.edges),
      graph: { nodes: graph.nodes.length, edges: graph.edges.length, scope },
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
