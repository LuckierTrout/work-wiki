import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { serializeFrontmatter } from "../frontmatter";
import { compileKnowledgePage, listSourceContributions } from "../knowledge-compilation";
import { _resetLocks } from "../lock";
import { listMemoryChangeProposals } from "../memory-proposals";
import { buildSourceEntry, serializeSources } from "../sources";
import { _resetStorage, getStorage } from "../storage";
import { updateIndex, writeWikiPage } from "../wiki";

vi.mock("../llm", async (importOriginal) => ({
  ...await importOriginal<typeof import("../llm")>(),
  hasLLMKey: () => false,
  callLLM: vi.fn(),
}));

let tmpDir: string;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "knowledge-compilation-"));
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

describe("two-pass knowledge compilation", () => {
  it("tracks source contributions and proposes separate structured pages", async () => {
    const page = serializeFrontmatter({
      owner: "alice",
      visibility: "private",
      authors: ["alice"],
      sources: serializeSources([buildSourceEntry("https://example.com/atlas", "url", "alice", "raw-1")]),
    }, "# Atlas notes\n\nAda Lovelace owns the Atlas decision log.");
    await writeWikiPage("atlas-notes", page, "alice", undefined, "alice");
    await writeWikiPage("atlas-notes", page, "alice");
    await updateIndex([{ slug: "atlas-notes", title: "Atlas notes", summary: "Decision notes", owner: "alice", visibility: "private" }]);
    const now = new Date().toISOString();
    await getStorage().writeFile("tenants/alice/structured-knowledge.json", JSON.stringify({
      version: 1,
      owner: "alice",
      updatedAt: now,
      records: [{
        id: "kr_ada", owner: "alice", kind: "person", name: "Ada Lovelace", summary: "Owner of the Atlas decision log.",
        sourceSlugs: ["atlas-notes"], evidenceIds: ["ev_ada"], createdAt: now, updatedAt: now,
      }],
      relations: [],
    }));

    const run = await compileKnowledgePage("alice", "atlas-notes");
    expect(run.status).toBe("complete");
    expect(run.pass1.recordIds).toEqual(["kr_ada"]);
    expect(run.pass2.proposalIds).toHaveLength(1);
    expect(await listSourceContributions("alice")).toEqual([
      expect.objectContaining({ pageSlug: "atlas-notes", rawId: "raw-1", structuredRecordIds: ["kr_ada"] }),
    ]);
    expect(await listMemoryChangeProposals("alice", "pending")).toEqual([
      expect.objectContaining({ targetSlug: "person-ada-lovelace", kind: "create" }),
    ]);
  });
});
