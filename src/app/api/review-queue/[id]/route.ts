import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { normalizeReviewCount } from "@/lib/review-count";
import {
  createPageFromReview,
  pendingReviewCount,
  skipReviewItem,
} from "@/lib/review-queue";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const principal = await requireOwnerPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }
  if (isReadOnly()) {
    return NextResponse.json({ error: READ_ONLY_REFUSAL.reviewQueue }, { status: 403 });
  }
  try {
    const { id } = await params;
    const body = (await request.json().catch(() => ({}))) as { action?: unknown; wikiId?: unknown };
    const wikiId = typeof body.wikiId === "string" ? body.wikiId.trim() : "";
    if (!wikiId) {
      return NextResponse.json({ error: "wikiId is required." }, { status: 400 });
    }
    const count = async (): Promise<number | undefined> => {
      try {
        return normalizeReviewCount(await pendingReviewCount(principal.handle, wikiId)) ?? 0;
      } catch {
        return undefined;
      }
    };
    if (body.action === "skip") {
      const item = await skipReviewItem(principal.handle, id, wikiId);
      if (!item) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const pendingCount = await count();
      return NextResponse.json({ item, ...(pendingCount === undefined ? {} : { pendingCount }) });
    }
    if (body.action === "create-page") {
      const created = await createPageFromReview(
        principal.handle,
        id,
        principal.handle,
        wikiId,
      );
      if (!created) return NextResponse.json({ error: "Not found." }, { status: 404 });
      const pendingCount = await count();
      return NextResponse.json({
        item: created.item,
        slug: created.slug,
        ...(pendingCount === undefined ? {} : { pendingCount }),
      });
    }
    return NextResponse.json(
      { error: "action must be skip or create-page." },
      { status: 400 },
    );
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
