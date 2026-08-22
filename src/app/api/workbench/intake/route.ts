import { NextRequest, NextResponse } from "next/server";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { contentHash } from "@/lib/embeddings";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { fetchUrlContent } from "@/lib/fetch";
import { ingest, type IngestOptions } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob } from "@/lib/ingest-jobs";
import { stageText } from "@/lib/ingest-staging";
import { logger } from "@/lib/logger";
import { saveRawSourceFor } from "@/lib/raw";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { type Task } from "@/lib/tasks";
import {
  INTAKE_ALLOWED_CONTENT_TYPES,
  INTAKE_EMPTY_SOURCE_COPY,
  INTAKE_FILE_REQUIRED_COPY,
  INTAKE_SIGN_IN_COPY,
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeFileTitle,
  intakeSourceSlug,
  intakeTooLargeCopy,
  intakeUrlSlug,
  isIntakeUrl,
} from "@/lib/workbench-intake";

/**
 * `POST /api/workbench/intake` — the Workbench's Source door (Story 2.1).
 *
 * ONE ARRIVAL PER REQUEST, deliberately. A batch of N files is N stored Sources
 * and N queue items, and `enqueueOrInline` composes the response for exactly one
 * job — so the client posts N times and reports per-item outcomes, rather than
 * this route growing a second enqueue loop beside the shared one. That is also
 * what makes "successes still store and queue when one item fails" fall out of
 * the transport instead of a partial-batch response shape nobody else answers.
 *
 * A NARROWER DOOR than `/api/ingest/document`. That route accepts PDF, DOCX and
 * the rest because the kernel can extract them; here they must fail visibly
 * (`classifyIntakeFile`, and the narrowed content-type list handed to
 * `fetchUrlContent`) because this epic runs no sidecar extract. Widening this
 * handler to the vault's allowlist would quietly make the Workbench a document
 * extractor door.
 *
 * WHAT IT DOES, in order: refuse (401 → 403 → shape → type), store the immutable
 * bytes under `raw/sources/` through `saveRawSourceFor` — the only raw-source
 * writer, which also mirrors them into the owner's silo and bumps `dataVersion`
 * — then enqueue Ingest. The store happens BEFORE the enqueue so a queue that
 * rejects still leaves the Source on disk (the epic's "Sources persist even when
 * compile fails"), and the queued payload is the STORED text rather than the URL,
 * so compile reads exactly the bytes that were kept instead of re-fetching a page
 * that may have changed.
 *
 * Which makes the STATUS CODE a claim about the Source, not about the job: once
 * the bytes are stored the answer is 2xx even if the queue then rejects, because
 * the client uses a failure to decide whether to re-poll the trees and a Source
 * that landed must not be reported as one that did not. See `storeAndQueue`.
 */

/** Matches `/api/ingest`: larger text is staged to R2 rather than sent inline. */
const MAX_INLINE_CONTENT_CHARS = 96000;

export async function POST(request: NextRequest) {
  try {
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: INTAKE_SIGN_IN_COPY }, { status: 401 });
    }

    // Deployment read-only (DW-187), answered after the 401 and BEFORE any
    // staging, silo write or job record — the same ordering `/api/ingest` uses,
    // and for the same reason: everything below this line commits something.
    if (isReadOnly()) {
      return NextResponse.json({ error: READ_ONLY_REFUSAL.ingest }, { status: 403 });
    }

    const contentType = request.headers.get("content-type") || "";
    return contentType.includes("multipart/form-data")
      ? await intakeFile(request, principal.handle)
      : await intakeUrl(request, principal.handle);
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    if (error instanceof ClientInputError) {
      logger.warn("intake", `workbench intake rejected: ${message}`);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logger.error("intake", "workbench intake error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/** A picked or dropped file: `.md` / `.txt` / `.html` only. */
async function intakeFile(
  request: NextRequest,
  owner: string,
): Promise<NextResponse> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return NextResponse.json({ error: INTAKE_FILE_REQUIRED_COPY }, { status: 400 });
  }
  // The name a drop reports may carry a directory part; the classifier reads
  // only the extension, and `intakeSourceSlug` reduces it to one segment.
  const verdict = classifyIntakeFile(file.name, file.type);
  if (!verdict.ok) {
    // No Source written, no job created, no extract attempted — the refusal is
    // the whole of what this door does with an office or ebook file.
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return NextResponse.json(
      { error: intakeTooLargeCopy(MAX_DOCUMENT_SIZE / 1024 / 1024) },
      { status: 400 },
    );
  }

  const text = (await file.text()).trim();
  if (text.length === 0) {
    return NextResponse.json({ error: INTAKE_EMPTY_SOURCE_COPY }, { status: 400 });
  }

  return await storeAndQueue({
    owner,
    slug: intakeSourceSlug(file.name),
    text,
    title: intakeFileTitle(file.name),
    sourceType: "text",
  });
}

/** The in-app URL field. HTML becomes clip Markdown; PDF and office fail. */
async function intakeUrl(
  request: NextRequest,
  owner: string,
): Promise<NextResponse> {
  // `?? {}` as well as the catch: a body of the four characters `null` is VALID
  // JSON, so `request.json()` resolves with `null` and never reaches the catch —
  // and reading `.url` off it throws a TypeError that the outer handler can only
  // report as a 500. It is a malformed request, and it gets the 400 every other
  // malformed one gets.
  const body = (await request.json().catch(() => ({}))) ?? {};
  const raw = (body as { url?: unknown }).url;
  const url = typeof raw === "string" ? raw.trim() : "";
  if (!isIntakeUrl(url)) {
    return NextResponse.json({ error: INTAKE_URL_REQUIRED_COPY }, { status: 400 });
  }

  let fetched: { title: string; content: string };
  try {
    // Readability + `htmlToMarkdown` for HTML, the body verbatim for
    // text/plain and text/markdown — the existing path (AD-16), with the
    // content-type list narrowed so `application/pdf` is refused here instead
    // of being routed into extraction.
    fetched = await fetchUrlContent(url, {
      allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES,
    });
  } catch (error) {
    // A blocked host, an unsupported type, an unparseable page: the arrival
    // fails on this action and NO Source is invented for it. 400 rather than
    // 500 — every one of those is a fact about the URL the owner supplied.
    return NextResponse.json({ error: getErrorMessage(error) }, { status: 400 });
  }

  const text = fetched.content.trim();
  if (text.length === 0) {
    return NextResponse.json({ error: INTAKE_EMPTY_SOURCE_COPY }, { status: 400 });
  }

  return await storeAndQueue({
    owner,
    slug: intakeUrlSlug(url),
    text,
    title: fetched.title,
    sourceType: "url",
    sourceUrl: url,
  });
}

/**
 * The golden path both doors end in: store the immutable bytes, then queue one
 * Ingest for them.
 *
 * The raw id is a hash of the STORED TEXT, so a re-arrival of identical bytes
 * lands on the key it already occupies (and is left untouched) while different
 * bytes under the same filename get their own key. That is how "Sources are
 * immutable after save" holds without a second upload of the same name being
 * refused.
 */
async function storeAndQueue(input: {
  owner: string;
  slug: string;
  text: string;
  title: string;
  sourceType: "text" | "url";
  sourceUrl?: string;
}): Promise<NextResponse> {
  const { owner, slug, text, title, sourceType, sourceUrl } = input;

  // The ONE raw-source writer (AD-3). It also mirrors into
  // `tenants/<tenant>/raw/sources/…` so the Files tree can see the arrival, and
  // bumps `dataVersion` so the trees refresh without a reload.
  const rawId = contentHash(text);
  const path = await saveRawSourceFor(slug, rawId, text, { owner });

  const options: IngestOptions = {
    owner,
    author: owner,
    triggeredBy: owner,
    sourceType,
    ...(sourceUrl ? { sourceUrl } : {}),
  };

  const jobId = crypto.randomUUID();
  await createIngestJob({ jobId, owner, title, ...(sourceUrl ? { url: sourceUrl } : {}) });

  const base = {
    kind: "ingest" as const,
    ...(title ? { title } : {}),
    owner,
    author: owner,
    triggeredBy: owner,
    sourceType,
    ...(sourceUrl ? { sourceUrl } : {}),
    jobId,
  };
  // Small enough to ride inline in the queue message; otherwise staged to R2,
  // exactly as `/api/ingest` does for a large paste.
  const task: Task =
    text.length <= MAX_INLINE_CONTENT_CHARS
      ? { ...base, content: text }
      : { ...base, staged: { key: await stageText(jobId, text), kind: "text" } };

  // THE SOURCE IS ALREADY ON DISK from here down, so a failure below is not a
  // failed arrival. Answering 500 told the client the whole thing failed: it
  // reported a confirmed failure, `intakeShouldRefresh` stayed false, and the
  // trees were never re-polled — so bytes that had landed, and were listable in
  // Files, stayed invisible until something else happened to bump the version.
  //
  // So a rejected queue is a PARTIAL success: 202 with the stored path and
  // `queued: false`. The Source is NOT rolled back — deleting stored bytes to
  // tidy up a queue error would be the one thing FR-2 forbids, and Ingest can be
  // re-driven for a Source that exists.
  let response: Response;
  try {
    response = await enqueueOrInline(jobId, task, () => ingest(title, text, options));
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error("intake", `stored "${path}" but could not queue Ingest`, error);
    return NextResponse.json(
      { queued: false, jobId, path, error: message },
      { status: 202 },
    );
  }

  // The stored key travels back so the client can name what landed; the body
  // `enqueueOrInline` composed (`queued`, `jobId`, maybe `slug`) is unchanged.
  const served = (await response
    .json()
    .catch(() => ({}))) as Record<string, unknown>;
  return NextResponse.json({ ...served, path }, { status: response.status });
}
