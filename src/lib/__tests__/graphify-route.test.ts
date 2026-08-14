import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/graphify-jobs", () => ({
  createGraphifyJob: vi.fn(),
  effectiveGraphifyJob: vi.fn((job) => job),
  failGraphifyPages: vi.fn(),
  getLatestGraphifyJob: vi.fn(),
  listGraphifiableWikiPages: vi.fn(),
  prepareGraphifyRetry: vi.fn(),
}));
vi.mock("@/lib/tasks", () => ({ enqueueTasks: vi.fn() }));

import { getPrincipal } from "@/lib/auth";
import {
  createGraphifyJob,
  failGraphifyPages,
  getLatestGraphifyJob,
  listGraphifiableWikiPages,
  prepareGraphifyRetry,
} from "@/lib/graphify-jobs";
import { enqueueTasks } from "@/lib/tasks";
import { GET, POST } from "@/app/api/knowledge/graphify/route";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedCreate = vi.mocked(createGraphifyJob);
const mockedFail = vi.mocked(failGraphifyPages);
const mockedLatest = vi.mocked(getLatestGraphifyJob);
const mockedList = vi.mocked(listGraphifiableWikiPages);
const mockedRetry = vi.mocked(prepareGraphifyRetry);
const mockedEnqueue = vi.mocked(enqueueTasks);

const job = {
  version: 1 as const,
  jobId: "graphify_12345678-1234-1234-1234-123456789abc",
  owner: "alice",
  scope: "wiki" as const,
  status: "queued" as const,
  total: 2,
  queued: 2,
  processing: 0,
  succeeded: 0,
  failed: 0,
  items: [
    { slug: "notes", status: "queued" as const, attempts: 0 },
    { slug: "decisions", status: "queued" as const, attempts: 0 },
  ],
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

function post(body: unknown) {
  return POST(new Request("http://localhost/api/knowledge/graphify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user_alice", handle: "alice" });
  mockedLatest.mockResolvedValue(null);
  mockedList.mockResolvedValue(["notes", "decisions"]);
  mockedCreate.mockResolvedValue(job);
  mockedEnqueue.mockResolvedValue({ available: true, enqueued: 2 });
  mockedFail.mockResolvedValue(job);
});

describe("/api/knowledge/graphify", () => {
  it("requires an owner session for status and mutations", async () => {
    mockedPrincipal.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect((await post({ action: "wiki" })).status).toBe(401);
    expect(mockedList).not.toHaveBeenCalled();
  });

  it("queues only the signed-in owner's eligible pages", async () => {
    const response = await post({ action: "wiki" });
    expect(response.status).toBe(202);
    expect(mockedList).toHaveBeenCalledWith("alice");
    expect(mockedCreate).toHaveBeenCalledWith("alice", ["notes", "decisions"]);
    expect(mockedEnqueue).toHaveBeenCalledWith([
      {
        kind: "extract-knowledge",
        slug: "notes",
        owner: "alice",
        graphifyJobId: job.jobId,
      },
      {
        kind: "extract-knowledge",
        slug: "decisions",
        owner: "alice",
        graphifyJobId: job.jobId,
      },
    ]);
  });

  it("does not start a second whole-wiki job while one is active", async () => {
    mockedLatest.mockResolvedValue(job);
    const response = await post({ action: "wiki" });
    expect(response.status).toBe(409);
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("retries only the pages selected by the owner-scoped job tracker", async () => {
    mockedRetry.mockResolvedValue({ job, slugs: ["decisions"] });
    mockedEnqueue.mockResolvedValue({ available: true, enqueued: 1 });
    const response = await post({ action: "retry", jobId: job.jobId });
    expect(response.status).toBe(202);
    expect(mockedRetry).toHaveBeenCalledWith("alice", job.jobId);
    expect(mockedEnqueue).toHaveBeenCalledWith([
      {
        kind: "extract-knowledge",
        slug: "decisions",
        owner: "alice",
        graphifyJobId: job.jobId,
      },
    ]);
  });

  it("marks the unsent tail failed when the queue is unavailable", async () => {
    mockedEnqueue.mockResolvedValue({ available: false, enqueued: 0 });
    const response = await post({ action: "wiki" });
    expect(response.status).toBe(503);
    expect(mockedFail).toHaveBeenCalledWith(
      "alice",
      job.jobId,
      ["notes", "decisions"],
      expect.stringMatching(/queue is unavailable/i),
    );
  });
});
