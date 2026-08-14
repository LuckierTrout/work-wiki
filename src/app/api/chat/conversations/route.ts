import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  createChatConversation,
  isChatContextBudget,
  isChatRetrievalMode,
  listChatConversations,
} from "@/lib/chat";
import { getErrorMessage } from "@/lib/errors";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    return NextResponse.json({
      conversations: await listChatConversations(principal.handle),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      scope?: unknown;
      retrievalMode?: unknown;
      contextBudget?: unknown;
    };
    if (body.title !== undefined && typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string" }, { status: 400 });
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
    const conversation = await createChatConversation(principal.handle, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.scope === "string" ? { scope: body.scope } : {}),
      ...(isChatRetrievalMode(body.retrievalMode)
        ? { retrievalMode: body.retrievalMode }
        : {}),
      ...(isChatContextBudget(body.contextBudget)
        ? { contextBudget: body.contextBudget }
        : {}),
    });
    return NextResponse.json({ conversation }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
