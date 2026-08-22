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
 * Vitest runs `environment: "node"`, so nothing here mounts a component: the
 * UI's own invariants (Import / Upload in the tree header, the shell's drop
 * handlers) are pinned by source scan in `workbench-left-column.test.ts`, and
 * every rule that could be executed instead of grepped was put in a module for
 * exactly that reason.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";

import { ALLOWED_CONTENT_TYPES } from "../fetch";
import { MAX_DOCUMENT_SIZE } from "../constants";
import { DOCUMENT_FORMAT_LABELS } from "../document-formats";
import { READ_ONLY_REFUSAL } from "../read-only";
import {
  INTAKE_ACCEPT_ATTR,
  INTAKE_ALLOWED_CONTENT_TYPES,
  INTAKE_DROP_COPY,
  INTAKE_EMPTY_SOURCE_COPY,
  INTAKE_EXTENSIONS,
  INTAKE_FALLBACK_SLUG,
  INTAKE_FOLDER_COPY,
  INTAKE_IMPORT_LABEL,
  INTAKE_IN_FLIGHT_COPY,
  INTAKE_MIME_TYPES,
  INTAKE_READ_ONLY_COPY,
  INTAKE_URL_REQUIRED_COPY,
  classifyIntakeFile,
  intakeDragHasFiles,
  intakeFileTitle,
  intakeSourceSlug,
  intakeStoredCopy,
  intakeUnsupportedCopy,
  intakeUrlSlug,
  isIntakeUrl,
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

  it("refuses every office and ebook type, and NAMES what it refused", () => {
    // The headline of the story: this door runs no extract, so a PDF or a DOCX
    // must fail visibly. The label comes from the vault's format table, which
    // is why the sentence says "PDF" rather than "that file" — naming the type
    // is what tells the owner whether to convert it or pick something else.
    for (const [name, label] of [
      ["report.pdf", DOCUMENT_FORMAT_LABELS.pdf],
      ["plan.docx", DOCUMENT_FORMAT_LABELS.docx],
      ["deck.pptx", DOCUMENT_FORMAT_LABELS.pptx],
      ["sheet.xlsx", DOCUMENT_FORMAT_LABELS.xlsx],
      ["book.epub", DOCUMENT_FORMAT_LABELS.epub],
      ["book.mobi", DOCUMENT_FORMAT_LABELS.mobi],
    ] as const) {
      const verdict = classifyIntakeFile(name);
      expect(verdict.ok, name).toBe(false);
      expect(verdict.ok ? "" : verdict.reason).toBe(intakeUnsupportedCopy(label));
    }
  });

  it("refuses a PDF even when the content type claims otherwise", () => {
    // The content type is supplied by whoever built the multipart body, so a
    // classifier that fell back to it on an unrecognised extension would let
    // `report.pdf` through the one door that must never take a PDF. An
    // extension the tables do not name is refused whatever the label says.
    expect(classifyIntakeFile("report.pdf", "text/plain").ok).toBe(false);
    expect(classifyIntakeFile("plan.docx", "text/markdown").ok).toBe(false);
    expect(classifyIntakeFile("thing.bin", "text/html").ok).toBe(false);
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
    // …and offers nothing this door would refuse.
    for (const banned of [".pdf", ".docx", "application/pdf"]) {
      expect(INTAKE_ACCEPT_ATTR).not.toContain(banned);
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
}));
vi.mock("@/lib/fetch", async (importOriginal) => ({
  // The real module for `ALLOWED_CONTENT_TYPES`, which the narrowing case above
  // compares against — only the network call is replaced.
  ...(await importOriginal<typeof import("../fetch")>()),
  fetchUrlContent: vi.fn(),
}));
vi.mock("@/lib/ingest", () => ({ ingest: vi.fn(async () => ({ slug: "stored" })) }));
vi.mock("@/lib/ingest-jobs", () => ({ createIngestJob: vi.fn(async () => ({})) }));
vi.mock("@/lib/ingest-staging", () => ({
  stageText: vi.fn(async () => "raw/uploads/job/source.md"),
}));
vi.mock("@/lib/ingest-async", () => ({
  enqueueOrInline: vi.fn(
    async (jobId: string) =>
      new Response(JSON.stringify({ queued: true, jobId }), { status: 202 }),
  ),
}));

import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { fetchUrlContent } from "@/lib/fetch";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob } from "@/lib/ingest-jobs";
import { saveRawSourceFor } from "@/lib/raw";
import { POST } from "@/app/api/workbench/intake/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedFetchUrl = vi.mocked(fetchUrlContent);
const mockedSave = vi.mocked(saveRawSourceFor);
const mockedJob = vi.mocked(createIngestJob);
const mockedEnqueue = vi.mocked(enqueueOrInline);

/** A multipart request carrying one file, as the picker and the drop both send. */
function fileRequest(file?: File): Request {
  const form = new FormData();
  if (file) form.append("file", file);
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

/** Nothing was committed: no Source, no job record, no queue item. */
function expectNothingCommitted(): void {
  expect(mockedSave).not.toHaveBeenCalled();
  expect(mockedJob).not.toHaveBeenCalled();
  expect(mockedEnqueue).not.toHaveBeenCalled();
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

  it("refuses an office or ebook file with no Source and no job", async () => {
    for (const name of ["report.pdf", "plan.docx", "book.epub"]) {
      vi.clearAllMocks();
      const { status, body } = await post(fileRequest(new File(["x"], name)));
      expect(status, name).toBe(400);
      expect(String(body.error)).toContain("not a Markdown, text, or HTML source");
      expectNothingCommitted();
    }
  });

  it("refuses a missing or empty file", async () => {
    expect((await post(fileRequest())).status).toBe(400);
    expectNothingCommitted();
    vi.clearAllMocks();
    // Whitespace only: nothing storable arrived, and no Source is invented for
    // it — the failure belongs to the action the owner took.
    const { status, body } = await post(fileRequest(new File(["   \n  "], "blank.md")));
    expect(status).toBe(400);
    expect(body.error).toBe(INTAKE_EMPTY_SOURCE_COPY);
    expectNothingCommitted();
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
});

describe("the route's shape", () => {
  it("writes Sources through the shared helper and no other writer", async () => {
    const source = await readFile(
      path.join(SRC, "app/api/workbench/intake/route.ts"),
      "utf8",
    );
    expect(source).toContain("saveRawSourceFor");
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
});

// ---------------------------------------------------------------------------
// 3. The browser half
// ---------------------------------------------------------------------------

import {
  INTAKE_ROUTE,
  folderRefusedOutcome,
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
      { name: "a.md", error: null, unconfirmed: false },
      { name: "b.txt", error: null, unconfirmed: false },
    ]);
    vi.unstubAllGlobals();
  });

  it("refuses an office file WITHOUT uploading it", async () => {
    // A drop of a 40MB DOCX should fail on the spot with the same sentence,
    // not after a round trip that sends the bytes first. The route refuses
    // independently — a client check is not a gate.
    const spy = stubFetch(ok);
    const outcome = await submitIntakeFile(new File(["x"], "plan.docx"));
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.error).toBe(intakeUnsupportedCopy(DOCUMENT_FORMAT_LABELS.docx));
    expect(outcome.unconfirmed).toBe(false);
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
});

describe("a folder drop is refused, not half-imported", () => {
  /** As a browser reports a file it expanded out of a dropped directory. */
  function fromFolder(name: string, relative: string): File {
    const file = new File(["x"], name);
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

  it("keeps the loose files and counts the expanded ones", () => {
    const loose = new File(["a"], "a.md");
    const { files, skippedFolderFiles } = partitionIntakeFiles([
      loose,
      fromFolder("b.md", "notes/b.md"),
      fromFolder("c.md", "notes/deep/c.md"),
    ]);
    // A folder dragged ALONGSIDE two loose files is the case that decides this:
    // the loose ones are stored and the refusal is still said.
    expect(files).toEqual([loose]);
    expect(skippedFolderFiles).toBe(2);
  });

  it("uploads none of an expanded folder, and says why once", async () => {
    // Recursive folder import is Story 2.2. Storing the leaves a browser
    // happened to expand would ship an unnamed half of it — and silently, which
    // is the one thing this door must never be.
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      fromFolder("a.md", "notes/a.md"),
      fromFolder("b.md", "notes/b.md"),
    ]);
    expect(spy).not.toHaveBeenCalled();
    // ONE sentence for the whole folder, not one per leaf: a directory of forty
    // files is one thing the owner did.
    expect(outcomes).toEqual([folderRefusedOutcome()]);
    expect(outcomes[0].error).toBe(INTAKE_FOLDER_COPY);
    expect(intakeStoredCount(outcomes)).toBe(0);
    // Nothing landed and nothing is unknown, so there is nothing to re-poll for.
    expect(intakeShouldRefresh(outcomes)).toBe(false);
    // Reported without a filename in front of it: the sentence is about the
    // ACTION, and naming one of the expanded leaves would mislead.
    expect(intakeReport(outcomes)).toBe(INTAKE_FOLDER_COPY);
    vi.unstubAllGlobals();
  });

  it("still stores the loose files dropped beside a folder", async () => {
    const spy = stubFetch(ok);
    const outcomes = await submitIntakeFiles([
      new File(["a"], "a.md"),
      fromFolder("b.md", "notes/b.md"),
    ]);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(intakeStoredCount(outcomes)).toBe(1);
    expect(intakeReport(outcomes)).toBe(`${intakeStoredCopy(1)} ${INTAKE_FOLDER_COPY}`);
    // Something landed, so the trees are re-polled even though the batch also
    // carried a refusal.
    expect(intakeShouldRefresh(outcomes)).toBe(true);
    vi.unstubAllGlobals();
  });
});

describe("the batch sentence", () => {
  const stored = (name: string) => ({ name, error: null, unconfirmed: false });
  const failed = (name: string, error: string) => ({ name, error, unconfirmed: false });

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
      intakeShouldRefresh([{ name: "a.md", error: "unknown", unconfirmed: true }]),
    ).toBe(true);
  });
});
