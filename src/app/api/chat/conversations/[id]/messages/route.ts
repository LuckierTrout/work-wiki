import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  appendChatMessages,
  conversationWithName,
  retractLastChatTurn,
  type PersistChatMessage,
} from "@/lib/chat";
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
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as {
      persist?: unknown;
      retractLastTurn?: unknown;
      message?: unknown;
      messages?: unknown;
    };

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
      const conversation = await appendChatMessages(principal.handle, id, frames);
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
    const status = /not found/i.test(message)
      ? 404
      : /cannot be empty/i.test(message)
        ? 400
        : /no original source material|no readable pages/i.test(message)
          ? 422
          : 500;
    return NextResponse.json(
      { error: message },
      { status },
    );
  }
}
