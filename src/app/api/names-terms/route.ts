import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage } from "@/lib/errors";
import {
  createNamesTerm,
  listNamesTerms,
  NamesTermConflictError,
  parseNamesTermInput,
} from "@/lib/names-terms";

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    return NextResponse.json({ entries: await listNamesTerms(principal.handle) });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  // Deployment read-only (DW-300). After the 401 and before the parse:
  // `parseNamesTermInput` throws a 400 on a malformed body, which would
  // otherwise blame the caller's input for a write the deployment was never
  // going to accept. `createNamesTerm` also refuses in the kernel now (DW-385,
  // same sentence, for the callers that never pass a route), so this gate is
  // about WHICH answer the caller gets first, not about whether one exists. The
  // `[id]` PUT and DELETE gate at the same point with the same sentence.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.namesTerms },
      { status: 403 },
    );
  }
  try {
    const entry = await createNamesTerm(
      principal.handle,
      parseNamesTermInput((await request.json()) as Record<string, unknown>),
    );
    return NextResponse.json({ entry }, { status: 201 });
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
