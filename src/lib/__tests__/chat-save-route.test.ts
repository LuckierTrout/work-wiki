import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/query", () => ({ saveAnswerToWiki: vi.fn() }));
vi.mock("@/lib/raw", () => ({ saveRawSourceFor: vi.fn() }));
vi.mock("@/lib/ingest-async", () => ({ enqueueOrInline: vi.fn() }));
vi.mock("@/lib/ingest", () => ({ ingest: vi.fn() }));
vi.mock("@/lib/ingest-jobs", () => ({ createIngestJob: vi.fn() }));
vi.mock("@/lib/chat", async (original) => ({
  ...(await original<typeof import("@/lib/chat")>()),
  getChatConversation: vi.fn(),
}));

import { POST as saveAnswer } from "@/app/api/chat/conversations/[id]/save/route";
import { getPrincipal } from "@/lib/auth";
import { getChatConversation } from "@/lib/chat";
import { enqueueOrInline } from "@/lib/ingest-async";
import { ingest } from "@/lib/ingest";
import { saveAnswerToWiki } from "@/lib/query";
import { saveRawSourceFor } from "@/lib/raw";

const conversation = {
  id: "c1",
  title: "Cited turn",
  messages: [
    {
      id: "u1",
      role: "user" as const,
      content: "What is alpha?",
      sources: [],
      createdAt: "2026-08-23T00:00:00.000Z",
    },
    {
      id: "a-old",
      role: "assistant" as const,
      content: "Old answer [1].",
      citations: [{ n: 1, path: "wiki/old.md", title: "Old", type: "page" }],
      sources: ["wiki/old.md"],
      createdAt: "2026-08-23T00:00:00.000Z",
    },
    {
      id: "a-save",
      role: "assistant" as const,
      content: "Alpha [1] from the transcript [2].",
      citations: [
        { n: 1, path: "wiki/queries/cited-answer.md", title: "Cited", type: "page" },
        { n: 2, path: "raw/sources/meet/cafe01.md", title: "Meet", type: "source" },
      ],
      sources: ["wiki/queries/cited-answer.md", "raw/sources/meet/cafe01.md"],
      createdAt: "2026-08-23T00:00:01.000Z",
    },
  ],
  createdAt: "2026-08-23T00:00:00.000Z",
  updatedAt: "2026-08-23T00:00:01.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getPrincipal).mockResolvedValue({ id: "alice", handle: "alice" } as never);
  vi.mocked(getChatConversation).mockResolvedValue(conversation as never);
  vi.mocked(saveAnswerToWiki).mockResolvedValue({ slug: "queries/cited-turn" });
  vi.mocked(saveRawSourceFor).mockResolvedValue(undefined as never);
  vi.mocked(enqueueOrInline).mockResolvedValue({
    ok: true,
    json: async () => ({ queued: true, jobId: "job-1" }),
  } as never);
});

describe("Save uses the named assistant message and keeps Source paths", () => {
  it("saves that message's content and both wiki and raw provenance", async () => {
    const response = await saveAnswer(
      new Request("http://local/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messageId: "a-save",
          content: "Client-forged text [1].",
        }),
      }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(200);
    expect(vi.mocked(saveAnswerToWiki)).toHaveBeenCalledWith(
      "Cited turn",
      expect.stringContaining("Alpha [1] from the transcript [2]."),
      undefined,
      ["queries/cited-answer"],
      "markdown",
      "alice",
      "alice",
      expect.objectContaining({ conversationId: "c1", underQueries: true }),
    );
    const savedBody = vi.mocked(saveAnswerToWiki).mock.calls[0]?.[1] as string;
    expect(savedBody).toContain("raw/sources/meet/cafe01.md");
    expect(savedBody).not.toContain("Client-forged");
    const task = vi.mocked(enqueueOrInline).mock.calls[0]?.[1] as {
      jobId?: string;
    };
    expect(task.jobId).toEqual(expect.any(String));
    const inline = vi.mocked(enqueueOrInline).mock.calls[0]?.[2] as () => Promise<unknown>;
    await inline();
    expect(vi.mocked(ingest)).toHaveBeenCalledWith(
      "Cited turn",
      expect.any(String),
      expect.objectContaining({ jobId: task.jobId }),
    );
  });

  it("returns 202 queued:false when Ingest dispatch is rejected after the page write", async () => {
    vi.mocked(enqueueOrInline).mockResolvedValue({
      ok: false,
      json: async () => ({ error: "queue down" }),
    } as never);
    const response = await saveAnswer(
      new Request("http://local/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId: "a-save" }),
      }),
      { params: Promise.resolve({ id: "c1" }) },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({
        slug: "queries/cited-turn",
        queued: false,
      }),
    );
    expect(vi.mocked(saveAnswerToWiki)).toHaveBeenCalled();
  });
});
