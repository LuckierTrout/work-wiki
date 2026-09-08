import { NextResponse } from "next/server";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import {
  conversationWithName,
  deleteChatConversation,
  exportChatConversation,
  getChatConversation,
  isChatContextBudget,
  isChatRetrievalMode,
  updateChatConversation,
} from "@/lib/chat";
import { clampHistoryDepth, clampTokenBudget } from "@/lib/chat-contract";
import { getErrorMessage } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const conversation = await getChatConversation(principal.handle, id);
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    const url = new URL(_request.url);
    if (url.searchParams.get("export") === "1") {
      return NextResponse.json({
        conversation: exportChatConversation(conversation),
      });
    }
    return NextResponse.json({ conversation: conversationWithName(conversation) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    let body: {
      title?: unknown;
      name?: unknown;
      scope?: unknown;
      retrievalMode?: unknown;
      contextBudget?: unknown;
      tokenBudget?: unknown;
      historyDepth?: unknown;
      selectedSkill?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string" }, { status: 400 });
    }
    if (body.name !== undefined && typeof body.name !== "string") {
      return NextResponse.json({ error: "name must be a string" }, { status: 400 });
    }
    if (
      body.scope !== undefined &&
      body.scope !== null &&
      typeof body.scope !== "string"
    ) {
      return NextResponse.json({ error: "scope must be a string or null" }, { status: 400 });
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
    // `null` is ACCEPTED, and it is the only way to clear a Skill: `/skill` with
    // no argument means "stop running under one", and an omitted field cannot say
    // that — it means "leave it alone".
    if (
      body.selectedSkill !== undefined &&
      body.selectedSkill !== null &&
      typeof body.selectedSkill !== "string"
    ) {
      return NextResponse.json(
        { error: "selectedSkill must be a string or null" },
        { status: 400 },
      );
    }
    const conversation = await updateChatConversation(principal.handle, id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.name === "string" ? { name: body.name } : {}),
      ...(body.scope === null || typeof body.scope === "string"
        ? { scope: body.scope }
        : {}),
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
      ...(body.selectedSkill === null || typeof body.selectedSkill === "string"
        ? { selectedSkill: body.selectedSkill }
        : {}),
    });
    if (!conversation) {
      return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
    }
    return NextResponse.json({ conversation: conversationWithName(conversation) });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /cannot be empty/i.test(message) ? 400 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const deleted = await deleteChatConversation(principal.handle, id);
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Conversation not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
