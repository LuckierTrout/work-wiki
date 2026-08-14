import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  appendAgentRunArtifacts,
  claimAgentSandboxApproval,
  createAgentInteraction,
  createAgentSandboxApproval,
  deleteAgentRunWorkspace,
  finishAgentSandboxApproval,
  listAgentInteractions,
  listAgentRunWorkspaces,
  listAgentSandboxApprovals,
  readAgentArtifact,
  recordAgentRunWorkspace,
  rejectAgentSandboxApproval,
  submitAgentInteraction,
} from "../agent-workspaces";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-workspaces-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("agent run workspaces", () => {
  it("persists hashed artifacts and keeps them owner scoped", async () => {
    const workspace = await recordAgentRunWorkspace({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-1234",
      prompt: "Build a brief",
      output: "# Brief\n\nDone.",
      status: "completed",
      extraArtifacts: [{ filename: "findings.csv", mediaType: "text/csv", content: "topic,count\nAI,2" }],
    });
    expect(workspace.artifacts.map((artifact) => artifact.filename)).toEqual([
      "response.md", "run.json", "findings.csv",
    ]);
    expect(await listAgentRunWorkspaces("bob")).toEqual([]);
    const response = workspace.artifacts.find((artifact) => artifact.filename === "response.md")!;
    expect((await readAgentArtifact("alice", workspace.id, response.id))?.content).toContain("# Brief");
    expect(await readAgentArtifact("bob", workspace.id, response.id)).toBeNull();
    expect(await deleteAgentRunWorkspace("alice", workspace.id)).toBe(true);
  });

  it("validates a typed interaction before resuming", async () => {
    const request = await createAgentInteraction({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-5678",
      title: "Choose scope",
      fields: [
        { id: "project-name", label: "Project name", type: "text", required: true },
        { id: "depth", label: "Depth", type: "select", options: ["brief", "deep"] },
        { id: "approved", label: "Approved", type: "checkbox" },
      ],
    });
    await expect(submitAgentInteraction("alice", request.id, { depth: "invalid", "project-name": "Atlas" }))
      .rejects.toThrow(/invalid option/i);
    const submitted = await submitAgentInteraction("alice", request.id, {
      "project-name": "Atlas", depth: "deep", approved: true,
    });
    expect(submitted).toMatchObject({ status: "submitted", values: { "project-name": "Atlas", depth: "deep", approved: true } });
    expect(await listAgentInteractions("alice", "pending")).toEqual([]);
  });

  it("keeps sandbox commands pending until an owner decision and stores the receipt", async () => {
    await recordAgentRunWorkspace({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-approval",
      prompt: "Calculate a result",
      output: "Waiting for approval.",
      status: "awaiting-input",
    });
    const request = await createAgentSandboxApproval({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-approval",
      purpose: "Calculate the approved total",
      command: "node calculate.js",
      files: { "calculate.js": "console.log(42)" },
      outputFiles: ["result.json"],
      timeoutMs: 12_000,
    });
    expect(request).toMatchObject({ status: "pending", files: [{ filename: "calculate.js" }] });
    expect(await listAgentSandboxApprovals("bob")).toEqual([]);

    const claimed = await claimAgentSandboxApproval("alice", request.id);
    expect(claimed?.files).toEqual({ "calculate.js": "console.log(42)" });
    const finished = await finishAgentSandboxApproval({
      owner: "alice",
      id: request.id,
      status: "completed",
      result: { exitCode: 0, stdout: "42", stderr: "", artifacts: ["result.json"], durationMs: 50 },
    });
    expect(finished).toMatchObject({ status: "completed", result: { exitCode: 0, stdout: "42" } });

    const workspace = await appendAgentRunArtifacts({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-approval",
      artifacts: [{ filename: "sandbox.log", content: "42" }],
    });
    expect(workspace?.artifacts.some((artifact) => artifact.filename === "sandbox.log")).toBe(true);
  });

  it("rejects a pending sandbox command without exposing its payload", async () => {
    const request = await createAgentSandboxApproval({
      owner: "alice",
      agentId: "alice-researcher",
      runId: "run-reject",
      command: "echo no",
      files: { "private.txt": "not returned in the approval index" },
    });
    expect(JSON.stringify(await listAgentSandboxApprovals("alice"))).not.toContain("not returned");
    expect(await rejectAgentSandboxApproval("alice", request.id)).toMatchObject({ status: "rejected" });
    expect(await claimAgentSandboxApproval("alice", request.id)).toBeNull();
  });
});
