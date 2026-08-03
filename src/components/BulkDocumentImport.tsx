"use client";

import Link from "next/link";
import {
  useEffect,
  useRef,
  useState,
  type DragEvent,
} from "react";
import { Alert } from "@/components/Alert";
import { Icon } from "@/components/folio/icons";
import {
  BULK_DOCUMENT_UPLOAD_CONCURRENCY,
  MAX_BULK_DOCUMENTS,
  documentExtension,
  documentFileKey,
  formatDocumentBytes,
  runWithConcurrency,
  selectBulkDocuments,
} from "@/lib/bulk-document-import";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { commonsPath } from "@/lib/links";
import { rememberRecentJob } from "@/lib/recent-ingests";

const ACCEPTED_DOCUMENTS =
  ".md,.markdown,.txt,.html,.htm,.pdf,.docx,.pptx,.xlsx,.csv,.zip,text/markdown,text/plain,text/html,application/pdf,application/zip,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.presentationml.presentation,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv";
const MAX_POLL_ATTEMPTS = 100;

type ImportStatus =
  | "ready"
  | "uploading"
  | "queued"
  | "processing"
  | "done"
  | "failed";

interface ImportItem {
  id: string;
  file: File;
  status: ImportStatus;
  jobId?: string;
  slug?: string;
  error?: string;
  pollAttempts: number;
}

interface JobResponse {
  queued?: boolean;
  jobId?: string;
  status?: "queued" | "processing" | "done" | "failed";
  slug?: string;
  error?: string;
}

interface BulkDocumentImportProps {
  vaultId: string | null;
}

function statusLabel(status: ImportStatus): string {
  switch (status) {
    case "ready":
      return "ready";
    case "uploading":
      return "uploading";
    case "queued":
      return "queued";
    case "processing":
      return "synthesizing";
    case "done":
      return "complete";
    case "failed":
      return "needs attention";
  }
}

function statusColor(status: ImportStatus): string {
  if (status === "failed") return "var(--rust)";
  if (status === "done") return "var(--accent)";
  if (status === "uploading" || status === "queued" || status === "processing") {
    return "var(--ink-2)";
  }
  return "var(--muted)";
}

export function BulkDocumentImport({ vaultId }: BulkDocumentImportProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const folderInputRef = useRef<HTMLInputElement>(null);
  const dragDepthRef = useRef(0);
  const latestItemsRef = useRef<ImportItem[]>([]);
  const [items, setItems] = useState<ImportItem[]>([]);
  const [dragActive, setDragActive] = useState(false);
  const [uploadingBatch, setUploadingBatch] = useState(false);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [singleTitle, setSingleTitle] = useState("");

  useEffect(() => {
    folderInputRef.current?.setAttribute("webkitdirectory", "");
    folderInputRef.current?.setAttribute("directory", "");
  }, []);

  const readyItems = items.filter((item) => item.status === "ready");
  const failedItems = items.filter((item) => item.status === "failed");
  const doneCount = items.filter((item) => item.status === "done").length;
  const activeCount = items.filter((item) =>
    item.status === "uploading" || item.status === "queued" || item.status === "processing"
  ).length;
  const settledCount = doneCount + failedItems.length;
  const progress = items.length > 0 ? Math.round((settledCount / items.length) * 100) : 0;
  latestItemsRef.current = items;
  const pollingSignature = items
    .filter((item) =>
      (item.status === "queued" || item.status === "processing") && item.jobId,
    )
    .map((item) => `${item.id}:${item.jobId}:${item.pollAttempts}`)
    .join("|");

  function updateItem(id: string, patch: Partial<ImportItem>) {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }

  function addFiles(files: readonly File[]) {
    if (files.length === 0) return;
    setSelectionError(null);
    const selection = selectBulkDocuments(files, items.map((item) => item.file));

    if (selection.accepted.length > 0) {
      setItems((current) => [
        ...current,
        ...selection.accepted.map((file) => ({
          id: documentFileKey(file),
          file,
          status: "ready" as const,
          pollAttempts: 0,
        })),
      ]);
      if (items.length + selection.accepted.length !== 1) setSingleTitle("");
    }

    if (selection.rejected.length > 0) {
      const visible = selection.rejected
        .slice(0, 3)
        .map(({ file, reason }) => `${file.name}: ${reason}`)
        .join(" ");
      const remainder = selection.rejected.length - 3;
      setSelectionError(`${visible}${remainder > 0 ? ` ${remainder} more file${remainder === 1 ? " was" : "s were"} not added.` : ""}`);
    }
  }

  function handleDrop(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepthRef.current = 0;
    setDragActive(false);
    addFiles(Array.from(event.dataTransfer.files));
  }

  function handleDragEnter(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepthRef.current += 1;
    setDragActive(true);
  }

  function handleDragLeave(event: DragEvent<HTMLButtonElement>) {
    event.preventDefault();
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDragActive(false);
  }

  async function uploadItem(item: ImportItem): Promise<void> {
    updateItem(item.id, {
      status: "uploading",
      error: undefined,
      jobId: undefined,
      slug: undefined,
      pollAttempts: 0,
    });

    try {
      const form = new FormData();
      form.append("file", item.file);
      const relativePath = (item.file as File & { webkitRelativePath?: string })
        .webkitRelativePath;
      if (relativePath) form.append("relativePath", relativePath);
      if (items.length === 1 && singleTitle.trim()) form.append("title", singleTitle.trim());
      if (vaultId) form.append("vaultId", vaultId);

      const response = await fetch("/api/ingest/document", {
        method: "POST",
        body: form,
      });
      const data = (await response.json().catch(() => ({}))) as JobResponse;
      if (!response.ok) {
        throw new Error(data.error || `Upload failed (${response.status}).`);
      }
      if (!data.queued || !data.jobId) {
        throw new Error("The server did not return an ingest job.");
      }

      rememberRecentJob(data.jobId);
      updateItem(item.id, { status: "queued", jobId: data.jobId });
    } catch (error) {
      updateItem(item.id, {
        status: "failed",
        error: error instanceof Error ? error.message : "Upload failed.",
      });
    }
  }

  async function uploadItems(entries: readonly ImportItem[]) {
    if (entries.length === 0 || uploadingBatch) return;
    setUploadingBatch(true);
    setSelectionError(null);
    try {
      await runWithConcurrency(
        entries,
        BULK_DOCUMENT_UPLOAD_CONCURRENCY,
        async (item) => uploadItem(item),
      );
    } finally {
      setUploadingBatch(false);
    }
  }

  useEffect(() => {
    if (!pollingSignature) return;
    const pollingItems = latestItemsRef.current.filter(
      (item) =>
        (item.status === "queued" || item.status === "processing") && item.jobId,
    );
    let cancelled = false;

    const timer = window.setTimeout(async () => {
      const results = await Promise.all(
        pollingItems.map(async (item) => {
          try {
            const response = await fetch(`/api/ingest/status/${item.jobId}`);
            const data = (await response.json().catch(() => ({}))) as JobResponse;
            if (!response.ok) {
              return {
                id: item.id,
                status: "failed" as const,
                error: data.error || "The ingest job could not be found.",
              };
            }
            if (data.status === "done" && data.slug) {
              return { id: item.id, status: "done" as const, slug: data.slug };
            }
            if (data.status === "failed") {
              return {
                id: item.id,
                status: "failed" as const,
                error: data.error || "Ingestion failed.",
              };
            }
            const attempts = item.pollAttempts + 1;
            if (attempts >= MAX_POLL_ATTEMPTS) {
              return {
                id: item.id,
                status: "failed" as const,
                error: "Status checks timed out. Check Recent ingests before retrying.",
              };
            }
            return {
              id: item.id,
              status: data.status === "processing" ? "processing" as const : "queued" as const,
              pollAttempts: attempts,
            };
          } catch {
            const attempts = item.pollAttempts + 1;
            if (attempts >= MAX_POLL_ATTEMPTS) {
              return {
                id: item.id,
                status: "failed" as const,
                error: "Status checks timed out. Check Recent ingests before retrying.",
              };
            }
            return { id: item.id, pollAttempts: attempts };
          }
        }),
      );

      if (cancelled) return;
      const resultById = new Map(results.map((result) => [result.id, result]));
      setItems((current) =>
        current.map((item) => {
          const result = resultById.get(item.id);
          return result ? { ...item, ...result } : item;
        }),
      );
    }, 2500);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [pollingSignature]);

  function removeItem(id: string) {
    setItems((current) => current.filter((item) => item.id !== id));
    setSelectionError(null);
    setSingleTitle("");
  }

  function resetManifest() {
    setItems([]);
    setSelectionError(null);
    setSingleTitle("");
    if (inputRef.current) inputRef.current.value = "";
    if (folderInputRef.current) folderInputRef.current.value = "";
  }

  const canEditManifest = activeCount === 0 && !uploadingBatch;

  return (
    <section aria-labelledby="bulk-document-heading" className="space-y-5">
      <div>
        <h2 id="bulk-document-heading" style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>
          Import documents
        </h2>
        <p style={{ margin: "5px 0 0", color: "var(--muted)", fontSize: 13.5 }}>
          Add one file or a working set. Each document becomes its own traceable page.
        </p>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_DOCUMENTS}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        className="sr-only"
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        accept={ACCEPTED_DOCUMENTS}
        onChange={(event) => {
          addFiles(Array.from(event.target.files ?? []));
          event.target.value = "";
        }}
        className="sr-only"
      />
      <button
        type="button"
        aria-label="Choose documents to import"
        aria-describedby="bulk-document-limits"
        onClick={() => inputRef.current?.click()}
        onDragEnter={handleDragEnter}
        onDragOver={(event) => event.preventDefault()}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        style={{
          border: `1px ${dragActive ? "solid" : "dashed"} ${dragActive ? "var(--accent)" : "var(--rule-strong)"}`,
          borderRadius: 16,
          background: dragActive
            ? "color-mix(in srgb, var(--accent) 8%, var(--paper-2))"
            : "var(--paper-2)",
          minHeight: 166,
          width: "100%",
          display: "grid",
          placeItems: "center",
          padding: "30px 24px",
          cursor: "pointer",
          color: "var(--ink)",
          fontFamily: "var(--font-read)",
          transition: "border-color 160ms ease, background 160ms ease, transform 160ms ease",
          transform: dragActive ? "translateY(-2px)" : "none",
        }}
      >
        <div style={{ textAlign: "center", pointerEvents: "none" }}>
          <span
            aria-hidden
            style={{
              width: 42,
              height: 42,
              margin: "0 auto 13px",
              border: "1px solid var(--rule-strong)",
              borderRadius: 999,
              display: "grid",
              placeItems: "center",
              color: dragActive ? "var(--accent)" : "var(--ink-2)",
              background: "var(--paper)",
            }}
          >
            <Icon.plus width="18" height="18" />
          </span>
          <p style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>
            {dragActive ? "Release to add files" : "Drop documents here"}
          </p>
          <p style={{ margin: "6px 0 0", color: "var(--muted)", fontSize: 13 }}>
            or click to browse · notes, documents, PDFs, and ZIP exports
          </p>
          <p id="bulk-document-limits" className="receipt" style={{ margin: "10px 0 0", color: "var(--faint)", fontSize: 10.5 }}>
            up to {MAX_BULK_DOCUMENTS} files · {MAX_DOCUMENT_SIZE / 1024 / 1024} MB each
          </p>
        </div>
      </button>

      <div className="spread" style={{ gap: 12, alignItems: "center" }}>
        <p style={{ margin: 0, color: "var(--muted)", fontSize: 12.5 }}>
          Importing an Obsidian vault? Folder paths and Markdown links are preserved.
        </p>
        <button
          type="button"
          className="btn ghost"
          onClick={() => folderInputRef.current?.click()}
          disabled={!canEditManifest}
          style={{ whiteSpace: "nowrap" }}
        >
          Choose folder
        </button>
      </div>

      {selectionError && <Alert variant="error">{selectionError}</Alert>}

      {items.length === 1 && items[0].status === "ready" && (
        <div>
          <label htmlFor="documentTitle" className="block text-sm font-medium mb-2">
            Title <span className="text-foreground/40">(optional)</span>
          </label>
          <input
            id="documentTitle"
            type="text"
            value={singleTitle}
            onChange={(event) => setSingleTitle(event.target.value)}
            placeholder="Defaults to the document title or filename"
            className="w-full rounded-lg border border-foreground/20 bg-transparent px-4 py-2.5 text-sm placeholder:text-foreground/40 focus:border-foreground/50 focus:outline-none transition-colors"
          />
        </div>
      )}

      {items.length > 0 && (
        <div
          style={{
            border: "1px solid var(--rule)",
            borderRadius: 14,
            overflow: "hidden",
            background: "var(--paper)",
          }}
        >
          <div
            className="spread"
            style={{
              gap: 16,
              padding: "12px 14px",
              borderBottom: "1px solid var(--rule)",
              background: "var(--paper-2)",
            }}
          >
            <span className="fmark">Import manifest</span>
            <span className="receipt" style={{ fontSize: 10.5, color: "var(--muted)" }}>
              {doneCount}/{items.length} complete
            </span>
          </div>
          <div
            role="progressbar"
            aria-label="Bulk import progress"
            aria-valuemin={0}
            aria-valuemax={items.length}
            aria-valuenow={settledCount}
            style={{ height: 2, background: "var(--rule)" }}
          >
            <div
              style={{
                width: `${progress}%`,
                height: "100%",
                background: failedItems.length > 0 && activeCount === 0 ? "var(--rust)" : "var(--accent)",
                transition: "width 240ms ease",
              }}
            />
          </div>
          <ul style={{ listStyle: "none", margin: 0, padding: 0 }}>
            {items.map((item, index) => {
              const mutable = canEditManifest && (item.status === "ready" || item.status === "failed");
              return (
                <li
                  key={item.id}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "48px minmax(0, 1fr) auto",
                    gap: 12,
                    alignItems: "center",
                    padding: "13px 14px",
                    borderTop: index === 0 ? 0 : "1px solid var(--rule)",
                  }}
                >
                  <span
                    className="receipt"
                    style={{
                      fontSize: 9.5,
                      textTransform: "uppercase",
                      letterSpacing: "0.08em",
                      color: "var(--ink-2)",
                      border: "1px solid var(--rule-strong)",
                      borderRadius: 5,
                      padding: "4px 5px",
                      textAlign: "center",
                      background: "var(--paper-2)",
                    }}
                  >
                    {documentExtension(item.file.name)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <p
                      title={item.file.name}
                      style={{
                        margin: 0,
                        fontSize: 13.5,
                        color: "var(--ink)",
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {(item.file as File & { webkitRelativePath?: string }).webkitRelativePath || item.file.name}
                    </p>
                    <div className="row" style={{ gap: 8, marginTop: 3, flexWrap: "wrap" }}>
                      <span className="receipt" style={{ fontSize: 10.5, color: "var(--faint)" }}>
                        {formatDocumentBytes(item.file.size)}
                      </span>
                      <span className="receipt" style={{ fontSize: 10.5, color: statusColor(item.status) }}>
                        {statusLabel(item.status)}
                      </span>
                      {item.status === "done" && item.slug && (
                        <Link
                          href={commonsPath(item.slug)}
                          style={{ fontSize: 11.5, color: "var(--accent)" }}
                        >
                          Open page →
                        </Link>
                      )}
                    </div>
                    {item.error && (
                      <p style={{ margin: "5px 0 0", fontSize: 11.5, color: "var(--rust)", lineHeight: 1.4 }}>
                        {item.error}
                      </p>
                    )}
                  </div>
                  <div className="row" style={{ gap: 5 }}>
                    {item.status === "failed" && canEditManifest && (
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 11.5, padding: "5px 8px" }}
                        onClick={() => void uploadItems([item])}
                      >
                        Retry
                      </button>
                    )}
                    {mutable && (
                      <button
                        type="button"
                        className="btn ghost"
                        style={{ fontSize: 11.5, padding: "5px 8px", color: "var(--muted)" }}
                        onClick={() => removeItem(item.id)}
                        aria-label={`Remove ${item.file.name}`}
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {items.length > 0 && (
        <div className="row" style={{ gap: 10, flexWrap: "wrap" }}>
          {readyItems.length > 0 && (
            <button
              type="button"
              className="btn primary disabled:opacity-50"
              disabled={uploadingBatch || activeCount > 0}
              onClick={() => void uploadItems(readyItems)}
            >
              {uploadingBatch
                ? "Uploading…"
                : `Import ${readyItems.length} ${readyItems.length === 1 ? "document" : "documents"}`}
              {!uploadingBatch && <Icon.arrow width="16" height="16" />}
            </button>
          )}
          {failedItems.length > 1 && canEditManifest && (
            <button type="button" className="btn" onClick={() => void uploadItems(failedItems)}>
              Retry failed
            </button>
          )}
          {settledCount === items.length && items.length > 0 && (
            <button type="button" className="btn ghost" onClick={resetManifest}>
              Import another set
            </button>
          )}
          {activeCount > 0 && (
            <span className="receipt" aria-live="polite" style={{ fontSize: 11.5, color: "var(--muted)" }}>
              {activeCount} {activeCount === 1 ? "file" : "files"} in progress
            </span>
          )}
        </div>
      )}
    </section>
  );
}
