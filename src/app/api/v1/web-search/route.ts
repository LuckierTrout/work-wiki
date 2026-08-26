import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";
import {
  searchResearchProvider,
  selectResearchProvider,
} from "@/lib/research-providers";
import { V1_EMPTY_QUERY_ERROR } from "@/lib/v1-contract";

/** Ten is the providers' own ceiling; five is plenty for one Chat turn. */
const MAX_RESULTS = 5;

/**
 * `POST /api/v1/web-search` — one search-engine query, mid-turn (Story 8.5).
 *
 * THIS IS NOT DEEP RESEARCH, and the difference is structural rather than a
 * matter of degree: it mints no `ResearchProject`, enqueues no task, fetches no
 * page bodies and writes nothing anywhere. It is one provider call whose titles
 * and snippets go back to the model as an observation. The Deep Research panel
 * remains the only thing that starts a run, and its confirm is untouched — which
 * is exactly the property the epic's acceptance criterion names.
 *
 * IT EXISTS because the alternative was worse. The Agent's `web_search` tool has
 * to reach a real search engine, the provider credentials live in kernel
 * `AppConfig` (AD-23) and the sidecar cannot read them, so the choice was this
 * small route or a second credential store on the sidecar's disk. A tool that
 * pretended to search and answered from the model's memory would be the worst of
 * the three.
 *
 * AN UNCONFIGURED PROVIDER IS A 503 WITH THE REASON, not an empty result set.
 * "No provider configured" and "the web has nothing" lead the Agent to different
 * next moves, and only one of them is worth telling the owner about.
 */
export async function POST(request: Request) {
  const principal = await requireOwnerOrServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      query?: unknown;
      limit?: unknown;
    };
    const query = typeof body.query === "string" ? body.query.trim() : "";
    if (!query) {
      return NextResponse.json({ error: V1_EMPTY_QUERY_ERROR }, { status: 400 });
    }
    let provider;
    try {
      provider = selectResearchProvider();
    } catch (error) {
      return NextResponse.json(
        { error: "provider_unconfigured", detail: getErrorMessage(error) },
        { status: 503 },
      );
    }
    const limit =
      typeof body.limit === "number" && Number.isFinite(body.limit)
        ? Math.min(MAX_RESULTS, Math.max(1, Math.round(body.limit)))
        : MAX_RESULTS;
    const results = await searchResearchProvider(provider, query, limit);
    return NextResponse.json({
      query,
      provider,
      results: results.map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.snippet,
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
