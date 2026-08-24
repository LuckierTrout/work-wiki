import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/tasks", () => ({ enqueueTask: vi.fn() }));
vi.mock("@/lib/ingest-jobs", () => ({ updateIngestJob: vi.fn(async () => null) }));
vi.mock("@/lib/todo-dispatch", () => ({
  dispatchMeetingTodoExtract: vi.fn(async () => "skipped"),
}));
vi.mock("@/lib/review-queue", async (orig) => ({
  ...(await orig<typeof import("@/lib/review-queue")>()),
  enqueueReviewAfterIngest: vi.fn(async () => {}),
  rememberReviewOutbox: vi.fn(async () => {}),
}));
vi.mock("@/lib/ingest-analysis", () => ({
  hasIngestAnalysis: vi.fn(async () => false),
}));

import { enqueueTask } from "@/lib/tasks";
import { updateIngestJob } from "@/lib/ingest-jobs";
import { dispatchMeetingTodoExtract } from "@/lib/todo-dispatch";
import { hasIngestAnalysis } from "@/lib/ingest-analysis";
import { enqueueReviewAfterIngest, ReviewDeliveryUnretainedError } from "@/lib/review-queue";
import { enqueueOrInline } from "@/lib/ingest-async";

const mockedEnqueue = vi.mocked(enqueueTask);
const mockedUpdate = vi.mocked(updateIngestJob);
const mockedDispatch = vi.mocked(dispatchMeetingTodoExtract);
const mockedReview = vi.mocked(enqueueReviewAfterIngest);
const mockedHasAnalysis = vi.mocked(hasIngestAnalysis);

beforeEach(() => {
  vi.clearAllMocks();
  mockedUpdate.mockResolvedValue(null);
});

const task = { kind: "ingest" as const, url: "https://x/a", jobId: "j1" };

describe("enqueueOrInline", () => {
  it("enqueued → returns {queued,jobId} and does NOT run inline", async () => {
    mockedEnqueue.mockResolvedValue(true);
    const inline = vi.fn();
    const res = await enqueueOrInline("j1", task, inline);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, jobId: "j1" });
    expect(inline).not.toHaveBeenCalled();
  });

  it("queue absent → runs inline, marks job done, returns the slug", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const res = await enqueueOrInline("j1", task, async () => ({ primarySlug: "page-a" }));
    expect(await res.json()).toEqual({ queued: true, jobId: "j1", slug: "page-a" });
    expect(mockedUpdate).toHaveBeenCalledWith("j1", { status: "done", slug: "page-a" });
  });

  it("queue absent + skipped inline → marks the job skipped", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const res = await enqueueOrInline("j1", task, async () => ({
      primarySlug: "page-a",
      skipped: true,
    }));
    expect(await res.json()).toEqual({
      queued: false,
      skipped: true,
      jobId: "j1",
      slug: "page-a",
    });
    expect(mockedUpdate).toHaveBeenCalledWith("j1", {
      status: "skipped",
      stage: "complete",
      slug: "page-a",
    });
  });

  it("enqueue THROWS → marks job failed and rethrows (no stuck 'queued')", async () => {
    mockedEnqueue.mockRejectedValue(new Error("queue down"));
    await expect(enqueueOrInline("j1", task, vi.fn())).rejects.toThrow("queue down");
    expect(mockedUpdate).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("queue down") }),
    );
  });

  it("inline THROWS (queue absent) → marks job failed and rethrows", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const inline = vi.fn().mockRejectedValue(new Error("synthesis failed"));
    await expect(enqueueOrInline("j1", task, inline)).rejects.toThrow("synthesis failed");
    expect(mockedUpdate).toHaveBeenCalledWith(
      "j1",
      expect.objectContaining({ status: "failed", error: expect.stringContaining("synthesis failed") }),
    );
    // It must NOT then mark done.
    expect(mockedUpdate).not.toHaveBeenCalledWith("j1", expect.objectContaining({ status: "done" }));
  });

  it("dispatches meeting extract after a successful owner inline ingest", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedDispatch.mockResolvedValueOnce("ran");
    const owned = {
      kind: "ingest" as const,
      jobId: "j1",
      owner: "alice",
      origin: "plaud" as const,
      sourcePath: "raw/sources/meet/a.md",
    };
    await enqueueOrInline("j1", owned, async () => ({ primarySlug: "meet" }));
    expect(mockedDispatch).toHaveBeenCalledWith(
      "alice",
      {
        origin: "plaud",
        sourcePath: "raw/sources/meet/a.md",
        slug: "meet",
      },
      { failSoft: true },
    );
  });

  it("does not dispatch meeting extract when the inline ingest is skipped", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const owned = {
      kind: "ingest" as const,
      jobId: "j1",
      owner: "alice",
      origin: "plaud" as const,
    };
    await enqueueOrInline("j1", owned, async () => ({
      primarySlug: "meet",
      skipped: true,
    }));
    expect(mockedDispatch).not.toHaveBeenCalled();
    expect(mockedReview).not.toHaveBeenCalled();
  });

  it("enqueues Review after a successful owner inline compile", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const owned = {
      kind: "ingest" as const,
      jobId: "j-review",
      owner: "alice",
    };
    await enqueueOrInline("j-review", owned, async () => ({ primarySlug: "topic" }));
    expect(mockedReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "topic",
      jobId: "j-review",
    });
  });

  it("enqueues Review under the author when that is the only owner", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const authored = {
      kind: "ingest" as const,
      jobId: "j-author",
      author: "solo-author",
    };
    await enqueueOrInline("j-author", authored, async () => ({ primarySlug: "topic" }));
    expect(mockedReview).toHaveBeenCalledWith({
      owner: "solo-author",
      pageSlug: "topic",
      jobId: "j-author",
    });
  });

  it("retries Review enqueue on a skipped inline ingest that already has analysis", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedHasAnalysis.mockResolvedValueOnce(true);
    const owned = {
      kind: "ingest" as const,
      jobId: "j-skip",
      owner: "alice",
    };
    await enqueueOrInline("j-skip", owned, async () => ({
      primarySlug: "existing",
      skipped: true,
    }));
    expect(mockedReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "existing",
      jobId: "j-skip",
    });
  });

  it("keeps a skipped compile successful when the Analysis existence read fails", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedHasAnalysis.mockRejectedValueOnce(new Error("analysis unavailable"));
    const owned = { kind: "ingest" as const, jobId: "j-skip-read", owner: "alice" };
    const res = await enqueueOrInline("j-skip-read", owned, async () => ({
      primarySlug: "existing",
      skipped: true,
    }));
    expect(res.status).toBe(200);
    expect((await res.json()).skipped).toBe(true);
    expect(mockedReview).toHaveBeenCalledWith({
      owner: "alice",
      pageSlug: "existing",
      jobId: "j-skip-read",
    });
  });

  it("does not mark compile done when Review delivery is not retained", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedReview.mockRejectedValueOnce(new ReviewDeliveryUnretainedError());
    const owned = { kind: "ingest" as const, jobId: "j-unretained", owner: "alice" };
    const res = await enqueueOrInline("j-unretained", owned, async () => ({ primarySlug: "topic" }));
    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("j-unretained", {
      status: "failed",
      error: "Review delivery was not retained",
      slug: "topic",
    });
    expect(mockedUpdate).not.toHaveBeenCalledWith(
      "j-unretained",
      expect.objectContaining({ status: "done" }),
    );
  });

  it("keeps a successful compile done when Review delivery fails", async () => {
    mockedEnqueue.mockResolvedValue(false);
    mockedReview.mockRejectedValueOnce(new Error("review unavailable"));
    const owned = { kind: "ingest" as const, jobId: "j-review-fail", owner: "alice" };
    const res = await enqueueOrInline("j-review-fail", owned, async () => ({ primarySlug: "topic" }));
    expect(res.status).toBe(200);
    expect(mockedUpdate).toHaveBeenCalledWith("j-review-fail", {
      status: "done",
      slug: "topic",
    });
  });
});
