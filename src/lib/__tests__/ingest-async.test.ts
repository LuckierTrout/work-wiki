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
import { logger } from "@/lib/logger";

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

  // -------------------------------------------------------------------------
  // The inline answer budget (DW-700)
  // -------------------------------------------------------------------------
  //
  // Off-Workers the FULL `ingest()` used to run inside the request, after the
  // Source was already stored and with nothing bounding it. The client's
  // `REQUEST_TIMEOUT_MS` fired first and the owner was told "the outcome is
  // unknown" about a Source that had landed. The budget is opt-in: omitting it
  // must leave every other caller exactly as it was, which every case above
  // (all of which omit it) is what pins.

  it("a budget is never consulted when the enqueue succeeds", async () => {
    // The queue-present half of a budgeted door (both Workbench doors pass the
    // option unconditionally). The enqueue answers first, so a budget of 0 --
    // which would abandon any inline run instantly -- changes nothing: the
    // inline callback is never even built into a race.
    mockedEnqueue.mockResolvedValue(true);
    const inline = vi.fn();
    const res = await enqueueOrInline("j-queued", { ...task, jobId: "j-queued" }, inline, {
      inlineBudgetMs: 0,
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, jobId: "j-queued" });
    expect(inline).not.toHaveBeenCalled();
    expect(mockedUpdate).not.toHaveBeenCalled();
  });

  it("a budgeted inline run that finishes in time behaves exactly as today", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const res = await enqueueOrInline(
      "j-in-budget",
      { ...task, jobId: "j-in-budget" },
      async () => ({ primarySlug: "page-a" }),
      { inlineBudgetMs: 30_000 },
    );
    expect(await res.json()).toEqual({
      queued: true,
      jobId: "j-in-budget",
      slug: "page-a",
    });
    expect(mockedUpdate).toHaveBeenCalledWith("j-in-budget", {
      status: "done",
      slug: "page-a",
    });
  });

  it("an inline run still going at the deadline answers {queued,jobId} and keeps marking the job", async () => {
    mockedEnqueue.mockResolvedValue(false);
    let finish!: (value: { primarySlug: string }) => void;
    const inline = vi.fn(
      () => new Promise<{ primarySlug: string }>((resolve) => { finish = resolve; }),
    );

    const res = await enqueueOrInline("j-late", { ...task, jobId: "j-late" }, inline, {
      inlineBudgetMs: 0,
    });

    // The honest body: the Source is stored, the job exists, work is in flight
    // — and this is the shape `workbench-intake-client.ts` already polls.
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ queued: true, jobId: "j-late" });
    // Nothing terminal has been written yet; the run is genuinely still going.
    expect(mockedUpdate).not.toHaveBeenCalled();

    // ABANDONED, NOT CANCELLED: the continuation still reaches the job record.
    finish({ primarySlug: "page-late" });
    await vi.waitFor(() =>
      expect(mockedUpdate).toHaveBeenCalledWith("j-late", {
        status: "done",
        slug: "page-late",
      }),
    );
  });

  it("catches and logs a rejection from an abandoned run rather than leaving it unhandled", async () => {
    mockedEnqueue.mockResolvedValue(false);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      let fail!: (err: unknown) => void;
      const inline = vi.fn(
        () => new Promise<{ primarySlug: string }>((_, reject) => { fail = reject; }),
      );

      const res = await enqueueOrInline(
        "j-late-throw",
        { ...task, jobId: "j-late-throw" },
        inline,
        { inlineBudgetMs: 0 },
      );
      expect(await res.json()).toEqual({ queued: true, jobId: "j-late-throw" });

      fail(new Error("synthesis failed late"));

      // The abandoned run still marks the job failed...
      await vi.waitFor(() =>
        expect(mockedUpdate).toHaveBeenCalledWith(
          "j-late-throw",
          expect.objectContaining({
            status: "failed",
            error: expect.stringContaining("synthesis failed late"),
          }),
        ),
      );
      // ...and its rethrow is owned, not left to surface as a crash.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "ingest",
        expect.stringContaining("j-late-throw"),
        expect.any(Error),
      );
    } finally {
      process.off("unhandledRejection", unhandled);
      warn.mockRestore();
    }
  });
});
