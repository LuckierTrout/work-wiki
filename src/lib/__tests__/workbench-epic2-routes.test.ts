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
