/**
 * Create → /run → parseTask → /api/tasks/run → runtime, against real
 * project storage. Search, LLM, and the Page writer stay mocked; the
 * HTTP doors and the consumer dispatch do not.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
  getServicePrincipal: vi.fn(),
}));
vi.mock("@/lib/research-providers", () => ({
  searchResearchProvider: vi.fn(),
  extractResearchSourceText: vi.fn(async () => ({
    title: "Launch brief",
    content: "THE WHOLE PAGE BODY.",
  })),
  resolveResearchProvider: vi.fn(() => "tavily"),
  selectResearchProvider: vi.fn(() => "tavily"),
  availableResearchProviders: vi.fn(() => ["tavily"]),
  RESEARCH_SNIPPET_MAX: 4_000,
  ResearchProviderUnconfiguredError: class extends Error {
    provider: string;
    constructor(provider: string) {
      super(`Deep Research is set to ${provider}, which has no credential.`);
      this.name = "ResearchProviderUnconfiguredError";
      this.provider = provider;
    }
  },
}));
vi.mock("@/lib/llm", () => ({
  callLLM: vi.fn(),
  callLLMStream: vi.fn(async () => {
    throw new Error("stream unavailable in unit tests");
  }),
  hasLLMKey: vi.fn(() => true),
}));
vi.mock("@/lib/lifecycle", () => ({ writeWikiPageWithSideEffects: vi.fn() }));
vi.mock("@/lib/schema", () => ({ loadPageConventions: vi.fn(async () => "") }));
vi.mock("@/lib/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/tasks")>();
  return { ...actual, enqueueTask: vi.fn(async () => true) };
});

import { POST as POST_RESEARCH } from "@/app/api/research/route";
import { POST as POST_RUN } from "@/app/api/research/[id]/run/route";
import { POST as POST_TASK } from "@/app/api/tasks/run/route";
import { getPrincipal, getServicePrincipal } from "@/lib/auth";
import { writeWikiPageWithSideEffects } from "@/lib/lifecycle";
import { callLLM } from "@/lib/llm";
import { _resetLocks } from "@/lib/lock";
import { getResearchProject } from "@/lib/research-projects";
import { searchResearchProvider } from "@/lib/research-providers";
import { _resetStorage } from "@/lib/storage";
import { enqueueTask, parseTask } from "@/lib/tasks";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedService = vi.mocked(getServicePrincipal);
const mockedSearch = vi.mocked(searchResearchProvider);
const mockedLLM = vi.mocked(callLLM);
const mockedWritePage = vi.mocked(writeWikiPageWithSideEffects);
const mockedEnqueue = vi.mocked(enqueueTask);

let tmpDir: string;
let original: Record<string, string | undefined> = {};
const ENV_KEYS = ["DATA_DIR", "WIKI_DIR", "RAW_DIR", "YOPEDIA_READONLY"] as const;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "research-delivery-"));
  original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ handle: "alice" } as Awaited<ReturnType<typeof getPrincipal>>);
  mockedService.mockReturnValue({ id: "service:alice", handle: "alice" } as ReturnType<typeof getServicePrincipal>);
  mockedEnqueue.mockResolvedValue(true);
  mockedWritePage.mockImplementation(async ({ slug }) => ({ slug, updatedSlugs: [] }));
  mockedSearch.mockResolvedValue([{
    title: "Launch brief",
    url: "https://example.com/launch/brief",
    snippet: "short excerpt",
    content: "THE WHOLE PAGE BODY.",
  }]);
  mockedLLM.mockResolvedValue("# Launch evidence\n\nA brief.");
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

describe("research delivery path", () => {
  it("creates, queues, parses, and runs through the task consumer door", async () => {
    const created = await POST_RESEARCH(new Request("http://localhost/api/research", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: "Launch evidence",
        question: "What supports the launch date?",
        queries: ["launch evidence"],
      }),
    }));
    expect(created.status).toBe(201);
    const { project } = await created.json() as { project: { id: string } };

    const queued = await POST_RUN(
      new Request(`http://localhost/api/research/${project.id}/run`, { method: "POST" }),
      { params: Promise.resolve({ id: project.id }) },
    );
    expect(queued.status).toBe(202);
    expect(mockedEnqueue).toHaveBeenCalledWith({
      kind: "run-research",
      projectId: project.id,
      owner: "alice",
    });

    const task = parseTask(mockedEnqueue.mock.calls[0][0]);
    expect(task).toEqual({ kind: "run-research", projectId: project.id, owner: "alice" });

    const consumed = await POST_TASK(new Request("http://localhost/api/tasks/run", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Yopedia-Queue-Attempt": "1",
      },
      body: JSON.stringify(task),
    }));
    expect(consumed.status).toBe(200);
    expect(mockedWritePage).toHaveBeenCalledTimes(1);
    expect((await getResearchProject("alice", project.id))?.status).toBe("complete");
  });
});
