import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * A SEPARATE file from `source-monitors.test.ts` on purpose: the redraft
 * prompt is built by the DEFAULT `draftUpdate`, which every test in that file
 * replaces through `dependencies.draftUpdate` precisely so it never reaches a
 * model. Exercising the default needs `ai` and `../llm` mocked at module level,
 * which would take the injected path away from those tests.
 */
const { generateTextMock, getConfiguredModelMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  getConfiguredModelMock: vi.fn(async () => ({ id: "test-model" })),
}));

vi.mock("ai", () => ({ generateText: generateTextMock }));

vi.mock("../llm", () => ({
  getConfiguredModel: getConfiguredModelMock,
  retryWithBackoff: async <T>(operation: () => Promise<T>) => operation(),
}));

import { serializeFrontmatter } from "../frontmatter";
import { _resetLocks } from "../lock";
import { listMemoryChangeProposals } from "../memory-proposals";
import { createNamesTerm } from "../names-terms";
import { createSourceMonitor, runSourceMonitor } from "../source-monitors";
import { _resetStorage, getStorage } from "../storage";
import { tenantForOwner, tenantWikiRelPath } from "../wiki";
import { createWiki, writeWikiArtifact } from "../wikis";

const HUMAN = "alice";
const AGENT = "alice--yoyo";
const PURPOSE = "Track Project Lighthouse decisions.";

let tmpDir: string;
let originalDataDir: string | undefined;

function page(owner: string, body: string): string {
  return serializeFrontmatter(
    {
      owner,
      visibility: "private",
      authors: [owner],
      created: "2026-08-01",
      updated: "2026-08-01",
    },
    body,
  );
}

/** Seed the monitor's target page inside `owner`'s OWN silo (raw handle). */
async function seedTargetPage(owner: string): Promise<void> {
  await getStorage().writeFile(
    tenantWikiRelPath(tenantForOwner(owner), "plan.md"),
    page(owner, "# Plan\n\nThe launch is planned for September."),
  );
}

/** Baseline, then a materially changed fetch — the only path that redrafts. */
async function runThroughRedraft(owner: string): Promise<string> {
  const monitor = await createSourceMonitor(owner, {
    name: "Launch brief",
    url: "https://example.com/launch",
    targetSlug: "plan",
    meaningfulChangeThreshold: 0.05,
  }, new Date("2026-08-03T10:00:00.000Z"));

  const baseline = await runSourceMonitor(owner, monitor.id, {
    now: new Date("2026-08-03T10:05:00.000Z"),
    fetchSource: async () => ({
      title: "Launch brief",
      content: "The launch is planned for September with a limited pilot group.",
    }),
  });
  expect(baseline.outcome).toBe("initialized");

  // NOTE: no `draftUpdate` override — this is the DEFAULT path under test.
  const changed = await runSourceMonitor(owner, monitor.id, {
    now: new Date("2026-08-04T10:05:00.000Z"),
    fetchSource: async () => ({
      title: "Launch brief",
      content:
        "The launch moved to November. The rollout now includes every regional team and requires legal approval.",
    }),
  });
  expect(changed.outcome).toBe("proposal-created");

  return String(generateTextMock.mock.calls.at(-1)?.[0].system);
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "source-monitors-guidance-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  vi.clearAllMocks();
  getConfiguredModelMock.mockResolvedValue({ id: "test-model" });
  generateTextMock.mockResolvedValue({
    text: "# Plan\n\nThe launch moved to November and requires legal approval.",
  });
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetLocks();
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

/**
 * Guidance is addressed BY HUMAN, storage by handle (DW-543/DW-709).
 *
 * `ownerToTenant("alice--yoyo")` is the AGENT's own tenant, so before DW-709 a
 * monitor an agent owns redrafted the page against no Workspace Purpose and an
 * empty dictionary. Everything else about the run — the lock key, the monitor
 * record, the target page read, the evidence and the proposal — stays on the
 * RAW handle, which is what keeps the monitor in the agent's silo.
 */
describe("the default monitor redraft resolves guidance by human owner (DW-709)", () => {
  beforeEach(async () => {
    const wiki = await createWiki(HUMAN, { name: "Ops", scenario: "business" });
    await writeWikiArtifact(HUMAN, wiki.id, "purpose.md", `# Ops\n\n${PURPOSE}\n`);
    await createNamesTerm(HUMAN, {
      kind: "project",
      canonical: "Project Lighthouse",
      aliases: ["Lighthouse"],
    });
  });

  it("carries the human's Purpose and dictionary into an AGENT-owned redraft", async () => {
    await seedTargetPage(AGENT);

    const system = await runThroughRedraft(AGENT);

    expect(system).toContain(PURPOSE);
    expect(system).toContain("WORKSPACE NAMES & TERMS");
    expect(system).toContain("aliases: Lighthouse");
  });

  it("keeps the monitor and its proposal in the AGENT's silo", async () => {
    await seedTargetPage(AGENT);

    await runThroughRedraft(AGENT);

    expect(tenantForOwner(AGENT)).not.toBe(tenantForOwner(HUMAN));
    expect(await listMemoryChangeProposals(AGENT, "pending")).toHaveLength(1);
    expect(await listMemoryChangeProposals(HUMAN, "pending")).toEqual([]);
  });

  it("is byte-identical for a plain human handle", async () => {
    await seedTargetPage(HUMAN);

    const system = await runThroughRedraft(HUMAN);

    expect(system).toContain(PURPOSE);
    expect(system).toContain("aliases: Lighthouse");
  });

  it("leaves an unreducible handle addressing exactly the tenant it does today", async () => {
    // `humanOwnerOf("yoyo")` returns `yoyo`, so this resolves its OWN (empty)
    // guidance rather than borrowing anyone's.
    await seedTargetPage("yoyo");

    const system = await runThroughRedraft("yoyo");

    expect(system).not.toContain(PURPOSE);
    expect(system).not.toContain("WORKSPACE NAMES & TERMS");
    expect(system).toContain("You revise a private knowledge page");
  });
});
