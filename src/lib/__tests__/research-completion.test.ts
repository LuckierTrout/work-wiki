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
} from "../research-projects";
import { cancelResearchProject, retireResearchProject } from "../research-runtime";
import { _resetStorage, getStorage } from "../storage";
import { enqueueTask } from "../tasks";
import { saveRawSourceFor } from "../raw";
import { tenantForOwner, writeWikiPage } from "../wiki";
import { sourceSha256 } from "../source-sha256";
import { serializeFrontmatter } from "../frontmatter";

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
