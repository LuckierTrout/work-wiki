import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import {
  ChatPersistError,
  conversationWithName,
  persistChatTurn,
  retractLastChatTurn,
  type ChatOutput,
  type ChatToolCall,
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

/**
 * Tool rows off the wire (Story 8.5).
 *
 * VALIDATED, not trusted: this body is posted by the browser after a sidecar
 * `done`, and the rows land in a stored conversation the Preview and the export
 * both read. `detail` is capped because it is a SUMMARY — "4 hits" — and a
 * caller sending a page of text in it would put that text in the conversation
 * record forever.
 */
function asToolCalls(value: unknown): ChatToolCall[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const rows: ChatToolCall[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== "string" || typeof row.tool !== "string") {
      return undefined;
    }
    rows.push({
      id: row.id.slice(0, 64),
      tool: row.tool.slice(0, 64),
      detail: typeof row.detail === "string" ? row.detail.slice(0, 200) : "",
    });
  }
  return rows;
}

/**
 * Output chips off the wire (Story 8.8).
 *
 * The path must be WORKSPACE-RELATIVE, checked here rather than assumed: a
 * stored chip is a thing the surface will later open, and one that was absolute
 * or contained a traversal segment would be a path the workspace door refuses —
 * a chip that can only ever 403 when clicked.
 */
function asOutputs(value: unknown): ChatOutput[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 32) return undefined;
  const rows: ChatOutput[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object") return undefined;
    const row = item as Record<string, unknown>;
    if (typeof row.path !== "string" || typeof row.name !== "string") {
      return undefined;
    }
    const path = row.path.trim();
    if (
      !path ||
      path.startsWith("/") ||
      /^[a-zA-Z]:[\\/]/.test(path) ||
      path.split(/[\\/]/).includes("..")
    ) {
      return undefined;
    }
    rows.push({
      path,
      name: row.name.slice(0, 200),
      bytes: typeof row.bytes === "number" && row.bytes >= 0 ? row.bytes : 0,
    });
  }
  return rows;
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
      const retracted = await retractLastChatTurn(ownerTenantHandle(principal), id);
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
        const toolCalls = asToolCalls(row.toolCalls);
        if (row.toolCalls !== undefined && !toolCalls) {
          return NextResponse.json({ error: "toolCalls are invalid" }, { status: 400 });
        }
        const outputs = asOutputs(row.outputs);
        if (row.outputs !== undefined && !outputs) {
          return NextResponse.json({ error: "outputs are invalid" }, { status: 400 });
        }
        frames.push({
          role: row.role,
          content: row.content,
          ...(citations ? { citations } : {}),
          ...(typeof row.thinking === "string" ? { thinking: row.thinking } : {}),
          ...(toolCalls?.length ? { toolCalls } : {}),
          ...(outputs?.length ? { outputs } : {}),
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
      const conversation = await persistChatTurn(ownerTenantHandle(principal), id, frames, {
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
