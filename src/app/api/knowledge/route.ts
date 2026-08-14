import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  extractStructuredKnowledge,
  getStructuredKnowledge,
  type KnowledgeKind,
} from "@/lib/structured-knowledge";

const KINDS = new Set<KnowledgeKind>([
  "person",
  "organization",
  "project",
  "decision",
  "commitment",
  "risk",
  "event",
]);

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const graph = await getStructuredKnowledge(principal.handle);
    const kindValue = new URL(request.url).searchParams.get("kind");
    const kind = kindValue && KINDS.has(kindValue as KnowledgeKind)
      ? (kindValue as KnowledgeKind)
      : null;
    return NextResponse.json({
      graph: kind ? { ...graph, records: graph.records.filter((record) => record.kind === kind) } : graph,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = (await request.json()) as Record<string, unknown>;
    if (typeof body.slug !== "string" || !body.slug.trim()) {
      return NextResponse.json({ error: "slug is required." }, { status: 400 });
    }
    const graph = await extractStructuredKnowledge(principal.handle, body.slug);
    return NextResponse.json({ graph });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /invalid|owner|not found/i.test(message) ? 400 : 500 },
    );
  }
}
