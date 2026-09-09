import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { isChatRetrievalMode } from "@/lib/chat";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";
import {
  V1_EMPTY_QUERY_ERROR,
  clampTopK,
} from "@/lib/v1-contract";
import { requireAccessibleWikiId } from "@/lib/wiki-access";
import { retrieveHits } from "@/lib/wiki-retrieve";
import { readV1JsonBody } from "@/lib/v1-route";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `POST /api/v1/projects/{id}/search` — the FR-76 search shape, and Epic 3's.
 *
 * IT EMITS BOTH, DELIBERATELY. The FR-76 vocabulary an external agent reads is
 * `results` with `mode` / `tokenHits` / `vectorHits`; the Workbench's
 * `SearchCanvas` has read `hits` and `vectorPhase` since Epic 3. One shape
 * replacing the other would either break Search mode in the product or ship an
 * external contract nothing outside can parse, so this route answers one object
 * that satisfies both readers — the same rows under two names, from ONE
 * retrieval.
 *
 * That is not two sources of truth: both projections are built from the single
 * `retrieveHits` result below, so they cannot disagree about what was found.
 *
 * `retrieveHits` rather than `searchWiki` because `searchWiki` drops each page's
 * `body` on its way out, and `includeContent` has to answer with the actual text
 * — a `content` field that echoed the snippet back would be a field that lies
 * about what it is. The snippet fallback `searchWiki` applies is reproduced
 * below, so the `hits` array is byte-identical to what `SearchCanvas` had.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerOrServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { wikiId } = await params;
  const access = await requireAccessibleWikiId(ownerTenantHandle(principal), wikiId);
  if (!access.ok) {
    return NextResponse.json({ error: access.error }, { status: access.status });
  }
  try {
    const parsed = await readV1JsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      query?: unknown;
      topK?: unknown;
      mode?: unknown;
      retrievalMode?: unknown;
      includeContent?: unknown;
      queryEmbedding?: unknown;
    };
    if (typeof body.query !== "string" || !body.query.trim()) {
      // An empty query is a 400, never an empty result set: "no hits" is a fact
      // about the wiki, and answering it for a request that asked nothing would
      // let an agent conclude the wiki is empty.
      return NextResponse.json({ error: V1_EMPTY_QUERY_ERROR }, { status: 400 });
    }
    // CLAMPED, not refused. `topK: 99` is a caller wanting plenty of hits, not a
    // malformed request — the cap exists to bound the work, so the honest answer
    // is fifty results rather than a 400 the caller cannot act on.
    const topK = clampTopK(body.topK, body.mode);
    const retrievalMode = isChatRetrievalMode(body.retrievalMode)
      ? body.retrievalMode
      : "wiki";
    const query = body.query;
    const retrieved = await retrieveHits(query, {
      principal,
      topK,
      retrievalMode,
    });
    // `includeContent` is OPT-IN because a fifty-hit search with page bodies
    // attached is megabytes, and the caller that wants one page's text has
    // `files/content` for it. Absent, every row still carries its `snippet`.
    const includeContent = body.includeContent === true;
    const rows = retrieved.hits.slice(0, topK);
    const needle = query.toLowerCase();
    return NextResponse.json({
      // Epic 3's fields, unchanged. `SearchCanvas` reads these two.
      query,
      topK,
      hits: rows.map((hit) => ({
        path: hit.path,
        title: hit.title,
        snippet: hit.snippet || String(hit.body ?? "").slice(0, 240),
        score: hit.score,
      })),
      vectorPhase: retrieved.vectorPhase,
      // FR-76's fields, from the same rows.
      mode: retrievalMode,
      tokenHits: rows.length,
      vectorHits: retrieved.vectorPhase.status === "ok" ? rows.length : 0,
      results: rows.map((hit) => ({
        path: hit.path,
        title: hit.title ?? "",
        snippet: hit.snippet || String(hit.body ?? "").slice(0, 240),
        score: hit.score,
        // A TITLE MATCH is called out because it is the one relevance signal a
        // caller can reason about without the index: "the page is named this"
        // is different evidence from "the phrase appears in the body".
        titleMatch: String(hit.title ?? "")
          .toLowerCase()
          .includes(needle),
        ...(includeContent ? { content: hit.body } : {}),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
