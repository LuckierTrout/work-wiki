import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ingest-async", () => ({
  enqueueOrInline: vi.fn(),
}));
vi.mock("@/lib/ingest-jobs", () => ({
  createIngestJob: vi.fn(async () => ({})),
  updateIngestJob: vi.fn(async () => ({})),
}));

import { enqueueOrInline } from "@/lib/ingest-async";
import { updateIngestJob } from "@/lib/ingest-jobs";
import { enqueueEmbeddingBackfill } from "@/lib/ingest-embed";

const mockedEnqueue = vi.mocked(enqueueOrInline);
const mockedUpdate = vi.mocked(updateIngestJob);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("enqueueEmbeddingBackfill", () => {
  it("marks the job failed when enqueue/rebuild throws", async () => {
    mockedEnqueue.mockRejectedValueOnce(new Error("queue down"));
    const jobId = await enqueueEmbeddingBackfill("alice");
    expect(jobId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(mockedUpdate).toHaveBeenCalledWith(jobId, {
      status: "failed",
      error: "queue down",
    });
  });
});
