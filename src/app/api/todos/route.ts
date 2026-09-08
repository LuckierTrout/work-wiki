import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { dispatchMeetingTodoExtract } from "@/lib/todo-dispatch";
import {
  decideTodos,
  getTodoExtractError,
  listTodos,
  pendingTodoCount,
  type TodoDecision,
  type TodoTab,
} from "@/lib/todos";

const TABS = new Set<TodoTab>(["candidates", "open", "done"]);
const DECISIONS = new Set<TodoDecision>(["approve", "reject"]);

export async function GET(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const tabValue = new URL(request.url).searchParams.get("tab");
    const tab = tabValue && TABS.has(tabValue as TodoTab)
      ? (tabValue as TodoTab)
      : undefined;
    const [items, pendingCount, extractError] = await Promise.all([
      listTodos(principal.handle, tab),
      pendingTodoCount(principal.handle),
      getTodoExtractError(principal.handle),
    ]);
    return NextResponse.json({
      items,
      pendingCount,
      ...(extractError ? { extractError } : {}),
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
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.todos }, { status: 403 });
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      decision?: unknown;
      ids?: unknown;
      retry?: unknown;
      slug?: unknown;
      sourcePath?: unknown;
    };
    if (body.retry === true) {
      if (typeof body.slug !== "string" || !body.slug.trim()) {
        return NextResponse.json({ error: "slug is required to retry." }, { status: 400 });
      }
      const outcome = await dispatchMeetingTodoExtract(principal.handle, {
        slug: body.slug.trim(),
        ...(typeof body.sourcePath === "string" && body.sourcePath.trim()
          ? { sourcePath: body.sourcePath.trim() }
          : {}),
      });
      if (outcome === "skipped") {
        return NextResponse.json(
          { error: "This Source is not a meeting. Mark as meeting to extract Todos." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, retried: true, outcome });
    }
    if (!DECISIONS.has(body.decision as TodoDecision)) {
      return NextResponse.json(
        { error: "decision must be approve or reject." },
        { status: 400 },
      );
    }
    if (!Array.isArray(body.ids) || body.ids.some((id) => typeof id !== "string")) {
      return NextResponse.json({ error: "ids must be an array of strings." }, { status: 400 });
    }
    const items = await decideTodos(
      principal.handle,
      body.ids as string[],
      body.decision as TodoDecision,
      principal.handle,
    );
    return NextResponse.json({
      items,
      pendingCount: await pendingTodoCount(principal.handle),
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
