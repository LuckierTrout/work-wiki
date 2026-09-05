import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getServicePrincipal: vi.fn() }));
vi.mock("@/lib/ingest", () => {
  class IngestCancelledError extends Error {
    constructor(message = "Cancelled — no pages were written.") {
      super(message);
      this.name = "IngestCancelledError";
    }
  }
  return {
    ingest: vi.fn(),
    ingestUrl: vi.fn(),
    ingestPdf: vi.fn(),
    ingestImage: vi.fn(),
    ingestDocument: vi.fn(),
    reingest: vi.fn(),
    IngestCancelledError,
  };
});
vi.mock("@/lib/tasks", async (orig) => ({
  ...(await orig<typeof import("@/lib/tasks")>()),
  enqueueTask: vi.fn(async () => false),
}));
vi.mock("@/lib/embeddings", () => ({
  rebuildVectorStore: vi.fn(async () => ({ total: 0, embedded: 0, skipped: 0, model: "none" })),
}));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  getVectorSearchSettings: vi.fn(() => ({
    enabled: true,
    provider: null,
    baseUrl: null,
    model: null,
    hasKey: false,
  })),
}));
vi.mock("@/lib/lint-fix", () => ({ fixLintIssue: vi.fn() }));
// Keep DEFAULT_AGENT_NAME real (the staleness path uses it); only stub
// addAgentLearningPage so we can assert the learning attach + fail-soft.
vi.mock("@/lib/agents", async (orig) => ({
  ...(await orig<typeof import("@/lib/agents")>()),
  addAgentLearningPage: vi.fn(async () => {}),
}));
vi.mock("@/lib/ingest-jobs", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest-jobs")>()),
  getIngestJob: vi.fn(async () => null),
  updateIngestJob: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ingest-staging", () => ({
  readStagedBytes: vi.fn(async () => new Uint8Array([1, 2, 3]).buffer),
  readStagedText: vi.fn(async () => "staged pasted text"),
  deleteStaged: vi.fn(async () => {}),
}));
vi.mock("@/lib/vault", () => ({
  addToVault: vi.fn(async () => {}),
}));
// Story 7.5: a staged PDF or office file reaching this consumer is a task an
// OLDER build enqueued. The Worker no longer owns those parsers, so it hands
// the bytes to the sidecar rather than calling them.
vi.mock("@/lib/fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/fetch")>()),
  fetchPdfBytes: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]).buffer,
    filename: "a.pdf",
    title: "a",
  })),
}));
vi.mock("@/lib/extract-dispatch", () => ({
  enqueueExtract: vi.fn(async () => ({
    path: "raw/sources/doc/abc.pdf",
    jobId: "job",
    extractId: "extract",
    error: null,
  })),
}));
vi.mock("@/lib/source-sha256", () => ({ bytesSha256: vi.fn(async () => "ab".repeat(32)) }));
vi.mock("@/lib/document-sources", () => ({
  preserveDocumentSources: vi.fn(async () => []),
}));
vi.mock("@/lib/structured-knowledge", () => ({
  extractStructuredKnowledge: vi.fn(),
}));
vi.mock("@/lib/graphify-jobs", () => ({
  completeGraphifyPage: vi.fn(async () => ({})),
  failGraphifyPages: vi.fn(async () => ({})),
  startGraphifyPage: vi.fn(async () => ({ job: {}, shouldRun: true })),
}));
vi.mock("@/lib/monitor-digests", () => ({
  deliverMonitorDigest: vi.fn(),
}));
vi.mock("@/lib/source-meeting", () => ({
  meetingExtractTarget: vi.fn(async (_owner: string, input: { origin?: string; sourcePath?: string }) =>
    input.origin === "plaud" ? { sourcePath: input.sourcePath } : null,
  ),
  setSourceMeeting: vi.fn(async (path: string) => ({ path, meeting: true })),
}));
vi.mock("@/lib/todo-extract", () => ({
  extractTodoCandidatesFromMeeting: vi.fn(async () => []),
}));
vi.mock("@/lib/todos", () => ({
  recordTodoExtractError: vi.fn(async () => {}),
}));
vi.mock("@/lib/review-queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/review-queue")>()),
  enqueueReviewFromAnalysis: vi.fn(async () => []),
  enqueueReviewAfterIngest: vi.fn(async () => {}),
  rememberReviewOutbox: vi.fn(async () => {}),
}));
// DW-482: the `run-research` arm was unreachable from this suite because the
// runtime was never mocked, so the classifier's handling of a corrupt-registry
// refusal had no row at the TASK surface at all.
vi.mock("@/lib/research-runtime", () => ({
  runResearchProject: vi.fn(),
}));
vi.mock("@/lib/ingest-analysis", async (orig) => ({
  ...(await orig<typeof import("@/lib/ingest-analysis")>()),
  loadIngestAnalysis: vi.fn(async () => null),
  hasIngestAnalysis: vi.fn(async () => false),
}));

import { getServicePrincipal } from "@/lib/auth";
import { ingest, ingestUrl, ingestPdf, ingestImage, ingestDocument, reingest, IngestCancelledError } from "@/lib/ingest";
import { meetingExtractTarget, setSourceMeeting } from "@/lib/source-meeting";
import { recordTodoExtractError } from "@/lib/todos";
import { extractTodoCandidatesFromMeeting } from "@/lib/todo-extract";
import { enqueueTask } from "@/lib/tasks";
import { rebuildVectorStore } from "@/lib/embeddings";
import { getVectorSearchSettings } from "@/lib/config";
import { fixLintIssue } from "@/lib/lint-fix";
import { getIngestJob, updateIngestJob } from "@/lib/ingest-jobs";
import { readStagedBytes, readStagedText, deleteStaged } from "@/lib/ingest-staging";
import { preserveDocumentSources } from "@/lib/document-sources";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { fetchPdfBytes } from "@/lib/fetch";
import { extractStructuredKnowledge } from "@/lib/structured-knowledge";
import {
  completeGraphifyPage,
  failGraphifyPages,
  startGraphifyPage,
} from "@/lib/graphify-jobs";
import { deliverMonitorDigest } from "@/lib/monitor-digests";
import { runResearchProject } from "@/lib/research-runtime";
// NOT mocked, unlike `@/lib/research-runtime` above — so the class this file
// throws is the same class the route's `instanceof` arm imports.
import { ResearchProjectNotFoundError } from "@/lib/research-projects";
import { StoreFaultError } from "@/lib/errors";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";

const mockedGetService = vi.mocked(getServicePrincipal);
const mockedEnqueueTask = vi.mocked(enqueueTask);
const mockedMeetingTarget = vi.mocked(meetingExtractTarget);
const mockedSetMeeting = vi.mocked(setSourceMeeting);
const mockedExtractTodos = vi.mocked(extractTodoCandidatesFromMeeting);
const mockedRecordTodoError = vi.mocked(recordTodoExtractError);
const mockedRebuild = vi.mocked(rebuildVectorStore);
const mockedVector = vi.mocked(getVectorSearchSettings);
const mockedIngest = vi.mocked(ingest);
const mockedIngestUrl = vi.mocked(ingestUrl);
const mockedIngestPdf = vi.mocked(ingestPdf);
const mockedIngestImage = vi.mocked(ingestImage);
const mockedIngestDocument = vi.mocked(ingestDocument);
const mockedReingest = vi.mocked(reingest);
const mockedFixLint = vi.mocked(fixLintIssue);
const mockedGetJob = vi.mocked(getIngestJob);
const mockedUpdateJob = vi.mocked(updateIngestJob);
const mockedReadStagedBytes = vi.mocked(readStagedBytes);
const mockedReadStagedText = vi.mocked(readStagedText);
const mockedDeleteStaged = vi.mocked(deleteStaged);
const mockedPreserveDocuments = vi.mocked(preserveDocumentSources);
const mockedExtract = vi.mocked(enqueueExtract);
const mockedFetchPdf = vi.mocked(fetchPdfBytes);
const mockedExtractKnowledge = vi.mocked(extractStructuredKnowledge);
const mockedCompleteGraphify = vi.mocked(completeGraphifyPage);
const mockedFailGraphify = vi.mocked(failGraphifyPages);
const mockedStartGraphify = vi.mocked(startGraphifyPage);
const mockedDeliverMonitorDigest = vi.mocked(deliverMonitorDigest);
const mockedRunResearch = vi.mocked(runResearchProject);

import { addToVault } from "@/lib/vault";
const mockedAddToVault = vi.mocked(addToVault);

import { addAgentLearningPage } from "@/lib/agents";
const mockedAddLearning = vi.mocked(addAgentLearningPage);

import { enqueueReviewAfterIngest, ReviewDeliveryUnretainedError } from "@/lib/review-queue";
import { hasIngestAnalysis, loadIngestAnalysis } from "@/lib/ingest-analysis";
const mockedEnqueueReview = vi.mocked(enqueueReviewAfterIngest);
const mockedLoadAnalysis = vi.mocked(loadIngestAnalysis);
const mockedHasAnalysis = vi.mocked(hasIngestAnalysis);

async function run(body: unknown, headers?: Record<string, string>) {
  const { POST } = await import("@/app/api/tasks/run/route");
  return POST(
    new Request("http://localhost/api/tasks/run", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

let savedReadOnly: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  savedReadOnly = process.env.YOPEDIA_READONLY;
  // Cleared rather than inherited: a value exported in a developer's shell
  // would otherwise turn every case below into a 403.
  delete process.env.YOPEDIA_READONLY;
  mockedVector.mockReturnValue({
    enabled: true,
    provider: null,
    baseUrl: null,
    model: null,
    hasKey: false,
  });
  mockedGetJob.mockResolvedValue(null);
  mockedExtractKnowledge.mockReset();
  mockedStartGraphify.mockReset();
  mockedStartGraphify.mockResolvedValue({
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    job: {} as any,
    shouldRun: true,
  });
  mockedCompleteGraphify.mockReset();
  mockedCompleteGraphify.mockResolvedValue({} as never);
  mockedFailGraphify.mockReset();
  mockedFailGraphify.mockResolvedValue({} as never);
  mockedDeliverMonitorDigest.mockResolvedValue({
    id: "mdg_1234567890abcdef",
    owner: "alice",
    email: { status: "sent", attempts: 1 },
  } as never);
  mockedMeetingTarget.mockReset();
  mockedMeetingTarget.mockImplementation(
    async (_owner: string, input: { origin?: string; sourcePath?: string }) =>
      input.origin === "plaud" ? { sourcePath: input.sourcePath } : null,
  );
  mockedExtractTodos.mockReset();
  mockedExtractTodos.mockResolvedValue([]);
  // Default: authenticated as the service principal.
  mockedGetService.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
});

afterEach(() => {
  if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = savedReadOnly;
});

describe("POST /api/tasks/run", () => {
  it("401s without the service token (no other side effects)", async () => {
    mockedGetService.mockReturnValue(null);
    const res = await run({ kind: "maintain", op: "staleness", slug: "p" });
    expect(res.status).toBe(401);
    expect(mockedReingest).not.toHaveBeenCalled();
  });

  it("400s a malformed task (poison → don't retry)", async () => {
    const res = await run({ kind: "bogus" });
    expect(res.status).toBe(400);
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("400s the retired reconcile task kinds as malformed (poison)", async () => {
    // reconcile-from-talk is retired: such queue messages must parse as
    // malformed (400 → ack/drop), never fall through to another handler.
    const legacy = await run({ kind: "reconcile", slug: "p", threadIndex: 0 });
    expect(legacy.status).toBe(400);
    expect(await legacy.json()).toEqual({ error: "malformed task" });
    const maintain = await run({
      kind: "maintain",
      op: "reconcile",
      slug: "p",
      threadIndex: 1,
    });
    expect(maintain.status).toBe(400);
    expect(await maintain.json()).toEqual({ error: "malformed task" });
    expect(mockedReingest).not.toHaveBeenCalled();
    expect(mockedFixLint).not.toHaveBeenCalled();
  });

  it("dispatches a persisted monitor digest for queued email delivery", async () => {
    const res = await run({
      kind: "deliver-monitor-digest",
      digestId: "mdg_1234567890abcdef",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(mockedDeliverMonitorDigest).toHaveBeenCalledWith(
      "alice",
      "mdg_1234567890abcdef",
    );
  });

  it("advances a tracked Graphify page and avoids replaying completed work", async () => {
    const graphifyJobId = "graphify_12345678-1234-1234-1234-123456789abc";
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedExtractKnowledge.mockResolvedValue({ records: [], relations: [] } as any);
    const task = {
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
      graphifyJobId,
    };

    const completed = await run(task, { "X-Yopedia-Queue-Attempt": "1" });
    expect(completed.status).toBe(200);
    expect(mockedStartGraphify).toHaveBeenCalledWith("alice", graphifyJobId, "notes");
    expect(mockedExtractKnowledge).toHaveBeenCalledWith("alice", "notes");
    expect(mockedCompleteGraphify).toHaveBeenCalledWith("alice", graphifyJobId, "notes");

    vi.clearAllMocks();
    mockedGetService.mockReturnValue({ id: "service:yopedia", handle: "yopedia" });
    mockedStartGraphify.mockResolvedValue({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      job: {} as any,
      shouldRun: false,
    });
    const replay = await run(task, { "X-Yopedia-Queue-Attempt": "2" });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(mockedExtractKnowledge).not.toHaveBeenCalled();
    expect(mockedCompleteGraphify).not.toHaveBeenCalled();
  });

  it("records a Graphify failure only on the final queue delivery", async () => {
    const graphifyJobId = "graphify_12345678-1234-1234-1234-123456789abc";
    mockedExtractKnowledge.mockRejectedValue(new Error("provider unavailable"));
    const task = {
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
      graphifyJobId,
    };

    const transient = await run(task, { "X-Yopedia-Queue-Attempt": "1" });
    expect(transient.status).toBe(500);
    expect(mockedFailGraphify).not.toHaveBeenCalled();

    const terminal = await run(task, { "X-Yopedia-Queue-Attempt": "4" });
    expect(terminal.status).toBe(500);
    expect(mockedFailGraphify).toHaveBeenCalledWith(
      "alice",
      graphifyJobId,
      ["notes"],
      "provider unavailable",
    );
  });

  it("dispatches an ingest task by URL", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "made" } as any);
    const res = await run({ kind: "ingest", url: "https://example.com", owner: "alice" });
    expect(res.status).toBe(200);
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://example.com",
      expect.objectContaining({ owner: "alice" }),
    );
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("agent ingest: threads pageType/triggeredBy/sourceType to the pipeline", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "k" } as any);
    const res = await run({
      kind: "ingest",
      content: "note",
      title: "N",
      owner: "alice--yoyo",
      author: "alice--yoyo",
      triggeredBy: "alice--yoyo",
      pageType: "agent-knowledge",
      sourceType: "text",
      learningFor: "alice--yoyo", // real addAgentLearningPage is fail-soft (no agent)
    });
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      "N",
      "note",
      expect.objectContaining({
        owner: "alice--yoyo",
        author: "alice--yoyo",
        triggeredBy: "alice--yoyo",
        pageType: "agent-knowledge",
        sourceType: "text",
      }),
    );
  });

  it("threads email provenance through the queued text ingest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "emailed-note" } as any);
    const res = await run({
      kind: "ingest",
      content: "Email body",
      title: "Emailed note",
      owner: "alice",
      author: "alice",
      triggeredBy: "alice",
      sourceType: "email",
      email: {
        from: "alice@example.com",
        to: "ingest@example.com",
        subject: "Emailed note",
        messageId: "<email@example.com>",
        attachmentNames: [],
      },
    });
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      "Emailed note",
      "Email body",
      expect.objectContaining({ sourceType: "email", owner: "alice" }),
    );
  });

  it("attaches the page to the agent's learnings on success (learningFor)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "k" } as any);
    const res = await run({
      kind: "ingest",
      content: "note",
      owner: "alice--yoyo",
      author: "alice--yoyo",
      pageType: "agent-knowledge",
      learningFor: "alice--yoyo",
    });
    expect(res.status).toBe(200);
    expect(mockedAddLearning).toHaveBeenCalledWith("alice--yoyo", "k");
  });

  it("learning-page attach failure is fail-soft (the ingest still completes)", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "k" } as any);
    mockedAddLearning.mockRejectedValueOnce(new Error("storage down"));
    const res = await run({
      kind: "ingest",
      content: "note",
      learningFor: "alice--yoyo",
    });
    expect(res.status).toBe(200); // not failed by the orphan
  });

  it("ingest triggeredBy defaults to author when not provided", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "x" } as any);
    await run({ kind: "ingest", url: "https://e.com", owner: "o", author: "a" });
    expect(mockedIngestUrl).toHaveBeenCalledWith(
      "https://e.com",
      expect.objectContaining({ author: "a", triggeredBy: "a" }),
    );
  });

  it("routes a leftover URL pdf task (source:pdf) to extract, not ingestPdf", async () => {
    const res = await run({
      kind: "ingest",
      url: "https://x/a.pdf",
      source: "pdf",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, extract: true });
    expect(mockedFetchPdf).toHaveBeenCalledWith("https://x/a.pdf");
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "alice",
        format: "pdf",
        filename: "a.pdf",
      }),
    );
    expect(mockedIngestPdf).not.toHaveBeenCalled();
    expect(mockedIngestUrl).not.toHaveBeenCalled();
  });

  it("routes a URL image task (source:image) to ingestImage", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestImage.mockResolvedValue({ primarySlug: "img-page" } as any);
    const res = await run({
      kind: "ingest",
      url: "https://x/a.png",
      source: "image",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(mockedIngestImage).toHaveBeenCalledWith(
      { imageUrl: "https://x/a.png" },
      expect.objectContaining({ owner: "alice" }),
    );
  });

  it("diverts a staged pdf left by an older build to the sidecar, and deletes the blob", async () => {
    // Was: "reads a staged pdf from R2, ingests it". Story 7.5 took the PDF
    // parser off the Worker, so the only remaining source of such a task is a
    // queue written before the cutover. It is diverted, not parsed — that is
    // what lets the cutover deploy without draining the queue first.
    const res = await run({
      kind: "ingest",
      owner: "alice",
      staged: { key: "raw/uploads/j/doc.pdf", kind: "pdf", filename: "doc.pdf" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, extract: true });
    expect(mockedReadStagedBytes).toHaveBeenCalledWith("raw/uploads/j/doc.pdf");
    expect(mockedExtract).toHaveBeenCalledTimes(1);
    expect(mockedExtract.mock.calls[0][0]).toMatchObject({
      owner: "alice",
      format: "pdf",
      filename: "doc.pdf",
    });
    expect(mockedIngestPdf).not.toHaveBeenCalled();
    // The staging blob still goes: the bytes now live under `raw/sources/`.
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/doc.pdf");
  });

  it("forwards a user-supplied title to extract/ingestImage across the queue", async () => {
    // Regression: title rode the task but was dropped from the consumer opts, so
    // a typed PDF/image title was ignored on the production (queued) path (and
    // for images the title also drives the slug).
    await run({ kind: "ingest", url: "https://x/a.pdf", source: "pdf", owner: "alice", title: "My Doc" });
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({ title: "My Doc", format: "pdf" }),
    );
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestImage.mockResolvedValue({ primarySlug: "i" } as any);
    await run({
      kind: "ingest",
      owner: "alice",
      title: "My Pic",
      staged: { key: "raw/uploads/j/p.png", kind: "image", filename: "p.png" },
    });
    expect(mockedIngestImage).toHaveBeenLastCalledWith(
      expect.objectContaining({ filename: "p.png" }),
      expect.objectContaining({ title: "My Pic" }),
    );
  });

  it("reads a staged image from R2, ingests it, and deletes the blob", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestImage.mockResolvedValue({ primarySlug: "staged-img" } as any);
    const res = await run({
      kind: "ingest",
      owner: "alice",
      staged: { key: "raw/uploads/j/p.png", kind: "image", filename: "p.png", contentType: "image/png" },
    });
    expect(res.status).toBe(200);
    expect(mockedReadStagedBytes).toHaveBeenCalledWith("raw/uploads/j/p.png");
    expect(mockedIngestImage).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "p.png", contentType: "image/png" }),
      expect.objectContaining({ owner: "alice" }),
    );
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/p.png");
  });

  it("diverts a staged DOCX to the sidecar, but still ingests a CSV here", async () => {
    // The divert is by FORMAT, not by staged kind: `document` covers both the
    // office files the extract crate reads and the CSV/TSV it does not. Losing
    // that split either strands a spreadsheet on a queue no crate drains, or
    // keeps the Worker parser alive for DOCX.
    const docx = await run({
      kind: "ingest",
      owner: "alice",
      staged: {
        key: "raw/uploads/j/plan.docx",
        kind: "document",
        filename: "plan.docx",
      },
    });
    expect(docx.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledTimes(1);
    expect(mockedIngestDocument).not.toHaveBeenCalled();
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/plan.docx");

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestDocument.mockResolvedValue({ primarySlug: "staged-doc" } as any);
    const csv = await run({
      kind: "ingest",
      owner: "alice",
      staged: {
        key: "raw/uploads/j/rows.csv",
        kind: "document",
        filename: "rows.csv",
        contentType: "text/csv",
      },
    });
    expect(csv.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledTimes(1); // still just the DOCX
    expect(mockedIngestDocument).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "rows.csv" }),
      expect.objectContaining({ owner: "alice" }),
    );
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/rows.csv");
  });

  it("does not delete staging when enqueueExtract reports a failure without throwing", async () => {
    // `enqueueExtract` returns `{ error }` for its one partial failure: bytes
    // stored, job records not written. Read as a divert it deleted the staging
    // blob and answered `{ ok: true, extract: true }` for a document with no
    // record anywhere — the queue message acknowledged, the Worker parse
    // skipped, and nothing left that could ever compile it.
    mockedExtract.mockResolvedValueOnce({
      path: "raw/sources/doc/abc.pdf",
      jobId: "job",
      extractId: "extract",
      error: "the job store refused the write",
    } as never);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestPdf.mockResolvedValue({ primarySlug: "p" } as any);

    const res = await run({
      kind: "ingest",
      owner: "alice",
      staged: { key: "raw/uploads/j/doc.pdf", kind: "pdf", filename: "doc.pdf" },
    });
    // 5xx, which is what makes the consumer redeliver instead of acking.
    expect(res.status).toBe(503);
    expect(await res.json()).not.toMatchObject({ extract: true });
    // Not quietly re-parsed on the Worker either — that path ends in the same
    // `deleteStaged`, so "fall through" and "delete the only copy" are the
    // same branch.
    expect(mockedIngestPdf).not.toHaveBeenCalled();
    // The staged bytes SURVIVE, so the task can be retried.
    expect(mockedDeleteStaged).not.toHaveBeenCalledWith("raw/uploads/j/doc.pdf");
  });

  it("returns a completed tracked ingest on queue replay without rereading deleted staging", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "job-done",
      owner: "alice",
      status: "done",
      slug: "live-verification",
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
    });
    const res = await run({
      kind: "ingest",
      owner: "alice",
      jobId: "job-done",
      staged: {
        key: "raw/uploads/job-done/plan.docx",
        kind: "document",
        filename: "plan.docx",
      },
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({
      ok: true,
      slug: "live-verification",
      replayed: true,
    });
    expect(mockedReadStagedBytes).not.toHaveBeenCalled();
    expect(mockedIngestDocument).not.toHaveBeenCalled();
    expect(mockedUpdateJob).not.toHaveBeenCalled();
    expect(mockedDeleteStaged).toHaveBeenCalledWith(
      "raw/uploads/job-done/plan.docx",
    );
  });

  it("folds staged email attachments into the email body", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "email-with-sheet" } as any);
    const res = await run({
      kind: "ingest",
      title: "Planning",
      content: "Email body",
      owner: "alice",
      sourceType: "email",
      email: {
        from: "alice@example.com",
        to: "ingest@example.com",
        subject: "Planning",
        messageId: "<planning@example.com>",
        attachmentNames: ["plan.csv"],
      },
      attachments: [{ key: "raw/uploads/j/plan.csv", filename: "plan.csv", contentType: "text/csv" }],
    });
    expect(res.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      "Planning",
      expect.stringContaining("# Attachment: plan.csv"),
      expect.objectContaining({ sourceType: "email" }),
    );
    expect(mockedPreserveDocuments).toHaveBeenCalledWith(
      "email-with-sheet",
      "alice",
      [expect.objectContaining({ filename: "plan.csv" })],
    );
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/plan.csv");
  });

  it("reads staged text from R2, ingests it, and deletes the blob", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "staged-text" } as any);
    const res = await run({
      kind: "ingest",
      owner: "alice",
      title: "Big Paste",
      staged: { key: "raw/uploads/j/text.md", kind: "text" },
    });
    expect(res.status).toBe(200);
    expect(mockedReadStagedText).toHaveBeenCalledWith("raw/uploads/j/text.md");
    expect(mockedIngest).toHaveBeenCalledWith(
      "Big Paste",
      "staged pasted text",
      expect.objectContaining({ owner: "alice" }),
    );
    expect(mockedDeleteStaged).toHaveBeenCalledWith("raw/uploads/j/text.md");
  });

  it("keeps a staged blob when a transient ingest failure should be retried", async () => {
    // The subject is the retry contract, not the format: staged PDFs now divert
    // to the sidecar before any parser runs, so this uses a staged IMAGE — the
    // remaining staged kind the Worker still ingests itself.
    mockedIngestImage.mockRejectedValueOnce(new Error("R2 read flaked"));
    const res = await run({
      kind: "ingest",
      owner: "alice",
      jobId: "job-x",
      staged: { key: "raw/uploads/j/shot.png", kind: "image" },
    });
    expect(res.status).toBe(500); // transient → retry
    expect(mockedDeleteStaged).not.toHaveBeenCalled();
    // The tracked job is recorded failed.
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-x", {
      status: "retrying",
      error: "R2 read flaked",
    });
  });

  it("dispatches maintain:fix via fixLintIssue (deterministic lint fix)", async () => {
    mockedFixLint.mockResolvedValue({ success: true, slug: "p", message: "fixed" });
    const res = await run({
      kind: "maintain",
      op: "fix",
      slug: "p",
      lintType: "unmigrated-page",
    });
    expect(res.status).toBe(200);
    expect(mockedFixLint).toHaveBeenCalledWith("unmigrated-page", "p", undefined);
  });

  it("dispatches maintain:fix broken-link with targetSlug", async () => {
    mockedFixLint.mockResolvedValue({ success: true, slug: "p", message: "removed dead link" });
    const res = await run({
      kind: "maintain",
      op: "fix",
      slug: "p",
      lintType: "broken-link",
      targetSlug: "dead-page",
    });
    expect(res.status).toBe(200);
    expect(mockedFixLint).toHaveBeenCalledWith("broken-link", "p", "dead-page");
  });

  it("dispatches maintain:staleness via reingest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedReingest.mockResolvedValue({ primarySlug: "s" } as any);
    const res = await run({ kind: "maintain", op: "staleness", slug: "s" });
    expect(res.status).toBe(200);
    expect(mockedReingest).toHaveBeenCalledWith("s", expect.objectContaining({ author: "yoyo" }));
  });

  it("drives a tracked ingest job processing → done on success", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "made" } as any);
    const res = await run({
      kind: "ingest",
      url: "https://youtu.be/x",
      owner: "alice",
      jobId: "job-1",
    });
    expect(res.status).toBe(200);
    expect(mockedUpdateJob).toHaveBeenNthCalledWith(1, "job-1", {
      status: "processing",
      stage: "extracting",
    });
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-1", {
      status: "done",
      stage: "complete",
      slug: "made",
    });
  });

  it("records a tracked ingest job as failed when ingest throws", async () => {
    mockedIngestUrl.mockRejectedValueOnce(new Error("LLM timeout"));
    const res = await run({
      kind: "ingest",
      url: "https://youtu.be/x",
      owner: "alice",
      jobId: "job-2",
    });
    expect(res.status).toBe(500); // transient → retry
    expect(mockedUpdateJob).toHaveBeenNthCalledWith(1, "job-2", {
      status: "processing",
      stage: "extracting",
    });
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-2", {
      status: "retrying",
      error: "LLM timeout",
    });
  });

  it("leaves an untracked ingest task (no jobId) alone — no job writes", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "made" } as any);
    await run({ kind: "ingest", url: "https://example.com", owner: "alice" });
    expect(mockedUpdateJob).not.toHaveBeenCalled();
  });

  it("maps a 'not found' failure to 422 (poison), other failures to 500 (retry)", async () => {
    mockedReingest.mockRejectedValueOnce(new Error('page "x" not found'));
    expect((await run({ kind: "maintain", op: "staleness", slug: "x" })).status).toBe(422);

    mockedReingest.mockRejectedValueOnce(new Error("LLM timeout"));
    expect((await run({ kind: "maintain", op: "staleness", slug: "x" })).status).toBe(500);
  });

  /**
   * DW-427. `reingest`'s merge base now reads `{ fresh: true, strict: true }`,
   * so a provider blip arrives here as the STORAGE error rather than as
   * `Cannot re-ingest: page "x" not found`. This row pins the shape that error
   * takes against the classifier the fix depends on: the store-fault row runs
   * ahead of `/not found/i`, so even a store fault whose sentence reads like a
   * miss gets the transient 500 and the queue's bounded retry — never the 422
   * poison, which is permanent and would strand a repairable page.
   */
  it("500s an errno-coded store fault out of reingest, even worded like a miss", async () => {
    mockedReingest.mockRejectedValueOnce(
      Object.assign(new Error("EIO: i/o error, page \"x\" not found on this volume"), {
        code: "EIO",
      }),
    );

    const res = await run({ kind: "maintain", op: "staleness", slug: "x" });

    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({
      error: 'EIO: i/o error, page "x" not found on this volume',
    });
  });

  /**
   * DW-482. `parseRegistry` refuses a corrupt research registry (DW-297) and
   * that refusal used to reach the final 500 by FALL-THROUGH: past
   * `/not found/i`, past `ClientInputError`, past the ingest cap, landing on
   * the default. Bounded queue retry to the DLQ is the right answer for a
   * fault we can repair in place — but nothing said so, and one whose
   * sentence happened to read "not found" would have been poisoned at 422
   * instead. The store-fault row now decides it, ahead of the ladder.
   */
  describe("a run-research task whose project store refuses", () => {
    const RESEARCH_TASK = {
      kind: "run-research",
      owner: "alice",
      projectId: "11111111-1111-4111-8111-111111111111",
    };

    it("500s a StoreFaultError so the queue retries within its bound", async () => {
      mockedRunResearch.mockRejectedValueOnce(
        new StoreFaultError("Research projects file is not a list."),
      );

      const res = await run(RESEARCH_TASK);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "Research projects file is not a list.",
      });
    });

    it("500s a store fault worded like a miss — never the 422 poison", async () => {
      // The store-fault row runs BEFORE `/not found/i`, which is the whole
      // point: an unreadable file is not a missing page.
      mockedRunResearch.mockRejectedValueOnce(
        new StoreFaultError("Research projects file not found on this volume."),
      );

      expect((await run(RESEARCH_TASK)).status).toBe(500);
    });

    /**
     * DW-725. The row above passes even against an `instanceof` check, because
     * the fixture throws through the same module copy the route imported. This
     * one is the foreign-copy case a duplicated module graph produces — vitest's
     * two projects, a bundler splitting server and edge chunks, the stdio MCP
     * entry compiled separately. It carries no errno `code` to fall back on, so
     * an identity check answers `false` and the sentence's "not found" lands it
     * on the 422 poison row instead of the retryable 500. Asserting on the
     * classifier alone would not see the misroute; the STATUS is the surface
     * DW-725 names as harmed.
     */
    it("500s a FOREIGN-COPY store fault worded like a miss — never the 422 poison", async () => {
      mockedRunResearch.mockRejectedValueOnce(
        Object.assign(new Error("Research projects file not found on this volume."), {
          name: "StoreFaultError",
        }),
      );

      const res = await run(RESEARCH_TASK);

      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({
        error: "Research projects file not found on this volume.",
      });
    });

    it("500s a Node errno fault off the filesystem", async () => {
      mockedRunResearch.mockRejectedValueOnce(
        Object.assign(new Error("EINVAL: invalid argument, open '/data/alice/research.json'"), {
          code: "EINVAL",
        }),
      );

      expect((await run(RESEARCH_TASK)).status).toBe(500);
    });

    it("500s a network errno — infrastructure beneath us, never the 422 poison", async () => {
      // DW-685. The row's verdict for `ECONNREFUSED` is unchanged; only the
      // name and the log line stopped pointing at the disk for it. The
      // SENTENCE is what this row exists for: `logger.error` reaches
      // `console.error` at the test default level, and the operator reading it
      // is the person DW-685 was sent to the wrong subsystem by.
      const logged = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        mockedRunResearch.mockRejectedValueOnce(
          Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:443"), {
            code: "ECONNREFUSED",
          }),
        );

        expect((await run(RESEARCH_TASK)).status).toBe(500);

        const sentences = logged.mock.calls.map((call) => String(call[1]));
        expect(sentences).toContain('task "run-research" hit an infrastructure fault');
        expect(sentences.some((line) => /store fault/i.test(line))).toBe(false);
      } finally {
        logged.mockRestore();
      }
    });

    it("still 422s a genuine miss that is not a store fault", async () => {
      mockedRunResearch.mockRejectedValueOnce(new Error('research project "x" not found'));

      expect((await run(RESEARCH_TASK)).status).toBe(422);
    });

    /**
     * DW-650. The 422 for a research miss used to ride entirely on
     * `/not found/i` agreeing with `ResearchProjectNotFoundError`'s DEFAULT
     * message — a coupling nothing pinned, so rewording either
     * `runResearchProject` throw would have flipped a permanent miss into a
     * 500 retried to the DLQ.
     *
     * The message here is a STAND-IN for any such rewording, not a sentence
     * this door sees today: `runResearchProject` throws the default at both
     * sites, and "Research project is retired" is the wording
     * `queueResearchProject` gives the same class at the research door. What
     * the row pins is the ROUTE's decision — it fails against a regex-only
     * ladder and passes only against the typed arm checked first.
     */
    it("422s a typed ResearchProjectNotFoundError whose message never says 'not found'", async () => {
      mockedRunResearch.mockRejectedValueOnce(
        new ResearchProjectNotFoundError("Research project is retired"),
      );

      const res = await run(RESEARCH_TASK);

      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: "Research project is retired" });
    });

    it("422s a default-message ResearchProjectNotFoundError, as it always did", async () => {
      mockedRunResearch.mockRejectedValueOnce(new ResearchProjectNotFoundError());

      expect((await run(RESEARCH_TASK)).status).toBe(422);
    });
  });

  it("keeps the ingest auto-retry cap at 422 even for a store fault", async () => {
    // Block-if: this bundle pins `run-research`, it does not re-decide ingest.
    // At the cap the ingest 422 wins whatever the failure was.
    mockedIngestUrl.mockRejectedValueOnce(
      Object.assign(new Error("EINVAL: invalid argument, open '/data/staging'"), {
        code: "EINVAL",
      }),
    );

    const res = await run(
      { kind: "ingest", url: "https://example.com", owner: "alice", jobId: "job-cap" },
      { "X-Yopedia-Queue-Attempt": "3" },
    );

    expect(res.status).toBe(422);
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-cap", {
      status: "failed",
      error: "EINVAL: invalid argument, open '/data/staging'",
    });
  });

  it("files into vault when ingest task carries vaultId", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "page-a" } as any);
    const res = await run({
      kind: "ingest",
      url: "https://example.com",
      owner: "alice",
      vaultId: "alice--my-vault",
    });
    expect(res.status).toBe(200);
    expect(mockedAddToVault).toHaveBeenCalledWith("alice--my-vault", "page-a");
  });

  it("does not call addToVault when no vaultId on ingest task", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngestUrl.mockResolvedValue({ primarySlug: "page-b" } as any);
    const res = await run({
      kind: "ingest",
      url: "https://example.com",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(mockedAddToVault).not.toHaveBeenCalled();
  });

  it("enqueues extract-actions for a non-Plaud ingest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "notes" } as any);
    const res = await run({
      kind: "ingest",
      content: "body",
      title: "Notes",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-actions", slug: "notes" }),
    );
  });

  it("marks a skipped ingest skipped and does not enqueue extract-actions", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "existing", skipped: true } as any);
    const res = await run({
      kind: "ingest",
      content: "same bytes",
      owner: "alice",
      jobId: "job-skip",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, skipped: true, slug: "existing" });
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-skip", {
      status: "skipped",
      stage: "complete",
      slug: "existing",
    });
    expect(mockedEnqueueTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-actions" }),
    );
  });

  it("skips extract-actions for Plaud-origin ingest and still extracts knowledge", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "meet" } as any);
    const res = await run({
      kind: "ingest",
      content: "transcript",
      title: "Standup",
      owner: "alice",
      origin: "plaud",
      sourcePath: "raw/sources/meet/abc.md",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-actions" }),
    );
    expect(mockedEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-knowledge", slug: "meet" }),
    );
    expect(mockedEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "extract-todo-candidates",
        slug: "meet",
        owner: "alice",
        sourcePath: "raw/sources/meet/abc.md",
      }),
    );
    expect(mockedSetMeeting).toHaveBeenCalledWith(
      "alice",
      "raw/sources/meet/abc.md",
      true,
    );
  });

  it("does not enqueue extract-todo-candidates when ingest is skipped", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "existing", skipped: true } as any);
    const res = await run({
      kind: "ingest",
      content: "same bytes",
      owner: "alice",
      origin: "plaud",
      jobId: "job-skip-todos",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-todo-candidates" }),
    );
  });

  it("does not enqueue extract-todo-candidates when ingest fails", async () => {
    mockedIngest.mockRejectedValueOnce(new Error("LLM timeout"));
    const res = await run({
      kind: "ingest",
      content: "transcript",
      owner: "alice",
      origin: "plaud",
    });
    expect(res.status).toBe(500);
    expect(mockedEnqueueTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-todo-candidates" }),
    );
    expect(mockedEnqueueReview).not.toHaveBeenCalled();
  });

  it("does not enqueue Review items when ingest is skipped and no analysis exists", async () => {
    mockedHasAnalysis.mockResolvedValue(false);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "existing", skipped: true } as any);
    const res = await run({
      kind: "ingest",
      content: "same bytes",
      owner: "alice",
      jobId: "job-skip-review",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueReview).not.toHaveBeenCalled();
  });

  it("retries Review enqueue when a skipped ingest already has analysis", async () => {
    mockedHasAnalysis.mockResolvedValue(true);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "existing", skipped: true } as any);
    const res = await run({
      kind: "ingest",
      content: "same bytes",
      owner: "alice",
      jobId: "job-skip-review-retry",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "existing",
      jobId: "job-skip-review-retry",
    });
  });

  it("keeps a skipped ingest successful when the Analysis existence read fails", async () => {
    mockedHasAnalysis
      .mockResolvedValueOnce(false)
      .mockRejectedValueOnce(new Error("analysis unavailable"));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "existing", skipped: true } as any);
    const res = await run({
      kind: "ingest",
      content: "same bytes",
      owner: "alice",
      jobId: "job-skip-analysis-fail",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "existing",
      jobId: "job-skip-analysis-fail",
    });
  });

  it("enqueues Review items after a successful compile with analysis", async () => {
    mockedLoadAnalysis.mockResolvedValue({
      entities: [],
      concepts: [],
      arguments: [],
      existingLinks: [],
      tensions: ["Sources disagree."],
      recommendedStructure: "",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "topic" } as any);
    const res = await run({
      kind: "ingest",
      content: "body",
      title: "Topic",
      owner: "alice",
      jobId: "job-review",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "topic",
      jobId: "job-review",
    });
  });

  it("does not mark a compile done when Review delivery is not retained", async () => {
    mockedEnqueueReview.mockRejectedValueOnce(new ReviewDeliveryUnretainedError());
    mockedIngest.mockResolvedValue({ primarySlug: "topic" } as never);
    const res = await run({
      kind: "ingest",
      content: "body",
      title: "Topic",
      owner: "alice",
      jobId: "job-unretained",
    });
    expect(res.status).toBe(200);
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-unretained", {
      status: "failed",
      error: "Review delivery was not retained",
      slug: "topic",
    });
    expect(mockedUpdateJob).not.toHaveBeenCalledWith(
      "job-unretained",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("enqueues Review under the author when triggeredBy and owner are absent", async () => {
    mockedIngest.mockResolvedValue({ primarySlug: "topic" } as never);
    const res = await run({
      kind: "ingest",
      content: "body",
      title: "Topic",
      author: "solo-author",
      jobId: "job-author-only",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueReview).toHaveBeenCalledWith({
      owner: "solo-author",
      pageSlug: "topic",
      jobId: "job-author-only",
    });
  });

  it("does not enqueue extract-todo-candidates for a non-meeting ingest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "notes" } as any);
    mockedMeetingTarget.mockResolvedValueOnce(null);
    const res = await run({
      kind: "ingest",
      content: "body",
      title: "Notes",
      owner: "alice",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueTask).not.toHaveBeenCalledWith(
      expect.objectContaining({ kind: "extract-todo-candidates" }),
    );
  });

  it("enqueues extract-todo-candidates for a marked-meeting ingest", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    mockedIngest.mockResolvedValue({ primarySlug: "notes" } as any);
    mockedMeetingTarget.mockResolvedValueOnce({
      sourcePath: "raw/sources/notes/cafe.md",
    });
    const res = await run({
      kind: "ingest",
      content: "transcript",
      title: "Notes",
      owner: "alice",
      sourcePath: "raw/sources/notes/cafe.md",
    });
    expect(res.status).toBe(200);
    expect(mockedEnqueueTask).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "extract-todo-candidates",
        slug: "notes",
        owner: "alice",
        sourcePath: "raw/sources/notes/cafe.md",
      }),
    );
  });

  it("runs extract-todo-candidates and does not call proposeActionItems", async () => {
    mockedExtractTodos.mockResolvedValueOnce([]);
    const res = await run({
      kind: "extract-todo-candidates",
      slug: "meet",
      owner: "alice",
      sourcePath: "raw/sources/meet/abc.md",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, created: 0 });
    expect(mockedExtractTodos).toHaveBeenCalledWith(
      "alice",
      "meet",
      "raw/sources/meet/abc.md",
    );
  });

  it("records a visible extract error when extract-todo-candidates throws", async () => {
    mockedExtractTodos.mockRejectedValueOnce(new Error("no key"));
    const res = await run({
      kind: "extract-todo-candidates",
      slug: "meet",
      owner: "alice",
      sourcePath: "raw/sources/meet/abc.md",
    });
    expect(res.status).toBe(500);
    expect(mockedRecordTodoError).toHaveBeenCalledWith(
      "alice",
      expect.objectContaining({
        message: "no key",
        slug: "meet",
        sourcePath: "raw/sources/meet/abc.md",
      }),
    );
  });

  it("acks a cancelled ingest with 200 and does not write pages", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "job-cancel",
      owner: "alice",
      status: "processing",
      cancelled: true,
      createdAt: "2026-08-02T00:00:00.000Z",
      updatedAt: "2026-08-02T00:01:00.000Z",
    } as never);
    const res = await run({
      kind: "ingest",
      content: "note",
      owner: "alice",
      jobId: "job-cancel",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
    expect(mockedIngest).not.toHaveBeenCalled();
  });

  it("maps mid-write cancel to 200 rather than a retryable 500", async () => {
    mockedIngest.mockRejectedValueOnce(new IngestCancelledError());
    const res = await run({
      kind: "ingest",
      content: "note",
      owner: "alice",
      jobId: "job-mid",
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, cancelled: true });
  });

  it("stops auto-retrying ingest after three queue attempts", async () => {
    mockedIngestUrl.mockRejectedValueOnce(new Error("LLM timeout"));
    const res = await run(
      { kind: "ingest", url: "https://example.com", owner: "alice" },
      { "X-Yopedia-Queue-Attempt": "3" },
    );
    expect(res.status).toBe(422);
  });

  it("rebuilds embeddings for a tracked embed-backfill task", async () => {
    const res = await run({
      kind: "ingest",
      owner: "alice",
      jobId: "job-embed",
      rebuildEmbeddings: true,
    });
    expect(res.status).toBe(200);
    expect(mockedRebuild).toHaveBeenCalled();
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-embed", {
      status: "done",
      stage: "complete",
    });
  });

  it("poison-acks embed-backfill when vector search is off", async () => {
    mockedVector.mockReturnValue({
      enabled: false,
      provider: null,
      baseUrl: null,
      model: null,
      hasKey: false,
    });
    const res = await run({
      kind: "ingest",
      owner: "alice",
      jobId: "job-embed-off",
      rebuildEmbeddings: true,
    });
    expect(res.status).toBe(422);
    expect(mockedRebuild).not.toHaveBeenCalled();
    expect(mockedUpdateJob).toHaveBeenCalledWith("job-embed-off", {
      status: "failed",
      error: "Vector search is off.",
    });
  });
});

/**
 * DW-646. The read-only door on this route (`route.ts`, after the 401 and ahead
 * of `req.json()`) is published in `DEPLOY.md` as an operator alerting contract:
 * the status is 403 and the body is `READ_ONLY_REFUSAL.queuedWork`, a sentence
 * deliberately DIFFERENT from the scan's so an alert rule matching one never
 * fires on the other. Nothing referenced either half. The one door-coverage scan
 * that reaches this file matches `isReadOnlyError(` too, which the handler's
 * catch already spells — so deleting the early gate outright left the suite
 * green while the route answered 500 (or worse, ran the work).
 *
 * Modelled on `scan-route.test.ts`'s "on a read-only deployment" describe.
 *
 * One prose conflict that used to sit here: the route's own status contract
 * (`route.ts`, above the gate), the read-only comment in
 * `src/app/api/tasks/scan/route.ts` and `scan-route.test.ts` all said 4xx means
 * the consumer ACKS AND DROPS, which stopped being true of 403 when the gate
 * landed. DW-645 corrected all three, plus the gate comment itself — the ack
 * set is 400/404/422, and `task-consumer.test.ts` pins the 403 retry.
 */
describe("POST /api/tasks/run on a read-only deployment", () => {
  beforeEach(() => {
    process.env.YOPEDIA_READONLY = "1";
  });

  it("403s with the queued-work sentence, running no task at all", async () => {
    const res = await run({
      kind: "ingest",
      owner: "alice",
      url: "https://example.com/a",
    });

    expect(res.status).toBe(403);
    // The exact body, not just the status: `DEPLOY.md` quotes this sentence for
    // operators to match on, and a 403 carrying the scan's sentence (or a bare
    // "Forbidden") would break every rule written against the doc.
    expect(await res.json()).toEqual({ error: READ_ONLY_REFUSAL.queuedWork });
    // …and no handler ran. The gate's whole point is that the fetch and the two
    // LLM calls happen BEFORE any page write, so a refusal arriving later would
    // still have burned them.
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedIngestUrl).not.toHaveBeenCalled();
    expect(mockedIngestPdf).not.toHaveBeenCalled();
    expect(mockedIngestImage).not.toHaveBeenCalled();
    expect(mockedIngestDocument).not.toHaveBeenCalled();
    expect(mockedReingest).not.toHaveBeenCalled();
    expect(mockedFixLint).not.toHaveBeenCalled();
    expect(mockedRebuild).not.toHaveBeenCalled();
    expect(mockedEnqueueTask).not.toHaveBeenCalled();
    // Nor did the tracked job get marked `failed` for a refusal the deployment
    // stated for free — which is what the un-gated route's catch would have done.
    expect(mockedUpdateJob).not.toHaveBeenCalled();
  });

  it("refuses BOTH maintain arms with the same sentence", async () => {
    // The other task family through the same door. Both arms are driven because
    // each reaches a different writer and only one of them is the expensive one
    // the route's gate comment names: `op: "fix"` reaches `fixLintIssue`, a
    // whole page rewrite, and `op: "staleness"` reaches `reingest`. Asserting
    // `mockedFixLint` against a staleness body would be an assertion that cannot
    // fail with OR without the gate, which is the drift this suite exists to stop.
    //
    // `broken-link` carries a `targetSlug` because `parseTask` rejects it
    // without one — a body that parses to null would 400 past the writer and
    // make `not.toHaveBeenCalled()` vacuous once the gate is removed.
    const fix = await run({
      kind: "maintain",
      op: "fix",
      slug: "p",
      lintType: "broken-link",
      targetSlug: "dead-link",
    });

    expect(fix.status).toBe(403);
    expect(await fix.json()).toEqual({ error: READ_ONLY_REFUSAL.queuedWork });
    expect(mockedFixLint).not.toHaveBeenCalled();

    const staleness = await run({ kind: "maintain", op: "staleness", slug: "p" });

    expect(staleness.status).toBe(403);
    expect(await staleness.json()).toEqual({ error: READ_ONLY_REFUSAL.queuedWork });
    expect(mockedReingest).not.toHaveBeenCalled();
  });

  it("still 401s without the service token, so the gate stays behind auth", async () => {
    // Order matters at the wire: an unauthenticated caller must not be able to
    // read the deployment's read-only state off the status code.
    mockedGetService.mockReturnValue(null);

    const res = await run({ kind: "maintain", op: "staleness", slug: "p" });

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("refuses ahead of the body parse — an unparseable body still gets the 403", async () => {
    // The gate sits before `req.json()`, so garbage on the wire is answered with
    // the refusal rather than "invalid JSON body". Pinning this is what keeps
    // the gate from drifting down past the parse, where a 400 would tell the
    // consumer to ACK AND DROP the message instead of retrying it.
    const { POST } = await import("@/app/api/tasks/run/route");
    const res = await POST(
      new Request("http://localhost/api/tasks/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{ not json",
      }),
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: READ_ONLY_REFUSAL.queuedWork });
  });
});
