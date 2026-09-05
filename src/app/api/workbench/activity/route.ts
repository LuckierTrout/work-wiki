import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ACTIVITY_ANSWER_BUDGET_MS } from "@/lib/constants";
import { hasIngestAnalysis } from "@/lib/ingest-analysis";
import { enqueueOrInline } from "@/lib/ingest-async";
import { ingest } from "@/lib/ingest";
import {
  cancelIngestJob,
  effectiveStatus,
  listIngestJobs,
  retryIngestJob,
} from "@/lib/ingest-jobs";
import { logger } from "@/lib/logger";
import { getStorage } from "@/lib/storage";
import { rawSourceRelPath } from "@/lib/raw";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { getErrorMessage } from "@/lib/errors";
import { type Task } from "@/lib/tasks";
import {
  ACTIVITY_EXTRACT_BYTES_KEPT_COPY,
  EXTRACT_RETRY_UNAVAILABLE_COPY,
  activityDisplayStatus,
  type ActivityRow,
} from "@/lib/workbench-activity";
import { retryExtract } from "@/lib/extract-dispatch";
import {
  INTAKE_EXTENSIONS,
  INTAKE_SIGN_IN_COPY,
  intakeRequiresExtract,
  isIntakeMediaFormat,
} from "@/lib/workbench-intake";
import { sourceRestFromPath } from "@/lib/source-delete";

/**
 * GET /api/workbench/activity — Activity poll source.
 * POST { action: "cancel" | "retry", jobId } — cancel before Page writes, or
 * re-queue the same stored Source (no second store).
 */

/** Does this stored Source hold bytes no UTF-8 read can turn back into text? */
function isBinarySource(sourceRel: string | undefined): boolean {
  if (!sourceRel) return false;
  const name = sourceRel.slice(sourceRel.lastIndexOf("/") + 1).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  const format = INTAKE_EXTENSIONS[name.slice(dot + 1)];
  return Boolean(format) && (intakeRequiresExtract(format) || isIntakeMediaFormat(format));
}

export async function GET(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
  }
  const wikiId = new URL(request.url).searchParams.get("wikiId")?.trim() || undefined;
  const jobs = await listIngestJobs({
    owner: principal.handle,
    limit: 100,
    ...(wikiId ? { wikiId } : {}),
  });
  const rows: ActivityRow[] = jobs.map((job) => {
    const { status, error } = effectiveStatus(job);
    const displayStatus = activityDisplayStatus(
      status,
      job.stage,
      job.kind,
      job.cancelled,
    );
    // A failed extract still has its bytes: `enqueueExtract` stores them before
    // it queues anything, and every failure path marks records rather than
    // deleting files. Saying so on the row is what makes that guarantee visible
    // at the moment the owner most needs it — a red row otherwise reads as
    // "the upload was lost", and the usual response is to upload it again.
    const bytesKept =
      displayStatus === "failed" && job.kind === "extract" && Boolean(job.sourceRel);
    return {
      jobId: job.jobId,
      title: job.title?.trim() || job.url || "Ingest",
      displayStatus,
      ...(job.wikiId ? { wikiId: job.wikiId } : {}),
      ...(error || job.error ? { error: error || job.error } : {}),
      ...(bytesKept ? { note: ACTIVITY_EXTRACT_BYTES_KEPT_COPY } : {}),
      ...(typeof job.progressDone === "number" ? { progressDone: job.progressDone } : {}),
      ...(typeof job.progressTotal === "number" ? { progressTotal: job.progressTotal } : {}),
      canCancel:
        !job.cancelled &&
        !job.sourceDeleted &&
        (status === "queued" || status === "processing" || status === "retrying"),
      canRetry: status === "failed" && !job.sourceDeleted,
    };
  });
  return NextResponse.json({ rows });
}

export async function POST(request: NextRequest) {
  try {
    const principal = await getPrincipal();
    if (!principal) {
      return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
    }
    if (isReadOnly()) {
      return NextResponse.json({ error: READ_ONLY_REFUSAL.ingest }, { status: 403 });
    }

    // THE REQUEST'S OWN DEADLINE (DW-746), captured after the 401/403 and
    // before any work, so what is handed to the inline runs below is the
    // REMAINDER — what the job read and the Source read left over — rather
    // than a fixed margin that cannot bound total work. Ordered against
    // `REQUEST_TIMEOUT_MS`, the deadline `send` arms for every `ActivityDock`
    // call. See `ACTIVITY_ANSWER_BUDGET_MS`.
    const answerBy = Date.now() + ACTIVITY_ANSWER_BUDGET_MS;

    const body = (await request.json().catch(() => ({}))) as {
      action?: unknown;
      jobId?: unknown;
    };
    const jobId = typeof body.jobId === "string" ? body.jobId.trim() : "";
    if (!jobId) {
      return NextResponse.json({ error: "jobId is required." }, { status: 400 });
    }

    if (body.action === "cancel") {
      const job = await cancelIngestJob(jobId, principal.handle);
      if (!job) return NextResponse.json({ error: "Job not found." }, { status: 404 });
      return NextResponse.json({ ok: true, cancelled: true });
    }

    if (body.action === "retry") {
      const job = await retryIngestJob(jobId, principal.handle);
      if (!job) return NextResponse.json({ error: "Job cannot be retried." }, { status: 400 });
      if (job.kind === "embed") {
        const response = await enqueueOrInline(
          job.jobId,
          {
            kind: "ingest",
            owner: principal.handle,
            jobId: job.jobId,
            rebuildEmbeddings: true,
            ...(job.title ? { title: job.title } : {}),
          },
          async () => {
            const { rebuildVectorStore } = await import("@/lib/embeddings");
            await rebuildVectorStore();
            return { primarySlug: "" };
          },
          // Whatever is LEFT of the answer budget (DW-746). A whole-wiki
          // `rebuildVectorStore()` can outlast `REQUEST_TIMEOUT_MS`, the
          // deadline `send` arms in `ActivityDock`; past this point the route
          // answers `{ queued: true, jobId, retried: true }` and the run goes
          // on marking the job.
          //
          // WHAT THAT AVOIDS, precisely: the dock's retry `.catch` is
          // `setError(cause.message)` — it does NOT reach `unconfirmedCause`
          // or `writeFailure`, so an abort here shows the owner the abort's
          // own mechanism sentence ("signal timed out") beside a row whose
          // rebuild is still running and will still be marked. Not an
          // "unknown outcome" verdict; a bare timeout against live work.
          { inlineBudgetMs: Math.max(0, answerBy - Date.now()) },
        );
        const served = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return NextResponse.json({ ...served, retried: true }, { status: response.status });
      }
      if (!job.sourceRel) {
        return NextResponse.json({ error: "This job has no stored Source to retry." }, { status: 400 });
      }
      // BINARIES GO BACK TO THE SIDECAR, never through the text path below
      // (Story 7.1). `readFile` decodes UTF-8, so retrying a failed PDF this
      // way compiled a page of replacement characters — a corrupted Page from
      // a button labelled Retry, with nothing on screen saying so. Decided by
      // the job's kind AND by what the stored Source actually is, because a
      // record written before the `extract` kind existed still names a `.pdf`.
      if (job.kind === "extract" || isBinarySource(job.sourceRel)) {
        if (await retryExtract(principal.handle, job.jobId)) {
          return NextResponse.json({ ok: true, retried: true, extract: true });
        }
        return NextResponse.json(
          { error: EXTRACT_RETRY_UNAVAILABLE_COPY },
          { status: 400 },
        );
      }

      const rest = sourceRestFromPath(job.sourceRel);
      if (!rest) {
        return NextResponse.json({ error: "This job has no stored Source to retry." }, { status: 400 });
      }
      const text = await getStorage().readFile(rawSourceRelPath(rest));
      const reuseAnalysis = job.jobId ? await hasIngestAnalysis(job.jobId) : false;
      const task: Task = {
        kind: "ingest",
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        jobId: job.jobId,
        ...(job.wikiId ? { tags: [`wiki:${job.wikiId}`] } : {}),
        ...(job.title ? { title: job.title } : {}),
        ...(job.origin ? { origin: job.origin } : {}),
        ...(job.relativePath ? { relativePath: job.relativePath } : {}),
        ...(job.sourceType === "url" || job.sourceType === "text"
          ? { sourceType: job.sourceType }
          : {}),
        ...(job.url ? { sourceUrl: job.url } : {}),
        ...(job.contentSha256 ? { contentSha256: job.contentSha256 } : {}),
        sourcePath: job.sourceRel,
        ...(reuseAnalysis ? { reuseAnalysis: true } : {}),
      };
      // Same budget as the embed path above, and for the same reason (DW-746):
      // the inline `ingest()` is the long step, `ActivityDock` reaches it
      // through `send`'s `REQUEST_TIMEOUT_MS`, and the remainder is what the
      // job read and the stored-Source read left of the route's answer budget.
      // Past it the owner would see the abort's own "signal timed out" from the
      // dock's `setError(cause.message)` — not an unconfirmed-write verdict —
      // while the compile it names goes on and marks the job.
      const response = await enqueueOrInline(
        job.jobId,
        task,
        () =>
          ingest(job.title || "Untitled", text, {
            owner: principal.handle,
            author: principal.handle,
            triggeredBy: principal.handle,
            jobId: job.jobId,
            ...(job.wikiId ? { tags: [`wiki:${job.wikiId}`] } : {}),
            ...(job.origin ? { origin: job.origin } : {}),
            ...(job.relativePath ? { relativePath: job.relativePath } : {}),
            ...(job.sourceType === "url" || job.sourceType === "text"
              ? { sourceType: job.sourceType }
              : {}),
            ...(job.url ? { sourceUrl: job.url } : {}),
            ...(job.contentSha256 ? { contentSha256: job.contentSha256 } : {}),
            reuseAnalysis,
            sourcePath: job.sourceRel,
          }),
        { inlineBudgetMs: Math.max(0, answerBy - Date.now()) },
      );
      const served = (await response.json().catch(() => ({}))) as Record<string, unknown>;
      return NextResponse.json({ ...served, retried: true }, { status: response.status });
    }

    return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    logger.error("activity", "workbench activity error", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
