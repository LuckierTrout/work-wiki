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

import { commitResearchPage } from "../research-completion";
import { _resetLocks } from "../lock";
import { createResearchProject, getResearchProject } from "../research-projects";
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
});
