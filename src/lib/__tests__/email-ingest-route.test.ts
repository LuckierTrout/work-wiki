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
  updateIngestJob: vi.fn(),
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
vi.mock("@/lib/extract-dispatch", () => ({
  enqueueExtract: vi.fn(async () => ({
    path: "sources/report/abc.pdf",
    jobId: "job-extract",
    extractId: "extract-1",
    storedBytes: true,
  })),
}));
vi.mock("@/lib/email-ingest", async (original) => ({
  ...(await original<typeof import("@/lib/email-ingest")>()),
  loadEmailIngestConfig: vi.fn(),
}));

import { getServicePrincipal } from "@/lib/auth";
import { enqueueOrInline } from "@/lib/ingest-async";
import { stageBytes } from "@/lib/ingest-staging";
import { createIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import {
  loadEmailIngestConfig,
  MAX_EMAIL_CONTENT_CHARS,
  MAX_EMAIL_DOCUMENTS,
} from "@/lib/email-ingest";
import { MAX_DOCUMENT_SIZE } from "@/lib/constants";
import { getAgent } from "@/lib/agents";
import { getVault, vaultOwnedBy } from "@/lib/vault";
import { enqueueExtract } from "@/lib/extract-dispatch";

const mockedPrincipal = vi.mocked(getServicePrincipal);
const mockedEnqueue = vi.mocked(enqueueOrInline);
const mockedCreateJob = vi.mocked(createIngestJob);
const mockedGetJob = vi.mocked(getIngestJob);
const mockedLoadConfig = vi.mocked(loadEmailIngestConfig);
const mockedGetAgent = vi.mocked(getAgent);
const mockedGetVault = vi.mocked(getVault);
const mockedVaultOwnedBy = vi.mocked(vaultOwnedBy);
const mockedStageBytes = vi.mocked(stageBytes);
const mockedEnqueueExtract = vi.mocked(enqueueExtract);

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
    /**
     * The `attachmentName` fields the caller records, REPLACING the one-per-file
     * default below.
     *
     * The default (a recorded name equal to every file's own name) is the easy
     * case and the one the Worker produces least often: it names a part from the
     * MIME headers and falls back to `unnamed attachment`, then forwards the file
     * under a generated `attachment-N`, so the two lists routinely disagree on a
     * file that arrived perfectly. This option is how a fixture posts that
     * disagreement.
     */
    recordedNames?: string[];
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
    if (!options.recordedNames) form.append("attachmentName", file.name);
    form.append("attachments", file, file.name);
  }
  for (const name of options.recordedNames ?? []) form.append("attachmentName", name);
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
      // A resend answers with the SAME accounting pair a first delivery does.
      // `request()` names `deck.pptx` and posts no file, so nothing is
      // supported and the local floor is 1 -- reporting the count only on the
      // success path left a resend answering with half the contract.
      supportedAttachmentCount: 0,
      skippedAttachmentCount: 1,
    });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(mockedCreateJob).not.toHaveBeenCalled();
  });

  it("reports the summed skipped count on the duplicate path too", async () => {
    mockedGetJob.mockResolvedValueOnce({
      jobId: "email-existing",
      owner: "LuckierTrout",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const { POST } = await import("@/app/api/email/ingest/route");
    // The Worker's own 3 plus the route's own drop of a forwarded file it does
    // not support: 4. A duplicate that reported only the Worker's figure, or
    // only the local floor, would understate the loss.
    const response = await POST(multipartRequest({
      messageId: "<message-duplicate@example.com>",
      file: new File(["name,total\nAlpha,10"], "metrics.csv", { type: "text/csv" }),
      files: [new File(["binary"], "clip.mov", { type: "video/quicktime" })],
      unforwardedNames: ["scan.tiff"],
      skippedAttachmentCount: "3",
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      duplicate: true,
      status: "queued",
      supportedAttachmentCount: 1,
      skippedAttachmentCount: 4,
    });
    expect(mockedEnqueue).not.toHaveBeenCalled();
    // The hoist moved the count computation ACROSS this boundary, and this
    // request posts real `File` parts -- so pin that the duplicate path still
    // stages nothing and records nothing, not merely that it does not enqueue.
    expect(mockedStageBytes).not.toHaveBeenCalled();
    expect(mockedCreateJob).not.toHaveBeenCalled();
  });

  it("reports the same counts on the duplicate path as on the first delivery", async () => {
    // The invariant the hoist exists to create, stated as an invariant rather
    // than as arithmetic: ONE message, answered twice, has to be accounted for
    // identically both times. The per-path tests above assert hand-computed
    // figures, so editing one path's expression leaves the other path's
    // assertion green; comparing the two responses to EACH OTHER is what
    // catches a divergence no matter which number is the right one.
    const payload = () =>
      multipartRequest({
        messageId: "<message-both-paths@example.com>",
        file: new File(["name,total\nAlpha,10"], "metrics.csv", { type: "text/csv" }),
        files: [
          new File(["binary"], "clip.mov", { type: "video/quicktime" }),
          // Oversized, so `oversizedAttachmentNames` is populated and this one
          // fixture pins the field on BOTH exits. Without it, deleting the
          // spread from the duplicate response leaves the suite green.
          new File([new Uint8Array(MAX_DOCUMENT_SIZE + 1)], "huge.pdf", {
            type: "application/pdf",
          }),
        ],
        unforwardedNames: ["scan.tiff"],
        skippedAttachmentCount: "3",
      });
    const { POST } = await import("@/app/api/email/ingest/route");

    // First delivery: no stored job, so the success path answers and spreads
    // its own pair over whatever `enqueueOrInline` returned.
    const first = (await (await POST(payload())).json()) as Record<string, unknown>;
    expect(first).toMatchObject({ accepted: true, queued: true });
    expect(mockedEnqueue).toHaveBeenCalledOnce();

    // The same message again, now already recorded: the duplicate path answers.
    mockedGetJob.mockResolvedValueOnce({
      jobId: "email-existing",
      owner: "LuckierTrout",
      status: "queued",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const second = (await (await POST(payload())).json()) as Record<string, unknown>;
    expect(second).toMatchObject({ duplicate: true });
    expect(mockedEnqueue).toHaveBeenCalledOnce();

    expect(second.supportedAttachmentCount).toBe(first.supportedAttachmentCount);
    expect(second.skippedAttachmentCount).toBe(first.skippedAttachmentCount);
    expect(second.oversizedAttachmentNames).toEqual(first.oversizedAttachmentNames);
    // All three really carried a value -- otherwise the equalities above would
    // hold vacuously on a pair of `undefined`s.
    expect(typeof first.supportedAttachmentCount).toBe("number");
    expect(typeof first.skippedAttachmentCount).toBe("number");
    expect(first.oversizedAttachmentNames).toEqual(["huge.pdf"]);
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

  /**
   * Epic 7 split this door in two. An attachment an extract crate reads leaves
   * as its own Source on the sidecar; everything else still stages onto the
   * message job. Asserting BOTH halves off one mixed fixture is the point --
   * either half alone would stay green while the other silently swallowed a
   * file, which is the exact loss `.yoyo/learnings.md` names for this door.
   */
  it("routes a PDF attachment to extract and stages only the rest with its own bytes", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(mixedAttachmentRequest());
    expect(response.status).toBe(200);

    expect(mockedEnqueueExtract).toHaveBeenCalledTimes(1);
    const [extracted] = mockedEnqueueExtract.mock.calls[0]!;
    expect(extracted).toMatchObject({
      owner: "LuckierTrout",
      filename: "report.pdf",
      format: "pdf",
      ext: "pdf",
    });
    // The BYTES, not just the name: a diversion that posted an empty buffer
    // would store a Source that can never extract.
    expect(new Uint8Array(extracted.bytes)).toEqual(FIRST_BYTES);
    // Email provenance survives the hop -- Activity shows the message it
    // arrived on, not an orphan upload.
    expect(extracted.email).toMatchObject({
      messageId: "<message-mixed-attachments@example.com>",
      subject: "Quarterly review",
    });

    // The CSV is untouched by the split, and re-indexed from 1: it is now the
    // first staged attachment, not the second.
    expect(mockedStageBytes).toHaveBeenCalledTimes(1);
    const [jobId, filename, fallback, bytes] = mockedStageBytes.mock.calls[0]!;
    expect({ filename, fallback, bytes: new Uint8Array(bytes as ArrayBuffer) }).toMatchObject({
      filename: "1-metrics.csv",
      fallback: "attachment-1",
      bytes: SECOND_BYTES,
    });
    expect(jobId).toMatch(/^email-/);
    // Stamped ONCE on arrival and carried onto every record the message
    // produces: an emailed PDF is parked behind an extract that may not compile
    // for minutes, and a page dated by the compile would put the sidecar's
    // clock on the owner's correspondence.
    expect(extracted.email?.receivedAt).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
    );
    expect(mockedCreateJob.mock.calls[0]![0].email?.receivedAt).toBe(
      extracted.email?.receivedAt,
    );
  });

  it("fails a lost attachment visibly instead of dropping it from both paths", async () => {
    // An attachment routed to extract is REMOVED from the staged list, so a
    // queueing failure that only logged left the sender a 200 saying the mail
    // was accepted with no Source, no row and no sentence anywhere. The message
    // body must still compile — one bad attachment cannot 500 the delivery and
    // make the inbound Worker redeliver it.
    mockedEnqueueExtract.mockResolvedValueOnce({
      path: "sources/report/abc.pdf",
      jobId: "job-extract",
      extractId: "extract-1",
      storedBytes: true,
      error: "the job store refused the write",
    } as never);

    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(mixedAttachmentRequest());
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      accepted: boolean;
      extractIds?: string[];
      failedAttachments?: { filename: string; error: string }[];
    };
    // Reported, not silently absent from `extractIds`.
    expect(body.accepted).toBe(true);
    expect(body.extractIds).toBeUndefined();
    expect(body.failedAttachments).toEqual([
      { filename: "report.pdf", error: "the job store refused the write" },
    ]);

    // …and it has a row of its own, so Activity shows which file was lost.
    const failedRow = mockedCreateJob.mock.calls
      .map((call) => call[0])
      .find((input) => input.kind === "extract");
    expect(failedRow).toMatchObject({
      kind: "extract",
      source: "email",
      sourceRel: "sources/report/abc.pdf",
    });

    // The message body still went to Ingest.
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
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
        // The PDF left for the sidecar, so the message task carries only the
        // CSV. All three names still travel on `email.attachmentNames`: the
        // record of what arrived is not the record of what this task compiles.
        attachments: [
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
   * DW-690, the ordinary shape the phantom skip was reachable through. A
   * supported part with no filename is recorded by the Worker as
   * `unnamed attachment` and forwarded under a generated `attachment-1`: ONE
   * file, TWO names. The recorded-name floor used to subtract the forwarded file
   * count from the UNION of both lists, so a message that lost nothing at all
   * reported a skip of 1 -- and the sender was told to resend a file that had
   * already arrived.
   *
   * The union itself is unchanged and still asserted here: both names belong in
   * the record of what the message carried. What may not be read off it is a
   * loss, because a forwarded file's own filename is evidence the file ARRIVED.
   */
  it("reports no skip when a forwarded file is recorded under a different name", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      messageId: "<message-unnamed-part@example.com>",
      files: [new File([SECOND_BYTES], "attachment-1", { type: "text/csv" })],
      recordedNames: ["unnamed attachment"],
    }));
    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      accepted: true,
      supportedAttachmentCount: 1,
      skippedAttachmentCount: 0,
    });
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({
          attachmentNames: ["unnamed attachment", "attachment-1"],
        }),
      }),
    );
  });

  /**
   * DW-690's other half. The union used to be de-duplicated with a `Set` over
   * RAW strings and sanitized afterwards, so two names that scrub to the same
   * recorded string both survived: the list said a file arrived twice, and the
   * surplus name became a skip of a file nobody sent.
   *
   * `report.pdf\r\n` is the shape a client that folded a long
   * `Content-Disposition` header produces -- the exact input
   * `sanitizeAttachmentNames` exists to scrub. Asserting the RECORDED LIST as
   * well as the count matters: collapsing the pair only in the arithmetic would
   * leave Activity showing one file under two names.
   */
  it("records a name once when the caller's name and the file's name scrub alike", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      messageId: "<message-scrub-collision@example.com>",
      files: [new File([FIRST_BYTES], "report.pdf\r\n", { type: "application/pdf" })],
      recordedNames: ["report.pdf"],
    }));
    expect(response.status).toBe(200);

    expect(await response.json()).toMatchObject({
      accepted: true,
      supportedAttachmentCount: 1,
      skippedAttachmentCount: 0,
    });
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({ attachmentNames: ["report.pdf"] }),
      }),
    );
  });

  /**
   * The other side of the DW-690 floor change, and the case that keeps it from
   * over-correcting. Narrowing the recorded-name subtraction to the CALLER'S
   * names alone must not let a real drop go unreported when the caller recorded
   * no names at all: `payload.attachmentNames.length - attachments.length` is
   * negative here, and the route's own drop count -- the second floor -- is what
   * answers.
   */
  it("counts a route-dropped file the caller recorded no name for", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      messageId: "<message-unnamed-unsupported-drop@example.com>",
      content: "The sheet is attached.",
      files: [
        new File([SECOND_BYTES], "metrics.csv", { type: "text/csv" }),
        new File([SECOND_BYTES], "program.exe", { type: "application/octet-stream" }),
      ],
      recordedNames: [],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      supportedAttachmentCount: 1,
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
     * recorded-name subtraction.
     *
     * Since DW-690 that subtraction reads `payload.attachmentNames` -- the
     * caller's recorded names ALONE, no longer their union with the forwarded
     * file names -- and parse-time `sanitizeAttachmentNames` does not
     * de-duplicate, so identically-named parts no longer collapse into one name
     * the way they did when the union was the minuend. What makes the drop count
     * the larger term now is a caller that records FEWER names than it forwards
     * files: one recorded name beside four refused parts. Record one name per
     * file and the two floors are equal and a negative count is unobservable.
     *
     * That shape is a hand-rolled POST, not something this repo's Worker emits
     * -- it posts one recorded name per countable part -- which is the same
     * class of caller the `-1` and the `Infinity` themselves come from.
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

    it("counts every part it dropped when the recorded names collapse", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-negative-observable@example.com>",
        content: "Four scans from the copier.",
        files: Array.from(
          { length: 4 },
          () => new File([SECOND_BYTES], "scan.exe", { type: "application/octet-stream" }),
        ),
        recordedNames: ["scan.exe"],
        skippedAttachmentCount: "-1",
      }));
      expect(response.status).toBe(200);
      // ONE recorded name beside FOUR forwarded parts, so the recorded-name
      // subtraction answers 1 while four files really were refused. The floor
      // takes the route's own drop count as its second term, so the honest
      // answer is 4 -- which is the whole point of there being two floors.
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 4,
      });
      // What this case can no longer discriminate, stated rather than implied:
      // the `-1` is ignored by `parseSkippedCount`, but a route that DID treat
      // it as real would answer `max(4, -1 + 4)` = 4 as well. A negative count
      // can never exceed the drop-count floor -- `count + drops < drops` for any
      // negative count -- so the guard is unobservable from the response by
      // construction, and asserting on it here would be theatre. It is kept in
      // `parseSkippedCount` as defence, not as behaviour.
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
      // And it scales with the recorded names rather than answering a constant.
      // The JSON branch carries no files at all, so this is the one caller shape
      // where the recorded-name floor is the ONLY floor -- the route's own drop
      // count is zero minus zero -- which is why DW-690 narrowed that floor to
      // `payload.attachmentNames` instead of removing it.
      const twoNames = await POST(request({
        messageId: "<message-json-two-names@example.com>",
        attachmentNames: ["a.pdf", "b.pdf"],
      }));
      expect(await twoNames.json()).toMatchObject({ skippedAttachmentCount: 2 });
    });
  });

  /**
   * A body whose every attachment was refused. The route's own filter drops both
   * parts, so nothing is staged and the task carries no `attachments` key at
   * all -- but the body still ingests and both names still reach the job
   * metadata. Neither suite had this case end to end: every prior
   * all-unsupported fixture was attachment-ONLY, and so exercised the 400 rather
   * than the accepting path (DW-253).
   */
  it("ingests the body when every attachment is unsupported, recording both names", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      messageId: "<message-body-all-unsupported@example.com>",
      content: "The notes are in this email body.",
      files: [
        new File([SECOND_BYTES], "program.exe", { type: "application/octet-stream" }),
        new File([SECOND_BYTES], "clip.mov", { type: "video/quicktime" }),
      ],
    }));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      accepted: true,
      supportedAttachmentCount: 0,
      skippedAttachmentCount: 2,
    });
    expect(mockedStageBytes).not.toHaveBeenCalled();
    expect(mockedCreateJob).toHaveBeenCalledWith(
      expect.objectContaining({
        email: expect.objectContaining({ attachmentNames: ["program.exe", "clip.mov"] }),
      }),
    );
    const task = mockedEnqueue.mock.calls[0][1];
    expect(task).toMatchObject({ content: "The notes are in this email body." });
    // Absent, not an empty array: `...(stagedAttachments.length ? ... : {})`.
    expect(task).not.toHaveProperty("attachments");
  });

  /**
   * Oversize is a per-FILE loss (DW-253). It used to 400 the whole email, so one
   * document over the ceiling cost the sender their body and every other
   * attachment as well. The ceiling itself is unchanged -- what changed is who
   * pays for breaching it.
   *
   * The fixture buffer is allocated once and shared by every `File` below: at
   * `MAX_DOCUMENT_SIZE + 1` bytes a fresh allocation per case would dominate the
   * suite's runtime for no added coverage.
   */
  describe("oversized attachments", () => {
    const OVERSIZED_BYTES = new Uint8Array(MAX_DOCUMENT_SIZE + 1);
    /** The ceiling as the refusal and the route's own arithmetic both write it. */
    const CEILING_MB = MAX_DOCUMENT_SIZE / 1024 / 1024;

    function oversizedFile(name = "big.pdf") {
      return new File([OVERSIZED_BYTES], name, { type: "application/pdf" });
    }

    it("keeps the body and the under-ceiling attachment, dropping only the oversized one", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-among-good@example.com>",
        content: "Two files attached.",
        files: [
          oversizedFile(),
          new File([FIRST_BYTES], "report.pdf", { type: "application/pdf" }),
        ],
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accepted: true,
        supportedAttachmentCount: 1,
        skippedAttachmentCount: 1,
        oversizedAttachmentNames: ["big.pdf"],
      });

      // The oversized file's NAME still reaches the job: its bytes are lost,
      // the record that it was sent is not.
      expect(mockedCreateJob).toHaveBeenCalledWith(
        expect.objectContaining({
          email: expect.objectContaining({ attachmentNames: ["big.pdf", "report.pdf"] }),
        }),
      );
      // `report.pdf` is an extractable format, so it leaves for the sidecar with
      // its own bytes rather than staging -- and it is the ONLY thing that left.
      expect(mockedEnqueueExtract).toHaveBeenCalledTimes(1);
      expect(mockedEnqueueExtract.mock.calls[0][0]).toMatchObject({
        filename: "report.pdf",
      });
      expect(new Uint8Array(mockedEnqueueExtract.mock.calls[0][0].bytes)).toEqual(FIRST_BYTES);
      expect(mockedStageBytes).not.toHaveBeenCalled();
      expect(mockedEnqueue).toHaveBeenCalledWith(
        expect.stringMatching(/^email-/),
        expect.objectContaining({ content: "Two files attached." }),
        expect.any(Function),
      );
    });

    it("stages an under-ceiling file from index 1, leaving no hole for the dropped one", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-then-staged@example.com>",
        content: "Two files attached.",
        files: [
          oversizedFile(),
          new File([SECOND_BYTES], "metrics.csv", { type: "text/csv" }),
        ],
      }));
      expect(response.status).toBe(200);
      // Only the small file was staged -- and it is numbered 1, so the dropped
      // file did not leave a hole in the indexed keys.
      expect(mockedStageBytes).toHaveBeenCalledTimes(1);
      expect(mockedStageBytes.mock.calls[0][1]).toBe("1-metrics.csv");
      expect(mockedEnqueue).toHaveBeenCalledWith(
        expect.stringMatching(/^email-/),
        expect.objectContaining({
          attachments: [expect.objectContaining({ filename: "metrics.csv" })],
        }),
        expect.any(Function),
      );
    });

    it("accepts an email whose only attachment is oversized, as long as it has a body", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-with-body@example.com>",
        content: "The report is attached.",
        files: [oversizedFile()],
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accepted: true,
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 1,
        oversizedAttachmentNames: ["big.pdf"],
      });
      expect(mockedStageBytes).not.toHaveBeenCalled();
      const task = mockedEnqueue.mock.calls[0][1];
      expect(task).toMatchObject({ content: "The report is attached." });
      expect(task).not.toHaveProperty("attachments");
    });

    it("still refuses when the oversized file was the only thing to ingest", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-no-body@example.com>",
        files: [oversizedFile()],
      }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      // The sender has to learn WHICH file was too big and what the ceiling is;
      // "no supported document attachment" alone would be a lie about a `.pdf`.
      expect(body.error).toContain("big.pdf");
      expect(body.error).toContain(`larger than ${CEILING_MB} MB`);
      expect(CEILING_MB).toBe(10);
      expect(body.oversizedAttachmentNames).toEqual(["big.pdf"]);
      // A supported document DID arrive -- it was too big, not unsupported. The
      // lead sentence must not contradict the one naming the sender's PDF.
      expect(body.error).not.toContain("supported document attachment");
      // Nothing irreversible happened on the way to the refusal.
      expect(mockedStageBytes).not.toHaveBeenCalled();
      expect(mockedCreateJob).not.toHaveBeenCalled();
      expect(mockedEnqueue).not.toHaveBeenCalled();
    });

    it("adds its own oversize drop to the count the Worker forwarded", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-plus-forwarded@example.com>",
        content: "Everything I have.",
        files: [oversizedFile()],
        // What the Worker never forwarded. Disjoint from the drop made here, so
        // the two are summed: 3 + 1.
        skippedAttachmentCount: "3",
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 4,
        oversizedAttachmentNames: ["big.pdf"],
      });
    });

    it("reports the unsupported refusal alongside the oversize one", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-plus-unsupported@example.com>",
        files: [
          oversizedFile(),
          new File([SECOND_BYTES], "program.exe", { type: "application/octet-stream" }),
        ],
      }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      // Two independent refusals, so BOTH have to be reported. Swapping one
      // sentence for the other loses either the oversize explanation or the
      // list of formats the sender needs in order to resend the `.exe`.
      expect(body.error).toContain("supported document attachment");
      expect(body.error).toContain(`big.pdf is larger than ${CEILING_MB} MB`);
      expect(body.oversizedAttachmentNames).toEqual(["big.pdf"]);
    });

    it("still names and reports a file whose own name scrubs away to nothing", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-blank-name@example.com>",
        // Two of them, so the plural verb is exercised where the noun cannot be
        // taken for granted: `sanitizeAttachmentNames` drops a name that scrubs
        // away, and a list built without the fallback would come back EMPTY
        // while two files were really dropped -- printing "The attachment are
        // larger than 10 MB" and omitting the field that is supposed to prove
        // the drop happened.
        files: [oversizedFile("   "), oversizedFile("\t")],
      }));
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body.oversizedAttachmentNames).toEqual([
        "unnamed attachment",
        "unnamed attachment",
      ]);
      expect(body.error).toContain(
        `unnamed attachment, unnamed attachment are larger than ${CEILING_MB} MB`,
      );
      // Never the singular verb against a two-item list.
      expect(body.error).not.toContain("is larger than");
    });

    it("ingests a file sitting exactly on the ceiling", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-at-ceiling@example.com>",
        files: [
          new File([new Uint8Array(MAX_DOCUMENT_SIZE)], "sheet.csv", { type: "text/csv" }),
        ],
      }));
      // The gate is `>`, not `>=`: a document of exactly the advertised size is
      // the largest legal one. Nothing else in this suite posts a file at the
      // boundary, so shifting the partition's predicate by one -- in either
      // direction -- was invisible: `>=` silently refuses a file that fits, and
      // a mismatched pair of predicates puts it in BOTH lists at once, staged
      // AND reported as dropped. Mirrors the Worker's own boundary pin.
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({
        accepted: true,
        supportedAttachmentCount: 1,
        skippedAttachmentCount: 0,
      });
      // Not "dropped for size" as well as staged -- the field must be absent.
      expect(body).not.toHaveProperty("oversizedAttachmentNames");
      expect(mockedStageBytes).toHaveBeenCalledTimes(1);
      expect(mockedStageBytes.mock.calls[0][1]).toBe("1-sheet.csv");
    });

    it("counts an oversized file whose name scrubs away to nothing", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-oversized-blank-name-accepted@example.com>",
        content: "The report is attached.",
        files: [oversizedFile("   ")],
      }));
      expect(response.status).toBe(200);
      // The accepting path's version of the blank-name case, and the one that
      // caught a self-contradicting response: `sanitizeAttachmentNames` drops a
      // name that scrubs away, so the recorded-name subtraction answers ZERO
      // here -- "nothing was skipped" printed beside a list naming the file that
      // was. The floor takes the route's own drop count too, so the pair agrees.
      expect(await response.json()).toMatchObject({
        accepted: true,
        supportedAttachmentCount: 0,
        skippedAttachmentCount: 1,
        oversizedAttachmentNames: ["unnamed attachment"],
      });
    });

    it("counts past the recorded-name cap and says how many it did not name", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      // 21: one more than `sanitizeAttachmentNames` will record. Built inline
      // rather than through `multipartRequest` so ONE 10 MB `File` can be
      // appended under twenty-one distinct part names -- twenty-one separate
      // `File`s would copy 210 MB more for no added coverage.
      const OVERSIZED_TOTAL = 21;
      const shared = oversizedFile("shared.pdf");
      const form = new FormData();
      form.append("from", "owner@example.com");
      form.append("to", "ingest@example.com");
      form.append("subject", "Quarterly review");
      form.append("messageId", "<message-oversized-past-name-cap@example.com>");
      for (let index = 0; index < OVERSIZED_TOTAL; index += 1) {
        form.append("attachments", shared, `big-${index + 1}.pdf`);
      }
      const response = await POST(
        new Request("http://localhost/api/email/ingest", { method: "POST", body: form }),
      );
      expect(response.status).toBe(400);
      const body = (await response.json()) as Record<string, unknown>;

      // The names stay capped -- one refusal line must not grow with the
      // sender's attachment count, and the Worker's `safeError` guillotines a
      // relayed error at 300 characters anyway.
      expect(body.oversizedAttachmentNames).toHaveLength(20);
      expect(body.error).toContain("big-20.pdf");
      // ...but the COUNT is the true total, carried by a counted tail. Deriving
      // it from the truncated list instead told the sender about twenty files
      // and left the twenty-first unmentioned anywhere.
      expect(body.error).toContain(
        `big-20.pdf, and 1 other are larger than ${CEILING_MB} MB`,
      );
      // Named nowhere -- it is inside the "1 other", not omitted from the story.
      expect(body.error).not.toContain("big-21.pdf");
      // Plural verb against 21 files, even though the tail itself is singular.
      expect(body.error).not.toContain("is larger than");
      expect(mockedCreateJob).not.toHaveBeenCalled();
      expect(mockedEnqueue).not.toHaveBeenCalled();
    });

    it("leaves the field off entirely when nothing was oversized", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(mixedAttachmentRequest());
      expect(response.status).toBe(200);
      // Presence alone must mean "a file was dropped for being too big", so an
      // empty array here would be a false alarm to relay back to the sender.
      expect(await response.json()).not.toHaveProperty("oversizedAttachmentNames");
    });
  });

  /**
   * The body-length ceiling (DW-366). Nothing in the repo posted a body anywhere
   * near `MAX_EMAIL_CONTENT_CHARS`, so deleting the guard -- or flipping its
   * comparison -- shipped green, and the sentence a direct caller reads was
   * unpinned. The Worker truncates to the same figure before forwarding, so this
   * refusal is the route's own contract for DIRECT service-principal callers and
   * defence-in-depth should the two ever drift.
   */
  describe("body length ceiling", () => {
    /** `x` repeated: no whitespace, so `content.trim()` cannot change the length. */
    const body = (length: number) => "x".repeat(length);

    it("refuses a body one character over the ceiling with the copy a caller reads", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(request({
        messageId: "<message-body-over-cap@example.com>",
        content: body(MAX_EMAIL_CONTENT_CHARS + 1),
      }));
      expect(response.status).toBe(400);
      // The sentence below encodes this ceiling as a literal, so the two must
      // move together: a legitimate change should fail HERE, naming the
      // coupling, rather than surfacing one line down as an opaque regression.
      expect(MAX_EMAIL_CONTENT_CHARS).toBe(100_000);
      // Verbatim, not interpolated: an interpolated expectation re-derives
      // whatever the route emits and so cannot fail on a reworded message. The
      // comma is `toLocaleString()`'s, and it is part of the contract.
      expect(await response.json()).toEqual({
        error: "Email body exceeds 100,000 characters",
      });
      // The 400 lands before any irreversible work.
      expect(mockedStageBytes).not.toHaveBeenCalled();
      expect(mockedCreateJob).not.toHaveBeenCalled();
      expect(mockedEnqueue).not.toHaveBeenCalled();
    });

    it("accepts a body sitting exactly on the ceiling", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(request({
        messageId: "<message-body-at-cap@example.com>",
        content: body(MAX_EMAIL_CONTENT_CHARS),
      }));
      // The gate is `>`, not `>=`: a body of exactly the advertised length is
      // the longest legal one, and a `>=` would refuse a message that fits
      // invisibly to a clearly-under / clearly-over pair.
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ accepted: true });
      expect(mockedEnqueue).toHaveBeenCalledOnce();
    });
  });

  /**
   * The per-message document cap. Nothing posted more than three parts before
   * this block, so `attachments.length > MAX_EMAIL_DOCUMENTS` survived both
   * deletion and inversion, and no test in the repo matched the message text
   * (DW-250).
   *
   * Who reaches this branch: NOT an emailing sender. `MAX_EMAIL_ATTACHMENTS`
   * equals `MAX_EMAIL_DOCUMENTS` (pinned in `email-ingest-allowlist-parity.test.ts`)
   * and the Worker slices to its own cap at `workers/email-ingest/index.ts:300`
   * before forwarding, so a forwarded message can never arrive over the cap --
   * a sender would only ever see this string relayed back through the Worker's
   * `safeError`. This is the route's own contract for DIRECT service-principal
   * callers, and defence-in-depth should the two caps ever drift apart.
   *
   * Counts are derived from `MAX_EMAIL_DOCUMENTS` so a cap change moves the
   * fixtures rather than silently re-aiming them. The user-facing sentence is
   * the deliberate exception: it is pinned verbatim, because a wording
   * regression is exactly what an interpolated expectation cannot see.
   */
  describe("supported-document cap", () => {
    /** Small, in-allowlist, distinct per index -- nothing here trips the size gate. */
    function csvFiles(count: number): File[] {
      return Array.from(
        { length: count },
        (_unused, index) =>
          new File([`name,total\nrow-${index},${index}`], `sheet-${index + 1}.csv`, {
            type: "text/csv",
          }),
      );
    }

    it("accepts exactly the cap", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-at-cap@example.com>",
        files: csvFiles(MAX_EMAIL_DOCUMENTS),
      }));
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accepted: true,
        supportedAttachmentCount: MAX_EMAIL_DOCUMENTS,
      });
      expect(mockedStageBytes).toHaveBeenCalledTimes(MAX_EMAIL_DOCUMENTS);
      expect(mockedEnqueue).toHaveBeenCalledOnce();
    });

    it("rejects one above the cap with the copy a direct caller reads", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-over-cap@example.com>",
        files: csvFiles(MAX_EMAIL_DOCUMENTS + 1),
      }));
      expect(response.status).toBe(400);
      // The sentence below encodes this cap as a literal, so the two must move
      // together: a legitimate cap change should fail HERE, naming the coupling,
      // rather than surfacing one line down as an opaque wording regression.
      expect(MAX_EMAIL_DOCUMENTS).toBe(10);
      // Verbatim, not `Attach no more than ${MAX_EMAIL_DOCUMENTS} ...`: the
      // interpolated form re-derives whatever the route emits and so cannot
      // fail on a reworded message.
      expect(await response.json()).toEqual({
        error: "Attach no more than 10 supported documents",
      });
      // The 400 lands before any irreversible work.
      expect(mockedStageBytes).not.toHaveBeenCalled();
      expect(mockedCreateJob).not.toHaveBeenCalled();
      expect(mockedEnqueue).not.toHaveBeenCalled();
    });

    it("counts only supported files toward the cap", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-cap-plus-unsupported@example.com>",
        files: [
          ...csvFiles(MAX_EMAIL_DOCUMENTS),
          new File(["binary"], "installer.exe", { type: "application/octet-stream" }),
          new File(["binary"], "driver.exe", { type: "application/octet-stream" }),
        ],
      }));
      // `attachments` is filtered by `isSupportedDocument` before the
      // comparison, so the two rejected parts cannot push a legal message over.
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        supportedAttachmentCount: MAX_EMAIL_DOCUMENTS,
        skippedAttachmentCount: 2,
      });
      // The reported count alone would not notice the `.exe` parts leaking into
      // R2; the staging call count would.
      expect(mockedStageBytes).toHaveBeenCalledTimes(MAX_EMAIL_DOCUMENTS);
    });

    it("does not let an oversized file consume a cap slot", async () => {
      const { POST } = await import("@/app/api/email/ingest/route");
      const response = await POST(multipartRequest({
        messageId: "<message-cap-plus-oversized@example.com>",
        files: [
          ...csvFiles(MAX_EMAIL_DOCUMENTS),
          new File([new Uint8Array(MAX_DOCUMENT_SIZE + 1)], "huge.pdf", {
            type: "application/pdf",
          }),
        ],
      }));
      // The oversize partition runs BEFORE the cap comparison, so a full email
      // plus one too-big file is a legal email with one file dropped -- not a
      // cap refusal. Comparing `supportedFiles.length` instead of
      // `attachments.length` here would 400 the whole message, and no other
      // assertion in this suite would notice.
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        accepted: true,
        supportedAttachmentCount: MAX_EMAIL_DOCUMENTS,
        skippedAttachmentCount: 1,
        oversizedAttachmentNames: ["huge.pdf"],
      });
      expect(mockedStageBytes).toHaveBeenCalledTimes(MAX_EMAIL_DOCUMENTS);
    });
  });

  /**
   * The no-body/no-supported refusal (DW-367). Nothing matched its text, so the
   * sentence a sender is shown -- relayed back through the Worker's `safeError`
   * -- could be reworded, or merged into the oversize sentence beside it, with
   * the suite green. Pinned VERBATIM and as the whole body: an interpolated or
   * `toContain` expectation cannot fail on a rewording, and `toEqual` is what
   * says the oversize clause and `oversizedAttachmentNames` stay OFF when
   * nothing was oversized.
   */
  it("rejects attachment-only email when its file type is unsupported", async () => {
    const { POST } = await import("@/app/api/email/ingest/route");
    const response = await POST(multipartRequest({
      file: new File(["binary"], "program.exe", { type: "application/octet-stream" }),
    }));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "The email has no text body or supported document attachment to ingest",
    });
    expect(mockedStageBytes).not.toHaveBeenCalled();
    expect(mockedCreateJob).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});
