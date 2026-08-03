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

import { getPrincipal } from "@/lib/auth";
import { ingestDocument } from "@/lib/ingest";
import { enqueueTask } from "@/lib/tasks";
import { POST } from "@/app/api/ingest/document/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIngest = vi.mocked(ingestDocument);
const mockedEnqueue = vi.mocked(enqueueTask);

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

  it("stages the upload and enqueues a document task on Workers", async () => {
    mockedEnqueue.mockResolvedValue(true);
    const response = await POST(upload(new File(["x"], "plan.docx")) as never);
    expect(response.status).toBe(200);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "ingest",
      staged: expect.objectContaining({ kind: "document", filename: "plan.docx" }),
    }));
    expect(mockedIngest).not.toHaveBeenCalled();
  });
});
