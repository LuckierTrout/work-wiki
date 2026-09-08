import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
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
    // The body is guarded HERE rather than left to the catch (DW-641). It used
    // to reach the parse raw, and a `request.json()` rejection — or the
    // `TypeError` a `null` body raises on `body.kind`, or the refusal an array
    // body earns for having no `kind` — landed in a catch whose default was
    // 400, so the caller was told the right thing by accident. Under the 500
    // default below that accident
    // becomes a server fault for a body the server read fine. The
    // `src/app/api/research/route.ts` idiom, one sentence each.
    let parsed: unknown;
    try {
      parsed = await request.json();
    } catch {
      return NextResponse.json({ error: "Request body must be JSON." }, { status: 400 });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
    }
    const entry = await createNamesTerm(
      principal.handle,
      parseNamesTermInput(parsed as Record<string, unknown>),
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
    // Classification by TYPE alone (DW-641), the workspace-profile ladder of
    // DW-319 applied to a second store. This used to end `NamesTermConflictError
    // ? 409 : 400`, which flattened EVERY other failure — an EACCES, a full
    // disk, a lock timeout inside `createNamesTerm` — into the owner's bad
    // input, while the sibling `DELETE /api/names-terms/[id]` answered 500 for
    // that same class. The store now throws `ClientInputError` for what really
    // is the caller's fault, so the default can be the 500 the sibling gives.
    // `isClientInputError` is structural on `err.name` rather than `instanceof`
    // for the duplicated-module-graph reason its docblock states;
    // `NamesTermConflictError` keeps the `instanceof` this catch already used.
    const message = getErrorMessage(error);
    const status = error instanceof NamesTermConflictError
      ? 409
      : isClientInputError(error)
        ? 400
        : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
