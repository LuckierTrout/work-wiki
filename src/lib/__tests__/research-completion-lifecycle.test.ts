/**
 * Page commit through the real lifecycle writer. The mocked-writer suite
 * pins CAS fencing; this one pins that the winner actually materialises
 * `wiki/<slug>.md` and the index row.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../raw", () => ({ saveRawSourceFor: vi.fn() }));
vi.mock("../tasks", () => ({ enqueueTask: vi.fn(async () => true) }));

import * as lifecycle from "../lifecycle";
import { commitResearchPage } from "../research-completion";
import { _resetLocks } from "../lock";
import { createResearchProject, getResearchProject, updateResearchProject } from "../research-projects";
import { _resetStorage } from "../storage";
import { ensureDirectories, readWikiPage } from "../wiki";

const OUTBOX = {
  pageSlug: "research-launch-evidence",
  title: "Launch evidence",
  synthesis: "# Launch evidence\n\nA brief.",
  thinking: [],
  sources: [{
    url: "https://example.com/launch/brief",
    title: "Launch brief",
    text: "THE WHOLE PAGE BODY.",
  }],
  evidence: [{ url: "https://example.com/launch/brief", title: "Launch brief" }],
};

let tmpDir: string;
let original: Record<string, string | undefined> = {};

const ENV_KEYS = ["DATA_DIR", "WIKI_DIR", "RAW_DIR", "YOPEDIA_READONLY"] as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-lifecycle-"));
  original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  for (const key of ENV_KEYS) {
    const value = original[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("research completion lifecycle write", () => {
  it("materialises the Page through writeWikiPageWithSideEffects", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });

    const committed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(committed?.completion?.phase).toBe("sources");
    const page = await readWikiPage(OUTBOX.pageSlug);
    expect(page?.content).toContain("A brief.");
    expect((await getResearchProject("alice", created.id))?.pageSlugs)
      .toContain(OUTBOX.pageSlug);
  });

  it("lets only one concurrent commit materialise the Page", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const spy = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects");

    await Promise.all([
      commitResearchPage("alice", created.id, OUTBOX),
      commitResearchPage("alice", created.id, OUTBOX),
    ]);

    expect(spy).toHaveBeenCalledTimes(1);
    expect((await readWikiPage(OUTBOX.pageSlug))?.content).toContain("A brief.");
    spy.mockRestore();
  });

  it("does not rewrite a Page once the run has left the page phase", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await commitResearchPage("alice", created.id, OUTBOX);
    const spy = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects");

    await commitResearchPage("alice", created.id, OUTBOX);

    expect(spy).not.toHaveBeenCalled();
    expect((await getResearchProject("alice", created.id))?.completion?.phase).toBe("sources");
    spy.mockRestore();
  });

  it("conditionally replaces the same stable Page on an explicit rerun", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await commitResearchPage("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      status: "queued",
      completion: null,
    });

    const rerun = await commitResearchPage("alice", created.id, {
      ...OUTBOX,
      synthesis: "# Launch evidence\n\nA newer brief.",
    });

    expect(rerun?.completion?.phase).toBe("sources");
    expect((await readWikiPage(OUTBOX.pageSlug))?.content).toContain("A newer brief.");
    expect((await getResearchProject("alice", created.id))?.pageSlugs)
      .toEqual([OUTBOX.pageSlug]);
  });

  it("refuses a rerun when the owner changed the captured Page bytes", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await commitResearchPage("alice", created.id, OUTBOX);
    const prior = await readWikiPage(OUTBOX.pageSlug);
    expect(prior).not.toBeNull();
    await updateResearchProject("alice", created.id, {
      status: "queued",
      completion: null,
    });
    await lifecycle.writeWikiPageWithSideEffects({
      slug: OUTBOX.pageSlug,
      title: OUTBOX.title,
      content: `${prior!.content}\n\nOwner note.`,
      summary: "Owner edit",
      logOp: "edit",
    });

    await expect(commitResearchPage("alice", created.id, {
      ...OUTBOX,
      synthesis: "# Launch evidence\n\nA newer brief.",
      previousPageContent: prior!.content,
    })).rejects.toThrow(/changed; run Lint again/i);
    expect((await readWikiPage(OUTBOX.pageSlug))?.content).toContain("Owner note.");
  });
});
