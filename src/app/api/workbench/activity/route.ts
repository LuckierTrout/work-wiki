import { NextRequest, NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
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
  activityDisplayStatus,
  type ActivityRow,
} from "@/lib/workbench-activity";
import { INTAKE_SIGN_IN_COPY } from "@/lib/workbench-intake";
import { sourceRestFromPath } from "@/lib/source-cascade";

/**
 * GET /api/workbench/activity — Activity poll source.
 * POST { action: "cancel" | "retry", jobId } — cancel before Page writes, or
 * re-queue the same stored Source (no second store).
 */

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
  }
  const jobs = await listIngestJobs({ owner: principal.handle, limit: 100 });
  const rows: ActivityRow[] = jobs.map((job) => {
    const { status, error } = effectiveStatus(job);
    const displayStatus = activityDisplayStatus(
      status,
      job.stage,
      job.kind,
      job.cancelled,
    );
    return {
      jobId: job.jobId,
      title: job.title?.trim() || job.url || "Ingest",
      displayStatus,
      ...(error || job.error ? { error: error || job.error } : {}),
      ...(typeof job.progressDone === "number" ? { progressDone: job.progressDone } : {}),
      ...(typeof job.progressTotal === "number" ? { progressTotal: job.progressTotal } : {}),
      canCancel: !job.cancelled && (status === "queued" || status === "processing"),
      canRetry: status === "failed",
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
        );
        const served = (await response.json().catch(() => ({}))) as Record<string, unknown>;
        return NextResponse.json({ ...served, retried: true }, { status: response.status });
      }
      if (!job.sourceRel) {
        return NextResponse.json({ error: "This job has no stored Source to retry." }, { status: 400 });
      }
      const rest = sourceRestFromPath(job.sourceRel);
      if (!rest) {
        return NextResponse.json({ error: "This job has no stored Source to retry." }, { status: 400 });
      }
      const text = await getStorage().readFile(rawSourceRelPath(rest));
      const reuseAnalysis = job.jobId ? await hasIngestAnalysis(job.jobId) : false;
      const task: Task = {
        kind: "ingest",
        content: text,
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        jobId: job.jobId,
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
      const response = await enqueueOrInline(job.jobId, task, () =>
        ingest(job.title || "Untitled", text, {
          owner: principal.handle,
          author: principal.handle,
          triggeredBy: principal.handle,
          jobId: job.jobId,
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
