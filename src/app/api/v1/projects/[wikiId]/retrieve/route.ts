import { NextResponse } from "next/server";
import { isChatRetrievalMode } from "@/lib/chat";
import {
  clampHistoryDepth,
  clampTokenBudget,
  isFilesystemWikiId,
  type ChatExportMessage,
} from "@/lib/chat-contract";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { assembleWikiContext } from "@/lib/wiki-retrieve";

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
      retrievalMode?: unknown;
      tokenBudget?: unknown;
      historyDepth?: unknown;
      history?: unknown;
    };
    if (typeof body.query !== "string" || !body.query.trim()) {
      return NextResponse.json({ error: "query is required" }, { status: 400 });
    }
    const history = Array.isArray(body.history)
      ? (body.history as ChatExportMessage[])
          .filter(
            (item) =>
              item &&
              (item.role === "user" || item.role === "assistant") &&
              typeof item.content === "string",
          )
          .map((item) => ({ role: item.role, content: item.content }))
      : [];
    const assembled = await assembleWikiContext(body.query, {
      principal,
      retrievalMode: isChatRetrievalMode(body.retrievalMode)
        ? body.retrievalMode
        : "wiki",
      tokenBudget:
        typeof body.tokenBudget === "number"
          ? clampTokenBudget(body.tokenBudget)
          : undefined,
      historyDepth:
        typeof body.historyDepth === "number"
          ? clampHistoryDepth(body.historyDepth)
          : undefined,
      history,
    });
    return NextResponse.json(assembled);
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
