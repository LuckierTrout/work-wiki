import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import {
  insightDismissalMap,
  reconcileLegacyInsightDismissals,
} from "@/lib/graph-insight-dismissals";
import { isReadOnly } from "@/lib/config";
import { assignCommunities } from "@/lib/graph-louvain";
import {
  computeWorkbenchInsights,
  filterDismissedInsights,
  typeLegend,
} from "@/lib/graph-surprise";
import { buildWikiGraph } from "@/lib/graph-build";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import {
  RESEARCH_PREFILL_LIMIT,
  allocateResearchPrefillSlugs,
  buildResearchPrefill,
  loadResearchPrefillContext,
  loadResearchPrefillPages,
} from "@/lib/research-prefill";

export async function GET() {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { nodes, edges } = await buildWikiGraph("mine", principal);
    const communities = assignCommunities(nodes, edges);
    const rawInsights = computeWorkbenchInsights(nodes, edges, communities);
    const dismissed = isReadOnly()
      ? await insightDismissalMap(principal.handle)
      : await reconcileLegacyInsightDismissals(principal.handle, rawInsights);
    const insights = filterDismissedInsights(rawInsights, dismissed);
    const eligible = insights.filter((insight) => insight.offersDeepResearch);
    const selected = new Set(eligible.slice(0, RESEARCH_PREFILL_LIMIT).map((insight) => insight.id));
    const selectedInsights = insights.filter((insight) => selected.has(insight.id));
    const context = selected.size > 0
      ? {
          ...(await loadResearchPrefillContext(principal.handle)),
          pages: await loadResearchPrefillPages(
            allocateResearchPrefillSlugs(selectedInsights.map((insight) => insight.slugs)),
          ),
        }
      : undefined;
    let applied = 0;
    let failed = 0;
    const filled = await Promise.all(insights.map(async (insight) => {
      if (!selected.has(insight.id)) return insight;
      try {
        const prefill = await buildResearchPrefill(
          insight.slugs,
          insight.topic,
          principal.handle,
          context,
        );
        applied += 1;
        return {
          ...insight,
          topic: prefill.topic,
          queries: prefill.queries.length > 0 ? prefill.queries : insight.queries,
        };
      } catch {
        failed += 1;
        return insight;
      }
    }));
    const publicInsights = filled.map(({
      legacyFingerprint: _legacy,
      legacyId: _legacyId,
      ...insight
    }) => insight);
    return NextResponse.json({
      nodes,
      edges,
      communities: communities.communities,
      communityBySlug: communities.bySlug,
      types: typeLegend(nodes),
      insights: publicInsights,
      prefill: {
        limit: RESEARCH_PREFILL_LIMIT,
        attempted: selected.size,
        applied,
        failed,
        remaining: Math.max(0, eligible.length - selected.size),
      },
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
