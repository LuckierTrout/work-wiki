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
import { _resetStorage, getStorage } from "../storage";

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

// ---------------------------------------------------------------------------
// Guidance by human, storage by handle (DW-709)
// ---------------------------------------------------------------------------

import { createNamesTerm } from "../names-terms";
import { tenantForOwner } from "../wiki";

/**
 * Digest prose is canonicalized against the owner's Names & Terms. Before
 * DW-709 an `alice--yoyo`-owned digest read the AGENT's tenant — an empty
 * dictionary — so the aliases alice maintains never reached the prose she
 * actually receives. The digest RECORD itself stays in the agent's silo.
 */
describe("agent-owned digests canonicalize against the human's dictionary", () => {
  const HUMAN = "alice";
  const AGENT = "alice--yoyo";

  it("applies the human's aliases to the entry prose, storing under the agent", async () => {
    await getStorage().writeFile(`agents/${AGENT}.json`, JSON.stringify({ id: AGENT, owner: HUMAN }));
    await createNamesTerm(HUMAN, {
      kind: "project",
      canonical: "Project Lighthouse",
      aliases: ["Lighthouse"],
    });
    // Both canonicalized fields carry the ALIAS, so a dictionary read against
    // the agent's own empty tenant leaves them verbatim and this fails.
    const monitor = await createSourceMonitor(AGENT, {
      name: "Lighthouse brief",
      url: "https://example.com/launch",
      targetSlug: "launch-plan",
    }, new Date("2026-08-04T00:00:00.000Z"));
    await recordOperation(AGENT, {
      kind: "monitor",
      operation: "propose-update",
      status: "succeeded",
      subjectId: monitor.id,
      detail: "Lighthouse shifted its ship date; proposal mcp_9",
      createdAt: "2026-08-04T03:00:00.000Z",
    });

    const digest = await createMonitorDigest(AGENT, {
      now: new Date("2026-08-04T06:00:00.000Z"),
    });

    expect(digest?.entries[0]?.monitorName).toBe("Project Lighthouse brief");
    expect(digest?.entries[0]?.detail).toContain("Project Lighthouse shifted");
    // Addressing is untouched: the digest is the AGENT's, in the agent's silo.
    expect(digest?.owner).toBe(AGENT);
    expect(tenantForOwner(AGENT)).not.toBe(tenantForOwner(HUMAN));
    expect(await listMonitorDigests(HUMAN)).toEqual([]);
    expect(await listMonitorDigests(AGENT)).toHaveLength(1);
  });
});
