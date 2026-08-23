import { NextResponse } from "next/server";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { listReviewItems, pendingReviewCount } from "@/lib/review-queue";

export async function GET() {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  try {
    const [items, pendingCount] = await Promise.all([
      listReviewItems(principal.handle),
      pendingReviewCount(principal.handle),
    ]);
    return NextResponse.json({ items, pendingCount });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
