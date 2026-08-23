import { NextResponse } from "next/server";
import {
  ChatPersistError,
  conversationWithName,
  persistChatTurn,
  retractLastChatTurn,
  type PersistChatMessage,
} from "@/lib/chat";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import type { ChatCitation } from "@/lib/chat-contract";
import { getErrorMessage } from "@/lib/errors";

interface RouteContext {
  params: Promise<{ id: string }>;
}

function asCitations(value: unknown): ChatCitation[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const citations: ChatCitation[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (
      typeof row.n !== "number" ||
      !Number.isInteger(row.n) ||
      row.n < 1 ||
      typeof row.path !== "string" ||
      !row.path.trim() ||
      typeof row.title !== "string" ||
      typeof row.type !== "string"
    ) {
      return undefined;
    }
    citations.push({
      n: row.n,
      path: row.path.trim(),
      title: row.title,
      type: row.type,
    });
  }
  return citations;
}

export async function POST(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    let body: {
      persist?: unknown;
      retractLastTurn?: unknown;
      replaceLastTurn?: unknown;
      message?: unknown;
      messages?: unknown;
    };
    try {
      body = (await request.json()) as typeof body;
    } catch {
      return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
    }

    if (body.retractLastTurn === true) {
      const retracted = await retractLastChatTurn(principal.handle, id);
      if (!retracted) {
        return NextResponse.json({
          conversation: null,
          userContent: null,
          noop: true,
        });
      }
      return NextResponse.json({
        conversation: conversationWithName(retracted.conversation),
        userContent: retracted.userContent,
        noop: false,
      });
    }

    if (body.persist === true) {
      if (!Array.isArray(body.messages)) {
        return NextResponse.json(
          { error: "messages must be an array" },
          { status: 400 },
        );
      }
      const frames: PersistChatMessage[] = [];
      for (const item of body.messages) {
        if (!item || typeof item !== "object") {
          return NextResponse.json({ error: "invalid message frame" }, { status: 400 });
        }
        const row = item as Record<string, unknown>;
        if (row.role !== "user" && row.role !== "assistant") {
          return NextResponse.json({ error: "invalid message role" }, { status: 400 });
        }
        if (typeof row.content !== "string") {
          return NextResponse.json({ error: "content must be a string" }, { status: 400 });
        }
        const citations = asCitations(row.citations);
        if (row.citations !== undefined && !citations) {
          return NextResponse.json({ error: "citations are invalid" }, { status: 400 });
        }
        frames.push({
          role: row.role,
          content: row.content,
          ...(citations ? { citations } : {}),
          ...(typeof row.thinking === "string" ? { thinking: row.thinking } : {}),
        });
      }
      if (
        frames.length !== 2 ||
        frames[0]?.role !== "user" ||
        frames[1]?.role !== "assistant"
      ) {
        return NextResponse.json(
          { error: "A turn must be one user message then one assistant message" },
          { status: 400 },
        );
      }
      const conversation = await persistChatTurn(principal.handle, id, frames, {
        replaceLastTurn: body.replaceLastTurn === true,
      });
      if (!conversation) {
        return NextResponse.json({ error: "Conversation not found." }, { status: 404 });
      }
      return NextResponse.json({ conversation: conversationWithName(conversation) });
    }

    return NextResponse.json(
      { error: "sidecar_required" },
      { status: 410 },
    );
  } catch (error) {
    const message = getErrorMessage(error);
    const status =
      error instanceof ChatPersistError || /cannot be empty/i.test(message)
        ? 400
        : /not found/i.test(message)
          ? 404
          : /no original source material|no readable pages/i.test(message)
            ? 422
            : 500;
    return NextResponse.json(
      { error: message },
      { status },
    );
  }
}
