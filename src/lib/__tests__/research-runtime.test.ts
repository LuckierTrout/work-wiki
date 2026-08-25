/**
 * The Deep Research run: what a success writes, and what a failure or a cancel
 * must NOT write.
 *
 * The project store and the concurrency lease are REAL over a temp `DATA_DIR` —
 * status transitions and the three-slot ceiling are the behaviour under test.
 * Everything with a network or an LLM behind it is mocked, which is also what
 * lets each row say exactly which doors were opened: `writeWikiPageWithSideEffects`
 * for the Page, `saveRawSourceFor` + `createIngestJob` + `enqueueTask` for the
 * auto-Ingest, and — the point of the epic — `createMemoryChangeProposal` for
 * nothing at all.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("../research-providers", () => ({
  searchResearchProvider: vi.fn(),
  extractResearchSourceText: vi.fn(),
  resolveResearchProvider: vi.fn(() => "tavily"),
  selectResearchProvider: vi.fn(() => "tavily"),
  RESEARCH_SNIPPET_MAX: 4_000,
  // Declared in the factory rather than imported, since a `vi.mock` factory
  // cannot close over the module it replaces. The source narrows on `instanceof`
  // this class, so the mock has to BE the class the source sees.
  ResearchProviderUnconfiguredError: class extends Error {
    provider: string;
    constructor(provider: string) {
      super(`Deep Research is set to ${provider}, which has no credential.`);
      this.name = "ResearchProviderUnconfiguredError";
      this.provider = provider;
    }
  },
}));
vi.mock("../llm", () => ({
  callLLM: vi.fn(),
  callLLMStream: vi.fn(async () => {
    throw new Error("stream unavailable in unit tests");
  }),
  hasLLMKey: vi.fn(() => true),
}));
vi.mock("../lifecycle", () => ({ writeWikiPageWithSideEffects: vi.fn() }));
vi.mock("../raw", () => ({ saveRawSourceFor: vi.fn() }));
vi.mock("../ingest-jobs", () => ({
  createIngestJob: vi.fn(),
  createIngestJobIfAbsent: vi.fn(async (input: { jobId: string }) => ({
    job: input,
    created: true,
  })),
  getIngestJob: vi.fn(async () => null),
  updateIngestJob: vi.fn(async () => null),
}));
vi.mock("../tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tasks")>();
  return { ...actual, enqueueTask: vi.fn(async () => true) };
});
vi.mock("../schema", () => ({ loadPageConventions: vi.fn(async () => "") }));
vi.mock("../vault", () => ({ addToVault: vi.fn() }));
// The REAL `../wiki` with one function swapped: `research-projects` resolves its
// storage path through `tenantForOwner`/`validateTenant` from this same module,
// so replacing it wholesale would take the store down with it. Only the page
// index is under test here.
vi.mock("../wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../wiki")>();
  return { ...actual, listWikiPages: vi.fn(async () => [] as IndexEntry[]) };
});

import { createIngestJobIfAbsent } from "../ingest-jobs";
import { drainResearchOutbox, loadResearchOutbox, saveResearchOutbox } from "../research-completion";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { callLLM, callLLMStream } from "../llm";
import { _resetLocks } from "../lock";
import { saveRawSourceFor } from "../raw";
import {
  acquireResearchSlot,
  activeResearchCount,
  releaseResearchSlot,
  RESEARCH_SLOT_TTL_MS,
} from "../research-concurrency";
import {
  createResearchProject,
  deleteResearchProject,
  getResearchProject,
  listResearchProjects,
  mutateResearchProject,
  updateResearchProject,
} from "../research-projects";
import {
  extractResearchSourceText,
  searchResearchProvider,
  resolveResearchProvider,
  ResearchProviderUnconfiguredError,
} from "../research-providers";
import {
  RESEARCH_ABANDONED_AFTER_MS,
  RESEARCH_SOURCE_FETCH_MAX,
  cancelResearchProject,
  drainResearchQueue,
  queueResearchProject,
  reconcileResearchProjects,
  researchPageSlug,
  researchSourceSlug,
  retireResearchProject,
  runResearchProject,
} from "../research-runtime";
import { loadPageConventions } from "../schema";
import { _resetStorage, getStorage } from "../storage";
import { enqueueTask, parseTask } from "../tasks";
import type { IndexEntry } from "../types";
import { addToVault } from "../vault";
import { listWikiPages } from "../wiki";

const mockedSearch = vi.mocked(searchResearchProvider);
const mockedExtract = vi.mocked(extractResearchSourceText);
const mockedResolve = vi.mocked(resolveResearchProvider);
const mockedLLM = vi.mocked(callLLM);
const mockedStream = vi.mocked(callLLMStream);
const mockedWritePage = vi.mocked(writeWikiPageWithSideEffects);
const mockedSaveRaw = vi.mocked(saveRawSourceFor);
const mockedIngestJob = vi.mocked(createIngestJobIfAbsent);
const mockedEnqueue = vi.mocked(enqueueTask);
const mockedVault = vi.mocked(addToVault);
const mockedPages = vi.mocked(listWikiPages);
const mockedConventions = vi.mocked(loadPageConventions);

/** One index entry, owned unless told otherwise. */
function entry(title: string, extra?: Partial<IndexEntry>): IndexEntry {
  return {
    slug: title.toLowerCase().replace(/\s+/g, "-"),
    title,
    summary: "",
    owner: "alice",
    ...extra,
  };
}

let tmpDir: string;
let originalDataDir: string | undefined;

/** A project ready to run, with one query. */
async function project(extra?: Record<string, unknown>) {
  return createResearchProject("alice", {
    title: "Launch evidence",
    question: "What supports the launch date?",
    queries: ["launch evidence"],
    ...extra,
  });
}

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-runtime-"));
  originalDataDir = process.env.DATA_DIR;
  process.env.DATA_DIR = tmpDir;
  _resetLocks();
  _resetStorage();
  vi.clearAllMocks();
  mockedResolve.mockReturnValue("tavily");
  mockedEnqueue.mockResolvedValue(true);
  mockedStream.mockRejectedValue(new Error("stream unavailable in unit tests"));
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
  mockedSaveRaw.mockReset();
  mockedSaveRaw.mockImplementation(async (slug, sha, content) => {
    const rel = `raw/sources/${slug}/${sha}.md`;
    await getStorage().writeFile(rel, content);
    return rel;
  });
  mockedSearch.mockResolvedValue([
    {
      title: "Launch brief",
      url: "https://example.com/launch/brief",
      snippet: "short excerpt",
      content: "THE WHOLE PAGE BODY, well past any snippet cap.",
    },
  ]);
  mockedLLM.mockResolvedValue("# Launch evidence\n\nA brief.");
  mockedPages.mockResolvedValue([]);
  mockedConventions.mockResolvedValue("");
});

afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("deep research run — success", () => {
  it("writes the Page, stores each fetched body as a Source and queues its Ingest", async () => {
    const created = await project({ vaultId: "alice--launch" });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(finished.synthesis).toContain("# Launch evidence");
    // ONE Page, through the lifecycle writer — not a second Page writer, and
    // not a memory proposal. The stable project suffix prevents title collisions.
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    const pageSlug = researchPageSlug({ title: created.title, id: created.id });
    expect(mockedWritePage.mock.calls[0][0]).toMatchObject({
      slug: pageSlug,
      title: "Launch evidence",
    });
    // The Page slug is recorded on the project, so the panel can open it.
    expect(finished.pageSlugs).toContain(pageSlug);
    // AUTO-INGEST: the fetched body is a Source, and the Source has a job.
    expect(mockedSaveRaw).toHaveBeenCalledTimes(1);
    expect(mockedSaveRaw.mock.calls[0][0]).toBe(researchSourceSlug("https://example.com/launch/brief"));
    expect(mockedIngestJob).toHaveBeenCalledTimes(1);
    expect(mockedIngestJob.mock.calls[0][0]).toMatchObject({
      owner: "alice",
      url: "https://example.com/launch/brief",
      sourceType: "url",
      wikiId: "alice--launch",
    });
    expect(mockedIngestJob.mock.calls[0][0].jobId).toMatch(/^[a-z0-9]{64}$/);
    const ingestTask = mockedEnqueue.mock.calls
      .map(([task]) => task)
      .find((task) => task.kind === "ingest");
    expect(ingestTask).toBeDefined();
    expect(ingestTask).toMatchObject({ tags: ["research", "wiki:alice--launch"] });
    // NO VAULT, either as a task field or as a call. `project.vaultId` is the
    // Workbench WIKI id (a registry UUID); `addToVault` and the ingest task's
    // `vaultId` both want a Knowledge Studio id (`tenant--name`). Passing one as
    // the other was a filing step that silently did nothing, every time.
    expect(ingestTask).not.toHaveProperty("vaultId");
    expect(mockedVault).not.toHaveBeenCalled();
    expect(String(mockedWritePage.mock.calls[0][0].content)).toMatch(/wiki:\s*alice--launch/);
  });

  it("keeps the confirm's wiki on the project without treating it as a vault", async () => {
    // The wiki id is still recorded — that is what says WHERE the confirm came
    // from — it just is not handed to the vault door.
    const created = await project({ vaultId: "6f1b7e10-0000-4000-8000-000000000000" });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.vaultId).toBe("6f1b7e10-0000-4000-8000-000000000000");
    expect(mockedVault).not.toHaveBeenCalled();
  });

  it("synthesizes from the FULL source text, never the persisted snippet", async () => {
    // The bug this epic fixes: a brief written from a 4 000-character search
    // snippet is a brief about each page's opening paragraph.
    const created = await project();

    await runResearchProject("alice", created.id);

    const [, userPrompt] = mockedLLM.mock.calls[0];
    expect(userPrompt).toContain("THE WHOLE PAGE BODY");
    const stored = await getResearchProject("alice", created.id);
    // …while the PERSISTED result keeps the bounded excerpt: full page bodies
    // in the registry JSON would balloon a file every list call reads.
    expect(stored?.results?.[0].snippet).toBe("short excerpt");
    expect(JSON.stringify(stored)).not.toContain("THE WHOLE PAGE BODY");
  });

  it("extracts through the kernel clip path when the provider returned no body", async () => {
    // SerpApi and SearXNG return snippets only. Extraction must not need a
    // Tavily key — it is the wiki's own readability path.
    mockedSearch.mockResolvedValue([
      { title: "Snippet only", url: "https://example.com/a", snippet: "just a blurb" },
    ]);
    mockedExtract.mockResolvedValue({ title: "Real title", content: "EXTRACTED BODY" });
    const created = await project();

    await runResearchProject("alice", created.id);

    expect(mockedExtract).toHaveBeenCalledWith("https://example.com/a");
    expect(mockedLLM.mock.calls[0][1]).toContain("EXTRACTED BODY");
    expect(mockedSaveRaw.mock.calls[0][2]).toBe("EXTRACTED BODY");
  });

  it("skips one dead URL and keeps the run going", async () => {
    mockedSearch.mockResolvedValue([
      { title: "Dead", url: "https://example.com/dead", snippet: "x" },
      { title: "Alive", url: "https://example.com/alive", snippet: "y" },
    ]);
    mockedExtract.mockImplementation(async (url: string) =>
      url.includes("dead") ? null : { title: "Alive", content: "ALIVE BODY" });
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedSaveRaw).toHaveBeenCalledTimes(1);
    // The skip is reported as PROGRESS, not as thinking — see the thinking
    // describe below.
    expect(mockedSaveRaw.mock.calls[0][2]).toBe("ALIVE BODY");
  });

  it("counts the source it is reading, once, in both the sentence and the counter", async () => {
    // `researchTaskLine` renders the message and the counters together, so a
    // counter one behind the sentence read as "Reading source 2 of 2 (1 of 2)".
    mockedSearch.mockResolvedValue([
      { title: "One", url: "https://example.com/1", snippet: "s" },
      { title: "Two", url: "https://example.com/2", snippet: "s" },
    ]);
    const seen: Array<{ completed: number; total: number; message: string }> = [];
    mockedExtract.mockImplementation(async () => {
      const progress = (await getResearchProject("alice", created.id))?.progress;
      if (progress) {
        seen.push({
          completed: progress.completedQueries,
          total: progress.totalQueries,
          message: progress.message,
        });
      }
      return { title: "Body", content: "BODY" };
    });
    const created = await project();

    await runResearchProject("alice", created.id);

    expect(seen).toEqual([
      { completed: 1, total: 2, message: "Reading source 1 of 2." },
      { completed: 2, total: 2, message: "Reading source 2 of 2." },
    ]);
  });

  it("bounds how many result URLs one run reads", async () => {
    mockedSearch.mockResolvedValue(
      Array.from({ length: 20 }, (_, i) => ({
        title: `Result ${i}`,
        url: `https://example.com/r${i}`,
        snippet: "s",
        content: `BODY ${i}`,
      })),
    );
    const created = await project();

    await runResearchProject("alice", created.id);

    expect(mockedSaveRaw).toHaveBeenCalledTimes(RESEARCH_SOURCE_FETCH_MAX);
  }, 15_000);

  it("balances the fetch budget across every query", async () => {
    mockedSearch.mockImplementation(async (_provider, query) =>
      Array.from({ length: 8 }, (_, index) => ({
        title: `${query} result ${index}`,
        url: `https://example.com/${query}/${index}`,
        snippet: "s",
        content: `${query.toUpperCase()} BODY ${index}`,
      })));
    const created = await project({ queries: ["first", "second"] });

    await runResearchProject("alice", created.id);

    const savedSlugs = mockedSaveRaw.mock.calls.map(([slug]) => slug);
    expect(savedSlugs).toHaveLength(RESEARCH_SOURCE_FETCH_MAX);
    expect(savedSlugs.some((slug) => slug.includes("first"))).toBe(true);
    expect(savedSlugs.some((slug) => slug.includes("second"))).toBe(true);
  }, 15_000);

  it("condenses every chunk when evidence is too large for one synthesis prompt", async () => {
    const large = `BEGIN-${"x".repeat(600_000)}-END`;
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: large,
    }]);
    mockedLLM.mockImplementation(async (system) =>
      system.startsWith("Extract only evidence")
        ? "condensed evidence"
        : "# Launch evidence\n\nA brief.");
    const created = await project();

    await runResearchProject("alice", created.id);

    const mapCalls = mockedLLM.mock.calls.filter(([, , options]) =>
      options?.maxOutputTokens === 1_500);
    expect(mapCalls.length).toBeGreaterThan(1);
    const mapPrompts = mapCalls.map(([, prompt]) => prompt);
    expect(mapPrompts.join("")).toContain("BEGIN-");
    expect(mapPrompts.join("")).toContain("-END");
    expect(mockedLLM.mock.calls.at(-1)?.[1]).toContain("condensed evidence");
    expect(mockedLLM.mock.calls.at(-1)?.[1].length).toBeLessThanOrEqual(101_000);
  });

  it("stops chunk reduction before another paid call after cancellation", async () => {
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: `BEGIN-${"x".repeat(300_000)}-END`,
    }]);
    const created = await project();
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) {
        await cancelResearchProject("alice", created.id);
        return "first condensed part";
      }
      return "# Launch evidence\n\nA brief.";
    });

    const stopped = await runResearchProject("alice", created.id);

    expect(stopped.status).toBe("cancelled");
    expect(mockedLLM).toHaveBeenCalledTimes(1);
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("gives its slot back", async () => {
    const created = await project();
    await runResearchProject("alice", created.id);
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("never routes success through memory-proposals", async () => {
    // A static read, because the point is that the module does not IMPORT the
    // legacy door at all — a mock-call assertion would pass on a build that
    // still reached it through a dynamic import.
    const source = await fs.readFile(
      path.join(process.cwd(), "src/lib/research-runtime.ts"),
      "utf-8",
    );
    // The docblock still NAMES the old door, because "this used to file a
    // proposal" is the fact a reader needs. What must be gone is the import and
    // the call.
    expect(source).not.toMatch(/from "\.\/memory-proposals"/);
    expect(source).not.toMatch(/import\(["']\.\/memory-proposals["']\)/);
    expect(source).not.toMatch(/createMemoryChangeProposal\s*\(/);
  });

  it("never takes the AD-9 ingest compile lock", async () => {
    // `withDurableLock("ingest-llm:…")` is one-compile-per-owner and belongs to
    // `ingest()`. A collecting research run holding it would serialise research
    // behind ingest and ingest behind research — the spec's "both may proceed".
    // The research SLOT is the lease this module takes instead, and a static
    // read is the right tool: the claim is about which lock is reachable at all.
    const source = await fs.readFile(
      path.join(process.cwd(), "src/lib/research-runtime.ts"),
      "utf-8",
    );
    // Comments stripped first: the docblock NAMES the lock, because "research
    // does not take this one" is the fact a reader needs. What must be gone is
    // the import and the call.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toContain("withDurableLock");
    expect(code).not.toContain('from "./lock"');
    expect(code).toContain("acquireResearchSlot(");
  });
});

describe("deep research run — failure and cancellation", () => {
  it("writes no Page and queues no Ingest when synthesis returns nothing", async () => {
    mockedLLM.mockResolvedValue("   ");
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/no content/i);

    const stored = await getResearchProject("alice", created.id);
    expect(stored?.status).toBe("failed");
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedSaveRaw).not.toHaveBeenCalled();
    expect(mockedIngestJob).not.toHaveBeenCalled();
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("fails visibly when no result could be read", async () => {
    mockedSearch.mockResolvedValue([
      { title: "Dead", url: "https://example.com/dead", snippet: "x" },
    ]);
    mockedExtract.mockResolvedValue(null);
    const created = await project();

    await expect(runResearchProject("alice", created.id))
      .rejects.toThrow(/none of the search results could be read/i);
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("fails the run — not the queue — when the selected provider has no credential", async () => {
    // Refused BEFORE a slot is taken: a run that cannot search should not
    // consume one of three.
    mockedResolve.mockImplementation(() => {
      throw new Error("Deep Research is set to Tavily, which has no credential.");
    });
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("failed");
    expect(finished.error).toMatch(/no credential/);
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("releases a slot preclaimed by the dispatcher when provider resolution fails", async () => {
    const created = await project();
    await acquireResearchSlot("alice", created.id);
    mockedResolve.mockImplementation(() => {
      throw new Error("Deep Research provider override is invalid.");
    });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("failed");
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("stops before the Page write when a cancel lands during collection", async () => {
    const created = await project();
    // The cancel arrives while the provider is answering the first query.
    mockedSearch.mockImplementation(async () => {
      await updateResearchProject("alice", created.id, { cancelRequested: true });
      return [{ title: "T", url: "https://example.com/x", snippet: "s", content: "BODY" }];
    });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("cancelled");
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedIngestJob).not.toHaveBeenCalled();
    // A cancel must not leak the slot it held.
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("cancels a queued project immediately and never starts it", async () => {
    const created = await project();
    await queueResearchProject("alice", created.id);

    const cancelled = await cancelResearchProject("alice", created.id);

    expect(cancelled.status).toBe("cancelled");
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("records a missing credential on the project AND rethrows for the door", async () => {
    // Both, deliberately. The throw is what the run route turns into a 400 the
    // owner hears on the confirm they just made; the write is what the Research
    // Panel reads, so the row says why instead of sitting at `draft` forever —
    // the Epic 5 wart this epic removes.
    const created = await project();
    mockedResolve.mockImplementation(() => {
      throw new ResearchProviderUnconfiguredError("tavily");
    });

    await expect(queueResearchProject("alice", created.id)).rejects.toThrow(/no credential/);

    const stored = await getResearchProject("alice", created.id);
    expect(stored?.status).toBe("failed");
    expect(stored?.error).toMatch(/no credential/);
    expect(mockedSearch).not.toHaveBeenCalled();
    // A refused start holds no slot.
    expect(await activeResearchCount("alice")).toBe(0);
  });
});

describe("deep research run — the three-slot ceiling", () => {
  it("leaves the fourth start queued and visibly waiting", async () => {
    await acquireResearchSlot("alice", "other-1");
    await acquireResearchSlot("alice", "other-2");
    await acquireResearchSlot("alice", "other-3");
    const created = await project();

    const waiting = await runResearchProject("alice", created.id);

    // QUEUED, not failed and not dropped — and the message says what it is
    // waiting behind.
    expect(waiting.status).toBe("queued");
    expect(waiting.progress?.message).toMatch(/free research slot \(3 of 3 running\)/);
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("hands the freed slot to the oldest waiting project", async () => {
    // Two waiting projects; the run that releases a slot wakes the one that has
    // waited longest, rather than leaving both queued until someone clicks.
    const older = await project({ title: "Older" });
    await queueResearchProject("alice", older.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await project({ title: "Newer" });
    await queueResearchProject("alice", newer.id);

    const running = await project({ title: "Running" });
    await runResearchProject("alice", running.id);

    // Dispatch, not execution: the drain enqueues the next `run-research`.
    const drained = mockedEnqueue.mock.calls
      .map(([task]) => task)
      .filter((task): task is { kind: "run-research"; projectId: string; owner: string } =>
        task.kind === "run-research");
    expect(drained.map((task) => task.projectId)).toEqual([older.id]);
  });
});

describe("deep research — one run per project", () => {
  // Queue redelivery, `drainResearchQueue`, and the panel's poll can each
  // deliver a start for a project that is already going. Every one of them used
  // to re-search, re-fetch, re-synthesise and overwrite the Page.
  it.each(["collecting", "ready"] as const)(
    "refuses to re-enter a %s project and writes nothing",
    async (status) => {
      const created = await project();
      await updateResearchProject("alice", created.id, { status });

      const same = await runResearchProject("alice", created.id);

      expect(same.status).toBe(status);
      expect(mockedSearch).not.toHaveBeenCalled();
      expect(mockedLLM).not.toHaveBeenCalled();
      expect(mockedWritePage).not.toHaveBeenCalled();
    },
  );

  it("does not run a project that already finished", async () => {
    const created = await project();
    await runResearchProject("alice", created.id);
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    mockedSearch.mockClear();

    // A redelivered task for a finished run: the Page exists, and a second pass
    // would overwrite it from a fresh set of search results.
    const again = await runResearchProject("alice", created.id);

    expect(again.status).toBe("complete");
    expect(mockedSearch).not.toHaveBeenCalled();
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
  });

  it.each(["collecting", "ready"] as const)(
    "refuses to queue a %s project as already running",
    async (status) => {
      const created = await project();
      await updateResearchProject("alice", created.id, { status });

      await expect(queueResearchProject("alice", created.id)).rejects.toThrow(/already running/i);
    },
  );

  it("queues a finished project again, because that is an explicit new start", async () => {
    // `complete` is deliberately NOT refused: the only caller is the owner's own
    // `POST /run`, and re-researching a topic is a thing an owner may want.
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "complete" });

    const queued = await queueResearchProject("alice", created.id);

    expect(queued.status).toBe("queued");
  });

  it("reruns a completed project with the same Page identity", async () => {
    const created = await project();
    const first = await runResearchProject("alice", created.id);
    const firstSlug = first.pageSlugs[0];

    await queueResearchProject("alice", created.id);
    const second = await runResearchProject("alice", created.id);

    expect(second.status).toBe("complete");
    expect(second.pageSlugs).toContain(firstSlug);
    expect(new Set(second.pageSlugs)).toEqual(new Set([firstSlug]));
    expect(mockedWritePage).toHaveBeenCalledTimes(2);
  });

  it("gives same-title projects distinct stable Page identities", async () => {
    const first = await project();
    const second = await project();

    expect(researchPageSlug(first)).not.toBe(researchPageSlug(second));
    expect(researchPageSlug(first)).toBe(researchPageSlug(first));
  });

  it("dispatches a queued project once, however many times it is drained", async () => {
    // The panel polls every few seconds and each poll drains. The claim used to
    // be released immediately, so every poll during one queue delivery produced
    // another `run-research` task for the same project.
    const created = await project();
    await queueResearchProject("alice", created.id);
    mockedEnqueue.mockClear();

    await drainResearchQueue("alice");
    await drainResearchQueue("alice");
    await drainResearchQueue("alice");

    const dispatched = mockedEnqueue.mock.calls
      .map(([task]) => task)
      .filter((task) => task.kind === "run-research");
    expect(dispatched).toHaveLength(1);
    // The claim is the slot, and it is still held for the run that is coming.
    expect(await activeResearchCount("alice")).toBe(1);
  });

  it.each(["collecting", "ready"] as const)("never dispatches a %s project", async (status) => {
    const created = await project();
    await updateResearchProject("alice", created.id, { status });
    mockedEnqueue.mockClear();

    await drainResearchQueue("alice");

    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("moves past a claimed waiter to the next one", async () => {
    // A claimed head must not block the queue behind it.
    const older = await project({ title: "Older" });
    await queueResearchProject("alice", older.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await project({ title: "Newer" });
    await queueResearchProject("alice", newer.id);
    mockedEnqueue.mockClear();

    await drainResearchQueue("alice");
    await drainResearchQueue("alice");

    const dispatched = mockedEnqueue.mock.calls
      .map(([task]) => task)
      .filter((task): task is { kind: "run-research"; projectId: string; owner: string } =>
        task.kind === "run-research")
      .map((task) => task.projectId);
    expect(dispatched).toEqual([older.id, newer.id]);
  });

  it("gives the claim back when the dispatch itself fails", async () => {
    // Otherwise the project holds a slot nothing will ever renew, and the
    // workspace runs one short until the TTL.
    const created = await project();
    await queueResearchProject("alice", created.id);
    mockedEnqueue.mockRejectedValue(new Error("queue unreachable"));

    await drainResearchQueue("alice");

    expect(await activeResearchCount("alice")).toBe(0);
  });
});

describe("deep research — thinking is the model's, progress is the kernel's", () => {
  it("stores no thinking for a run whose model emitted none", async () => {
    // Which is the common case, and the reason the panel's thinking chrome used
    // to appear on every single run — over the kernel's own bookkeeping.
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.thinking).toBeUndefined();
    // The narration is still there. It is progress, where it belongs.
    expect(finished.progress?.message).toMatch(/Wrote research-launch-evidence/);
  });

  it("persists thinking while the synthesis stream is still open", async () => {
    mockedStream.mockResolvedValue({
      textStream: (async function* () {
        yield "<thinking>step one\n";
        yield "step two</thinking>\n# Launch evidence\n\nA brief.";
      })(),
      text: Promise.resolve("<thinking>step one\nstep two</thinking>\n# Launch evidence\n\nA brief."),
    } as unknown as Awaited<ReturnType<typeof callLLMStream>>);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.thinking).toEqual(["step one", "step two"]);
    expect(mockedLLM).not.toHaveBeenCalled();
    expect(mockedWritePage.mock.calls[0][0].content).not.toContain("step one");
  });

  it("keeps a model's think-tokens off the Page and on the project", async () => {
    mockedLLM.mockResolvedValue(
      "<thinking>Weighing two dates.</thinking>\n# Launch evidence\n\nA brief.",
    );
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.thinking).toEqual(["Weighing two dates."]);
    // Never published: not in the body, and not in the stored synthesis.
    expect(mockedWritePage.mock.calls[0][0].content).not.toContain("Weighing two dates");
    expect(finished.synthesis).not.toContain("Weighing two dates");
    expect(finished.synthesis).toContain("# Launch evidence");
  });
});

describe("deep research — what synthesis is told", () => {
  it("offers only this owner's page titles as wikilink targets", async () => {
    // An unfiltered `listWikiPages()` handed every owner's page TITLES to the
    // model as link targets on any deployment holding more than one.
    mockedPages.mockResolvedValue([
      entry("Launch plan"),
      entry("Bob private thing", { owner: "bob" }),
      entry("Nameless legacy page", { owner: undefined }),
      entry("Agent brain", { type: "agent-knowledge" }),
    ]);
    const created = await project();

    await runResearchProject("alice", created.id);

    const [systemPrompt] = mockedLLM.mock.calls[0];
    expect(systemPrompt).toContain("Launch plan");
    expect(systemPrompt).not.toContain("Bob private thing");
    // Fail closed on an unowned entry, and leave agent-scoped pages out.
    expect(systemPrompt).not.toContain("Nameless legacy page");
    expect(systemPrompt).not.toContain("Agent brain");
  });

  it("carries the page conventions when the schema has any", async () => {
    mockedConventions.mockResolvedValue("Every page opens with one H1.");
    const created = await project();

    await runResearchProject("alice", created.id);

    expect(mockedLLM.mock.calls[0][0]).toContain("Every page opens with one H1.");
  });
});

describe("deep research — an interrupted run gets an answer", () => {
  it("fails a queued waiter visibly when the lease file is malformed", async () => {
    const created = await project();
    await queueResearchProject("alice", created.id);
    const leasePath = path.join(tmpDir, "tenants", "alice", "research-leases.json");
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(leasePath, "{ malformed", "utf-8");

    await drainResearchQueue("alice");

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/lease file is unreadable/i);
    expect(failed?.progress?.message).toMatch(/repair the lease state/i);
  });

  // `shouldAdvanceTime` so the clock can jump past the abandonment window
  // without freezing the real timers that `withFileLock` and the fs writes
  // below still need.
  beforeEach(() => void vi.useFakeTimers({ shouldAdvanceTime: true }));
  afterEach(() => void vi.useRealTimers());

  it("fails a `collecting` project whose worker died, and says it is retryable", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "collecting" });
    // No slot held (the isolate is gone and the TTL reaped it) and the record
    // untouched for longer than a full TTL: the two conditions together.
    vi.setSystemTime(new Date(Date.now() + RESEARCH_ABANDONED_AFTER_MS + 1_000));

    const [reconciled] = await reconcileResearchProjects(
      "alice",
      await listResearchProjects("alice"),
    );

    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toMatch(/stopped before it finished/i);
    // Nothing was re-run behind the owner's back.
    expect(mockedSearch).not.toHaveBeenCalled();
  });

  it("fails a `ready` project whose worker died during synthesis", async () => {
    // `ready` is a real phase a worker can die in — it is the LLM call — and
    // checking only `collecting` left such a row reading "Synthesizing" forever
    // with nothing synthesising.
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "ready" });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_ABANDONED_AFTER_MS + 1_000));

    const [reconciled] = await reconcileResearchProjects(
      "alice",
      await listResearchProjects("alice"),
    );

    expect(reconciled.status).toBe("failed");
    expect(reconciled.error).toMatch(/stopped before it finished/i);
  });

  it("skips a row whose updatedAt cannot be parsed instead of failing it", async () => {
    // `Date.parse` of nonsense is `NaN`, and every `NaN` comparison is false —
    // so the age guard waved the row straight through to `failed`. A record this
    // cannot read is one it must not judge.
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "collecting" });
    const projects = await listResearchProjects("alice");
    const damaged = [{ ...projects[0], updatedAt: "not a date" }];

    const [reconciled] = await reconcileResearchProjects("alice", damaged);

    expect(reconciled.status).toBe("collecting");
    expect((await getResearchProject("alice", created.id))?.status).toBe("collecting");
  });

  it("leaves a long run that still holds its lease alone", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "collecting" });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_ABANDONED_AFTER_MS + 1_000));
    // Cold record, live lease: a multi-query run that has been going a while.
    // Holding the lease is proof the run exists, whatever the record's age.
    await acquireResearchSlot("alice", created.id);

    const [reconciled] = await reconcileResearchProjects(
      "alice",
      await listResearchProjects("alice"),
    );

    expect(reconciled.status).toBe("collecting");
  });

  it("waits a second lease lifetime before calling a lease-less run dead", async () => {
    // The lease is gone but only one TTL has passed, which is also what a live
    // run that never renewed looks like. Not conclusive yet, so: hands off.
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "collecting" });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));

    const [reconciled] = await reconcileResearchProjects(
      "alice",
      await listResearchProjects("alice"),
    );

    expect(reconciled.status).toBe("collecting");
  });

  it("re-dispatches a queued project whose wake-up was lost", async () => {
    // The drain that should have woken it never ran, because the run holding the
    // slot died instead of releasing. The panel's next poll is the retry.
    const created = await project();
    await queueResearchProject("alice", created.id);
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: created.id }),
    );
  });

  it("does not re-dispatch when the workspace is already at its ceiling", async () => {
    await acquireResearchSlot("alice", "other-1");
    await acquireResearchSlot("alice", "other-2");
    await acquireResearchSlot("alice", "other-3");
    const created = await project();
    await queueResearchProject("alice", created.id);
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(mockedEnqueue).not.toHaveBeenCalled();
  });
});

describe("deep research — remediations", () => {
  it("executes a create → queue → parseTask → run delivery once", async () => {
    const created = await project();
    const queued = await queueResearchProject("alice", created.id);
    expect(parseTask({
      kind: "run-research",
      projectId: queued.id,
      owner: "alice",
    })).toEqual({ kind: "run-research", projectId: queued.id, owner: "alice" });

    const finished = await runResearchProject("alice", queued.id);

    expect(finished.status).toBe("complete");
    expect(mockedSearch).toHaveBeenCalledTimes(1);
  });

  it("lets only one of two concurrent deliveries search", async () => {
    const created = await project();
    await queueResearchProject("alice", created.id);

    await Promise.all([
      runResearchProject("alice", created.id),
      runResearchProject("alice", created.id),
    ]);

    expect(mockedSearch).toHaveBeenCalledTimes(1);
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect((await getResearchProject("alice", created.id))?.status).toBe("complete");
  });

  it("does not release a ready run's slot when cancel lands during synthesis", async () => {
    const created = await project();
    mockedLLM.mockImplementation(async () => {
      const cancelled = await cancelResearchProject("alice", created.id);
      expect(cancelled.status).toBe("ready");
      expect(cancelled.cancelRequested).toBe(true);
      expect(await activeResearchCount("alice")).toBe(1);
      return "# Launch evidence\n\nA brief.";
    });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("cancelled");
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("keeps a collecting worker's lease until that worker exits", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "collecting" });
    await acquireResearchSlot("alice", created.id);

    expect(await retireResearchProject("alice", created.id)).toBe(true);
    expect(await getResearchProject("alice", created.id)).toBeNull();
    expect(await activeResearchCount("alice")).toBe(1);
    await releaseResearchSlot("alice", created.id);
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("keeps the Page and reports pending Source promotion after a storage failure", async () => {
    mockedSaveRaw.mockRejectedValue(new Error("disk full"));
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(finished.status).toBe("complete");
    expect(finished.completion?.phase).toBe("sources");
    expect(finished.error).toMatch(/did not ingest|Page was written/);
  });

  it("does not claim the Page was written when the lifecycle writer fails", async () => {
    mockedWritePage.mockRejectedValueOnce(new Error("registry down"));
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/registry down/);

    const stored = await getResearchProject("alice", created.id);
    expect(stored?.completion?.phase).toBe("page");
    expect(stored?.progress?.message).toMatch(/resume the write|Nothing was written|before the Page landed/);
    expect(stored?.progress?.message).not.toMatch(/The Page was written/);
  });

  it("resumes the Page write from a discoverable phase-page completion", async () => {
    mockedWritePage.mockRejectedValueOnce(new Error("registry down"));
    const created = await project();
    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/registry down/);

    const recovered = await drainResearchOutbox("alice", created.id);

    expect(mockedWritePage).toHaveBeenCalledTimes(2);
    expect(recovered?.status).toBe("complete");
    expect(recovered?.completion?.phase).toBe("done");
    expect(recovered?.error).toBeUndefined();
  });

  it("reconcile deletes a finished row that DELETE could not remove mid-write", async () => {
    const created = await project();
    await runResearchProject("alice", created.id);
    await mutateResearchProject("alice", created.id, (project) => {
      project.deleteRequested = true;
      return project;
    });

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", created.id)).toBeNull();
  });

  it("does not rewrite a completed project when leftover outbox is only cleanup", async () => {
    const created = await project();
    const finished = await runResearchProject("alice", created.id);
    expect(finished.completion?.phase).toBe("done");
    const before = await getResearchProject("alice", created.id);
    await saveResearchOutbox("alice", created.id, {
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
    });
    mockedWritePage.mockClear();
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect((await getResearchProject("alice", created.id))?.updatedAt).toBe(before?.updatedAt);
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedEnqueue).not.toHaveBeenCalled();
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });

  it("reconcile drains an orphan outbox after the project row is gone", async () => {
    const created = await project();
    await saveResearchOutbox("alice", created.id, {
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
    });
    expect(await deleteResearchProject("alice", created.id)).toBe(true);
    mockedWritePage.mockClear();
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(mockedEnqueue).toHaveBeenCalledWith(expect.objectContaining({ kind: "ingest" }));
    expect(await loadResearchOutbox("alice", created.id)).toBeNull();
  });

  it("reconcile drains an outbox even when the project has no completion pointer", async () => {
    const created = await project();
    await saveResearchOutbox("alice", created.id, {
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
    });

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect((await getResearchProject("alice", created.id))?.status).toBe("complete");
  });

  it("resolves the current Settings provider on retry, not a stale project pin", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, { provider: "serpapi", status: "failed" });
    mockedResolve.mockReturnValue("tavily");

    const queued = await queueResearchProject("alice", created.id);

    expect(mockedResolve).toHaveBeenCalledWith();
    expect(queued.provider).toBe("tavily");
  });

  it("drops invented citation URLs before the Page is written", async () => {
    mockedLLM.mockResolvedValue(
      "# Launch evidence\n\nSee [ok](https://example.com/launch/brief) and [nope](https://evil.example/x).",
    );
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.synthesis).toContain("[ok](https://example.com/launch/brief)");
    expect(finished.synthesis).toContain("nope");
    expect(finished.synthesis).not.toContain("https://evil.example/x");
  });

  it.skipIf(!process.env.TAVILY_API_KEY)(
    "runs one live Tavily search when a key is present",
    async () => {
      const { searchResearchProvider } = await vi.importActual<
        typeof import("../research-providers")
      >("../research-providers");
      const results = await searchResearchProvider("tavily", "TypeScript", 1);
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].url).toMatch(/^https?:/);
    },
  );
});

describe("research slugs", () => {
  it("names the Page from the title and the Source from the URL", () => {
    // URL identity is what makes the SHA skip mean anything: a second run over
    // the same page writes the same Source slug instead of a duplicate.
    expect(researchPageSlug({ title: "Launch Evidence!", id: "abc" })).toMatch(/^research-launch-evidence-[0-9a-f]{8}$/);
    expect(researchSourceSlug("https://example.com/a/b")).toMatch(/^research-example-com-a-b$/);
    expect(researchSourceSlug("not a url")).toBeNull();
  });

  it("distinguishes two URLs that differ only in their query string", () => {
    // These used to collide, and because `saveRawSourceFor` is first-write-only
    // the SECOND document silently kept the FIRST one's body: two pages, one
    // Source, wrong bytes, no error. Most of the paginated and id-addressed web
    // lands here.
    const first = researchSourceSlug("https://example.com/a/b?q=1");
    const second = researchSourceSlug("https://example.com/a/b?q=2");
    expect(first).not.toBe(second);
    // Still derived from the URL, so a re-run of the SAME URL is the same slug —
    // which is what makes the SHA skip mean anything.
    expect(researchSourceSlug("https://example.com/a/b?q=1")).toBe(first);
    expect(first).toMatch(/^research-example-com-a-b-[0-9a-f]{8}$/);
    // A bare URL keeps the slug it has always had: every Source already stored
    // stays reachable, and re-research still hits its snapshot.
    expect(researchSourceSlug("https://example.com/a/b")).toBe("research-example-com-a-b");
    // A fragment addresses a position inside ONE document — same bytes, same
    // Source.
    expect(researchSourceSlug("https://example.com/a/b#top"))
      .toBe(researchSourceSlug("https://example.com/a/b"));
  });

  it("falls back to the project id when the title slugifies to nothing", () => {
    expect(researchPageSlug({ title: "!!!", id: "0123456789abcdef" })).toMatch(/^research-untitled-[0-9a-f]{8}$/);
  });
});
