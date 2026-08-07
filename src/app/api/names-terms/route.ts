import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
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
  try {
    const entry = await createNamesTerm(
      principal.handle,
      parseNamesTermInput((await request.json()) as Record<string, unknown>),
    );
    return NextResponse.json({ entry }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: error instanceof NamesTermConflictError ? 409 : 400 },
    );
  }
}
