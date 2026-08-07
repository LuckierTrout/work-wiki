import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getDocumentLineage } from "@/lib/document-lineage";
import { getErrorMessage } from "@/lib/errors";
import { decodeSlug } from "@/lib/slugify";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ slug: string }> },
) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  try {
    const { slug: encodedSlug } = await params;
    const slug = decodeSlug(encodedSlug);
    const lineage = await getDocumentLineage(principal, slug);
    if (!lineage) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    return NextResponse.json({ lineage });
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: /invalid|not found/i.test(message) ? 404 : 500 },
    );
  }
}
