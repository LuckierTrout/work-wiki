/**
 * Story 2.1 — Workbench Intake: the door policy, the route behind it, and the
 * browser half that reports what happened.
 *
 * Three layers, in that order:
 *
 *   1. the PURE policy (`workbench-intake.ts`) — what may come in, what the
 *      refusal says, what the stored key is called;
 *   2. the ROUTE (`/api/workbench/intake`) with its collaborators mocked — the
 *      refusal ORDER (401 → 403 → shape → type), that a refused arrival writes
 *      and queues nothing, and that an accepted one stores before it enqueues;
 *   3. the CLIENT (`workbench-intake-client.ts`) with `fetch` stubbed — N files
 *      is N requests and N outcomes, and one refusal does not take its
 *      neighbours down.
 *
 * This file is collected by vitest's `node` project (`environment: "node"`,
 * `*.test.ts`), so nothing here mounts a component: the UI's own invariants
 * (Import / Upload in the tree header, the shell's drop handlers) are pinned by
 * source scan in `workbench-left-column.test.ts`, and
 * every rule that could be executed instead of grepped was put in a module for
 * exactly that reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { ALLOWED_CONTENT_TYPES } from "../fetch";
import { MAX_DOCUMENT_SIZE } from "../constants";
import { READ_ONLY_REFUSAL } from "../read-only";
import {
  INTAKE_ACCEPT_ATTR,
  INTAKE_ALLOWED_CONTENT_TYPES,
  INTAKE_DROP_COPY,
  INTAKE_BAD_PATH_COPY,
  INTAKE_EMPTY_SOURCE_COPY,
  INTAKE_EXTENSIONS,
  INTAKE_FALLBACK_SLUG,
  INTAKE_FILE_REQUIRED_COPY,
  INTAKE_FOLDER_COPY,
  INTAKE_FOLDER_LABEL,
  INTAKE_IMPORT_LABEL,
  INTAKE_PLAUD_LABEL,
  INTAKE_TOO_DEEP_COPY,
  INTAKE_IN_FLIGHT_COPY,
  INTAKE_MIME_TYPES,
  INTAKE_EXTRACT_UNAVAILABLE_COPY,
  INTAKE_READ_ONLY_COPY,
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeDragHasFiles,
  intakeContentType,
  intakeFileTitle,
  intakeSourceSlug,
  intakeStoredCopy,
  intakeUnsupportedCopy,
  intakeUrlSlug,
  isIntakeUrl,
  sanitizeIntakeRelativePath,
} from "../workbench-intake";

const SRC = path.resolve(__dirname, "../..");

// ---------------------------------------------------------------------------
// 1. The door policy
// ---------------------------------------------------------------------------

describe("the intake allowlist", () => {
  it("accepts Markdown, text and HTML by extension", () => {
    for (const [name, format] of [
      ["notes.md", "md"],
      ["NOTES.MARKDOWN", "md"],
      ["log.txt", "txt"],
      ["clip.html", "html"],
      ["clip.htm", "html"],
    ] as const) {
      expect(classifyIntakeFile(name), name).toEqual({ ok: true, format });
    }
  });

  it("accepts by content type when the extension says nothing", () => {
    // A browser reports `application/octet-stream` for a `.md` often enough
    // that the extension has to win — but a name with no extension at all is
    // exactly when the type is the only evidence there is.
    expect(classifyIntakeFile("clipboard", "text/markdown")).toEqual({
      ok: true,
      format: "md",
    });
    expect(classifyIntakeFile("clipboard", "text/html; charset=utf-8")).toEqual({
      ok: true,
      format: "html",
    });
  });

  it("prefers the extension over a wrong content type", () => {
    expect(classifyIntakeFile("notes.md", "application/octet-stream")).toEqual({
      ok: true,
      format: "md",
    });
  });

  it("ACCEPTS every office and ebook type, as extract work (Epic 7)", () => {
    // The Epic 2 pin this replaces asserted the opposite, and it was right for
    // a door that could not extract: with no sidecar, a PDF could only be
    // stored as bytes nobody could read, so refusing it visibly beat taking it
    // silently. Epic 7 built the extract job, so the door's answer changes —
    // and the FORMAT each name resolves to is what the enqueue keys off.
    for (const [name, format] of [
      ["report.pdf", "pdf"],
      ["plan.docx", "docx"],
      ["deck.pptx", "pptx"],
      ["sheet.xlsx", "xlsx"],
      ["sheet.xls", "xls"],
      ["sheet.ods", "ods"],
      ["book.epub", "epub"],
      ["book.mobi", "mobi"],
    ] as const) {
      expect(classifyIntakeFile(name), name).toEqual({ ok: true, format });
    }
  });

  it("accepts browser-renderable media, and still refuses an unknown binary", () => {
    for (const [name, format] of [
      ["shot.png", "image"],
      ["photo.JPEG", "image"],
      ["clip.mp4", "video"],
      ["call.m4a", "audio"],
    ] as const) {
      expect(classifyIntakeFile(name), name).toEqual({ ok: true, format });
    }
    // Widening the door is not the same as opening it: an extension no table
    // names is still refused, whatever content type the multipart body claims.
    expect(classifyIntakeFile("thing.bin", "text/html").ok).toBe(false);
    expect(classifyIntakeFile("thing.xyz").ok).toBe(false);
  });

  it("still prefers the extension over a content type that disagrees", () => {
    // The type is supplied by whoever built the multipart body, so the name
    // wins wherever the two can conflict — that rule outlived the refusal it
    // was originally written to protect.
    expect(classifyIntakeFile("report.pdf", "text/plain")).toEqual({
      ok: true,
      format: "pdf",
    });
    expect(classifyIntakeFile("plan.docx", "text/markdown")).toEqual({
      ok: true,
      format: "docx",
    });
  });

  it("refuses an unknown type by its own extension, and a nameless one plainly", () => {
    expect(classifyIntakeFile("thing.xyz")).toEqual({
      ok: false,
      reason: intakeUnsupportedCopy("XYZ"),
    });
    expect(classifyIntakeFile("thing")).toEqual({
      ok: false,
      reason: intakeUnsupportedCopy("That file"),
    });
  });

  it("cannot inherit an answer off Object.prototype", () => {
    // `ownLookup`'s guard. Without it `notes.constructor` reads a truthy value
    // out of the prototype chain and is accepted as a format.
    expect(classifyIntakeFile("notes.constructor").ok).toBe(false);
    expect(classifyIntakeFile("x", "constructor").ok).toBe(false);
  });

  it("derives the picker's accept attribute from the same tables", () => {
    // Hand-writing it is how an added extension ends up greyed out by the
    // operating system's dialog with no sentence anywhere explaining it.
    for (const ext of Object.keys(INTAKE_EXTENSIONS)) {
      expect(INTAKE_ACCEPT_ATTR).toContain(`.${ext}`);
    }
    for (const mime of Object.keys(INTAKE_MIME_TYPES)) {
      expect(INTAKE_ACCEPT_ATTR).toContain(mime);
    }
    // …and the formats Epic 7 widened it to are IN it, not merely absent from
    // a ban list: an accepted extension the picker does not offer is greyed out
    // by the operating system's dialog with no sentence anywhere saying why.
    for (const offered of [".pdf", ".docx", ".png", ".mp4", "application/pdf"]) {
      expect(INTAKE_ACCEPT_ATTR).toContain(offered);
    }
  });

  it("resolves stored Source extensions to concrete content types", () => {
    expect(intakeContentType("md")).toBe("text/markdown");
    expect(intakeContentType("pdf")).toBe("application/pdf");
    expect(intakeContentType("png")).toBe("image/png");
    expect(intakeContentType("bin")).toBe("application/octet-stream");
  });

  it("has a concrete content type for every accepted extension", () => {
    for (const ext of Object.keys(INTAKE_EXTENSIONS)) {
      expect(intakeContentType(ext), ext).not.toBe(
        "application/octet-stream",
      );
    }
  });

  it("is a NARROWER content-type list than the kernel's own", () => {
    // `fetch.ts`'s default includes `application/pdf` and routes it into
    // extraction. That is right for the vault's callers and wrong here.
    expect(ALLOWED_CONTENT_TYPES).toContain("application/pdf");
    expect(INTAKE_ALLOWED_CONTENT_TYPES).not.toContain("application/pdf");
    // Every type this door does allow is one the kernel already knows how to
    // read — a narrowing, never a widening.
    for (const type of INTAKE_ALLOWED_CONTENT_TYPES) {
      expect(ALLOWED_CONTENT_TYPES).toContain(type);
    }
    // …and HTML survives it, or the whole in-app URL field is pointless.
    expect(INTAKE_ALLOWED_CONTENT_TYPES).toContain("text/html");
  });
});

describe("the URL field's own check", () => {
  it("accepts absolute http(s) URLs and nothing else", () => {
    expect(isIntakeUrl("https://example.com/a")).toBe(true);
    expect(isIntakeUrl("  http://example.com  ")).toBe(true);
    for (const value of [
      "",
      "   ",
      "example.com",
      "ftp://example.com",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "https://",
    ]) {
      expect(isIntakeUrl(value), value).toBe(false);
    }
  });
});

describe("naming the stored key", () => {
  it("reduces a filename to ONE slug segment", () => {
    // A drop can report `notes/plan.md`; the result has to pass `validateSlug`,
    // which rejects a path separator.
    expect(intakeSourceSlug("notes/Plan Draft.md")).toBe("plan-draft");
    expect(intakeSourceSlug("C:\\docs\\Q3 Review.txt")).toBe("q3-review");
    expect(intakeSourceSlug("***.md")).toBe(INTAKE_FALLBACK_SLUG);
    expect(intakeSourceSlug("")).toBe(INTAKE_FALLBACK_SLUG);
    expect(intakeSourceSlug("/")).toBe(INTAKE_FALLBACK_SLUG);
    for (const name of ["notes/plan.md", "a b/c d.md", "***.md", ""]) {
      expect(intakeSourceSlug(name), name).not.toContain("/");
      expect(intakeSourceSlug(name), name).not.toContain("\\");
    }
  });

  it("bounds the slug so a long filename cannot make an unwieldy key", () => {
    const slug = intakeSourceSlug(`${"a".repeat(400)}.md`);
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("names a URL by host and leaf, and never throws on a broken one", () => {
    expect(intakeUrlSlug("https://example.com/posts/why-wikis.html")).toBe(
      "example-com-why-wikis",
    );
    expect(intakeUrlSlug("https://example.com/")).toBe("example-com");
    // A naming helper must not throw: the caller has already refused this.
    expect(intakeUrlSlug("not a url")).toBe(INTAKE_FALLBACK_SLUG);
  });

  it("titles a job by the file's basename", () => {
    expect(intakeFileTitle("notes/Q3 Review.md")).toBe("Q3 Review");
    expect(intakeFileTitle("README")).toBe("README");
  });
});

describe("sanitizing a folder relative path", () => {
  it("keeps the root folder and slugifies each directory segment", () => {
    expect(sanitizeIntakeRelativePath("papers/energy/note.md")).toEqual({
      ok: true,
      path: "papers/energy/note.md",
    });
    expect(sanitizeIntakeRelativePath("Papers/Energy Notes/Q3 Review.md")).toEqual({
      ok: true,
      path: "papers/energy-notes/q3-review.md",
    });
  });

  it("keeps an allowlisted extension on the leaf", () => {
    expect(sanitizeIntakeRelativePath("notes/clip.HTML")).toEqual({
      ok: true,
      path: "notes/clip.html",
    });
    expect(sanitizeIntakeRelativePath("notes/log.markdown")).toEqual({
      ok: true,
      path: "notes/log.markdown",
    });
  });

  it("refuses traversal, absolute, empty, and null-byte segments", () => {
    for (const value of [
      "../../etc/passwd",
      "/etc/passwd",
      "C:\\docs\\note.md",
      "papers//note.md",
      "papers/../note.md",
      "papers/\0/note.md",
      "note.md",
      "",
    ]) {
      expect(sanitizeIntakeRelativePath(value), value).toEqual({
        ok: false,
        reason: INTAKE_BAD_PATH_COPY,
      });
    }
  });

  it("refuses a path that would sit past the listable Files depth", () => {
    // First unlistable shape: raw/sources/a/b/c/file.md is 6 segments; cap is 5.
    expect(sanitizeIntakeRelativePath("a/b/c/file.md")).toEqual({
      ok: false,
      reason: INTAKE_TOO_DEEP_COPY,
    });
    expect(sanitizeIntakeRelativePath("a/b/c/d/file.md")).toEqual({
      ok: false,
      reason: INTAKE_TOO_DEEP_COPY,
    });
    expect(sanitizeIntakeRelativePath("papers/energy/note.md").ok).toBe(true);
  });

  it("normalizes Windows separators and refuses a non-allowlisted leaf", () => {
    expect(sanitizeIntakeRelativePath("papers\\energy\\note.md")).toEqual({
      ok: true,
      path: "papers/energy/note.md",
    });
    expect(sanitizeIntakeRelativePath("papers/note.exe")).toEqual({
      ok: false,
      reason: INTAKE_BAD_PATH_COPY,
    });
  });
});

describe("the drag test", () => {
  it("claims file drags only", () => {
    // The drop target is the whole shell, so a selection dragged out of the
    // Preview and a link dragged in from another tab both pass over it.
    // `preventDefault` on those would swallow behaviour the shell has nothing
    // to do with.
    expect(intakeDragHasFiles(["Files"])).toBe(true);
    expect(intakeDragHasFiles(["files"])).toBe(true);
    expect(intakeDragHasFiles(["text/plain", "Files"])).toBe(true);
    expect(intakeDragHasFiles(["text/uri-list"])).toBe(false);
    expect(intakeDragHasFiles([])).toBe(false);
    expect(intakeDragHasFiles(undefined)).toBe(false);
  });
});

describe("the copy", () => {
  it("says exactly what the route's 403 says", () => {
    // The client constant cannot IMPORT `read-only.ts` (it would drag
    // `./config` and `process.env` into the browser bundle), so the two are
    // duplicated — and this is the seam that stops them drifting, the same one
    // `read-only-copy-parity.test.ts` maintains for every other surface.
    expect(INTAKE_READ_ONLY_COPY).toBe(READ_ONLY_REFUSAL.ingest);
  });

  it("says the sidecar-down sentence identically in all three places", async () => {
    // The spec character-locks this one sentence, and three modules hold it:
    // the KERNEL writes it onto the failed job, the CLIENT door shows it on the
    // drop that just failed closed, and ACTIVITY compares the row against it.
    // The kernel constant cannot be imported by the other two — `extract-jobs`
    // reaches `./storage`, which does not belong in the browser bundle — so the
    // duplication is deliberate and this is the seam that stops it drifting.
    // Imported dynamically so the storage-bound module stays out of this
    // suite's module graph until the one assertion that needs it.
    const { EXTRACT_SIDECAR_DOWN_COPY } = await import("../extract-jobs");
    const { ACTIVITY_EXTRACT_UNAVAILABLE_COPY } = await import("../workbench-activity");
    expect(INTAKE_EXTRACT_UNAVAILABLE_COPY).toBe(EXTRACT_SIDECAR_DOWN_COPY);
    expect(ACTIVITY_EXTRACT_UNAVAILABLE_COPY).toBe(EXTRACT_SIDECAR_DOWN_COPY);
    // It names the half of the system the owner has to go and fix. A reword
    // that dropped "sidecar" would leave them with nothing to act on.
    expect(EXTRACT_SIDECAR_DOWN_COPY).toBe(
      "Extract is unavailable — the sidecar is down.",
    );
  });

  it("counts sources in English, singular and plural", () => {
    expect(intakeStoredCopy(1)).toBe("Stored 1 source. Ingest is queued.");
    expect(intakeStoredCopy(3)).toBe("Stored 3 sources. Ingest is queued.");
  });

  it("promises no second click anywhere in the success sentence", () => {
    // FR-41: arrival compiles by itself. A sentence telling the owner to press
    // Ingest would describe a button that does not exist.
    expect(intakeStoredCopy(1)).toContain("queued");
    expect(intakeStoredCopy(1)).not.toMatch(/click|press|button/i);
  });

  it("reads as sentences, in English, with no emoji", () => {
    for (const sentence of [
      INTAKE_DROP_COPY,
      INTAKE_EMPTY_SOURCE_COPY,
      INTAKE_URL_REQUIRED_COPY,
      INTAKE_READ_ONLY_COPY,
      // Both refusals a DROP can hit, which the controls' disabled state cannot
      // express: the platform delivers a drop whatever the shell renders.
      INTAKE_FOLDER_COPY,
      INTAKE_BAD_PATH_COPY,
      INTAKE_TOO_DEEP_COPY,
      INTAKE_IN_FLIGHT_COPY,
      intakeUnsupportedCopy("PDF"),
      intakeStoredCopy(2),
    ]) {
      expect(sentence).toMatch(/^[A-Z].*\.$/);
      // ASCII only: the project is English-only by policy, and an emoji in
      // chrome is banned by DESIGN.md.
      expect(sentence).toMatch(/^[\x20-\x7E…—]+$/);
    }
    expect(INTAKE_IMPORT_LABEL).toBe("Import / Upload");
    expect(INTAKE_FOLDER_LABEL).toBe("Folder");
    expect(INTAKE_PLAUD_LABEL).toBe("Plaud");
  });
});

// ---------------------------------------------------------------------------
// 2. The route
// ---------------------------------------------------------------------------

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(() => null),
}));
vi.mock("@/lib/config", () => ({ isReadOnly: vi.fn(() => false) }));
vi.mock("@/lib/raw", () => ({
  saveRawSourceFor: vi.fn(async (slug: string, rawId: string) => `raw/sources/${slug}/${rawId}.md`),
  saveRawSourceTree: vi.fn(async (relativePath: string) => ({
    path: `raw/sources/${relativePath}`,
    created: true,
  })),
  // Story 7.1's byte writer: a PDF and a PNG are stored through this one, not
  // through the string writer above.
  saveRawSourceBytes: vi.fn(async (slug: string, digest: string, ext: string) => ({
    path: `raw/sources/${slug}/${digest}.${ext}`,
    created: true,
  })),
  readRawSourceTree: vi.fn(async () => null),
}));
vi.mock("@/lib/extract-dispatch", () => ({
  enqueueExtract: vi.fn(async (input: { slug: string; bytesSha256: string; ext: string }) => ({
    path: `raw/sources/${input.slug}/${input.bytesSha256}.${input.ext}`,
    jobId: "extract-job",
    error: null,
  })),
  rememberExtractMeeting: vi.fn(async () => undefined),
}));
vi.mock("@/lib/fetch", async (importOriginal) => ({
  // The real module for `ALLOWED_CONTENT_TYPES`, which the narrowing case above
  // compares against — only the network call is replaced.
  ...(await importOriginal<typeof import("../fetch")>()),
  fetchUrlContent: vi.fn(),
}));
vi.mock("@/lib/ingest", () => ({
  ingest: vi.fn(async () => ({ slug: "stored" })),
  recordSourceResee: vi.fn(async () => ({ primarySlug: "existing", skipped: true })),
}));
vi.mock("@/lib/ingest-jobs", () => ({ createIngestJob: vi.fn(async () => ({})) }));
vi.mock("@/lib/source-index", () => ({
  resolveContentSha256: vi.fn(async () => null),
  resolveStoredSourcePath: vi.fn(async () => "raw/sources/existing/abc.md"),
}));
vi.mock("@/lib/wiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wiki")>()),
  readWikiPageWithFrontmatter: vi.fn(async () => null),
}));
vi.mock("@/lib/source-sha256", () => ({
  sourceSha256: vi.fn(async () => "ab".repeat(32)),
  // The BYTE digest (Story 7.1): a binary arrival is keyed on the hash of its
  // bytes, not of a string it was never safe to decode into.
  bytesSha256: vi.fn(async () => "cd".repeat(32)),
}));
vi.mock("@/lib/ingest-staging", () => ({
  stageText: vi.fn(async () => "raw/uploads/job/source.md"),
}));
vi.mock("@/lib/ingest-async", () => ({
  enqueueOrInline: vi.fn(
    async (jobId: string) =>
      new Response(JSON.stringify({ queued: true, jobId }), { status: 202 }),
  ),
}));
vi.mock("@/lib/source-meeting", () => ({
  setSourceMeeting: vi.fn(async (path: string) => ({ path, meeting: true })),
}));

import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { fetchUrlContent } from "@/lib/fetch";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob } from "@/lib/ingest-jobs";
import { stageText } from "@/lib/ingest-staging";
import { ingest, recordSourceResee } from "@/lib/ingest";
import { resolveContentSha256 } from "@/lib/source-index";
import { enqueueExtract, rememberExtractMeeting } from "@/lib/extract-dispatch";
import {
  readRawSourceTree,
  saveRawSourceBytes,
  saveRawSourceFor,
  saveRawSourceTree,
} from "@/lib/raw";
import { POST } from "@/app/api/workbench/intake/route";
import { setSourceMeeting } from "@/lib/source-meeting";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedFetchUrl = vi.mocked(fetchUrlContent);
const mockedSave = vi.mocked(saveRawSourceFor);
const mockedSaveTree = vi.mocked(saveRawSourceTree);
const mockedReadTree = vi.mocked(readRawSourceTree);
const mockedIngest = vi.mocked(ingest);
const mockedResee = vi.mocked(recordSourceResee);
const mockedSha = vi.mocked(resolveContentSha256);
const mockedJob = vi.mocked(createIngestJob);
const mockedStage = vi.mocked(stageText);
const mockedEnqueue = vi.mocked(enqueueOrInline);
const mockedSaveBytes = vi.mocked(saveRawSourceBytes);
const mockedExtract = vi.mocked(enqueueExtract);

/** A multipart request carrying one file, as the picker and the drop both send. */
function fileRequest(file?: File, relativePath?: string, origin?: "plaud"): Request {
  const form = new FormData();
  if (file) form.append("file", file);
  if (relativePath) form.append("relativePath", relativePath);
  if (origin) form.append("origin", origin);
  return new Request("http://localhost/api/workbench/intake", {
    method: "POST",
    body: form,
  });
}

/** The in-app URL field's JSON request. */
function urlRequest(body: unknown): Request {
  return new Request("http://localhost/api/workbench/intake", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function post(request: Request): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await POST(request as never);
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

/** Nothing was committed: no Source, no job record, no queue item, no extract. */
function expectNothingCommitted(): void {
  expect(mockedSave).not.toHaveBeenCalled();
  expect(mockedSaveTree).not.toHaveBeenCalled();
  expect(mockedSaveBytes).not.toHaveBeenCalled();
  expect(mockedJob).not.toHaveBeenCalled();
  expect(mockedEnqueue).not.toHaveBeenCalled();
  expect(mockedExtract).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "alice", handle: "alice" } as never);
  mockedReadOnly.mockReturnValue(false);
  mockedSave.mockImplementation(
    async (slug: string, rawId: string) => `raw/sources/${slug}/${rawId}.md`,
  );
  mockedEnqueue.mockImplementation(async (jobId: string) =>
    NextResponse.json({ queued: true, jobId }, { status: 202 }),
  );
  mockedSha.mockResolvedValue(null);
});

describe("POST /api/workbench/intake — who may write", () => {
  it("answers 401 with no session, before touching the body", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const { status } = await post(fileRequest(new File(["hi"], "notes.md")));
    expect(status).toBe(401);
    expectNothingCommitted();
  });

  it("answers 403 on a read-only deployment, before any staging or write", async () => {
    mockedReadOnly.mockReturnValue(true);
    const { status, body } = await post(fileRequest(new File(["hi"], "notes.md")));
    expect(status).toBe(403);
    expect(body.error).toBe(READ_ONLY_REFUSAL.ingest);
    expectNothingCommitted();
  });

  it("refuses read-only for the URL door too", async () => {
    mockedReadOnly.mockReturnValue(true);
    const { status } = await post(urlRequest({ url: "https://example.com/a" }));
    expect(status).toBe(403);
    expect(mockedFetchUrl).not.toHaveBeenCalled();
    expectNothingCommitted();
  });
});

describe("POST /api/workbench/intake — files", () => {
  it("stores the bytes under raw/sources/ and queues one ingest", async () => {
    const { status, body } = await post(
      fileRequest(new File(["# Plan\n\nBody."], "Q3 Plan.md", { type: "text/markdown" })),
    );
    expect(status).toBe(202);
    expect(mockedSave).toHaveBeenCalledTimes(1);
    const [slug, rawId, text, options] = mockedSave.mock.calls[0];
    expect(slug).toBe("q3-plan");
    // A content hash, so two different arrivals cannot collide onto one key.
    expect(rawId).toMatch(/^[a-f0-9]+$/);
    expect(text).toBe("# Plan\n\nBody.");
    // The owner, so the bytes are mirrored into the silo the Workbench lists.
    expect(options).toEqual({ owner: "alice" });
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    // The stored key travels back, on top of the enqueue's own body.
    expect(body.path).toBe(`raw/sources/q3-plan/${rawId}.md`);
    expect(body.queued).toBe(true);
  });

  it("queues the STORED text, not a re-read of the file", async () => {
    await post(fileRequest(new File(["exact bytes"], "notes.md")));
    const task = mockedEnqueue.mock.calls[0][1] as { content?: string };
    expect(task.content).toBe("exact bytes");
  });

  it("stores BEFORE it enqueues, and answers 202 when only the queue failed", async () => {
    // A rejected queue is a PARTIAL success, and the status code says so.
    //
    // Answering 500 here was a real bug with a silent consequence: the client
    // reads a thrown request as a CONFIRMED failure, so `intakeShouldRefresh`
    // stayed false, the trees were never re-polled, and bytes that had already
    // landed — listable in Files, mirrored into the silo — stayed invisible
    // until something unrelated happened to bump `dataVersion`. The Source
    // exists; only the compile has to be re-driven.
    const order: string[] = [];
    mockedSave.mockImplementation(async () => {
      order.push("store");
      return "raw/sources/notes/abc.md";
    });
    mockedEnqueue.mockImplementation(async () => {
      order.push("enqueue");
      throw new Error("queue unavailable");
    });

    const { status, body } = await post(fileRequest(new File(["x"], "notes.md")));
    expect(order).toEqual(["store", "enqueue"]);
    expect(status).toBe(202);
    // The stored key travels back, so the client can name what landed…
    expect(body.path).toBe("raw/sources/notes/abc.md");
    // …and `queued: false` is the honest half: nothing is compiling yet.
    expect(body.queued).toBe(false);
    expect(String(body.error)).toContain("queue unavailable");
    // NOT rolled back. Deleting stored bytes to tidy up a queue error is the one
    // thing FR-2 forbids, and there is no writer here that could do it anyway.
    expect(mockedSave).toHaveBeenCalledTimes(1);
  });

  it("answers 202 when store succeeded and the job record failed", async () => {
    mockedJob.mockRejectedValueOnce(new Error("jobs unavailable"));
    const { status, body } = await post(fileRequest(new File(["x"], "notes.md")));
    expect(status).toBe(202);
    expect(body.queued).toBe(false);
    expect(body.path).toMatch(/^raw\/sources\//);
    expect(String(body.error)).toContain("jobs unavailable");
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("answers 202 when store succeeded and staging the queue payload failed", async () => {
    mockedStage.mockRejectedValueOnce(new Error("stage full"));
    const huge = "x".repeat(96_001);
    const { status, body } = await post(fileRequest(new File([huge], "huge.md")));
    expect(status).toBe(202);
    expect(body.queued).toBe(false);
    expect(body.path).toMatch(/^raw\/sources\//);
    expect(String(body.error)).toContain("stage full");
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("hands an office or ebook file to the extract job, and parses nothing here", async () => {
    // The Epic 2 pin this replaces asserted a 400. What has to hold NOW is
    // that the bytes are handed on UNPARSED: the Worker cannot reach the
    // sidecar at `127.0.0.1`, so any parse attempted on this side is the bug.
    for (const [name, format] of [
      ["report.pdf", "pdf"],
      ["plan.docx", "docx"],
      ["book.epub", "epub"],
    ] as const) {
      vi.clearAllMocks();
      mockedExtract.mockResolvedValue({
        path: `raw/sources/x/abc.${format}`,
        jobId: "extract-job",
        error: null,
      } as never);
      const { status, body } = await post(fileRequest(new File(["x"], name)));
      // 200, not the text path's 202: nothing is queued for COMPILE yet. The
      // `extract: true` flag is what the client reports the arrival by.
      expect(status, name).toBe(200);
      expect(body.extract, name).toBe(true);
      expect(mockedExtract, name).toHaveBeenCalledTimes(1);
      expect(mockedExtract.mock.calls[0][0].format, name).toBe(format);
      // The bytes travel as bytes. `file.text()` would replace every byte the
      // UTF-8 decoder does not recognise, and the sidecar would be handed a
      // document that no longer parses.
      expect(mockedExtract.mock.calls[0][0].bytes, name).toBeInstanceOf(ArrayBuffer);
      // NOT the text writer, and NOT an ingest queued ahead of the extract:
      // Ingest runs only once extracted text is in the kernel.
      expect(mockedSave, name).not.toHaveBeenCalled();
      expect(mockedEnqueue, name).not.toHaveBeenCalled();
    }
  });

  it("keeps a Plaud-origin PDF meeting-eligible across the extract hop", async () => {
    // Epic 4's rule is about the SOURCE, not the door it came through. A Plaud
    // recording that arrives as a binary loses its Todo Candidates entirely if
    // the flag is not set here — and this is the ONLY place that knows the
    // arrival said `plaud`, because the completing door reads a record that
    // does not carry it.
    mockedExtract.mockResolvedValue({
      path: "raw/sources/call/abc.pdf",
      jobId: "extract-job",
      extractId: "extract-1",
      error: null,
    } as never);
    const { status } = await post(
      fileRequest(new File(["x"], "call.pdf"), undefined, "plaud"),
    );
    expect(status).toBe(200);
    expect(mockedExtract.mock.calls[0][0].origin).toBe("plaud");
    expect(rememberExtractMeeting).toHaveBeenCalledWith(
      "alice",
      "raw/sources/call/abc.pdf",
      "plaud",
    );
  });

  it("does not mark a non-Plaud PDF as a meeting", async () => {
    await post(fileRequest(new File(["x"], "report.pdf")));
    expect(rememberExtractMeeting).toHaveBeenCalledWith(
      "alice",
      expect.any(String),
      undefined,
    );
  });

  it("stores media as bytes and queues no compile", async () => {
    const { status, body } = await post(fileRequest(new File(["x"], "shot.png")));
    expect(status).toBe(200);
    expect(body.media).toBe(true);
    expect(body.queued).toBe(false);
    expect(mockedSaveBytes).toHaveBeenCalledTimes(1);
    // An image is not extract work — no crate reads one — so nothing is
    // enqueued for the sidecar, and nothing is parsed here either.
    expect(mockedExtract).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
  });

  it("refuses a missing or empty file", async () => {
    expect((await post(fileRequest())).status).toBe(400);
    expectNothingCommitted();
    vi.clearAllMocks();
    // Zero bytes: nothing storable arrived. Whitespace is still bytes and is
    // stored as-is (Story 2.7).
    const { status, body } = await post(fileRequest(new File([""], "blank.md")));
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_FILE_REQUIRED_COPY);
    expectNothingCommitted();
  });

  it("stores a whitespace-only file as those exact bytes", async () => {
    const { status, body } = await post(
      fileRequest(new File(["   \n  "], "blank.md")),
    );
    expect(status).toBe(202);
    expect(mockedSave.mock.calls[0][2]).toBe("   \n  ");
    expect(body.queued).toBe(true);
  });

  it("makes N files into N Sources and N queue items", async () => {
    // One arrival per request by design, so a drop of three is three posts.
    // What this pins is that three of them produce three distinct keys and
    // three jobs — not one batched write.
    for (const name of ["a.md", "b.txt", "c.html"]) {
      await post(fileRequest(new File([`body of ${name}`], name)));
    }
    expect(mockedSave).toHaveBeenCalledTimes(3);
    expect(mockedJob).toHaveBeenCalledTimes(3);
    expect(mockedEnqueue).toHaveBeenCalledTimes(3);
    const slugs = mockedSave.mock.calls.map(([slug]) => slug);
    expect(slugs).toEqual(["a", "b", "c"]);
    const jobIds = mockedEnqueue.mock.calls.map(([jobId]) => jobId);
    expect(new Set(jobIds).size).toBe(3);
  });

  it("stores a folder file at its sanitized relative path and carries it on the task", async () => {
    mockedEnqueue.mockImplementation(async (jobId, _task, inline) => {
      await inline();
      return NextResponse.json({ queued: true, jobId }, { status: 202 });
    });
    const { status, body } = await post(
      fileRequest(new File(["# Note"], "note.md"), "papers/energy/note.md"),
    );
    expect(status).toBe(202);
    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedSaveTree).toHaveBeenCalledTimes(1);
    const [relative, text, options] = mockedSaveTree.mock.calls[0];
    expect(relative).toBe("papers/energy/note.md");
    expect(text).toBe("# Note");
    expect(options).toEqual({ owner: "alice" });
    expect(body.path).toBe("raw/sources/papers/energy/note.md");
    const task = mockedEnqueue.mock.calls[0][1] as { relativePath?: string; content?: string };
    expect(task.relativePath).toBe("papers/energy/note.md");
    expect(task.content).toBe("# Note");
    expect(mockedIngest).toHaveBeenCalledWith(
      "note",
      "# Note",
      expect.objectContaining({ relativePath: "papers/energy/note.md", owner: "alice" }),
    );
  });

  it("does not queue Ingest when the tree key already holds the same bytes", async () => {
    mockedSaveTree.mockResolvedValueOnce({
      path: "raw/sources/papers/energy/note.md",
      created: false,
    });
    mockedReadTree.mockResolvedValueOnce("new bytes");
    const { status, body } = await post(
      fileRequest(new File(["new bytes"], "note.md"), "papers/energy/note.md"),
    );
    expect(status).toBe(200);
    expect(body.queued).toBe(false);
    expect(body.skipped).toBe(true);
    expect(body.path).toBe("raw/sources/papers/energy/note.md");
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("keeps the 2.1 hash writer when relativePath is absent", async () => {
    await post(fileRequest(new File(["loose"], "a.md")));
    expect(mockedSave).toHaveBeenCalledTimes(1);
    expect(mockedSaveTree).not.toHaveBeenCalled();
    const task = mockedEnqueue.mock.calls[0][1] as { relativePath?: string };
    expect(task.relativePath).toBeUndefined();
  });

  it("answers 400 and writes nothing for a traversal relativePath", async () => {
    const { status, body } = await post(
      fileRequest(new File(["x"], "passwd.md"), "../../etc/passwd"),
    );
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_BAD_PATH_COPY);
    expectNothingCommitted();
  });

  it("answers 400 and writes nothing for a path past the listable depth", async () => {
    const { status, body } = await post(
      fileRequest(new File(["x"], "file.md"), "a/b/c/file.md"),
    );
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_TOO_DEEP_COPY);
    expectNothingCommitted();
  });

  it("answers 400 when relativePath is not a string, rather than hashing", async () => {
    const form = new FormData();
    form.append("file", new File(["# Note"], "note.md"));
    form.append("relativePath", new File(["not a path"], "path.txt"));
    const { status, body } = await post(
      new Request("http://localhost/api/workbench/intake", { method: "POST", body: form }),
    );
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_BAD_PATH_COPY);
    expectNothingCommitted();
  });

  it("stamps Plaud-origin on the job and the queued task", async () => {
    await post(fileRequest(new File(["# Meet"], "meet.md"), undefined, "plaud"));
    expect(mockedJob.mock.calls[0][0]).toMatchObject({ origin: "plaud" });
    const task = mockedEnqueue.mock.calls[0][1] as { origin?: string };
    expect(task.origin).toBe("plaud");
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(vi.mocked(setSourceMeeting)).toHaveBeenCalledWith(
      "alice",
      expect.stringMatching(/^raw\/sources\//),
      true,
    );
  });

  it("skips Analysis/Generation when SHA256 already ingested", async () => {
    mockedSha.mockResolvedValueOnce("existing-page");
    const { status, body } = await post(fileRequest(new File(["# Same"], "same.md")));
    expect(status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(body.queued).toBe(false);
    expect(body.path).toBe("raw/sources/existing/abc.md");
    expect(mockedResee).toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedSaveTree).not.toHaveBeenCalled();
    expect(mockedJob.mock.calls[0][0]).toMatchObject({
      status: "skipped",
      sourceRel: "raw/sources/existing/abc.md",
    });
  });

  it("stores the second folder path on a SHA256 hit and skips compile", async () => {
    mockedSha.mockResolvedValueOnce("existing-page");
    const { status, body } = await post(
      fileRequest(new File(["# Same"], "note.md"), "papers/energy/note.md"),
    );
    expect(status).toBe(200);
    expect(body.skipped).toBe(true);
    expect(mockedSave).not.toHaveBeenCalled();
    expect(mockedSaveTree).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("refuses a folder path occupied by different bytes", async () => {
    mockedSaveTree.mockResolvedValueOnce({
      path: "raw/sources/papers/energy/note.md",
      created: false,
    });
    mockedReadTree.mockResolvedValueOnce("old bytes");
    const { status, body } = await post(
      fileRequest(new File(["# New"], "note.md"), "papers/energy/note.md"),
    );
    expect(status).toBe(409);
    expect(body.refused).toBe(true);
    expect(body.queued).toBe(false);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("does not skip or disclose a SHA hit the caller cannot re-see", async () => {
    mockedSha.mockResolvedValueOnce("other-owner-page");
    mockedResee.mockResolvedValueOnce(null);
    const { status, body } = await post(fileRequest(new File(["# Same"], "same.md")));
    expect(status).toBe(202);
    expect(body.skipped).not.toBe(true);
    expect(body.slug).not.toBe("other-owner-page");
    expect(mockedSave).toHaveBeenCalled();
    expect(mockedEnqueue).toHaveBeenCalled();
  });

  it("refuses a file over the byte cap", async () => {
    // A REAL oversized body, not a `size` property redefined on the instance:
    // the multipart round trip reconstructs the `File` from the encoded bytes,
    // so a faked size never reaches the handler and the case would pass
    // against a route with no cap at all.
    const huge = new File(["x".repeat(MAX_DOCUMENT_SIZE + 1)], "big.md");
    const { status, body } = await post(fileRequest(huge));
    expect(status).toBe(400);
    expect(String(body.error)).toContain("too large");
    expectNothingCommitted();
  });
});

describe("POST /api/workbench/intake — the in-app URL", () => {
  it("fetches through the NARROWED content-type list", async () => {
    mockedFetchUrl.mockResolvedValue({ title: "Why Wikis", content: "# Why Wikis\n\nClip." });
    const { status } = await post(urlRequest({ url: "https://example.com/posts/why-wikis" }));
    expect(status).toBe(202);
    expect(mockedFetchUrl).toHaveBeenCalledWith(
      "https://example.com/posts/why-wikis",
      { allowedContentTypes: INTAKE_ALLOWED_CONTENT_TYPES },
    );
  });

  it("stores the clip Markdown as the Source and queues it", async () => {
    mockedFetchUrl.mockResolvedValue({ title: "Why Wikis", content: "# Why Wikis\n\nClip." });
    await post(urlRequest({ url: "https://example.com/posts/why-wikis.html" }));
    const [slug, , text, options] = mockedSave.mock.calls[0];
    expect(slug).toBe("example-com-why-wikis");
    expect(text).toBe("# Why Wikis\n\nClip.");
    expect(options).toEqual({ owner: "alice" });
    // Provenance rides along, so the compiled page can cite where it came from.
    const task = mockedEnqueue.mock.calls[0][1] as { sourceUrl?: string };
    expect(task.sourceUrl).toBe("https://example.com/posts/why-wikis.html");
  });

  it("refuses an empty or non-http URL before fetching anything", async () => {
    for (const url of ["", "   ", "example.com", "file:///etc/passwd"]) {
      vi.clearAllMocks();
      const { status, body } = await post(urlRequest({ url }));
      expect(status, url).toBe(400);
      expect(body.error).toBe(INTAKE_URL_REQUIRED_COPY);
      expect(mockedFetchUrl).not.toHaveBeenCalled();
      expectNothingCommitted();
    }
  });

  it("refuses a missing url key, and a non-string one", async () => {
    for (const body of [{}, { url: 42 }, { url: null }]) {
      vi.clearAllMocks();
      expect((await post(urlRequest(body))).status).toBe(400);
      expectNothingCommitted();
    }
  });

  it("refuses a JSON body of `null` as malformed, not as a server error", async () => {
    // The four characters `null` are VALID JSON, so `request.json()` RESOLVES
    // with `null` and never reaches the `.catch`. Reading `.url` off it throws a
    // TypeError the outer handler can only report as a 500 — an "our fault"
    // answer to a request that is simply malformed, and one that a client
    // treats as unconfirmed (the bytes may have landed) when nothing was even
    // parsed. `null` and a primitive body both belong with the other 400s.
    for (const raw of ["null", '"https://example.com/a"', "42"]) {
      vi.clearAllMocks();
      const { status, body } = await post(
        new Request("http://localhost/api/workbench/intake", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: raw,
        }),
      );
      expect(status, raw).toBe(400);
      expect(body.error, raw).toBe(INTAKE_URL_REQUIRED_COPY);
      expect(mockedFetchUrl).not.toHaveBeenCalled();
      expectNothingCommitted();
    }
  });

  it("invents no Source when the fetch fails", async () => {
    // A blocked host, a PDF refused by the narrowed list, an unparseable page:
    // all of them are facts about the URL the owner supplied, so the arrival
    // fails on that action and nothing is written.
    mockedFetchUrl.mockRejectedValue(new Error("Unsupported content type: application/pdf."));
    const { status, body } = await post(urlRequest({ url: "https://example.com/doc.pdf" }));
    expect(status).toBe(400);
    expect(String(body.error)).toContain("Unsupported content type");
    expectNothingCommitted();
  });

  it("invents no Source when the page carries no text", async () => {
    mockedFetchUrl.mockResolvedValue({ title: "Empty", content: "   \n " });
    const { status, body } = await post(urlRequest({ url: "https://example.com/empty" }));
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_EMPTY_SOURCE_COPY);
    expectNothingCommitted();
  });

  it("stores a non-empty clip without fetching, and keeps the captured URL as provenance", async () => {
    const clip = "Selected paragraph from the page.";
    const { status } = await post(
      urlRequest({ url: "https://example.com/posts/why-wikis.html", clip }),
    );
    expect(status).toBe(202);
    expect(mockedFetchUrl).not.toHaveBeenCalled();
    const [slug, , text, options] = mockedSave.mock.calls[0];
    expect(slug).toBe("example-com-why-wikis");
    expect(text).toBe(clip);
    expect(options).toEqual({ owner: "alice" });
    const task = mockedEnqueue.mock.calls[0][1] as { sourceUrl?: string };
    expect(task.sourceUrl).toBe("https://example.com/posts/why-wikis.html");
    expect(mockedJob.mock.calls[0][0]).toMatchObject({
      url: "https://example.com/posts/why-wikis.html",
      title: "Selected paragraph from the page.",
    });
  });

  it("still fetches when clip is missing, empty, or not a string", async () => {
    // Missing/non-string clip is absent — not hashed, not stored. Empty clip
    // is the 2.1 URL door: fetch, then store whatever the page yielded.
    for (const extra of [{}, { clip: "" }, { clip: "   " }, { clip: 12 }, { clip: null }]) {
      vi.clearAllMocks();
      mockedFetchUrl.mockResolvedValue({ title: "Why Wikis", content: "# Why Wikis\n\nClip." });
      const { status } = await post(
        urlRequest({ url: "https://example.com/posts/why-wikis", ...extra }),
      );
      expect(status, JSON.stringify(extra)).toBe(202);
      expect(mockedFetchUrl, JSON.stringify(extra)).toHaveBeenCalledTimes(1);
      expect(mockedSave.mock.calls[0][2]).toBe("# Why Wikis\n\nClip.");
    }
  });

  it("invents no Source when a clip is over the byte cap", async () => {
    const clip = "x".repeat(MAX_DOCUMENT_SIZE + 1);
    const { status, body } = await post(
      urlRequest({ url: "https://example.com/a", clip }),
    );
    expect(status).toBe(400);
    expect(String(body.error)).toContain("too large");
    expect(mockedFetchUrl).not.toHaveBeenCalled();
    expectNothingCommitted();
  });
});

describe("the route's shape", () => {
  it("writes Sources through the shared helper and no other writer", async () => {
    const source = await readFile(
      path.join(SRC, "app/api/workbench/intake/route.ts"),
      "utf8",
    );
    expect(source).toContain("saveRawSourceFor");
    expect(source).toContain("saveRawSourceTree");
    // No second raw-source writer, and no direct storage call that would
    // bypass the immutability, silo-mirror and `dataVersion` tail those
    // helpers own.
    expect(source).not.toContain("getStorage()");
    expect(source).not.toContain("writeFile(");
    // The extract path stays out of this door entirely (Epic 7 owns it).
    expect(source).not.toContain("ingestDocument");
    expect(source).not.toContain("detectDocumentFormat");
    // And the queue is the shared helper, not a second enqueue loop.
    expect(source).toContain("enqueueOrInline");
    // Nothing here can UNDO a store. A queue failure answers 202 with the path
    // rather than tidying up bytes FR-2 declares immutable, and there is no
    // deleting call in the file for a later "cleanup" to reach for.
    expect(source).not.toMatch(/delete(File|Object)?\(|unlink|\brm\(/);
  });

  it("files Capture through Intake and nowhere else", async () => {
    const source = await readFile(path.join(SRC, "components/SaveCapture.tsx"), "utf8");
    expect(source).toContain("submitIntakeUrl(url, clip)");
    expect(source).not.toContain("submitIntakeUrl(url)");
    expect(source).not.toContain("/api/ingest");
    expect(source).not.toContain("IngestVaultPicker");
    expect(source).not.toContain("rememberRecentJob");
    expect(source).toContain('dismiss("/")');
    expect(source).not.toContain('dismiss("/ingest")');
    // Unsigned Capture is fail-closed on this action: sign-in, no submit.
    expect(source).toContain('return isSignedIn ? "confirm" : "signin"');
    expect(source).toContain("openSignIn()");
    expect(source).toContain("Sign in to save this page to work-wiki.");
    // Empty/blocked sentences stay on the Capture action, not a silent return.
    expect(source).toContain("INTAKE_URL_REQUIRED_COPY");
    expect(source).toContain("setError(outcome.error)");
    expect(source).toContain("disabled={missingUrl}");
    expect(source).toContain("if (missingUrl)");
    expect(source).toContain("outcome.unconfirmed");
    expect(source).not.toContain("editTitle");
  });
});

// ---------------------------------------------------------------------------
// 3. The browser half
// ---------------------------------------------------------------------------

import {
  INTAKE_ROUTE,
  emptyFolderOutcome,
  intakeReport,
  intakeShouldRefresh,
  intakeStoredCount,
  isFolderExpandedFile,
  partitionIntakeFiles,
  submitIntakeFile,
  submitIntakeFiles,
  submitIntakeUrl,
} from "../workbench-intake-client";

/** A stub for the ONE global the client touches. */
function stubFetch(
  handler: (url: string, init: RequestInit) => Promise<Response> | Response,
): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async (url: string, init: RequestInit) => handler(url, init));
  vi.stubGlobal("fetch", spy);
  return spy;
}

const ok = () => new Response(JSON.stringify({ queued: true }), { status: 202 });

describe("the client's per-item submit", () => {
  it("posts one multipart request per file and reports each outcome", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      new File(["a"], "a.md"),
      new File(["b"], "b.txt"),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [url, init] of spy.mock.calls as Array<[string, RequestInit]>) {
      expect(url).toBe(INTAKE_ROUTE);
      expect(init.method).toBe("POST");
      expect(init.body).toBeInstanceOf(FormData);
      // The boundary has to be the browser's, so the label is left unset.
      expect(init.headers).toBeUndefined();
    }
    expect(outcomes).toEqual([
      { name: "a.md", error: null, unconfirmed: false, disposition: "queued" },
      { name: "b.txt", error: null, unconfirmed: false, disposition: "queued" },
    ]);
    vi.unstubAllGlobals();
  });

  it("UPLOADS an office file now, and still refuses an unreadable one on the spot", async () => {
    // The Epic 2 pin this replaces asserted the DOCX never left the browser.
    // It does now: the bytes are what the sidecar's crate needs, and the door
    // that takes them is the same one. What is still worth not spending is a
    // round trip for a format nothing can read — `.bin` fails here, before the
    // upload, with the sentence naming what it was.
    const spy = stubFetch(ok);
    const accepted = await submitIntakeFile(new File(["x"], "plan.docx"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(accepted.error).toBe(null);

    const refused = await submitIntakeFile(new File(["x"], "thing.bin"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(refused.error).toBe(intakeUnsupportedCopy("BIN"));
    expect(refused.unconfirmed).toBe(false);
    vi.unstubAllGlobals();
  });

  it("keeps going after a refusal, and reports the server's sentence", async () => {
    const spy = stubFetch((_url, init) => {
      const body = init.body as FormData;
      const file = body.get("file") as File;
      return file.name === "bad.md"
        ? new Response(JSON.stringify({ error: "No text could be stored." }), { status: 400 })
        : ok();
    });
    const outcomes = await submitIntakeFiles([
      new File(["a"], "a.md"),
      new File(["b"], "bad.md"),
      new File(["c"], "c.md"),
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
    expect(outcomes.map((o) => o.error)).toEqual([
      null,
      "No text could be stored.",
      null,
    ]);
    expect(intakeStoredCount(outcomes)).toBe(2);
    vi.unstubAllGlobals();
  });

  it("reports an unanswered write as UNKNOWN, never as a failure", async () => {
    // A gateway that gave up may have applied the write in full, so the client
    // must not claim it failed — and the caller has to reconcile.
    const spy = stubFetch(() => new Response("", { status: 504 }));
    const outcome = await submitIntakeFile(new File(["a"], "a.md"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(outcome.unconfirmed).toBe(true);
    expect(outcome.error).toContain("the outcome is unknown");
    expect(intakeShouldRefresh([outcome])).toBe(true);
    vi.unstubAllGlobals();
  });

  it("posts origin=plaud only when the Plaud pick asked", async () => {
    const spy = stubFetch(ok);
    await submitIntakeFile(new File(["a"], "a.md"), { origin: "plaud" });
    expect((spy.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(((spy.mock.calls[0][1] as RequestInit).body as FormData).get("origin")).toBe(
      "plaud",
    );

    spy.mockClear();
    await submitIntakeFile(new File(["b"], "b.md"));
    expect(((spy.mock.calls[0][1] as RequestInit).body as FormData).get("origin")).toBeNull();
    vi.unstubAllGlobals();
  });

  it("posts the URL as JSON, and refuses a bad one without a request", async () => {
    const spy = stubFetch(ok);
    const stored = await submitIntakeUrl("  https://example.com/a  ");
    expect(stored.error).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(INTAKE_ROUTE);
    // Trimmed before it is sent, so the stored slug cannot depend on stray
    // whitespace the owner pasted.
    expect(init.body).toBe(JSON.stringify({ url: "https://example.com/a" }));

    spy.mockClear();
    const refused = await submitIntakeUrl("example.com");
    expect(spy).not.toHaveBeenCalled();
    expect(refused.error).toBe(INTAKE_URL_REQUIRED_COPY);
    vi.unstubAllGlobals();
  });

  it("posts a non-empty clip with the URL, and omits an empty one", async () => {
    const spy = stubFetch(ok);
    await submitIntakeUrl("https://example.com/a", "  selected paragraph  ");
    expect(JSON.parse(String(spy.mock.calls[0][1].body))).toEqual({
      url: "https://example.com/a",
      clip: "  selected paragraph  ",
    });

    spy.mockClear();
    await submitIntakeUrl("https://example.com/a", "   ");
    expect(JSON.parse(String(spy.mock.calls[0][1].body))).toEqual({
      url: "https://example.com/a",
    });

    spy.mockClear();
    await submitIntakeUrl("https://example.com/a");
    expect(JSON.parse(String(spy.mock.calls[0][1].body))).toEqual({
      url: "https://example.com/a",
    });
    vi.unstubAllGlobals();
  });
});

describe("a folder drop stores each leaf and queues it", () => {
  /** As a browser reports a file it expanded out of a dropped directory. */
  function fromFolder(name: string, relative: string, body = "x"): File {
    const file = new File([body], name);
    Object.defineProperty(file, "webkitRelativePath", {
      value: relative,
      configurable: true,
    });
    return file;
  }

  it("reads the platform's own marker, and defaults to `direct`", () => {
    expect(isFolderExpandedFile(fromFolder("plan.md", "notes/plan.md"))).toBe(true);
    // `""` is what a directly dropped file carries, and the property is
    // non-standard — a browser that does not implement it leaves it `undefined`,
    // which must read as a direct file rather than refusing every arrival.
    expect(isFolderExpandedFile(new File(["x"], "plan.md"))).toBe(false);
    expect(isFolderExpandedFile(fromFolder("plan.md", ""))).toBe(false);
  });

  it("keeps every file, including the expanded ones", () => {
    const loose = new File(["a"], "a.md");
    const nested = fromFolder("b.md", "notes/b.md");
    const { files, skippedFolderFiles } = partitionIntakeFiles([
      loose,
      nested,
      fromFolder("c.md", "notes/deep/c.md"),
    ]);
    expect(files).toHaveLength(3);
    expect(files[0]).toBe(loose);
    expect(files[1]).toBe(nested);
    expect(skippedFolderFiles).toBe(0);
  });

  it("posts each expanded file with its sanitized relativePath", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      fromFolder("note.md", "papers/energy/note.md"),
      fromFolder("clip.html", "papers/clip.html"),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    const paths = (spy.mock.calls as Array<[string, RequestInit]>).map(([, init]) =>
      (init.body as FormData).get("relativePath"),
    );
    expect(paths).toEqual(["papers/energy/note.md", "papers/clip.html"]);
    expect(outcomes.map((o) => o.error)).toEqual([null, null]);
    expect(intakeStoredCount(outcomes)).toBe(2);
    expect(intakeShouldRefresh(outcomes)).toBe(true);
    vi.unstubAllGlobals();
  });

  it("uploads an office file in the tree as a LOOSE source, beside its siblings", async () => {
    // The Epic 2 pin this replaces expected the PPTX to be refused. It is
    // stored now — but WITHOUT a `relativePath`, and that is the point: a tree
    // position is a claim about a text file's place in a folder of notes, and
    // a binary that has to come back from the sidecar before it means anything
    // is a loose Source until it does.
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      fromFolder("note.md", "papers/energy/note.md"),
      fromFolder("deck.pptx", "papers/energy/deck.pptx"),
      fromFolder("log.txt", "papers/log.txt"),
    ]);
    expect(spy).toHaveBeenCalledTimes(3);
    const bodies = (spy.mock.calls as Array<[string, RequestInit]>).map(([, init]) => {
      const form = init.body as FormData;
      return {
        name: (form.get("file") as File).name,
        relativePath: form.get("relativePath"),
      };
    });
    expect(bodies).toEqual([
      { name: "note.md", relativePath: "papers/energy/note.md" },
      { name: "deck.pptx", relativePath: null },
      { name: "log.txt", relativePath: "papers/log.txt" },
    ]);
    expect(outcomes.every((o) => o.error === null)).toBe(true);
    expect(intakeStoredCount(outcomes)).toBe(3);
    vi.unstubAllGlobals();
  });

  it("stores a loose file without relativePath and a folder file with one", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      new File(["a"], "a.md"),
      fromFolder("b.md", "notes/b.md"),
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    const bodies = (spy.mock.calls as Array<[string, RequestInit]>).map(([, init]) => {
      const form = init.body as FormData;
      return {
        name: (form.get("file") as File).name,
        relativePath: form.get("relativePath"),
      };
    });
    expect(bodies).toEqual([
      { name: "a.md", relativePath: null },
      { name: "b.md", relativePath: "notes/b.md" },
    ]);
    expect(intakeStoredCount(outcomes)).toBe(2);
    expect(intakeReport(outcomes)).toBe(intakeStoredCopy(2));
    expect(intakeReport(outcomes)).not.toContain(INTAKE_FOLDER_COPY);
    vi.unstubAllGlobals();
  });

  it("refuses a traversal relativePath without uploading", async () => {
    const spy = stubFetch(ok);
    const outcome = await submitIntakeFile(fromFolder("passwd.md", "../../etc/passwd"));
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).toBe(INTAKE_BAD_PATH_COPY);
    vi.unstubAllGlobals();
  });

  it("refuses a path past the listable depth without uploading", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      fromFolder("note.md", "papers/energy/note.md"),
      fromFolder("file.md", "a/b/c/d/file.md"),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][1] as RequestInit).body).toBeInstanceOf(FormData);
    expect(((spy.mock.calls[0][1] as RequestInit).body as FormData).get("relativePath")).toBe(
      "papers/energy/note.md",
    );
    expect(outcomes.map((o) => o.error)).toEqual([null, INTAKE_TOO_DEEP_COPY]);
    expect(intakeStoredCount(outcomes)).toBe(1);
    vi.unstubAllGlobals();
  });

  it("says so on the Folder action when the picker yields no files", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([]);
    expect(spy).not.toHaveBeenCalled();
    expect(outcomes).toEqual([emptyFolderOutcome()]);
    expect(outcomes[0].error).toBe(INTAKE_FOLDER_COPY);
    expect(intakeStoredCount(outcomes)).toBe(0);
    expect(intakeShouldRefresh(outcomes)).toBe(false);
    expect(intakeReport(outcomes)).toBe(INTAKE_FOLDER_COPY);
    vi.unstubAllGlobals();
  });
});

describe("the batch sentence", () => {
  const stored = (name: string) => ({
    name,
    error: null,
    unconfirmed: false,
    disposition: "queued" as const,
  });
  const failed = (name: string, error: string) => ({
    name,
    error,
    unconfirmed: false,
    disposition: "failed" as const,
  });

  it("counts what landed when everything landed", () => {
    expect(intakeReport([stored("a.md"), stored("b.md")])).toBe(intakeStoredCopy(2));
  });

  it("names the failure when nothing landed", () => {
    expect(intakeReport([failed("plan.docx", "DOCX is not a source.")])).toBe(
      "plan.docx: DOCX is not a source.",
    );
  });

  it("says BOTH halves for a mixed batch", () => {
    // Reporting only the successes hides a refusal; reporting only the refusal
    // hides Sources that are already compiling.
    expect(
      intakeReport([stored("a.md"), failed("plan.docx", "DOCX is not a source.")]),
    ).toBe(`${intakeStoredCopy(1)} plan.docx: DOCX is not a source.`);
  });

  it("reports nothing at all for an empty batch", () => {
    // A drag that carried no files. "Stored 0 sources" would announce an
    // arrival that never happened.
    expect(intakeReport([])).toBe("");
  });

  it("asks for a refresh whenever anything might have landed", () => {
    expect(intakeShouldRefresh([stored("a.md")])).toBe(true);
    expect(intakeShouldRefresh([failed("a.md", "no")])).toBe(false);
    expect(
      intakeShouldRefresh([
        { name: "a.md", error: "unknown", unconfirmed: true, disposition: "unconfirmed" },
      ]),
    ).toBe(true);
  });
});
