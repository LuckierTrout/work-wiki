import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { _resetLocks } from "../lock";
import {
  createMonitorDigest,
  deliverMonitorDigest,
  getMonitorDigest,
  listDueMonitorDigestOwners,
  listMonitorDigests,
  listPendingMonitorDigestDeliveries,
  markMonitorDigestRead,
  saveMonitorDigestSettings,
} from "../monitor-digests";
import { recordOperation } from "../operation-ledger";
import { createSourceMonitor } from "../source-monitors";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "monitor-digests-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function createMonitor() {
  return createSourceMonitor("alice", {
    name: "Launch brief",
    url: "https://example.com/launch",
    targetSlug: "launch-plan",
  }, new Date("2026-08-04T00:00:00.000Z"));
}

describe("source-monitor digests", () => {
  it("groups proposals, failures, recoveries, and routine checks into owner history", async () => {
    const monitor = await createMonitor();
    await recordOperation("alice", {
      kind: "monitor",
      operation: "check",
      status: "failed",
      subjectId: monitor.id,
      detail: "upstream unavailable",
      createdAt: "2026-08-04T01:00:00.000Z",
    });
    await recordOperation("alice", {
      kind: "monitor",
      operation: "check",
      status: "succeeded",
      subjectId: monitor.id,
      detail: "content hash unchanged",
      createdAt: "2026-08-04T02:00:00.000Z",
    });
    await recordOperation("alice", {
      kind: "monitor",
      operation: "propose-update",
      status: "succeeded",
      subjectId: monitor.id,
      detail: "proposal mcp_123; change 0.420",
      createdAt: "2026-08-04T03:00:00.000Z",
    });

    const digest = await createMonitorDigest("alice", {
      now: new Date("2026-08-04T06:00:00.000Z"),
    });
    expect(digest).toMatchObject({
      owner: "alice",
      readAt: null,
      counts: {
        checks: 2,
        unchanged: 1,
        initialized: 0,
        minorChanges: 0,
        proposals: 1,
        failures: 1,
        recoveries: 1,
      },
      email: { status: "disabled", attempts: 0 },
    });
    expect(digest?.entries.map((entry) => entry.kind).sort()).toEqual([
      "failure",
      "proposal",
      "recovery",
    ]);
    expect(digest?.entries[0]).toMatchObject({ monitorName: "Launch brief" });
    expect(await listMonitorDigests("bob")).toEqual([]);

    const read = await markMonitorDigestRead(
      "alice",
      digest!.id,
      new Date("2026-08-04T06:05:00.000Z"),
    );
    expect(read?.readAt).toBe("2026-08-04T06:05:00.000Z");
  });

  it("discovers due owners and advances an empty digest window without creating noise", async () => {
    await createMonitor();
    await expect(
      listDueMonitorDigestOwners(new Date("2026-08-04T06:00:00.000Z")),
    ).resolves.toEqual(["alice"]);
    await expect(
      createMonitorDigest("alice", { now: new Date("2026-08-04T06:00:00.000Z") }),
    ).resolves.toBeNull();
    await expect(
      listDueMonitorDigestOwners(new Date("2026-08-04T06:01:00.000Z")),
    ).resolves.toEqual([]);
  });

  it("delivers email once and persists the provider receipt", async () => {
    const monitor = await createMonitor();
    await saveMonitorDigestSettings("alice", {
      enabled: true,
      cadence: "daily",
      emailEnabled: true,
      emailAddress: "Alice@example.com",
    }, new Date("2026-08-04T00:00:00.000Z"));
    await recordOperation("alice", {
      kind: "monitor",
      operation: "check",
      status: "succeeded",
      subjectId: monitor.id,
      detail: "baseline initialized",
      createdAt: "2026-08-04T01:00:00.000Z",
    });
    const digest = await createMonitorDigest("alice", {
      now: new Date("2026-08-04T06:00:00.000Z"),
      force: true,
    });
    const send = vi.fn(async () => ({ messageId: "email-123" }));
    const delivered = await deliverMonitorDigest("alice", digest!.id, {
      now: new Date("2026-08-04T06:01:00.000Z"),
      from: "ingest@workwiki.app",
      siteUrl: "https://workwiki.app/",
      send,
    });
    expect(send).toHaveBeenCalledWith(expect.objectContaining({
      from: "ingest@workwiki.app",
      to: "alice@example.com",
      subject: expect.stringContaining("source digest"),
      html: expect.stringContaining("Open source watch"),
    }));
    expect(delivered.email).toMatchObject({
      status: "sent",
      attempts: 1,
      messageId: "email-123",
    });

    await deliverMonitorDigest("alice", digest!.id, {
      now: new Date("2026-08-04T06:02:00.000Z"),
      send,
    });
    expect(send).toHaveBeenCalledTimes(1);
    expect(await listPendingMonitorDigestDeliveries(new Date("2026-08-05T00:00:00.000Z"))).toEqual([]);
  });

  it("persists failed delivery for a later retry", async () => {
    const monitor = await createMonitor();
    await saveMonitorDigestSettings("alice", {
      enabled: true,
      cadence: "daily",
      emailEnabled: true,
      emailAddress: "alice@example.com",
    }, new Date("2026-08-04T00:00:00.000Z"));
    await recordOperation("alice", {
      kind: "monitor",
      operation: "check",
      status: "failed",
      subjectId: monitor.id,
      detail: "timeout",
      createdAt: "2026-08-04T01:00:00.000Z",
    });
    const digest = await createMonitorDigest("alice", {
      now: new Date("2026-08-04T06:00:00.000Z"),
      force: true,
    });
    await expect(deliverMonitorDigest("alice", digest!.id, {
      now: new Date("2026-08-04T06:01:00.000Z"),
      send: async () => { throw new Error("email provider unavailable"); },
    })).rejects.toThrow("email provider unavailable");
    expect((await getMonitorDigest("alice", digest!.id))?.email).toMatchObject({
      status: "failed",
      attempts: 1,
      error: "email provider unavailable",
      nextAttemptAt: "2026-08-04T06:16:00.000Z",
    });
    expect(await listPendingMonitorDigestDeliveries(
      new Date("2026-08-04T06:16:00.000Z"),
    )).toMatchObject([{ id: digest!.id, owner: "alice", status: "failed" }]);
  });
});
