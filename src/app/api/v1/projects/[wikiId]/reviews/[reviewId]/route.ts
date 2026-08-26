import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnlyError, READ_ONLY_REFUSAL } from "@/lib/read-only";
import { normalizeReviewCount } from "@/lib/review-count";
import {
  createPageFromReview,
  getReviewItem,
  isPendingReview,
  pendingReviewCount,
  reopenReviewItem,
  skipReviewItem,
  type ReviewItem,
} from "@/lib/review-queue";
import { createResearchProject } from "@/lib/research-projects";
import { V1_UNKNOWN_ACTION_ERROR, v1ReviewIntent } from "@/lib/v1-contract";
import { readV1JsonBody, resolveV1Caller } from "@/lib/v1-route";

interface RouteContext {
  params: Promise<{ wikiId: string; reviewId: string }>;
}

function shape(item: ReviewItem) {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    summary: item.summary,
    path: item.path,
    queries: item.queries,
    status: item.status,
    resolved: !isPendingReview(item),
    updatedAt: item.updatedAt,
    ...(item.pageSlug ? { pageSlug: item.pageSlug } : {}),
  };
}

/**
 * `PATCH /api/v1/projects/{id}/reviews/{reviewId}` — the FR-23 action set, over
 * HTTP (Story 8.2).
 *
 * FOUR INTENTS out of two fields, resolved by `v1ReviewIntent` in the contract
 * module rather than by an `if` ladder here, so the node suite can execute the
 * mapping without standing up a Worker. `{ resolved: false }` reopens,
 * `create_page` creates, `skip` dismisses, `deep_research` opens a Research
 * draft. An action that is neither is a 400 — a typo'd verb must never be read
 * as the destructive one.
 *
 * `deep_research` DOES NOT RUN ANYTHING. It creates a `draft` Research project
 * seeded from the review's own queries and returns it. Deep Research spends real
 * provider budget and the product gates it behind an explicit confirm; a route
 * that started a run because an agent asked would be that confirm removed. The
 * review also stays PENDING through it — opening an investigation is not
 * dismissing the suggestion that prompted it.
 *
 * WRITES, so read-only refuses before anything is attempted, and the refusal is
 * the same sentence the in-product Review desk gives.
 */
export async function PATCH(request: Request, { params }: RouteContext) {
  const { wikiId, reviewId } = await params;
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
    const parsed = await readV1JsonBody(request);
    if (!parsed.ok) return parsed.response;
    const body = parsed.body as {
      resolved?: unknown;
      action?: unknown;
    };
    const intent = v1ReviewIntent(body);
    if (intent.kind === "invalid") {
      return NextResponse.json(
        { error: V1_UNKNOWN_ACTION_ERROR },
        { status: 400 },
      );
    }
    // Counted AFTER the write, and never allowed to fail the request: the badge
    // is a courtesy, and a caller that just created a page should not be told
    // the create failed because a second read did.
    const count = async (): Promise<number | undefined> => {
      try {
        return normalizeReviewCount(await pendingReviewCount(owner, scope)) ?? 0;
      } catch {
        return undefined;
      }
    };
    const answer = async (item: ReviewItem, extra: object = {}) => {
      const pendingCount = await count();
      return NextResponse.json({
        review: shape(item),
        ...extra,
        ...(pendingCount === undefined ? {} : { pendingCount }),
      });
    };

    if (intent.kind === "reopen") {
      const item = await reopenReviewItem(owner, reviewId, scope);
      if (!item) {
        // 409, not 404, when the row exists but is not reopenable: "already
        // created" is a different problem from "no such review", and only one of
        // them is worth retrying.
        const existing = await getReviewItem(owner, reviewId);
        return existing
          ? NextResponse.json(
              { error: "not_reopenable", status: existing.status },
              { status: 409 },
            )
          : NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return answer(item);
    }

    if (intent.kind === "skip") {
      const item = await skipReviewItem(owner, reviewId, scope);
      if (!item) return NextResponse.json({ error: "not_found" }, { status: 404 });
      return answer(item);
    }

    if (intent.kind === "create_page") {
      const created = await createPageFromReview(owner, reviewId, owner, scope);
      if (!created) {
        return NextResponse.json({ error: "not_found" }, { status: 404 });
      }
      return answer(created.item, { slug: created.slug });
    }

    const item = await getReviewItem(owner, reviewId);
    if (!item || !isPendingReview(item)) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    const project = await createResearchProject(owner, {
      title: item.title,
      // The review's SUMMARY is the question, because that is the sentence the
      // ingest analysis wrote about what the wiki is missing. Inventing a
      // question here would research something the owner never observed.
      question: item.summary || item.title,
      queries: item.queries,
      ...(item.pageSlug ? { pageSlugs: [item.pageSlug] } : {}),
    });
    return answer(item, {
      research: { id: project.id, status: project.status, title: project.title },
      // SAID OUT LOUD, because the alternative reading — "I asked for deep
      // research and it silently did nothing" — is exactly what an agent would
      // otherwise conclude from a 200 with no run.
      confirmRequired: true,
    });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
