import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  compileKnowledgePage,
  getKnowledgeCompilation,
  listSourceContributions,
} from "@/lib/knowledge-compilation";

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const slug = new URL(request.url).searchParams.get("slug")?.trim();
    return NextResponse.json({
      contributions: await listSourceContributions(principal.handle),
      ...(slug ? { run: await getKnowledgeCompilation(principal.handle, slug) } : {}),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  try {
    const body = await request.json() as Record<string, unknown>;
    if (typeof body.slug !== "string" || !body.slug.trim()) {
      return NextResponse.json({ error: "slug is required." }, { status: 400 });
    }
    return NextResponse.json({ run: await compileKnowledgePage(principal.handle, body.slug.trim()) });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json({ error: message }, { status: /not found|invalid/i.test(message) ? 400 : 500 });
  }
}
