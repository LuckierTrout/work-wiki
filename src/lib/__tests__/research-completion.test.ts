import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../lifecycle", () => ({ writeWikiPageWithSideEffects: vi.fn() }));
vi.mock("../raw", () => ({ saveRawSourceFor: vi.fn() }));
vi.mock("../tasks", () => ({ enqueueTask: vi.fn(async () => true) }));

import { writeWikiPageWithSideEffects } from "../lifecycle";
import { _resetLocks } from "../lock";
import {
  commitResearchPage,
  drainResearchOutbox,
  researchIngestJobId,
  saveResearchOutbox,
} from "../research-completion";
import {
  createResearchProject,
  getResearchProject,
  updateResearchProject,
} from "../research-projects";
import { cancelResearchProject } from "../research-runtime";
import { _resetStorage } from "../storage";
import { enqueueTask } from "../tasks";

const mockedWritePage = vi.mocked(writeWikiPageWithSideEffects);
const mockedEnqueue = vi.mocked(enqueueTask);

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
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-completion-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  vi.clearAllMocks();
  mockedWritePage.mockImplementation(async ({ slug }) => ({ slug, updatedSlugs: [] }));
  mockedEnqueue.mockResolvedValue(true);
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("research completion outbox", () => {
  it("refuses the Page when cancel wins the claim", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await cancelResearchProject("alice", created.id);

    expect(await commitResearchPage("alice", created.id, OUTBOX)).toBeNull();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("keeps the Page when cancel lands after the commit claim", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    mockedWritePage.mockImplementation(async ({ slug }) => {
      await cancelResearchProject("alice", created.id);
      return { slug, updatedSlugs: [] };
    });

    const committed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(committed?.completion?.phase).toBe("sources");
    expect(committed?.pageSlugs).toContain("research-launch-evidence");
  });

  it("uses one deterministic job id across concurrent drains", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [{
          url: OUTBOX.sources[0].url,
          title: OUTBOX.sources[0].title,
          slug: "research-example-com-launch-brief",
          sha: "abc",
        }],
      },
    });

    await Promise.all([
      drainResearchOutbox("alice", created.id),
      drainResearchOutbox("alice", created.id),
    ]);

    const ingest = mockedEnqueue.mock.calls
      .map(([task]) => task)
      .filter((task) => task.kind === "ingest");
    expect(ingest).toHaveLength(1);
    const expected = await researchIngestJobId(
      created.id,
      "research-example-com-launch-brief",
      "abc",
    );
    expect(ingest[0]).toMatchObject({ jobId: expected });
    expect((await getResearchProject("alice", created.id))?.completion?.sources[0]?.jobId)
      .toBe(expected);
  });

  it("keeps the job id when ingest fails so a retry does not mint another", async () => {
    mockedEnqueue.mockRejectedValue(new Error("queue down"));
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [{
          url: OUTBOX.sources[0].url,
          title: OUTBOX.sources[0].title,
          slug: "research-example-com-launch-brief",
          sha: "abc",
        }],
      },
    });

    const first = await drainResearchOutbox("alice", created.id);
    const jobId = first?.completion?.sources[0]?.jobId;
    expect(jobId).toMatch(/^[a-z0-9]{64}$/);
    expect(first?.completion?.phase).toBe("sources");

    mockedEnqueue.mockResolvedValue(true);
    const second = await drainResearchOutbox("alice", created.id);
    expect(second?.completion?.sources[0]?.jobId).toBe(jobId);
    expect(second?.error).toBeUndefined();
  });
});
