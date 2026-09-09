import { ownerTenantHandle } from "@/lib/owner";
import { NextRequest, NextResponse } from "next/server";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { INTAKE_ANSWER_BUDGET_MS, MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { extension } from "@/lib/document-formats";
import { contentHash } from "@/lib/embeddings";
import { getErrorMessage, isClientInputError } from "@/lib/errors";
import { enqueueExtract, rememberExtractMeeting } from "@/lib/extract-dispatch";
import { fetchUrlContent } from "@/lib/fetch";
import { ingest, recordSourceResee, sameHumanOwner, type IngestOptions } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob } from "@/lib/ingest-jobs";
import { resolveContentSha256, resolveStoredSourcePath } from "@/lib/source-index";
import { bytesSha256, sourceSha256 } from "@/lib/source-sha256";
import { stageText } from "@/lib/ingest-staging";
import { logger } from "@/lib/logger";
import {
  readRawSourceTree,
  saveRawSourceBytes,
  saveRawSourceFor,
  saveRawSourceTree,
} from "@/lib/raw";
import { workbenchSourcePath } from "@/lib/source-delete";
import { setSourceMeeting } from "@/lib/source-meeting";
import { readWikiPageWithFrontmatter } from "@/lib/wiki";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { type Task } from "@/lib/tasks";
import {
  INTAKE_ALLOWED_CONTENT_TYPES,
  INTAKE_BAD_PATH_COPY,
  INTAKE_EMPTY_SOURCE_COPY,
  INTAKE_EXTRACT_UNAVAILABLE_COPY,
  INTAKE_FILE_REQUIRED_COPY,
  INTAKE_MEDIA_STORED_COPY,
  INTAKE_PATH_COLLISION_COPY,
  INTAKE_SIGN_IN_COPY,
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeFileTitle,
  intakeSourceSlug,
  intakeTooLargeCopy,
  intakeUrlSlug,
  isIntakeMediaFormat,
  isIntakeTextFormat,
  isIntakeUrl,
  sanitizeIntakeRelativePath,
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
 * A DIFFERENT DOOR from `/api/ingest/document`, not a narrower one any more.
 * Epic 7 widened it to every format the sidecar's extract crate can read, plus
 * browser-renderable media — but a binary is stored and QUEUED here, never
 * parsed here. The Worker cannot reach `127.0.0.1`, so the arrival ends with an
 * extract record the sidecar claims (`enqueueExtract`), and Ingest starts only
 * once the extracted text is in the kernel. `csv`, `zip`, `odt`, `odp`, `org`
 * and `rtf` stay out: no crate reads them, and storing bytes nothing can
 * compile is a slower version of losing them.
 *
 * The URL door keeps its narrowed content-type list. A `.pdf` LINK is still
 * refused there — the extract path needs bytes on disk with an owner and a
 * digest, which is what the file door produces and what a streamed fetch does
 * not.
 *
 * WHAT IT DOES, in order: refuse (401 → 403 → shape → type), store the immutable
 * bytes under `raw/sources/` through `saveRawSourceFor` (loose files) or
 * `saveRawSourceTree` (folder-expanded `relativePath`) — the same
 * `storeRawSource` helper, which also mirrors them into the owner's silo and
 * bumps `dataVersion` — then enqueue Ingest. The store happens BEFORE the
 * enqueue so a queue that rejects still leaves the Source on disk (the epic's
 * "Sources persist even when compile fails"), and the queued payload is the
 * STORED text rather than the URL, so compile reads exactly the bytes that
 * were kept instead of re-fetching a page that may have changed.
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

    // THE REQUEST'S OWN DEADLINE (DW-700), captured before any work so what is
    // handed to the inline ingest below is the REMAINDER — what the fetch, the
    // store and the job record left over — rather than a fixed margin that
    // cannot bound total work. See `INTAKE_ANSWER_BUDGET_MS`.
    const answerBy = Date.now() + INTAKE_ANSWER_BUDGET_MS;

    const contentType = request.headers.get("content-type") || "";
    return contentType.includes("multipart/form-data")
      ? await intakeFile(request, ownerTenantHandle(principal), answerBy, principal.handle)
      : await intakeUrl(request, ownerTenantHandle(principal), answerBy, principal.handle);
  } catch (error) {
    if (isReadOnlyError(error)) {
      return NextResponse.json({ error: getErrorMessage(error) }, { status: 403 });
    }
    const message = getErrorMessage(error);
    if (isClientInputError(error)) {
      logger.warn("intake", `workbench intake rejected: ${message}`);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logger.error("intake", "workbench intake error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * A picked or dropped file.
 *
 * THREE ENDINGS, chosen by what the classifier called it (Story 7.1):
 * text is stored and compiled here; an extract format is stored as bytes and
 * handed to {@link enqueueExtract}; media is stored as bytes and compiles
 * nothing. Only an unrecognised type is refused, and only that ending writes
 * no Source at all.
 */
async function intakeFile(
  request: NextRequest,
  owner: string,
  answerBy: number,
  actor: string,
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
    return NextResponse.json({ error: verdict.reason }, { status: 400 });
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return NextResponse.json(
      { error: intakeTooLargeCopy(MAX_DOCUMENT_SIZE / 1024 / 1024) },
      { status: 400 },
    );
  }

  const originRaw = form.get("origin");
  const origin = originRaw === "plaud" ? ("plaud" as const) : undefined;
  const slug = intakeSourceSlug(file.name);
  const title = intakeFileTitle(file.name);

  if (!isIntakeTextFormat(verdict.format)) {
    // BYTES, not `file.text()`. Decoding a PDF as UTF-8 would replace every
    // byte the decoder does not recognise, and the sidecar would then be
    // handed a document that no longer parses.
    const bytes = await file.arrayBuffer();
    const digest = await bytesSha256(bytes);
    const ext = extension(file.name) || defaultExtensionFor(verdict.format);

    if (isIntakeMediaFormat(verdict.format)) {
      return await storeMedia({ owner, slug, title, ext, digest, bytes });
    }

    const queued = await enqueueExtract({
      owner,
      actor,
      slug,
      bytesSha256: digest,
      ext,
      format: verdict.format,
      filename: file.name,
      title,
      bytes,
      ...(origin ? { origin } : {}),
    });
    await rememberExtractMeeting(owner, queued.path, origin);
    if (queued.error) {
      // The bytes landed; only the two job records did not. Same 202 contract
      // the text path uses for a queue that rejected after a successful store.
      return NextResponse.json(
        { queued: false, path: queued.path, jobId: queued.jobId, error: queued.error },
        { status: 202 },
      );
    }
    if (queued.sidecarDown) {
      // The bytes are stored and the row carries the locked sentence, so this
      // is NOT a refusal: 200 with `queued: false` keeps the client re-polling
      // the trees for a Source that really did land.
      return NextResponse.json(
        {
          queued: false,
          extract: true,
          sidecarDown: true,
          path: queued.path,
          jobId: queued.jobId,
          extractId: queued.extractId,
          note: INTAKE_EXTRACT_UNAVAILABLE_COPY,
        },
        { status: 200 },
      );
    }
    return NextResponse.json(
      {
        queued: true,
        extract: true,
        path: queued.path,
        jobId: queued.jobId,
        extractId: queued.extractId,
      },
      { status: 200 },
    );
  }

  const text = await file.text();
  if (text.length === 0) {
    return NextResponse.json({ error: INTAKE_EMPTY_SOURCE_COPY }, { status: 400 });
  }

  const relativeRaw = form.get("relativePath");
  if (relativeRaw !== null && typeof relativeRaw !== "string") {
    return NextResponse.json({ error: INTAKE_BAD_PATH_COPY }, { status: 400 });
  }
  const relativeInput =
    typeof relativeRaw === "string" && relativeRaw.trim() ? relativeRaw.trim() : "";
  let relativePath: string | undefined;
  if (relativeInput) {
    const sanitized = sanitizeIntakeRelativePath(relativeInput);
    if (!sanitized.ok) {
      return NextResponse.json({ error: sanitized.reason }, { status: 400 });
    }
    relativePath = sanitized.path;
  }

  return await storeAndQueue({
    owner,
    actor,
    slug,
    text,
    title,
    sourceType: "text",
    answerBy,
    ...(relativePath ? { relativePath } : {}),
    ...(origin ? { origin } : {}),
  });
}

/**
 * The extension a format is stored under when the arrival had none.
 *
 * A drop can report `Screenshot` with the suffix stripped, and the stored key
 * has to carry SOMETHING the Preview can dispatch a player or an `<img>` on.
 */
function defaultExtensionFor(format: string): string {
  if (format === "image") return "png";
  if (format === "video") return "mp4";
  if (format === "audio") return "mp3";
  return format;
}

/**
 * Store an image, video or audio Source.
 *
 * NO EXTRACT JOB AND NO COMPILE: there is no crate that turns a JPEG into
 * prose, and enqueueing an ingest for one would produce a Page built from
 * nothing. The job record exists anyway, terminal and `skipped`, because the
 * alternative is an arrival that leaves no trace in Activity — which is
 * indistinguishable from the silent drop this epic forbids.
 */
async function storeMedia(input: {
  owner: string;
  slug: string;
  title: string;
  ext: string;
  digest: string;
  bytes: ArrayBuffer;
}): Promise<NextResponse> {
  const stored = await saveRawSourceBytes(
    input.slug,
    input.digest,
    input.ext,
    input.bytes,
    // Mirrored into the owner's silo, which is where Files and the media door
    // resolve `raw/` — a flat-only image is stored but unreachable.
    { owner: input.owner },
  );
  const path = workbenchSourcePath(stored.path) ?? stored.path;
  const jobId = crypto.randomUUID();
  try {
    await createIngestJob({
      jobId,
      owner: input.owner,
      title: input.title,
      status: "skipped",
      sourceRel: path,
      sourceType: "text",
      contentSha256: input.digest,
    });
  } catch (error) {
    logger.error("intake", `stored media "${path}" but could not record it`, error);
  }
  return NextResponse.json(
    {
      queued: false,
      skipped: true,
      media: true,
      path,
      jobId,
      note: INTAKE_MEDIA_STORED_COPY,
    },
    { status: 200 },
  );
}

/** The in-app URL field. HTML becomes clip Markdown; PDF and office fail. */
async function intakeUrl(
  request: NextRequest,
  owner: string,
  answerBy: number,
  actor: string,
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

  // A non-empty string clip is the body — store it and skip the fetch. Missing
  // or non-string clip is absent, not hashed; empty clip keeps the 2.1 fetch.
  const clipRaw = (body as { clip?: unknown }).clip;
  const clip = typeof clipRaw === "string" ? clipRaw : "";
  if (clip.trim()) {
    const bytes = new TextEncoder().encode(clip).byteLength;
    if (bytes > MAX_DOCUMENT_SIZE) {
      return NextResponse.json(
        { error: intakeTooLargeCopy(MAX_DOCUMENT_SIZE / 1024 / 1024) },
        { status: 400 },
      );
    }
    const firstLine = clip.split(/\r?\n/, 1)[0]?.trim() ?? "";
    return await storeAndQueue({
      owner,
      actor,
      slug: intakeUrlSlug(url),
      text: clip,
      title: (firstLine || url).slice(0, 200),
      sourceType: "url",
      sourceUrl: url,
      answerBy,
    });
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

  const text = fetched.content;
  if (text.trim().length === 0) {
    return NextResponse.json({ error: INTAKE_EMPTY_SOURCE_COPY }, { status: 400 });
  }

  return await storeAndQueue({
    owner,
    actor,
    slug: intakeUrlSlug(url),
    text,
    title: fetched.title,
    sourceType: "url",
    sourceUrl: url,
    answerBy,
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
async function authorizedShaSkip(
  digest: string,
  owner: string,
  sourceUrl?: string,
  sourceType: "text" | "url" = "text",
  actor: string = owner,
): Promise<{ slug: string; path?: string } | null> {
  const existing = await resolveContentSha256(digest);
  if (!existing) return null;
  const page = await readWikiPageWithFrontmatter(existing);
  if (page && !sameHumanOwner(owner, page.frontmatter.owner)) {
    return null;
  }
  const existingPath = await resolveStoredSourcePath(existing);
  const resee = await recordSourceResee(existing, {
    url: sourceUrl ?? existingPath ?? "text-paste",
    type: sourceType,
    triggeredBy: actor,
    actorOwner: owner,
  });
  if (!resee) return null;
  return { slug: resee.primarySlug, ...(existingPath ? { path: existingPath } : {}) };
}

async function rememberPlaudMeeting(
  owner: string,
  sourcePath: string | undefined,
  origin?: "plaud",
): Promise<void> {
  if (origin !== "plaud" || !sourcePath) return;
  await setSourceMeeting(owner, sourcePath, true).catch((error) => {
    logger.warn("intake", `plaud meeting flag failed for "${sourcePath}"`, error);
  });
}

async function recordSkippedJob(input: {
  owner: string;
  title: string;
  sourceUrl?: string;
  origin?: "plaud";
  sourceRel?: string;
  relativePath?: string;
  sourceType: "text" | "url";
  digest: string;
}): Promise<string> {
  await rememberPlaudMeeting(input.owner, input.sourceRel, input.origin);
  const jobId = crypto.randomUUID();
  try {
    await createIngestJob({
      jobId,
      owner: input.owner,
      title: input.title,
      status: "skipped",
      ...(input.sourceUrl ? { url: input.sourceUrl } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
      ...(input.sourceRel ? { sourceRel: input.sourceRel } : {}),
      ...(input.relativePath ? { relativePath: input.relativePath } : {}),
      sourceType: input.sourceType,
      contentSha256: input.digest,
    });
  } catch (error) {
    logger.error("intake", `could not record skipped job for "${input.title}"`, error);
  }
  return jobId;
}

async function storeAndQueue(input: {
  owner: string;
  actor: string;
  slug: string;
  text: string;
  title: string;
  sourceType: "text" | "url";
  sourceUrl?: string;
  relativePath?: string;
  origin?: "plaud";
  /** Wall-clock ms after which this request must answer — see `POST`. */
  answerBy: number;
}): Promise<NextResponse> {
  const { owner, actor, slug, text, title, sourceType, sourceUrl, relativePath, origin } = input;

  const digest = await sourceSha256(text);
  const authorized = await authorizedShaSkip(digest, owner, sourceUrl, sourceType, actor);

  // Loose files keep the 2.1 hash key so a second `notes.md` does not collide.
  // Folder identity is the sanitized relative path (FR-40); both writers share
  // `storeRawSource` — silo mirror, immutability, `dataVersion` bump.
  let path: string;
  if (relativePath) {
    const stored = await saveRawSourceTree(relativePath, text, { owner });
    path =
      workbenchSourcePath(stored.path) ?? `raw/sources/${relativePath}`;
    if (!stored.created) {
      const held = await readRawSourceTree(relativePath);
      if (held !== null && held !== text) {
        return NextResponse.json(
          {
            queued: false,
            refused: true,
            path,
            error: INTAKE_PATH_COLLISION_COPY,
          },
          { status: 409 },
        );
      }
      const jobId = await recordSkippedJob({
        owner,
        title,
        sourceUrl,
        origin,
        sourceRel: path,
        relativePath,
        sourceType,
        digest,
      });
      return NextResponse.json(
        {
          queued: false,
          skipped: true,
          path,
          jobId,
          ...(authorized ? { slug: authorized.slug } : {}),
        },
        { status: 200 },
      );
    }
    if (authorized) {
      const jobId = await recordSkippedJob({
        owner,
        title,
        sourceUrl,
        origin,
        sourceRel: path,
        relativePath,
        sourceType,
        digest,
      });
      return NextResponse.json(
        { queued: false, skipped: true, path, jobId, slug: authorized.slug },
        { status: 200 },
      );
    }
  } else if (authorized) {
    const jobId = await recordSkippedJob({
      owner,
      title,
      sourceUrl,
      origin,
      sourceRel: authorized.path,
      sourceType,
      digest,
    });
    return NextResponse.json(
      {
        queued: false,
        skipped: true,
        ...(authorized.path ? { path: authorized.path } : {}),
        jobId,
        slug: authorized.slug,
      },
      { status: 200 },
    );
  } else {
    const storedPath = await saveRawSourceFor(slug, contentHash(text), text, {
      owner,
    });
    path =
      workbenchSourcePath(storedPath) ??
      `raw/sources/${slug}/${contentHash(text)}.md`;
  }

  const options: IngestOptions = {
    owner,
    author: actor,
    triggeredBy: actor,
    sourceType,
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(relativePath ? { relativePath } : {}),
    ...(origin ? { origin } : {}),
    contentSha256: digest,
    sourcePath: path,
  };

  await rememberPlaudMeeting(owner, path, origin);

  const jobId = crypto.randomUUID();

  // THE SOURCE IS ALREADY ON DISK from here down, so a failure below is not a
  // failed arrival. Answering 500 told the client the whole thing failed: it
  // reported a confirmed failure, `intakeShouldRefresh` stayed false, and the
  // trees were never re-polled — so bytes that had landed, and were listable in
  // Files, stayed invisible until something else happened to bump the version.
  //
  // The same hole used to sit on `createIngestJob` and `stageText`: they run
  // after the write and a throw became a 500. So ANY post-store failure is a
  // PARTIAL success: 202 with the stored path and `queued: false`. The Source
  // is NOT rolled back — deleting stored bytes to tidy up a queue error would
  // be the one thing FR-2 forbids, and Ingest can be re-driven for a Source
  // that exists.
  let response: Response;
  try {
    await createIngestJob({
      jobId,
      owner,
      title,
      ...(sourceUrl ? { url: sourceUrl } : {}),
      ...(origin ? { origin } : {}),
      sourceRel: path,
      ...(relativePath ? { relativePath } : {}),
      sourceType,
      contentSha256: digest,
    });

    options.jobId = jobId;

    const base = {
      kind: "ingest" as const,
      ...(title ? { title } : {}),
      owner,
      author: actor,
      triggeredBy: actor,
      sourceType,
      ...(sourceUrl ? { sourceUrl } : {}),
      ...(relativePath ? { relativePath } : {}),
      ...(origin ? { origin } : {}),
      contentSha256: digest,
      sourcePath: path,
      jobId,
    };
    // Small enough to ride inline in the queue message; otherwise staged to R2,
    // exactly as `/api/ingest` does for a large paste. Folder context rides
    // top-level for inline text; staged already has `relativePath`.
    const task: Task =
      text.length <= MAX_INLINE_CONTENT_CHARS
        ? { ...base, content: text }
        : {
            ...base,
            staged: {
              key: await stageText(jobId, text),
              kind: "text",
              ...(relativePath ? { relativePath } : {}),
            },
          };

    // The inline compile (queue absent) gets whatever is LEFT of the request's
    // answer budget — the fetch and the store already spent part of it. Past
    // that point the route answers `{ queued: true, jobId, path }` and the run
    // goes on marking the job, rather than letting the client's deadline fire
    // on a Source that landed.
    response = await enqueueOrInline(jobId, task, () => ingest(title, text, options), {
      inlineBudgetMs: Math.max(0, input.answerBy - Date.now()),
    });
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
