import { NextResponse } from "next/server";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";
import { getErrorMessage } from "@/lib/errors";
import { expandQueryWithNamesTerms } from "@/lib/names-terms";
import { selectPagesForQuery } from "@/lib/query";
import { buildRawSourceContext } from "@/lib/raw-source-search";
import { resolveScopeSlugs } from "@/lib/search";
import {
  isAgentScopedType,
  isArtifactType,
  listReadableWikiPages,
} from "@/lib/wiki";

export async function GET(request: Request) {
  // The owner-automation token is accepted here (Story 8.5) because the Chat
  // Agent's AnyTXT tool is this route: the Agent runs in the sidecar, which has
  // no session. The read gate below is unchanged — `listReadableWikiPages` still
  // decides what the principal may see, whichever way it authenticated.
  const principal = await requireOwnerOrServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const url = new URL(request.url);
    const query = url.searchParams.get("q")?.trim();
    const scope = url.searchParams.get("scope")?.trim() || undefined;
    if (!query) {
      return NextResponse.json({ error: "q parameter is required" }, { status: 400 });
    }
    if (query.length > 2_000) {
      return NextResponse.json({ error: "q must be at most 2,000 characters" }, { status: 400 });
    }

    const { scopeSlugs, error } = await resolveScopeSlugs(scope, principal);
    if (error) return NextResponse.json({ error }, { status: 400 });
    let entries = (await listReadableWikiPages(principal)).filter(
      (entry) => !isArtifactType(entry.type),
    );
    if (!scopeSlugs) {
      entries = entries.filter((entry) => !isAgentScopedType(entry.type));
    }
    const retrievalQuery = await expandQueryWithNamesTerms(
      principal.handle,
      query,
    );
    const selected = (await selectPagesForQuery(
      retrievalQuery,
      entries,
      scopeSlugs,
    )).slice(0, 12);
    const raw = await buildRawSourceContext(
      selected,
      entries,
      retrievalQuery,
    );
    return NextResponse.json({
      results: raw.chunks.map((chunk) => ({
        id: chunk.key,
        pageSlug: chunk.pageSlug,
        pageTitle: chunk.pageTitle,
        sourceType: chunk.sourceType,
        sourceUrl: chunk.sourceUrl,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        excerpt: chunk.content.slice(0, 1_200),
        href: chunk.citationHref,
        citation: chunk.citation,
        score: chunk.score,
      })),
      candidatePages: selected,
      searchedOriginals: raw.pageSlugs,
    });
  } catch (error) {
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
