import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage } from "@/lib/errors";
import {
  deleteNamesTerm,
  NamesTermConflictError,
  parseNamesTermInput,
  updateNamesTerm,
} from "@/lib/names-terms";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function PUT(request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  // Deployment read-only (DW-300), after the 401 and before the parse — the
  // sibling `POST /api/names-terms` gate, one sentence for all three writers.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.namesTerms },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    const entry = await updateNamesTerm(
      principal.handle,
      id,
      parseNamesTermInput((await request.json()) as Record<string, unknown>),
    );
    return entry
      ? NextResponse.json({ entry })
      : NextResponse.json({ error: "Names & Terms entry not found." }, { status: 404 });
  } catch (error) {
    // Backstop for a flag that flipped mid-request: the gate above already
    // answered for a deployment that was read-only when the request arrived, so
    // reaching here means the kernel writer refused. A refusal is neither a
    // server fault nor the caller's bad input.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: error instanceof NamesTermConflictError ? 409 : 400 },
    );
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  // Deployment read-only (DW-300) — same point, same sentence as PUT above.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.namesTerms },
      { status: 403 },
    );
  }
  try {
    const { id } = await params;
    const deleted = await deleteNamesTerm(principal.handle, id);
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Names & Terms entry not found." }, { status: 404 });
  } catch (error) {
    // Backstop for a flag that flipped mid-request: the gate above already
    // answered for a deployment that was read-only when the request arrived, so
    // reaching here means the kernel writer refused. A refusal is neither a
    // server fault nor the caller's bad input.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
