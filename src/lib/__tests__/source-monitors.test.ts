import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { serializeFrontmatter } from "../frontmatter";
import { _resetLocks } from "../lock";
import { listMemoryChangeProposals } from "../memory-proposals";
import {
  createSourceMonitor,
  getSourceMonitor,
  listDueSourceMonitors,
  listSourceMonitors,
  runSourceMonitor,
  sourceChangeScore,
  updateSourceMonitor,
} from "../source-monitors";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner, tenantWikiRelPath } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

function page(body: string): string {
  return serializeFrontmatter(
    {
      owner: "alice",
      visibility: "private",
      authors: ["alice"],
      created: "2026-08-01",
      updated: "2026-08-01",
    },
    body,
  );
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-monitors-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await getStorage().writeFile(
    tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
    page("# Plan\n\nThe launch is planned for September."),
  );
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("source monitors", () => {
  it("stores owner-scoped monitors and schedules only active due entries", async () => {
    const now = new Date("2026-08-03T10:00:00.000Z");
    const monitor = await createSourceMonitor("alice", {
      name: "Launch brief",
      url: "https://example.com/launch",
      targetSlug: "plan",
      cadence: "daily",
    }, now);
    expect(await listSourceMonitors("alice")).toHaveLength(1);
    expect(await getSourceMonitor("bob", monitor.id)).toBeNull();
    expect(await listDueSourceMonitors(now)).toMatchObject([{ id: monitor.id, owner: "alice" }]);

    await updateSourceMonitor("alice", monitor.id, { state: "paused" }, now);
    expect(await listDueSourceMonitors(new Date("2026-08-05T10:00:00.000Z"))).toHaveLength(0);
  });

  it("initializes a baseline, then creates an evidence-backed review proposal", async () => {
    const monitor = await createSourceMonitor("alice", {
      name: "Launch brief",
      url: "https://example.com/launch",
      targetSlug: "plan",
      meaningfulChangeThreshold: 0.05,
    }, new Date("2026-08-03T10:00:00.000Z"));

    const baseline = await runSourceMonitor("alice", monitor.id, {
      now: new Date("2026-08-03T10:05:00.000Z"),
      fetchSource: async () => ({
        title: "Launch brief",
        content: "The launch is planned for September with a limited pilot group.",
      }),
    });
    expect(baseline.outcome).toBe("initialized");

    const changed = await runSourceMonitor("alice", monitor.id, {
      now: new Date("2026-08-04T10:05:00.000Z"),
      fetchSource: async () => ({
        title: "Launch brief",
        content: "The launch moved to November. The rollout now includes every regional team and requires legal approval.",
      }),
      draftUpdate: async () => page("# Plan\n\nThe launch moved to November and requires legal approval."),
    });
    expect(changed.outcome).toBe("proposal-created");
    const proposals = await listMemoryChangeProposals("alice", "pending");
    expect(proposals).toHaveLength(1);
    expect(proposals[0].evidenceIds).toHaveLength(1);
    expect(await getStorage().readFile(
      tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
    )).toContain("planned for September");
  });

  it("scores identical text as unchanged and records fetch failures for retry", async () => {
    expect(sourceChangeScore("Same words here", "Same words here")).toBe(0);
    const monitor = await createSourceMonitor("alice", {
      name: "Launch brief",
      url: "https://example.com/launch",
      targetSlug: "plan",
    });
    const failed = await runSourceMonitor("alice", monitor.id, {
      fetchSource: async () => { throw new Error("upstream unavailable"); },
    });
    expect(failed).toMatchObject({ outcome: "failed", error: "upstream unavailable" });
    expect((await getSourceMonitor("alice", monitor.id))?.failureCount).toBe(1);
  });
});
