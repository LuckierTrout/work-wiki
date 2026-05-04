import { NextResponse } from "next/server";
import { getAgent, deleteAgent, updateAgent } from "@/lib/agents";
import type { UpdateAgentOptions } from "@/lib/agents";
import { getErrorMessage } from "@/lib/errors";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/agents/[id]
 *
 * Returns a single agent profile by ID. 404 if not found.
 */
export async function GET(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: "Agent ID must be a non-empty string" },
        { status: 400 },
      );
    }

    const agent = await getAgent(id);
    if (!agent) {
      return NextResponse.json(
        { error: `Agent "${id}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({ agent });
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes("Invalid agent ID")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * DELETE /api/agents/[id]
 *
 * Remove an agent profile. Returns 200 on success, 404 if not found.
 */
export async function DELETE(_req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: "Agent ID must be a non-empty string" },
        { status: 400 },
      );
    }

    const deleted = await deleteAgent(id);
    if (!deleted) {
      return NextResponse.json(
        { error: `Agent "${id}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({ deleted: true });
  } catch (err) {
    const message = getErrorMessage(err);
    if (message.includes("Invalid agent ID")) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * PUT /api/agents/[id]
 *
 * Partially update an agent profile. Accepts:
 *   - `name?` — new display name
 *   - `description?` — new description
 *   - `addPages?` — array of `{ slug, title, type, content }` to create and link
 *   - `removePages?` — array of slugs to unlink (does NOT delete wiki pages)
 *
 * Returns the updated profile. 404 if agent doesn't exist, 400 for validation.
 */
export async function PUT(req: Request, { params }: RouteParams) {
  try {
    const { id } = await params;

    if (!id || id.trim().length === 0) {
      return NextResponse.json(
        { error: "Agent ID must be a non-empty string" },
        { status: 400 },
      );
    }

    let body: UpdateAgentOptions;
    try {
      body = await req.json();
    } catch {
      return NextResponse.json(
        { error: "Invalid JSON body" },
        { status: 400 },
      );
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return NextResponse.json(
        { error: "Request body must be a JSON object" },
        { status: 400 },
      );
    }

    const updated = await updateAgent(id, body);
    if (!updated) {
      return NextResponse.json(
        { error: `Agent "${id}" not found` },
        { status: 404 },
      );
    }

    return NextResponse.json({ agent: updated });
  } catch (err) {
    const message = getErrorMessage(err);
    if (
      message.includes("Invalid agent ID") ||
      message.includes("must be a non-empty string")
    ) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
