import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { extractDocumentTextAsync, isSupportedDocument } from "@/lib/document-extract";
import { ingest } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import { stageBytes, stageText } from "@/lib/ingest-staging";
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
import { addAgentLearningPage, getAgent } from "@/lib/agents";
import {
  preserveDocumentSources,
  type DocumentSourceInput,
} from "@/lib/document-sources";
import { addToVault, getVault, vaultOwnedBy } from "@/lib/vault";

const MAX_INLINE_CONTENT_CHARS = 96_000;
const MAX_EMAIL_DOCUMENTS = 10;

interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  content: string;
  attachmentNames: string[];
  attachments: File[];
}

async function parsePayload(request: Request): Promise<EmailPayload> {
  const contentType = request.headers.get("content-type") || "";
  if (contentType.includes("multipart/form-data")) {
    const form = await request.formData();
    const value = (name: string) => {
      const entry = form.get(name);
      return typeof entry === "string" ? entry : "";
    };
    const attachments = form
      .getAll("attachments")
      .filter((entry): entry is File => entry instanceof File && entry.size > 0);
    return {
      from: normalizeEmailAddress(value("from")),
      to: normalizeEmailAddress(value("to")),
      subject: sanitizeEmailSubject(value("subject")),
      messageId: value("messageId").trim().slice(0, 998),
      content: value("content").trim(),
      attachmentNames: sanitizeAttachmentNames(
        form.getAll("attachmentName").filter((entry): entry is string => typeof entry === "string"),
      ),
      attachments,
    };
  }

  const body = (await request.json()) as Record<string, unknown>;
  return {
    from: typeof body.from === "string" ? normalizeEmailAddress(body.from) : "",
    to: typeof body.to === "string" ? normalizeEmailAddress(body.to) : "",
    subject: sanitizeEmailSubject(typeof body.subject === "string" ? body.subject : ""),
    messageId: typeof body.messageId === "string" ? body.messageId.trim().slice(0, 998) : "",
    content: typeof body.content === "string" ? body.content.trim() : "",
    attachmentNames: sanitizeAttachmentNames(
      Array.isArray(body.attachmentNames)
        ? body.attachmentNames.filter((value): value is string => typeof value === "string")
        : [],
    ),
    attachments: [],
  };
}

export async function POST(request: Request) {
  const principal = getServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const payload = await parsePayload(request);
    const { from, to, subject, messageId, content } = payload;
    const attachments = payload.attachments.filter((file) =>
      isSupportedDocument(file.name, file.type),
    );
    const attachmentNames = sanitizeAttachmentNames(Array.from(new Set([
      ...payload.attachmentNames,
      ...payload.attachments.map((file) => file.name),
    ])));

    if (!from || !to || !messageId) {
      return NextResponse.json(
        { error: "from, to, and messageId are required" },
        { status: 400 },
      );
    }
    if (!content && attachments.length === 0) {
      return NextResponse.json(
        { error: "The email has no text body or supported document attachment to ingest" },
        { status: 400 },
      );
    }
    if (content.length > MAX_EMAIL_CONTENT_CHARS) {
      return NextResponse.json(
        { error: `Email body exceeds ${MAX_EMAIL_CONTENT_CHARS.toLocaleString()} characters` },
        { status: 400 },
      );
    }
    if (attachments.length > MAX_EMAIL_DOCUMENTS) {
      return NextResponse.json(
        { error: `Attach no more than ${MAX_EMAIL_DOCUMENTS} supported documents` },
        { status: 400 },
      );
    }
    const oversized = attachments.find((file) => file.size > MAX_DOCUMENT_SIZE);
    if (oversized) {
      return NextResponse.json(
        { error: `${oversized.name} is larger than ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB` },
        { status: 400 },
      );
    }

    const config = await loadEmailIngestConfig();
    if (!config.enabled) {
      return NextResponse.json({ error: "Email ingestion is disabled" }, { status: 403 });
    }
    if (!senderIsAllowed(from, config.allowedSenders)) {
      return NextResponse.json({ error: "Sender is not approved" }, { status: 403 });
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

    const destinationAgent = config.destinationAgentId
      ? await getAgent(config.destinationAgentId).catch(() => null)
      : null;
    const validAgent =
      destinationAgent?.owner?.toLowerCase() === principal.handle.toLowerCase()
        ? destinationAgent
        : null;
    if (config.destinationAgentId && !validAgent) {
      logger.warn(
        "email-ingest",
        `configured destination agent "${config.destinationAgentId}" is unavailable or not owned by @${principal.handle}; routing to the owner workspace`,
      );
    }
    const configuredVault = config.destinationVaultId
      ? await getVault(config.destinationVaultId)
      : null;
    const validVaultId =
      configuredVault && vaultOwnedBy(config.destinationVaultId, principal.handle)
        ? config.destinationVaultId
        : "";
    if (config.destinationVaultId && !validVaultId) {
      logger.warn(
        "email-ingest",
        `configured destination vault "${config.destinationVaultId}" is unavailable or not owned by @${principal.handle}; skipping automatic filing`,
      );
    }

    const contentOwner = validAgent?.id || principal.handle;
    const contentAuthor = validAgent?.id || principal.handle;
    const learningFor = validAgent?.id;

    const jobId = await emailJobId(messageId);
    const existing = await getIngestJob(jobId);
    if (existing) {
      return NextResponse.json({
        accepted: true,
        duplicate: true,
        jobId,
        status: existing.status,
        supportedAttachmentCount: attachments.length,
        ...(existing.slug ? { slug: existing.slug } : {}),
      });
    }

    const attachmentBytes = await Promise.all(
      attachments.map(async (file) => ({
        file,
        bytes: await file.arrayBuffer(),
      })),
    );
    const stagedAttachments = await Promise.all(
      attachmentBytes.map(async ({ file, bytes }, index) => ({
        key: await stageBytes(jobId, `${index + 1}-${file.name}`, `attachment-${index + 1}`, bytes),
        filename: file.name,
        ...(file.type ? { contentType: file.type } : {}),
      })),
    );

    const email = { from, to, subject, messageId, attachmentNames };
    await createIngestJob({
      jobId,
      owner: principal.handle,
      title: subject,
      source: "email",
      email,
    });

    const task: Task = {
      kind: "ingest",
      title: subject,
      owner: contentOwner,
      author: contentAuthor,
      triggeredBy: principal.handle,
      sourceType: "email",
      jobId,
      email,
      ...(validAgent ? { pageType: "agent-knowledge", learningFor } : {}),
      ...(validVaultId ? { vaultId: validVaultId } : {}),
      ...(stagedAttachments.length ? { attachments: stagedAttachments } : {}),
    };
    if (content.length <= MAX_INLINE_CONTENT_CHARS) {
      if (content) task.content = content;
    } else {
      const key = await stageText(jobId, content);
      task.staged = { key, kind: "text" };
    }

    const response = await enqueueOrInline(jobId, task, async () => {
      let combined = content;
      const documentSources: DocumentSourceInput[] = [];
      for (const { file, bytes } of attachmentBytes) {
        const extracted = await extractDocumentTextAsync({
          bytes,
          filename: file.name,
          contentType: file.type,
        });
        combined += `${combined.trim() ? "\n\n" : ""}# Attachment: ${file.name}\n\n${extracted.text}`;
        documentSources.push({
          bytes,
          filename: file.name,
          contentType: file.type,
          extracted,
        });
      }
      const result = await ingest(subject, combined, {
        owner: contentOwner,
        author: contentAuthor,
        triggeredBy: principal.handle,
        sourceType: "email",
        ...(validAgent ? { pageType: "agent-knowledge" as const } : {}),
      });
      await preserveDocumentSources(result.primarySlug, contentOwner, documentSources);
      if (learningFor) await addAgentLearningPage(learningFor, result.primarySlug);
      if (validVaultId) await addToVault(validVaultId, result.primarySlug);
      return result;
    });
    const responseBody = (await response.json()) as Record<string, unknown>;
    return NextResponse.json({
      ...responseBody,
      accepted: true,
      supportedAttachmentCount: attachments.length,
      skippedAttachmentCount: Math.max(0, attachmentNames.length - attachments.length),
    }, { status: response.status });
  } catch (error) {
    logger.error("email-ingest", "email ingest request failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
