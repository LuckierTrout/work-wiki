/**
 * Executed Workbench routes for Epic 2 Activity, Source delete, files listing,
 * and vector-on backfill. These replace source-text pins for the controls the
 * retrospective required: retry, cancel, cascade delete, progressive files.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(() => null),
}));
vi.mock("@/lib/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  isReadOnly: vi.fn(() => false),
}));
vi.mock("@/lib/ingest-jobs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../ingest-jobs")>()),
  listIngestJobs: vi.fn(async () => []),
  cancelIngestJob: vi.fn(),
  retryIngestJob: vi.fn(),
}));
vi.mock("@/lib/ingest-async", () => ({
  enqueueOrInline: vi.fn(
    async (jobId: string) =>
      new NextResponse(JSON.stringify({ queued: true, jobId }), { status: 202 }),
  ),
}));
vi.mock("@/lib/ingest", () => ({
  ingest: vi.fn(async () => ({ slug: "retried" })),
}));
vi.mock("@/lib/ingest-analysis", () => ({
  hasIngestAnalysis: vi.fn(async () => false),
}));
vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => ({
    readFile: vi.fn(async () => "# stored source\n"),
  })),
}));
vi.mock("@/lib/source-cascade", () => ({
  cascadeDeleteSource: vi.fn(async () => ({
    deletedPages: ["sole"],
    updatedPages: ["shared"],
  })),
}));
vi.mock("@/lib/wikis", () => ({
  getWikiRegistry: vi.fn(async () => ({ currentId: "wiki-1", wikis: [] })),
}));
vi.mock("@/lib/wiki", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../wiki")>()),
  listReadableWikiPages: vi.fn(async () => []),
}));
vi.mock("@/lib/workbench-files", () => ({
  listWorkbenchFilePaths: vi.fn(async () => ({
    paths: ["raw/sources/a.md", "wiki/overview.md"],
    truncated: false,
  })),
}));

import { getPrincipal } from "@/lib/auth";
import { isReadOnly } from "@/lib/config";
import { ACTIVITY_ANSWER_BUDGET_MS } from "@/lib/constants";
import { enqueueOrInline } from "@/lib/ingest-async";
import {
  cancelIngestJob,
  listIngestJobs,
  retryIngestJob,
} from "@/lib/ingest-jobs";
import { cascadeDeleteSource } from "@/lib/source-cascade";
import { GET as GET_ACTIVITY, POST as POST_ACTIVITY } from "@/app/api/workbench/activity/route";
import { DELETE as DELETE_SOURCE } from "@/app/api/workbench/source/route";
import { GET as GET_FILES } from "@/app/api/workbench/files/route";
import { INTAKE_SIGN_IN_COPY } from "@/lib/workbench-intake";
import { READ_ONLY_REFUSAL } from "@/lib/read-only";
import { WORKBENCH_FILE_LIMIT } from "@/lib/workbench-tree";
import { listWorkbenchFilePaths } from "@/lib/workbench-files";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedList = vi.mocked(listIngestJobs);
const mockedCancel = vi.mocked(cancelIngestJob);
const mockedRetry = vi.mocked(retryIngestJob);
const mockedEnqueue = vi.mocked(enqueueOrInline);
const mockedCascade = vi.mocked(cascadeDeleteSource);
const mockedListFiles = vi.mocked(listWorkbenchFilePaths);

function jsonRequest(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function activityGet(url = "http://localhost/api/workbench/activity"): Request {
  return new Request(url);
}

/**
 * The SHAPE of the fourth argument both Activity retry paths hand
 * `enqueueOrInline` (DW-746): present, numeric, positive (the route has not
 * already blown its own budget by the time it enqueues) and never more than the
 * budget it is measured from.
 *
 * SHAPE ONLY — deliberately. This much still passes for a literal
 * `{ inlineBudgetMs: ACTIVITY_ANSWER_BUDGET_MS }`, which is the fixed margin
 * DW-746 forbids. That the number is a REMAINDER measured from ROUTE ENTRY is
 * pinned by the stall case below, which is the only assertion in the repo that
 * can tell the two apart.
 */
function expectAnswerBudget(options: unknown): void {
  const { inlineBudgetMs } = (options ?? {}) as { inlineBudgetMs?: number };
  expect(typeof inlineBudgetMs).toBe("number");
  expect(inlineBudgetMs).toBeGreaterThan(0);
  expect(inlineBudgetMs).toBeLessThanOrEqual(ACTIVITY_ANSWER_BUDGET_MS);
}

async function asJson(response: Response): Promise<{
  status: number;
  body: Record<string, unknown>;
}> {
  return {
    status: response.status,
    body: (await response.json()) as Record<string, unknown>,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "alice", handle: "alice" } as never);
  mockedReadOnly.mockReturnValue(false);
  mockedList.mockResolvedValue([]);
  mockedEnqueue.mockImplementation(
    async (jobId: string) =>
      new NextResponse(JSON.stringify({ queued: true, jobId }), { status: 202 }),
  );
});

describe("GET /api/workbench/activity", () => {
  it("answers 401 with no session", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const { status, body } = await asJson(await GET_ACTIVITY(activityGet()));
    expect(status).toBe(401);
    expect(body.error).toBe(INTAKE_SIGN_IN_COPY);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("offers Retry only for failed jobs and Cancel only for active ones", async () => {
    const now = new Date().toISOString();
    mockedList.mockResolvedValue([
      {
        jobId: "done-1",
        owner: "alice",
        status: "done",
        stage: "complete",
        createdAt: now,
        updatedAt: now,
        title: "Done",
      },
      {
        jobId: "fail-1",
        owner: "alice",
        status: "failed",
        stage: "generation",
        createdAt: now,
        updatedAt: now,
        title: "Failed",
        error: "LLM timeout",
      },
      {
        jobId: "retrying-1",
        owner: "alice",
        status: "retrying",
        stage: "queued",
        createdAt: now,
        updatedAt: now,
        title: "Retrying",
      },
      {
        jobId: "deleted-1",
        owner: "alice",
        status: "failed",
        stage: "queued",
        createdAt: now,
        updatedAt: now,
        title: "Gone",
        sourceDeleted: true,
      },
    ] as never);

    const { status, body } = await asJson(await GET_ACTIVITY(activityGet()));
    expect(status).toBe(200);
    const rows = body.rows as Array<{
      jobId: string;
      canRetry: boolean;
      canCancel: boolean;
      displayStatus: string;
    }>;
    expect(rows).toHaveLength(4);
    expect(rows.find((row) => row.jobId === "done-1")).toMatchObject({
      canRetry: false,
      canCancel: false,
      displayStatus: "succeeded",
    });
    expect(rows.find((row) => row.jobId === "fail-1")).toMatchObject({
      canRetry: true,
      canCancel: false,
      displayStatus: "failed",
    });
    expect(rows.find((row) => row.jobId === "retrying-1")).toMatchObject({
      canRetry: false,
      canCancel: true,
      displayStatus: "pending",
    });
    expect(rows.find((row) => row.jobId === "deleted-1")).toMatchObject({
      canRetry: false,
      canCancel: false,
    });
  });

  it("scopes the list to the requested Wiki", async () => {
    mockedList.mockResolvedValue([
      {
        jobId: "wiki-a",
        owner: "alice",
        status: "done",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: "A",
        wikiId: "wiki-a",
      },
    ] as never);

    const { status, body } = await asJson(
      await GET_ACTIVITY(activityGet("http://localhost/api/workbench/activity?wikiId=wiki-a")),
    );

    expect(status).toBe(200);
    expect(mockedList).toHaveBeenCalledWith({
      owner: "alice",
      limit: 100,
      wikiId: "wiki-a",
    });
    expect((body.rows as Array<{ wikiId?: string }>)[0]?.wikiId).toBe("wiki-a");
  });
});

describe("POST /api/workbench/activity", () => {
  it("cancels the named job", async () => {
    mockedCancel.mockResolvedValue({
      jobId: "job-1",
      owner: "alice",
      status: "failed",
      cancelled: true,
    } as never);
    const { status, body } = await asJson(
      await POST_ACTIVITY(
        jsonRequest("http://localhost/api/workbench/activity", {
          action: "cancel",
          jobId: "job-1",
        }) as never,
      ),
    );
    expect(status).toBe(200);
    expect(body).toEqual({ ok: true, cancelled: true });
    expect(mockedCancel).toHaveBeenCalledWith("job-1", "alice");
    expect(mockedRetry).not.toHaveBeenCalled();
  });

  it("refuses Retry when the job is not terminal-failed", async () => {
    mockedRetry.mockResolvedValue(null);
    const { status, body } = await asJson(
      await POST_ACTIVITY(
        jsonRequest("http://localhost/api/workbench/activity", {
          action: "retry",
          jobId: "retrying-1",
        }) as never,
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("Job cannot be retried.");
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("retries a failed ingest from the stored Source without a second store", async () => {
    mockedRetry.mockResolvedValue({
      jobId: "job-1",
      owner: "alice",
      status: "queued",
      kind: "ingest",
      sourceRel: "raw/sources/meet/abc.md",
      title: "Meet",
    } as never);
    const { status, body } = await asJson(
      await POST_ACTIVITY(
        jsonRequest("http://localhost/api/workbench/activity", {
          action: "retry",
          jobId: "job-1",
        }) as never,
      ),
    );
    expect(status).toBe(202);
    expect(body.retried).toBe(true);
    const task = mockedEnqueue.mock.calls[0][1] as {
      sourcePath?: string;
      content?: string;
    };
    expect(task.sourcePath).toBe("raw/sources/meet/abc.md");
    expect(task.content).toBeUndefined();
    expectAnswerBudget(mockedEnqueue.mock.calls[0][3]);
  });

  it("retries a failed embed job as vector-on backfill", async () => {
    mockedRetry.mockResolvedValue({
      jobId: "embed-1",
      owner: "alice",
      status: "queued",
      kind: "embed",
      title: "Embed current pages",
    } as never);
    const { status, body } = await asJson(
      await POST_ACTIVITY(
        jsonRequest("http://localhost/api/workbench/activity", {
          action: "retry",
          jobId: "embed-1",
        }) as never,
      ),
    );
    expect(status).toBe(202);
    expect(body.retried).toBe(true);
    expect(mockedEnqueue.mock.calls[0][1]).toMatchObject({
      jobId: "embed-1",
      rebuildEmbeddings: true,
      owner: "alice",
    });
    expectAnswerBudget(mockedEnqueue.mock.calls[0][3]);
  });

  it("hands BOTH inline retries the REMAINDER of the answer budget, not a fresh one", async () => {
    // DW-746, mirroring `workbench-intake.test.ts`'s remainder pin, and the
    // assertion neither `expectAnswerBudget` above nor the source scan in
    // `workbench-request.test.ts` can make. Both of those still pass if
    // `answerBy` is captured one line ABOVE each `enqueueOrInline` instead of
    // at route entry -- which hands the inline run a FULL 17 s after the job
    // read and the stored-Source read may already have spent most of the 20 s
    // client deadline. That is the original defect, with every other assertion
    // green. So a step that runs BEFORE both call sites is stalled for a
    // measurable interval and the budget is read off the call: a remainder
    // shrinks by what the work ahead of it spent, a fresh fixed margin does not.
    //
    // `retryIngestJob` is the stalled step because it is the ONE pre-enqueue
    // await both paths share -- the embed path reaches `enqueueOrInline` with
    // nothing else in front of it -- so one stall pins both call sites.
    const STALL_MS = 60;
    const stalledRetry = (job: Record<string, unknown>) => async () => {
      await new Promise((resolve) => setTimeout(resolve, STALL_MS));
      return job as never;
    };

    mockedRetry.mockImplementationOnce(
      stalledRetry({
        jobId: "job-1",
        owner: "alice",
        status: "queued",
        kind: "ingest",
        sourceRel: "raw/sources/meet/abc.md",
        title: "Meet",
      }),
    );
    await POST_ACTIVITY(
      jsonRequest("http://localhost/api/workbench/activity", {
        action: "retry",
        jobId: "job-1",
      }) as never,
    );

    mockedRetry.mockImplementationOnce(
      stalledRetry({
        jobId: "embed-1",
        owner: "alice",
        status: "queued",
        kind: "embed",
        title: "Embed current pages",
      }),
    );
    await POST_ACTIVITY(
      jsonRequest("http://localhost/api/workbench/activity", {
        action: "retry",
        jobId: "embed-1",
      }) as never,
    );

    const paths = [
      ["stored-Source re-ingest", mockedEnqueue.mock.calls[0]],
      ["embed rebuild", mockedEnqueue.mock.calls[1]],
    ] as const;
    for (const [label, call] of paths) {
      const budget = (call?.[3] as { inlineBudgetMs?: number } | undefined)
        ?.inlineBudgetMs;
      // Still positive: the route did not answer with a budget already spent.
      expect(budget, label).toBeGreaterThan(0);
      // THE PIN: the stall was actually subtracted. `toBeLessThan` alone passes
      // at 16_999, which a budget captured one line above the call site would
      // also produce.
      expect(budget, label).toBeLessThanOrEqual(
        ACTIVITY_ANSWER_BUDGET_MS - STALL_MS,
      );
    }
  });

  it("answers 403 on a read-only deployment", async () => {
    mockedReadOnly.mockReturnValue(true);
    const { status, body } = await asJson(
      await POST_ACTIVITY(
        jsonRequest("http://localhost/api/workbench/activity", {
          action: "cancel",
          jobId: "job-1",
        }) as never,
      ),
    );
    expect(status).toBe(403);
    expect(body.error).toBe(READ_ONLY_REFUSAL.ingest);
    expect(mockedCancel).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/workbench/source", () => {
  it("answers 401 with no session", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const { status } = await asJson(
      await DELETE_SOURCE(
        jsonRequest("http://localhost/api/workbench/source", {
          path: "raw/sources/meet/abc.md",
        }) as never,
      ),
    );
    expect(status).toBe(401);
    expect(mockedCascade).not.toHaveBeenCalled();
  });

  it("refuses a path outside raw/sources/", async () => {
    const { status, body } = await asJson(
      await DELETE_SOURCE(
        jsonRequest("http://localhost/api/workbench/source", {
          path: "wiki/overview.md",
        }) as never,
      ),
    );
    expect(status).toBe(400);
    expect(body.error).toBe("That source path is not allowed.");
    expect(mockedCascade).not.toHaveBeenCalled();
  });

  it("cascades delete for the owner's exact stored path", async () => {
    const { status, body } = await asJson(
      await DELETE_SOURCE(
        jsonRequest("http://localhost/api/workbench/source", {
          path: "raw/sources/papers/energy/note.md",
        }) as never,
      ),
    );
    expect(status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      deletedPages: ["sole"],
      updatedPages: ["shared"],
    });
    expect(mockedCascade).toHaveBeenCalledWith({
      owner: "alice",
      actor: "alice",
      path: "raw/sources/papers/energy/note.md",
      sourceTitle: "note",
    });
  });
});

describe("GET /api/workbench/files", () => {
  it("answers 401 with no session", async () => {
    mockedPrincipal.mockResolvedValue(null);
    const { status, body } = await asJson(await GET_FILES());
    expect(status).toBe(401);
    expect(body.error).toBe(INTAKE_SIGN_IN_COPY);
    expect(mockedListFiles).not.toHaveBeenCalled();
  });

  it("returns the remaining listing at the full file cap", async () => {
    const { status, body } = await asJson(await GET_FILES());
    expect(status).toBe(200);
    expect(body.paths).toEqual(["raw/sources/a.md", "wiki/overview.md"]);
    expect(body.truncated).toBe(false);
    expect(mockedListFiles).toHaveBeenCalledWith(
      "alice",
      "wiki-1",
      expect.objectContaining({ limit: WORKBENCH_FILE_LIMIT }),
    );
  });
});


it("separates the canonical Source-delete namespace from the live destructive actor", async () => {
  vi.stubEnv("YOPEDIA_OWNER_USER_ID", "user_stable");
  vi.stubEnv("NEXT_PUBLIC_OWNER_HANDLE", "canonical");
  try {
    mockedPrincipal.mockResolvedValue({ id: "user_stable", handle: "changed" });
    const response = await DELETE_SOURCE(jsonRequest("http://localhost/api/workbench/source", { path: "raw/sources/note.md" }) as never);
    expect(response.status).toBe(200);
    expect(mockedCascade).toHaveBeenCalledWith({ owner: "canonical", actor: "changed", path: "raw/sources/note.md", sourceTitle: "note" });
  } finally { vi.unstubAllEnvs(); }
});
