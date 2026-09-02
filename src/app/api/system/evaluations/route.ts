import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage, isClientInputError, isStoreFault } from "@/lib/errors";
import {
  listRetrievalEvalCases,
  listRetrievalEvalRuns,
  runRetrievalEvaluation,
  saveRetrievalEvalCase,
} from "@/lib/retrieval-evals";

function stringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value as string[]
    : null;
}

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const [cases, runs] = await Promise.all([
      listRetrievalEvalCases(principal.handle),
      listRetrievalEvalRuns(principal.handle),
    ]);
    return NextResponse.json({ cases, runs });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "run") {
      return NextResponse.json({ run: await runRetrievalEvaluation(principal.handle) });
    }
    const expectedSlugs = stringArray(body.expectedSlugs);
    const forbiddenSlugs = stringArray(body.forbiddenSlugs ?? []);
    const requiredPhrases = stringArray(body.requiredPhrases ?? []);
    if (typeof body.label !== "string" || typeof body.question !== "string" || !expectedSlugs || !forbiddenSlugs || !requiredPhrases) {
      return NextResponse.json({ error: "label, question, and string-array checks are required." }, { status: 400 });
    }
    const value = await saveRetrievalEvalCase(principal.handle, {
      ...(typeof body.id === "string" ? { id: body.id } : {}),
      label: body.label,
      question: body.question,
      expectedSlugs,
      forbiddenSlugs,
      requiredPhrases,
    });
    return NextResponse.json({ case: value }, { status: 201 });
  } catch (error) {
    const message = getErrorMessage(error);
    // Classify by TYPE first. A store fault (`saveRetrievalEvalCase` hitting an
    // unreadable file, or the filesystem answering `EINVAL: invalid argument,
    // open '…'`) is OURS, not the caller's — the message ladder below read
    // that sentence's "invalid" as a 400 and the caller retried a broken disk
    // forever (DW-481). The ladder survives as the residual branch only,
    // covering `validateSlug` and the eval module's own still-untyped
    // validation throws, which are genuinely the caller's 400.
    if (isStoreFault(error)) {
      return NextResponse.json({ error: message }, { status: 500 });
    }
    if (isClientInputError(error)) {
      return NextResponse.json({ error: message }, { status: 400 });
    }
    return NextResponse.json(
      { error: message },
      { status: /required|invalid|add at least/i.test(message) ? 400 : 500 },
    );
  }
}
