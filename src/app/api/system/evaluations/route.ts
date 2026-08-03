import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
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
    return NextResponse.json(
      { error: message },
      { status: /required|invalid|add at least/i.test(message) ? 400 : 500 },
    );
  }
}
