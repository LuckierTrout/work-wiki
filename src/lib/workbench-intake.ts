/**
 * Workbench Intake's door policy: what a file pick, a shell drop or an in-app
 * URL is allowed to bring in, what the refusal says, and what the stored key is
 * called.
 *
 * THREE CLASSES OF ARRIVAL, and the difference between them is the whole point
 * of the tables below:
 *
 *   - TEXT (`md` / `txt` / `html`, and the in-app URL) is stored and compiled
 *     immediately. It never touches the sidecar.
 *   - EXTRACT (PDF, DOCX, PPTX, XLSX/XLS/ODS, EPUB/MOBI) is stored as bytes and
 *     parked behind an extract job the sidecar claims (Story 7.1). The door
 *     accepts it even when the sidecar is down — the bytes are the Source, and
 *     failing the arrival would lose them to save an error message.
 *   - MEDIA (browser-renderable images, audio, video) is stored as bytes for
 *     Preview. There is no crate that turns a JPEG into prose, so it queues no
 *     extract job and compiles nothing; it is visible in Files and playable in
 *     Preview, which is what Story 7.7 asks of it.
 *
 * Epic 2 shipped this module as a NARROWER door than the vault's
 * `/api/ingest/document`, refusing every binary on the grounds that no
 * extractor existed. Epic 7 builds the extractor, so the refusal it was
 * standing in for is gone — but the door is still not the vault's: `csv`,
 * `zip`, `odt`, `odp`, `org` and `rtf` stay out because no sidecar crate reads
 * them, and letting them in would store bytes nothing can ever compile.
 *
 * Pure and client-safe on purpose — no storage, no `node:` imports — so the
 * picker in the browser and the route on the server classify with the same
 * function, and the node suite executes it. A route-side allowlist with a
 * hand-copied `accept` attribute beside it is exactly the drift DW-246 records.
 */

import {
  DOCUMENT_FORMAT_LABELS,
  detectDocumentFormat,
  extension,
  ownLookup,
} from "./document-formats";
import { slugify } from "./slugify";
import { WORKBENCH_FILE_MAX_DEPTH } from "./workbench-tree";

// ---------------------------------------------------------------------------
// What may come in
// ---------------------------------------------------------------------------

/** Stored as text and compiled on arrival. No sidecar involvement. */
export type IntakeTextFormat = "md" | "txt" | "html";

/** Stored as bytes; a sidecar extract job stands between them and Ingest. */
export type IntakeExtractFormat =
  | "pdf"
  | "docx"
  | "pptx"
  | "xlsx"
  | "xls"
  | "ods"
  | "epub"
  | "mobi";

/** Stored as bytes for Preview. Nothing extracts prose from them in v1. */
export type IntakeMediaFormat = "image" | "video" | "audio";

export type IntakeFormat =
  | IntakeTextFormat
  | IntakeExtractFormat
  | IntakeMediaFormat;

/** Filename extensions the TEXT door accepts, and the format each one names. */
export const INTAKE_TEXT_EXTENSIONS: Record<string, IntakeTextFormat> = {
  md: "md",
  markdown: "md",
  mdown: "md",
  txt: "txt",
  text: "txt",
  html: "html",
  htm: "html",
};

/**
 * Extensions the sidecar's Rust crate can read, and the format each names.
 *
 * DERIVED FROM THE CRATE, not from the vault's table: `pdf-extract`,
 * `docx-rs`, `calamine` (XLSX/XLS/ODS), the PPTX ZIP+XML pass and the ebook
 * pass are exactly these eight. Adding a ninth here without a matching arm in
 * `sidecar/extract` stores bytes that will always fail extract.
 */
export const INTAKE_EXTRACT_EXTENSIONS: Record<string, IntakeExtractFormat> = {
  pdf: "pdf",
  docx: "docx",
  pptx: "pptx",
  xlsx: "xlsx",
  xls: "xls",
  ods: "ods",
  epub: "epub",
  mobi: "mobi",
};

/**
 * Media extensions Preview can render or play in-pane.
 *
 * SVG is deliberately in the image list and deliberately never inlined: the
 * Preview shows it through an `<img>`, which does not execute script in the
 * document, and `raw/sources` bytes are served through the authenticated asset
 * door rather than as a same-origin document.
 */
export const INTAKE_MEDIA_EXTENSIONS: Record<string, IntakeMediaFormat> = {
  png: "image",
  jpg: "image",
  jpeg: "image",
  gif: "image",
  webp: "image",
  svg: "image",
  avif: "image",
  mp4: "video",
  webm: "video",
  mov: "video",
  m4v: "video",
  mp3: "audio",
  m4a: "audio",
  wav: "audio",
  ogg: "audio",
  flac: "audio",
};

/** Every extension this door accepts, and the format each one names. */
export const INTAKE_EXTENSIONS: Record<string, IntakeFormat> = {
  ...INTAKE_TEXT_EXTENSIONS,
  ...INTAKE_EXTRACT_EXTENSIONS,
  ...INTAKE_MEDIA_EXTENSIONS,
};

/** Content types this door accepts, and the format each one names. */
export const INTAKE_MIME_TYPES: Record<string, IntakeFormat> = {
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "text/html": "html",
  "application/xhtml+xml": "html",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.oasis.opendocument.spreadsheet": "ods",
  "application/epub+zip": "epub",
  "application/x-mobipocket-ebook": "mobi",
  "image/png": "image",
  "image/jpeg": "image",
  "image/gif": "image",
  "image/webp": "image",
  "image/svg+xml": "image",
  "image/avif": "image",
  "video/mp4": "video",
  "video/webm": "video",
  "video/quicktime": "video",
  "audio/mpeg": "audio",
  "audio/mp4": "audio",
  "audio/wav": "audio",
  "audio/ogg": "audio",
  "audio/flac": "audio",
};

/**
 * The accepted-format grid Settings → Intake renders (Story 7.5).
 *
 * DERIVED from the three tables above rather than typed beside them. A
 * hand-written list on the Settings pane would be a second inventory of what
 * this door accepts — it would drift the first time a format was added, and it
 * would drift in the worst direction: an owner reading a format the door
 * refuses, or not reading one it takes. Only the GROUP LABELS are prose here,
 * and each one names a class of arrival rather than restating its members.
 *
 * Extensions are de-duplicated by FORMAT-preserving order, not collapsed: `md`
 * and `markdown` are both really accepted, and hiding the alias would tell an
 * owner their file will be refused when it will not.
 */
export const INTAKE_FORMAT_GROUPS: readonly {
  label: string;
  extensions: readonly string[];
}[] = [
  { label: "Text", extensions: Object.keys(INTAKE_TEXT_EXTENSIONS) },
  { label: "Documents", extensions: Object.keys(INTAKE_EXTRACT_EXTENSIONS) },
  {
    label: "Images",
    extensions: Object.keys(INTAKE_MEDIA_EXTENSIONS).filter(
      (ext) => INTAKE_MEDIA_EXTENSIONS[ext] === "image",
    ),
  },
  {
    label: "Audio and video",
    extensions: Object.keys(INTAKE_MEDIA_EXTENSIONS).filter(
      (ext) => INTAKE_MEDIA_EXTENSIONS[ext] !== "image",
    ),
  },
];

/**
 * What `Content-Type` a media Source is served back with (Story 7.7).
 *
 * A SEPARATE table from {@link INTAKE_MIME_TYPES} and not derivable from it:
 * that one maps a content type to the FORMAT class it names, and the mapping is
 * many-to-one in exactly the direction that matters here — `jpg` and `jpeg`
 * both mean `image`, but inverting `image` gives no way back to `image/jpeg`.
 * Serving the class instead of the type would put `Content-Type: image` on the
 * wire, which no browser renders.
 *
 * Membership is still checked against {@link INTAKE_MEDIA_EXTENSIONS} by the
 * caller, so this table only ever answers for an extension that table admits.
 * Anything unrecognised falls back to the octet-stream default rather than to a
 * guess, so a wrong label is a download rather than a mis-decode.
 */
const MEDIA_CONTENT_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  avif: "image/avif",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
  m4v: "video/mp4",
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  wav: "audio/wav",
  ogg: "audio/ogg",
  flac: "audio/flac",
};

export function intakeMediaContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return MEDIA_CONTENT_TYPES[ext] ?? "application/octet-stream";
}

/**
 * The NON-media half of the same answer: what a text or document Source is
 * served back as.
 *
 * Split from {@link MEDIA_CONTENT_TYPES} rather than merged into it because
 * that table has a caller contract — {@link intakeMediaContentType} answers
 * only for extensions {@link INTAKE_MEDIA_EXTENSIONS} admits, and the media
 * door checks membership before asking. Widening it in place would start
 * answering `application/pdf` on a door that must refuse PDFs.
 *
 * The spellings are lifted from {@link INTAKE_MIME_TYPES} — the door's own
 * statement of what each format is called on the wire — but they cannot be
 * DERIVED from it: that map is many-to-one (`text/markdown` and
 * `text/x-markdown` both mean `md`), so inverting it would have to pick a
 * winner arbitrarily. The pairs below are the canonical direction of that same
 * table, and `workbench-intake.test.ts` pins that every key of
 * {@link INTAKE_EXTENSIONS} resolves to something, so an extension added to
 * the door without a type here fails a test rather than silently downloading.
 */
const SOURCE_CONTENT_TYPES: Record<string, string> = {
  md: "text/markdown",
  markdown: "text/markdown",
  mdown: "text/markdown",
  txt: "text/plain",
  text: "text/plain",
  html: "text/html",
  htm: "text/html",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  epub: "application/epub+zip",
  mobi: "application/x-mobipocket-ebook",
};

/**
 * What `Content-Type` ANY stored arrival is served as, media or not.
 *
 * The whole-door answer {@link intakeMediaContentType} deliberately is not:
 * `listRawSourceSnapshots` describes every stored artefact under
 * `raw/sources/<slug>/`, binaries and Markdown alike (DW-569), and needs a
 * real type for each without minting a third MIME inventory in `raw.ts`.
 *
 * Media is consulted FIRST so the extensions both tables could claim keep the
 * answer the media door already gives (there is no overlap today; the order
 * makes that fact a rule rather than a coincidence). Anything neither table
 * knows is `application/octet-stream` — a download rather than a mis-decode,
 * the same fallback and the same reasoning as the media resolver.
 *
 * Both lookups go through {@link ownLookup} (DW-365). {@link
 * intakeMediaContentType} can index bare because its caller has already checked
 * membership in {@link INTAKE_MEDIA_EXTENSIONS}; this one is the whole-door
 * answer for an ARBITRARY stored filename with no such pre-check, so
 * `thing.constructor` would otherwise be served a `Content-Type` of
 * `function Object() { … }` — an inherited value that `??` does not rescue,
 * because it is neither `null` nor `undefined`.
 */
export function intakeContentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot + 1).toLowerCase() : "";
  return (
    ownLookup(MEDIA_CONTENT_TYPES, ext) ??
    ownLookup(SOURCE_CONTENT_TYPES, ext) ??
    "application/octet-stream"
  );
}

/** Is this arrival stored as a UTF-8 string rather than as bytes? */
export function isIntakeTextFormat(
  format: IntakeFormat,
): format is IntakeTextFormat {
  return format === "md" || format === "txt" || format === "html";
}

/** Must a sidecar extract job run before this arrival can be compiled? */
export function intakeRequiresExtract(
  format: IntakeFormat,
): format is IntakeExtractFormat {
  return Object.prototype.hasOwnProperty.call(
    INTAKE_EXTRACT_FORMAT_SET,
    format,
  );
}

const INTAKE_EXTRACT_FORMAT_SET: Record<string, true> = Object.fromEntries(
  Object.values(INTAKE_EXTRACT_EXTENSIONS).map((format) => [format, true]),
);

/** Stored for Preview only — no extract job, no compile. */
export function isIntakeMediaFormat(
  format: IntakeFormat,
): format is IntakeMediaFormat {
  return format === "image" || format === "video" || format === "audio";
}

/**
 * The `accept` attribute for the file input, DERIVED from the tables above.
 *
 * Not hand-written: an extension added to `INTAKE_EXTENSIONS` that the picker
 * still greyed out would be refused by the operating system's dialog with no
 * sentence anywhere explaining it.
 */
export const INTAKE_ACCEPT_ATTR: string = [
  ...Object.keys(INTAKE_EXTENSIONS).map((ext) => `.${ext}`),
  ...Object.keys(INTAKE_MIME_TYPES),
].join(",");

/**
 * The content types the in-app URL door lets `fetchUrlContent` proceed on.
 *
 * `ALLOWED_CONTENT_TYPES` in `fetch.ts` includes `application/pdf` and routes it
 * into `unpdf` extraction. On THIS door a PDF must fail (see the module note),
 * so the narrower list is passed in rather than the module default. `text/xml`
 * and `application/xml` are left out too: they would take the Readability path
 * as if they were articles.
 */
export const INTAKE_ALLOWED_CONTENT_TYPES: readonly string[] = [
  "text/html",
  "application/xhtml+xml",
  "text/plain",
  "text/markdown",
];

// ---------------------------------------------------------------------------
// Copy
// ---------------------------------------------------------------------------

/**
 * The tree-panel and Sources control (UX-DR5), and the only label either
 * surface offers.
 *
 * The retired folder-opening affordance is not merely absent: its exact wording
 * is banned from every source under `src/` by `workbench-left-column.test.ts`,
 * which is why this docblock names neither the phrase nor a paraphrase close
 * enough to be copied back into a button. Folder pick is a second control
 * ({@link INTAKE_FOLDER_LABEL}); nothing here opens a project directory.
 */
export const INTAKE_IMPORT_LABEL = "Import / Upload";

/**
 * The directory picker beside Import / Upload. Never the retired project-folder
 * phrasing — that exact wording is banned from every source under `src/`.
 */
export const INTAKE_FOLDER_LABEL = "Folder";

/**
 * The third pick beside Import / Folder. Same allowlist, not a directory
 * picker, and not an OAuth connect — upload is the only Plaud path.
 */
export const INTAKE_PLAUD_LABEL = "Plaud";

/** The in-app URL field's real label — never placeholder-only (a11y floor). */
export const INTAKE_URL_FIELD_LABEL = "Source URL";

/** The one primary beside the URL field. */
export const INTAKE_URL_SUBMIT_LABEL = "Add URL";

export const INTAKE_URL_PLACEHOLDER = "https://";

/** Shown while an arrival is being stored and queued. */
export const INTAKE_BUSY_COPY = "Storing…";

/**
 * A second drop arrived while the first batch was still posting.
 *
 * The controls are disabled while `intakeBusy` is set, but a DROP has no
 * disabled state — the platform delivers it whatever the shell renders — and in
 * a mode with no visible Intake control there is nothing dimmed to look at
 * either. Silently ignoring it is indistinguishable from losing the file, which
 * is the one thing this door must never be, so the refusal gets its own
 * sentence rather than borrowing {@link INTAKE_BUSY_COPY} (which reads as if the
 * dropped files had been accepted).
 */
export const INTAKE_IN_FLIGHT_COPY =
  "Still storing the last batch. Try again once it finishes.";

/**
 * The shell's drop affordance, shown while a file drag is over the Workbench.
 *
 * Visual only — the overlay carrying it is `aria-hidden`, because holding files
 * over a window is a state no keyboard or screen-reader user can be in. Their
 * path is the picker, and both paths report through the batch sentence.
 */
export const INTAKE_DROP_COPY =
  "Drop documents, media, or folders to store them.";

/** Nothing was attached to the picker or the drop. */
export const INTAKE_FILE_REQUIRED_COPY = "Attach a document or media file.";

/**
 * A directory picker or folder drop expanded to no files.
 *
 * Browsers omit empty directories, so this is the whole of what the Folder
 * action can say when nothing storable arrived — no Source is invented for it.
 */
export const INTAKE_FOLDER_COPY = "That folder has no storable files.";

/**
 * A client-supplied relative path was absolute, traversed, empty, or otherwise
 * not a folder location this door will store.
 */
export const INTAKE_BAD_PATH_COPY = "That folder path is not allowed.";

/**
 * The sanitized tree path would sit past {@link WORKBENCH_FILE_MAX_DEPTH}, so
 * Files could not list it. Named so a mixed folder can refuse the deep file
 * and still store its shallower siblings.
 */
export const INTAKE_TOO_DEEP_COPY =
  "That file is nested too deeply to store.";

/** An empty field, or something that is not an absolute http(s) URL. */
export const INTAKE_URL_REQUIRED_COPY = "Enter an http:// or https:// URL.";

/**
 * The fetch or the file carried nothing storable. No Source is invented for it
 * — the arrival fails on the action that started it.
 */
export const INTAKE_EMPTY_SOURCE_COPY = "No text could be stored from that source.";

/** Signed out. The page sends the owner to sign-in; the API answers 401. */
export const INTAKE_SIGN_IN_COPY = "Sign in required.";

/**
 * Beside the dimmed Import control on a read-only deployment.
 *
 * CHARACTER-IDENTICAL to `READ_ONLY_REFUSAL.ingest`, which is what the route
 * answers — but duplicated rather than imported, because `read-only.ts` pulls
 * `./config` (and `process.env`) and this module is in the browser bundle. That
 * is the boundary `read-only-copy-parity.test.ts` documents; the duplication is
 * pinned by test instead (`workbench-intake.test.ts`), so rewording either half
 * turns the next run red.
 */
export const INTAKE_READ_ONLY_COPY =
  "Sources cannot be ingested while this deployment is read-only.";

/**
 * What a refused type is called, as a sentence. The LABEL comes from the vault
 * format table when it recognises the thing (so a PDF is refused as "PDF", not
 * as "that file"), because naming what was refused is what tells the owner
 * whether to convert it or to pick a different file.
 */
export function intakeUnsupportedCopy(label: string): string {
  return `${label} is not a source this wiki can read.`;
}

/**
 * What Activity says when a stored binary could not be extracted because
 * nothing was listening on the sidecar's loopback port.
 *
 * CHARACTER-IDENTICAL to `EXTRACT_SIDECAR_DOWN_COPY` in `./extract-jobs`, which
 * is what the kernel actually writes onto the job — but duplicated rather than
 * imported, because that module reaches `./storage` and this one is in the
 * browser bundle. Same boundary, and the same remedy, as
 * {@link INTAKE_READ_ONLY_COPY}: the duplication is pinned by test, so
 * rewording either half turns the next run red.
 */
export const INTAKE_EXTRACT_UNAVAILABLE_COPY =
  "Extract is unavailable — the sidecar is down.";

/**
 * Beside a stored image, video or audio Source.
 *
 * A media arrival is NOT a failure and must not read as one: the bytes are in
 * the vault and Preview will show or play them. What it is not is a compile,
 * and saying so is what keeps "auto-queue on arrival" from looking broken when
 * no Page appears.
 */
export const INTAKE_MEDIA_STORED_COPY =
  "Stored for Preview. There is no text to compile.";

/** Over the byte cap. `mb` is the cap in whole megabytes. */
export function intakeTooLargeCopy(mb: number): string {
  return `Source too large (max ${mb} MB).`;
}

/** What the owner is told after N arrivals landed. Ingest needs no second click. */
export function intakeStoredCopy(count: number): string {
  return `Stored ${count} ${count === 1 ? "source" : "sources"}. Ingest is queued.`;
}

export const INTAKE_PATH_COLLISION_COPY =
  "A different source already occupies that folder path.";

export function intakeSkippedCopy(count: number): string {
  return `Skipped compile for ${count} ${count === 1 ? "source" : "sources"} (already ingested).`;
}

export function intakeStoredNotQueuedCopy(count: number): string {
  return `Stored ${count} ${count === 1 ? "source" : "sources"}. Ingest was not queued.`;
}

export function intakeRefusedCopy(count: number): string {
  return `Refused ${count} ${count === 1 ? "source" : "sources"}.`;
}

// ---------------------------------------------------------------------------
// Classifying one arrival
// ---------------------------------------------------------------------------

/** Accepted, with the format the door recognised. */
export interface IntakeAccepted {
  ok: true;
  format: IntakeFormat;
}

/** Refused, with the one sentence to put in front of the owner. */
export interface IntakeRejected {
  ok: false;
  reason: string;
}

export type IntakeVerdict = IntakeAccepted | IntakeRejected;

/**
 * What to CALL the thing that arrived, for a refusal sentence.
 *
 * The vault's table names far more formats than this door accepts, which is
 * exactly what makes it the right source for the label: `plan.docx` is refused
 * as "DOCX" and `report.pdf` as "PDF". An extension the vault does not know
 * either is named by its own upper-cased extension, and something with no
 * extension at all falls back to a bare noun.
 */
export function intakeTypeLabel(filename: string, contentType?: string): string {
  const known = detectDocumentFormat(filename, contentType);
  if (known) return DOCUMENT_FORMAT_LABELS[known];
  const ext = extension(filename);
  return ext ? ext.toUpperCase() : "That file";
}

/**
 * May this file be stored as a Source?
 *
 * THE EXTENSION DECIDES whenever there is one. A browser reports
 * `application/octet-stream` for a `.md` file often enough that trusting the
 * type alone would refuse the commonest arrival there is — and the converse is
 * worse: a content type is supplied by whoever built the multipart body, so a
 * `report.pdf` labelled `text/plain` would otherwise be stored as a UTF-8
 * string and handed to Ingest as mojibake instead of being routed to the PDF
 * extractor. An extension the tables do not name is refused even when the type
 * looks fine, which is the safe direction on a door whose whole job is to fail
 * visibly.
 *
 * The content type is consulted only for a name with NO extension at all —
 * a paste, a clipboard drop, a `Save as` with the suffix stripped — where it is
 * the only evidence in the request.
 *
 * Both lookups go through `ownLookup`, so `notes.constructor` cannot inherit a
 * truthy answer off `Object.prototype`.
 */
export function classifyIntakeFile(
  filename: string,
  contentType?: string,
): IntakeVerdict {
  const refused: IntakeVerdict = {
    ok: false,
    reason: intakeUnsupportedCopy(intakeTypeLabel(filename, contentType)),
  };
  const ext = extension(filename);
  if (ext) {
    const byExtension = ownLookup(INTAKE_EXTENSIONS, ext);
    return byExtension ? { ok: true, format: byExtension } : refused;
  }
  const byType = intakeFormatForContentType(contentType);
  return byType ? { ok: true, format: byType } : refused;
}

/** The format a content type names, ignoring any `;charset=` parameters. */
export function intakeFormatForContentType(
  contentType: string | undefined,
): IntakeFormat | null {
  const mime = contentType?.split(";", 1)[0]?.trim().toLowerCase();
  return mime ? ownLookup(INTAKE_MIME_TYPES, mime) : null;
}

/**
 * Is this string an absolute http(s) URL this door will try?
 *
 * Deliberately NOT `isUrl` from `fetch.ts`: that module reaches storage and
 * `unpdf`, so a client component cannot import it. The kernel still validates
 * for real — `validateUrlSafety` inside `fetchUrlContent` is what refuses a
 * private address — and this is only the client's own field check plus the
 * route's cheap pre-flight.
 */
export function isIntakeUrl(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) return false;
  try {
    const url = new URL(trimmed);
    return url.hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Is this drag carrying FILES, rather than text, a link or a tree row?
 *
 * The shell's drop target covers the whole Workbench, so every drag inside it —
 * a selection dragged out of the Preview, a link dragged from another tab — ends
 * over that target. `preventDefault` on a drag that carries no files would claim
 * a drop the shell cannot act on and swallow whatever the browser would have
 * done with it, so the check happens on `dragover` (where the file LIST is not
 * yet readable and `types` is all there is) as well as on the drop.
 *
 * `DataTransfer.types` is an array-like of strings; `"Files"` is the platform's
 * own marker for a file drag and is compared case-insensitively because older
 * engines report `"files"`.
 */
export function intakeDragHasFiles(types: readonly string[] | undefined): boolean {
  return (types ?? []).some((type) => type.toLowerCase() === "files");
}

// ---------------------------------------------------------------------------
// Naming the stored key
// ---------------------------------------------------------------------------

/** When a name slugifies to nothing at all (`"***.md"`, `"---"`). */
export const INTAKE_FALLBACK_SLUG = "source";

/** Storage keys stay short; the hashed id beside it is what makes them unique. */
const MAX_SLUG_CHARS = 80;

function boundedSlug(value: string): string {
  return slugify(value).slice(0, MAX_SLUG_CHARS).replace(/^-+|-+$/g, "");
}

/**
 * The `raw/sources/<slug>/<hash>.md` slug segment for an uploaded or dropped
 * file: its basename, slugified. Any directory part of the reported name is
 * dropped (a drop can report `notes/plan.md`), so the result is always ONE path
 * segment and always passes `validateSlug`.
 *
 * The slug is not an identity — two arrivals named `notes.md` share it — which
 * is why the writer keys on a hash of the bytes as well. That is what lets a
 * Source be immutable without a re-upload of the same name being refused.
 */
export function intakeSourceSlug(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  return boundedSlug(base.replace(/\.[^.]+$/, "")) || INTAKE_FALLBACK_SLUG;
}

/** The same, for a URL: host and last path segment, so the key reads usefully. */
export function intakeUrlSlug(url: string): string {
  let host = "";
  let leaf = "";
  try {
    const parsed = new URL(url.trim());
    host = parsed.hostname;
    leaf = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  } catch {
    // Not parseable — the caller has already refused it; fall through to the
    // fallback rather than throwing from a naming helper.
  }
  return boundedSlug(`${host} ${leaf.replace(/\.[^.]+$/, "")}`) || INTAKE_FALLBACK_SLUG;
}

/** A display title for the queued job: the file's basename without extension. */
export function intakeFileTitle(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  return base.replace(/\.[^.]+$/, "").trim() || base.trim();
}

// ---------------------------------------------------------------------------
// Folder-tree relative paths (Story 2.2)
// ---------------------------------------------------------------------------

/** Accepted, with the sanitized relative path the tree writer will store. */
export interface IntakePathAccepted {
  ok: true;
  path: string;
}

/** Refused, with the one sentence to put in front of the owner. */
export interface IntakePathRejected {
  ok: false;
  reason: string;
}

export type IntakePathVerdict = IntakePathAccepted | IntakePathRejected;

/**
 * Files-tab display path for a sanitized relative tree key.
 *
 * `papers/energy/note.md` → `raw/sources/papers/energy/note.md`.
 */
export function intakeTreeDisplayPath(relativePath: string): string {
  return `raw/sources/${relativePath}`;
}

/**
 * Would Files list this sanitized relative path at the current depth cap?
 *
 * Same numbering as `isListablePath`: `raw/sources/papers/energy/note.md` is
 * five segments. A path past the cap is refused at the door so an arrival
 * cannot land where the walk will never show it.
 */
export function isIntakeTreeListable(relativePath: string): boolean {
  return (
    intakeTreeDisplayPath(relativePath).split("/").length <= WORKBENCH_FILE_MAX_DEPTH
  );
}

/**
 * Sanitize a client-supplied `webkitRelativePath` into the stored tree key.
 *
 * Mirrors the platform field (root folder name included). Rejects `..`,
 * absolute, empty, and null-byte segments rather than normalizing them.
 * Slugifies each directory segment; keeps an allowlisted extension on the
 * leaf. Does not reuse {@link intakeSourceSlug} as the stored key — that
 * helper strips directories on purpose for the 2.1 hash writer.
 */
export function sanitizeIntakeRelativePath(value: string): IntakePathVerdict {
  const refused: IntakePathVerdict = { ok: false, reason: INTAKE_BAD_PATH_COPY };
  if (typeof value !== "string") return refused;
  const trimmed = value.trim();
  if (!trimmed) return refused;
  if (trimmed.includes("\0")) return refused;
  if (trimmed.startsWith("/") || /^[a-zA-Z]:/.test(trimmed)) return refused;

  const segments = trimmed.replace(/\\/g, "/").split("/");
  // A folder location includes the root folder name plus a leaf
  // (`papers/note.md`). A single segment is a loose filename, not a tree.
  if (segments.length < 2) return refused;
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    return refused;
  }

  const leaf = segments[segments.length - 1];
  const dirs = segments.slice(0, -1);
  // TEXT ONLY, narrower than the file door above. The tree writer
  // (`saveRawSourceTree`) takes a string and keys on the sanitized path; a
  // binary has neither a string body nor a stable text identity, so a PDF
  // inside a dropped folder is stored as a loose content-hashed Source
  // instead. The route is what makes that fallback — this refuses the path,
  // not the file.
  const ext = extension(leaf);
  if (!ext || !ownLookup(INTAKE_TEXT_EXTENSIONS, ext)) return refused;

  const slugDirs: string[] = [];
  for (const dir of dirs) {
    const slug = boundedSlug(dir);
    if (!slug) return refused;
    slugDirs.push(slug);
  }

  const leafBase = leaf.replace(/\.[^.]+$/, "");
  const slugLeaf = boundedSlug(leafBase) || INTAKE_FALLBACK_SLUG;
  const path = `${slugDirs.join("/")}/${slugLeaf}.${ext}`;
  if (!isIntakeTreeListable(path)) {
    return { ok: false, reason: INTAKE_TOO_DEEP_COPY };
  }
  return { ok: true, path };
}
