import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { normalizeReviewCount } from "@/lib/review-count";
import { resolveV1Caller } from "@/lib/v1-route";
import {
  isPendingReview,
  pendingReviewCount,
  reopenReviewItem,
  reviewSnapshot,
  reviewSnapshotIncludingResolved,
  skipReviewItem,
} from "@/lib/review-queue";
import { V1_UNKNOWN_ACTION_ERROR, v1BulkReviewIntent } from "@/lib/v1-contract";

interface RouteContext {
  params: Promise<{ wikiId: string }>;
}

/**
 * `GET /api/v1/projects/{id}/reviews` — the Review queue, read-only
 * (Story 8.2).
 *
 * THE SAME SNAPSHOT the Review canvas renders, from `reviewSnapshot`, which is
 * what also drains the outbox and recovers interrupted creates. Reading the raw
 * store instead would show an agent items the product has already resolved.
 *
 * `resolved` is DERIVED from status rather than stored: the queue's vocabulary is
 * `pending | creating | skipped | created`, and FR-76's is a boolean. Deriving it
 * here keeps one truth — a `creating` item is not resolved yet, which is exactly
 * why an agent must not re-issue `create_page` for it.
 */
export async function GET(request: Request, { params }: RouteContext) {
  const { wikiId } = await params;
  const caller = await resolveV1Caller(wikiId, request);
  if (!caller.ok) {
    return NextResponse.json({ error: caller.error }, { status: caller.status });
  }
  try {
    // OPEN BY DEFAULT, because "what needs my attention" is the question, and a
    // queue that has been used for a month would otherwise answer mostly with
    // history. `all` exists so a caller can find something it dismissed and
    // reopen it — see `reviewSnapshotIncludingResolved`.
    const scope =
      new URL(request.url).searchParams.get("status") === "all" ? "all" : "open";
    // `wikiId ?? undefined` — a workspace with no Wiki asks for the UNSCOPED
    // queue rather than for the queue of a Wiki named `null`.
    const snapshot =
      scope === "all"
        ? await reviewSnapshotIncludingResolved(
            caller.principal.handle,
            caller.wikiId ?? undefined,
          )
        : await reviewSnapshot(
            caller.principal.handle,
            caller.wikiId ?? undefined,
          );
    return NextResponse.json({
      wikiId: caller.requested,
      status: scope,
      pendingCount: snapshot.pendingCount,
      reviews: snapshot.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        title: item.title,
        summary: item.summary,
        path: item.path,
        queries: item.queries,
        status: item.status,
        resolved: !isPendingReview(item),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(item.pageSlug ? { pageSlug: item.pageSlug } : {}),
        ...(item.sourcePath ? { sourcePath: item.sourcePath } : {}),
      })),
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

/**
 * `PATCH /api/v1/projects/{id}/reviews` — bulk resolve / reopen (Story 8.2).
 *
 * DISMISS AND UNDISMISS ONLY. `create_page` and `deep_research` are refused here
 * with a 400 that names the per-item route, and that is the point rather than an
 * omission: a bulk create would mint a page per card in one unattended call, and
 * a bulk `deep_research` would open an investigation per card against the
 * owner's provider budget. Dismissal is the one verb that is cheap to undo —
 * which is why the reopen it pairs with lives here too.
 *
 * IDS OR NOTHING. There is no "resolve the whole queue" form: `ids` is required
 * and capped by `v1BulkReviewIntent`, so a caller has to have LISTED what it is
 * dismissing. "Clear everything" issued by an agent that never read the
 * queue is indistinguishable from a bug, and the queue is the wiki telling the
 * owner what it is missing.
 *
 * PER-ITEM RESULTS, never one aggregate boolean. Some ids will be unknown or
 * already created; the caller is told which, because "17 of 20" with no names is
 * not something it can act on.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
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
  const owner = caller.principal.handle;
  const scope = caller.wikiId ?? undefined;
  try {
    const body = (await request.json().catch(() => ({}))) as {
      ids?: unknown;
      resolved?: unknown;
      action?: unknown;
    };
    const intent = v1BulkReviewIntent(body);
    if (intent.kind === "invalid") {
      return NextResponse.json(
        { error: V1_UNKNOWN_ACTION_ERROR, detail: intent.reason },
        { status: 400 },
      );
    }
    const results: { id: string; ok: boolean; status?: string }[] = [];
    for (const id of intent.ids) {
      const item =
        intent.kind === "reopen"
          ? await reopenReviewItem(owner, id, scope)
          : await skipReviewItem(owner, id, scope);
      results.push(
        item ? { id, ok: true, status: item.status } : { id, ok: false },
      );
    }
    let pendingCount: number | undefined;
    try {
      pendingCount =
        normalizeReviewCount(await pendingReviewCount(owner, scope)) ?? 0;
    } catch {
      pendingCount = undefined;
    }
    return NextResponse.json({
      wikiId: caller.requested,
      action: intent.kind,
      requested: intent.ids.length,
      changed: results.filter((row) => row.ok).length,
      results,
      ...(pendingCount === undefined ? {} : { pendingCount }),
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
