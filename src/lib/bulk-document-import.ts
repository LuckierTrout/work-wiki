import { MAX_DOCUMENT_SIZE } from "./constants";
import {
  DOCUMENT_FORMAT_LABELS,
  SUPPORTED_DOCUMENT_EXTENSIONS,
  SUPPORTED_DOCUMENT_MIME_TYPES,
  extension,
} from "./document-formats";

export const MAX_BULK_DOCUMENTS = 200;
export const BULK_DOCUMENT_UPLOAD_CONCURRENCY = 2;

/**
 * The client-side allowlist, derived from the one the server actually enforces.
 *
 * This used to be an eleven-entry literal, and `/api/ingest/document` grew seven
 * formats past it (`odt`, `ods`, `odp`, `epub`, `org`, `rtf`, `mobi`) without it
 * noticing — so dropping `plan.odt` into bulk import was refused here even
 * though POSTing the same file to the endpoint succeeds (DW-246). The tables now
 * live in `./document-formats`, a leaf module with no imports, precisely so this
 * client-bundled file can read them instead of copying them.
 */
const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set(
  SUPPORTED_DOCUMENT_EXTENSIONS,
);

/**
 * The `accept` attribute for the file input and the drop zone, as
 * dot-extensions followed by content types.
 *
 * Lives here rather than in `@/components/BulkDocumentImport` because that
 * component's hand-written copy was the FOURTH restatement of this list, and a
 * too-narrow `accept` hides supported formats behind the browser's file picker
 * filter — a rejection the user never even sees a reason for.
 */
export const ACCEPTED_DOCUMENT_ATTRIBUTE: string = [
  ...SUPPORTED_DOCUMENT_EXTENSIONS.map((ext) => `.${ext}`),
  ...SUPPORTED_DOCUMENT_MIME_TYPES,
].join(",");

/**
 * The rejection sentence, built from `DOCUMENT_FORMAT_LABELS` so it names every
 * supported format and nothing else.
 *
 * Labels, not `SUPPORTED_DOCUMENT_EXTENSIONS`: the extension list also carries
 * the `EXTENSION_ALIASES` keys `markdown` and `htm`, which fold into "Markdown"
 * and "HTML" in prose — the same distinction `prose-inventory-parity.test.ts`
 * draws for the repo's other format sentences.
 */
const SUPPORTED_FORMATS_SENTENCE: string = (() => {
  const labels = Object.values(DOCUMENT_FORMAT_LABELS);
  const last = labels[labels.length - 1];
  return labels.length === 1
    ? `Use ${last}.`
    : `Use ${labels.slice(0, -1).join(", ")}, or ${last}.`;
})();

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

/**
 * The extension this file will be badged by in the manifest, or `"file"` when
 * the server would not accept it.
 *
 * Reads the extension with the extractor's own `extension()` rather than a local
 * `split(".").pop()`. Sharing the format TABLE but not the DETECTION left two
 * live disagreements of exactly the class DW-246 is about: `split(".").pop()`
 * returns the WHOLE NAME when there is no dot, so a file literally named `org`
 * (or `md`, or `csv`) passed here and then 400d at `/api/ingest/document`; and
 * it does not trim, so `"notes.md "` was refused here though the endpoint trims
 * and accepts it.
 *
 * Still the RAW extension, not the resolved format — `notes.markdown` badges
 * "markdown", not "md".
 */
export function documentExtension(filename: string): string {
  const ext = extension(filename);
  return SUPPORTED_EXTENSIONS.has(ext) ? ext : "file";
}

export function formatDocumentBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function validationError(file: File): string | null {
  if (file.size === 0) return "The file is empty.";
  if (documentExtension(file.name) === "file") {
    return SUPPORTED_FORMATS_SENTENCE;
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
