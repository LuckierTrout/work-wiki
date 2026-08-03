import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { createOwnerBackup, verifyOwnerBackup } from "../backups";
import { serializeFrontmatter } from "../frontmatter";
import { _resetLocks } from "../lock";
import { saveRetrievalEvalCase, runRetrievalEvaluation } from "../retrieval-evals";
import { createSourceMonitor, runSourceMonitor } from "../source-monitors";
import { _resetStorage, getStorage } from "../storage";
import { getSystemHealth } from "../system-health";
import { tenantForOwner, tenantWikiRelPath } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "system-health-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  await getStorage().writeFile(
    tenantWikiRelPath(tenantForOwner("alice"), "plan.md"),
    serializeFrontmatter({ owner: "alice", visibility: "private" }, "# Plan\n\nApproved."),
  );
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("system health", () => {
  it("summarizes verified recovery and retrieval checks", async () => {
    const backup = await createOwnerBackup("alice");
    await verifyOwnerBackup("alice", backup.id);
    await saveRetrievalEvalCase("alice", {
      label: "Plan",
      question: "What is approved?",
      expectedSlugs: ["plan"],
    });
    await runRetrievalEvaluation("alice", async () => ({
      answer: "The plan is approved.",
      sources: ["plan"],
    }));

    const health = await getSystemHealth("alice");
    expect(health.status).toBe("healthy");
    expect(health.backup.status).toBe("verified");
    expect(health.backup.latest?.fileCount).toBeGreaterThan(0);
    expect(health.evaluation.privacyPass).toBe(true);
    expect(health.operations.observed).toBeGreaterThan(0);
  });

  it("surfaces a failed source check as requiring attention", async () => {
    const backup = await createOwnerBackup("alice");
    await verifyOwnerBackup("alice", backup.id);
    const monitor = await createSourceMonitor("alice", {
      name: "Plan source",
      url: "https://example.com/plan",
      targetSlug: "plan",
    });
    await runSourceMonitor("alice", monitor.id, {
      fetchSource: async () => { throw new Error("upstream unavailable"); },
    });

    const health = await getSystemHealth("alice");
    expect(health.status).toBe("attention");
    expect(health.monitors.failed).toBe(1);
    expect(health.operations.recent.some((item) => item.kind === "monitor" && item.status === "failed")).toBe(true);
  });
});
