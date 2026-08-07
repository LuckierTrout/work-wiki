import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  buildAgentSkillGuidance,
  createAgentSkill,
  deleteAgentSkill,
  listAgentSkills,
  updateAgentSkill,
} from "../agent-skills";
import { _resetLocks } from "../lock";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-skills-"));
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

describe("owner agent skills", () => {
  it("stores assignments per owner and renders only active skills for an agent", async () => {
    const skill = await createAgentSkill("Alice", {
      name: "Decision extractor",
      description: "Find explicit decisions.",
      instructions: "Preserve the exact decision wording and cite the source.",
      agentIds: ["alice--reviewer", "alice--reviewer"],
    });

    expect(skill.agentIds).toEqual(["alice--reviewer"]);
    expect(await listAgentSkills("bob")).toEqual([]);
    expect(await buildAgentSkillGuidance("alice", "alice--reviewer"))
      .toContain("Preserve the exact decision wording");
    expect(await buildAgentSkillGuidance("alice", "alice--other")).toBe("");

    await updateAgentSkill("alice", skill.id, { enabled: false });
    expect(await buildAgentSkillGuidance("alice", "alice--reviewer")).toBe("");
  });

  it("updates and deletes a skill without affecting another owner", async () => {
    const skill = await createAgentSkill("alice", {
      name: "Source checker",
      instructions: "Confirm every claim against retrieved sources.",
    });
    const updated = await updateAgentSkill("alice", skill.id, {
      name: "Evidence checker",
      agentIds: ["alice--researcher"],
    });
    expect(updated).toMatchObject({
      name: "Evidence checker",
      agentIds: ["alice--researcher"],
    });
    expect(await deleteAgentSkill("bob", skill.id)).toBe(false);
    expect(await deleteAgentSkill("alice", skill.id)).toBe(true);
  });
});
