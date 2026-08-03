import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  deleteActionItem,
  updateActionItem,
  type ActionItemPriority,
  type ActionItemStatus,
} from "@/lib/action-items";
import { getErrorMessage } from "@/lib/errors";

const STATUSES = new Set<ActionItemStatus>(["inbox", "accepted", "dismissed", "done"]);
const PRIORITIES = new Set<ActionItemPriority>(["low", "medium", "high"]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const body = (await request.json()) as Record<string, unknown>;
    if (body.status !== undefined && !STATUSES.has(body.status as ActionItemStatus)) {
      return NextResponse.json({ error: "Invalid status." }, { status: 400 });
    }
    if (body.priority !== undefined && !PRIORITIES.has(body.priority as ActionItemPriority)) {
      return NextResponse.json({ error: "Invalid priority." }, { status: 400 });
    }
    const item = await updateActionItem(principal.handle, id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(typeof body.details === "string" ? { details: body.details } : {}),
      ...(typeof body.assignee === "string" ? { assignee: body.assignee } : {}),
      ...(typeof body.dueDate === "string" ? { dueDate: body.dueDate } : {}),
      ...(PRIORITIES.has(body.priority as ActionItemPriority)
        ? { priority: body.priority as ActionItemPriority }
        : {}),
      ...(STATUSES.has(body.status as ActionItemStatus)
        ? { status: body.status as ActionItemStatus }
        : {}),
    });
    return item
      ? NextResponse.json({ item })
      : NextResponse.json({ error: "Action item not found." }, { status: 404 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /cannot be empty/i.test(message) ? 400 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const { id } = await params;
    const deleted = await deleteActionItem(principal.handle, id);
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Action item not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
