import { NextResponse } from "next/server";
import { isFilesystemWikiId } from "@/lib/chat-contract";
import { getErrorMessage } from "@/lib/errors";
import { isChatRetrievalMode } from "@/lib/chat";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { searchWiki } from "@/lib/wiki-retrieve";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  const { wikiId } = await params;
  if (isFilesystemWikiId(wikiId)) {
    return NextResponse.json({ error: "invalid_wiki_id" }, { status: 400 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      query?: unknown;
      topK?: unknown;
      retrievalMode?: unknown;
    };
    if (typeof body.query !== "string" || !body.query.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const topK =
      typeof body.topK === "number" && Number.isFinite(body.topK)
        ? Math.min(50, Math.max(1, Math.round(body.topK)))
        : 10;
    const result = await searchWiki(body.query, {
      principal,
      topK,
      retrievalMode: isChatRetrievalMode(body.retrievalMode)
        ? body.retrievalMode
        : "wiki",
    });
    return NextResponse.json({
      query: body.query,
      topK,
      hits: result.hits,
      vectorPhase: result.vectorPhase,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
