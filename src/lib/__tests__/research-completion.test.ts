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
  RESEARCH_PAGE_WRITE_STALE_MS,
  commitResearchPage,
  drainResearchOutbox,
  listResearchOutboxIds,
  loadResearchOutbox,
  researchIngestJobId,
  saveResearchOutbox,
} from "../research-completion";
import {
  createResearchProject,
  deleteResearchProject,
  getResearchProject,
  updateResearchProject,
} from "../research-projects";
import { cancelResearchProject, retireResearchProject } from "../research-runtime";
import { _resetStorage, getStorage } from "../storage";
import { enqueueTask } from "../tasks";
import { tenantForOwner } from "../wiki";

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
  claimed: true,
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

  it("does not let a concurrent drain un-ingest a source the other drain finished", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const outbox = {
      ...OUTBOX,
      sources: [
        OUTBOX.sources[0],
        {
          url: "https://example.com/launch/appendix",
          title: "Launch appendix",
          text: "APPENDIX BODY.",
        },
      ],
      evidence: [
        ...OUTBOX.evidence,
        { url: "https://example.com/launch/appendix", title: "Launch appendix" },
      ],
    };
    await saveResearchOutbox("alice", created.id, outbox);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [
          {
            url: outbox.sources[0].url,
            title: outbox.sources[0].title,
            slug: "research-example-com-launch-brief",
            sha: "abc",
            ingested: true,
            jobId: "already-done",
          },
          {
            url: outbox.sources[1].url,
            title: outbox.sources[1].title,
            slug: "research-example-com-launch-appendix",
            sha: "def",
          },
        ],
      },
    });

    await Promise.all([
      drainResearchOutbox("alice", created.id),
      drainResearchOutbox("alice", created.id),
    ]);

    const sources = (await getResearchProject("alice", created.id))?.completion?.sources ?? [];
    expect(sources.find((source) => source.url === outbox.sources[0].url)?.ingested).toBe(true);
    expect(sources.find((source) => source.url === outbox.sources[1].url)?.ingested).toBe(true);
    expect(sources.find((source) => source.url === outbox.sources[0].url)?.jobId).toBe("already-done");
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
    mockedEnqueue.mockClear();
    const second = await drainResearchOutbox("alice", created.id);
    expect(second?.completion?.sources[0]?.jobId).toBe(jobId);
    expect(second?.error).toBeUndefined();
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      kind: "ingest",
      jobId,
    }));
  });

  it("lets only one of two concurrent commits write the Page", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });

    await Promise.all([
      commitResearchPage("alice", created.id, OUTBOX),
      commitResearchPage("alice", created.id, OUTBOX),
    ]);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect((await getResearchProject("alice", created.id))?.completion?.phase).toBe("sources");
  });

  it("removes the outbox once drain finishes so a later poll is a no-op", async () => {
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
    expect(first?.completion?.phase).toBe("done");
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
    expect(await listResearchOutboxIds("alice")).toEqual([]);

    mockedEnqueue.mockClear();
    const second = await drainResearchOutbox("alice", created.id);
    expect(second?.completion?.phase).toBe("done");
    expect(second?.updatedAt).toBe(first?.updatedAt);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("keeps the row when delete lands during the Page write", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    let finishWrite: () => void = () => undefined;
    let resolveStarted: () => void = () => undefined;
    const started = new Promise<void>((resolve) => { resolveStarted = resolve; });
    mockedWritePage.mockImplementation(async ({ slug }) => {
      resolveStarted();
      await new Promise<void>((resolve) => { finishWrite = resolve; });
      return { slug, updatedSlugs: [] };
    });

    const commitP = commitResearchPage("alice", created.id, OUTBOX);
    await started;
    expect(await retireResearchProject("alice", created.id)).toBe(true);
    expect(await getResearchProject("alice", created.id)).not.toBeNull();
    expect(mockedWritePage).toHaveBeenCalledTimes(1);

    finishWrite();
    await commitP;
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    await drainResearchOutbox("alice", created.id);
    expect(await getResearchProject("alice", created.id)).toBeNull();
  });

  it("does not steal a fresh Page-write claim just because another drain arrived", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        sources: [{
          url: OUTBOX.sources[0].url,
          title: OUTBOX.sources[0].title,
          slug: "research-example-com-launch-brief",
          sha: "abc",
        }],
        writeClaimedAt: new Date().toISOString(),
        writeClaimId: "writer-1",
      },
    });

    await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).not.toHaveBeenCalled();
    expect((await getResearchProject("alice", created.id))?.completion?.writeClaimId)
      .toBe("writer-1");
  });

  it("steals a stale claim only when the Page is still missing", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        sources: [{
          url: OUTBOX.sources[0].url,
          title: OUTBOX.sources[0].title,
          slug: "research-example-com-launch-brief",
          sha: "abc",
        }],
        writeClaimedAt: new Date(Date.now() - RESEARCH_PAGE_WRITE_STALE_MS - 1_000).toISOString(),
        writeClaimId: "dead-writer",
      },
    });

    await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect((await getResearchProject("alice", created.id))?.completion?.phase).toBe("sources");
  });

  it("drains an orphan outbox after the project row is gone", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    expect(await deleteResearchProject("alice", created.id)).toBe(true);

    await drainResearchOutbox("alice", created.id);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: "ingest" }));
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });

  it("retries an orphan outbox after a stale write claim and a failed ingest", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/research-outbox/${created.id}.json.writing`,
      JSON.stringify({
        at: new Date(Date.now() - RESEARCH_PAGE_WRITE_STALE_MS - 1_000).toISOString(),
      }),
    );
    expect(await deleteResearchProject("alice", created.id)).toBe(true);
    mockedEnqueue.mockRejectedValue(new Error("queue down"));

    await drainResearchOutbox("alice", created.id);
    expect(await loadResearchOutbox("alice", created.id)).not.toBeNull();

    mockedEnqueue.mockResolvedValue(true);
    mockedEnqueue.mockClear();
    await drainResearchOutbox("alice", created.id);
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: "ingest" }));
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });

  it("drops an unclaimed orphan outbox instead of writing a Page", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, { ...OUTBOX, claimed: false });
    expect(await deleteResearchProject("alice", created.id)).toBe(true);

    await drainResearchOutbox("alice", created.id);

    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });

  it("drops a leftover outbox when delete wins before the Page claim", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);

    expect(await retireResearchProject("alice", created.id)).toBe(true);

    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
    expect(await getResearchProject("alice", created.id)).toBeNull();
  });

  it("drops a leftover outbox when cancel wins after the outbox is saved", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await cancelResearchProject("alice", created.id);

    expect(await commitResearchPage("alice", created.id, OUTBOX)).toBeNull();
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });
});
