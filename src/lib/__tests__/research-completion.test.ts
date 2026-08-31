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
  ResearchCompletionShapeError,
  commitResearchPage,
  clearResearchStaging,
  drainResearchOutbox,
  listResearchOutboxIds,
  loadResearchOutbox,
  researchIngestJobId,
  saveResearchOutbox,
  stageResearchSource,
  researchFrontmatter,
} from "../research-completion";
import { createIngestJobIfAbsent, getIngestJob, updateIngestJob } from "../ingest-jobs";
import {
  createResearchProject,
  deleteResearchProject,
  getResearchProject,
  updateResearchProject,
  type ResearchCompletion,
} from "../research-projects";
import { cancelResearchProject, retireResearchProject } from "../research-runtime";
import { _resetStorage, getStorage } from "../storage";
import { enqueueTask } from "../tasks";
import { saveRawSourceFor } from "../raw";
import { tenantForOwner, writeWikiPage } from "../wiki";
import { sourceSha256 } from "../source-sha256";
import { serializeFrontmatter } from "../frontmatter";
import {
  acquireResearchSlot,
  activeResearchCount,
  renewResearchSlot,
  rotateResearchSlot,
  RESEARCH_SLOT_TTL_MS,
} from "../research-concurrency";

const mockedWritePage = vi.mocked(writeWikiPageWithSideEffects);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedSaveRaw = vi.mocked(saveRawSourceFor);

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
  mockedWritePage.mockImplementation(async ({ slug, idempotency }) => {
    const result = { slug, updatedSlugs: [] };
    if (idempotency) {
      await getStorage().writeFile(
        idempotency.receiptPath,
        JSON.stringify({ key: idempotency.key, result }),
      );
    }
    return result;
  });
  mockedEnqueue.mockResolvedValue(true);
  mockedSaveRaw.mockImplementation(async (slug, sha, content) => {
    const rel = `raw/sources/${slug}/${sha}.md`;
    await getStorage().writeFile(rel, content);
    return rel;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("research completion outbox", () => {
  it("refuses a stale attempt before staging Source bytes", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: "replacement-attempt",
    });

    await expect(stageResearchSource(
      "alice",
      created.id,
      OUTBOX.sources[0],
      "stale-attempt",
    )).rejects.toThrow(/retired/i);
    expect(await getStorage().listFiles("tenants/alice/research-outbox")).toEqual([]);
  });

  it("refuses a stale attempt before persisting an outbox or Page", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await updateResearchProject("alice", created.id, {
      status: "ready",
      runAttemptId: "replacement-attempt",
    });

    await expect(commitResearchPage("alice", created.id, {
      ...OUTBOX,
      attemptId: "stale-attempt",
    })).rejects.toThrow(/attempt was replaced/i);
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("discovers staged bodies when their manifest is malformed", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const staged = await stageResearchSource("alice", created.id, OUTBOX.sources[0]);
    await getStorage().writeFile(
      `tenants/alice/research-outbox/staging-${created.id}.manifest`,
      "{ malformed",
    );

    await clearResearchStaging("alice", created.id);

    await expect(getStorage().fileExists(staged.sourcePath)).resolves.toBe(false);
  });

  it("refuses the Page when cancel wins the claim", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await cancelResearchProject("alice", created.id);

    expect(await commitResearchPage("alice", created.id, OUTBOX)).toBeNull();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("linearizes Page authorization before a later cancel request", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const cancelsDuringWrite: Awaited<ReturnType<typeof cancelResearchProject>>[] = [];
    mockedWritePage.mockImplementation(async ({ slug }) => {
      cancelsDuringWrite.push(await cancelResearchProject("alice", created.id));
      return { slug, updatedSlugs: [] };
    });

    const committed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(cancelsDuringWrite[0]?.cancelRequested).not.toBe(true);
    expect(cancelsDuringWrite[0]?.progress?.message).toMatch(/commit has already started/i);
    expect(committed?.completion?.phase).toBe("sources");
    expect(committed?.pageSlugs).toContain("research-launch-evidence");
  });

  it("rechecks cancellation after winning the claim and before calling the Page writer", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const storage = getStorage();
    const writeFile = storage.writeFile.bind(storage);
    vi.spyOn(storage, "writeFile").mockImplementation(async (relPath, content) => {
      await writeFile(relPath, content);
      if (relPath.endsWith(`${created.id}.json`) && content.includes('"claimed":true')) {
        await cancelResearchProject("alice", created.id);
      }
    });

    const committed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(committed?.status).toBe("cancelled");
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
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
    expect(ingest[0]).toMatchObject({
      sourcePath: "raw/sources/research-example-com-launch-brief/abc.md",
    });
    expect(ingest[0]).not.toHaveProperty("content");
    expect((await getResearchProject("alice", created.id))?.completion?.sources[0]?.jobId)
      .toBe(expected);
  });

  it("dispatches when another isolate created only the dispatch-pending job", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const sha = await sourceSha256(OUTBOX.sources[0].text);
    const slug = "research-example-com-launch-brief";
    const jobId = await researchIngestJobId(created.id, slug, sha);
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [{ url: OUTBOX.sources[0].url, title: OUTBOX.sources[0].title, slug, sha, jobId }],
      },
    });
    await createIngestJobIfAbsent({
      jobId,
      owner: "alice",
      title: OUTBOX.sources[0].title,
      sourceRel: `raw/sources/${slug}/${sha}.md`,
      sourceType: "url",
      stage: "dispatch-pending",
    });
    const storage = getStorage();
    const readFile = storage.readFile.bind(storage);
    let hideExistingOnce = true;
    vi.spyOn(storage, "readFile").mockImplementation(async (relPath) => {
      if (hideExistingOnce && relPath === `ingest-jobs/${jobId}.json`) {
        hideExistingOnce = false;
        throw Object.assign(new Error("not found"), { code: "ENOENT" });
      }
      return readFile(relPath);
    });

    await drainResearchOutbox("alice", created.id);

    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({ jobId }));
    expect((await getResearchProject("alice", created.id))?.completion?.phase).toBe("done");
  });

  it("does not regress a job completed by a fast queue consumer", async () => {
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
          sha: await sourceSha256(OUTBOX.sources[0].text),
        }],
      },
    });
    mockedEnqueue.mockImplementationOnce(async (task) => {
      if (task.kind === "ingest") {
        if (!task.jobId) throw new Error("missing ingest job id");
        await updateIngestJob(task.jobId, { status: "done", stage: "complete", slug: "launch" });
      }
      return true;
    });

    await drainResearchOutbox("alice", created.id);

    const task = mockedEnqueue.mock.calls[0]?.[0];
    expect(task?.kind).toBe("ingest");
    if (!task || task.kind !== "ingest") throw new Error("missing ingest task");
    if (!task.jobId) throw new Error("missing ingest job id");
    expect(await getIngestJob(task.jobId)).toMatchObject({ status: "done", stage: "complete" });
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

  it("rejects a stale caller checkpoint and asks lifecycle to verify its own receipt", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        sources: [],
        writeClaimedAt: new Date(Date.now() - RESEARCH_PAGE_WRITE_STALE_MS - 1_000).toISOString(),
        writeClaimId: "dead-writer",
      },
    });
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/research-outbox/${created.id}.json.page-written`,
      JSON.stringify({ completedAt: new Date().toISOString(), claimId: "dead-writer" }),
    );

    const resumed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(resumed?.completion?.phase).toBe("sources");
  });

  it("resumes lifecycle side effects when exact Page bytes exist without its receipt", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const body = serializeFrontmatter(
      researchFrontmatter("alice", OUTBOX.evidence),
      OUTBOX.synthesis,
    );
    await writeWikiPage(OUTBOX.pageSlug, body, undefined, undefined, tenantForOwner("alice"));
    await writeWikiPage(OUTBOX.pageSlug, body);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        sources: [],
        writeClaimedAt: new Date(Date.now() - RESEARCH_PAGE_WRITE_STALE_MS - 1_000).toISOString(),
        writeClaimId: "dead-writer",
      },
    });

    const resumed = await commitResearchPage("alice", created.id, OUTBOX);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(resumed?.completion?.phase).toBe("sources");
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
    // The caller always re-enters lifecycle; the real writer consumes its
    // receipt and returns without replaying side effects. This unit mocks that
    // boundary, so both calls are observable here.
    expect(mockedWritePage).toHaveBeenCalledTimes(2);
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

  it("removes staged source bytes when DELETE retires a project before commit", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const staged = await stageResearchSource("alice", created.id, {
      url: "https://example.com/private-draft",
      title: "Private draft",
      text: "SECRET_BODY",
    });
    expect(await getStorage().readFile(staged.sourcePath)).toBe("SECRET_BODY");

    await retireResearchProject("alice", created.id);

    await expect(getStorage().readFile(staged.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await getResearchProject("alice", created.id)).toBeNull();
  });

  it("serializes DELETE with a body write that follows its staging manifest", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const storage = getStorage();
    const originalWrite = storage.writeFile.bind(storage);
    let bodyWriteStarted!: () => void;
    let releaseBody!: () => void;
    const started = new Promise<void>((resolve) => { bodyWriteStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseBody = resolve; });
    vi.spyOn(storage, "writeFile").mockImplementation(async (rel, content) => {
      if (rel.includes(`/research-outbox/staging-${created.id}-`) && !rel.endsWith(".manifest")) {
        bodyWriteStarted();
        await release;
      }
      return originalWrite(rel, content);
    });

    const staging = stageResearchSource("alice", created.id, {
      url: "https://example.com/racy-private-draft",
      title: "Racy private draft",
      text: "SECRET_RACE_BODY",
    });
    await started;
    let retired = false;
    const retiring = retireResearchProject("alice", created.id).then((value) => {
      retired = value;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(retired).toBe(false);

    releaseBody();
    const staged = await staging;
    await expect(retiring).resolves.toBe(true);
    await expect(storage.readFile(staged.sourcePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(storage.readFile(
      `tenants/${tenantForOwner("alice")}/research-outbox/staging-${created.id}.manifest`,
    )).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a late Source stage after DELETE removed the project", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await retireResearchProject("alice", created.id);

    await expect(stageResearchSource("alice", created.id, {
      url: "https://example.com/too-late",
      title: "Too late",
      text: "PRIVATE_LATE_BODY",
    })).rejects.toThrow(/retired/i);

    const dir = `tenants/${tenantForOwner("alice")}/research-outbox`;
    const files = await getStorage().listFiles(dir).catch(() => []);
    expect(files.map((entry) => entry.name).join("\n")).not.toContain(created.id);
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

  it("retains the DELETE tombstone when completion cannot release its live lease", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    expect(await retireResearchProject("alice", created.id)).toBe(true);
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => target.endsWith("research-leases.json")
        ? false
        : originalMatch(target, content, etag),
    );

    expect(await commitResearchPage("alice", created.id, OUTBOX)).toBeNull();

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      runAttemptId: grant.attemptId,
    });
    expect(await activeResearchCount("alice")).toBe(1);
  });

  it("retains the DELETE tombstone when completion sees a rotated successor lease", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    expect(await retireResearchProject("alice", created.id)).toBe(true);
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    const rotated = await rotateResearchSlot("alice", created.id, grant.attemptId!);

    expect(await commitResearchPage("alice", created.id, OUTBOX)).toBeNull();

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      runAttemptId: grant.attemptId,
    });
    expect(await activeResearchCount("alice")).toBe(1);
    await expect(renewResearchSlot("alice", created.id, rotated!.attemptId!))
      .resolves.toBeUndefined();
    vi.useRealTimers();
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

/**
 * DW-579. `isResearchProject` validates no nested optional structure, so a
 * stored `completion` can reach the drain with no `sources` at all or with a
 * STRING there. Undefined died in `findIndex`/`map` as the same opaque
 * `TypeError` DW-476 removed from the registry sort; a string was iterated one
 * character at a time, turning the completion into per-character garbage. Both
 * now refuse by name, and refusing is the point — coercing to `[]` would mark
 * the completion `done` having delivered nothing.
 */
describe("a stored completion whose sources are not a list", () => {
  /** Seed a `sources`-phase completion the registry accepts but the drain must refuse. */
  async function seedBadCompletion(completion: Record<string, unknown>): Promise<string> {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: completion as unknown as ResearchCompletion,
    });
    return created.id;
  }

  it.each([
    ["missing entirely", { phase: "sources", pageSlug: OUTBOX.pageSlug }],
    // Falsy and truthy non-arrays are both here on purpose. They used to take
    // different routes — `commitResearchPage` tested `completion?.sources?.length`,
    // so a falsy one fell back like a missing list while a truthy one passed
    // and was persisted forward. Since DW-652 every read of a stored
    // `completion.sources` is guarded before any truthiness test, so the two
    // are now indistinguishable: both refuse, at the same door, by the same
    // name. These rows are what keeps that true.
    ["null", { phase: "sources", pageSlug: OUTBOX.pageSlug, sources: null }],
    ["a string", { phase: "sources", pageSlug: OUTBOX.pageSlug, sources: "https://example.com/a" }],
    ["an object", { phase: "sources", pageSlug: OUTBOX.pageSlug, sources: { url: "x" } }],
  ])("refuses the drain by name when sources are %s", async (_label, completion) => {
    const id = await seedBadCompletion(completion);

    // ONE drain, one caught error: a refusing drain is not byte-for-byte
    // idempotent (it mints `deliveryAttemptId` first, see the row below), so
    // all three assertions have to be made against the same thrown value.
    const caught = await drainResearchOutbox("alice", id).then(
      () => { throw new Error("drain resolved instead of refusing"); },
      (error: unknown) => error,
    );

    // By NAME first: a duplicated module graph must not be able to un-classify
    // the refusal, so the name is the load-bearing assertion and `instanceof`
    // is the stronger one that holds in this single-graph test process.
    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    expect((caught as Error).message).toBe("Research completion sources are not a list.");
  });

  it("leaves the completion, the status and the outbox alone, writing only the delivery fence", async () => {
    const id = await seedBadCompletion({
      phase: "sources",
      pageSlug: OUTBOX.pageSlug,
      sources: "https://example.com/a",
    });
    const before = await getResearchProject("alice", id);
    expect(before?.deliveryAttemptId).toBeUndefined();

    await expect(drainResearchOutbox("alice", id)).rejects.toBeInstanceOf(
      ResearchCompletionShapeError,
    );

    const after = await getResearchProject("alice", id);
    // NOT a whole-row no-write guarantee, and the exception is pinned rather
    // than hidden by a narrow comparison: `drainResearchOutbox` mints and
    // PERSISTS `deliveryAttemptId` before it ever reads `completion.sources`,
    // so a refusing drain does write the row — that field and `updatedAt`.
    expect(after?.deliveryAttemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(after?.updatedAt).not.toBe(before?.updatedAt);

    // What IS guaranteed: the bad value is neither repaired nor acted on. The
    // completion payload is byte-identical, the status never moves, the outbox
    // still holds the bodies so an operator fix can drain them, and no Ingest
    // was enqueued for the string's characters.
    expect(after?.completion).toEqual(before?.completion);
    expect(after?.status).toBe(before?.status);
    expect(await loadResearchOutbox("alice", id)).not.toBeNull();
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("refuses from checkpointSource when the row is corrupted mid-drain", async () => {
    // The drain loop guards only the SNAPSHOT it read at the top, so every row
    // above refuses there and `checkpointSource`'s own guard never runs. This
    // row is the one that reaches it: the stored `sources` is a valid list when
    // the drain starts and is corrupted while the FIRST source is in flight, so
    // the next `checkpointSource` — which re-reads the stored row inside its
    // mutator — is the door that has to refuse.
    const second = {
      url: "https://example.com/launch/timeline",
      title: "Launch timeline",
      text: "THE SECOND BODY.",
    };
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, {
      ...OUTBOX,
      sources: [OUTBOX.sources[0], second],
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [
          {
            url: OUTBOX.sources[0].url,
            title: OUTBOX.sources[0].title,
            slug: "research-example-com-launch-brief",
            sha: "abc",
          },
          {
            url: second.url,
            title: second.title,
            slug: "research-example-com-launch-timeline",
            sha: "def",
          },
        ],
      },
    });

    // The `enqueueTask` seam runs inside the dispatch of source one, after the
    // drain has taken its snapshot and before any later checkpoint.
    let corrupted = false;
    mockedEnqueue.mockImplementation(async () => {
      if (!corrupted) {
        corrupted = true;
        await updateResearchProject("alice", created.id, {
          completion: {
            phase: "sources",
            pageSlug: OUTBOX.pageSlug,
            sources: "https://example.com/launch/brief",
          } as unknown as ResearchCompletion,
        });
      }
      return true;
    });

    const caught = await drainResearchOutbox("alice", created.id).then(
      () => { throw new Error("drain resolved instead of refusing"); },
      (error: unknown) => error,
    );

    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);

    // This is what makes the row specific to `checkpointSource`: the drain got
    // past its own loop guard and did REAL WORK — source one's Ingest was
    // dispatched — before anything refused. A refusal from the loop guard
    // would have enqueued nothing at all.
    expect(mockedEnqueue).toHaveBeenCalledTimes(1);
    expect(corrupted).toBe(true);

    // And the corrupt value is still on disk, untouched: refusing is not
    // repairing.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion?.sources).toBe("https://example.com/launch/brief");
    expect(after?.completion?.phase).toBe("sources");
  });

  /**
   * DW-654. `Array.isArray` alone admitted an array of WRONG-SHAPED elements,
   * which then reached `source.url === url` and `meta.slug` as the same opaque
   * `TypeError` one level down. Each row below is a list the old guard passed.
   */
  it.each([
    ["a bare string", ["https://example.com/a"], 0],
    ["null", [null], 0],
    ["an empty object", [{}], 0],
    // A nested array: `typeof "object"` and non-null, so it reaches the field
    // tests. What this row pins is the OUTCOME — a list of lists is refused.
    // The `Array.isArray(value)` early return in `isCompletionSource` is not
    // what does the refusing here (a bare `[]` has no `url` either, so it
    // fails regardless); it is there to make the refusal deliberate rather
    // than incidental, mirroring `isResearchProject`'s own first line.
    ["an array", [[]], 0],
    // A wrong-typed REQUIRED field, not just a missing one: `sha: 123` reaches
    // `meta.sha` as the raw-source filename and the ingest job's content hash.
    ["a wrong-typed required field", [{
      url: OUTBOX.sources[0].url,
      title: OUTBOX.sources[0].title,
      slug: "research-example-com-launch-brief",
      sha: 123,
    }], 0],
    // Not just the required fields: an optional one with the wrong type is a
    // shape this module dereferences (`meta.ingested` decides whether a source
    // is re-dispatched), and `"yes"` is truthy, so accepting it would silently
    // mark an un-ingested source delivered.
    ["a wrong-typed optional field", [{
      url: OUTBOX.sources[0].url,
      title: OUTBOX.sources[0].title,
      slug: "research-example-com-launch-brief",
      sha: "abc",
      ingested: "yes",
    }], 0],
    // The row that makes the index load-bearing. Every case above names index
    // 0, so a hard-coded `0` in place of the `findIndex` would satisfy them
    // all; this one puts a GOOD source first and only refuses correctly if the
    // reported index is really computed.
    ["preceded by a well-shaped source", [
      {
      url: OUTBOX.sources[0].url,
      title: OUTBOX.sources[0].title,
      slug: "research-example-com-launch-brief",
      sha: "abc",
    },
      { url: "https://example.com/launch/timeline" },
    ], 1],
  ])("refuses the drain by index when the bad element is %s", async (_label, sources, index) => {
    const id = await seedBadCompletion({
      phase: "sources",
      pageSlug: OUTBOX.pageSlug,
      sources,
    });

    const caught = await drainResearchOutbox("alice", id).then(
      () => { throw new Error("drain resolved instead of refusing"); },
      (error: unknown) => error,
    );

    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    // The INDEX is the message's whole job: there is no repair route, so it is
    // the operator's only handle on WHICH entry is wrong.
    expect((caught as Error).message).toBe(`Research completion source ${index} is invalid.`);
    // Refused at the door, before anything acted on the bad element.
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  /**
   * DW-652. `commitResearchPage`'s two `completion?.sources?.length ? … : …`
   * fallbacks treated a TRUTHY non-array as a usable list, so the string was
   * written forward — row moved to `phase: "sources"` with a progress message
   * counting its 21 characters as sources — and only the drain immediately
   * after refused. The commit is now the door that refuses.
   */
  it("refuses in commitResearchPage instead of persisting a truthy non-array forward", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        sources: "https://example.com/a",
      } as unknown as ResearchCompletion,
    });

    const caught = await commitResearchPage("alice", created.id, OUTBOX).then(
      () => { throw new Error("commit resolved instead of refusing"); },
      (error: unknown) => error,
    );

    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    // The non-array message stays verbatim — it is the same failure, caught a
    // door earlier.
    expect((caught as Error).message).toBe("Research completion sources are not a list.");
    expect(mockedWritePage).not.toHaveBeenCalled();

    // The bad value never moved forward: same phase, byte-identical payload,
    // and no `Ingesting 21 sources.` counting the string's characters.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion?.phase).toBe("page");
    expect(after?.completion?.sources).toBe("https://example.com/a");
    expect(after?.progress?.message ?? "").not.toContain("Ingesting");
    // Refusing is not repairing, and it is not discarding either: the outbox
    // still holds the bodies so an operator fix can drain them — the same
    // contract the sibling drain refusal pins.
    expect(await loadResearchOutbox("alice", created.id)).not.toBeNull();
  });

  /**
   * The FALSY half of the same commit door. The old condition was
   * `afterSave.completion?.sources?.length`, which a missing or `null`
   * `sources` fails exactly the way a first commit does — so reverting to it
   * would leave the truthy row above green while these two silently self-heal
   * from the outbox, writing a completion the stored row never had. "No
   * `completion` at all" is the first-commit path; "a completion whose
   * `sources` is missing" is a half-written row, and the two must not be
   * confused.
   */
  it.each([
    ["missing entirely", { phase: "page", pageSlug: OUTBOX.pageSlug }],
    ["null", { phase: "page", pageSlug: OUTBOX.pageSlug, sources: null }],
  ])("refuses in commitResearchPage when a stored completion's sources are %s", async (
    _label,
    completion,
  ) => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: completion as unknown as ResearchCompletion,
    });
    const before = await getResearchProject("alice", created.id);

    const caught = await commitResearchPage("alice", created.id, OUTBOX).then(
      () => { throw new Error("commit resolved instead of refusing"); },
      (error: unknown) => error,
    );

    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    expect((caught as Error).message).toBe("Research completion sources are not a list.");
    expect(mockedWritePage).not.toHaveBeenCalled();

    // No outbox-derived self-heal: the half-written completion is left exactly
    // as found rather than quietly back-filled from the outbox's sources.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion).toEqual(before?.completion);
    expect(after?.completion?.phase).toBe("page");
  });

  /**
   * The same falsy shape again, but arranged so ONLY the pre-claim read can
   * refuse it — which is what makes that guard's own coverage real rather than
   * borrowed from the CAS guard below it.
   *
   * The trick is the fresh foreign `writeClaimedAt`. The claim mutator checks
   * `researchWriteClaimIsFresh` and DECLINES before it ever reads the sources
   * (deliberately: the in-CAS guard sits below that check so a row this
   * mutator would not touch is declined, not refused). So with the claim held
   * elsewhere the CAS guard cannot fire, and a commit that reached it would
   * return the row normally — "someone else is writing, nothing to do" — even
   * though the stored completion is half-written. The pre-claim read is the
   * only door left, and this is the row that proves it is a door.
   */
  it("refuses at the pre-claim read even when the write claim is held elsewhere", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "page",
        pageSlug: OUTBOX.pageSlug,
        // No `sources` at all — a half-written row, NOT the first-commit path.
        writeClaimedAt: new Date().toISOString(),
        writeClaimId: "another-isolate",
      } as unknown as ResearchCompletion,
    });
    const before = await getResearchProject("alice", created.id);

    const caught = await commitResearchPage("alice", created.id, OUTBOX).then(
      () => { throw new Error("commit resolved instead of refusing"); },
      (error: unknown) => error,
    );

    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    expect((caught as Error).message).toBe("Research completion sources are not a list.");
    expect(mockedWritePage).not.toHaveBeenCalled();

    // The other isolate's claim is untouched — refusing this commit does not
    // steal or clear a live claim — and the half-written completion is neither
    // repaired nor back-filled from the outbox.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion).toEqual(before?.completion);
    expect(after?.completion?.writeClaimId).toBe("another-isolate");
    expect(await loadResearchOutbox("alice", created.id)).not.toBeNull();
  });

  /**
   * DW-652's second read, the one INSIDE the claim CAS. `commitResearchPage`
   * reads the row twice — once before the claim and once again inside the
   * mutator, under the compare-and-swap — and it is the second read that
   * decides what gets WRITTEN. A guard on only the first one is the DW-653
   * defect in a new place: a row that was well-shaped when the pre-claim read
   * saw it, and corrupt by the time the CAS re-read it, would be persisted
   * forward unchecked. This is the only test that reaches that guard.
   */
  it("refuses inside the claim CAS when the row is corrupted after the pre-claim read", async () => {
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, OUTBOX);
    // Well-shaped, and still at `phase: "page"` so the commit proceeds to the
    // claim rather than short-circuiting on an already-advanced phase.
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
      },
    });
    const before = await getResearchProject("alice", created.id);

    // The seam, and it is exact rather than approximate. `getResearchProject`
    // reads the registry with `readFile`; the ONLY caller that reads it with
    // `readFileWithEtag` is the compare-and-swap in
    // `applyResearchProjectMutation`. Installing the spy here — after all the
    // setup writes — means the first such read is the claim CAS's own, so
    // corrupting the file through the un-spied writer just before delegating
    // lands strictly after the pre-claim read and strictly inside the CAS.
    const storage = getStorage();
    const registryPath = `tenants/${tenantForOwner("alice")}/research-projects.json`;
    const readWithEtag = storage.readFileWithEtag.bind(storage);
    let latched = false;
    vi.spyOn(storage, "readFileWithEtag").mockImplementation(async (filePath: string) => {
      if (!latched && filePath === registryPath) {
        latched = true;
        const rows = JSON.parse(await storage.readFile(registryPath)) as Array<
          Record<string, unknown>
        >;
        const row = rows.find((entry) => entry.id === created.id);
        (row!.completion as { sources: unknown }).sources = "https://example.com/a";
        await storage.writeFile(registryPath, JSON.stringify(rows, null, 2));
      }
      return readWithEtag(filePath);
    });

    const caught = await commitResearchPage("alice", created.id, OUTBOX).then(
      () => { throw new Error("commit resolved instead of refusing"); },
      (error: unknown) => error,
    );

    // The latch is asserted first: a seam that stopped firing would otherwise
    // let this test pass vacuously, which is the failure mode it exists to
    // prevent.
    expect(latched).toBe(true);
    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    expect((caught as Error).message).toBe("Research completion sources are not a list.");
    expect(mockedWritePage).not.toHaveBeenCalled();

    // Nothing was written forward: the claim never landed, so the phase is
    // still `page`, no `writeClaimId` was stamped, and no progress message
    // counts the string's 21 characters as sources.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion?.phase).toBe("page");
    expect(after?.completion?.sources).toBe("https://example.com/a");
    expect(after?.completion?.writeClaimId).toBeUndefined();
    expect(after?.progress?.message ?? "").not.toContain("Ingesting");
    expect(before?.completion?.writeClaimId).toBeUndefined();
  });

  /**
   * DW-653. The post-ingest CAS re-reads the stored completion and maps it, so
   * it needs its own guard — and until now no test reached it: every row above
   * refuses at the loop guard or inside `checkpointSource`. This one corrupts
   * the row in the one window that guard alone protects.
   */
  it("refuses at the post-ingest CAS when the row is corrupted after the last checkpoint", async () => {
    const second = {
      url: "https://example.com/launch/timeline",
      title: "Launch timeline",
      text: "THE SECOND BODY.",
    };
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, {
      ...OUTBOX,
      sources: [OUTBOX.sources[0], second],
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [
          {
            url: OUTBOX.sources[0].url,
            title: OUTBOX.sources[0].title,
            slug: "research-example-com-launch-brief",
            sha: "abc",
          },
          {
            url: second.url,
            title: second.title,
            slug: "research-example-com-launch-timeline",
            sha: "def",
          },
        ],
      },
    });

    const before = await getResearchProject("alice", created.id);

    // The seam. Registry writes go through `writeFileIfMatch` (the CAS), so
    // that is what is wrapped. The write whose content shows EVERY stored
    // source `ingested: true` is the last in-loop `checkpointSource`;
    // corrupting the row through the captured original right after it lands
    // is strictly after the loop's final write and strictly before the
    // post-ingest CAS re-reads — the exact window that guard protects.
    const storage = getStorage();
    const registryPath = `tenants/${tenantForOwner("alice")}/research-projects.json`;
    const writeIfMatch = storage.writeFileIfMatch.bind(storage);
    let corrupted = false;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (filePath: string, content: string, etag: string) => {
        const wrote = await writeIfMatch(filePath, content, etag);
        if (!wrote || corrupted || filePath !== registryPath) return wrote;
        const rows = JSON.parse(content) as Array<Record<string, unknown>>;
        const row = rows.find((entry) => entry.id === created.id);
        const completion = row?.completion as { sources?: unknown } | undefined;
        const stored = completion?.sources;
        if (!Array.isArray(stored) || stored.length !== 2) return wrote;
        if (!stored.every((source) => (source as { ingested?: unknown })?.ingested === true)) {
          return wrote;
        }
        corrupted = true;
        completion!.sources = "https://example.com/launch/brief";
        await storage.writeFile(registryPath, JSON.stringify(rows, null, 2));
        return wrote;
      },
    );

    const caught = await drainResearchOutbox("alice", created.id).then(
      () => { throw new Error("drain resolved instead of refusing"); },
      (error: unknown) => error,
    );

    // The corruption really landed in the intended window, and both Ingests
    // were dispatched BEFORE anything refused — which is what makes this row
    // specific to the post-ingest CAS rather than the loop or checkpoint guard.
    expect(corrupted).toBe(true);
    expect((caught as Error).name).toBe("ResearchCompletionShapeError");
    expect(caught).toBeInstanceOf(ResearchCompletionShapeError);
    expect(mockedEnqueue).toHaveBeenCalledTimes(2);

    // What the refusal left behind, stated positively rather than as a weak
    // "not complete" that several different broken states would satisfy: the
    // phase never advanced past `sources`, the status is exactly what it was
    // before the drain, the corrupt value was not repaired, and the outbox
    // still holds both bodies so an operator fix can drain them.
    const after = await getResearchProject("alice", created.id);
    expect(after?.completion?.phase).toBe("sources");
    expect(after?.status).toBe(before?.status);
    expect(after?.completion?.sources).toBe("https://example.com/launch/brief");
    const outbox = await loadResearchOutbox("alice", created.id);
    expect(outbox?.sources).toHaveLength(2);
  });

  /**
   * The ACCEPTANCE side of the guard, which is the half a tightening would
   * break silently. The docblock promises `jobId`/`error` may be a string or
   * absent, `ingested` a boolean or absent, and that unknown extra keys are
   * accepted for forward-compatibility — a row written by a newer build must
   * still drain on this one. Source one carries every optional field ABSENT,
   * source two carries all of them PRESENT plus a key this build never heard
   * of; both must reach `done`.
   */
  it("still drains a completion whose sources are a proper list", async () => {
    const second = {
      url: "https://example.com/launch/timeline",
      title: "Launch timeline",
      text: "THE SECOND BODY.",
    };
    const created = await createResearchProject("alice", {
      title: "Launch evidence",
      question: "What supports the launch date?",
    });
    await saveResearchOutbox("alice", created.id, {
      ...OUTBOX,
      sources: [OUTBOX.sources[0], second],
    });
    await updateResearchProject("alice", created.id, {
      completion: {
        phase: "sources",
        pageSlug: OUTBOX.pageSlug,
        sources: [
          {
            url: OUTBOX.sources[0].url,
            title: OUTBOX.sources[0].title,
            slug: "research-example-com-launch-brief",
            sha: "abc",
          },
          {
            url: second.url,
            title: second.title,
            slug: "research-example-com-launch-timeline",
            sha: "def",
            jobId: "research-ingest-timeline",
            ingested: false,
            error: "a previous attempt failed",
            // Not a field this build knows. A guard that matched keys exactly
            // would refuse a row a newer writer produced.
            futureField: "written by a newer build",
          },
        ] as unknown as ResearchCompletion["sources"],
      },
    });

    // The guard adds refusals only for shapes that already failed: a real
    // list still drains to `done` exactly as before.
    const drained = await drainResearchOutbox("alice", created.id);
    expect(drained?.completion?.phase).toBe("done");

    // Accepted AND carried through — forward-compatibility that dropped the
    // unknown key on the first write would not be forward-compatibility.
    const stored = drained?.completion?.sources ?? [];
    expect(stored).toHaveLength(2);
    expect(stored.every((source) => source.ingested === true)).toBe(true);
    expect((stored[1] as unknown as Record<string, unknown>).futureField)
      .toBe("written by a newer build");
  });
});
