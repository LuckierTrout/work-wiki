import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
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
  try {
    const { id } = await params;
    const deleted = await deleteNamesTerm(principal.handle, id);
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Names & Terms entry not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
