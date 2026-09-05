import { NextResponse } from "next/server";
import { isReadOnly } from "@/lib/config";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
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
import { ResearchProjectBusyError, createResearchProject } from "@/lib/research-projects";
import {
  V1_INVALID_INPUT_ERROR,
  V1_UNKNOWN_ACTION_ERROR,
  v1ReviewIntent,
} from "@/lib/v1-contract";
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
        const existing = await getReviewItem(owner, reviewId, scope);
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

    const item = await getReviewItem(owner, reviewId, scope);
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
    // The read-only 403 stays FIRST: a `ReadOnlyError` is not the caller's bad
    // input and must not be reclassified by the branch below.
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    // Classification by TYPE alone, the `src/app/api/research/route.ts` idiom
    // (DW-478). `deep_research` calls `createResearchProject`, so both the
    // `MAX_PROJECTS` refusal and `cleanInput`'s verdict on `item.title` land
    // here — and an agent told "500" retries a request that can never succeed.
    //
    // THREE RUNGS, NOT TWO. DW-478 split this ladder caller-fault/server-fault,
    // and DW-684 added the middle rung at the `/api/research` doors: a
    // contended registry write is neither, and the 503 below is where it goes.
    // So read what follows as 400 / 503 / 500 — the two-way split was only ever
    // the first two thirds of the classification.
    //
    // The caller-fault body is TWO HALVES: `error` is the façade's machine
    // token, the thing an agent switch-cases on as it does at every other 4xx
    // here, and `detail` carries the store's own sentence, which is the only
    // part that says WHICH input was wrong. The 500 body stays the bare
    // message: a server fault has no token vocabulary and nothing to branch on.
    if (isClientInputError(error)) {
      return NextResponse.json(
        { error: V1_INVALID_INPUT_ERROR, detail: getErrorMessage(error) },
        { status: 400 },
      );
    }
    // THE 503 RUNG (DW-732), matching the ladder DW-684 left in the five
    // `/api/research` doors. This door calls the SAME `createResearchProject`,
    // so it reaches the same exhausted compare-and-swap and catches the same
    // `ResearchProjectBusyError` — transient contention over the registry,
    // whose own sentence already says "retry the request." DW-684 enumerated
    // the three `/api/research` siblings and this door was outside its intent,
    // which left one store giving two verdicts about one moment of contention:
    // an agent here was told a write that provably never landed was a permanent
    // server fault, and stopped retrying the one thing that would have worked.
    //
    // BARE-MESSAGE BODY, not the token-plus-detail shape above, because the
    // split is caller-fault versus server-fault and contention is neither the
    // caller's mistake nor a vocabulary an agent switch-cases on. The store's
    // own sentence is the whole answer. Ordered AFTER the 400 and before the
    // 500 fallthrough — the `research/route.ts` ladder, rung for rung.
    if (error instanceof ResearchProjectBusyError) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 503 });
    }
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
