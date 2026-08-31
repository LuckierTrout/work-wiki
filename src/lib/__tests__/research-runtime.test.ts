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
  updateIngestJobIf: vi.fn(async () => null),
}));
vi.mock("../tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../tasks")>();
  return { ...actual, enqueueTask: vi.fn(async () => true) };
});
vi.mock("../schema", () => ({ loadPageConventions: vi.fn(async () => "") }));
// Only the deadline READING is faked (DW-544). `importOriginal` keeps the rest
// of `config` real — the store and the lease reach through this module too —
// and the default is `null`, this repo's default and the state every row in
// this suite ran under before DW-544.
vi.mock("../config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config")>()),
  getLlmTimeoutMs: vi.fn(() => null),
}));
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
import { getLlmTimeoutMs } from "../config";
import { callLLM, callLLMStream } from "../llm";
import {
  LLM_DEADLINE_RESEARCH_COPY,
  LLM_LENGTH_CAP_COPY,
  LLM_RESEARCH_LENGTH_CAP_COPY,
  LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
} from "../llm-deadline";
import { SETTINGS_LABEL, settingsPointer } from "../workbench-settings";
import { _resetLocks } from "../lock";
import { logger } from "../logger";
import * as projectsModule from "../research-projects";
import { saveRawSourceFor } from "../raw";
import {
  acquireResearchSlot,
  activeResearchCount,
  releaseResearchSlot,
  renewResearchSlot,
  rotateResearchSlot,
  RESEARCH_SLOT_TTL_MS,
} from "../research-concurrency";
import {
  createResearchProject,
  deleteResearchProject,
  getResearchProject,
  listResearchProjects,
  mutateResearchProject,
  ResearchProjectBusyError,
  ResearchProjectConflictError,
  ResearchProjectNotFoundError,
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
import { READ_ONLY_REFUSAL, ReadOnlyError, isReadOnlyError } from "../read-only";
import { loadPageConventions } from "../schema";
import { _resetStorage, getStorage } from "../storage";
import { enqueueTask, parseTask } from "../tasks";
import type { IndexEntry } from "../types";
import { addToVault } from "../vault";
import { listWikiPages, writeWikiPage } from "../wiki";

const mockedSearch = vi.mocked(searchResearchProvider);
const mockedExtract = vi.mocked(extractResearchSourceText);
const mockedResolve = vi.mocked(resolveResearchProvider);
const mockedLLM = vi.mocked(callLLM);
const mockedStream = vi.mocked(callLLMStream);
const mockedTimeout = vi.mocked(getLlmTimeoutMs);
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

/** A `text-delta` part, minus the fields the synthesis loop never reads. */
const delta = (text: string) => ({ type: "text-delta", id: "t0", text });

/**
 * Stand in for `StreamTextResult`, exposing the `fullStream` the synthesis loop
 * reads (DW-544) and the `text` it falls back to. `fullStream`, not
 * `textStream`: the abort and `error` parts a cut stream ends on exist only
 * there — `textStream` drops them, which is the bug DW-544 closed.
 */
function fakeStream(
  parts: (Record<string, unknown> | (() => unknown))[],
  text = "",
) {
  mockedStream.mockResolvedValue({
    fullStream: (async function* () {
      for (const part of parts) {
        // A FUNCTION entry is an event mid-stream rather than a part: it either
        // throws (a provider that died) or runs a side effect (the owner
        // pressing Cancel) at a precise point between two parts.
        if (typeof part === "function") await part();
        else yield part;
      }
    })(),
    text: Promise.resolve(text),
  } as unknown as Awaited<ReturnType<typeof callLLMStream>>);
}

/** A brief that satisfies the citation gate, so a commit is the only variable. */
const GOOD_BRIEF =
  "# Launch evidence\n\nA brief [from the source](https://example.com/launch/brief).";

/** An abort of exactly the flavour `AbortSignal.timeout()` produces. */
function abortError(name: "TimeoutError" | "AbortError"): Error {
  const error = new Error("The operation was aborted due to timeout");
  error.name = name;
  return error;
}

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
  // No deadline configured unless a row says otherwise.
  mockedTimeout.mockReturnValue(null);
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
  mockedLLM.mockImplementation(async (_system, user) => {
    const url = user.match(/(?:Exact )?URL: (https?:\/\/\S+)/)?.[1]
      ?? "https://example.com/launch/brief";
    return `# Launch evidence\n\nA brief [from the source](${url}).`;
  });
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
    expect(mockedSaveRaw.mock.calls[0][0]).toBe(await researchSourceSlug("https://example.com/launch/brief"));
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
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) {
        return `condensed evidence ${"m".repeat(24_000)}`;
      }
      if (system.startsWith("Reduce these evidence notes")) return "reduced evidence";
      return "# Launch evidence\n\nA brief [from the source](https://example.com/large).";
    });
    const created = await project();

    await runResearchProject("alice", created.id);

    const mapCalls = mockedLLM.mock.calls.filter(([system]) =>
      system.startsWith("Extract only evidence"));
    const reduceCalls = mockedLLM.mock.calls.filter(([system]) =>
      system.startsWith("Reduce these evidence notes"));
    expect(mapCalls.length).toBeGreaterThan(1);
    expect(reduceCalls.length).toBeGreaterThan(0);
    const mapPrompts = mapCalls.map(([, prompt]) => prompt);
    expect(mapPrompts.join("")).toContain("BEGIN-");
    expect(mapPrompts.join("")).toContain("-END");
    expect(reduceCalls.map(([, prompt]) => prompt).join("\n")).toContain("condensed evidence");
    expect(mockedLLM.mock.calls.at(-1)?.[1]).toContain("reduced evidence");
    expect(mockedLLM.mock.calls.at(-1)?.[1].length).toBeLessThanOrEqual(101_000);
  }, 15_000);

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

  it("fails visibly when hierarchical reduction makes no progress", async () => {
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: `BEGIN-${"x".repeat(500_000)}-END`,
    }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) return "m".repeat(30_000);
      if (system.startsWith("Reduce these evidence notes")) return "r".repeat(100_000);
      return "# should not synthesize";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id))
      .rejects.toThrow(/reduction did not converge/i);

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toMatch(/reduction did not converge/i);
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.startsWith("Reduce these evidence notes")).length).toBeLessThanOrEqual(8);
  });

  /**
   * DW-665. Condensation and hierarchical reduction call the LLM under the same
   * `llmTimeoutOption()` as synthesis, and their rejections travel straight to
   * `runResearchProject`'s catch, which writes the message onto `project.error`
   * — which `ResearchCanvas` renders verbatim. Unwrapped, a fired deadline
   * showed the owner the SDK's own "The operation was aborted due to timeout".
   *
   * Both sentences are true here even though neither mentions condensation: the
   * page write happens only after synthesis commits, so a run cut this early
   * has written nothing to the wiki, which is what they promise.
   */
  it("reports a deadline during evidence condensation as the gated sentence", async () => {
    mockedTimeout.mockReturnValue(30_000);
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: `BEGIN-${"x".repeat(600_000)}-END`,
    }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) throw abortError("TimeoutError");
      return "# should not synthesize";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_DEADLINE_RESEARCH_COPY,
    );

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_DEADLINE_RESEARCH_COPY);
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(failed?.error).not.toContain(word);
    }
    expect(mockedWritePage).not.toHaveBeenCalled();
  }, 15_000);

  it("reports a deadline during hierarchical reduction with no deadline set", async () => {
    // The ungated half, mirroring the synthesis fallback. Nothing the owner set
    // caused this, so the sentence names no field, and it names no limit for
    // them to go raise either. `null` is SET here rather than inherited from
    // the suite `beforeEach`: which sentence this row is about is the whole
    // point of it, and a changed default must not quietly reverse that.
    mockedTimeout.mockReturnValue(null);
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: `BEGIN-${"x".repeat(600_000)}-END`,
    }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) {
        return `condensed evidence ${"m".repeat(24_000)}`;
      }
      if (system.startsWith("Reduce these evidence notes")) throw abortError("TimeoutError");
      return "# should not synthesize";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    );

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError", "timeout"]) {
      expect(failed?.error).not.toContain(word);
    }
    expect(mockedWritePage).not.toHaveBeenCalled();
  }, 15_000);

  it("reports a run cancelled DURING a condensation call as cancelled, not failed", async () => {
    // The cancel window is the CALL, and `researchEvidenceForSynthesis` checks
    // only BEFORE each one. An owner who pressed Cancel while the model was
    // thinking, and whose deadline then fired on the way out, must not be
    // relabelled `failed` under a sentence about a timeout they did not cause —
    // the same guarantee the synthesis stream's early endings already carry.
    mockedTimeout.mockReturnValue(30_000);
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
        throw abortError("TimeoutError");
      }
      return "# should not synthesize";
    });

    const stopped = await runResearchProject("alice", created.id);

    expect(stopped.status).toBe("cancelled");
    const latest = await getResearchProject("alice", created.id);
    expect(latest?.status).toBe("cancelled");
    expect(latest?.error).not.toBe(LLM_DEADLINE_RESEARCH_COPY);
    expect(latest?.error).not.toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    expect(mockedWritePage).not.toHaveBeenCalled();
  }, 15_000);

  it("leaves a NON-deadline condensation failure carrying its own message", async () => {
    // THE BOUNDARY of the wrap. A provider fault is the diagnostic whoever
    // reads the failure needs; replacing it with "the model's response stopped"
    // would hide a broken provider behind a sentence about a timeout.
    mockedTimeout.mockReturnValue(30_000);
    mockedSearch.mockResolvedValue([{
      title: "Large source",
      url: "https://example.com/large",
      snippet: "s",
      content: `BEGIN-${"x".repeat(600_000)}-END`,
    }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.startsWith("Extract only evidence")) throw new Error("provider 500");
      return "# should not synthesize";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow("provider 500");

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe("provider 500");
    expect(mockedWritePage).not.toHaveBeenCalled();
  }, 15_000);

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

  it("writes no Page when synthesis cites none of the fetched source URLs", async () => {
    mockedLLM.mockResolvedValue("# Launch evidence\n\nFacts without evidence links.");
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/no citation/i);

    expect((await getResearchProject("alice", created.id))?.status).toBe("failed");
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedIngestJob).not.toHaveBeenCalled();
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
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, { runAttemptId: grant.attemptId });
    mockedResolve.mockImplementation(() => {
      throw new Error("Deep Research provider override is invalid.");
    });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("failed");
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("keeps the attempt fence when provider-failure lease cleanup cannot land", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, { runAttemptId: grant.attemptId });
    mockedResolve.mockImplementation(() => {
      throw new Error("Deep Research provider override is invalid.");
    });
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => target.endsWith("research-leases.json")
        ? false
        : originalMatch(target, content, etag),
    );

    const finished = await runResearchProject("alice", created.id);

    expect(finished).toMatchObject({
      status: "failed",
      runAttemptId: grant.attemptId,
    });
    expect(await activeResearchCount("alice")).toBe(1);
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

      const error = await queueResearchProject("alice", created.id).catch((e: unknown) => e);

      // BOTH halves are contract. The TYPE is what `POST /api/research/[id]/run`
      // classifies on (409); a throw site reverted to a plain `Error` would
      // degrade that to a 500 with the message assertion still green. The
      // MESSAGE stays asserted because it is echoed in the response body.
      expect(error).toBeInstanceOf(ResearchProjectConflictError);
      expect((error as Error).message).toMatch(/already running/i);
    },
  );

  /**
   * The other half of the runtime→route seam. The door decides 404 by
   * `instanceof ResearchProjectNotFoundError` alone, so an untyped throw here
   * silently becomes a 500 — and the route suite cannot catch that, because it
   * mocks this module wholesale. The message is asserted alongside the type
   * because `POST /api/tasks/run` still poisons a task by `/not found/i`.
   */
  it("throws a typed not-found from queue and from cancel, not a bare Error", async () => {
    const queued = await queueResearchProject("alice", "missing").catch((e: unknown) => e);
    expect(queued).toBeInstanceOf(ResearchProjectNotFoundError);
    expect((queued as Error).message).toMatch(/not found/i);

    const cancelled = await cancelResearchProject("alice", "missing").catch((e: unknown) => e);
    expect(cancelled).toBeInstanceOf(ResearchProjectNotFoundError);
    expect((cancelled as Error).message).toMatch(/not found/i);
  });

  /**
   * DW-651, the rest of that seam. Four more refusals in `queueResearchProject`
   * were plain `Error`, so `POST /api/research/[id]/run` answered 500 for all
   * of them — transient store contention reported as a permanent server fault
   * with no retry signal, and a completion mid-delivery reported the same way.
   * (The fifth, the RETIRED row, is pinned where the DELETE tombstone that
   * retains it is built — a draft with no live lease is deleted outright, so
   * `queueResearchProject` never reaches that line for one.) The route suite
   * mocks this module wholesale and so cannot see a revert to `new Error(...)`;
   * these rows can. Every MESSAGE is asserted beside its type because the
   * response body echoes it verbatim.
   */
  it("throws a typed conflict while a completion is still being delivered", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "failed",
      completion: { phase: "page", pageSlug: "research-launch-evidence", sources: [] },
    });

    const error = await queueResearchProject("alice", created.id).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ResearchProjectConflictError);
    expect((error as Error).message).toBe(
      "Research project completion is still being delivered",
    );
  });

  it("throws a typed conflict when the completion appears INSIDE the mutation", async () => {
    // The second copy of that refusal, in the `mutateResearchProjectOrRefusal`
    // mutator — reachable only when a completion lands between the read and the
    // compare-and-swap, which is what the stale read below stands in for.
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "failed",
      completion: { phase: "page", pageSlug: "research-launch-evidence", sources: [] },
    });
    const stored = await getResearchProject("alice", created.id);
    const stale = { ...stored! };
    delete stale.completion;
    const spy = vi
      .spyOn(projectsModule, "getResearchProject")
      .mockResolvedValue(stale);

    try {
      const error = await queueResearchProject("alice", created.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResearchProjectConflictError);
      expect((error as Error).message).toBe(
        "Research project completion is still being delivered",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("throws a typed busy error when the delivery-retry CAS is lost", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "failed",
      deliveryBlocked: true,
      completion: { phase: "page", pageSlug: "research-launch-evidence", sources: [] },
    });
    // The conditional update whose predicate another writer already broke.
    // `null`, NOT the read-only sentinel: that branch takes the
    // refusal-preserving sibling, so only a genuinely lost predicate is
    // contention (the refusal is pinned in `read-only-store-gate.test.ts`).
    const spy = vi
      .spyOn(projectsModule, "updateResearchProjectIfOrRefusal")
      .mockResolvedValue(null);

    try {
      const error = await queueResearchProject("alice", created.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResearchProjectBusyError);
      expect((error as Error).message).toBe(
        "Research project changed while delivery retry started",
      );
    } finally {
      spy.mockRestore();
    }
  });

  it("throws a typed busy error when the rerun baseline lost its race", async () => {
    // `current.updatedAt !== project.updatedAt` inside the mutator: the row
    // moved under the read that captured the baseline.
    const created = await project();
    const stored = await getResearchProject("alice", created.id);
    const spy = vi
      .spyOn(projectsModule, "getResearchProject")
      .mockResolvedValue({ ...stored!, updatedAt: "2020-01-01T00:00:00.000Z" });

    try {
      const error = await queueResearchProject("alice", created.id).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ResearchProjectBusyError);
      expect((error as Error).message).toBe(
        "Research project changed while the rerun baseline was captured; retry",
      );
    } finally {
      spy.mockRestore();
    }
  });

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
  }, 15_000);

  it("captures rerun Page bytes at queue time so a later owner edit wins", async () => {
    const created = await project();
    const first = await runResearchProject("alice", created.id);
    const slug = first.pageSlugs[0];
    const baseline = "---\ntitle: Launch evidence\n---\n\n# Original brief";
    await writeWikiPage(slug, baseline);

    await queueResearchProject("alice", created.id);
    await writeWikiPage(slug, `${baseline}\n\nOwner note.`);
    await runResearchProject("alice", created.id);

    expect(mockedWritePage.mock.calls.at(-1)?.[0]).toMatchObject({
      slug,
      expectedContent: baseline,
    });
  }, 15_000);

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
    fakeStream(
      [
        { type: "start" },
        delta("<thinking>step one\n"),
        delta(`step two</thinking>\n${GOOD_BRIEF}`),
        { type: "finish", finishReason: "stop" },
      ],
      `<thinking>step one\nstep two</thinking>\n${GOOD_BRIEF}`,
    );
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.thinking).toEqual(["step one", "step two"]);
    expect(mockedLLM).not.toHaveBeenCalled();
    expect(mockedWritePage.mock.calls[0][0].content).not.toContain("step one");
  });

  it("does not buy a second synthesis after a partial stream fails", async () => {
    fakeStream(
      [
        delta("# Partial"),
        () => {
          throw new Error("stream disconnected");
        },
      ],
      "# Partial",
    );
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/stream disconnected/i);

    expect(mockedLLM).not.toHaveBeenCalled();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("keeps a model's think-tokens off the Page and on the project", async () => {
    mockedLLM.mockResolvedValue(
      "<thinking>Weighing two dates.</thinking>\n# Launch evidence\n\nA brief [from the source](https://example.com/launch/brief).",
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

  it("does not rewrite a completed project when unrelated lease state is malformed", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "complete",
      completion: {
        phase: "done",
        pageSlug: "research-launch-evidence",
        sources: [],
      },
    });
    const leasePath = path.join(tmpDir, "tenants", "alice", "research-leases.json");
    await fs.mkdir(path.dirname(leasePath), { recursive: true });
    await fs.writeFile(leasePath, "{ malformed", "utf-8");
    const stored = await getResearchProject("alice", created.id);

    await reconcileResearchProjects("alice", [stored!]);

    expect((await getResearchProject("alice", created.id))?.status).toBe("complete");
  });

  it.each(["draft", "complete", "cancelled"] as const)(
    "does not rewrite a legacy %s project when unrelated lease state is malformed",
    async (status) => {
      const created = await project();
      await updateResearchProject("alice", created.id, { status, completion: null });
      const leasePath = path.join(tmpDir, "tenants", "alice", "research-leases.json");
      await fs.mkdir(path.dirname(leasePath), { recursive: true });
      await fs.writeFile(leasePath, "{ malformed", "utf-8");

      await reconcileResearchProjects("alice", await listResearchProjects("alice"));

      expect((await getResearchProject("alice", created.id))?.status).toBe(status);
    },
  );

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

  it("fails and releases the retained expired claim of an abandoned worker", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_ABANDONED_AFTER_MS + 1_000));

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect((await getResearchProject("alice", created.id))?.status).toBe("failed");
    expect(await activeResearchCount("alice")).toBe(0);
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

  it("retires an expired previous-release lease and dispatches its queued project", async () => {
    const created = await project();
    await queueResearchProject("alice", created.id);
    await getStorage().writeFile(
      "tenants/alice/research-leases.json",
      JSON.stringify([{
        projectId: created.id,
        acquiredAt: Date.now() - RESEARCH_SLOT_TTL_MS * 2,
        expiresAt: Date.now() - 1,
      }]),
    );
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: created.id }),
    );
    expect((await getResearchProject("alice", created.id))?.runAttemptId).toBeTruthy();
  });

  it("rotates and re-dispatches an expired queued reservation whose task was lost", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    await queueResearchProject("alice", created.id);
    await drainResearchQueue("alice");
    const reserved = await getResearchProject("alice", created.id);
    expect(reserved?.status).toBe("queued");
    expect(reserved?.runAttemptId).toBeTruthy();
    const firstAttempt = reserved!.runAttemptId;
    mockedEnqueue.mockClear();
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    const recovered = await getResearchProject("alice", created.id);
    expect(recovered?.runAttemptId).toBeTruthy();
    expect(recovered?.runAttemptId).not.toBe(firstAttempt);
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: created.id }),
    );
    vi.useRealTimers();
  });

  it("adopts a rotated lease after crashing before the project token write", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    await queueResearchProject("alice", created.id);
    await drainResearchQueue("alice");
    const reserved = await getResearchProject("alice", created.id);
    const oldAttempt = reserved!.runAttemptId!;
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    const rotated = await rotateResearchSlot("alice", created.id, oldAttempt);
    expect(rotated?.attemptId).toBeTruthy();
    mockedEnqueue.mockClear();

    const snapshot = await listResearchProjects("alice");
    await Promise.all([
      reconcileResearchProjects("alice", snapshot),
      reconcileResearchProjects("alice", snapshot),
    ]);

    expect((await getResearchProject("alice", created.id))?.runAttemptId)
      .toBe(rotated?.attemptId);
    expect(await activeResearchCount("alice")).toBe(1);
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: created.id }),
    );
    vi.useRealTimers();
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
  it("rotates the attempt fence before recovering an abandoned run", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    const oldGrant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: oldGrant.attemptId,
    });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_ABANDONED_AFTER_MS + 1_000));
    let observedAttempt: string | undefined;
    mockedSearch.mockImplementation(async () => {
      observedAttempt = (await getResearchProject("alice", created.id))?.runAttemptId;
      return [{
        title: "Launch brief",
        url: "https://example.com/launch/brief",
        snippet: "short excerpt",
        content: "THE WHOLE PAGE BODY.",
      }];
    });

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(observedAttempt).toBeTruthy();
    expect(observedAttempt).not.toBe(oldGrant.attemptId);
    vi.useRealTimers();
  });

  it("does not let a stale terminal snapshot revoke a replacement attempt", async () => {
    const created = await project();
    const oldGrant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "complete",
      runAttemptId: oldGrant.attemptId,
      completion: { phase: "done", pageSlug: "research-old", sources: [] },
    });
    const stale = await listResearchProjects("alice");
    await updateResearchProject("alice", created.id, {
      status: "queued",
      runAttemptId: null,
      completion: null,
    });
    await releaseResearchSlot("alice", created.id, oldGrant.attemptId);
    const replacement = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, { runAttemptId: replacement.attemptId });

    await reconcileResearchProjects("alice", stale);

    await expect(renewResearchSlot("alice", created.id, replacement.attemptId!))
      .resolves.toBeUndefined();
    expect((await getResearchProject("alice", created.id))?.runAttemptId)
      .toBe(replacement.attemptId);
  });

  it("isolates a damaged project and still dispatches the next recoverable row", async () => {
    const recoverable = await project({ title: "Recoverable" });
    await queueResearchProject("alice", recoverable.id);
    const damaged = await project({ title: "Damaged" });
    await updateResearchProject("alice", damaged.id, {
      status: "failed",
      completion: { phase: "page", pageSlug: "research-damaged", sources: [] },
    });
    await getStorage().writeFile(
      `tenants/alice/research-outbox/${damaged.id}.json`,
      "{ malformed",
    );
    mockedEnqueue.mockClear();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect((await getResearchProject("alice", damaged.id))?.deliveryBlocked).toBe(true);
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: recoverable.id }),
    );
  });

  it("logs a read-only skip, not data damage, when a delete is refused", async () => {
    // DW-528. Reconcile's per-project catch reported EVERY fault as
    // `reconcile skipped damaged project`, so a deployment that turned
    // read-only mid sweep told the operator their rows were corrupt. The
    // refusal comes from the gated `deleteResearchProject`, which reconcile
    // calls for a tombstoned row whose slot is gone — the same path the
    // "reconcile deletes a finished row DELETE could not remove" case walks.
    const ids: string[] = [];
    for (const title of ["Retired one", "Retired two"]) {
      const created = await project({ title });
      await runResearchProject("alice", created.id);
      await mutateResearchProject("alice", created.id, (current) => {
        current.deleteRequested = true;
        return current;
      });
      ids.push(created.id);
    }
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const savedReadOnly = process.env.YOPEDIA_READONLY;
    process.env.YOPEDIA_READONLY = "1";

    let lines: string[] = [];
    try {
      await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    } finally {
      if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
      else process.env.YOPEDIA_READONLY = savedReadOnly;
      // BEFORE `mockRestore`, which resets the recorded calls along with the
      // implementation — reading them afterwards yields an empty list and
      // every assertion below would pass vacuously.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
    }

    expect(lines.length, "reconcile logged nothing at all").toBeGreaterThan(0);
    // BOTH rows, which is also how the loop's continuation is pinned: a catch
    // that rethrew would have logged only the first.
    for (const id of ids) {
      expect(lines).toContain(`reconcile skipped read-only project ${id}`);
    }
    expect(lines.some((line) => line.includes("damaged project"))).toBe(false);
    // And the refusal was real: neither tombstone was reaped.
    for (const id of ids) {
      expect(await getResearchProject("alice", id)).not.toBeNull();
    }
  });

  it("still names a DAMAGED project when the fault is not a refusal", async () => {
    // The control for the case above (DW-528). A catch that logged the
    // read-only line for EVERY fault would satisfy it and hide every real one,
    // so this walks the same catch with an ordinary storage fault.
    const created = await project({ title: "Damaged row" });
    const failing = vi
      .spyOn(projectsModule, "getResearchProject")
      .mockRejectedValue(new Error("EIO: registry unreadable"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      await reconcileResearchProjects("alice", [created]);
    } finally {
      // BEFORE `mockRestore`, which clears the recorded calls with it.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
      failing.mockRestore();
    }

    expect(lines).toContain(`reconcile skipped damaged project ${created.id}`);
    expect(lines.some((line) => line.includes("read-only project"))).toBe(false);
  });

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

  it("does not let delete remove a row while direct admission publishes its first lease", async () => {
    const created = await project();
    const storage = getStorage();
    const originalAbsent = storage.writeFileIfAbsent.bind(storage);
    let leasePublished!: () => void;
    let resumeAdmission!: () => void;
    let searchStarted!: () => void;
    let finishSearch!: (results: Awaited<ReturnType<typeof searchResearchProvider>>) => void;
    const published = new Promise<void>((resolve) => { leasePublished = resolve; });
    const resume = new Promise<void>((resolve) => { resumeAdmission = resolve; });
    const searching = new Promise<void>((resolve) => { searchStarted = resolve; });
    const searchResult = new Promise<Awaited<ReturnType<typeof searchResearchProvider>>>(
      (resolve) => { finishSearch = resolve; },
    );
    vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (target, content) => {
      const wrote = await originalAbsent(target, content);
      if (wrote && target.endsWith("research-leases.json")) {
        leasePublished();
        await resume;
      }
      return wrote;
    });
    mockedSearch.mockImplementationOnce(async () => {
      searchStarted();
      return searchResult;
    });

    const running = runResearchProject("alice", created.id);
    await published;
    const deleting = deleteResearchProject("alice", created.id);
    resumeAdmission();
    await searching;

    expect(await deleting).toBe(false);
    expect(await getResearchProject("alice", created.id)).toMatchObject({
      status: "collecting",
      runAttemptId: expect.any(String),
    });
    expect(await activeResearchCount("alice")).toBe(1);

    finishSearch([{
      title: "Launch brief",
      url: "https://example.com/launch/brief",
      snippet: "short excerpt",
      content: "THE WHOLE PAGE BODY, well past any snippet cap.",
    }]);
    await expect(running).resolves.toMatchObject({ status: "complete" });
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("does not let delete remove a row while queue drain reserves its first lease", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, { status: "queued" });
    const storage = getStorage();
    const originalAbsent = storage.writeFileIfAbsent.bind(storage);
    let leasePublished!: () => void;
    let resumeAdmission!: () => void;
    const published = new Promise<void>((resolve) => { leasePublished = resolve; });
    const resume = new Promise<void>((resolve) => { resumeAdmission = resolve; });
    vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (target, content) => {
      const wrote = await originalAbsent(target, content);
      if (wrote && target.endsWith("research-leases.json")) {
        leasePublished();
        await resume;
      }
      return wrote;
    });

    const draining = drainResearchQueue("alice");
    await published;
    const deleting = deleteResearchProject("alice", created.id);
    resumeAdmission();

    await draining;
    expect(await deleting).toBe(false);
    expect(await getResearchProject("alice", created.id)).toMatchObject({
      status: "queued",
      runAttemptId: expect.any(String),
    });
    expect(await activeResearchCount("alice")).toBe(1);
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

  it("writes no Page when its research slot is lost during synthesis", async () => {
    const created = await project();
    let synthesisStarted!: () => void;
    let finishSynthesis!: (value: string) => void;
    const started = new Promise<void>((resolve) => { synthesisStarted = resolve; });
    const response = new Promise<string>((resolve) => { finishSynthesis = resolve; });
    mockedLLM.mockImplementation(async () => {
      synthesisStarted();
      return response;
    });

    const running = runResearchProject("alice", created.id);
    await started;
    const active = await getResearchProject("alice", created.id);
    await releaseResearchSlot("alice", created.id, active?.runAttemptId);
    finishSynthesis(
      "# Launch evidence\n\nA brief [from the source](https://example.com/launch/brief).",
    );

    await expect(running).rejects.toThrow(/slot.*lost/i);
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect((await getResearchProject("alice", created.id))?.status).toBe("failed");
  });

  it("keeps a collecting worker's lease until that worker exits", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });

    expect(await retireResearchProject("alice", created.id)).toBe(true);
    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      cancelRequested: true,
    });
    expect(await activeResearchCount("alice")).toBe(1);
    await releaseResearchSlot("alice", created.id, grant.attemptId);
    await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    expect(await getResearchProject("alice", created.id)).toBeNull();
    expect(await activeResearchCount("alice")).toBe(0);
  });

  it("rejects Retry for a retained DELETE tombstone without revoking its live lease", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    expect(await retireResearchProject("alice", created.id)).toBe(true);

    const refusal = await queueResearchProject("alice", created.id).catch((e: unknown) => e);
    // TYPE and message both: the door decides 404 by `instanceof` alone, and
    // the body echoes the sentence (DW-651).
    expect(refusal).toBeInstanceOf(ResearchProjectNotFoundError);
    expect((refusal as Error).message).toMatch(/retired/i);

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      cancelRequested: true,
      runAttemptId: grant.attemptId,
    });
    await expect(renewResearchSlot("alice", created.id, grant.attemptId!)).resolves.toBeUndefined();
    expect(await activeResearchCount("alice")).toBe(1);
    expect(mockedEnqueue).not.toHaveBeenCalled();
  });

  it("reaps a crashed DELETE tombstone after expiry and dispatches its successor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const doomed = await project({ title: "Doomed" });
    const grant = await acquireResearchSlot("alice", doomed.id);
    await updateResearchProject("alice", doomed.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    const successor = await project({ title: "Successor" });
    await queueResearchProject("alice", successor.id);
    expect(await retireResearchProject("alice", doomed.id)).toBe(true);
    mockedEnqueue.mockClear();
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", doomed.id)).toBeNull();
    expect(mockedEnqueue).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "run-research", projectId: successor.id }),
    );
    vi.useRealTimers();
  });

  it("retains a DELETE tombstone when its stale token has a rotated durable successor", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    expect(await retireResearchProject("alice", created.id)).toBe(true);
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    const rotated = await rotateResearchSlot("alice", created.id, grant.attemptId!);
    expect(rotated?.attemptId).toBeTruthy();

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      runAttemptId: grant.attemptId,
    });
    expect(await activeResearchCount("alice")).toBe(1);
    await expect(renewResearchSlot("alice", created.id, rotated!.attemptId!))
      .resolves.toBeUndefined();
    vi.useRealTimers();
  });

  it("does not delete a project while stale recovery publishes a replacement lease", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    await queueResearchProject("alice", created.id);
    await drainResearchQueue("alice");
    const reserved = await getResearchProject("alice", created.id);
    const oldAttempt = reserved!.runAttemptId!;
    const snapshot = await listResearchProjects("alice");
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    await releaseResearchSlot("alice", created.id, oldAttempt);
    expect(await activeResearchCount("alice")).toBe(0);

    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let replacementPublished!: () => void;
    let resumeRotation!: () => void;
    const published = new Promise<void>((resolve) => { replacementPublished = resolve; });
    const resume = new Promise<void>((resolve) => { resumeRotation = resolve; });
    let pauseOnce = true;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => {
        const wrote = await originalMatch(target, content, etag);
        if (
          pauseOnce
          && wrote
          && target.endsWith("research-leases.json")
          && content.includes(created.id)
        ) {
          pauseOnce = false;
          replacementPublished();
          await resume;
        }
        return wrote;
      },
    );

    const reconciling = reconcileResearchProjects("alice", snapshot);
    await published;
    const deleting = deleteResearchProject("alice", created.id);
    resumeRotation();

    await reconciling;
    expect(await deleting).toBe(false);
    const retained = await getResearchProject("alice", created.id);
    expect(retained?.runAttemptId).toBeTruthy();
    expect(retained?.runAttemptId).not.toBe(oldAttempt);
    expect(await activeResearchCount("alice")).toBe(1);
    vi.useRealTimers();
  });

  it("reaps an expired rotated successor before deleting its stale-token tombstone", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "collecting",
      runAttemptId: grant.attemptId,
    });
    expect(await retireResearchProject("alice", created.id)).toBe(true);
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    const rotated = await rotateResearchSlot("alice", created.id, grant.attemptId!);
    expect(rotated?.attemptId).toBeTruthy();
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", created.id)).toBeNull();
    expect(await activeResearchCount("alice")).toBe(0);
    vi.useRealTimers();
  });

  it("retains the DELETE tombstone when lease cleanup cannot be confirmed", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "failed",
      runAttemptId: grant.attemptId,
    });
    await getStorage().writeFile("tenants/alice/research-leases.json", "{ malformed");

    expect(await retireResearchProject("alice", created.id)).toBe(true);
    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      runAttemptId: grant.attemptId,
    });
  });

  it("retains an expired DELETE tombstone when durable release writes keep losing", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "failed",
      runAttemptId: grant.attemptId,
    });
    vi.setSystemTime(new Date(Date.now() + RESEARCH_SLOT_TTL_MS + 1_000));
    const storage = getStorage();
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(
      async (target, content, etag) => target.endsWith("research-leases.json")
        ? false
        : originalMatch(target, content, etag),
    );

    expect(await retireResearchProject("alice", created.id)).toBe(true);
    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await getResearchProject("alice", created.id)).toMatchObject({
      deleteRequested: true,
      runAttemptId: grant.attemptId,
    });
    expect(await activeResearchCount("alice")).toBe(1);
    vi.useRealTimers();
  });

  it("keeps the Page and reports pending Source promotion after a storage failure", async () => {
    mockedSaveRaw.mockRejectedValue(new Error("disk full"));
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect(finished.status).toBe("failed");
    expect(finished.deliveryBlocked).toBe(true);
    expect(finished.completion?.phase).toBe("sources");
    expect(finished.error).toMatch(/did not ingest|Page was written/);
    const attempts = mockedSaveRaw.mock.calls.length;
    await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    expect(mockedSaveRaw).toHaveBeenCalledTimes(attempts);
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

  it("blocks a persistent Page delivery failure until an explicit Retry", async () => {
    mockedWritePage.mockRejectedValue(
      new Error("Durable lock page-lifecycle:research-launch-evidence expired without release; operator recovery required"),
    );
    const created = await project();
    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/operator recovery/i);
    const firstAttempts = mockedWritePage.mock.calls.length;

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    const blocked = await getResearchProject("alice", created.id);
    expect(blocked).toMatchObject({ status: "failed", deliveryBlocked: true });
    expect(mockedWritePage.mock.calls.length).toBe(firstAttempts + 1);

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    expect(mockedWritePage.mock.calls.length).toBe(firstAttempts + 1);
    const oldDeliveryAttempt = blocked?.deliveryAttemptId;
    const retrying = await queueResearchProject("alice", created.id);
    expect(retrying.deliveryBlocked).toBe(false);
    expect(retrying.deliveryAttemptId).toBeTruthy();
    expect(retrying.deliveryAttemptId).not.toBe(oldDeliveryAttempt);
  });

  it("does not let a stale queue delivery bypass an operator delivery block", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "failed",
      deliveryBlocked: true,
      deliveryAttemptId: "blocked-delivery",
      completion: { phase: "page", pageSlug: "research-launch-evidence", sources: [] },
    });
    mockedWritePage.mockClear();

    const returned = await runResearchProject("alice", created.id);

    expect(returned.deliveryBlocked).toBe(true);
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("does not let an old delivery failure overwrite an explicit Retry generation", async () => {
    const created = await project();
    const source = {
      url: "https://example.com/launch/brief",
      title: "Launch brief",
      slug: "research-source-launch-brief",
      sha: "old-delivery-sha",
    };
    await saveResearchOutbox("alice", created.id, {
      pageSlug: "research-launch-evidence",
      title: "Launch evidence",
      synthesis: "# Launch evidence\n\nA brief.",
      thinking: [],
      sources: [{ ...source, text: "body" }],
      evidence: [{ url: source.url, title: source.title }],
    });
    await updateResearchProject("alice", created.id, {
      status: "failed",
      deliveryBlocked: false,
      deliveryAttemptId: "old-delivery",
      completion: { phase: "sources", pageSlug: "research-launch-evidence", sources: [source] },
    });
    let saveStarted!: () => void;
    let finishSave!: () => void;
    const started = new Promise<void>((resolve) => { saveStarted = resolve; });
    const finish = new Promise<void>((resolve) => { finishSave = resolve; });
    mockedSaveRaw.mockImplementationOnce(async () => {
      saveStarted();
      await finish;
      throw new Error("stale delivery failed");
    });

    const staleDrain = drainResearchOutbox("alice", created.id);
    await started;
    await updateResearchProject("alice", created.id, { deliveryBlocked: true });
    const retrying = await queueResearchProject("alice", created.id);
    finishSave();
    await staleDrain;

    const latest = await getResearchProject("alice", created.id);
    expect(latest?.deliveryAttemptId).toBe(retrying.deliveryAttemptId);
    expect(latest?.deliveryBlocked).toBe(false);
  });

  it("returns a fresh Retry generation instead of the stale panel snapshot", async () => {
    const created = await project();
    await updateResearchProject("alice", created.id, {
      status: "failed",
      deliveryBlocked: true,
      deliveryAttemptId: "failed-delivery",
      completion: { phase: "page", pageSlug: "research-launch-evidence", sources: [] },
    });
    const stale = await listResearchProjects("alice");
    const retrying = await queueResearchProject("alice", created.id);

    const reconciled = await reconcileResearchProjects("alice", stale);

    expect(reconciled.find((item) => item.id === created.id)?.deliveryAttemptId)
      .toBe(retrying.deliveryAttemptId);
    expect(reconciled.find((item) => item.id === created.id)?.deliveryBlocked).toBe(false);
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

  it("retries cleanup of a terminal project's retained lease", async () => {
    const created = await project();
    const grant = await acquireResearchSlot("alice", created.id);
    await updateResearchProject("alice", created.id, {
      status: "complete",
      runAttemptId: grant.attemptId,
      completion: { phase: "done", pageSlug: "research-launch-evidence", sources: [] },
    });
    expect(await activeResearchCount("alice")).toBe(1);

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    expect(await activeResearchCount("alice")).toBe(0);
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

  it("logs a read-only skip, not damage, when an ORPHAN outbox drain is refused", async () => {
    // DW-660. DW-528 gave the per-project catch its `isReadOnlyError` branch
    // and left the orphan loop three lines below it still calling every fault
    // damage. The orphan drain reaches `writeResearchPage` ->
    // `writeWikiPageWithSideEffects`, which is gated, so a read-only deployment
    // lands a `ReadOnlyError` in exactly this catch — and "damaged orphan
    // outbox" told an operator their queued Page was corrupt when nothing was
    // wrong with it.
    const ids: string[] = [];
    for (const title of ["Orphan one", "Orphan two"]) {
      const created = await project({ title });
      await saveResearchOutbox("alice", created.id, {
        pageSlug: "research-launch-evidence",
        title: "Launch evidence",
        synthesis: "# Launch evidence\n\nA brief.",
        thinking: [],
        sources: [],
        evidence: [],
        claimed: true,
      });
      expect(await deleteResearchProject("alice", created.id)).toBe(true);
      ids.push(created.id);
    }
    mockedWritePage.mockRejectedValue(new ReadOnlyError(READ_ONLY_REFUSAL.pageWrite));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    } finally {
      // BEFORE `mockRestore`, which resets the recorded calls along with the
      // implementation — reading them afterwards yields an empty list and every
      // assertion below would pass vacuously.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
    }

    // BOTH orphans, which is also how the loop's continuation is pinned: a
    // catch that rethrew would have logged only the first.
    for (const id of ids) {
      expect(lines).toContain(`reconcile skipped read-only orphan outbox ${id}`);
    }
    expect(lines.some((line) => line.includes("damaged orphan outbox"))).toBe(false);
    // And the refusal was real: neither outbox was drained away.
    for (const id of ids) {
      expect(await loadResearchOutbox("alice", id)).not.toBeNull();
    }
  });

  it("still names a DAMAGED orphan outbox when the fault is not a refusal", async () => {
    // The control for the case above (DW-660). A catch that logged the
    // read-only line for EVERY fault would satisfy it and hide every real one,
    // so this walks the same catch with an ordinary storage fault.
    const created = await project();
    await saveResearchOutbox("alice", created.id, {
      pageSlug: "research-launch-evidence",
      title: "Launch evidence",
      synthesis: "# Launch evidence\n\nA brief.",
      thinking: [],
      sources: [],
      evidence: [],
      claimed: true,
    });
    expect(await deleteResearchProject("alice", created.id)).toBe(true);
    mockedWritePage.mockRejectedValue(new Error("EIO: page store unreadable"));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    } finally {
      // BEFORE `mockRestore`, which clears the recorded calls with it.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
    }

    expect(lines).toContain(`reconcile skipped damaged orphan outbox ${created.id}`);
    expect(lines.some((line) => line.includes("read-only orphan outbox"))).toBe(false);
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

  it("records a blocked delivery and requires an explicit retry", async () => {
    const created = await project();
    await saveResearchOutbox("alice", created.id, {
      pageSlug: "research-launch-evidence",
      title: "Launch evidence",
      synthesis: "# Launch evidence\n\nA brief.",
      thinking: [],
      sources: [],
      evidence: [],
    });
    mockedWritePage.mockRejectedValueOnce(
      new Error("Durable lock page-lifecycle:research-launch-evidence expired without release; operator recovery required"),
    );

    await reconcileResearchProjects("alice", await listResearchProjects("alice"));

    const blocked = await getResearchProject("alice", created.id);
    expect(blocked).toMatchObject({ status: "failed", deliveryBlocked: true });
    expect(blocked?.error).toMatch(/operator recovery required/i);
    // DW-656. The sentence used to tell the operator to repair a reported lock
    // — a literal this comment deliberately does not spell, so the repo-wide
    // grep for it stays clean. But the expired durable lock is only ONE of the
    // faults that reaches this fence, and the row's own `error` field already
    // carries whichever it was, so the sentence points at that field instead of
    // at a lock that may not be involved at all.
    expect(blocked?.progress?.message).toMatch(/resolve.*error.*retry/i);
    // Anchored at the START of a word only: "blocked" carries the substring, so
    // an unanchored /lock/i would fail on the sentence's own first clause. The
    // tail is deliberately open — "locks", "locking", "lockfile" and
    // "lock-holder" are exactly the rewordings that would bring the regression
    // back, and a trailing \b would wave all four through.
    expect(blocked?.progress?.message).not.toMatch(/(?:^|\W)lock\w*/i);

    const retrying = await queueResearchProject("alice", created.id);
    expect(retrying.deliveryBlocked).toBe(false);
    expect(retrying.completion?.phase).not.toBe("done");
  });

  it("does NOT fence the row when the delivery drain is REFUSED, not broken", async () => {
    // DW-656. The fence is for a fault an operator must go and resolve, and it
    // costs the owner an explicit Retry to clear. A read-only refusal is
    // neither: nothing is wrong with the row and the drain succeeds unchanged
    // the moment the deployment is writable. The write was silent only BY
    // ACCIDENT before — `updateResearchProjectIf` collapses the CAS sentinel to
    // `null`, so the fence refused ITSELF — which left the real hole this pins:
    // the flag flipping back to writable between the drain's throw and the
    // fence write, storing `deliveryBlocked: true` with a read-only sentence as
    // `error`. That is the shape here: the store is writable throughout and only
    // the Page write refuses.
    const created = await project();
    await saveResearchOutbox("alice", created.id, {
      pageSlug: "research-launch-evidence",
      title: "Launch evidence",
      synthesis: "# Launch evidence\n\nA brief.",
      thinking: [],
      sources: [],
      evidence: [],
    });
    mockedWritePage.mockRejectedValueOnce(new ReadOnlyError(READ_ONLY_REFUSAL.pageWrite));
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    } finally {
      // BEFORE `mockRestore`, which clears the recorded calls with it.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
    }

    // Skipped OUT LOUD, not silently: the fence is the operator's signal that a
    // delivery stopped, so declining to raise one has to leave a line behind.
    expect(lines).toContain(`skipped read-only delivery block for ${created.id}`);

    // Every field an operator reads is untouched by the refusal.
    const after = await getResearchProject("alice", created.id);
    expect(after?.deliveryBlocked).not.toBe(true);
    expect(after?.status).not.toBe("failed");
    expect(after?.error).toBeUndefined();
    expect(after?.progress?.message ?? "").not.toMatch(/delivery is blocked/i);

    // …and the next writable pass drains it on its own. The fence is exactly
    // what would have gated this behind a Retry the owner never had to make.
    await reconcileResearchProjects("alice", await listResearchProjects("alice"));
    const delivered = await getResearchProject("alice", created.id);
    expect(delivered?.status).toBe("complete");
    expect(delivered?.completion?.phase).toBe("done");
  });

  it("rethrows that refusal from runResearchProject, still without fencing", async () => {
    // The fence's OTHER caller (DW-656). Both cases above drive reconcile,
    // which swallows what the fence returns; `runResearchProject` rethrows the
    // drain's own error on the line after it, so the early return has to leave
    // that rethrow — and the row — exactly as it found them. A fence that
    // started throwing, or one that wrote on a refusal, shows up here and
    // nowhere else.
    //
    // The first, ORDINARY failure is setup, not the subject: it is what leaves
    // a pending `phase: "page"` completion and a minted `deliveryAttemptId`
    // behind, which is the shape that actually reaches the drain — a project
    // with no attempt id yet never gets past `ensureResearchDeliveryAttempt`.
    mockedWritePage.mockRejectedValueOnce(new Error("registry down"));
    const created = await project();
    await expect(runResearchProject("alice", created.id)).rejects.toThrow(/registry down/);
    const pending = await getResearchProject("alice", created.id);
    expect(pending?.completion?.phase).toBe("page");
    expect(pending?.deliveryAttemptId).toBeTruthy();
    expect(pending?.deliveryBlocked).not.toBe(true);

    mockedWritePage.mockRejectedValueOnce(new ReadOnlyError(READ_ONLY_REFUSAL.pageWrite));
    const error = await runResearchProject("alice", created.id).then(
      () => null,
      (e: unknown) => e,
    );

    // The caller's own rethrow, unchanged: the refusal leaves by the door every
    // read-only path leaves by, classified on `name` the way each one is.
    expect(isReadOnlyError(error)).toBe(true);
    expect((error as Error).message).toBe(READ_ONLY_REFUSAL.pageWrite);
    // And nothing was fenced on the way out. `error` is the tell: the fence
    // overwrites it with the refusal sentence, so the ordinary fault from the
    // setup run still standing there is proof the write never happened.
    const after = await getResearchProject("alice", created.id);
    expect(after?.deliveryBlocked).not.toBe(true);
    expect(after?.status).not.toBe("failed");
    expect(after?.error).toBe("registry down");
    expect(after?.progress?.message ?? "").not.toMatch(/delivery is blocked/i);
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
  it("names the Page from the title and the Source from the URL", async () => {
    // URL identity is what makes the SHA skip mean anything: a second run over
    // the same page writes the same Source slug instead of a duplicate.
    expect(researchPageSlug({ title: "Launch Evidence!", id: "abc" })).toMatch(/^research-launch-evidence-[0-9a-f]{8}$/);
    expect(await researchSourceSlug("https://example.com/a/b"))
      .toMatch(/^research-example-com-a-b-[0-9a-f]{20}$/);
    expect(await researchSourceSlug("not a url")).toBeNull();
  });

  it("distinguishes the complete normalized URL identity", async () => {
    // These used to collide, and because `saveRawSourceFor` is first-write-only
    // the SECOND document silently kept the FIRST one's body: two pages, one
    // Source, wrong bytes, no error. Most of the paginated and id-addressed web
    // lands here.
    const first = await researchSourceSlug("https://example.com/a/b?q=1");
    const second = await researchSourceSlug("https://example.com/a/b?q=2");
    expect(first).not.toBe(second);
    // Still derived from the URL, so a re-run of the SAME URL is the same slug —
    // which is what makes the SHA skip mean anything.
    expect(await researchSourceSlug("https://example.com/a/b?q=1")).toBe(first);
    expect(first).toMatch(/^research-example-com-a-b-[0-9a-f]{20}$/);
    expect(await researchSourceSlug("https://example.com/a/b"))
      .toMatch(/^research-example-com-a-b-[0-9a-f]{20}$/);
    // A fragment addresses a position inside ONE document — same bytes, same
    // Source.
    expect(await researchSourceSlug("https://example.com/a/b#top"))
      .toBe(await researchSourceSlug("https://example.com/a/b"));
    expect(await researchSourceSlug("http://example.com/a/b"))
      .not.toBe(await researchSourceSlug("https://example.com/a/b"));
    expect(await researchSourceSlug("https://example.com:8443/a/b"))
      .not.toBe(await researchSourceSlug("https://example.com/a/b"));
  });

  it("falls back to the project id when the title slugifies to nothing", () => {
    expect(researchPageSlug({ title: "!!!", id: "0123456789abcdef" })).toMatch(/^research-untitled-[0-9a-f]{8}$/);
  });
});

// ---------------------------------------------------------------------------
// DW-544. A synthesis stream that ends early must FAIL the run, not commit half
// a brief as a finished wiki page.
//
// The pre-DW-544 shape was silence: `textStream` drops the `{ type: "abort" }`
// part `ai@6` emits when the owner's deadline fires, so the `for await` ended
// NORMALLY and whatever text had arrived flowed on into the page write.
//
// FAILS CLOSED whatever the deadline field says, unlike `/api/query/stream`,
// which stays silent with no deadline configured. That route's fallback is
// silence — what it did before DW-64. Research's fallback is a truncated page,
// which is the bug. So only the WORDS turn on the field here.
//
// DW-663 and DW-664 add the two endings the loop still fell through: a
// `finish` carrying `finishReason: "length"` (the output cap CUT the brief) and
// an `error` part that nothing follows (`ai@6` closed the source, so the
// `for await` ended normally). Both were committing a fragment as a finished
// page. An `error` the stream carries on PAST is still warning-shaped and still
// commits — that distinction is what the after-the-loop check exists for.
// ---------------------------------------------------------------------------
describe("deep research — a synthesis stream that stopped early (DW-544, DW-663, DW-664)", () => {
  it("fails the run and writes nothing when the deadline aborts mid-synthesis", async () => {
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([delta("# Half a brie"), { type: "abort", reason: "timeout" }]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_DEADLINE_RESEARCH_COPY,
    );

    // The whole point: nothing reached the wiki, and no second synthesis was
    // bought to paper over the first.
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.includes("evidence-first private research brief"),
    )).toHaveLength(0);

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    // The IMPORTED constant, not `error.message` from the SDK — this string is
    // rendered in the research panel.
    expect(failed?.error).toBe(LLM_DEADLINE_RESEARCH_COPY);
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(failed?.error).not.toContain(word);
    }
  });

  it.each(["TimeoutError", "AbortError"] as const)(
    "treats a deadline carried by an `error` part the same way (%s)",
    async (name) => {
      mockedTimeout.mockReturnValue(30_000);
      fakeStream([
        delta("# Half a brie"),
        { type: "error", error: abortError(name) },
      ]);
      const created = await project();

      await expect(runResearchProject("alice", created.id)).rejects.toThrow(
        LLM_DEADLINE_RESEARCH_COPY,
      );

      expect(mockedWritePage).not.toHaveBeenCalled();
      expect((await getResearchProject("alice", created.id))?.error).toBe(
        LLM_DEADLINE_RESEARCH_COPY,
      );
    },
  );

  it("fails with the no-deadline words when nothing was configured", async () => {
    // `mockedTimeout` is already `null` — the default. The run still dies; only
    // the sentence changes, and it names no limit and no Settings destination,
    // because there is no field behind a stream this repo did not cut.
    fakeStream([delta("# Half a brie"), { type: "abort" }]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    );

    expect(mockedWritePage).not.toHaveBeenCalled();
    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    expect(failed?.error).not.toContain(SETTINGS_LABEL);
  });

  it("reports a run cancelled at the moment its stream aborts as CANCELLED", async () => {
    // Both are true at once, and the owner's own action wins. Under `textStream`
    // the cancellation check was the first thing every chunk hit; DW-544 must
    // not relabel a cancelled run `failed` and tell someone who pressed Cancel
    // that their LLM timeout is too low.
    mockedTimeout.mockReturnValue(30_000);
    const created = await project();
    fakeStream([
      delta("# Half a brie"),
      async () => {
        await cancelResearchProject("alice", created.id);
      },
      { type: "abort", reason: "timeout" },
    ]);

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("cancelled");
    expect(finished.error).not.toBe(LLM_DEADLINE_RESEARCH_COPY);
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(finished.progress?.message).toBe("Cancelled.");
  });

  it("still ignores a NON-deadline `error` part and commits the brief", async () => {
    // Warning-shaped parts were dropped when `textStream` did the reading, and
    // a brief that completes after one has always committed. DW-544 owns the
    // abort and the deadline, and nothing else.
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([
      delta("# Launch evidence\n\nA brief "),
      { type: "error", error: new Error("a warning-shaped part") },
      delta("[from the source](https://example.com/launch/brief)."),
      { type: "finish", finishReason: "stop" },
    ]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedWritePage).toHaveBeenCalled();
    expect(mockedWritePage.mock.calls[0][0].content).toContain(
      "# Launch evidence",
    );
  });

  it("fails the run when its own output cap CUT the brief (DW-663)", async () => {
    // `finish`/`length` means this brief was cut at the output budget the
    // synthesis call passes — not that it fit under it. Before DW-663 the part
    // fell through the loop's bookkeeping tail and the fragment was committed
    // as a finished wiki page: the same silent truncation DW-544 closed for the
    // deadline, from a different cause. A brief that looks whole is the whole
    // point, so `GOOD_BRIEF` here would have passed every downstream gate.
    //
    // A deadline is configured on purpose: the cap sentence does NOT turn on
    // that field, unlike the abort branch, because the cap is passed on every
    // call and is always this repo's own.
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "finish", finishReason: "length" },
    ]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_LENGTH_CAP_COPY,
    );

    // Nothing reached the wiki, and no second synthesis was bought to paper
    // over the first.
    expect(mockedWritePage).not.toHaveBeenCalled();
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.includes("evidence-first private research brief"),
    )).toHaveLength(0);

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_LENGTH_CAP_COPY);
  });

  it("uses the same cap sentence with NO deadline configured (DW-663)", async () => {
    // `mockedTimeout` is already `null`. The gate that picks between the two
    // DW-544 sentences has no bearing here — a blank timeout field did not cut
    // this brief, the cap did — so the words are identical either way.
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "finish", finishReason: "length" },
    ]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_LENGTH_CAP_COPY,
    );

    expect(mockedWritePage).not.toHaveBeenCalled();
    expect((await getResearchProject("alice", created.id))?.error).toBe(
      LLM_RESEARCH_LENGTH_CAP_COPY,
    );
  });

  it("reports a run cancelled as the cap lands as CANCELLED, not failed", async () => {
    // Same rule as the abort branch: the owner's own action outranks the
    // failure sentence, so someone who pressed Cancel is not told their brief
    // was too long.
    mockedTimeout.mockReturnValue(30_000);
    const created = await project();
    fakeStream([
      delta(GOOD_BRIEF),
      async () => {
        await cancelResearchProject("alice", created.id);
      },
      { type: "finish", finishReason: "length" },
    ]);

    const finished = await runResearchProject("alice", created.id);

    // Mirrors the sibling DW-544 cancel assertion: the cancel PROGRESS line,
    // and no failure sentence at all — `not.toBe(...)` alone would pass on any
    // other failure sentence sitting in `error`.
    expect(finished.status).toBe("cancelled");
    expect(finished.progress?.message).toBe("Cancelled.");
    for (const sentence of [
      LLM_RESEARCH_LENGTH_CAP_COPY,
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
      LLM_DEADLINE_RESEARCH_COPY,
    ]) {
      expect(finished.error).not.toBe(sentence);
    }
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("fails the run when a non-deadline `error` part ENDS the stream (DW-664)", async () => {
    // `ai@6` CLOSES the source on an `error` part, so with nothing after it the
    // `for await` ends normally and the half brief used to flow straight into
    // `commitResearchPage`. Indistinguishable from the warning-shaped part
    // below at the moment it arrives — only what follows tells them apart.
    const cause = new Error("provider connection reset");
    fakeStream([delta(GOOD_BRIEF), { type: "error", error: cause }]);
    const created = await project();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let causes: unknown[] = [];
    try {
      await expect(runResearchProject("alice", created.id)).rejects.toThrow(
        LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
      );
    } finally {
      // BEFORE `mockRestore`, which resets the recorded calls with the
      // implementation.
      causes = warn.mock.calls.map((call) => call[2]);
      warn.mockRestore();
    }

    expect(mockedWritePage).not.toHaveBeenCalled();
    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    // The SDK's own words are logged, never rendered in the research panel —
    // and the log is the ONLY place the real cause survives, so pin that it
    // actually arrives there rather than being swallowed with the fragment.
    expect(failed?.error).not.toContain("provider connection reset");
    expect(causes).toContain(cause);
  });

  it("keeps the cut-short words for that ending even WITH a deadline set (DW-664)", async () => {
    // NOT `LLM_DEADLINE_RESEARCH_COPY`. This error is not a deadline — the
    // deadline branch already claimed those shapes — so blaming the owner's
    // timeout would send them to raise a limit that had nothing to do with it.
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "error", error: new Error("provider connection reset") },
    ]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    );

    expect(mockedWritePage).not.toHaveBeenCalled();
    const failed = await getResearchProject("alice", created.id);
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    expect(failed?.error).not.toBe(LLM_DEADLINE_RESEARCH_COPY);
    expect(failed?.error).not.toContain("provider connection reset");
  });

  it("reports a run cancelled as that ending lands as CANCELLED, not failed", async () => {
    mockedTimeout.mockReturnValue(30_000);
    const created = await project();
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "error", error: new Error("provider connection reset") },
      async () => {
        await cancelResearchProject("alice", created.id);
      },
    ]);

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("cancelled");
    expect(finished.progress?.message).toBe("Cancelled.");
    for (const sentence of [
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
      LLM_RESEARCH_LENGTH_CAP_COPY,
      LLM_DEADLINE_RESEARCH_COPY,
    ]) {
      expect(finished.error).not.toBe(sentence);
    }
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("is not defeated by the bookkeeping `ai@6` emits after a provider error (DW-664)", async () => {
    // THE REAL SDK SHAPE, and the one a naive "any following part clears it"
    // rule waves through. A provider `error` chunk does not close the stream on
    // the spot: `ai@6` enqueues the error part, sets the step's finish reason
    // to `"error"`, then emits `finish-step` and `finish` BOTH carrying
    // `finishReason: "error"` before closing. That trailing pair is teardown,
    // not brief, so it must not count as the stream carrying on.
    const cause = new Error("provider connection reset");
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "error", error: cause },
      { type: "finish-step", finishReason: "error" },
      { type: "finish", finishReason: "error" },
    ]);
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    );

    expect(mockedWritePage).not.toHaveBeenCalled();
    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
  });

  it("commits when the model reports a CLEAN finish after an error part", async () => {
    // `finishReason: "stop"` is the model saying it finished, which no teardown
    // after a provider error ever says. A pending error dies on it.
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "error", error: new Error("a warning-shaped part") },
      { type: "finish", finishReason: "stop" },
    ]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedWritePage).toHaveBeenCalled();
  });

  it("commits when a stray error part arrives AFTER a clean finish", async () => {
    // Teardown noise on a brief the model already completed. The clean `finish`
    // is remembered precisely so a late error cannot destroy a whole brief.
    fakeStream([
      delta(GOOD_BRIEF),
      { type: "finish", finishReason: "stop" },
      { type: "error", error: new Error("teardown noise") },
    ]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedWritePage).toHaveBeenCalled();
    expect(mockedWritePage.mock.calls[0][0].content).toContain(
      "# Launch evidence",
    );
  });

  it("takes the fallback, not the cap failure, when `length` beats the first token", async () => {
    // THE BOUNDARY of DW-663, stated rather than assumed. Both new throws sit
    // inside the `try`, so they meet `receivedStreamContent` in the catch —
    // and with no deltas at all there is no partial brief to protect, only a
    // stream that never started. That is the pre-existing fallback for a stream
    // that died before saying anything, which this change does not remove.
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([{ type: "finish", finishReason: "length" }]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.includes("evidence-first private research brief"),
    )).toHaveLength(1);
    expect(mockedWritePage).toHaveBeenCalled();
  });

  it("takes the fallback, not the cut-short failure, when an error beats the first token", async () => {
    // The same boundary for DW-664's ending. Nothing was truncated, so nothing
    // is being published as whole.
    fakeStream([{ type: "error", error: new Error("provider connection reset") }]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.includes("evidence-first private research brief"),
    )).toHaveLength(1);
    expect(mockedWritePage).toHaveBeenCalled();
  });

  it("still falls back to one non-streamed call when the abort beats the first token", async () => {
    // `receivedStreamContent` is false, so this is the pre-existing fallback
    // for a stream that died before saying anything — not a retry of a
    // truncated answer.
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([{ type: "abort" }]);
    const created = await project();

    const finished = await runResearchProject("alice", created.id);

    expect(finished.status).toBe("complete");
    expect(mockedLLM.mock.calls.filter(([system]) =>
      system.includes("evidence-first private research brief"),
    )).toHaveLength(1);
    expect(mockedWritePage).toHaveBeenCalled();
  });

  it("keeps the SDK's words out of the panel when that fallback aborts with no deadline set", async () => {
    // `mockedTimeout` is already `null`. Before this branch was ungated, the
    // rejection's own text — "The operation was aborted due to timeout" — was
    // stored as `project.error` and rendered in the research panel. The run
    // fails either way; only the sentence turns on the field.
    fakeStream([{ type: "abort" }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.includes("evidence-first private research brief")) {
        throw abortError("TimeoutError");
      }
      return "evidence";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    );

    const failed = await getResearchProject("alice", created.id);
    expect(failed?.status).toBe("failed");
    expect(failed?.error).toBe(LLM_RESEARCH_STREAM_CUT_SHORT_COPY);
    for (const word of ["aborted", "signal", "TimeoutError", "AbortError"]) {
      expect(failed?.error).not.toContain(word);
    }
  });

  it("reports a deadline on that fallback call in the same words", async () => {
    mockedTimeout.mockReturnValue(30_000);
    fakeStream([{ type: "abort" }]);
    mockedLLM.mockImplementation(async (system) => {
      if (system.includes("evidence-first private research brief")) {
        throw abortError("TimeoutError");
      }
      return "evidence";
    });
    const created = await project();

    await expect(runResearchProject("alice", created.id)).rejects.toThrow(
      LLM_DEADLINE_RESEARCH_COPY,
    );

    expect(mockedWritePage).not.toHaveBeenCalled();
    expect((await getResearchProject("alice", created.id))?.error).toBe(
      LLM_DEADLINE_RESEARCH_COPY,
    );
  });
});

describe("the research sentences (DW-544, DW-663)", () => {
  it("composes the Settings destination rather than spelling it out", () => {
    // DW-369: renaming the `llm-models` category must move this sentence with
    // it rather than orphan it. Composed even to ASSERT, never typed.
    expect(LLM_DEADLINE_RESEARCH_COPY).toContain(
      settingsPointer("llm-models", SETTINGS_LABEL),
    );
  });

  it.each([LLM_RESEARCH_STREAM_CUT_SHORT_COPY, LLM_RESEARCH_LENGTH_CAP_COPY])(
    "points the ungated sentences at no control at all (%#)",
    (copy) => {
      // Neither has a field behind it: the timeout was never set in the one
      // case, and the output cap is a source literal in the other. A Settings
      // pointer would send the owner looking for a control that is not there.
      expect(copy).not.toContain(settingsPointer("llm-models", SETTINGS_LABEL));
      expect(copy).not.toContain(SETTINGS_LABEL);
    },
  );

  it.each([
    LLM_DEADLINE_RESEARCH_COPY,
    LLM_RESEARCH_STREAM_CUT_SHORT_COPY,
    LLM_RESEARCH_LENGTH_CAP_COPY,
  ])(
    "carries no transport vocabulary and says nothing was written (%#)",
    (copy) => {
      for (const word of [
        "aborted",
        "signal",
        "TimeoutError",
        "AbortError",
        "finishReason",
        "token",
        "maxOutputTokens",
      ]) {
        expect(copy).not.toContain(word);
      }
      expect(copy).toContain("Nothing was written");
    },
  );

  it("does not reuse the query-scoped cap sentence for research", () => {
    // `LLM_LENGTH_CAP_COPY` promises "the rest" of an answer already on screen.
    // A research run that hits the cap writes nothing, so there is no rest to
    // see — and its owner has to be told the wiki is untouched.
    expect(LLM_RESEARCH_LENGTH_CAP_COPY).not.toBe(LLM_LENGTH_CAP_COPY);
    expect(LLM_RESEARCH_LENGTH_CAP_COPY).not.toContain(
      "narrower part of the question",
    );
    expect(LLM_LENGTH_CAP_COPY).not.toContain("Nothing was written");
  });
});


/**
 * The deployment turns read-only WHILE a run is in flight (DW-658).
 *
 * `research-runtime`'s two attempt-fenced writers used to reach the CAS through
 * the fail-soft wrappers, which collapse the read-only sentinel to the same
 * `null` a lost lease returns — so a flag flip mid-run surfaced as
 * "Research attempt for <id> was replaced.", a lease race the operator would
 * go hunting a second worker for. Both now carry the sentinel through and
 * report the deployment instead.
 *
 * `research-completion` and `research-concurrency` carry no read-only gate, so
 * staging and lease writes still succeed while the flag is set — which is what
 * lets the run get as far as these two writers at all.
 */
describe("deep research run — the deployment flips read-only mid-run", () => {
  let savedReadOnly: string | undefined;

  beforeEach(() => {
    savedReadOnly = process.env.YOPEDIA_READONLY;
    delete process.env.YOPEDIA_READONLY;
  });

  afterEach(() => {
    if (savedReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = savedReadOnly;
  });

  /** The refusal a mid-run write must leave by, whichever writer saw it first. */
  async function expectRunRefusal(id: string): Promise<void> {
    const error = await runResearchProject("alice", id).then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).not.toBeNull();
    // `isReadOnlyError` matches on `name`, which is what every door classifies
    // on — a plain `Error` carrying the right words would still be a 500.
    expect(isReadOnlyError(error)).toBe(true);
    expect((error as Error).message).toBe(READ_ONLY_REFUSAL.researchMutate);
    // The mislabel this pins the absence of. "Was replaced." named a lease
    // race that never happened.
    expect((error as Error).message).not.toContain("was replaced");
  }

  it("reports the deployment, not a lost lease, when updateResearchAttempt is refused", async () => {
    // The flip lands inside the SEARCH: the attempt's opening write and the
    // first progress line have already landed, so the next write — the
    // `updateResearchAttempt` that records the collected results — is the
    // first one refused.
    const created = await project();
    mockedSearch.mockImplementation(async () => {
      process.env.YOPEDIA_READONLY = "1";
      return [{
        title: "Launch brief",
        url: "https://example.com/launch/brief",
        snippet: "short excerpt",
      }];
    });

    await expectRunRefusal(created.id);

    // Nothing was written past the refusal: the row is still mid-run, not
    // "failed" (the catch's own write is fail-soft and refused too) and not
    // carrying a synthesis or a Page.
    const stored = await getResearchProject("alice", created.id);
    // The mirror of the `note` case below, and what makes that case's
    // progress assertion a real discriminator rather than a restatement: this
    // run stopped in the QUERY loop, before any source was read, so the
    // standing line is the query narration and never "Reading source 1 of N."
    expect(stored?.progress?.message).toBe("Query 1 of 1: launch evidence");
    expect(stored?.progress?.message).not.toContain("Reading source");
    expect(stored?.status).toBe("collecting");
    expect(stored?.synthesis).toBeUndefined();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("reports the deployment, not a lost lease, when a progress note is refused", async () => {
    // Two fetch targets, and the flip lands inside the FIRST extract. The next
    // attempt-fenced write is the second target's `note` — the narration line,
    // whose catch used to log every fault as "progress update failed" and
    // swallow it, so the run carried on writing into a deployment that had
    // already refused it.
    const created = await project();
    mockedSearch.mockResolvedValue([
      { title: "One", url: "https://example.com/1", snippet: "s" },
      { title: "Two", url: "https://example.com/2", snippet: "s" },
    ]);
    let extracted = 0;
    mockedExtract.mockImplementation(async () => {
      if (extracted++ === 0) process.env.YOPEDIA_READONLY = "1";
      return { title: "Body", content: "BODY" };
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});

    let lines: string[] = [];
    try {
      await expectRunRefusal(created.id);
    } finally {
      // BEFORE `mockRestore`, which clears the recorded calls with it.
      lines = warn.mock.calls.map((call) => String(call[1]));
      warn.mockRestore();
    }

    // The catch did not swallow it into a log line, which is the half of
    // DW-658 the thrown error alone cannot prove. On its own, though, that is
    // a NEGATIVE that would also hold if `note` were never reached at all —
    // and the error `note` throws is byte-identical to `updateResearchAttempt`'s,
    // so the throw cannot say which writer saw the flag.
    expect(lines.some((line) => line.includes("progress update failed"))).toBe(false);
    const stored = await getResearchProject("alice", created.id);
    // The POSITIVE pin. The last write that LANDED is the FIRST target's
    // narration line, written by `note` before the flip — so the run got past
    // every `updateResearchAttempt` and stopped at the second target's `note`.
    // Had `updateResearchAttempt` been the refused writer, the collection line
    // it writes after the search would still be standing here instead.
    expect(stored?.progress).toEqual({
      completedQueries: 1,
      totalQueries: 2,
      message: "Reading source 1 of 2.",
    });
    expect(stored?.status).toBe("collecting");
    expect(stored?.synthesis).toBeUndefined();
    expect(mockedWritePage).not.toHaveBeenCalled();
  });

  it("still reports a genuine lost attempt as a lease race on a WRITABLE deployment", async () => {
    // The control both cases above need: a refusal that fired unconditionally
    // would satisfy them and hide every real lease race. The attempt token is
    // replaced mid-search, so the same writer sees a genuine `null`.
    const created = await project();
    mockedSearch.mockImplementation(async () => {
      await mutateResearchProject("alice", created.id, (current) => {
        current.runAttemptId = "someone-else";
        return current;
      });
      return [{
        title: "Launch brief",
        url: "https://example.com/launch/brief",
        snippet: "short excerpt",
      }];
    });

    const error = await runResearchProject("alice", created.id).then(
      () => null,
      (e: unknown) => e,
    );

    expect(isReadOnlyError(error)).toBe(false);
    expect((error as Error).message).toBe(
      `Research attempt for ${created.id} was replaced.`,
    );
  });
});
