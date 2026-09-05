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
import { SETTINGS_LABEL, settingsCategory, settingsPointer } from "../workbench-settings";

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

  it("replaces one source contribution without deleting corroborating sources", async () => {
    const records = [
      {
        kind: "project" as const,
        name: "Apollo",
        summary: "Launch project.",
        sourceSlug: "source-a",
        evidenceIds: ["ev_a"],
      },
      {
        kind: "person" as const,
        name: "Christian",
        summary: "Project owner.",
        sourceSlug: "source-a",
        evidenceIds: ["ev_a"],
      },
    ];
    const relations = [{
      fromKind: "person" as const,
      fromName: "Christian",
      toKind: "project" as const,
      toName: "Apollo",
      type: "owns",
      sourceSlug: "source-a",
      evidenceIds: ["ev_a"],
    }];
    await upsertStructuredKnowledge("alice", records, relations);
    await upsertStructuredKnowledge(
      "alice",
      records.map((record) => ({
        ...record,
        sourceSlug: "source-b",
        evidenceIds: ["ev_b"],
      })),
      relations.map((relation) => ({
        ...relation,
        sourceSlug: "source-b",
        evidenceIds: ["ev_b"],
      })),
    );

    const graph = await upsertStructuredKnowledge(
      "alice",
      [],
      [],
      new Date(),
      { replaceSourceSlug: "source-a", priorEvidenceIds: ["ev_a"] },
    );

    expect(graph.records).toHaveLength(2);
    expect(graph.records[0].sourceSlugs).toEqual(["source-b"]);
    expect(graph.records[0].evidenceIds).toEqual(["ev_b"]);
    expect(graph.relations).toHaveLength(1);
    expect(graph.relations[0].sourceSlugs).toEqual(["source-b"]);
    expect(graph.relations[0].evidenceIds).toEqual(["ev_b"]);
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

    const replacementOutput = {
      records: generatedOutput.records.map((record) => ({ ...record })),
      relations: [
        {
          fromKind: "decision",
          fromName: "November launch",
          toKind: "project",
          toName: "Apollo",
          type: "decision for",
          validFrom: null,
          validTo: null,
          evidenceExcerpt: "Christian approved the November launch.",
        },
      ],
    };
    generateTextMock.mockResolvedValueOnce({ output: replacementOutput });

    const rerun = await extractStructuredKnowledge("alice", "decision-log");

    expect(rerun.records).toHaveLength(2);
    expect(rerun.records.every((record) => record.evidenceIds.length === 1)).toBe(true);
    expect(rerun.relations).toHaveLength(1);
    expect(rerun.relations[0]).toMatchObject({ type: "decision for" });
    const replacedEvidence = await getPageEvidence("alice", "decision-log");
    expect(replacedEvidence?.claims).toHaveLength(2);
  });

  describe("the refusal when no extraction provider is configured (DW-630)", () => {
    /**
     * `detectEnvProvider` auto-selects the primary provider from the FIRST of
     * these that is set, and an inherited primary is what
     * `getStructuredKnowledgeModelSettings` falls back to — so any one of them
     * present in a developer's shell makes the unconfigured state, and this
     * refusal, unreachable. The file-wide `beforeEach` clears only
     * `OPENAI_API_KEY`, which is not enough.
     */
    const DETECTION_VARS = [
      "ANTHROPIC_API_KEY",
      "OPENAI_API_KEY",
      "GOOGLE_GENERATIVE_AI_API_KEY",
      "DEEPSEEK_API_KEY",
      "OLLAMA_API_KEY",
      "OLLAMA_BASE_URL",
      "OLLAMA_MODEL",
    ] as const;

    let saved: Record<string, string | undefined>;

    beforeEach(() => {
      saved = {};
      for (const name of DETECTION_VARS) {
        saved[name] = process.env[name];
        delete process.env[name];
      }
      _resetConfigCache();
    });

    afterEach(() => {
      for (const name of DETECTION_VARS) {
        if (saved[name] === undefined) delete process.env[name];
        else process.env[name] = saved[name];
      }
      _resetConfigCache();
    });

    /** The message `extractStructuredKnowledge` refuses the seeded page with. */
    async function refusal(slug: string): Promise<string> {
      try {
        await extractStructuredKnowledge("alice", slug);
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
      // AFTER the `catch`, never inside the `try`: inline, this throw is caught
      // by its own handler and the sentinel becomes the "message" asserted on.
      throw new Error("expected the extraction to be refused");
    }

    it("sends an owner with no extraction provider to the LLM Models category", async () => {
      // The sentence used to end "Choose one in Settings;" — a surface with
      // nine categories and no hint which one holds provider selection, which
      // is weaker than the sibling refusals in `llm.ts` that all name the
      // field. Asserted against the DERIVATION, not a hand-composed literal: a
      // test that spelled the label would still pass if the source stopped
      // calling `settingsPointer`, and would fail on the very rename the
      // derivation exists to absorb.
      const pointer = settingsPointer("llm-models", SETTINGS_LABEL);
      // No config is saved and the `beforeEach` above clears every variable
      // `detectEnvProvider` consults, so nothing is selected or inherited and
      // the refusal is reached directly.
      await getStorage().writeFile(
        tenantWikiRelPath("alice", "no-provider.md"),
        "---\ntitle: No provider\nowner: alice\n---\nNothing can be extracted from here yet.\n",
      );

      const message = await refusal("no-provider");
      // The WHOLE sentence, not a substring: `rejects.toThrow` would pass on a
      // message that merely contained this, including one that had also kept
      // the old bare "Settings" clause somewhere else in it.
      expect(message).toBe(
        `Structured Knowledge needs a configured extraction provider. Choose one in ${pointer}; credentials stay in server secrets.`,
      );
      // SHORT surface form, for the same reason `llm.ts` uses it: this is a
      // runtime error raised from an extraction run, rendered on neither
      // Settings surface, so the disambiguating "Workbench " would be noise.
      expect(message).not.toContain("Workbench");
    });

    it("spells the destination nowhere in structured-knowledge.ts itself", async () => {
      // The mirror of `llm.test.ts`'s whole-file scan, and the reason the
      // pointer is hoisted to a module constant rather than composed inline at
      // the throw: the acceptance criterion names BOTH files, and until now
      // only `llm.ts` was scanned. Read as bytes, because a second refusal
      // written beside this one with a hand-typed label is invisible to any
      // assertion on a single message.
      const source = await fs.readFile(
        path.resolve(__dirname, "../structured-knowledge.ts"),
        "utf8",
      );
      const category = settingsCategory("llm-models").label;
      expect(source).not.toContain(`${SETTINGS_LABEL} → ${category}`);
      // And the derivation is actually reached — a file that had simply dropped
      // the destination would pass the check above too.
      expect(source).toContain('settingsPointer("llm-models", SETTINGS_LABEL)');
    });
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

// ---------------------------------------------------------------------------
// Guidance by human, storage by handle (DW-709)
// ---------------------------------------------------------------------------

import { createNamesTerm } from "../names-terms";
import { tenantForOwner } from "../wiki";
import { createWiki, writeWikiArtifact } from "../wikis";

/**
 * `ownerToTenant("alice--yoyo")` is the AGENT's own tenant, so before DW-709 an
 * agent extracting one of its own pages resolved a Workspace Purpose and a
 * Names & Terms dictionary that did not exist. The reduction is guidance-only:
 * the tenant read and the page-owner guard above it still compare RAW handles,
 * which is what keeps the agent's pages in the agent's silo.
 */
describe("agent-owned extraction is guided by the human owner (DW-709)", () => {
  const HUMAN = "alice";
  const AGENT = "alice--yoyo";
  const PURPOSE = "Track Project Lighthouse decisions.";

  const OUTPUT = {
    records: [{
      kind: "project",
      name: "Lighthouse",
      summary: "Lighthouse shipped in November.",
      status: null,
      validFrom: null,
      validTo: null,
      evidenceExcerpt: "Lighthouse shipped in November.",
    }],
    relations: [],
  };

  beforeEach(async () => {
    process.env.OPENAI_API_KEY = "openai-test-key";
    await saveConfig({
      provider: "openai",
      model: "gpt-4o",
      structuredKnowledgeProvider: "openai",
      structuredKnowledgeModel: "gpt-4o",
    });
    const wiki = await createWiki(HUMAN, { name: "Ops", scenario: "business" });
    await writeWikiArtifact(HUMAN, wiki.id, "purpose.md", `# Ops\n\n${PURPOSE}\n`);
    await createNamesTerm(HUMAN, {
      kind: "project",
      canonical: "Project Lighthouse",
      aliases: ["Lighthouse"],
    });
    // Written into the AGENT's silo with the AGENT as frontmatter owner, so the
    // storage read and the owner guard both have to stay raw for this to be
    // readable at all.
    await getStorage().writeFile(
      tenantWikiRelPath(tenantForOwner(AGENT), "decision-log.md"),
      `---\ntitle: Decision log\nowner: ${AGENT}\n---\nLighthouse shipped in November.\n`,
    );
  });

  it("carries the human's Purpose and dictionary into the extraction prompt", async () => {
    generateTextMock.mockResolvedValueOnce({ output: OUTPUT });

    const graph = await extractStructuredKnowledge(AGENT, "decision-log");

    const system = String(generateTextMock.mock.calls[0][0].system);
    expect(system).toContain(PURPOSE);
    expect(system).toContain("WORKSPACE NAMES & TERMS");
    expect(system).toContain("aliases: Lighthouse");
    // The DATA-visible half, not just prompt text: `canonicalRecordName` runs
    // every `person`/`organization`/`project` record through
    // `canonicalizeNamesTerm(dictionary, …)`, and the fixture emits the ALIAS
    // as the record name. Against the agent's own empty tenant the name would
    // persist verbatim as "Lighthouse".
    expect(graph.records).toHaveLength(1);
    expect(graph.records[0].name).toBe("Project Lighthouse");
    // Storage is untouched: the graph lands in the agent's silo, not alice's.
    expect(tenantForOwner(AGENT)).not.toBe(tenantForOwner(HUMAN));
    const stored = await getStructuredKnowledge(AGENT);
    expect(stored.records).toHaveLength(1);
    expect(stored.records[0].name).toBe("Project Lighthouse");
    expect((await getStructuredKnowledge(HUMAN)).records).toHaveLength(0);
  });

  it("still refuses a caller who is not the page owner, comparing RAW tenants", async () => {
    // Two DIFFERENT refusals, and it matters which is which.
    //
    // `alice` never reaches the owner guard at all: the storage read on
    // `tenantWikiRelPath(tenant(owner), …)` happens FIRST, and the page exists
    // only in the agent's silo, so this is an ENOENT — evidence that the READ
    // stayed raw, not evidence about the guard.
    await expect(extractStructuredKnowledge(HUMAN, "decision-log")).rejects.toThrow();
    // The guard itself is pinned below, by the one caller that gets past the
    // read: a DIFFERENT agent of the same human, holding its own copy of the
    // page. A guard that reduced to the human would compare `alice` to `alice`
    // and wave `alice--scout` through; the exact message asserts it does not.
    await getStorage().writeFile(
      tenantWikiRelPath(tenantForOwner("alice--scout"), "decision-log.md"),
      `---\ntitle: Decision log\nowner: ${AGENT}\n---\nLighthouse shipped in November.\n`,
    );
    await expect(
      extractStructuredKnowledge("alice--scout", "decision-log"),
    ).rejects.toThrow("Only the page owner may extract structured knowledge");
  });
});
