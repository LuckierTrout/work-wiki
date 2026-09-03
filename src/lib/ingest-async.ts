/**
 * Shared async-ingest dispatch for the ingest routes. Each interactive/API
 * ingest creates a job and returns `{ queued, jobId }` for the client to poll
 * (`/api/ingest/status/[jobId]`); the work is enqueued on Workers, or run inline
 * off-Workers (local dev / tests, where the queue is absent). This helper
 * centralizes that enqueue-or-inline so the URL/text/PDF/image routes don't each
 * carry a copy (which would drift).
 */
import { NextResponse } from "next/server";
import { enqueueTask, type Task } from "./tasks";
import { updateIngestJob } from "./ingest-jobs";
import { getErrorMessage } from "./errors";
import { logger } from "./logger";
import { dispatchMeetingTodoExtract } from "./todo-dispatch";
import { enqueueReviewAfterIngest, ReviewDeliveryUnretainedError } from "./review-queue";
import { hasIngestAnalysis } from "./ingest-analysis";

/** Mark a job failed (best-effort; a status-write blip must not mask the real
 *  error we're about to rethrow — but log it rather than swallowing silently). */
async function markFailed(jobId: string, err: unknown): Promise<void> {
  await updateIngestJob(jobId, {
    status: "failed",
    error: getErrorMessage(err),
  }).catch((writeErr) =>
    logger.warn("ingest", `failed to mark job ${jobId} failed`, writeErr),
  );
}

/** Per-call options for {@link enqueueOrInline}. */
export interface EnqueueOrInlineOptions {
  /**
   * How long the CALLER can still wait for the off-Workers inline run, in ms.
   *
   * OPT-IN, and measured as a REMAINDER (DW-700). The Workbench intake route is
   * the door THIS change bounds: it sits under a client deadline
   * (`REQUEST_TIMEOUT_MS`) that the full inline `ingest()` could outlast, so the
   * client aborted and reported a Source that had already landed as an unknown
   * outcome. Every other caller (`/api/ingest*`, agents, email, activity,
   * extract-dispatch) omits it and behaves exactly as before.
   *
   * NOT because no other door has the shape. `src/app/api/workbench/activity/
   * route.ts` runs an unbounded inline `ingest()` on both the retry and the
   * embed-rebuild paths, and `ActivityDock.tsx` reaches them through the same
   * `send` helper and therefore the same deadline. Those are still open; they
   * are simply outside what DW-700 covered. Passing this option is what closes
   * one of them, and the argument is the same wherever it is added next.
   *
   * When it elapses the run is NOT cancelled and the job record is NOT
   * abandoned: the continuation goes on to mark the job `done`/`failed` exactly
   * as it would have, and the route simply answers `{ queued: true, jobId }` —
   * the shape the client already polls — instead of holding the connection open
   * past the point the client will listen.
   */
  inlineBudgetMs?: number;
}

/**
 * Enqueue `task` and return `{ queued: true, jobId }`. When the queue is absent
 * (off-Workers — local dev / tests), run `inline()` synchronously and mark the
 * job `done` so the same poll-based client flow still resolves. If EITHER the
 * enqueue OR the inline run throws after the job exists, mark it `failed` (so it
 * can't show "working…" until the 20-min stale fallback) and rethrow as a 500.
 *
 * With `inlineBudgetMs` the inline half is RACED against that remainder rather
 * than awaited outright — see {@link EnqueueOrInlineOptions.inlineBudgetMs}.
 */
export async function enqueueOrInline(
  jobId: string,
  task: Task,
  inline: () => Promise<{ primarySlug: string; skipped?: boolean }>,
  options?: EnqueueOrInlineOptions,
): Promise<NextResponse> {
  let enqueued: boolean;
  try {
    enqueued = await enqueueTask(task);
  } catch (e) {
    await markFailed(jobId, e);
    throw e;
  }
  if (enqueued) {
    return NextResponse.json({ queued: true, jobId });
  }

  const budgetMs = options?.inlineBudgetMs;
  if (budgetMs === undefined) {
    // No budget: awaited outright, byte-for-byte the pre-DW-700 path.
    return await runInline(jobId, task, inline);
  }

  const run = runInline(jobId, task, inline);
  let abandoned = false;
  // Attached BEFORE the race, so there is no turn in which a rejection from an
  // abandoned run is unowned. While the race is still live this handler is a
  // no-op — the race itself surfaces that rejection to the caller.
  run.catch((err) => {
    if (abandoned) {
      logger.warn(
        "ingest",
        `inline ingest for ${jobId} failed after the answer budget elapsed`,
        err,
      );
    }
  });

  const elapsed = Symbol("inline-budget-elapsed");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let outcome: NextResponse | typeof elapsed;
  try {
    outcome = await Promise.race([
      run,
      new Promise<typeof elapsed>((resolve) => {
        timer = setTimeout(() => resolve(elapsed), Math.max(0, budgetMs));
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }

  if (outcome === elapsed) {
    // The Source is stored, the job record exists, and the work is still in
    // flight — which is precisely what `{ queued: true, jobId }` says. Nothing
    // is rolled back and the continuation still marks the job.
    abandoned = true;
    return NextResponse.json({ queued: true, jobId });
  }
  return outcome;
}

/**
 * The whole off-Workers inline half: run the compile, then compose the response
 * from what it produced.
 *
 * Extracted from {@link enqueueOrInline} so the budget above has ONE promise to
 * race. The composition below — skipped, meeting extract, Review enqueue, the
 * terminal `updateIngestJob` — is what has to keep running when the caller has
 * already been answered, so it must not be split across the race.
 */
async function runInline(
  jobId: string,
  task: Task,
  inline: () => Promise<{ primarySlug: string; skipped?: boolean }>,
): Promise<NextResponse> {
  // Off-Workers inline path: mark failed on throw too (symmetric with the
  // enqueue branch) so the failure is immediate, not 20 minutes later.
  let result: { primarySlug: string; skipped?: boolean };
  try {
    result = await inline();
  } catch (e) {
    await markFailed(jobId, e);
    throw e;
  }
  if (result.skipped) {
    const retryOwner =
      task.kind === "ingest"
        ? task.triggeredBy?.trim() || task.owner?.trim() || task.author?.trim()
        : undefined;
    if (retryOwner && result.primarySlug) {
      let shouldRetry = false;
      try {
        shouldRetry = await hasIngestAnalysis(jobId);
      } catch (err) {
        // The compile result is already known. Let the delivery helper perform
        // its own read and durable outbox fallback without failing the job.
        shouldRetry = true;
        logger.warn("ingest", `analysis check failed after skipped job ${jobId}`, err);
      }
      if (shouldRetry) {
        try {
          await enqueueReviewAfterIngest({
            owner: retryOwner,
            pageSlug: result.primarySlug,
            jobId,
          });
        } catch (err) {
          logger.warn("ingest", `review-queue retry after skip failed for ${jobId}`, err);
          if (err instanceof ReviewDeliveryUnretainedError) {
            await updateIngestJob(jobId, {
              status: "failed",
              error: err.message,
              ...(result.primarySlug ? { slug: result.primarySlug } : {}),
            });
            return NextResponse.json({
              queued: false,
              skipped: true,
              jobId,
              ...(result.primarySlug ? { slug: result.primarySlug } : {}),
              error: err.message,
            });
          }
        }
      }
    }
    await updateIngestJob(jobId, {
      status: "skipped",
      stage: "complete",
      ...(result.primarySlug ? { slug: result.primarySlug } : {}),
    });
    return NextResponse.json({
      queued: false,
      skipped: true,
      jobId,
      ...(result.primarySlug ? { slug: result.primarySlug } : {}),
    });
  }
  const extractOwner = task.kind === "ingest"
    ? task.triggeredBy?.trim() || task.owner?.trim() || task.author?.trim()
    : undefined;
  if (extractOwner && result.primarySlug && task.kind === "ingest") {
    await dispatchMeetingTodoExtract(
      extractOwner,
      {
        origin: task.origin,
        sourcePath: task.sourcePath,
        slug: result.primarySlug,
      },
      { failSoft: true },
    );
    try {
      await enqueueReviewAfterIngest({
        owner: extractOwner,
        pageSlug: result.primarySlug,
        jobId,
      });
    } catch (err) {
      logger.warn("ingest", `review-queue enqueue failed for ${jobId}`, err);
      if (err instanceof ReviewDeliveryUnretainedError) {
        await updateIngestJob(jobId, {
          status: "failed",
          error: err.message,
          ...(result.primarySlug ? { slug: result.primarySlug } : {}),
        });
        return NextResponse.json({
          queued: true,
          jobId,
          ...(result.primarySlug ? { slug: result.primarySlug } : {}),
          error: err.message,
        });
      }
    }
  }
  await updateIngestJob(jobId, {
    status: "done",
    ...(result.primarySlug ? { slug: result.primarySlug } : {}),
  });
  return NextResponse.json({
    queued: true,
    jobId,
    ...(result.primarySlug ? { slug: result.primarySlug } : {}),
  });
}
