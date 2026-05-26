import { NextResponse } from "next/server";
import { rebuildVectorStore } from "@/lib/embeddings";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";

export async function POST() {
  if (isReadOnly()) {
    return NextResponse.json(
      { error: "Rebuilding embeddings is disabled in read-only mode." },
      { status: 403 },
    );
  }

  try {
    const result = await rebuildVectorStore();
    return NextResponse.json(result);
  } catch (err: unknown) {
    const message = getErrorMessage(err, "Failed to rebuild vector store");

    // "No embedding provider configured" → 400; everything else → 500
    const status = message.includes("No embedding provider") ? 400 : 500;
    return NextResponse.json({ error: message }, { status });
  }
}
