import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const { generateTextMock, outputObjectMock, getConfiguredModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  outputObjectMock: vi.fn(({ schema }) => ({ schema })),
  getConfiguredModelMock: vi.fn(async () => ({ id: "test-model" })),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  Output: { object: outputObjectMock },
  NoObjectGeneratedError: {
    isInstance: (error: unknown) =>
      Boolean(error && typeof error === "object" && "noObjectGenerated" in error),
  },
}));

vi.mock("../llm", () => ({
  getConfiguredModel: getConfiguredModelMock,
  retryWithBackoff: async <T>(operation: () => Promise<T>) => operation(),
}));

import { _resetConfigCache, saveConfig } from "../config";
import { getPageEvidence } from "../evidence";
import { _resetLocks } from "../lock";
import {
  extractStructuredKnowledge,
  getStructuredKnowledge,
  listKnowledgeRecords,
  upsertStructuredKnowledge,
} from "../structured-knowledge";
import { _resetStorage, getStorage } from "../storage";
import { tenantWikiRelPath } from "../wiki";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalOpenAiKey: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "structured-knowledge-"));
  originalDataDir = process.env.DATA_DIR;
  originalOpenAiKey = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetConfigCache();
  _resetStorage();
  vi.clearAllMocks();
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = originalOpenAiKey;
  _resetLocks();
  _resetConfigCache();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("structured knowledge", () => {
  it("upserts stable records across sources and keeps owners isolated", async () => {
    const first = await upsertStructuredKnowledge("alice", [{
      kind: "project",
      name: "Apollo",
      summary: "Initial launch program.",
      sourceSlug: "launch-notes",
      evidenceIds: ["ev_one"],
    }], [], new Date("2026-08-01T00:00:00.000Z"));
    const second = await upsertStructuredKnowledge("alice", [{
      kind: "project",
      name: "  APOLLO ",
      summary: "Launch program now in pilot.",
      status: "pilot",
      sourceSlug: "pilot-notes",
      evidenceIds: ["ev_two"],
    }], [], new Date("2026-08-02T00:00:00.000Z"));

    expect(second.records).toHaveLength(1);
    expect(second.records[0]).toMatchObject({
      id: first.records[0].id,
      status: "pilot",
      sourceSlugs: ["launch-notes", "pilot-notes"],
      evidenceIds: ["ev_one", "ev_two"],
    });
    expect((await getStructuredKnowledge("bob")).records).toHaveLength(0);
  });

  it("stores temporal, source-linked relationships between known records", async () => {
    const graph = await upsertStructuredKnowledge("alice", [
      { kind: "person", name: "Christian", summary: "Project owner.", sourceSlug: "decision-log" },
      { kind: "decision", name: "November launch", summary: "Launch moved to November.", validFrom: "2026-08-01", sourceSlug: "decision-log" },
    ], [{
      fromKind: "person",
      fromName: "Christian",
      toKind: "decision",
      toName: "November launch",
      type: "approved",
      validFrom: "2026-08-01",
      sourceSlug: "decision-log",
      evidenceIds: ["ev_decision"],
    }]);

    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0]).toMatchObject({ type: "approved", validFrom: "2026-08-01", sourceSlugs: ["decision-log"] });
    expect(await listKnowledgeRecords("alice", "decision")).toHaveLength(1);
  });

  it("uses a dedicated provider, accepts nullable optional fields, and anchors evidence", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    await saveConfig({
      provider: "ollama-cloud",
      model: "gpt-oss:120b",
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
    });
    await getStorage().writeFile(
      tenantWikiRelPath("alice", "decision-log.md"),
      "---\ntitle: Decision log\nowner: alice\n---\nApollo is the launch project. Christian approved the November launch.\n",
    );
    const generatedOutput = {
      records: [
        {
          kind: "project",
          name: "Apollo",
          summary: "Apollo is the launch project.",
          status: null,
          validFrom: null,
          validTo: null,
          evidenceExcerpt: "Apollo is the launch project.",
        },
        {
          kind: "decision",
          name: "November launch",
          summary: "Christian approved the November launch.",
          status: "approved",
          validFrom: null,
          validTo: null,
          evidenceExcerpt: "Christian approved the November launch.",
        },
      ],
      relations: [
        {
          fromKind: "project",
          fromName: "Apollo",
          toKind: "decision",
          toName: "November launch",
          type: "has decision",
          validFrom: null,
          validTo: null,
          evidenceExcerpt: "Christian approved the November launch.",
        },
      ],
    };
    generateTextMock.mockResolvedValueOnce({ output: generatedOutput });

    const graph = await extractStructuredKnowledge("alice", "decision-log");

    expect(getConfiguredModelMock).toHaveBeenCalledWith({
      provider: "openai",
      model: "gpt-4o",
    });
    expect(graph.records).toHaveLength(2);
    expect(graph.relations).toHaveLength(1);
    expect(graph.records[0]).not.toHaveProperty("validFrom");
    const schema = outputObjectMock.mock.calls[0][0].schema;
    expect(schema.safeParse(generatedOutput).success).toBe(true);
    const evidence = await getPageEvidence("alice", "decision-log");
    expect(evidence?.claims).toHaveLength(2);
    expect(evidence?.evidence.map((item) => item.excerpt)).toContain(
      "Apollo is the launch project.",
    );
  });

  it("surfaces a safe structured-output error and writes nothing on parse failure", async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    await saveConfig({
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
    });
    await getStorage().writeFile(
      tenantWikiRelPath("alice", "failed-extraction.md"),
      "---\ntitle: Failed extraction\nowner: alice\n---\nA private page that must not be partially written.\n",
    );
    generateTextMock.mockRejectedValueOnce({
      noObjectGenerated: true,
      cause: new Error("response did not match schema"),
    });

    await expect(
      extractStructuredKnowledge("alice", "failed-extraction"),
    ).rejects.toThrow(
      "Structured Knowledge could not produce valid records with openai/gpt-4o. No records were written.",
    );
    expect((await getStructuredKnowledge("alice")).records).toHaveLength(0);
    expect(await getPageEvidence("alice", "failed-extraction")).toBeNull();
  });
});
