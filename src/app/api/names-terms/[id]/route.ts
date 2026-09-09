import { ownerTenantHandle } from "@/lib/owner";
import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
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
    // Body guarded before the parse — the sibling `POST /api/names-terms`
    // guard, same two sentences, for the same reason (DW-641): the catch below
    // now defaults to 500, and a body the server could not read is not a
    // server fault.
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const entry = await updateNamesTerm(
      ownerTenantHandle(principal),
      id,
      parseNamesTermInput(parsed as Record<string, unknown>),
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
    // Classification by TYPE alone (DW-641) — the `POST /api/names-terms`
    // ladder, because these are two verbs on one store and used to disagree
    // with the DELETE below about a storage fault: 400 here, 500 there. The
    // store types the caller's own faults as `ClientInputError`, so everything
    // left over defaults to the 500 the DELETE already gave.
    const message = getErrorMessage(error);
    const status = error instanceof NamesTermConflictError
      ? 409
      : isClientInputError(error)
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
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
    const deleted = await deleteNamesTerm(ownerTenantHandle(principal), id);
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
