import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { normalizeReviewCount } from "@/lib/review-count";
import { reviewSnapshot } from "@/lib/review-queue";

export async function GET(request: Request) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const rawWikiId = new URL(request.url).searchParams.get("wikiId");
    const wikiId = rawWikiId?.trim();
    if (!wikiId) {
      return NextResponse.json({ error: "wikiId is required." }, { status: 400 });
    }
    const { items, pendingCount: rawCount } = await reviewSnapshot(
      principal.handle,
      wikiId,
    );
    const pendingCount = normalizeReviewCount(rawCount) ?? items.length;
    return NextResponse.json({ items, pendingCount, wikiId });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
