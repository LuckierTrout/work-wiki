import { NextRequest, NextResponse } from "next/server";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { detectDocumentFormat } from "@/lib/document-extract";
import { ClientInputError, getErrorMessage } from "@/lib/errors";
import { ingestDocument, type IngestOptions } from "@/lib/ingest";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob } from "@/lib/ingest-jobs";
import { stageBytes } from "@/lib/ingest-staging";
import { logger } from "@/lib/logger";
import { isReadOnly } from "@/lib/config";
import { READ_ONLY_REFUSAL, isReadOnlyError } from "@/lib/read-only";
import { addToVault, vaultOwnedBy } from "@/lib/vault";

/** POST /api/ingest/document — upload a supported document or safe archive. */
export async function POST(request: NextRequest) {
  try {
    const principal = (await getPrincipal()) ?? getServicePrincipal(request);
    if (!principal) {
      return NextResponse.json({ error: "Sign in required." }, { status: 401 });
    }

    // Deployment read-only (DW-187). Answered HERE — after the 401, before any
    // work — and not left to the kernel writer, because this door meets BOTH
    // halves of the rule:
    //   - IRREVERSIBLE WORK ALREADY COMMITTED: the uploaded bytes are staged to
    //     R2 and an ingest-job record is created before anything is enqueued,
    //     so a kernel-only refusal strands both on every attempt.
    //   - EXPENSIVE, FAILABLE WORK FIRST: extraction and two LLM calls run
    //     ahead of the page write.
    // Ordered after `getPrincipal()` so an unauthenticated caller still learns
    // it is unauthenticated, matching `DELETE /api/ingest/history`.
    if (isReadOnly()) {
      return NextResponse.json(
        { error: READ_ONLY_REFUSAL.ingest },
        { status: 403 },
      );
    }
    if (!(request.headers.get("content-type") || "").includes("multipart/form-data")) {
      return NextResponse.json(
        { error: "Upload a supported document as multipart form data." },
        { status: 400 },
      );
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File) || file.size === 0) {
      return NextResponse.json({ error: "A non-empty 'file' is required." }, { status: 400 });
    }
    const format = detectDocumentFormat(file.name, file.type);
    if (!format) {
      return NextResponse.json(
        { error: "Unsupported document type. Use Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, ZIP, ODT/ODS/ODP, EPUB, MOBI, Org, or RTF." },
        { status: 400 },
      );
    }
    if (file.size > MAX_DOCUMENT_SIZE) {
      return NextResponse.json(
        { error: `Document too large (max ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB).` },
        { status: 400 },
      );
    }

    const options: Omit<IngestOptions, "sourceType"> & { title?: string } = {
      owner: principal.handle,
      author: principal.handle,
      triggeredBy: principal.handle,
    };
    const title = form.get("title");
    if (typeof title === "string" && title.trim()) options.title = title.trim();
    const tags = form.get("tags");
    if (typeof tags === "string" && tags.trim()) {
      options.tags = tags.split(",").map((tag) => tag.trim()).filter(Boolean);
    }
    const relativePathValue = form.get("relativePath");
    const relativePath =
      typeof relativePathValue === "string" && relativePathValue.trim()
        ? relativePathValue.trim().slice(0, 1_000)
        : undefined;

    const formVaultId = form.get("vaultId");
    let vaultId: string | undefined;
    if (typeof formVaultId === "string" && formVaultId.trim()) {
      if (!vaultOwnedBy(formVaultId, principal.handle)) {
        return NextResponse.json(
          { error: "Vault not found or not owned by you" },
          { status: 403 },
        );
      }
      vaultId = formVaultId;
    }

    const bytes = await file.arrayBuffer();
    const jobId = crypto.randomUUID();
    await createIngestJob({
      jobId,
      owner: principal.handle,
      title: options.title ?? file.name,
    });
    const key = await stageBytes(jobId, file.name, `document.${format}`, bytes);
    return await enqueueOrInline(
      jobId,
      {
        kind: "ingest",
        owner: principal.handle,
        author: principal.handle,
        triggeredBy: principal.handle,
        ...(options.title ? { title: options.title } : {}),
        ...(options.tags?.length ? { tags: options.tags } : {}),
        ...(vaultId ? { vaultId } : {}),
        jobId,
        staged: {
          key,
          kind: "document",
          filename: file.name,
          ...(file.type ? { contentType: file.type } : {}),
          ...(relativePath ? { relativePath } : {}),
        },
      },
      async () => {
        const result = await ingestDocument(
          {
            bytes,
            filename: file.name,
            contentType: file.type,
            ...(relativePath ? { relativePath } : {}),
          },
          options,
        );
        if (vaultId) {
          try { await addToVault(vaultId, result.primarySlug); }
          catch (error) { logger.warn("ingest", `vault filing failed: ${(error as Error).message}`); }
        }
        return result;
      },
    );
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
    const message = getErrorMessage(error);
    if (error instanceof ClientInputError) {
      logger.warn("ingest", `document ingest rejected: ${message}`);
      return NextResponse.json({ error: message }, { status: 400 });
    }
    logger.error("ingest", "document ingest error", error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
