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
  // Four parameters, not two: `bytes` is the whole point of the staging call,
  // and a mock that never names it leaves `bytes: await file.arrayBuffer()`
  // free to become `new ArrayBuffer(0)` with the suite green -- every emailed
  // document would then stage empty.
  stageBytes: vi.fn(
    async (
      _jobId: string,
      filename: string,
      _fallback: string,
      _bytes: ArrayBuffer,
    ) => `raw/uploads/job/${filename}`,
  ),
}));
vi.mock("@/lib/email-ingest", async (original) => ({
  ...(await original<typeof import("@/lib/email-ingest")>()),
  loadEmailIngestConfig: vi.fn(),
}));

import { getServicePrincipal } from "@/lib/auth";
import { enqueueOrInline } from "@/lib/ingest-async";
import { stageBytes } from "@/lib/ingest-staging";
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
const mockedStageBytes = vi.mocked(stageBytes);

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

function multipartRequest(
  options: {
    content?: string;
    file?: File;
    files?: File[];
    /** Names with no file part -- what the Worker sends for attachments it would not forward. */
    unforwardedNames?: string[];
    messageId?: string;
    /**
     * The Worker's own total. A string, not a number: this is a multipart field,
     * and the route has to parse it back out of the wire form.
     */
    skippedAttachmentCount?: string;
  } = {},
) {
  const form = new FormData();
  form.append("from", "owner@example.com");
  form.append("to", "ingest@example.com");
  form.append("subject", "Quarterly review");
  form.append("messageId", options.messageId ?? "<message-attachment@example.com>");
  if (options.content !== undefined) form.append("content", options.content);
  // Merged, not either/or: a helper that silently dropped `file` whenever
  // `files` was also given would let a test believe it posted an attachment it
  // never sent.
  const files = [...(options.file ? [options.file] : []), ...(options.files ?? [])];
  for (const file of files) {
    form.append("attachmentName", file.name);
    form.append("attachments", file, file.name);
  }
  for (const name of options.unforwardedNames ?? []) form.append("attachmentName", name);
  if (options.skippedAttachmentCount !== undefined) {
    form.append("skippedAttachmentCount", options.skippedAttachmentCount);
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

  // Two supported files with distinct payloads, plus a name for an attachment
  // the Worker did NOT forward -- the shape the Worker actually produces when
  // some of what the sender attached failed the allowlist.
  const FIRST_BYTES = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37, 0x00, 0xff]);
  const SECOND_BYTES = new Uint8Array([0x6e, 0x61, 0x6d, 0x65, 0x2c, 0x74, 0x6f, 0x74, 0x61, 0x6c]);

  function mixedAttachmentRequest() {
    return multipartRequest({
      messageId: "<message-mixed-attachments@example.com>",
      files: [
        new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" }),
        new File([SECOND_BYTES], "metrics.csv", { type: "text/csv" }),
      ],
      unforwardedNames: ["archive.exe"],
    });
  }

  it("stages each attachment's own bytes under its own indexed key", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(mixedAttachmentRequest());
    expect(response.status).toBe(200);

    expect(mockedStageBytes).toHaveBeenCalledTimes(2);
    // Call order is array order: `attachmentBytes.map(async (...) => ({ key:
    // await stageBytes(...) }))` invokes `stageBytes` synchronously inside each
    // callback, before the first `await` yields, so call index IS attachment
    // index and the pairing can be read straight off `mock.calls`.
    const staged = mockedStageBytes.mock.calls.map(
      ([jobId, filename, fallback, bytes]) => ({
        jobId,
        filename,
        fallback,
        bytes: new Uint8Array(bytes as ArrayBuffer),
      }),
    );
    expect(staged[0]).toMatchObject({
      filename: "1-report.pdf",
      fallback: "attachment-1",
      bytes: FIRST_BYTES,
    });
    expect(staged[1]).toMatchObject({
      filename: "2-metrics.csv",
      fallback: "attachment-2",
      bytes: SECOND_BYTES,
    });
    // One job, both attachments.
    expect(new Set(staged.map((call) => call.jobId)).size).toBe(1);
  });

  /**
   * The receiving half of the `attachmentName` handoff. DW-100's stated harm is
   * names vanishing from ingest job metadata, and a name only reaches the job
   * through the multipart `attachmentName` read at `parsePayload`: for a
   * *supported* file the union at the top of `POST` recovers the name from
   * `payload.attachments` anyway, so a fixture of supported files alone leaves
   * that read contributing nothing observable. `archive.exe` has no file part,
   * so it exists in the job only if the read happened.
   */
  it("carries an unforwarded attachment name into the job metadata and the skipped count", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(mixedAttachmentRequest());
    expect(response.status).toBe(200);

    const expectedNames = ["report.pdf", "metrics.csv", "archive.exe"];
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "email",
        email: expect.objectContaining({ attachmentNames: expectedNames }),
      }),
    );
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.stringMatching(/^email-/),
      expect.objectContaining({
        email: expect.objectContaining({ attachmentNames: expectedNames }),
        attachments: [
          expect.objectContaining({ filename: "report.pdf", contentType: "application/pdf" }),
          expect.objectContaining({ filename: "metrics.csv", contentType: "text/csv" }),
        ],
      }),
      expect.any(Function),
    );
    // Three names recorded, two of them forwarded and staged -- so exactly one
    // is reported back as skipped. Nothing else in the repo asserts
    // `skippedAttachmentCount`.
    expect(await response.json()).toMatchObject({
      accepted: true,
      supportedAttachmentCount: 2,
      skippedAttachmentCount: 1,
    });
  });

  /**
   * The Worker knows what it never forwarded -- unsupported parts plus supported
   * ones it dropped at its own per-email cap -- and the route cannot re-derive
   * that from a name list truncated at 20 and a file list truncated at 10. So
   * the count travels with the message. Both payload branches are pinned with
   * the field PRESENT as well as absent: an assertion that only omits it leaves
   * the parse itself free to be deleted (DW-247).
   */
  describe("forwarded skipped-attachment count", () => {
    it("reports the multipart count the Worker sent, not the local subtraction", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-forwarded-count@example.com>",
        files: [new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" })],
        unforwardedNames: ["archive.exe"],
        skippedAttachmentCount: "14",
      }));
      expect(response.status).toBe(200);
      // Locally derivable: 2 names minus 1 staged file = 1. The Worker's 14 wins.
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 1,
        skippedAttachmentCount: 14,
      });
    });

    it("adds its own rejections to the forwarded count", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-forwarded-plus-local@example.com>",
        files: [
          new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" }),
          // Forwarded by the Worker, refused here: a loss the Worker's total
          // cannot already include, so the two are summed rather than maxed.
          new File([SECOND_BYTES], "program.exe", { type: "application/octet-stream" }),
        ],
        skippedAttachmentCount: "3",
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 1,
        skippedAttachmentCount: 4,
      });
    });

    it("never reports below what the recorded names already prove was lost", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-count-below-floor@example.com>",
        files: [new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" })],
        unforwardedNames: ["archive.exe", "photo.heic"],
        // A Worker that miscounted, an older Worker that sent nothing but a
        // zero, or a hand-rolled POST: three names arrived and one file was
        // staged, so at least two are gone whatever the sender of the count
        // believes. A bare sum would answer 0 and call it honest.
        skippedAttachmentCount: "0",
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 1,
        skippedAttachmentCount: 2,
      });
    });

    /**
     * The floor masks a bad parse whenever it is the larger number, so both of
     * these are built where it cannot: `Infinity` overshoots any floor, and the
     * negative case needs a fixture where the route's OWN drop count exceeds the
     * local subtraction. That only happens when recorded names collapse -- the
     * name union is deduplicated, so four identically-named parts contribute one
     * name and four drops. With distinct names the subtraction is always the
     * larger of the two and a negative count is unobservable.
     */
    it("ignores a non-finite count instead of letting it reach the response", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-infinite-count@example.com>",
        files: [new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" })],
        skippedAttachmentCount: "Infinity",
      }));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      // `Math.max(0, Infinity)` is `Infinity`, which `JSON.stringify` writes as
      // `null` -- so a dropped finiteness check surfaces as a missing number,
      // not a wrong one.
      expect(typeof body.skippedAttachmentCount).toBe("number");
      expect(Number.isFinite(body.skippedAttachmentCount)).toBe(true);
      expect(body.skippedAttachmentCount).toBe(0);
    });

    it("ignores a negative count instead of subtracting it from its own drops", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-negative-observable@example.com>",
        content: "Four scans from the copier.",
        files: Array.from(
          { length: 4 },
          () => new File([SECOND_BYTES], "scan.exe", { type: "application/octet-stream" }),
        ),
        skippedAttachmentCount: "-1",
      }));
      expect(response.status).toBe(200);
      // One deduplicated name, no staged file: the local subtraction is 1. The
      // route rejected all four parts, so treating -1 as a real count would
      // answer `max(1, -1 + 4)` = 3.
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 1,
      });
    });

    it("falls back to the subtraction when the multipart field is absent or unusable", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const absent = await POST(mixedAttachmentRequest());
      expect(await absent.json()).toMatchObject({ skippedAttachmentCount: 1 });
      const unusable = await POST(multipartRequest({
        messageId: "<message-bad-count@example.com>",
        files: [new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" })],
        unforwardedNames: ["archive.exe"],
        skippedAttachmentCount: "not-a-number",
      }));
      expect(await unusable.json()).toMatchObject({ skippedAttachmentCount: 1 });
      const negative = await POST(multipartRequest({
        messageId: "<message-negative-count@example.com>",
        files: [new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" })],
        unforwardedNames: ["archive.exe"],
        skippedAttachmentCount: "-5",
      }));
      expect(await negative.json()).toMatchObject({ skippedAttachmentCount: 1 });
    });

    it("reads the count on the JSON body branch too", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const withCount = await POST(request({ skippedAttachmentCount: 14 }));
      expect(await withCount.json()).toMatchObject({
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 14,
      });
      const withoutCount = await POST(request({
        messageId: "<message-json-no-count@example.com>",
      }));
      // One recorded name, no attachments: the local subtraction.
      expect(await withoutCount.json()).toMatchObject({ skippedAttachmentCount: 1 });
    });
  });

  it("rejects attachment-only email when its file type is unsupported", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      file: new File(["binary"], "program.exe", { type: "application/octet-stream" }),
    }));
    expect(response.status).toBe(400);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
