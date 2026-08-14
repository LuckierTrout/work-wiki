import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import {
  listActionItems,
  proposeActionItems,
  type ActionItemPriority,
  type ActionItemStatus,
} from "@/lib/action-items";
import { getErrorMessage } from "@/lib/errors";

const STATUSES = new Set<ActionItemStatus>([
  "inbox",
  "accepted",
  "dismissed",
  "done",
]);
const PRIORITIES = new Set<ActionItemPriority>(["low", "medium", "high"]);

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const value = new URL(request.url).searchParams.get("status");
    const status = value && STATUSES.has(value as ActionItemStatus)
      ? (value as ActionItemStatus)
      : undefined;
    return NextResponse.json({
      items: await listActionItems(principal.handle, status),
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
    const body = (await request.json()) as {
      title?: unknown;
      details?: unknown;
      assignee?: unknown;
      dueDate?: unknown;
      priority?: unknown;
    };
    if (typeof body.title !== "string" || !body.title.trim()) {
      return NextResponse.json({ error: "title is required" }, { status: 400 });
    }
    if (
      body.priority !== undefined &&
      !PRIORITIES.has(body.priority as ActionItemPriority)
    ) {
      return NextResponse.json({ error: "priority must be low, medium, or high" }, { status: 400 });
    }
    const [item] = await proposeActionItems(principal.handle, [{
      title: body.title,
      ...(typeof body.details === "string" ? { details: body.details } : {}),
      ...(typeof body.assignee === "string" ? { assignee: body.assignee } : {}),
      ...(typeof body.dueDate === "string" ? { dueDate: body.dueDate } : {}),
      ...(PRIORITIES.has(body.priority as ActionItemPriority)
        ? { priority: body.priority as ActionItemPriority }
        : {}),
    }]);
    if (!item) {
      return NextResponse.json({ error: "That action item already exists." }, { status: 409 });
    }
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
