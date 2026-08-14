import { MAX_DOCUMENT_SIZE } from "./constants";

export const MAX_BULK_DOCUMENTS = 200;
export const BULK_DOCUMENT_UPLOAD_CONCURRENCY = 2;

const SUPPORTED_EXTENSIONS = new Set([
  "md",
  "markdown",
  "txt",
  "html",
  "htm",
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  "csv",
  "zip",
]);

export interface RejectedBulkDocument {
  file: File;
  reason: string;
}

export interface BulkDocumentSelection {
  accepted: File[];
  rejected: RejectedBulkDocument[];
}

export function documentFileKey(file: File): string {
  return `${file.name.toLowerCase()}::${file.size}::${file.lastModified}`;
}

export function documentExtension(filename: string): string {
  const extension = filename.split(".").pop()?.toLowerCase() ?? "";
  return SUPPORTED_EXTENSIONS.has(extension) ? extension : "file";
}

export function formatDocumentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validationError(file: File): string | null {
  if (file.size === 0) return "The file is empty.";
  if (documentExtension(file.name) === "file") {
    return "Use Markdown, TXT, HTML, PDF, DOCX, PPTX, XLSX, CSV, or ZIP.";
  }
  if (file.size > MAX_DOCUMENT_SIZE) {
    return `The file is larger than ${MAX_DOCUMENT_SIZE / 1024 / 1024} MB.`;
  }
  return null;
}

/**
 * Validate a newly selected group while preserving the files already shown in
 * the import manifest. Duplicate fingerprints are rejected rather than queued
 * twice, and files beyond the batch cap are reported individually.
 */
export function selectBulkDocuments(
  incoming: readonly File[],
  existing: readonly File[] = [],
): BulkDocumentSelection {
  const accepted: File[] = [];
  const rejected: RejectedBulkDocument[] = [];
  const seen = new Set(existing.map(documentFileKey));
  let available = Math.max(0, MAX_BULK_DOCUMENTS - existing.length);

  for (const file of incoming) {
    const error = validationError(file);
    if (error) {
      rejected.push({ file, reason: error });
      continue;
    }

    const key = documentFileKey(file);
    if (seen.has(key)) {
      rejected.push({ file, reason: "This file is already in the manifest." });
      continue;
    }
    if (available === 0) {
      rejected.push({
        file,
        reason: `A bulk import can contain up to ${MAX_BULK_DOCUMENTS} files.`,
      });
      continue;
    }

    seen.add(key);
    accepted.push(file);
    available -= 1;
  }

  return { accepted, rejected };
}

/** Run a client-side upload queue without opening every request at once. */
export async function runWithConcurrency<T>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  if (items.length === 0) return;
  const width = Math.max(1, Math.min(Math.floor(concurrency), items.length));
  let nextIndex = 0;

  async function run(): Promise<void> {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      await worker(items[index], index);
    }
  }

  await Promise.all(Array.from({ length: width }, () => run()));
}
