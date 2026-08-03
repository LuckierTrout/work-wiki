import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({ getServicePrincipal: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ ingest: vi.fn() }));
vi.mock("@/lib/agents", () => ({
  addAgentLearningPage: vi.fn(),
  getAgent: vi.fn(),
}));
vi.mock("@/lib/document-sources", () => ({ preserveDocumentSources: vi.fn() }));
vi.mock("@/lib/vault", () => ({
  addToVault: vi.fn(),
  getVault: vi.fn(),
  vaultOwnedBy: vi.fn(),
}));
vi.mock("@/lib/ingest-async", () => ({ enqueueOrInline: vi.fn() }));
vi.mock("@/lib/ingest-jobs", () => ({
  createIngestJob: vi.fn(),
  getIngestJob: vi.fn(),
}));
vi.mock("@/lib/ingest-staging", () => ({
  stageText: vi.fn(),
  stageBytes: vi.fn(async (_jobId: string, filename: string) => `raw/uploads/job/${filename}`),
}));
vi.mock("@/lib/email-ingest", async (original) => ({
  ...(await original<typeof import("@/lib/email-ingest")>()),
  loadEmailIngestConfig: vi.fn(),
}));

import { getServicePrincipal } from "@/lib/auth";
import { enqueueOrInline } from "@/lib/ingest-async";
import { createIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import { loadEmailIngestConfig } from "@/lib/email-ingest";
import { getAgent } from "@/lib/agents";
import { getVault, vaultOwnedBy } from "@/lib/vault";

const mockedPrincipal = vi.mocked(getServicePrincipal);
const mockedEnqueue = vi.mocked(enqueueOrInline);
const mockedCreateJob = vi.mocked(createIngestJob);
const mockedGetJob = vi.mocked(getIngestJob);
const mockedLoadConfig = vi.mocked(loadEmailIngestConfig);
const mockedGetAgent = vi.mocked(getAgent);
const mockedGetVault = vi.mocked(getVault);
const mockedVaultOwnedBy = vi.mocked(vaultOwnedBy);

function request(overrides: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/email/ingest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from: "owner@example.com",
      to: "ingest@example.com",
      subject: "Project notes",
      messageId: "<message-1@example.com>",
      content: "These are the project notes.",
      attachmentNames: ["deck.pptx"],
      ...overrides,
    }),
  });
}

function multipartRequest(options: { content?: string; file?: File } = {}) {
  const form = new FormData();
  form.append("from", "owner@example.com");
  form.append("to", "ingest@example.com");
  form.append("subject", "Quarterly review");
  form.append("messageId", "<message-attachment@example.com>");
  if (options.content !== undefined) form.append("content", options.content);
  if (options.file) {
    form.append("attachmentName", options.file.name);
    form.append("attachments", options.file, options.file.name);
  }
  return new Request("http://localhost/api/email/ingest", { method: "POST", body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockReturnValue({ id: "service:LuckierTrout", handle: "LuckierTrout" });
  mockedLoadConfig.mockResolvedValue({
    enabled: true,
    inboundAddress: "ingest@example.com",
    allowedSenders: ["owner@example.com"],
    destinationVaultId: "",
    destinationAgentId: "",
    updatedAt: null,
  });
  mockedGetJob.mockResolvedValue(null);
  mockedCreateJob.mockResolvedValue({} as never);
  mockedEnqueue.mockImplementation(async (jobId) =>
    NextResponse.json({ queued: true, jobId }),
  );
});

describe("POST /api/email/ingest", () => {
  it("requires the service principal", async () => {
    mockedPrincipal.mockReturnValue(null);
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(request());
    expect(response.status).toBe(401);
    expect(mockedCreateJob).not.toHaveBeenCalled();
  });

  it("rejects disabled email ingestion and unapproved senders", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    mockedLoadConfig.mockResolvedValueOnce({
      enabled: false,
      inboundAddress: "ingest@example.com",
      allowedSenders: ["owner@example.com"],
      destinationVaultId: "",
      destinationAgentId: "",
      updatedAt: null,
    });
    expect((await POST(request())).status).toBe(403);
    expect((await POST(request({ from: "stranger@example.com" }))).status).toBe(403);
    expect(mockedCreateJob).not.toHaveBeenCalled();
  });

  it("creates an owner-scoped email job and queues complete metadata", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: "LuckierTrout",
        source: "email",
        title: "Project notes",
        email: expect.objectContaining({
          from: "owner@example.com",
          attachmentNames: ["deck.pptx"],
        }),
      }),
    );
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.stringMatching(/^email-/),
      expect.objectContaining({
        kind: "ingest",
        sourceType: "email",
        owner: "LuckierTrout",
        email: expect.objectContaining({ messageId: "<message-1@example.com>" }),
      }),
      expect.any(Function),
    );
  });

  it("routes email to the configured owner-controlled agent and vault", async () => {
    mockedLoadConfig.mockResolvedValueOnce({
      enabled: true,
      inboundAddress: "ingest@example.com",
      allowedSenders: ["owner@example.com"],
      destinationVaultId: "luckiertrout--work",
      destinationAgentId: "luckiertrout--yoyo",
      updatedAt: null,
    });
    mockedGetAgent.mockResolvedValueOnce({
      id: "luckiertrout--yoyo",
      owner: "LuckierTrout",
    } as never);
    mockedGetVault.mockResolvedValueOnce({ id: "luckiertrout--work" } as never);
    mockedVaultOwnedBy.mockReturnValueOnce(true);
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(request());
    expect(response.status).toBe(200);
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({ owner: "LuckierTrout" }),
    );
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        owner: "luckiertrout--yoyo",
        author: "luckiertrout--yoyo",
        triggeredBy: "LuckierTrout",
        pageType: "agent-knowledge",
        learningFor: "luckiertrout--yoyo",
        vaultId: "luckiertrout--work",
      }),
      expect.any(Function),
    );
  });

  it("returns an existing Message-ID job without re-enqueueing", async () => {
    mockedGetJob.mockResolvedValueOnce({
      jobId: "email-existing",
      owner: "LuckierTrout",
      status: "done",
      slug: "project-notes",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(request());
    expect(await response.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      status: "done",
      slug: "project-notes",
    });
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("accepts an attachment-only email and queues its staged document", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      file: new File(["name,total\nAlpha,10"], "metrics.csv", { type: "text/csv" }),
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ supportedAttachmentCount: 1 });
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.stringMatching(/^email-/),
      expect.objectContaining({
        sourceType: "email",
        attachments: [expect.objectContaining({ filename: "metrics.csv" })],
      }),
      expect.any(Function),
    );
  });

  it("rejects attachment-only email when its file type is unsupported", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      file: new File(["zip"], "archive.zip", { type: "application/zip" }),
    }));
    expect(response.status).toBe(400);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
