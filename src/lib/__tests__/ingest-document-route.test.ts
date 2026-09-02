import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn(), getServicePrincipal: vi.fn(() => null) }));
vi.mock("@/lib/ingest", () => ({ ingestDocument: vi.fn() }));
vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn(async () => false) }));
vi.mock("@/lib/ingest-jobs", () => ({
  createIngestJob: vi.fn(async () => ({})),
  updateIngestJob: vi.fn(async () => ({})),
}));
vi.mock("@/lib/ingest-staging", () => ({
  stageBytes: vi.fn(async () => "raw/uploads/job/document.docx"),
}));
vi.mock("@/lib/extract-dispatch", () => ({
  enqueueExtract: vi.fn(async () => ({
    path: "raw/sources/plan/abc.docx",
    jobId: "job",
    extractId: "extract",
    error: null,
  })),
}));
vi.mock("@/lib/source-sha256", () => ({ bytesSha256: vi.fn(async () => "ab".repeat(32)) }));

import { getPrincipal } from "@/lib/auth";
import { ClientInputError } from "@/lib/errors";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { ingestDocument } from "@/lib/ingest";
import { enqueueTask } from "@/lib/tasks";
import { POST } from "@/app/api/ingest/document/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIngest = vi.mocked(ingestDocument);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedExtract = vi.mocked(enqueueExtract);

function upload(file?: File, title?: string) {
  const form = new FormData();
  if (file) form.append("file", file);
  if (title) form.append("title", title);
  return new Request("http://localhost/api/ingest/document", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "alice", handle: "alice" } as never);
  mockedIngest.mockResolvedValue({ primarySlug: "quarterly-plan" } as never);
  mockedEnqueue.mockResolvedValue(false);
});

describe("POST /api/ingest/document", () => {
  it("requires a signed-in principal", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await POST(upload(new File(["x"], "plan.docx")) as never)).status).toBe(401);
  });

  it("rejects missing and unsupported files", async () => {
    expect((await POST(upload() as never)).status).toBe(400);
    expect((await POST(upload(new File(["x"], "program.exe")) as never)).status).toBe(400);
  });

  it("ingests supported files inline with owner attribution", async () => {
    const response = await POST(upload(new File(["csv"], "report.csv", { type: "text/csv" }), "Report") as never);
    expect(response.status).toBe(200);
    expect(mockedIngest).toHaveBeenCalledWith(
      expect.objectContaining({ filename: "report.csv", contentType: "text/csv" }),
      expect.objectContaining({ owner: "alice", author: "alice", title: "Report" }),
    );
  });

  it("stages the upload and enqueues a document task for a format no crate reads", async () => {
    // CSV keeps the staged path: the sidecar's extract crate does not read one,
    // and storing bytes nothing can extract is a slower way to lose them. This
    // is the case that pins the OLD route still working.
    mockedEnqueue.mockResolvedValue(true);
    const response = await POST(
      upload(new File(["a,b"], "rows.csv", { type: "text/csv" })) as never,
    );
    expect(response.status).toBe(200);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "ingest",
      staged: expect.objectContaining({ kind: "document", filename: "rows.csv" }),
    }));
    expect(mockedIngest).not.toHaveBeenCalled();
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("hands a DOCX to the extract job instead of parsing it on the Worker", async () => {
    // Epic 7's headline for this door. The Worker cannot reach the sidecar at
    // `127.0.0.1`, so an office parse attempted on this side is the bug — the
    // bytes are stored and an extract job is enqueued for the crate to claim.
    mockedEnqueue.mockResolvedValue(true);
    const response = await POST(upload(new File(["x"], "plan.docx")) as never);
    expect(response.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledTimes(1);
    expect(mockedExtract.mock.calls[0][0]).toMatchObject({
      owner: "alice",
      format: "docx",
      filename: "plan.docx",
    });
    expect(mockedIngest).not.toHaveBeenCalled();
    // No staged compile ahead of the extract: Ingest starts only once the
    // extracted text is in the kernel.
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("carries vault filing and tags onto the extract job", async () => {
    // The silent-loss case: a DOCX filed into a vault with tags used to reach
    // `ingestDocument`, which applied both. Rerouted without them, the Source
    // would compile into no vault and with no tags, and nothing would say so.
    const form = new FormData();
    form.append("file", new File(["x"], "plan.docx"));
    form.append("tags", "alpha, beta");
    const request = new Request("http://localhost/api/ingest/document", {
      method: "POST",
      body: form,
    });
    await POST(request as never);
    expect(mockedExtract.mock.calls[0][0].tags).toEqual(["alpha", "beta"]);
  });

  /**
   * DW-578. This door's catch has no residual message ladder: a caught value is
   * either a client-input error (400 + `logger.warn`) or a server fault (500 +
   * `logger.error`). So the classifier is the ONLY thing deciding which, and a
   * misclassification here is silent — the caller gets a 500 for their own bad
   * file and retries it forever.
   */
  describe("client-input classification does not depend on module identity", () => {
    const csv = () =>
      upload(new File(["csv"], "report.csv", { type: "text/csv" }), "Report");

    it("400s a same-realm ClientInputError", async () => {
      mockedIngest.mockRejectedValueOnce(
        new ClientInputError("The document is empty."),
      );
      const response = await POST(csv() as never);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "The document is empty." });
    });

    it("400s a FOREIGN-REALM ClientInputError — the same status, by name not identity", async () => {
      // A second copy of `errors.ts`: same `name`, different constructor, which
      // is what vitest's two projects and a split bundle actually produce.
      // `instanceof` answers false for it, so this row — and only this row —
      // fails if the route goes back to classifying by identity.
      const foreign = Object.assign(new Error("The document is empty."), {
        name: "ClientInputError",
      });
      expect(foreign).not.toBeInstanceOf(ClientInputError);
      mockedIngest.mockRejectedValueOnce(foreign);

      const response = await POST(csv() as never);

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "The document is empty." });
    });

    it("still 500s a plain Error — the 400 branch did not widen", async () => {
      mockedIngest.mockRejectedValueOnce(new Error("disk on fire"));
      expect((await POST(csv() as never)).status).toBe(500);
    });
  });
});
