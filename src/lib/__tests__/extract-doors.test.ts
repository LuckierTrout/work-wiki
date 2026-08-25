/**
 * The three HTTP doors Epic 7 added, at the layer their bugs actually live in
 * (Stories 7.1 and 7.7).
 *
 * `extract-jobs.test.ts` covers the registry as functions. This suite is about
 * what the ROUTES do with them — who is allowed to stamp the heartbeat, what a
 * vanished Source answers, whether a `.md` can be pulled through the media
 * door, and whether Retry decodes a PDF as UTF-8. None of those are visible
 * from the library side, and all four were wrong there at some point.
 *
 * REAL STORAGE, mocked AUTH. Storage is where the invariants are (bytes on
 * disk, records that survive a failure); auth is the one thing a node suite
 * cannot produce honestly, so `getPrincipal`/`getServicePrincipal` are the
 * seam and everything below them runs for real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(),
}));
vi.mock("@/lib/ingest", () => ({
  ingest: vi.fn(async () => ({ primarySlug: "plan" })),
}));
vi.mock("@/lib/ingest-async", () => ({
  enqueueOrInline: vi.fn(async () => ({ ok: true, queued: true })),
}));
vi.mock("@/lib/vault", () => ({ addToVault: vi.fn(async () => {}) }));
// The media door derives its gate from the readable page tree; the pages
// themselves are not what these tests are about. PARTIAL, because the rest of
// `@/lib/wiki` is path arithmetic (`rawRelPath`, `tenantForOwner`,
// `validateSlug`) that the storage below this seam runs for real.
vi.mock("@/lib/wiki", async (original) => ({
  ...(await original<typeof import("@/lib/wiki")>()),
  listReadableWikiPages: vi.fn(async () => []),
}));
vi.mock("@/lib/wikis", () => ({
  getWikiRegistry: vi.fn(async () => ({ currentId: null })),
}));

import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { GET as extractJobsGET } from "@/app/api/extract/jobs/route";
import { GET as extractBytesGET } from "@/app/api/extract/bytes/route";
import { GET as mediaGET } from "@/app/api/workbench/media/route";
import { POST as activityPOST } from "@/app/api/workbench/activity/route";
import { enqueueExtract } from "@/lib/extract-dispatch";
import { getExtractJob } from "@/lib/extract-jobs";
import { isExtractPollerLive } from "@/lib/extract-heartbeat";
import { getIngestJob } from "@/lib/ingest-jobs";
import { saveRawSourceBytes } from "@/lib/raw";
import { _resetStorage, getStorage } from "@/lib/storage";
import { _resetLocks } from "@/lib/lock";
import { NextRequest } from "next/server";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedService = vi.mocked(getServicePrincipal);

let tmpDir: string;
let originalDataDir: string | undefined;
let originalWikiDir: string | undefined;

const SHA = "ab".repeat(32);
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7 fake").buffer;
/** A one-pixel PNG, as real bytes: the point is that they survive undecoded. */
const PNG_BYTES = Uint8Array.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0xff, 0xfe, 0xfd, 0xfc,
]);

function serviceRequest(url: string) {
  return new NextRequest(url, { headers: { authorization: "Bearer svc" } });
}

async function storePdf() {
  return enqueueExtract({
    owner: "alice",
    slug: "quarterly-plan",
    bytesSha256: SHA,
    ext: "pdf",
    format: "pdf",
    filename: "quarterly-plan.pdf",
    title: "Quarterly Plan",
    bytes: PDF_BYTES,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-doors-test-"));
  originalDataDir = process.env.DATA_DIR;
  originalWikiDir = process.env.WIKI_DIR;
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  _resetStorage();
  _resetLocks();
  mockedPrincipal.mockResolvedValue({ handle: "alice" } as never);
  mockedService.mockReturnValue(null as never);
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  _resetStorage();
  _resetLocks();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("GET /api/extract/jobs — the poll is the heartbeat", () => {
  it("stamps liveness for the sidecar's own bearer-token poll", async () => {
    mockedService.mockReturnValue({ handle: "alice" } as never);
    expect(await isExtractPollerLive("alice")).toBe(false);

    const response = await extractJobsGET(
      serviceRequest("http://x/api/extract/jobs"),
    );
    expect(response.status).toBe(200);
    expect(await isExtractPollerLive("alice")).toBe(true);
  });

  it("does NOT stamp liveness for a Clerk browser GET", async () => {
    // The stamp is what the arrival door reads to decide between queueing a
    // document and failing it closed. A tab being open is not evidence that a
    // process able to parse anything exists — and stamping it made every
    // arrival for the next few minutes queue against a sidecar that was not
    // running, with nothing on screen saying so.
    const response = await extractJobsGET(
      new NextRequest("http://x/api/extract/jobs"),
    );
    expect(response.status).toBe(200);
    expect(await isExtractPollerLive("alice")).toBe(false);
  });
});

describe("GET /api/extract/bytes", () => {
  it("serves the stored bytes with the kernel's own digest", async () => {
    mockedService.mockReturnValue({ handle: "alice" } as never);
    const queued = await storePdf();
    const response = await extractBytesGET(
      serviceRequest(
        `http://x/api/extract/bytes?extractId=${queued.extractId}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("x-extract-sha256")).toBe(SHA);
    expect((await response.arrayBuffer()).byteLength).toBe(PDF_BYTES.byteLength);
  });

  it("answers 404, not 500, when the Source bytes are gone", async () => {
    // A 500 reads to the poller as "the kernel is broken, keep polling", so a
    // single vanished Source had every poll retry it forever. A 404 is a
    // terminal answer the poller fails the record on.
    mockedService.mockReturnValue({ handle: "alice" } as never);
    const queued = await storePdf();
    const record = (await getExtractJob(queued.extractId))!;
    await getStorage().deleteFile(record.storageKey);

    const response = await extractBytesGET(
      serviceRequest(
        `http://x/api/extract/bytes?extractId=${queued.extractId}`,
      ),
    );
    expect(response.status).toBe(404);
  });
});

describe("GET /api/workbench/media", () => {
  /**
   * Through the same writer the Intake door uses, not `writeAsset` on a guessed
   * key: the display path the tree hands the column is resolved back through
   * the owner's silo, and a byte door tested against a hand-built key would
   * pass while the real one 404s.
   */
  async function storePng() {
    await saveRawSourceBytes("shots", SHA, "png", PNG_BYTES.buffer as ArrayBuffer, {
      owner: "alice",
    });
  }

  it("returns the raw PNG bytes, undecoded, as image/png", async () => {
    await storePng();
    const response = await mediaGET(
      new Request(
        `http://x/api/workbench/media?path=${encodeURIComponent(
          `raw/sources/shots/${SHA}.png`,
        )}`,
      ),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("Accept-Ranges")).toBe("bytes");
    // The bytes, byte for byte. A UTF-8 round trip would have replaced 0xff.
    const served = new Uint8Array(await response.arrayBuffer());
    expect(Array.from(served)).toEqual(Array.from(PNG_BYTES));
  });

  it("refuses a .md path — this door serves media and nothing else", async () => {
    // Without the format check it would be a general byte door for the whole
    // raw silo, at the Preview's reach but skipping the frontmatter strip, the
    // body cap and the disputed flag.
    await getStorage().writeFile("raw/sources/notes/secret.md", "# Secret");
    const response = await mediaGET(
      new Request(
        "http://x/api/workbench/media?path=raw%2Fsources%2Fnotes%2Fsecret.md",
      ),
    );
    expect(response.status).toBe(404);
  });

  it("answers a Range with 206 and the requested slice", async () => {
    // Safari will not play an <audio> source at all without range support, and
    // no browser can seek without it.
    await storePng();
    const response = await mediaGET(
      new Request(
        `http://x/api/workbench/media?path=${encodeURIComponent(
          `raw/sources/shots/${SHA}.png`,
        )}`,
        { headers: { range: "bytes=4-7" } },
      ),
    );
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(
      `bytes 4-7/${PNG_BYTES.byteLength}`,
    );
    expect(Array.from(new Uint8Array(await response.arrayBuffer()))).toEqual(
      Array.from(PNG_BYTES.slice(4, 8)),
    );
  });

  it("answers 416 for a range past the end", async () => {
    await storePng();
    const response = await mediaGET(
      new Request(
        `http://x/api/workbench/media?path=${encodeURIComponent(
          `raw/sources/shots/${SHA}.png`,
        )}`,
        { headers: { range: "bytes=9999-" } },
      ),
    );
    expect(response.status).toBe(416);
  });
});

describe("POST /api/workbench/activity — Retry", () => {
  it("re-offers the extract instead of reading a PDF as UTF-8 text", async () => {
    // No poller ever stamped, so the arrival failed closed — which is the
    // state a Retry button exists for.
    const queued = await storePdf();
    expect(await getExtractJob(queued.extractId)).toMatchObject({
      status: "failed",
    });

    const response = await activityPOST(
      new NextRequest("http://x/api/workbench/activity", {
        method: "POST",
        body: JSON.stringify({ action: "retry", jobId: queued.jobId }),
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ retried: true, extract: true });

    expect(await getExtractJob(queued.extractId)).toMatchObject({
      status: "queued",
      error: "",
    });
    // The row is live again, and still an extract — not an `Analysis` for text
    // that does not exist.
    expect(await getIngestJob(queued.jobId)).toMatchObject({
      kind: "extract",
      status: "queued",
    });
  });
});
