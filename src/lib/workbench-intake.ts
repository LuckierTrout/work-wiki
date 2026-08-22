/**
 * Workbench Intake's door policy: what a file pick, a shell drop or an in-app
 * URL is allowed to bring in, what the refusal says, and what the stored key is
 * called.
 *
 * A NARROWER DOOR than the vault's `/api/ingest/document`. That route accepts
 * DOCX, PPTX, XLSX, PDF, EPUB, MOBI and friends because the kernel can extract
 * them; this one must fail every one of those visibly (Epic 2 runs no sidecar
 * extract — that is Epic 7). So the tables below are a separate, smaller
 * allowlist, and `document-formats.ts` is imported only for the two pure
 * helpers that keep this module from re-deriving a lookup rule (`ownLookup`'s
 * prototype guard) and for the LABEL of whatever was refused. The vault's
 * format table itself is untouched: shrinking it would break the `/ingest`
 * page, email intake and the Worker parity tests.
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

/** The three shapes of text this door stores. Everything else is refused. */
export type IntakeFormat = "md" | "txt" | "html";

/** Filename extensions this door accepts, and the format each one names. */
export const INTAKE_EXTENSIONS: Record<string, IntakeFormat> = {
  md: "md",
  markdown: "md",
  mdown: "md",
  txt: "txt",
  text: "txt",
  html: "html",
  htm: "html",
};

/** Content types this door accepts, and the format each one names. */
export const INTAKE_MIME_TYPES: Record<string, IntakeFormat> = {
  "text/markdown": "md",
  "text/x-markdown": "md",
  "text/plain": "txt",
  "text/html": "html",
  "application/xhtml+xml": "html",
};

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
  "Drop Markdown, text, or HTML files or folders to store them.";

/** Nothing was attached to the picker or the drop. */
export const INTAKE_FILE_REQUIRED_COPY = "Attach a Markdown, text, or HTML file.";

/**
 * A directory picker or folder drop expanded to no files.
 *
 * Browsers omit empty directories, so this is the whole of what the Folder
 * action can say when nothing storable arrived — no Source is invented for it.
 */
export const INTAKE_FOLDER_COPY =
  "That folder has no Markdown, text, or HTML files.";

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
  return `${label} is not a Markdown, text, or HTML source.`;
}

/** Over the byte cap. `mb` is the cap in whole megabytes. */
export function intakeTooLargeCopy(mb: number): string {
  return `Source too large (max ${mb} MB).`;
}

/** What the owner is told after N arrivals landed. Ingest needs no second click. */
export function intakeStoredCopy(count: number): string {
  return `Stored ${count} ${count === 1 ? "source" : "sources"}. Ingest is queued.`;
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
 * `report.pdf` labelled `text/plain` would otherwise walk through the one door
 * that must never accept a PDF. An extension the tables do not name is refused
 * even when the type looks fine, which is the safe direction on a door whose
 * whole job is to fail visibly.
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
  const ext = extension(leaf);
  if (!ext || !ownLookup(INTAKE_EXTENSIONS, ext)) return refused;

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
