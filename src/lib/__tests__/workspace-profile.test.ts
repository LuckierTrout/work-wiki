import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { buildIngestSystemPrompt } from "../ingest";
import { _resetLocks } from "../lock";
import { buildQuerySystemPrompt } from "../query";
import { _resetStorage } from "../storage";
import {
  buildWorkspaceGuidance,
  emptyWorkspaceProfile,
  getWorkspaceProfile,
  renderWorkspaceGuidance,
  saveWorkspaceProfile,
} from "../workspace-profile";
import {
  WORKSPACE_SCENARIO_TEMPLATES,
  parseWorkspaceProfileInput,
} from "../workspace-profile-schema";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "workspace-profile-"));
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

describe("workspace purpose profile", () => {
  it("starts empty and stores profiles per owner", async () => {
    expect(await getWorkspaceProfile("alice")).toEqual(emptyWorkspaceProfile());

    const saved = await saveWorkspaceProfile("Alice", {
      scenario: "research",
      purpose: "Understand which evidence supports the launch decision.",
      keyQuestions: ["What changed?", "What changed?", " What is uncertain? "],
      inScope: ["Decision evidence"],
      outOfScope: ["Unsupported forecasts"],
      outputLanguage: "English",
      pageConventions: "Separate facts from recommendations.",
    });

    expect(saved.keyQuestions).toEqual(["What changed?", "What is uncertain?"]);
    expect(saved.createdAt).toBeTruthy();
    expect(saved.updatedAt).toBeTruthy();
    expect((await getWorkspaceProfile("alice")).purpose).toContain("launch decision");
    expect(await getWorkspaceProfile("bob")).toEqual(emptyWorkspaceProfile());
  });

  it("validates bounded profile input and independently authored templates", () => {
    expect(WORKSPACE_SCENARIO_TEMPLATES.business.purpose).toContain("operating memory");
    expect(() => parseWorkspaceProfileInput({ scenario: "unknown" })).toThrow(
      "Choose a valid workspace scenario",
    );
    expect(() => parseWorkspaceProfileInput({
      scenario: "custom",
      keyQuestions: "not-an-array",
    })).toThrow("Key questions must be a list");
  });

  it("renders evidence-safe guidance and omits an empty profile", () => {
    expect(renderWorkspaceGuidance(emptyWorkspaceProfile())).toBe("");
    const guidance = renderWorkspaceGuidance({
      scenario: "custom",
      purpose: "Track the Phoenix program.",
      keyQuestions: ["Who owns the next decision?"],
      inScope: ["Decisions"],
      outOfScope: ["Rumor"],
      outputLanguage: "English",
      pageConventions: "Use explicit dates.",
    });
    expect(guidance).toContain("WORKSPACE PURPOSE");
    expect(guidance).toContain("never overrides source evidence");
    expect(guidance).toContain("Track the Phoenix program");
    expect(guidance).toContain("Who owns the next decision?");
  });

  it("injects saved purpose into ingest and query prompts", async () => {
    await saveWorkspaceProfile("alice", {
      scenario: "business",
      purpose: "Keep a source-backed record of Project Lighthouse decisions.",
      keyQuestions: ["What was approved?"],
      inScope: ["Decisions"],
      outOfScope: [],
      outputLanguage: "English",
      pageConventions: "Preserve named owners.",
    });

    expect(await buildWorkspaceGuidance("alice")).toContain("Project Lighthouse");
    expect(await buildIngestSystemPrompt("alice")).toContain("Project Lighthouse");
    expect(
      await buildQuerySystemPrompt("context", [], [], "prose", "alice"),
    ).toContain("Project Lighthouse");
  });
});
