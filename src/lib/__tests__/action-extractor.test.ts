import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

const {
  generateTextMock,
  outputObjectMock,
  getConfiguredModelMock,
  hasLLMKeyMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  outputObjectMock: vi.fn(({ schema }) => ({ schema })),
  getConfiguredModelMock: vi.fn(async () => ({ id: "test-model" })),
  hasLLMKeyMock: vi.fn(async () => true),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
  Output: { object: outputObjectMock },
}));

vi.mock("../llm", () => ({
  getConfiguredModel: getConfiguredModelMock,
  hasLLMKey: hasLLMKeyMock,
  retryWithBackoff: async <T>(operation: () => Promise<T>) => operation(),
}));

import { extractActionsFromPage } from "../action-extractor";
import { listActionItems } from "../action-items";
import { _resetLocks } from "../lock";
import { createNamesTerm } from "../names-terms";
import { _resetStorage, getStorage } from "../storage";
import { getWikiDir, tenantForOwner } from "../wiki";
import { createWiki, writeWikiArtifact } from "../wikis";

const HUMAN = "alice";
const AGENT = "alice--yoyo";
const PURPOSE = "Track Project Lighthouse decisions.";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "action-extractor-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  vi.clearAllMocks();
  hasLLMKeyMock.mockResolvedValue(true);
  getConfiguredModelMock.mockResolvedValue({ id: "test-model" });
  outputObjectMock.mockImplementation(({ schema }) => ({ schema }));

  await getStorage().writeFile(
    `${getWikiDir()}/standup.md`,
    "---\ntitle: Standup\n---\n# Standup\n\nAli agreed to send the launch brief.\n",
  );
});

afterEach(async () => {
  for (const [name, value] of [
    ["WIKI_DIR", originalWikiDir],
    ["RAW_DIR", originalRawDir],
    ["DATA_DIR", originalDataDir],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * One proposal naming the ALIAS, so canonicalization is a real decision. The
 * title is parameterized because `proposeActionItems` dedupes on title +
 * source slug, and the unreducible-handle case below proposes several times
 * against the same page.
 */
function mockOneAction(title = "Send the launch brief"): void {
  generateTextMock.mockResolvedValueOnce({
    output: {
      actions: [{
        title,
        assignee: "Ali",
        priority: "high",
        sourceExcerpt: "Ali agreed to send the launch brief.",
        confidence: 0.9,
      }],
    },
  });
}

/**
 * Guidance is addressed BY HUMAN, storage by handle (DW-543/DW-709).
 *
 * `ownerToTenant("alice--yoyo")` is the AGENT's own tenant, so before DW-709
 * an agent extracting actions resolved a Workspace Purpose and a Names & Terms
 * dictionary that did not exist — the agent worked to no standards at all.
 * `proposeActionItems` deliberately keeps the RAW handle, because that one
 * names a SILO: reducing it would drop the agent's proposals into alice's
 * inbox.
 */
describe("extractActionsFromPage guidance principal (DW-709)", () => {
  beforeEach(async () => {
    await getStorage().writeFile(`agents/${AGENT}.json`, JSON.stringify({ id: AGENT, owner: HUMAN }));
    const wiki = await createWiki(HUMAN, { name: "Ops", scenario: "business" });
    await writeWikiArtifact(HUMAN, wiki.id, "purpose.md", `# Ops\n\n${PURPOSE}\n`);
    await createNamesTerm(HUMAN, {
      kind: "person",
      canonical: "Alice Chen",
      aliases: ["Ali"],
    });
  });

  it("carries the human's Purpose and dictionary into an AGENT's extraction prompt", async () => {
    mockOneAction();

    await extractActionsFromPage(AGENT, "standup");

    const system = String(generateTextMock.mock.calls[0][0].system);
    expect(system).toContain(PURPOSE);
    expect(system).toContain("WORKSPACE NAMES & TERMS");
    expect(system).toContain("aliases: Ali");
  });

  it("canonicalizes the assignee but stores the proposal in the AGENT's silo", async () => {
    mockOneAction();

    const [created] = await extractActionsFromPage(AGENT, "standup");

    // The DATA-visible half: the alias resolved through ALICE's dictionary.
    expect(created.assignee).toBe("Alice Chen");
    // Addressing is untouched — a reduced handle here would repoint the write.
    expect(tenantForOwner(AGENT)).not.toBe(tenantForOwner(HUMAN));
    expect(await listActionItems(AGENT)).toHaveLength(1);
    expect(await listActionItems(HUMAN)).toEqual([]);
  });

  it("is byte-identical for a plain human handle", async () => {
    mockOneAction();

    const [created] = await extractActionsFromPage(HUMAN, "standup");

    const system = String(generateTextMock.mock.calls[0][0].system);
    expect(system).toContain(PURPOSE);
    expect(system).toContain("aliases: Ali");
    expect(created.assignee).toBe("Alice Chen");
    expect(await listActionItems(HUMAN)).toHaveLength(1);
  });

  it("leaves an unreducible handle addressing exactly the tenant it does today", async () => {
    // `humanOwnerOf` returns `yoyo` / `system` / `--yoyo` whole, so these still
    // resolve their OWN (empty) guidance rather than borrowing anyone's.
    for (const handle of ["yoyo", "system"]) {
      generateTextMock.mockReset();
      // A distinct title per handle: `ownerToTenant` collapses `--yoyo` onto
      // the DEFAULT tenant, so two of these can share one item store and the
      // fixed title would dedupe away the second proposal.
      mockOneAction(`Send the launch brief for ${handle}`);
      const [created] = await extractActionsFromPage(handle, "standup");
      const system = String(generateTextMock.mock.calls[0][0].system);
      expect(system).not.toContain(PURPOSE);
      expect(system).not.toContain("WORKSPACE NAMES & TERMS");
      expect(created.assignee).toBe("Ali");
    }
  });

  it("degrades to an unguided prompt rather than throwing when guidance is absent", async () => {
    // Guidance is an ADDITION: `bob--yoyo` reduces to a human with no Wiki and
    // no dictionary, and extraction still runs and still stores.
    mockOneAction();

    const [created] = await extractActionsFromPage("bob--yoyo", "standup");

    const system = String(generateTextMock.mock.calls[0][0].system);
    expect(system).toContain("You extract actionable commitments");
    expect(system).not.toContain(PURPOSE);
    expect(created.assignee).toBe("Ali");
  });
});

describe("extractActionsFromPage preconditions", () => {
  it("returns nothing without an LLM key, before reading the page", async () => {
    hasLLMKeyMock.mockResolvedValue(false);
    expect(await extractActionsFromPage(AGENT, "standup")).toEqual([]);
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("throws when the page does not exist", async () => {
    await expect(extractActionsFromPage(AGENT, "missing")).rejects.toThrow(
      'Page "missing" not found',
    );
  });
});
