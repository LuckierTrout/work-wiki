import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import {
  deleteTodo,
  patchTodo,
  pendingTodoCount,
  type TodoDecision,
  type TodoStatus,
} from "@/lib/todos";

const DECISIONS = new Set<TodoDecision>(["approve", "reject"]);
const STATUSES = new Set<TodoStatus>(["open", "done"]);

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PATCH(request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.todos }, { status: 403 });
  }
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as {
      title?: unknown;
      due?: unknown;
      status?: unknown;
      decision?: unknown;
    };
    if (body.decision !== undefined && !DECISIONS.has(body.decision as TodoDecision)) {
      return NextResponse.json(
        { error: "decision must be approve or reject." },
        { status: 400 },
      );
    }
    if (body.status !== undefined && !STATUSES.has(body.status as TodoStatus)) {
      return NextResponse.json({ error: "status must be open or done." }, { status: 400 });
    }
    if (body.title !== undefined && typeof body.title !== "string") {
      return NextResponse.json({ error: "title must be a string." }, { status: 400 });
    }
    if (body.due !== undefined && body.due !== null && typeof body.due !== "string") {
      return NextResponse.json({ error: "due must be a string or null." }, { status: 400 });
    }
    const item = await patchTodo(principal.handle, id, {
      ...(typeof body.title === "string" ? { title: body.title } : {}),
      ...(body.due === null || typeof body.due === "string" ? { due: body.due } : {}),
      ...(STATUSES.has(body.status as TodoStatus)
        ? { status: body.status as TodoStatus }
        : {}),
      ...(DECISIONS.has(body.decision as TodoDecision)
        ? { decision: body.decision as TodoDecision, actor: principal.handle }
        : {}),
    });
    return item
      ? NextResponse.json({
          item,
          pendingCount: await pendingTodoCount(principal.handle),
        })
      : NextResponse.json({ error: "Todo not found." }, { status: 404 });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /cannot be empty|after approve|Only approved/i.test(message) ? 400 : 500 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.todos }, { status: 403 });
  }
  try {
    const { id } = await params;
    const deleted = await deleteTodo(principal.handle, id);
    return deleted
      ? NextResponse.json({
          deleted: true,
          pendingCount: await pendingTodoCount(principal.handle),
        })
      : NextResponse.json({ error: "Todo not found." }, { status: 404 });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
