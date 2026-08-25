import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(() => null),
}));
vi.mock("@/lib/fetch", async (orig) => ({
  ...(await orig<typeof import("@/lib/fetch")>()),
  fetchPdfBytes: vi.fn(async () => ({
    bytes: new Uint8Array([1, 2, 3]).buffer,
    filename: "doc.pdf",
    title: "doc",
  })),
}));
vi.mock("@/lib/extract-dispatch", () => ({
  enqueueExtract: vi.fn(async () => ({
    path: "raw/sources/report/abc.pdf",
    jobId: "job",
    extractId: "extract",
    error: null,
  })),
}));
vi.mock("@/lib/source-sha256", () => ({ bytesSha256: vi.fn(async () => "ab".repeat(32)) }));

import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { fetchPdfBytes } from "@/lib/fetch";
import { ClientInputError } from "@/lib/errors";
import { POST } from "@/app/api/ingest/pdf/route";

const mockedExtract = vi.mocked(enqueueExtract);
const mockedFetchPdf = vi.mocked(fetchPdfBytes);

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedServicePrincipal = vi.mocked(getServicePrincipal);

function jsonReq(body: unknown): Request {
  return new Request("http://localhost/api/ingest/pdf", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ handle: "alice", id: "alice" } as never);
  mockedFetchPdf.mockResolvedValue({
    bytes: new Uint8Array([1, 2, 3]).buffer,
    filename: "doc.pdf",
    title: "doc",
  });
});

describe("POST /api/ingest/pdf", () => {
  it("401 when not signed in", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf" }) as never);
    expect(res.status).toBe(401);
    expect(mockedFetchPdf).not.toHaveBeenCalled();
    expect(mockedExtract).not.toHaveBeenCalled();
  });

  it("400 when pdfUrl is missing or not a URL", async () => {
    expect((await POST(jsonReq({}) as never)).status).toBe(400);
    expect((await POST(jsonReq({ pdfUrl: "not-a-url" }) as never)).status).toBe(400);
  });

  it("fetches a URL PDF and enqueues extract with session attribution", async () => {
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf", title: "My Doc" }) as never);
    expect(res.status).toBe(200);
    expect(mockedFetchPdf).toHaveBeenCalledWith("https://example.com/doc.pdf");
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "alice",
        format: "pdf",
        filename: "doc.pdf",
        title: "My Doc",
        sourceUrl: "https://example.com/doc.pdf",
      }),
    );
  });

  it("passes tags from JSON body onto the extract job", async () => {
    await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf", tags: ["research", "ai"] }) as never);
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({ tags: ["research", "ai"] }),
    );
  });

  it("maps a ClientInputError from the fetch (oversized / wrong type) to 400", async () => {
    mockedFetchPdf.mockRejectedValue(new ClientInputError("PDF too large (21.0 MB). Maximum: 20 MB."));
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/huge.pdf" }) as never);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("too large");
  });

  it("maps an unexpected error (e.g. storage outage) to 500, not 400", async () => {
    mockedFetchPdf.mockRejectedValue(new Error("R2 unavailable"));
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf" }) as never);
    expect(res.status).toBe(500);
  });

  it("hands an UPLOADED pdf to the extract job, never to a Worker parse", async () => {
    // Epic 7. This test used to assert `ingestPdf` ran inline on the uploaded
    // bytes — the Worker-side `unpdf` parse the epic moved to the sidecar's
    // Rust crate. The URL door above now fetches bytes and takes this same path.
    const file = new File(["fake-pdf-bytes"], "report.pdf", { type: "application/pdf" });
    const form = new FormData();
    form.append("file", file);
    form.append("title", "My Report");

    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      body: form,
    });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledTimes(1);
    expect(mockedExtract.mock.calls[0][0]).toMatchObject({
      owner: "alice",
      format: "pdf",
      filename: "report.pdf",
      title: "My Report",
    });
    expect(mockedFetchPdf).not.toHaveBeenCalled();
  });

  it("400 when multipart file is missing", async () => {
    const form = new FormData();
    const req = new Request("http://localhost/api/ingest/pdf", {
      method: "POST",
      body: form,
    });
    const res = await POST(req as never);
    expect(res.status).toBe(400);
  });

  it("accepts service token when no Clerk session exists", async () => {
    mockedPrincipal.mockResolvedValue(null);
    mockedServicePrincipal.mockReturnValue({ id: "service:bot", handle: "bot" });
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf" }) as never);
    expect(res.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "bot", sourceUrl: "https://example.com/doc.pdf" }),
    );
  });

  it("prefers Clerk session over service token", async () => {
    mockedServicePrincipal.mockReturnValue({ id: "service:bot", handle: "bot" });
    // getPrincipal returns alice (Clerk session) — should use alice, not bot
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf" }) as never);
    expect(res.status).toBe(200);
    expect(mockedExtract).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "alice" }),
    );
  });

  it("does NOT enqueue a Worker source:pdf task for a URL PDF", async () => {
    const res = await POST(jsonReq({ pdfUrl: "https://example.com/doc.pdf" }) as never);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.queued).toBe(true);
    expect(data.extract).toBe(true);
    expect(mockedExtract).toHaveBeenCalledTimes(1);
    expect(mockedExtract.mock.calls[0][0]).toMatchObject({
      format: "pdf",
      sourceUrl: "https://example.com/doc.pdf",
    });
  });

  it("does NOT stage an uploaded PDF for the Worker, even where a queue exists", async () => {
    // The replaced pin asserted a `staged: { kind: "pdf" }` task — the payload
    // `/api/tasks/run` used to parse on the Worker. On Workers or not, an
    // uploaded PDF now takes exactly one path: stored bytes plus an extract
    // job. `queued: true` still means "the sidecar has work", not "a Worker
    // will parse this".
    const file = new File(["fake-pdf-bytes"], "report.pdf", { type: "application/pdf" });
    const form = new FormData();
    form.append("file", file);
    const req = new Request("http://localhost/api/ingest/pdf", { method: "POST", body: form });

    const res = await POST(req as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.queued).toBe(true);
    expect(body.extract).toBe(true);
    expect(mockedFetchPdf).not.toHaveBeenCalled();
  });
});
