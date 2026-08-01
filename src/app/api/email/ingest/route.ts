import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { ingest } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import { stageText } from "@/lib/ingest-staging";
import type { Task } from "@/lib/tasks";
import {
  MAX_EMAIL_CONTENT_CHARS,
  emailJobId,
  loadEmailIngestConfig,
  normalizeEmailAddress,
  sanitizeAttachmentNames,
  sanitizeEmailSubject,
  senderIsAllowed,
} from "@/lib/email-ingest";
import { getErrorMessage } from "@/lib/errors";
import { logger } from "@/lib/logger";

const MAX_INLINE_CONTENT_CHARS = 96_000;

export async function POST(request: Request) {
  const principal = getServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = (await request.json()) as Record<string, unknown>;
    const from =
      typeof body.from === "string" ? normalizeEmailAddress(body.from) : "";
    const to = typeof body.to === "string" ? normalizeEmailAddress(body.to) : "";
    const messageId =
      typeof body.messageId === "string" ? body.messageId.trim().slice(0, 998) : "";
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const subject = sanitizeEmailSubject(
      typeof body.subject === "string" ? body.subject : "",
    );
    const attachmentNames = sanitizeAttachmentNames(
      Array.isArray(body.attachmentNames)
        ? body.attachmentNames.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
    );

    if (!from || !to || !messageId) {
      return NextResponse.json(
        { error: "from, to, and messageId are required" },
        { status: 400 },
      );
    }
    if (!content) {
      return NextResponse.json(
        { error: "The email has no text body to ingest" },
        { status: 400 },
      );
    }
    if (content.length > MAX_EMAIL_CONTENT_CHARS) {
      return NextResponse.json(
        { error: `Email body exceeds ${MAX_EMAIL_CONTENT_CHARS.toLocaleString()} characters` },
        { status: 400 },
      );
    }

    const config = await loadEmailIngestConfig();
    if (!config.enabled) {
      return NextResponse.json(
        { error: "Email ingestion is disabled" },
        { status: 403 },
      );
    }
    if (!senderIsAllowed(from, config.allowedSenders)) {
      return NextResponse.json(
        { error: "Sender is not approved" },
        { status: 403 },
      );
    }
    if (
      config.inboundAddress &&
      normalizeEmailAddress(to) !== normalizeEmailAddress(config.inboundAddress)
    ) {
      return NextResponse.json(
        { error: "Recipient does not match the configured ingest address" },
        { status: 403 },
      );
    }

    const jobId = await emailJobId(messageId);
    const existing = await getIngestJob(jobId);
    if (existing) {
      return NextResponse.json({
        accepted: true,
        duplicate: true,
        jobId,
        status: existing.status,
        ...(existing.slug ? { slug: existing.slug } : {}),
      });
    }

    const email = { from, to, subject, messageId, attachmentNames };
    await createIngestJob({
      jobId,
      owner: principal.handle,
      title: subject,
      source: "email",
      email,
    });

    let task: Task;
    if (content.length <= MAX_INLINE_CONTENT_CHARS) {
      task = {
        kind: "ingest",
        title: subject,
        content,
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        sourceType: "email",
        jobId,
        email,
      };
    } else {
      const key = await stageText(jobId, content);
      task = {
        kind: "ingest",
        title: subject,
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        sourceType: "email",
        jobId,
        email,
        staged: { key, kind: "text" },
      };
    }

    return await enqueueOrInline(jobId, task, async () =>
      ingest(subject, content, {
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        sourceType: "email",
      }),
    );
  } catch (error) {
    logger.error("email-ingest", "email ingest request failed", error);
    return NextResponse.json(
      { error: getErrorMessage(error) },
      { status: 500 },
    );
  }
}
