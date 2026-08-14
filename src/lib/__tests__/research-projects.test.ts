import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  createResearchProject,
  deleteResearchProject,
  listResearchProjects,
  updateResearchProject,
} from "../research-projects";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-projects-"));
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

describe("research projects", () => {
  it("persists a source plan and synthesis per owner", async () => {
    const project = await createResearchProject("alice", {
      title: "Launch research",
      question: "What evidence supports the launch date?",
      queries: ["launch evidence", "launch evidence", "schedule risk"],
      sourceUrls: ["https://example.com/brief", "javascript:alert(1)"],
      vaultId: "alice--launch",
    });
    expect(project).toMatchObject({
      status: "draft",
      queries: ["launch evidence", "schedule risk"],
      sourceUrls: ["https://example.com/brief"],
    });
    expect(await listResearchProjects("bob")).toEqual([]);

    const updated = await updateResearchProject("alice", project.id, {
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
    expect(updated).toMatchObject({
      status: "complete",
      synthesis: "The launch date is supported by the approved brief.",
    });
  });

  it("deletes only from the owning workspace", async () => {
    const project = await createResearchProject("alice", {
      title: "Topic",
      question: "What changed?",
    });
    expect(await deleteResearchProject("bob", project.id)).toBe(false);
    expect(await deleteResearchProject("alice", project.id)).toBe(true);
    expect(await listResearchProjects("alice")).toEqual([]);
  });
});
