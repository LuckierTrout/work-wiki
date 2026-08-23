import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { insightDismissalMap } from "@/lib/graph-insight-dismissals";
import { assignCommunities } from "@/lib/graph-louvain";
import {
  computeWorkbenchInsights,
  filterDismissedInsights,
  typeLegend,
} from "@/lib/graph-surprise";
import { buildWikiGraph } from "@/lib/graph-build";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { buildResearchPrefill } from "@/lib/research-prefill";

export async function GET() {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { nodes, edges } = await buildWikiGraph("mine", principal);
    const communities = assignCommunities(nodes, edges);
    const rawInsights = computeWorkbenchInsights(nodes, edges, communities);
    const dismissed = await insightDismissalMap(principal.handle);
    const insights = filterDismissedInsights(rawInsights, dismissed);
    const filled = [];
    let prefilled = 0;
    for (const insight of insights) {
      if (!insight.offersDeepResearch || prefilled >= 12) {
        filled.push(insight);
        continue;
      }
      try {
        const prefill = await buildResearchPrefill(insight.slugs, insight.topic);
        prefilled += 1;
        filled.push({
          ...insight,
          topic: prefill.topic,
          queries: prefill.queries.length > 0 ? prefill.queries : insight.queries,
        });
      } catch {
        filled.push(insight);
      }
    }
    return NextResponse.json({
      nodes,
      edges,
      communities: communities.communities,
      communityBySlug: communities.bySlug,
      types: typeLegend(nodes),
      insights: filled,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
