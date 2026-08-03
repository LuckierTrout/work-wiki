import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { _resetLocks } from "../lock";
import {
  getStructuredKnowledge,
  listKnowledgeRecords,
  upsertStructuredKnowledge,
} from "../structured-knowledge";
import { _resetStorage } from "../storage";

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "structured-knowledge-"));
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
});
