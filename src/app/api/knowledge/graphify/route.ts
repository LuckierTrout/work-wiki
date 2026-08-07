import { NextResponse } from "next/server";
import { getPrincipal } from "@/lib/auth";
import { getErrorMessage } from "@/lib/errors";
import {
  createGraphifyJob,
  effectiveGraphifyJob,
  failGraphifyPages,
  getLatestGraphifyJob,
  listGraphifiableWikiPages,
  prepareGraphifyRetry,
  type GraphifyJob,
} from "@/lib/graphify-jobs";
import { enqueueTasks, type Task } from "@/lib/tasks";

function statusForError(message: string): number {
  if (/not found/i.test(message)) return 404;
  if (/invalid|no owner pages|no pages to retry|at most/i.test(message)) return 400;
  return 500;
}

async function queueGraphifyPages(
  owner: string,
  job: GraphifyJob,
  slugs: readonly string[],
): Promise<{ job: GraphifyJob; enqueued: number; warning?: string; status: number }> {
  const tasks: Task[] = slugs.map((slug) => ({
    kind: "extract-knowledge",
    slug,
    owner,
    graphifyJobId: job.jobId,
  }));
  const result = await enqueueTasks(tasks);
  if (result.enqueued === tasks.length) {
    return { job, enqueued: result.enqueued, status: 202 };
  }

  const unsent = slugs.slice(result.enqueued);
  const reason = !result.available
    ? "The Graphify task queue is unavailable. Retry when the queue is connected."
    : result.error || "Some Graphify tasks could not be queued. Retry the failed pages.";
  const updated = await failGraphifyPages(owner, job.jobId, unsent, reason);
  return {
    job: updated,
    enqueued: result.enqueued,
    warning: reason,
    status: result.enqueued > 0 ? 202 : 503,
  };
}

export async function GET() {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  try {
    const [slugs, latest] = await Promise.all([
      listGraphifiableWikiPages(principal.handle),
      getLatestGraphifyJob(principal.handle),
    ]);
    return NextResponse.json({
      eligibleCount: slugs.length,
      job: latest ? effectiveGraphifyJob(latest) : null,
    });
  } catch (error) {
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  const principal = await getPrincipal();
  if (!principal) {
    return NextResponse.json({ error: "Sign in required." }, { status: 401 });
  }

  try {
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
    if (body.action === "retry") {
      if (typeof body.jobId !== "string") {
        return NextResponse.json({ error: "jobId is required for retry." }, { status: 400 });
      }
      const retry = await prepareGraphifyRetry(principal.handle, body.jobId);
      const queued = await queueGraphifyPages(
        principal.handle,
        retry.job,
        retry.slugs,
      );
      return NextResponse.json(
        { job: effectiveGraphifyJob(queued.job), enqueued: queued.enqueued, warning: queued.warning },
        { status: queued.status },
      );
    }

    if (body.action !== undefined && body.action !== "wiki") {
      return NextResponse.json(
        { error: "action must be wiki or retry." },
        { status: 400 },
      );
    }

    const latest = await getLatestGraphifyJob(principal.handle);
    const effectiveLatest = latest ? effectiveGraphifyJob(latest) : null;
    if (
      effectiveLatest &&
      (effectiveLatest.status === "queued" ||
        effectiveLatest.status === "processing" ||
        effectiveLatest.status === "stalled")
    ) {
      return NextResponse.json(
        {
          error: effectiveLatest.status === "stalled"
            ? "The previous Graphify job stalled. Retry it before starting another."
            : "A whole-wiki Graphify job is already running.",
          job: effectiveLatest,
        },
        { status: 409 },
      );
    }

    const slugs = await listGraphifiableWikiPages(principal.handle);
    const job = await createGraphifyJob(principal.handle, slugs);
    const queued = await queueGraphifyPages(principal.handle, job, slugs);
    return NextResponse.json(
      { job: effectiveGraphifyJob(queued.job), enqueued: queued.enqueued, warning: queued.warning },
      { status: queued.status },
    );
  } catch (error) {
    const message = getErrorMessage(error);
    return NextResponse.json({ error: message }, { status: statusForError(message) });
  }
}
