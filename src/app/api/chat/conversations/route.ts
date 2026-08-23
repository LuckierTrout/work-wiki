import { NextResponse } from "next/server";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import {
  conversationWithName,
  createChatConversation,
  isChatContextBudget,
  isChatRetrievalMode,
  listChatConversations,
} from "@/lib/chat";
import { clampHistoryDepth, clampTokenBudget } from "@/lib/chat-contract";
import { getErrorMessage } from "@/lib/errors";

export async function GET() {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    return NextResponse.json({
      conversations: (await listChatConversations(principal.handle)).map(
        conversationWithName,
      ),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      name?: unknown;
      scope?: unknown;
      retrievalMode?: unknown;
      contextBudget?: unknown;
      tokenBudget?: unknown;
      historyDepth?: unknown;
    };
    if (body.title !== undefined && typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string" }, { status: 400 });
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    if (body.scope !== undefined && typeof body.scope !== "string") {
      return NextResponse.json({ error: "scope must be a string" }, { status: 400 });
    }
    if (
      body.retrievalMode !== undefined &&
      !isChatRetrievalMode(body.retrievalMode)
    ) {
      return NextResponse.json(
        { error: "retrievalMode must be wiki or sources" },
        { status: 400 },
      );
    }
    if (
      body.contextBudget !== undefined &&
      !isChatContextBudget(body.contextBudget)
    ) {
      return NextResponse.json(
        { error: "contextBudget must be compact, standard, or expanded" },
        { status: 400 },
      );
    }
    if (body.tokenBudget !== undefined && typeof body.tokenBudget !== "number") {
      return NextResponse.json({ error: "tokenBudget must be a number" }, { status: 400 });
    }
    if (body.historyDepth !== undefined && typeof body.historyDepth !== "number") {
      return NextResponse.json({ error: "historyDepth must be a number" }, { status: 400 });
    }
    const conversation = await createChatConversation(principal.handle, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(isChatRetrievalMode(body.retrievalMode)
        ? { retrievalMode: body.retrievalMode }
        : {}),
      ...(isChatContextBudget(body.contextBudget)
        ? { contextBudget: body.contextBudget }
        : {}),
      ...(typeof body.tokenBudget === "number"
        ? { tokenBudget: clampTokenBudget(body.tokenBudget) }
        : {}),
      ...(typeof body.historyDepth === "number"
        ? { historyDepth: clampHistoryDepth(body.historyDepth) }
        : {}),
    });
    return NextResponse.json(
      { conversation: conversationWithName(conversation) },
      { status: 201 },
    );
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
