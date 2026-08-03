import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { deleteRetrievalEvalCase } from "@/lib/retrieval-evals";
import { getErrorMessage } from "@/lib/errors";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const { id } = await context.params;
    const deleted = await deleteRetrievalEvalCase(principal.handle, id);
    return deleted
      ? NextResponse.json({ deleted: true })
      : NextResponse.json({ error: "Evaluation case not found." }, { status: 404 });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
