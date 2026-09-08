/**
 * The kernel half of the sidecar extract path (Story 7.1).
 *
 * This suite pins the extract rows of the spec's I/O matrix — "binary Intake,
 * sidecar up", "sidecar down", "PDF cache hit" — at the seam where they are
 * decidable without a Rust process: the job registry, the claim, and the
 * completion that turns extracted text into an Ingest.
 *
 * REAL STORAGE, NOT A MOCK. Every invariant here is about what is on disk when
 * something goes wrong — the bytes surviving a failed extract, a claim that two
 * pollers cannot both win, a compile that does not exist until the text does.
 * A mocked storage layer would let all three pass while none of them held.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

// The compile is the one thing this suite must NOT run: it would reach an LLM.
// Stubbed at the two seams `completeExtract` uses, so the assertions can be
// about WHETHER a compile was started and with what, which is the acceptance
// criterion "two-step Ingest started only after that text existed".
vi.mock("../ingest", () => ({ ingest: vi.fn(async () => ({ primarySlug: "plan" })) }));
vi.mock("../ingest-async", () => ({
  enqueueOrInline: vi.fn(async () => ({ ok: true, queued: true })),
}));
vi.mock("../vault", () => ({ addToVault: vi.fn(async () => {}) }));

import { enqueueOrInline } from "../ingest-async";
import { getIngestJob } from "../ingest-jobs";
import {
  claimExtract,
  completeExtract,
  enqueueExtract,
  failExtract,
  retryExtract,
} from "../extract-dispatch";
import { extractOwnerFor, type ExtractCaller } from "../extract-auth";
import {
  EXTRACT_CLAIM_TTL_MS,
  EXTRACT_EMPTY_TEXT_COPY,
  EXTRACT_SIDECAR_DOWN_COPY,
  claimExtractJob,
  createExtractJob,
  getExtractJob,
  isClaimExpired,
  isSidecarDownFailure,
  listClaimableExtractJobs,
  listExtractJobs,
  purgeStaleExtractJobs,
} from "../extract-jobs";
import {
  EXTRACT_POLL_ANY,
  EXTRACT_POLL_FRESH_MS,
  isExtractPollerLive,
  recordExtractPoll,
} from "../extract-heartbeat";
import { _resetStorage, getStorage } from "../storage";
import { _resetLocks } from "../lock";

const mockedEnqueueOrInline = vi.mocked(enqueueOrInline);

let tmpDir: string;
let originalDataDir: string | undefined;
let originalWikiDir: string | undefined;

const BYTES = new TextEncoder().encode("%PDF-1.7 fake").buffer;
const SHA = "ab".repeat(32);

function arrival(overrides: Partial<Parameters<typeof enqueueExtract>[0]> = {}) {
  return {
    owner: "alice",
    slug: "quarterly-plan",
    bytesSha256: SHA,
    ext: "pdf",
    format: "pdf" as const,
    filename: "quarterly-plan.pdf",
    title: "Quarterly Plan",
    bytes: BYTES,
    ...overrides,
  };
}

/** A sidecar that polled just now, so arrivals queue rather than fail closed. */
async function sidecarUp() {
  await recordExtractPoll(EXTRACT_POLL_ANY);
}

beforeEach(async () => {
  vi.clearAllMocks();
  mockedEnqueueOrInline.mockResolvedValue({ ok: true, queued: true } as never);
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "extract-jobs-test-"));
  originalDataDir = process.env.DATA_DIR;
  originalWikiDir = process.env.WIKI_DIR;
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  _resetStorage();
  _resetLocks();
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

describe("extract arrival — bytes first, compile last", () => {
  it("stores the bytes, parks the compile, and queues a claimable record", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival());

    // 1. The bytes are in the vault, at the content-addressed Source path.
    expect(result.path).toBe(`raw/sources/quarterly-plan/${SHA}.pdf`);
    expect(result.storedBytes).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.sidecarDown).toBeUndefined();

    // 2. The owner has a row, and it is NOT a compile yet.
    const job = await getIngestJob(result.jobId);
    expect(job).toMatchObject({ kind: "extract", stage: "extracting", owner: "alice" });

    // 3. The sidecar has something to claim.
    const claimable = await listClaimableExtractJobs("alice");
    expect(claimable.map((row) => row.extractId)).toEqual([result.extractId]);

    // Nothing has been handed to Ingest — the text does not exist.
    expect(mockedEnqueueOrInline).not.toHaveBeenCalled();
  });

  it("re-stores nothing when the same bytes arrive twice", async () => {
    // `saveRawSourceBytes` is first-write-only, so the second arrival gets a
    // record over the SAME bytes. This is the kernel side of the PDF parse
    // cache: one digest, one stored object, and the sidecar keyed on it.
    await sidecarUp();
    const first = await enqueueExtract(arrival());
    const second = await enqueueExtract(arrival());
    expect(second.path).toBe(first.path);
    expect(first.storedBytes).toBe(true);
    expect(second.storedBytes).toBe(false);
    expect(second.extractId).not.toBe(first.extractId);
  });

  it("mirrors the stored bytes into the owner's silo, not just the flat key", async () => {
    // `resolveWorkbenchFile` resolves `raw/` STRICTLY inside
    // `tenants/<tenant>/raw/` and never falls back to the shared flat tree
    // (DW-40). A byte writer that skipped the mirror stored the PDF correctly
    // and left it invisible in Files and unreachable through the media door —
    // the arrival succeeds, and the owner can neither see nor open it.
    await sidecarUp();
    const stored = await enqueueExtract(arrival());
    expect(stored.storedBytes).toBe(true);

    const { tenantForOwner } = await import("@/lib/wiki");
    const { tenantRawSourceRelPath } = await import("@/lib/raw");
    const silo = tenantRawSourceRelPath(
      tenantForOwner("alice"),
      `quarterly-plan/${SHA}.pdf`,
    );
    await expect(getStorage().readAsset(silo)).resolves.toBeDefined();
  });

  it("carries the vault and tags the arriving door knew onto the record", async () => {
    // The completing door cannot rediscover either, and an extract that
    // dropped them turns "file this into my vault with these tags" into
    // "store this" with nothing on screen saying so.
    await sidecarUp();
    const result = await enqueueExtract(
      arrival({ vaultId: "vault-1", tags: ["finance", "q3"] }),
    );
    expect(await getExtractJob(result.extractId)).toMatchObject({
      vaultId: "vault-1",
      tags: ["finance", "q3"],
    });
  });
});

describe("sidecar down — the row fails, the Source does not", () => {
  it("keeps the bytes and fails the record with the locked sentence", async () => {
    // No poll was ever recorded, which is exactly the state of a machine where
    // the owner never started the sidecar.
    const result = await enqueueExtract(arrival());
    expect(result.sidecarDown).toBe(true);

    // The bytes are on disk. This is the assertion the whole epic rests on.
    const stored = await getStorage().readAsset(
      `raw/sources/quarterly-plan/${SHA}.pdf`,
    );
    expect(stored.byteLength).toBe(BYTES.byteLength);

    // Both records carry the reason, verbatim — the extract record is the
    // sidecar's view, the ingest job is the one Activity reads.
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "failed",
      error: EXTRACT_SIDECAR_DOWN_COPY,
    });
    expect(await getIngestJob(result.jobId)).toMatchObject({
      status: "failed",
      error: EXTRACT_SIDECAR_DOWN_COPY,
    });
  });

  it("re-offers a sidecar-down record once a poller comes back", async () => {
    // A parse that failed on a corrupt file is a fact about the DOCUMENT and
    // stays failed. This failure is a fact about the MACHINE, and it stops
    // being true the moment a sidecar starts.
    const result = await enqueueExtract(arrival());
    const failed = (await getExtractJob(result.extractId))!;
    expect(isSidecarDownFailure(failed)).toBe(true);

    const claimable = await listClaimableExtractJobs("alice");
    expect(claimable.map((row) => row.extractId)).toEqual([result.extractId]);

    // Claiming it clears the stale sentence off BOTH records, or the owner
    // reads "the sidecar is down" beside a parse that is running.
    const claimed = await claimExtract(result.extractId, "alice");
    expect(claimed).toMatchObject({ status: "claimed", error: "" });
    expect(await getIngestJob(result.jobId)).toMatchObject({
      status: "queued",
      stage: "extracting",
      error: "",
    });
  });

  it("does not re-offer a record that failed on the document itself", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await failExtract({
      extractId: result.extractId,
      owner: "alice",
      error: "DOCX could not be read: it is not a ZIP archive.",
    });
    expect(await listClaimableExtractJobs("alice")).toEqual([]);
    // …and the reason reached the row the owner is watching, verbatim.
    expect(await getIngestJob(result.jobId)).toMatchObject({
      status: "failed",
      error: "DOCX could not be read: it is not a ZIP archive.",
    });
  });

  it("counts a poll for one owner and an unscoped poll as the same liveness", async () => {
    expect(await isExtractPollerLive("alice")).toBe(false);
    await recordExtractPoll("alice");
    expect(await isExtractPollerLive("alice")).toBe(true);
    // Stale is down: absence of a recent poll is the signal, because a killed
    // process writes nothing on the way out.
    expect(
      await isExtractPollerLive("alice", Date.now() + EXTRACT_POLL_FRESH_MS + 1000),
    ).toBe(false);
    // The sidecar drains every owner without being told a handle, so its
    // unscoped stamp has to vouch for a handle it never learned.
    expect(await isExtractPollerLive("bob")).toBe(false);
    await recordExtractPoll(EXTRACT_POLL_ANY);
    expect(await isExtractPollerLive("bob")).toBe(true);
  });
});

describe("the claim", () => {
  it("is won once — a second poller gets null, not a duplicate parse", async () => {
    await sidecarUp();
    const { extractId } = await enqueueExtract(arrival());
    const [first, second] = await Promise.all([
      claimExtractJob(extractId, "alice"),
      claimExtractJob(extractId, "alice"),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect(await getExtractJob(extractId)).toMatchObject({
      status: "claimed",
      attempts: 1,
    });
  });

  it("refuses a claim in another owner's name", async () => {
    await sidecarUp();
    const { extractId } = await enqueueExtract(arrival());
    expect(await claimExtractJob(extractId, "mallory")).toBeNull();
    expect(await getExtractJob(extractId)).toMatchObject({ status: "queued" });
  });

  it("re-offers a claim whose sidecar died mid-parse", async () => {
    // Without a TTL the owner is left with a Source that says `Extract`
    // forever, because a killed poller never writes a terminal status.
    await sidecarUp();
    const { extractId } = await enqueueExtract(arrival());
    const claimed = (await claimExtractJob(extractId, "alice"))!;
    expect(isClaimExpired(claimed)).toBe(false);
    expect(
      isClaimExpired(claimed, Date.now() + EXTRACT_CLAIM_TTL_MS + 1000),
    ).toBe(true);

    const stale = {
      ...claimed,
      claimedAt: new Date(Date.now() - EXTRACT_CLAIM_TTL_MS - 5000).toISOString(),
    };
    await getStorage().writeFile(
      `extract-jobs/${extractId}.json`,
      JSON.stringify(stale),
    );
    const reclaimed = await claimExtractJob(extractId, "alice");
    expect(reclaimed).toMatchObject({ status: "claimed", attempts: 2 });
  });
});

describe("completion — text first, then the compile", () => {
  it("writes the text beside the bytes and starts one Ingest", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival({ vaultId: "vault-1" }));
    await claimExtract(result.extractId, "alice");

    const done = await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "# Quarterly Plan\n\nRevenue is up.",
    });

    expect(done.ok).toBe(true);
    if (!done.ok) return;
    // Same slug, same digest, `.md` instead of `.pdf`: one Source identity with
    // two representations, not two Sources that happen to be related.
    expect(done.textRel).toBe(`raw/sources/quarterly-plan/${SHA}.md`);
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "done",
      textRel: done.textRel,
    });

    // The compile is enqueued NOW, against the text path, and never before.
    expect(mockedEnqueueOrInline).toHaveBeenCalledTimes(1);
    const [jobId, task] = mockedEnqueueOrInline.mock.calls[0];
    expect(jobId).toBe(result.jobId);
    expect(task).toMatchObject({
      kind: "ingest",
      title: "Quarterly Plan",
      owner: "alice",
      sourcePath: done.textRel,
      vaultId: "vault-1",
    });
    // One vault: the compile reads the text out of `raw/sources/`, and no
    // second copy was minted for the sidecar to work from.
    expect(await getIngestJob(result.jobId)).toMatchObject({
      kind: "ingest",
      sourceRel: done.textRel,
    });
  });

  it("records a cache hit without re-running anything", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "cached text",
      cacheHit: true,
    });
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "done",
      cacheHit: true,
    });
  });

  it("FAILS the record on empty text rather than leaving it claimed", async () => {
    // A PDF whose built-in extract found no glyphs is exactly the complex-layout
    // case MinerU exists for. Compiling nothing would hide it — and so would
    // returning without touching the record, which is what this used to do: a
    // `claimed` record is not claimable again until its TTL expires, so the row
    // said `Extract` for the rest of the hour for a document that had already
    // finished failing.
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    const done = await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "   \n  ",
    });
    expect(done).toEqual({ ok: false, reason: "empty" });
    expect(mockedEnqueueOrInline).not.toHaveBeenCalled();
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "failed",
      error: EXTRACT_EMPTY_TEXT_COPY,
    });
    // And the reason reached the row the owner is actually watching.
    expect(await getIngestJob(result.jobId)).toMatchObject({
      status: "failed",
      error: EXTRACT_EMPTY_TEXT_COPY,
    });
  });

  it("will not fail an extract that is already done", async () => {
    // The late failure is real: a poller whose `complete` timed out on the wire
    // retries as `fail`, and a retry can race a success. Letting it through put
    // a red row over a Source that extracted fine — and there is nothing left
    // to re-offer, because the bytes have already become text.
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "# Plan",
    });
    await failExtract({
      extractId: result.extractId,
      owner: "alice",
      error: "Extract timed out.",
    });
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "done",
      error: "",
    });
  });

  it("keeps the extractor's Markdown under raw/parsed/ only when asked", async () => {
    await sidecarUp();
    const off = await enqueueExtract(arrival());
    await claimExtract(off.extractId, "alice");
    await completeExtract({
      extractId: off.extractId,
      owner: "alice",
      text: "# Plan",
    });
    // DEFAULT IS OFF: `raw/parsed/` is a second copy of every document's text,
    // and it must be the owner's choice to keep one.
    await expect(
      getStorage().readFile(`raw/parsed/quarterly-plan/${SHA}.md`),
    ).rejects.toThrow();

    const on = await enqueueExtract(
      arrival({ slug: "kept-plan", bytesSha256: "cd".repeat(32) }),
    );
    await claimExtract(on.extractId, "alice");
    await completeExtract({
      extractId: on.extractId,
      owner: "alice",
      text: "# Kept",
      keepParsed: true,
    });
    expect(
      await getStorage().readFile(`raw/parsed/kept-plan/${"cd".repeat(32)}.md`),
    ).toContain("# Kept");
  });

  it("compiles an extracted PDF as a pdf, not as a paste", async () => {
    // `sourceType: "text"` for every extract put an emailed contract and a
    // typed note in the ledger under the same word.
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "# Plan",
    });
    expect(mockedEnqueueOrInline.mock.calls[0][1]).toMatchObject({
      sourceType: "pdf",
    });
  });

  it("compiles an emailed PDF as email, carrying the arrival's own metadata", async () => {
    await sidecarUp();
    const email = {
      from: "sender@example.com",
      to: "in@example.com",
      subject: "Contract",
      messageId: "<m1@example.com>",
      attachmentNames: ["contract.pdf"],
      receivedAt: "2026-08-25T10:00:00.000Z",
    };
    const result = await enqueueExtract(arrival({ email }));
    await claimExtract(result.extractId, "alice");
    await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "# Contract",
    });
    // `email` WINS over the format: `tasks.ts` refuses a task whose sourceType
    // is `email` without the metadata, and "this came from the inbox" is the
    // more useful of the two facts.
    expect(mockedEnqueueOrInline.mock.calls[0][1]).toMatchObject({
      sourceType: "email",
      email: expect.objectContaining({ receivedAt: email.receivedAt }),
    });
  });

  it("refuses a second completion and a completion in someone else's name", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    const args = { extractId: result.extractId, owner: "alice", text: "body" };
    expect((await completeExtract(args)).ok).toBe(true);
    expect(await completeExtract(args)).toEqual({ ok: false, reason: "wrong-state" });
    expect(
      await completeExtract({ ...args, owner: "mallory" }),
    ).toEqual({ ok: false, reason: "not-found" });
    expect(mockedEnqueueOrInline).toHaveBeenCalledTimes(1);
  });

  it("keeps the Source when the compile could not be queued", async () => {
    await sidecarUp();
    const result = await enqueueExtract(arrival());
    await claimExtract(result.extractId, "alice");
    mockedEnqueueOrInline.mockRejectedValueOnce(new Error("queue unavailable"));

    const done = await completeExtract({
      extractId: result.extractId,
      owner: "alice",
      text: "body",
    });
    // The extract itself SUCCEEDED — the text is on disk and the record says so.
    expect(done.ok).toBe(true);
    expect(await getExtractJob(result.extractId)).toMatchObject({ status: "done" });
    // The owner's row carries the reason rather than stopping silently.
    expect(await getIngestJob(result.jobId)).toMatchObject({
      status: "failed",
      error: "queue unavailable",
    });
  });
});

describe("listing order", () => {
  it("answers readers newest-first and the poller oldest-first", async () => {
    await sidecarUp();
    const first = await enqueueExtract(arrival({ slug: "one", bytesSha256: "11".repeat(32) }));
    // The records are written inside the same millisecond otherwise, and the
    // sort has nothing to order by.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = await enqueueExtract(arrival({ slug: "two", bytesSha256: "22".repeat(32) }));

    // A reader asking for N of many wants the recent ones — the same order
    // `listIngestJobs` answers in, and the order this function's docblock
    // promised while it was in fact answering the opposite.
    expect((await listExtractJobs({ owner: "alice" })).map((row) => row.extractId)).toEqual([
      second.extractId,
      first.extractId,
    ]);
    // The poller needs arrival order, or a backlog starves its oldest document
    // behind everything dropped after it.
    expect(
      (await listClaimableExtractJobs("alice")).map((row) => row.extractId),
    ).toEqual([first.extractId, second.extractId]);
  });
});

describe("retry — the bytes are re-offered, never re-read as text", () => {
  it("re-queues the extract behind a failed row and revives that row", async () => {
    // Activity's generic Retry reads the stored Source with `readFile`, which
    // DECODES UTF-8 — correct for a pasted note, and for a PDF it compiles a
    // page of replacement characters from a button labelled Retry.
    const result = await enqueueExtract(arrival()); // sidecar down → failed
    expect(await getExtractJob(result.extractId)).toMatchObject({ status: "failed" });

    expect(await retryExtract("alice", result.jobId)).toBe(true);
    expect(await getExtractJob(result.extractId)).toMatchObject({
      status: "queued",
      error: "",
    });
    expect(await getIngestJob(result.jobId)).toMatchObject({
      kind: "extract",
      status: "queued",
      stage: "extracting",
      error: "",
    });
  });

  it("reports false when there is no extract record behind the row", async () => {
    // The caller's signal to refuse rather than fall through to the text path.
    expect(await retryExtract("alice", "no-such-job")).toBe(false);
  });

  it("will not re-offer another owner's record", async () => {
    const result = await enqueueExtract(arrival());
    expect(await retryExtract("mallory", result.jobId)).toBe(false);
    expect(await getExtractJob(result.extractId)).toMatchObject({ status: "failed" });
  });
});

describe("who may act on a record", () => {
  const session = (owner: string): ExtractCaller => ({ owner, service: false });
  const service = (owner: string | null): ExtractCaller => ({ owner, service: true });

  it("scopes a session to its own records and lets the unscoped sidecar act as the owner", () => {
    expect(extractOwnerFor(session("alice"), "alice")).toBe("alice");
    expect(extractOwnerFor(session("alice"), "bob")).toBeNull();
    // The poller never learned a handle, so it inherits the RECORD's — which
    // is what keeps "text is written as whoever stored the bytes" true.
    expect(extractOwnerFor(service(null), "bob")).toBe("bob");
    expect(extractOwnerFor(service("alice"), "bob")).toBeNull();
    // An unscoped CLERK caller is not a thing; refuse rather than widen.
    expect(extractOwnerFor({ owner: null, service: false }, "alice")).toBeNull();
  });
});

describe("housekeeping", () => {
  it("purges terminal records and leaves live ones alone", async () => {
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (const [extractId, status] of [
      ["11111111-1111-1111-1111-111111111111", "done"],
      ["22222222-2222-2222-2222-222222222222", "failed"],
      ["33333333-3333-3333-3333-333333333333", "queued"],
    ] as const) {
      await createExtractJob({
        extractId,
        owner: "alice",
        sourceRel: `raw/sources/s/${SHA}.pdf`,
        slug: "s",
        storageKey: `raw/sources/s/${SHA}.pdf`,
        filename: "s.pdf",
        format: "pdf",
        bytesSha256: SHA,
        size: 10,
        ingestJobId: "job",
        title: "S",
      });
      const job = (await getExtractJob(extractId))!;
      await getStorage().writeFile(
        `extract-jobs/${extractId}.json`,
        JSON.stringify({ ...job, status, updatedAt: old }),
      );
    }
    expect(await purgeStaleExtractJobs()).toBe(2);
    expect(await getExtractJob("33333333-3333-3333-3333-333333333333")).not.toBeNull();
  });

  it("refuses an id that would escape the jobs prefix", async () => {
    await expect(getExtractJob("../../secrets")).rejects.toThrow(/invalid extract job id/);
  });
});
