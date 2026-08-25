import { NextRequest, NextResponse } from "next/server";
import type { IngestOptions } from "@/lib/ingest";
import { fetchPdfBytes, isUrl } from "@/lib/fetch";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import {
  enqueueExtract,
  type EnqueueExtractResult,
} from "@/lib/extract-dispatch";
import { logger } from "@/lib/logger";
import { MAX_PDF_SIZE } from "@/lib/constants";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { bytesSha256 } from "@/lib/source-sha256";
import { vaultOwnedBy } from "@/lib/vault";
import { intakeFileTitle, intakeSourceSlug } from "@/lib/workbench-intake";

/**
 * POST /api/ingest/pdf
 *
 * Ingest a PDF document — by URL (JSON) or file upload (multipart).
 *
 * BOTH PATHS STORE BYTES THEN ENQUEUE EXTRACT. An upload already has the
 * bytes. A `{ pdfUrl }` is fetched first ({@link fetchPdfBytes}) — SSRF,
 * redirects, size cap — then stored under the same key. The Worker does not
 * parse either one; `unpdf` is not on this door.
 *
 *   JSON:      { pdfUrl: string, title?: string, tags?: string[] }
 *   multipart: file=<blob>, title?=<string>, tags?=<comma-separated>
 */

function extractQueuedResponse(queued: EnqueueExtractResult) {
  return NextResponse.json(
    {
      queued: !queued.error && !queued.sidecarDown,
      extract: true,
      ...(queued.sidecarDown ? { sidecarDown: true } : {}),
      path: queued.path,
      jobId: queued.jobId,
      extractId: queued.extractId,
      ...(queued.error ? { error: queued.error } : {}),
    },
    { status: queued.error ? 202 : 200 },
  );
}

export async function POST(request: NextRequest) {
  try {
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Deployment read-only (DW-187). Answered HERE — after the 401, before any
    // work — and not left to the kernel writer, because this door meets BOTH
    // halves of the rule:
    //   - IRREVERSIBLE WORK ALREADY COMMITTED: an ingest-job record is created
    //     and the PDF bytes are staged to R2 before the work is enqueued.
    //   - EXPENSIVE, FAILABLE WORK FIRST: PDF extraction and two LLM calls run
    //     ahead of the page write.
    // Ordered after `getPrincipal()` so an unauthenticated caller still learns
    // it is unauthenticated, matching `DELETE /api/ingest/history`.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.ingest },
        { status: 403 },
      );
    }

    // Attribution comes from the session, never the request body.
    const options: Omit<IngestOptions, "sourceType"> & { title?: string } = {
      author: principal.handle,
      owner: principal.handle,
      triggeredBy: principal.handle,
    };

    const contentType = request.headers.get("content-type") || "";

    if (contentType.includes("multipart/form-data")) {
      const form = await request.formData();
      const file = form.get("file");
      if (!(file instanceof File) || file.size === 0) {
        return NextResponse.json(
          { error: "A non-empty 'file' is required." },
          { status: 400 },
        );
      }
      if (file.size > MAX_PDF_SIZE) {
        return NextResponse.json(
          { error: `PDF too large (max ${MAX_PDF_SIZE / 1024 / 1024} MB).` },
          { status: 400 },
        );
      }
      const title = form.get("title");
      if (typeof title === "string" && title.trim()) options.title = title.trim();
      const tags = form.get("tags");
      if (typeof tags === "string" && tags.trim()) {
        options.tags = tags.split(",").map((t) => t.trim()).filter(Boolean);
      }
      const formVaultId = form.get("vaultId");
      let validatedVaultId: string | undefined;
      if (typeof formVaultId === "string" && formVaultId.trim()) {
        if (!vaultOwnedBy(formVaultId, principal.handle)) {
          return NextResponse.json(
            { error: "Vault not found or not owned by you" },
            { status: 403 },
          );
        }
        validatedVaultId = formVaultId;
      }

      const bytes = await file.arrayBuffer();

      // THE WORKER NO LONGER PARSES THIS. Epic 7 moved PDF text off `unpdf`
      // and onto the sidecar's pinned `pdf-extract`, so an uploaded PDF is
      // stored and parked behind an extract job. The URL path below does the
      // same after it has fetched the bytes.
      const digest = await bytesSha256(bytes);
      const queued = await enqueueExtract({
        owner: principal.handle,
        slug: intakeSourceSlug(file.name),
        bytesSha256: digest,
        ext: "pdf",
        format: "pdf",
        filename: file.name,
        title: options.title ?? intakeFileTitle(file.name),
        bytes,
        ...(validatedVaultId ? { vaultId: validatedVaultId } : {}),
        ...(options.tags?.length ? { tags: options.tags } : {}),
      });
      return extractQueuedResponse(queued);
    }

    // JSON path: { pdfUrl, title?, tags? }
    const body = await request.json();
    const { pdfUrl, title, tags } = body;
    if (typeof pdfUrl !== "string" || !isUrl(pdfUrl.trim())) {
      return NextResponse.json(
        { error: "pdfUrl is required and must be a valid URL." },
        { status: 400 },
      );
    }
    if (typeof title === "string" && title.trim()) options.title = title.trim();
    if (Array.isArray(tags) && tags.every((t: unknown) => typeof t === "string")) {
      options.tags = tags;
    }

    let validatedVaultId: string | undefined;
    if (body.vaultId !== undefined) {
      if (typeof body.vaultId !== "string" || body.vaultId.trim().length === 0) {
        return NextResponse.json(
          { error: "vaultId must be a non-empty string if provided" },
          { status: 400 },
        );
      }
      if (!vaultOwnedBy(body.vaultId, principal.handle)) {
        return NextResponse.json(
          { error: "Vault not found or not owned by you" },
          { status: 403 },
        );
      }
      validatedVaultId = body.vaultId;
    }

    const trimmedUrl = pdfUrl.trim();
    const fetched = await fetchPdfBytes(trimmedUrl);
    const digest = await bytesSha256(fetched.bytes);
    const queued = await enqueueExtract({
      owner: principal.handle,
      slug: intakeSourceSlug(fetched.filename),
      bytesSha256: digest,
      ext: "pdf",
      format: "pdf",
      filename: fetched.filename,
      title: options.title ?? fetched.title,
      bytes: fetched.bytes,
      sourceUrl: trimmedUrl,
      ...(validatedVaultId ? { vaultId: validatedVaultId } : {}),
      ...(options.tags?.length ? { tags: options.tags } : {}),
    });
    return extractQueuedResponse(queued);
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
    const msg = getErrorMessage(error);
    if (error instanceof ClientInputError) {
      logger.warn("ingest", `PDF ingest rejected: ${msg}`);
      return NextResponse.json({ error: msg }, { status: 400 });
    }
    logger.error("ingest", "PDF ingest error", error);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
