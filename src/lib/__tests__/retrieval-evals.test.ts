import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import {
  listRetrievalEvalCases,
  runRetrievalEvaluation,
  saveRetrievalEvalCase,
} from "../retrieval-evals";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "retrieval-evals-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetStorage();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("retrieval evaluations", () => {
  it("keeps cases owner-scoped and scores grounded retrieval", async () => {
    await saveRetrievalEvalCase("alice", {
      label: "Project conflict",
      question: "What conflicts with the current project plan?",
      expectedSlugs: ["project-plan"],
      forbiddenSlugs: ["private-payroll"],
      requiredPhrases: ["conflict"],
    });
    expect(await listRetrievalEvalCases("bob")).toHaveLength(0);

    const run = await runRetrievalEvaluation("alice", async () => ({
      answer: "The project has one documented conflict.",
      sources: ["project-plan"],
    }));
    expect(run.sourceRecall).toBe(1);
    expect(run.citationPrecision).toBe(1);
    expect(run.privacyPassRate).toBe(1);
    expect(run.groundedAnswerRate).toBe(1);
  });

  it("fails the privacy check when a forbidden source crosses the boundary", async () => {
    await saveRetrievalEvalCase("alice", {
      label: "Isolation",
      question: "Summarize the plan.",
      expectedSlugs: ["project-plan"],
      forbiddenSlugs: ["private-payroll"],
    });
    const run = await runRetrievalEvaluation("alice", async () => ({
      answer: "Summary based on retrieved material.",
      sources: ["project-plan"],
      retrievedSources: ["project-plan", "private-payroll"],
    }));
    expect(run.privacyPassRate).toBe(0);
    expect(run.citationPrecision).toBe(1);
  });
});
