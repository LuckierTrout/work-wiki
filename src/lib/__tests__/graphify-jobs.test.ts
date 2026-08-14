import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  completeGraphifyPage,
  createGraphifyJob,
  effectiveGraphifyJob,
  failGraphifyPages,
  getGraphifyJob,
  getLatestGraphifyJob,
  prepareGraphifyRetry,
  startGraphifyPage,
} from "../graphify-jobs";
import { _resetLocks } from "../lock";
import { _resetStorage, getStorage } from "../storage";

let tempDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "graphify-jobs-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tempDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("Graphify jobs", () => {
  it("tracks per-page progress, errors, and targeted retries", async () => {
    const created = await createGraphifyJob("alice", ["notes", "decisions"]);
    expect(created).toMatchObject({
      owner: "alice",
      status: "queued",
      total: 2,
      queued: 2,
      succeeded: 0,
      failed: 0,
    });

    const started = await startGraphifyPage("alice", created.jobId, "notes");
    expect(started.shouldRun).toBe(true);
    expect(started.job).toMatchObject({ status: "processing", processing: 1 });

    await Promise.all([
      completeGraphifyPage("alice", created.jobId, "notes"),
      failGraphifyPages("alice", created.jobId, ["decisions"], "model unavailable"),
    ]);
    const partial = await getGraphifyJob("alice", created.jobId);
    expect(partial).toMatchObject({
      status: "completed_with_errors",
      queued: 0,
      processing: 0,
      succeeded: 1,
      failed: 1,
    });
    expect(partial?.items.find((item) => item.slug === "decisions")?.error)
      .toBe("model unavailable");

    const retry = await prepareGraphifyRetry("alice", created.jobId);
    expect(retry.slugs).toEqual(["decisions"]);
    expect(retry.job).toMatchObject({ status: "processing", queued: 1, failed: 0 });
    await startGraphifyPage("alice", created.jobId, "decisions");
    const done = await completeGraphifyPage("alice", created.jobId, "decisions");
    expect(done).toMatchObject({ status: "done", succeeded: 2, failed: 0 });
  });

  it("treats a delivered completed page as an idempotent replay", async () => {
    const created = await createGraphifyJob("alice", ["notes"]);
    await startGraphifyPage("alice", created.jobId, "notes");
    await completeGraphifyPage("alice", created.jobId, "notes");

    const replay = await startGraphifyPage("alice", created.jobId, "notes");
    expect(replay.shouldRun).toBe(false);
    expect(replay.job.items[0]).toMatchObject({ status: "done", attempts: 1 });
  });

  it("keeps job discovery owner-scoped", async () => {
    const created = await createGraphifyJob("alice", ["notes"]);
    expect((await getLatestGraphifyJob("alice"))?.jobId).toBe(created.jobId);
    expect(await getGraphifyJob("bob", created.jobId)).toBeNull();
    expect(await getLatestGraphifyJob("bob")).toBeNull();
  });

  it("reports an inactive job as stalled without rewriting its durable state", async () => {
    const created = await createGraphifyJob("alice", ["notes"]);
    const stale = {
      ...created,
      updatedAt: "2020-01-01T00:00:00.000Z",
    };
    await getStorage().writeFile(
      `tenants/alice/graphify-jobs/${created.jobId}.json`,
      JSON.stringify(stale),
    );

    const stored = await getGraphifyJob("alice", created.jobId);
    expect(stored?.status).toBe("queued");
    expect(effectiveGraphifyJob(stored!)).toMatchObject({ status: "stalled" });
  });

  it("rejects empty jobs and malformed ids", async () => {
    await expect(createGraphifyJob("alice", [])).rejects.toThrow(/no owner pages/i);
    await expect(getGraphifyJob("alice", "../bad")).rejects.toThrow(/invalid graphify job id/i);
  });
});
