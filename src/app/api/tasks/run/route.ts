import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { enqueueTask, parseTask } from "@/lib/tasks";
import {
  ingest,
  ingestUrl,
  ingestPdf,
  ingestImage,
  ingestDocument,
  reingest,
  IngestCancelledError,
} from "@/lib/ingest";
import { rebuildVectorStore } from "@/lib/embeddings";
import { INGEST_CANCELLED_COPY, claimIngestJob } from "@/lib/ingest-jobs";
import { extractDocumentTextAsync } from "@/lib/document-extract";
import { fixLintIssue } from "@/lib/lint-fix";
import { getIngestJob, updateIngestJob } from "@/lib/ingest-jobs";
import { readStagedBytes, readStagedText, deleteStaged } from "@/lib/ingest-staging";
import {
  addAgentLearningPage,
  DEFAULT_AGENT_NAME,
  listAgentsForOwner,
} from "@/lib/agents";
import { hasIngestAnalysis } from "@/lib/ingest-analysis";
import { enqueueReviewAfterIngest, ReviewDeliveryUnretainedError } from "@/lib/review-queue";
import { getErrorMessage, isClientInputError, isStoreFault } from "@/lib/errors";
import { getVectorSearchSettings, isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { logger } from "@/lib/logger";
import { addToVault } from "@/lib/vault";
import {
  preserveDocumentSources,
  type DocumentSourceInput,
} from "@/lib/document-sources";
import { extractActionsFromPage } from "@/lib/action-extractor";
import { dispatchMeetingTodoExtract } from "@/lib/todo-dispatch";
import { setSourceMeeting } from "@/lib/source-meeting";
import { extractTodoCandidatesFromMeeting } from "@/lib/todo-extract";
import { recordTodoExtractError } from "@/lib/todos";
import { runSpecializedAgent } from "@/lib/agent-runtime";
import { runSourceMonitor } from "@/lib/source-monitors";
import { deliverMonitorDigest } from "@/lib/monitor-digests";
import { extractStructuredKnowledge } from "@/lib/structured-knowledge";
import {
  completeGraphifyPage,
  failGraphifyPages,
  startGraphifyPage,
} from "@/lib/graphify-jobs";
import { deliverOutboxEvent } from "@/lib/integration-outbox";
import { createOwnerBackup, summarizeBackup, verifyOwnerBackup } from "@/lib/backups";
import { recordOperationSafe } from "@/lib/operation-ledger";
import { compileKnowledgePage } from "@/lib/knowledge-compilation";
import { runResearchProject } from "@/lib/research-runtime";
import { getStorage } from "@/lib/storage";
import { fetchPdfBytes } from "@/lib/fetch";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { bytesSha256 } from "@/lib/source-sha256";
import {
  intakeRequiresExtract,
  intakeSourceSlug,
  type IntakeExtractFormat,
  type IntakeFormat,
} from "@/lib/workbench-intake";
import { detectDocumentFormat } from "@/lib/document-extract";

/**
 * What {@link divertToExtract} decided about one queued binary.
 *
 * THREE ANSWERS, NOT TWO. A boolean conflated the two "no" cases, and they call
 * for opposite handling: `"skipped"` is a CSV or an image the caller should go
 * on and ingest itself, while `"failed"` is a document that belongs to the
 * sidecar and did not get there. Collapsing them sent the failure down the
 * caller's fallback, which deletes the staging blob after it runs — so a
 * document with no extract record anywhere had its only remaining copy removed
 * on the way to a Worker parse this build no longer owns.
 */
type DivertOutcome = "diverted" | "skipped" | "failed";

/**
 * Hand a queued binary to the sidecar instead of parsing it on the Worker.
 *
 * `"skipped"` — leaving the caller's existing path untouched — for anything no
 * extract crate reads (CSV, ZIP, plain text, images, which keep the vision
 * path). `"diverted"` once the bytes are stored AND a record exists, including
 * the sidecar-down case: the row is visibly failed with the locked sentence and
 * re-offered when a poller returns, which is a better answer than a Worker
 * parse this build no longer has.
 *
 * `enqueueExtract` REPORTS ONE FAILURE WITHOUT THROWING: bytes stored, job
 * records not written. That is `"failed"`, and the caller turns it into a 5xx
 * so the queue redelivers — the bytes are content-addressed, so the retry lands
 * on the same key and costs nothing.
 */
async function divertToExtract(input: {
  owner: string;
  title: string;
  filename: string;
  contentType?: string;
  bytes: ArrayBuffer;
  ingestJobId?: string;
  vaultId?: string;
  tags?: string[];
}): Promise<DivertOutcome> {
  const format = detectDocumentFormat(input.filename, input.contentType);
  if (!format || !intakeRequiresExtract(format as IntakeFormat)) return "skipped";
  if (!input.owner) return "skipped";
  try {
    const queued = await enqueueExtract({
      owner: input.owner,
      slug: intakeSourceSlug(input.filename),
      bytesSha256: await bytesSha256(input.bytes),
      ext: format,
      format: format as IntakeExtractFormat,
      filename: input.filename,
      title: input.title,
      bytes: input.bytes,
      ...(input.ingestJobId ? { ingestJobId: input.ingestJobId } : {}),
      ...(input.vaultId ? { vaultId: input.vaultId } : {}),
      ...(input.tags?.length ? { tags: input.tags } : {}),
    });
    if (queued.error) {
      logger.error(
        "tasks",
        `stored "${input.filename}" but no extract record exists: ${queued.error}`,
      );
      return "failed";
    }
    return "diverted";
  } catch (error) {
    logger.error("tasks", `could not divert "${input.filename}" to extract`, error);
    return "failed";
  }
}

/**
 * POST /api/tasks/run — execute one agent task.
 *
 * The SOLE caller is the task-consumer worker (`workers/task-consumer/`), which
 * drains the Cloudflare Queue and POSTs each message here with the service
 * token. Gated to {@link getServicePrincipal} only — never a human/Clerk session.
 *
 * Status contract (drives the consumer's ack/retry, which maps to CF Queues):
 *   - 2xx → done, ack the message.
 *   - 4xx → permanently-bad/poison task → ack + drop (don't retry; → DLQ on the
 *           consumer side if it chooses). Malformed body, or a missing page/thread.
 *   - 5xx → transient failure → the consumer retries (CF redelivers; DLQ after
 *           max_retries).
 *
 * Handlers are idempotent/retry-safe: ingest dedups.
 */
export async function POST(req: Request) {
  // Service-token only.
  const principal = getServicePrincipal(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Deployment read-only (DW-187). Answered here, after the 401 and before the
  // body is parsed, because this door meets BOTH halves of the rule: the ingest
  // handler stages/creates job records and writes `raw/<slug>.md`, and the
  // source fetch plus two LLM calls (or a whole `fixLintIssue` rewrite) run
  // ahead of the page write. Without it the catch below marks the tracked job
  // `failed` and records a failed operation for a refusal the deployment could
  // have stated for free.
  //
  // THIS CHANGES QUEUE SEMANTICS, and the status contract above is why it has
  // to be said out loud: 4xx means the consumer ACKS AND DROPS the message,
  // where the un-gated 500 would have been retried and eventually parked in the
  // DLQ. On a read-only deployment retrying cannot succeed — the refusal is
  // deployment-wide, not transient to this message — so failing fast is the
  // honest answer, but it does mean work queued against a read-only deployment
  // is discarded rather than replayable. Drain or pause the queue before
  // setting `YOPEDIA_READONLY`.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.queuedWork },
      { status: 403 },
    );
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const task = parseTask(body);
  if (!task) {
    // Poison message — don't retry.
    return NextResponse.json({ error: "malformed task" }, { status: 400 });
  }

  const queueAttempt = Number.parseInt(
    req.headers.get("X-Yopedia-Queue-Attempt") ?? "1",
    10,
  );

  const stagedKeys = task.kind === "ingest"
    ? [task.staged?.key, ...(task.attachments?.map((attachment) => attachment.key) ?? [])]
        .filter((key): key is string => Boolean(key))
    : [];
  const operationOwner = task.kind === "ingest"
    ? task.triggeredBy?.trim() || task.owner?.trim() || task.author?.trim() || null
    : null;
  const operationStartedAt = Date.now();

  try {
    // A queue delivery can be retried after the first request has committed the
    // page and terminal job status but before the consumer receives its 2xx.
    // At that point staging has legitimately been deleted. Replaying extraction
    // would turn a completed ingest into repeated R2-not-found failures, so use
    // the tracked job as the idempotency record and return the original result.
    if (task.kind === "ingest" && task.jobId) {
      const existingJob = await getIngestJob(task.jobId);
      const taskJobOwner = (
        task.triggeredBy ?? task.author ?? task.owner ?? ""
      ).toLowerCase();
      if (
        existingJob?.status === "done" &&
        existingJob.slug &&
        taskJobOwner &&
        existingJob.owner.toLowerCase() === taskJobOwner
      ) {
        await Promise.all(stagedKeys.map((key) => deleteStaged(key)));
        if (operationOwner) {
          await recordOperationSafe(operationOwner, {
            kind: "ingest",
            operation: "ingest-replay",
            status: "succeeded",
            subjectId: existingJob.slug,
            actor: task.author,
            durationMs: Date.now() - operationStartedAt,
            detail: task.jobId,
          });
        }
        return NextResponse.json({
          ok: true,
          slug: existingJob.slug,
          replayed: true,
        });
      }
    }

    if (task.kind === "maintain") {
      // Autonomous maintenance (Q2). Attributed to a generic yoyo (no requester).
      if (task.op === "fix") {
        // Deterministic, no-LLM lint auto-fix (backfill defaults, drop dead refs).
        if (!task.lintType) {
          return NextResponse.json(
            { error: "maintain:fix requires lintType" },
            { status: 400 },
          );
        }
        const result = await fixLintIssue(task.lintType, task.slug, task.targetSlug);
        return NextResponse.json({ ok: true, ...result });
      }
      // op === "staleness": refresh an expired page from its source.
      const result = await reingest(task.slug, {
        author: DEFAULT_AGENT_NAME,
        triggeredBy: DEFAULT_AGENT_NAME,
      });
      return NextResponse.json({ ok: true, slug: result.primarySlug });
    }

    if (task.kind === "extract-actions") {
      const items = await extractActionsFromPage(task.owner, task.slug);
      return NextResponse.json({ ok: true, created: items.length });
    }

    if (task.kind === "extract-todo-candidates") {
      try {
        const items = await extractTodoCandidatesFromMeeting(
          task.owner,
          task.slug,
          task.sourcePath,
        );
        return NextResponse.json({ ok: true, created: items.length });
      } catch (error) {
        try {
          await recordTodoExtractError(task.owner, {
            message: getErrorMessage(error),
            slug: task.slug,
            ...(task.sourcePath ? { sourcePath: task.sourcePath } : {}),
          });
        } catch (writeErr) {
          logger.warn("tasks", "failed to record todo extract error", writeErr);
        }
        throw error;
      }
    }

    if (task.kind === "extract-knowledge") {
      if (task.graphifyJobId) {
        const started = await startGraphifyPage(
          task.owner,
          task.graphifyJobId,
          task.slug,
        );
        if (!started.shouldRun) {
          return NextResponse.json({ ok: true, replayed: true });
        }
      }
      const graph = await extractStructuredKnowledge(task.owner, task.slug);
      if (task.graphifyJobId) {
        await completeGraphifyPage(task.owner, task.graphifyJobId, task.slug);
      }
      await enqueueTask({
        kind: "compile-knowledge",
        slug: task.slug,
        owner: task.owner,
      });
      return NextResponse.json({ ok: true, records: graph.records.length, relations: graph.relations.length });
    }

    if (task.kind === "compile-knowledge") {
      const compilation = await compileKnowledgePage(task.owner, task.slug);
      return NextResponse.json({ ok: true, compilation });
    }

    if (task.kind === "run-agent") {
      const activity = await runSpecializedAgent({
        agentId: task.agentId,
        owner: task.owner,
        trigger: task.trigger,
        ...(task.sourceSlug ? { sourceSlug: task.sourceSlug } : {}),
        ...(task.prompt ? { prompt: task.prompt } : {}),
      });
      return NextResponse.json({ ok: true, activity });
    }

    if (task.kind === "run-research") {
      const project = await runResearchProject(task.owner, task.projectId);
      if (project.status === "collecting" || project.status === "ready") {
        return NextResponse.json(
          { ok: false, error: "Research run is still active; retry delivery." },
          { status: 409 },
        );
      }
      return NextResponse.json({ ok: true, project });
    }

    if (task.kind === "monitor-source") {
      const result = await runSourceMonitor(task.owner, task.monitorId);
      if (result.outcome === "failed") {
        throw new Error(result.error);
      }
      return NextResponse.json({ ok: true, ...result });
    }

    if (task.kind === "deliver-monitor-digest") {
      const digest = await deliverMonitorDigest(task.owner, task.digestId);
      return NextResponse.json({ ok: true, digest });
    }

    if (task.kind === "deliver-integration") {
      const event = await deliverOutboxEvent(task.owner, task.outboxId);
      if (event.status === "failed") throw new Error(event.lastError ?? "Integration delivery failed");
      return NextResponse.json({ ok: true, event });
    }

    if (task.kind === "create-backup") {
      const backup = await createOwnerBackup(task.owner);
      const verified = await verifyOwnerBackup(task.owner, backup.id);
      if (verified.verificationStatus !== "passed") {
        throw new Error(verified.verificationError ?? "Backup verification failed");
      }
      return NextResponse.json({ ok: true, backup: summarizeBackup(verified) });
    }

    // kind === "ingest"
    if (task.rebuildEmbeddings) {
      if (task.jobId) {
        const current = await getIngestJob(task.jobId);
        if (current?.cancelled) {
          if (current.status !== "failed") {
            await updateIngestJob(task.jobId, {
              status: "failed",
              error: current.error || INGEST_CANCELLED_COPY,
            });
          }
          return NextResponse.json({ ok: true, cancelled: true });
        }
      }
      if (!getVectorSearchSettings().enabled) {
        if (task.jobId) {
          await updateIngestJob(task.jobId, {
            status: "failed",
            error: "Vector search is off.",
          });
        }
        return NextResponse.json({ error: "Vector search is off." }, { status: 422 });
      }
      if (task.jobId) {
        await updateIngestJob(task.jobId, { status: "processing", stage: "indexing" });
      }
      await rebuildVectorStore(async (done, total) => {
        if (task.jobId) {
          await updateIngestJob(task.jobId, {
            progressDone: done,
            progressTotal: total,
            stage: "indexing",
          });
        }
      });
      if (task.jobId) {
        await updateIngestJob(task.jobId, { status: "done", stage: "complete" });
      }
      return NextResponse.json({ ok: true, rebuilt: true });
    }

    if (task.jobId) {
      const current = await getIngestJob(task.jobId);
      if (current?.cancelled || current?.sourceDeleted) {
        if (current.status === "queued" || current.status === "retrying") {
          await updateIngestJob(task.jobId, {
            status: "failed",
            error: current.error || INGEST_CANCELLED_COPY,
          });
        }
        return NextResponse.json({ ok: true, cancelled: true });
      }
      if (current && (current.status === "queued" || current.status === "retrying")) {
        const claimed = await claimIngestJob(
          task.jobId,
          current.owner,
        );
        if (!claimed) {
          return NextResponse.json({ ok: true, skipped: true });
        }
      } else if (
        current?.status === "processing" ||
        current?.status === "failed" ||
        current?.status === "skipped"
      ) {
        return NextResponse.json({ ok: true, skipped: true });
      }
    }

    // triggeredBy defaults to author (the common case); agent ingests pass it
    // explicitly so author=agent while triggeredBy=human owner.
    const triggeredBy = task.triggeredBy ?? task.author;
    let storedAnalysis = false;
    if (task.jobId) {
      try {
        storedAnalysis = await hasIngestAnalysis(task.jobId);
      } catch (err) {
        logger.warn("tasks", `analysis reuse check failed for job ${task.jobId}`, err);
      }
    }
    const opts = {
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.author ? { author: task.author } : {}),
      ...(triggeredBy ? { triggeredBy } : {}),
      // Agent ingests carry a scoped page type + (text) provenance url/type.
      ...(task.pageType ? { pageType: task.pageType } : {}),
      ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
      ...(task.sourceType ? { sourceType: task.sourceType } : {}),
      ...((task.relativePath ?? task.staged?.relativePath)
        ? { relativePath: task.relativePath ?? task.staged?.relativePath }
        : {}),
      ...(task.tags && task.tags.length > 0 ? { tags: task.tags } : {}),
      // A user-supplied title must survive the queue hop — ingestPdf/ingestImage
      // use it to override the derived title (and, for images, the slug). The
      // text path passes title positionally below; for it `opts.title` is unused.
      ...(task.title && task.title.trim() ? { title: task.title.trim() } : {}),
      ...(task.origin ? { origin: task.origin } : {}),
      ...(task.jobId ? { jobId: task.jobId } : {}),
      ...((task.reuseAnalysis || storedAnalysis)
        ? { reuseAnalysis: true }
        : {}),
      ...(task.contentSha256 ? { contentSha256: task.contentSha256 } : {}),
      ...(task.sourcePath ? { sourcePath: task.sourcePath } : {}),
    };
    // For a tracked async job, record progress so the UI can poll the outcome.
    if (task.jobId) {
      await updateIngestJob(task.jobId, { status: "processing", stage: "extracting" });
    }

    // LEGACY TASKS ONLY (Story 7.5). Every door now parks extract-crate
    // binaries on the sidecar before anything is enqueued, so a staged PDF or
    // office file reaching the consumer means a task was written by an older
    // build and is still in the queue. Diverting it here — rather than calling
    // the parsers the Worker no longer owns — is what makes the cutover safe to
    // deploy without draining the queue first.
    if (task.staged && (task.staged.kind === "pdf" || task.staged.kind === "document")) {
      const { key, filename, contentType } = task.staged;
      const diverted = await divertToExtract({
        owner: task.owner ?? triggeredBy ?? task.author ?? "",
        title: task.title?.trim() || filename || "Document",
        filename: filename || (task.staged.kind === "pdf" ? "document.pdf" : "document"),
        contentType,
        bytes: await readStagedBytes(key),
        ...(task.jobId ? { ingestJobId: task.jobId } : {}),
        ...(task.vaultId ? { vaultId: task.vaultId } : {}),
        ...(task.tags?.length ? { tags: task.tags } : {}),
      });
      if (diverted === "diverted") {
        await deleteStaged(key).catch(() => {});
        return NextResponse.json({ ok: true, extract: true });
      }
      if (diverted === "failed") {
        // 5xx, so the consumer redelivers rather than acking a document that
        // now exists only as a staging blob. Falling through would ingest it on
        // the Worker and then delete that blob — the one copy left.
        return NextResponse.json(
          { error: "could not queue the document for extract" },
          { status: 503 },
        );
      }
    }

    // Route to the right ingest path:
    //  - staged: uploaded bytes/text in R2 (delete the blob after, best-effort);
    //  - source pdf/image with a url: the URL PDF/image path (not generic);
    //  - url: generic URL; content: pasted text.
    let result;
    const documentSources: DocumentSourceInput[] = [];
    if (task.sourceType === "email" && task.attachments?.length) {
      let combined = task.content ?? "";
      if (task.staged) combined = await readStagedText(task.staged.key);
      for (const attachment of task.attachments) {
        const bytes = await readStagedBytes(attachment.key);
        // A task enqueued by an older build can still carry a PDF here. The
        // Worker no longer owns those parsers, so hand it to the sidecar as its
        // own Source rather than gluing an empty extract onto the message.
        const diverted = await divertToExtract({
          owner: task.owner ?? triggeredBy ?? task.author ?? "",
          title: `${task.title?.trim() || "Emailed document"} — ${attachment.filename}`,
          filename: attachment.filename,
          contentType: attachment.contentType,
          bytes,
          ...(task.vaultId ? { vaultId: task.vaultId } : {}),
        });
        if (diverted === "diverted") continue;
        if (diverted === "failed") {
          // Same reasoning as the staged branch: retry the message rather than
          // glue an unparsed attachment onto the compiled mail.
          return NextResponse.json(
            { error: "could not queue the attachment for extract" },
            { status: 503 },
          );
        }
        const extracted = await extractDocumentTextAsync({
          bytes,
          filename: attachment.filename,
          contentType: attachment.contentType,
        });
        combined += `${combined.trim() ? "\n\n" : ""}# Attachment: ${attachment.filename}\n\n${extracted.text}`;
        documentSources.push({
          bytes,
          filename: attachment.filename,
          contentType: attachment.contentType,
          extracted,
        });
      }
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingest(task.title?.trim() || "Emailed document", combined, opts);
    } else if (task.staged) {
      const { key, kind, filename, contentType } = task.staged;
      if (kind === "pdf") {
        const bytes = await readStagedBytes(key);
        if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
        result = await ingestPdf(
          { bytes, filename: filename || "document.pdf" },
          opts,
        );
      } else if (kind === "image") {
        const bytes = await readStagedBytes(key);
        if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
        result = await ingestImage(
          { bytes, filename: filename || "image", contentType },
          opts,
        );
      } else if (kind === "document") {
        const bytes = await readStagedBytes(key);
        if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
        result = await ingestDocument(
          {
            bytes,
            filename: filename || "document",
            contentType,
            ...(task.staged.relativePath
              ? { relativePath: task.staged.relativePath }
              : {}),
          },
          opts,
        );
      } else {
        // kind === "text"
        const text = await readStagedText(key);
        if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
        result = await ingest(task.title?.trim() || "Untitled", text, opts);
      }
    } else if (task.source === "pdf" && task.url) {
      // Leftover `source:pdf` tasks from before the vault door fetched-then-
      // extracted. Fetch the bytes here and park them on the sidecar — do not
      // call ingestPdf / unpdf on the Worker.
      const fetched = await fetchPdfBytes(task.url);
      const diverted = await divertToExtract({
        owner: task.owner ?? triggeredBy ?? task.author ?? "",
        title: task.title?.trim() || fetched.title,
        filename: fetched.filename,
        contentType: "application/pdf",
        bytes: fetched.bytes,
        ...(task.jobId ? { ingestJobId: task.jobId } : {}),
        ...(task.vaultId ? { vaultId: task.vaultId } : {}),
        ...(task.tags?.length ? { tags: task.tags } : {}),
      });
      if (diverted === "diverted") {
        return NextResponse.json({ ok: true, extract: true });
      }
      return NextResponse.json(
        { error: "could not queue the document for extract" },
        { status: 503 },
      );
    } else if (task.source === "image" && task.url) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingestImage({ imageUrl: task.url }, opts);
    } else if (task.url) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingestUrl(task.url, opts);
    } else if (task.sourcePath && !task.content) {
      const stored = await getStorage().readFile(task.sourcePath);
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingest(task.title?.trim() || "Untitled", stored, opts);
    } else {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingest(task.title?.trim() || "Untitled", task.content ?? "", opts);
    }

    if (result.skipped) {
      const retryOwner = task.triggeredBy?.trim() || task.owner?.trim() || task.author?.trim();
      if (retryOwner && result.primarySlug && task.jobId) {
        let shouldRetry = false;
        try {
          shouldRetry = await hasIngestAnalysis(task.jobId);
        } catch (err) {
          shouldRetry = true;
          logger.warn("tasks", `analysis check failed after skipped job ${task.jobId}`, err);
        }
        if (shouldRetry) {
          try {
            await enqueueReviewAfterIngest({
              owner: retryOwner,
              pageSlug: result.primarySlug,
              jobId: task.jobId,
            });
          } catch (err) {
            logger.warn("tasks", `review-queue retry after skip failed for slug="${result.primarySlug}"`, err);
            if (err instanceof ReviewDeliveryUnretainedError && task.jobId) {
              await updateIngestJob(task.jobId, {
                status: "failed",
                error: getErrorMessage(err),
                slug: result.primarySlug,
              });
              await Promise.all(stagedKeys.map((key) => deleteStaged(key)));
              return NextResponse.json({
                ok: true,
                skipped: true,
                slug: result.primarySlug,
                error: getErrorMessage(err),
              });
            }
          }
        }
      }
      if (task.jobId) {
        await updateIngestJob(task.jobId, {
          status: "skipped",
          stage: "complete",
          slug: result.primarySlug,
        });
      }
      await Promise.all(stagedKeys.map((key) => deleteStaged(key)));
      return NextResponse.json({
        ok: true,
        skipped: true,
        slug: result.primarySlug,
      });
    }

    if (documentSources.length > 0) {
      await preserveDocumentSources(
        result.primarySlug,
        task.owner?.trim() || task.author?.trim() || "system",
        documentSources,
      );
    }

    if (task.jobId) await updateIngestJob(task.jobId, { stage: "indexing", slug: result.primarySlug });

    // Agent-scoped ingest: attach the page to the agent's learnings. Fail-soft —
    // the job is already `done` and the page exists; we won't fail the ingest over
    // this. But a THROW here means the page is orphaned from the agent (it won't
    // surface under the profile / `agent:` scope), so log it at error (matching
    // addAgentLearningPage's own severity for the missing-agent case).
    if (task.learningFor) {
      try {
        await addAgentLearningPage(task.learningFor, result.primarySlug);
      } catch (err) {
        logger.error(
          "tasks",
          `learning-page attach failed for agent="${task.learningFor}" slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
      }
    }

    // Auto-file into vault if requested (fail-soft: never fail the ingest).
    if (task.vaultId) {
      try {
        await addToVault(task.vaultId, result.primarySlug);
      } catch (err) {
        logger.warn("tasks", `vault filing failed for vault="${task.vaultId}" slug="${result.primarySlug}": ${(err as Error).message}`);
      }
    }

    // Proposals belong to the accountable HUMAN. Agent-routed email ingests set
    // owner=agent-id and triggeredBy=human; prefer the latter so the private
    // inbox and after-ingest agents stay in the human tenant silo.
    const actionOwner = task.triggeredBy?.trim() || task.owner?.trim() || task.author?.trim();
    let reviewDeliveryUnretained = false;
    if (actionOwner) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "deriving-knowledge" });
      try {
        if (task.origin !== "plaud") {
          await enqueueTask({
            kind: "extract-actions",
            slug: result.primarySlug,
            owner: actionOwner,
          });
        }
      } catch (err) {
        logger.warn(
          "tasks",
          `action extraction enqueue failed for slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
      }
      try {
        if (task.origin === "plaud" && task.sourcePath) {
          await setSourceMeeting(actionOwner, task.sourcePath, true).catch((err) => {
            logger.warn(
              "tasks",
              `plaud meeting flag failed for "${task.sourcePath}": ${getErrorMessage(err)}`,
            );
          });
        }
        await dispatchMeetingTodoExtract(
          actionOwner,
          {
            origin: task.origin,
            sourcePath: task.sourcePath,
            slug: result.primarySlug,
          },
          { failSoft: true },
        );
      } catch (err) {
        logger.warn(
          "tasks",
          `todo-candidate extract dispatch failed for slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
      }
      try {
        await enqueueReviewAfterIngest({
          owner: actionOwner,
          pageSlug: result.primarySlug,
          jobId: task.jobId,
        });
      } catch (err) {
        logger.warn(
          "tasks",
          `review-queue enqueue failed for slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
        if (err instanceof ReviewDeliveryUnretainedError) {
          reviewDeliveryUnretained = true;
          if (task.jobId) {
            await updateIngestJob(task.jobId, {
              status: "failed",
              error: getErrorMessage(err),
              slug: result.primarySlug,
            });
          }
        }
      }
      try {
        await enqueueTask({
          kind: "extract-knowledge",
          slug: result.primarySlug,
          owner: actionOwner,
        });
      } catch (err) {
        logger.warn(
          "tasks",
          `structured knowledge enqueue failed for slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
      }
      try {
        const agents = await listAgentsForOwner(actionOwner);
        for (const agent of agents) {
          if (!agent.enabled || agent.trigger !== "after-ingest") continue;
          await enqueueTask({
            kind: "run-agent",
            agentId: agent.id,
            owner: actionOwner,
            trigger: "after-ingest",
            sourceSlug: result.primarySlug,
          });
        }
      } catch (err) {
        logger.warn(
          "tasks",
          `after-ingest agent enqueue failed for owner="${actionOwner}": ${getErrorMessage(err)}`,
        );
      }
    }

    if (task.jobId && !reviewDeliveryUnretained) {
      await updateIngestJob(task.jobId, {
        status: "done",
        stage: "complete",
        slug: result.primarySlug,
      });
    }

    // R2 has no TTL. Delete only after the ingest and tracked-job update both
    // succeed so a transient failure can be retried against the same source.
    await Promise.all(stagedKeys.map((key) => deleteStaged(key)));

    if (task.kind === "ingest" && operationOwner) {
      await recordOperationSafe(operationOwner, {
        kind: "ingest",
        operation: task.sourceType === "email" ? "ingest-email" : "ingest",
        status: "succeeded",
        subjectId: result.primarySlug,
        actor: task.author,
        durationMs: Date.now() - operationStartedAt,
        detail: task.jobId,
      });
    }

    return NextResponse.json({ ok: true, slug: result.primarySlug });
  } catch (err) {
    // Mid-request flag flip: the gate above already answered for a deployment
    // that was read-only on arrival. Answered BEFORE the job-failure recording
    // below, so a refusal never writes `status: "failed"` onto the caller's
    // tracked job — the work was not attempted, it was declined.
    if (isReadOnlyError(err)) {
      return NextResponse.json({ error: getErrorMessage(err) }, { status: 403 });
    }
    if (err instanceof IngestCancelledError) {
      if (task.kind === "ingest" && task.jobId) {
        await updateIngestJob(task.jobId, {
          status: "failed",
          error: INGEST_CANCELLED_COPY,
        }).catch((writeErr) =>
          logger.error("tasks", `failed to record cancel for ${task.jobId}`, writeErr),
        );
      }
      return NextResponse.json({ ok: true, cancelled: true });
    }
    const message = getErrorMessage(err);
    // One predicate, read twice: the ingest auto-retry cap. It decides both
    // how the tracked job is recorded here and the 422 at the bottom, and it
    // is hoisted so the store-fault row in between can step around ingest
    // without a third copy drifting from these two.
    const ingestRetriesExhausted =
      task.kind === "ingest" && Number.isFinite(queueAttempt) && queueAttempt >= 3;
    // Record the failure on a tracked async job so the user sees the reason
    // (a later retry that succeeds will overwrite this back to "done"). Guarded:
    // a storage error here must not mask the original failure or skip the
    // status mapping below.
    if (task.kind === "ingest" && task.jobId) {
      try {
        await updateIngestJob(task.jobId, {
          status: ingestRetriesExhausted ? "failed" : "retrying",
          error: message,
        });
      } catch (writeErr) {
        logger.error(
          "tasks",
          `failed to record ingest job ${task.jobId} failure`,
          writeErr,
        );
      }
    }
    const graphifyFailureIsTerminal =
      /not found/i.test(message) ||
      isClientInputError(err) ||
      (Number.isFinite(queueAttempt) && queueAttempt >= 4);
    if (
      task.kind === "extract-knowledge" &&
      task.graphifyJobId &&
      graphifyFailureIsTerminal
    ) {
      try {
        await failGraphifyPages(
          task.owner,
          task.graphifyJobId,
          [task.slug],
          message,
        );
      } catch (writeErr) {
        logger.error(
          "tasks",
          `failed to record Graphify job ${task.graphifyJobId} failure`,
          writeErr,
        );
      }
    }
    if (task.kind === "ingest" && operationOwner) {
      await recordOperationSafe(operationOwner, {
        kind: "ingest",
        operation: task.sourceType === "email" ? "ingest-email" : "ingest",
        status: "failed",
        subjectId: task.jobId,
        actor: task.author,
        durationMs: Date.now() - operationStartedAt,
        detail: message,
      });
    }
    // A store fault is OURS and repairable in place, so it gets the transient
    // 500 and the queue's bounded retry to the DLQ — never the 422 poison.
    // Ahead of `/not found/i` on purpose (DW-482): the corrupt-registry
    // refusals in `research-projects.ts` reached this 500 only by falling all
    // the way through, and a store fault whose sentence happens to say "not
    // found" would have been poisoned as a missing page instead. Ingest at its
    // auto-retry cap is excluded so the 422 below still wins for it — this row
    // pins `run-research`, it does not re-decide ingest.
    if (isStoreFault(err) && !ingestRetriesExhausted) {
      logger.error("tasks", `task "${task.kind}" hit a store fault`, err);
      return NextResponse.json({ error: message }, { status: 500 });
    }
    // A missing page/thread is permanent → poison (4xx), don't retry forever.
    if (/not found/i.test(message)) {
      logger.warn("tasks", `task "${task.kind}" permanently failed: ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    if (isClientInputError(err)) {
      await Promise.all(stagedKeys.map((key) => deleteStaged(key)));
      logger.warn("tasks", `task "${task.kind}" rejected: ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    // Otherwise transient (LLM hiccup, lock contention) → retry.
    // Ingest auto-retries at most 3 times, then stays failed for manual retry.
    if (ingestRetriesExhausted) {
      logger.warn("tasks", `ingest exhausted auto-retry (${queueAttempt}): ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    logger.error("tasks", `task "${task.kind}" failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
