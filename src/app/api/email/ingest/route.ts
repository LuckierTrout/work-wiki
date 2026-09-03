import { NextResponse } from "next/server";
import { getServicePrincipal } from "@/lib/auth";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import {
  detectDocumentFormat,
  extractDocumentTextAsync,
  isSupportedDocument,
} from "@/lib/document-extract";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { bytesSha256 } from "@/lib/source-sha256";
import {
  intakeRequiresExtract,
  intakeSourceSlug,
  type IntakeExtractFormat,
  type IntakeFormat,
} from "@/lib/workbench-intake";
import { ingest } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob, getIngestJob, updateIngestJob } from "@/lib/ingest-jobs";
import { stageBytes, stageText } from "@/lib/ingest-staging";
import type { Task } from "@/lib/tasks";
import {
  MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENTS,
  type EmailIngestMetadata,
  emailJobId,
  loadEmailIngestConfig,
  normalizeEmailAddress,
  sanitizeAttachmentNames,
  sanitizeAttachmentNamesUnique,
  sanitizeEmailSubject,
  senderIsAllowed,
} from "@/lib/email-ingest";
import { getErrorMessage } from "@/lib/errors";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { logger } from "@/lib/logger";
import { addAgentLearningPage, getAgent } from "@/lib/agents";
import {
  preserveDocumentSources,
  type DocumentSourceInput,
} from "@/lib/document-sources";
import { addToVault, getVault, vaultOwnedBy } from "@/lib/vault";

const MAX_INLINE_CONTENT_CHARS = 96_000;

interface EmailPayload {
  from: string;
  to: string;
  subject: string;
  messageId: string;
  content: string;
  attachmentNames: string[];
  attachments: File[];
  /**
   * What the inbound Worker never forwarded — unsupported parts, supported ones
   * over its own per-document byte ceiling, and supported ones it dropped at its
   * own per-email cap or aggregate byte budget. Both payload branches read it, so
   * it is absent only when a caller omits the field or sends an unusable value
   * (non-numeric, non-finite, or negative); the route then falls back to
   * deriving a minimum from the recorded names.
   */
  skippedAttachmentCount?: number;
}

/**
 * Missing, non-numeric, non-finite and negative values are all "absent", not
 * zero: an unparseable field must fall back to the local subtraction rather than
 * silently reporting that nothing was skipped. One guard for both payload
 * branches, so the JSON number and the multipart string cannot diverge.
 */
function parseSkippedCount(value: unknown): number | undefined {
  const raw =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : undefined;
}

/**
 * Give a lost attachment a failed Activity row of its own.
 *
 * BEST-EFFORT BY CONSTRUCTION. This runs on the path where writing an extract
 * record has already failed once, so the same store may well refuse again — and
 * a throw here would turn one lost attachment into a 500 that makes the inbound
 * Worker redeliver the whole message. A logged warning is the floor; the row is
 * the improvement.
 *
 * `kind: "extract"` so Activity's Retry re-offers the extract rather than
 * decoding the stored bytes as UTF-8 text.
 */
async function recordFailedAttachment(input: {
  owner: string;
  title: string;
  sourceRel?: string;
  error: string;
  email: EmailIngestMetadata;
}): Promise<void> {
  try {
    const jobId = crypto.randomUUID();
    await createIngestJob({
      jobId,
      owner: input.owner,
      title: input.title,
      source: "email",
      email: input.email,
      kind: "extract",
      ...(input.sourceRel ? { sourceRel: input.sourceRel } : {}),
    });
    await updateIngestJob(jobId, {
      status: "failed",
      stage: "extracting",
      error: input.error,
    });
  } catch (error) {
    logger.warn(
      "email-ingest",
      `could not record a failed row for "${input.title}"`,
      error,
    );
  }
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
      skippedAttachmentCount: parseSkippedCount(form.get("skippedAttachmentCount")),
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
    skippedAttachmentCount: parseSkippedCount(body.skippedAttachmentCount),
  };
}

export async function POST(request: Request) {
  const principal = getServicePrincipal(request);
  if (!principal) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Deployment read-only (DW-187). Answered here, after the 401 and before the
  // payload is parsed, because this door meets BOTH halves of the rule:
  //   - IRREVERSIBLE WORK ALREADY COMMITTED: an ingest-job record is created and
  //     every supported attachment is staged to R2 before `ingest()` is reached,
  //     so a kernel-only refusal strands both on every inbound message.
  //   - EXPENSIVE, FAILABLE WORK FIRST: document extraction and two LLM calls
  //     run ahead of the page write.
  if (isReadOnly()) {
    return NextResponse.json(
      { error: READ_ONLY_REFUSAL.ingest },
      { status: 403 },
    );
  }

  try {
    const payload = await parsePayload(request);
    const { from, to, subject, messageId, content } = payload;
    // Oversize is a per-FILE loss, not a per-message one (DW-253). One
    // attachment above the ceiling used to 400 the whole email, taking the body
    // and every other attachment with it; now the offending file is dropped
    // here, folded into `skippedAttachmentCount` below, and named back to the
    // caller. The partition runs at the same place the allowlist filter does, so
    // an oversized file never consumes a `MAX_EMAIL_DOCUMENTS` slot either.
    const supportedFiles = payload.attachments.filter((file) =>
      isSupportedDocument(file.name, file.type),
    );
    // ONE predicate, one pass. Deliberately NOT two complementary filters
    // (`> MAX_DOCUMENT_SIZE` and `<= MAX_DOCUMENT_SIZE`): those are two
    // independently editable boundaries, and shifting only one puts a file of
    // exactly `MAX_DOCUMENT_SIZE` into BOTH lists -- staged AND reported as
    // dropped -- while shifting both silently refuses a document that fits. A
    // partition cannot drift against itself.
    const oversizedFiles: File[] = [];
    const attachments: File[] = [];
    for (const file of supportedFiles) {
      (file.size > MAX_DOCUMENT_SIZE ? oversizedFiles : attachments).push(file);
    }
    // The `|| "unnamed attachment"` is load-bearing, not decoration:
    // `sanitizeAttachmentNames` drops a name that scrubs away to nothing, so a
    // part named `"\r\n"` or `"   "` would shrink this list while an oversized
    // file really was dropped -- breaking the contract that the field's presence
    // alone means "a file was dropped for being too big", and leaving the
    // refusal below with a count and no noun to attach it to.
    const oversizedAttachmentNames = sanitizeAttachmentNames(
      oversizedFiles.map((file) => file.name.trim() || "unnamed attachment"),
    );
    // Loud server-side, not only sender-side. Oversize used to produce a 400 the
    // operator could find in the access log; now the bytes are dropped and the
    // message may well succeed, so without this line an attachment vanishes with
    // nothing anywhere to say it existed. Logged before any of the guards below,
    // so the record survives whichever exit this request takes.
    if (oversizedFiles.length) {
      logger.warn(
        "email-ingest",
        `dropped ${oversizedFiles.length} attachment${
          oversizedFiles.length === 1 ? "" : "s"
        } larger than ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB: ${oversizedAttachmentNames.join(", ")}`,
      );
    }
    // Files this route itself refused for format -- the route's analogue of the
    // Worker's `unsupportedCount`, and what decides whether the refusal below
    // may still claim nothing supported arrived.
    const unsupportedFileCount = payload.attachments.length - supportedFiles.length;
    // What the message is recorded as having carried: the names the caller told
    // us about UNIONED with the names of the files that actually arrived. The
    // caller's half is already scrubbed at parse time; the file names are raw,
    // which is why the union is de-duplicated by
    // `sanitizeAttachmentNamesUnique` rather than by a bare `new Set` over the
    // inputs (DW-690). A `Set` over RAW strings compares what nobody records:
    // `report.pdf` and `report.pdf\r\n` are two distinct raw strings and one
    // recorded name, so both used to survive and the list reported a file that
    // was never sent twice. Scrubbing first collapses them; capping after the
    // collapse keeps all twenty recorded slots for distinct names.
    const attachmentNames = sanitizeAttachmentNamesUnique([
      ...payload.attachmentNames,
      ...payload.attachments.map((file) => file.name),
    ]);

    if (!from || !to || !messageId) {
      return NextResponse.json(
        { error: "from, to, and messageId are required" },
        { status: 400 },
      );
    }
    if (!content && attachments.length === 0) {
      // Only here does an oversized file still cost the sender the message:
      // dropping it left nothing at all to ingest. Two sentences, JOINED rather
      // than swapped -- an email carrying one 11 MB PDF and one `.exe` has to
      // learn about both refusals, and which formats are supported. The lead
      // sentence drops its "or supported document attachment" clause only when
      // oversize is the sole reason nothing survived, because in that case a
      // supported document really did arrive; it was too big, not unsupported.
      //
      // Count and VERB come from `oversizedFiles`, the true total, never from
      // the name list: `sanitizeAttachmentNames` hard-truncates at 20, so a
      // caller posting 21 oversized files would otherwise be told about 20 of
      // them and never learn the rest were dropped. The names keep the 20 cap
      // -- one reply line must not grow without bound, and the Worker's
      // `safeError` guillotines a relayed error at 300 characters -- and the
      // remainder is reported as a counted tail, the shape `replyLossNames`
      // uses on the Worker side.
      //
      // The `|| "unnamed attachment"` fallback above guarantees a name per file
      // up to the cap, so `unnamedOversized` is truncation and nothing else.
      const oversizedCount = oversizedFiles.length;
      const unnamedOversized = oversizedCount - oversizedAttachmentNames.length;
      return NextResponse.json(
        {
          error: [
            oversizedCount && unsupportedFileCount === 0
              ? "The email has no text body to ingest"
              : "The email has no text body or supported document attachment to ingest",
            oversizedCount
              ? `${oversizedAttachmentNames.join(", ")}${
                  unnamedOversized
                    ? `, and ${unnamedOversized} other${unnamedOversized === 1 ? "" : "s"}`
                    : ""
                } ${
                  oversizedCount === 1 ? "is" : "are"
                } larger than ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB`
              : "",
          ]
            .filter(Boolean)
            .join(". "),
          ...(oversizedCount ? { oversizedAttachmentNames } : {}),
        },
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

    // Attachment loss accounting (DW-357). Hoisted above the duplicate check so
    // BOTH exits report the same pair; every input it reads is settled at
    // payload-parse time and nothing between here and the old site mutates them.
    //
    // The Worker's count and the route's own rejections are disjoint losses: the
    // Worker reports what it never forwarded, and the route can additionally drop
    // a forwarded file that fails `isSupportedDocument` or exceeds
    // `MAX_DOCUMENT_SIZE`. Both of the route's own drops are already inside
    // `payload.attachments.length - attachments.length`, so the oversize skip
    // needs no arithmetic of its own here. Sum them — and never report below what
    // is locally derivable, so a caller that sends no count (or an implausibly
    // low one) still gets an honest floor.
    //
    // TWO floors, whichever is higher, because the recorded-name subtraction is
    // not a bound on the route's own drops: `sanitizeAttachmentNames` discards a
    // name that scrubs away to nothing, so one oversized file named `"   "`
    // contributes no name at all and that subtraction answers zero — beside an
    // `oversizedAttachmentNames` list proving a file was dropped. The route's
    // own drop count cannot lie about itself, so it is the second floor.
    //
    // The first floor counts the CALLER'S recorded names, never the recorded
    // list `attachmentNames` above (DW-690). That list is the caller's names
    // UNIONED with the names of the files that arrived, and a forwarded file's
    // own filename is evidence the file arrived — never that one was skipped. So
    // any name the union contributes on the file side inflates the minuend
    // without adding anything the subtrahend can cancel, and the floor invents a
    // skip. The ordinary case reaches it: a supported part with no filename is
    // recorded by the Worker as `unnamed attachment` and forwarded as
    // `attachment-1`, which is one file, two names, and a phantom skip of 1.
    // `payload.attachmentNames` is the caller's claim about what it had, which
    // is the only side of the union a shortfall can be read off.
    //
    // THE PREMISE that makes this length a PART COUNT rather than a name count,
    // stated because the subtraction is meaningless without it. The Worker posts
    // exactly one recorded name per countable part
    // (`workers/email-ingest/index.ts`, the `countableAttachments.map(
    // replyAttachmentName)` that builds the field): `replyAttachmentName` falls
    // back to `unnamed attachment` and so never returns an empty string, so no
    // part loses its slot to `sanitizeAttachmentNames`'s `filter(Boolean)` —
    // and the Worker deliberately does NOT name a part it did not forward, which
    // is the DW-359 rule its own comments defend. One name in, one part; count
    // the names and you have counted the parts the sender was told travelled.
    //
    // THE ACCEPTED COST, for a caller that does not honour that. A hand-rolled
    // direct caller that records names ONLY for files it did not forward now
    // floors at 0 where the old union answered 1, because its recorded count is
    // below its forwarded count and the union used to add the two lists
    // together. That is not fixable by matching the caller's names against the
    // forwarded file names: `unnamed attachment` and `attachment-1` are ONE file
    // under two names, so any such matching re-creates exactly the phantom skip
    // DW-690 removed. It is recorded as accepted rather than worked around, and
    // such a caller already has an honest channel — its own
    // `skippedAttachmentCount`, which the `Math.max` below takes whenever it is
    // the larger figure.
    const localSkipped = Math.max(
      0,
      payload.attachmentNames.length - attachments.length,
      payload.attachments.length - attachments.length,
    );
    const skippedAttachmentCount =
      payload.skippedAttachmentCount === undefined
        ? localSkipped
        : Math.max(
            localSkipped,
            payload.skippedAttachmentCount +
              Math.max(0, payload.attachments.length - attachments.length),
          );

    const jobId = await emailJobId(messageId);
    const existing = await getIngestJob(jobId);
    if (existing) {
      return NextResponse.json({
        accepted: true,
        duplicate: true,
        jobId,
        status: existing.status,
        // Deliberately describing THIS request, not the job being acknowledged:
        // `status` and `slug` come from the stored job, but the counts are
        // derived from the payload just parsed. A resend carrying a different
        // attachment set therefore reports its own figures, not those of the
        // delivery that was actually ingested -- the accounting answers "what
        // did you just send me", which is the question a sender is asking.
        supportedAttachmentCount: attachments.length,
        skippedAttachmentCount,
        // Omitted when empty, so the field's presence alone means "a file was
        // dropped for being too big". For DIRECT service-principal callers: the
        // Worker reads only `error`, `jobId` and `slug` off this response, and
        // its own byte pre-filter means an emailed message can never reach here
        // with the field populated anyway.
        ...(oversizedAttachmentNames.length ? { oversizedAttachmentNames } : {}),
        ...(existing.slug ? { slug: existing.slug } : {}),
      });
    }

    const allAttachmentBytes = await Promise.all(
      attachments.map(async (file) => ({
        file,
        bytes: await file.arrayBuffer(),
      })),
    );

    // `receivedAt` is stamped ONCE, here, and carried onto every record this
    // message produces. An emailed PDF is parked behind an extract job that may
    // not compile for minutes, and a page dated by the compile would put the
    // sidecar's clock on the owner's correspondence.
    const email: EmailIngestMetadata = {
      from,
      to,
      subject,
      messageId,
      attachmentNames,
      receivedAt: new Date().toISOString(),
    };

    // BINARIES LEAVE HERE AS THEIR OWN SOURCES (Story 7.5). A PDF or DOCX that
    // arrived by mail used to be parsed on the Worker and glued onto the
    // message body; Epic 7 moved those parsers to the sidecar, so each one is
    // stored under `raw/sources/` and parked behind its own extract job. That
    // also stops one corrupt attachment from failing the whole message: the
    // note still compiles, and the attachment fails visibly on its own row.
    //
    // The rest — CSV, ZIP, the text formats — keep the inline path below,
    // because no crate reads them and there is nothing for the sidecar to do.
    const extractable = allAttachmentBytes.filter(({ file }) =>
      intakeRequiresExtract(
        (detectDocumentFormat(file.name, file.type) ?? "") as IntakeFormat,
      ),
    );
    const attachmentBytes = allAttachmentBytes.filter(
      (item) => !extractable.includes(item),
    );
    const extractIds: string[] = [];
    // Attachments that reached neither the extract queue nor the staged path.
    // They are ANSWERED, not dropped: an attachment removed from `extractable`
    // is also absent from `attachmentBytes`, so a failure that only logged left
    // the sender a 200 saying the mail was accepted with no Source, no row and
    // no sentence anywhere — the silent drop this epic forbids.
    const failedAttachments: { filename: string; error: string }[] = [];
    for (const { file, bytes } of extractable) {
      const format = detectDocumentFormat(file.name, file.type) as IntakeExtractFormat;
      const title = `${subject} — ${file.name}`.trim();
      try {
        const queued = await enqueueExtract({
          owner: contentOwner,
          slug: intakeSourceSlug(file.name),
          bytesSha256: await bytesSha256(bytes),
          ext: format,
          format,
          filename: file.name,
          title,
          bytes,
          email,
          ...(validVaultId ? { vaultId: validVaultId } : {}),
        });
        // `enqueueExtract` reports this failure WITHOUT throwing: the bytes
        // landed, the job records did not. The Source is real and reachable, so
        // the row it deserves is written here rather than inferred later.
        if (queued.error) {
          failedAttachments.push({ filename: file.name, error: queued.error });
          await recordFailedAttachment({
            owner: principal.handle,
            title,
            sourceRel: queued.path,
            error: queued.error,
            email,
          });
          continue;
        }
        extractIds.push(queued.extractId);
      } catch (error) {
        // The message is still worth compiling — one bad attachment must not
        // 500 and make the sender's Worker retry the whole delivery. But it
        // gets a failed Activity row, so the owner can see which one was lost.
        const message = getErrorMessage(error);
        logger.error(
          "email-ingest",
          `could not queue extract for attachment "${file.name}"`,
          error,
        );
        failedAttachments.push({ filename: file.name, error: message });
        await recordFailedAttachment({
          owner: principal.handle,
          title,
          error: message,
          email,
        });
      }
    }

    const stagedAttachments = await Promise.all(
      attachmentBytes.map(async ({ file, bytes }, index) => ({
        key: await stageBytes(jobId, `${index + 1}-${file.name}`, `attachment-${index + 1}`, bytes),
        filename: file.name,
        ...(file.type ? { contentType: file.type } : {}),
      })),
    );

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
      skippedAttachmentCount,
      // Omitted when empty, so the field's presence alone means "a file was
      // dropped for being too big".
      ...(oversizedAttachmentNames.length ? { oversizedAttachmentNames } : {}),
      ...(extractIds.length ? { extractIds } : {}),
      // Reported, not just logged. The status stays whatever the body's own
      // compile answered — the message did arrive — but a caller that reads
      // this field can tell that one attachment did not.
      ...(failedAttachments.length ? { failedAttachments } : {}),
    }, { status: response.status });
  } catch (error) {
    // Mid-request flag flip: the gate above already answered for a deployment
    // that was read-only on arrival, so a `ReadOnlyError` here came from the
    // kernel page writer. It is a refusal, not a server fault.
    if (isReadOnlyError(error)) {
      return NextResponse.json(
        { error: getErrorMessage(error) },
        { status: 403 },
      );
    }
    logger.error("email-ingest", "email ingest request failed", error);
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 500 });
  }
}
