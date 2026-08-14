import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { enqueueTask, parseTask } from "@/lib/tasks";
import { reconcileFromTalk } from "@/lib/reconcile";
import { ingest, ingestUrl, ingestPdf, ingestImage, ingestDocument, reingest } from "@/lib/ingest";
import { extractDocumentTextAsync } from "@/lib/document-extract";
import { fixLintIssue } from "@/lib/lint-fix";
import { getIngestJob, updateIngestJob } from "@/lib/ingest-jobs";
import { readStagedBytes, readStagedText, deleteStaged } from "@/lib/ingest-staging";
import {
  agentIdFor,
  addAgentLearningPage,
  DEFAULT_AGENT_NAME,
  listAgentsForOwner,
} from "@/lib/agents";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { addToVault } from "@/lib/vault";
import {
  preserveDocumentSources,
  type DocumentSourceInput,
} from "@/lib/document-sources";
import { extractActionsFromPage } from "@/lib/action-extractor";
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
 * Handlers are idempotent/retry-safe: reconcile re-reconciles harmlessly, ingest
 * dedups.
 */
export async function POST(req: Request) {
  // Service-token only.
  const principal = getServicePrincipal(req);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
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

    if (task.kind === "reconcile") {
      // Attribute the edit to the requester's yoyo (the human who asked), else a
      // generic yoyo for autonomous/unknown triggers.
      const author = task.requestedBy
        ? agentIdFor(task.requestedBy, DEFAULT_AGENT_NAME)
        : undefined;
      const result = await reconcileFromTalk(task.slug, task.threadIndex, {
        author,
      });
      return NextResponse.json({ ok: true, ...result });
    }

    if (task.kind === "maintain") {
      // Autonomous maintenance (Q2). Attributed to a generic yoyo (no requester).
      if (task.op === "reconcile") {
        if (typeof task.threadIndex !== "number") {
          return NextResponse.json(
            { error: "maintain:reconcile requires threadIndex" },
            { status: 400 },
          );
        }
        const result = await reconcileFromTalk(task.slug, task.threadIndex);
        return NextResponse.json({ ok: true, ...result });
      }
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
    // triggeredBy defaults to author (the common case); agent ingests pass it
    // explicitly so author=agent while triggeredBy=human owner.
    const triggeredBy = task.triggeredBy ?? task.author;
    const opts = {
      ...(task.owner ? { owner: task.owner } : {}),
      ...(task.author ? { author: task.author } : {}),
      ...(triggeredBy ? { triggeredBy } : {}),
      // Agent ingests carry a scoped page type + (text) provenance url/type.
      ...(task.pageType ? { pageType: task.pageType } : {}),
      ...(task.sourceUrl ? { sourceUrl: task.sourceUrl } : {}),
      ...(task.sourceType ? { sourceType: task.sourceType } : {}),
      ...(task.tags && task.tags.length > 0 ? { tags: task.tags } : {}),
      // A user-supplied title must survive the queue hop — ingestPdf/ingestImage
      // use it to override the derived title (and, for images, the slug). The
      // text path passes title positionally below; for it `opts.title` is unused.
      ...(task.title && task.title.trim() ? { title: task.title.trim() } : {}),
    };
    // For a tracked async job, record progress so the UI can poll the outcome.
    if (task.jobId) {
      await updateIngestJob(task.jobId, { status: "processing", stage: "extracting" });
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
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingestPdf({ pdfUrl: task.url }, opts);
    } else if (task.source === "image" && task.url) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingestImage({ imageUrl: task.url }, opts);
    } else if (task.url) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingestUrl(task.url, opts);
    } else {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "synthesizing" });
      result = await ingest(task.title?.trim() || "Untitled", task.content ?? "", opts);
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
    const actionOwner = task.triggeredBy?.trim() || task.owner?.trim();
    if (actionOwner) {
      if (task.jobId) await updateIngestJob(task.jobId, { stage: "deriving-knowledge" });
      try {
        await enqueueTask({
          kind: "extract-actions",
          slug: result.primarySlug,
          owner: actionOwner,
        });
      } catch (err) {
        logger.warn(
          "tasks",
          `action extraction enqueue failed for slug="${result.primarySlug}": ${getErrorMessage(err)}`,
        );
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

    if (task.jobId) {
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
    const message = getErrorMessage(err);
    // Record the failure on a tracked async job so the user sees the reason
    // (a later retry that succeeds will overwrite this back to "done"). Guarded:
    // a storage error here must not mask the original failure or skip the
    // status mapping below.
    if (task.kind === "ingest" && task.jobId) {
      try {
        await updateIngestJob(task.jobId, { status: "failed", error: message });
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
      err instanceof ClientInputError ||
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
    // A missing page/thread is permanent → poison (4xx), don't retry forever.
    if (/not found/i.test(message)) {
      logger.warn("tasks", `task "${task.kind}" permanently failed: ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    if (err instanceof ClientInputError) {
      await Promise.all(stagedKeys.map((key) => deleteStaged(key)));
      logger.warn("tasks", `task "${task.kind}" rejected: ${message}`);
      return NextResponse.json({ error: message }, { status: 422 });
    }
    // Otherwise transient (LLM hiccup, lock contention) → retry.
    logger.error("tasks", `task "${task.kind}" failed`, err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
