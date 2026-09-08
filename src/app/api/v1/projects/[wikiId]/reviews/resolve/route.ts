import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { skipReviewItem } from "@/lib/review-queue";
import { V1_UNKNOWN_ACTION_ERROR, v1BulkReviewIntent } from "@/lib/v1-contract";
import { resolveV1Caller } from "@/lib/v1-route";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `POST /api/v1/projects/{id}/reviews/resolve` — FR-76 bulk skip.
 *
 * THE COLLECTION PATCH is the reopen/skip pair with per-item results. This
 * door is the skill-facing spelling: `{ ids, action: "skip" }` in, and
 * `{ resolved, notFound, count }` out. `create_page` and `deep_research` stay
 * on the per-review PATCH — a bulk create is not a resolve.
 */
export async function POST(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.reviewQueue },
      { status: 403 },
    );
  }
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ids?: unknown;
      resolved?: unknown;
      action?: unknown;
    };
    const intent = v1BulkReviewIntent(body);
    if (intent.kind !== "skip") {
      return NextResponse.json(
        {
          error: V1_UNKNOWN_ACTION_ERROR,
          detail:
            intent.kind === "invalid"
              ? intent.reason
              : "POST .../reviews/resolve only skips; reopen is PATCH .../reviews",
        },
        { status: 400 },
      );
    }
    const resolved: string[] = [];
    const notFound: string[] = [];
    for (const id of intent.ids) {
      const item = await skipReviewItem(
        caller.principal.handle,
        id,
        caller.wikiId ?? undefined,
      );
      if (item) resolved.push(id);
      else notFound.push(id);
    }
    return NextResponse.json({
      resolved,
      notFound,
      count: resolved.length,
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
