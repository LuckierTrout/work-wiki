import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the OpenNext context. Default: throws (off-Workers) → enqueue no-ops.
// Workers tests opt in by setting a return value with a TASK_QUEUE binding.
vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(() => {
    throw new Error("no cloudflare context");
  }),
}));

import { enqueueTask, enqueueTasks, parseTask } from "../tasks";
import { getCloudflareContext } from "@opennextjs/cloudflare";

const mockGetCfContext = getCloudflareContext as ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks();
  mockGetCfContext.mockImplementation(() => {
    throw new Error("no cloudflare context");
  });
});

describe("enqueueTask", () => {
  it("no-ops (returns false) off the Workers runtime", async () => {
    const ok = await enqueueTask({ kind: "maintain", op: "staleness", slug: "p" });
    expect(ok).toBe(false);
  });

  it("no-ops when the TASK_QUEUE binding is absent on the runtime", async () => {
    mockGetCfContext.mockReturnValue({ env: { AI: {} } }); // no TASK_QUEUE
    const ok = await enqueueTask({ kind: "maintain", op: "staleness", slug: "p" });
    expect(ok).toBe(false);
  });

  it("sends to the queue binding and returns true when bound", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockGetCfContext.mockReturnValue({ env: { TASK_QUEUE: { send } } });

    const task = { kind: "maintain" as const, op: "staleness" as const, slug: "transformers" };
    const ok = await enqueueTask(task);

    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith(task);
  });
});

describe("enqueueTasks", () => {
  it("reports an unavailable queue without claiming work was accepted", async () => {
    await expect(enqueueTasks([
      { kind: "extract-knowledge", slug: "notes", owner: "alice" },
    ])).resolves.toEqual({ available: false, enqueued: 0 });
  });

  it("uses sendBatch and reports the accepted task count", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const sendBatch = vi.fn().mockResolvedValue(undefined);
    mockGetCfContext.mockReturnValue({ env: { TASK_QUEUE: { send, sendBatch } } });
    const tasks = [
      { kind: "extract-knowledge" as const, slug: "notes", owner: "alice" },
      { kind: "extract-knowledge" as const, slug: "decisions", owner: "alice" },
    ];

    await expect(enqueueTasks(tasks)).resolves.toEqual({
      available: true,
      enqueued: 2,
    });
    expect(sendBatch).toHaveBeenCalledWith(tasks.map((body) => ({ body })));
    expect(send).not.toHaveBeenCalled();
  });
});

describe("parseTask", () => {
  it("accepts action-extraction and specialized-agent tasks", () => {
    expect(parseTask({ kind: "extract-actions", slug: "notes", owner: "alice" })).toEqual({
      kind: "extract-actions",
      slug: "notes",
      owner: "alice",
    });
    expect(parseTask({
      kind: "extract-todo-candidates",
      slug: "meet",
      owner: "alice",
      sourcePath: "raw/sources/meet/abc.md",
    })).toEqual({
      kind: "extract-todo-candidates",
      slug: "meet",
      owner: "alice",
      sourcePath: "raw/sources/meet/abc.md",
    });
    expect(parseTask({
      kind: "run-agent",
      agentId: "alice--scout",
      owner: "alice",
      trigger: "after-ingest",
      sourceSlug: "notes",
    })).toEqual({
      kind: "run-agent",
      agentId: "alice--scout",
      owner: "alice",
      trigger: "after-ingest",
      sourceSlug: "notes",
    });
    expect(parseTask({ kind: "run-agent", agentId: "a", owner: "alice", trigger: "hourly" })).toBeNull();
  });

  it("accepts only owner-scoped source-monitor tasks", () => {
    expect(parseTask({
      kind: "monitor-source",
      monitorId: "mon_12345678",
      owner: "alice",
    })).toEqual({ kind: "monitor-source", monitorId: "mon_12345678", owner: "alice" });
    expect(parseTask({ kind: "monitor-source", monitorId: "bad", owner: "alice" })).toBeNull();
    expect(parseTask({ kind: "monitor-source", monitorId: "mon_12345678", owner: "" })).toBeNull();
  });

  it("accepts only owner-scoped monitor-digest delivery tasks", () => {
    expect(parseTask({
      kind: "deliver-monitor-digest",
      digestId: "mdg_1234567890abcdef",
      owner: "alice",
    })).toEqual({
      kind: "deliver-monitor-digest",
      digestId: "mdg_1234567890abcdef",
      owner: "alice",
    });
    expect(parseTask({ kind: "deliver-monitor-digest", digestId: "mdg_bad", owner: "alice" })).toBeNull();
    expect(parseTask({ kind: "deliver-monitor-digest", digestId: "mdg_1234567890abcdef", owner: "" })).toBeNull();
  });

  it("accepts owner-scoped structured-knowledge extraction tasks", () => {
    expect(parseTask({ kind: "extract-knowledge", slug: "notes", owner: "alice" })).toEqual({
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
    });
    expect(parseTask({ kind: "extract-knowledge", slug: "", owner: "alice" })).toBeNull();
    const graphifyJobId = "graphify_12345678-1234-1234-1234-123456789abc";
    expect(parseTask({
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
      graphifyJobId,
    })).toEqual({
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
      graphifyJobId,
    });
    expect(parseTask({
      kind: "extract-knowledge",
      slug: "notes",
      owner: "alice",
      graphifyJobId: "../../bad",
    })).toBeNull();
  });

  it("accepts only valid integration-delivery tasks", () => {
    expect(parseTask({ kind: "deliver-integration", outboxId: "out_1234567890abcdef", owner: "alice" })).toEqual({
      kind: "deliver-integration",
      outboxId: "out_1234567890abcdef",
      owner: "alice",
    });
    expect(parseTask({ kind: "deliver-integration", outboxId: "out_bad", owner: "alice" })).toBeNull();
  });

  it("accepts a run-research delivery and rejects a malformed id", () => {
    expect(parseTask({
      kind: "run-research",
      projectId: "6f1b7e10-0000-4000-8000-000000000001",
      owner: "alice",
    })).toEqual({
      kind: "run-research",
      projectId: "6f1b7e10-0000-4000-8000-000000000001",
      owner: "alice",
    });
    expect(parseTask({ kind: "run-research", projectId: "p1", owner: "alice" })).toBeNull();
    expect(parseTask({ kind: "run-research", projectId: "6f1b7e10-0000-4000-8000-000000000001", owner: "" })).toBeNull();
  });

  it("accepts owner-scoped backup tasks", () => {
    expect(parseTask({ kind: "create-backup", owner: "alice" })).toEqual({ kind: "create-backup", owner: "alice" });
    expect(parseTask({ kind: "create-backup", owner: "" })).toBeNull();
  });

  it("rejects the retired reconcile task kind as malformed (poison)", () => {
    // reconcile-from-talk is retired; such queue messages must parse as
    // malformed (null → 400 poison), never fall through to another handler.
    expect(parseTask({ kind: "reconcile", slug: "p", threadIndex: 0 })).toBeNull();
    expect(
      parseTask({ kind: "reconcile", slug: "p", threadIndex: 3, requestedBy: "alice" }),
    ).toBeNull();
  });

  it("accepts an ingest task with a url or content; rejects neither", () => {
    expect(parseTask({ kind: "ingest", url: "https://x.com" })).toMatchObject({
      kind: "ingest",
      url: "https://x.com",
    });
    expect(parseTask({ kind: "ingest", content: "some text" })).toMatchObject({
      kind: "ingest",
      content: "some text",
    });
    expect(
      parseTask({
        kind: "ingest",
        content: "folder note",
        relativePath: "papers/energy/note.md",
      }),
    ).toMatchObject({
      kind: "ingest",
      content: "folder note",
      relativePath: "papers/energy/note.md",
    });
    expect(parseTask({ kind: "ingest" })).toBeNull();
  });

  it("accepts a canonical stored Source reference without duplicating its body", () => {
    expect(parseTask({
      kind: "ingest",
      sourcePath: "raw/sources/research-example-com-page/abc123.md",
      sourceType: "url",
      sourceUrl: "https://example.com/page",
    })).toMatchObject({
      kind: "ingest",
      sourcePath: "raw/sources/research-example-com-page/abc123.md",
      sourceType: "url",
    });
    expect(parseTask({ kind: "ingest", sourcePath: "../secrets.md" })).toBeNull();
  });

  it("accepts an ingest task with only a staged descriptor (no url/content)", () => {
    expect(
      parseTask({
        kind: "ingest",
        staged: { key: "raw/uploads/job/document.pdf", kind: "pdf", filename: "doc.pdf" },
        jobId: "j1",
      }),
    ).toMatchObject({
      kind: "ingest",
      staged: { key: "raw/uploads/job/document.pdf", kind: "pdf", filename: "doc.pdf" },
      jobId: "j1",
    });
    // text staged kind is also valid (oversized paste).
    expect(
      parseTask({ kind: "ingest", staged: { key: "raw/uploads/j/text.md", kind: "text" } }),
    ).toMatchObject({ kind: "ingest", staged: { key: "raw/uploads/j/text.md", kind: "text" } });
  });

  it("preserves agent ingest fields (pageType, triggeredBy, sourceUrl, sourceType, learningFor)", () => {
    expect(
      parseTask({
        kind: "ingest",
        content: "note",
        owner: "alice--yoyo",
        author: "alice--yoyo",
        triggeredBy: "alice--yoyo",
        pageType: "agent-knowledge",
        sourceUrl: "https://example.com/post",
        sourceType: "text",
        learningFor: "alice--yoyo",
      }),
    ).toMatchObject({
      kind: "ingest",
      pageType: "agent-knowledge",
      triggeredBy: "alice--yoyo",
      sourceUrl: "https://example.com/post",
      sourceType: "text",
      learningFor: "alice--yoyo",
    });
    // Invalid pageType / sourceType, and empty/whitespace string fields, are
    // dropped (not trusted from the queue).
    const bad = parseTask({
      kind: "ingest",
      content: "x",
      pageType: "evil",
      sourceType: "bogus",
      triggeredBy: "",
      sourceUrl: "   ",
      learningFor: "",
    });
    expect(bad).not.toHaveProperty("pageType");
    expect(bad).not.toHaveProperty("sourceType");
    expect(bad).not.toHaveProperty("triggeredBy");
    expect(bad).not.toHaveProperty("sourceUrl");
    expect(bad).not.toHaveProperty("learningFor");
  });

  it("preserves complete email metadata and rejects incoherent email tasks", () => {
    const email = {
      from: "alice@example.com",
      to: "ingest@example.com",
      subject: "Quarterly notes",
      messageId: "<mail-1@example.com>",
      attachmentNames: ["deck.pptx"],
    };
    expect(
      parseTask({
        kind: "ingest",
        content: "Notes",
        sourceType: "email",
        email,
      }),
    ).toMatchObject({ sourceType: "email", email });
    expect(
      parseTask({ kind: "ingest", content: "Notes", sourceType: "email" }),
    ).toBeNull();
    expect(
      parseTask({ kind: "ingest", content: "Notes", sourceType: "text", email }),
    ).toBeNull();
  });

  it("accepts staged email attachments and rejects them on non-email tasks", () => {
    const email = {
      from: "alice@example.com",
      to: "ingest@example.com",
      subject: "Spreadsheet",
      messageId: "<sheet@example.com>",
      attachmentNames: ["sheet.xlsx"],
    };
    expect(parseTask({
      kind: "ingest",
      sourceType: "email",
      email,
      attachments: [{ key: "raw/uploads/j/sheet.xlsx", filename: "sheet.xlsx" }],
    })).toMatchObject({
      sourceType: "email",
      attachments: [{ key: "raw/uploads/j/sheet.xlsx", filename: "sheet.xlsx" }],
    });
    expect(parseTask({
      kind: "ingest",
      content: "x",
      sourceType: "text",
      attachments: [{ key: "raw/uploads/j/sheet.xlsx", filename: "sheet.xlsx" }],
    })).toBeNull();
  });

  it("rejects a malformed staged descriptor", () => {
    // Empty key, bad kind, or non-object → staged dropped; with no url/content → null.
    expect(parseTask({ kind: "ingest", staged: { key: "", kind: "pdf" } })).toBeNull();
    expect(parseTask({ kind: "ingest", staged: { key: "k", kind: "video" } })).toBeNull();
    expect(parseTask({ kind: "ingest", staged: "nope" })).toBeNull();
    // A bad staged but a valid url still parses (staged simply dropped).
    expect(
      parseTask({ kind: "ingest", url: "https://x.com", staged: { key: "", kind: "pdf" } }),
    ).toMatchObject({ kind: "ingest", url: "https://x.com" });
  });

  it("rejects incoherent source combinations (enforced invariant, not branch-order)", () => {
    // `staged` is exclusive — it's its own source; pairing it with url/content is
    // ambiguous (the consumer would silently prefer staged).
    expect(
      parseTask({ kind: "ingest", url: "https://x", staged: { key: "raw/uploads/j/d.pdf", kind: "pdf" } }),
    ).toBeNull();
    expect(
      parseTask({ kind: "ingest", content: "hi", staged: { key: "raw/uploads/j/t.md", kind: "text" } }),
    ).toBeNull();
    // `source` only qualifies a url — a source with no url is inert/incoherent.
    expect(parseTask({ kind: "ingest", content: "hi", source: "pdf" })).toBeNull();
  });

  it("preserves a source discriminator for URL-based pdf/image", () => {
    expect(
      parseTask({ kind: "ingest", url: "https://x/a.pdf", source: "pdf" }),
    ).toMatchObject({ kind: "ingest", url: "https://x/a.pdf", source: "pdf" });
    expect(
      parseTask({ kind: "ingest", url: "https://x/a.png", source: "image" }),
    ).toMatchObject({ kind: "ingest", url: "https://x/a.png", source: "image" });
    // An unknown source value is dropped, not preserved.
    expect(parseTask({ kind: "ingest", url: "https://x.com", source: "audio" })).not.toHaveProperty(
      "source",
    );
  });

  it("preserves a jobId on an ingest task (async status tracking)", () => {
    expect(
      parseTask({ kind: "ingest", url: "https://youtu.be/x", jobId: "job-1" }),
    ).toMatchObject({ kind: "ingest", url: "https://youtu.be/x", jobId: "job-1" });
    // No jobId → absent (not undefined-key noise).
    expect(parseTask({ kind: "ingest", url: "https://x.com" })).not.toHaveProperty(
      "jobId",
    );
  });

  it("accepts maintain tasks; retired/bad ops are rejected", () => {
    expect(parseTask({ kind: "maintain", op: "staleness", slug: "p" })).toEqual({
      kind: "maintain",
      op: "staleness",
      slug: "p",
    });
    // The retired reconcile op, or a bad op, is rejected (poison).
    expect(
      parseTask({ kind: "maintain", op: "reconcile", slug: "p", threadIndex: 1 }),
    ).toBeNull();
    expect(parseTask({ kind: "maintain", op: "bogus", slug: "p" })).toBeNull();
    expect(parseTask({ kind: "maintain", op: "staleness", slug: "" })).toBeNull();
  });

  it("accepts maintain:fix only with an allowed (deterministic) lintType", () => {
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "unmigrated-page" }),
    ).toEqual({ kind: "maintain", op: "fix", slug: "p", lintType: "unmigrated-page" });
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "supersedes-dangling" }),
    ).toMatchObject({ op: "fix", lintType: "supersedes-dangling" });
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "orphan-page" }),
    ).toEqual({ kind: "maintain", op: "fix", slug: "p", lintType: "orphan-page" });
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "empty-page" }),
    ).toEqual({ kind: "maintain", op: "fix", slug: "p", lintType: "empty-page" });
    // A non-deterministic / unknown lint type (or none) is rejected.
    expect(parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "contradictions" })).toBeNull();
    expect(parseTask({ kind: "maintain", op: "fix", slug: "p" })).toBeNull();
  });

  it("accepts maintain:fix broken-link only with a targetSlug", () => {
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "broken-link", targetSlug: "dead" }),
    ).toEqual({
      kind: "maintain",
      op: "fix",
      slug: "p",
      lintType: "broken-link",
      targetSlug: "dead",
    });
    // broken-link without targetSlug is rejected.
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "broken-link" }),
    ).toBeNull();
    // broken-link with an empty targetSlug is rejected.
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "broken-link", targetSlug: "" }),
    ).toBeNull();
    expect(
      parseTask({ kind: "maintain", op: "fix", slug: "p", lintType: "broken-link", targetSlug: "  " }),
    ).toBeNull();
  });

  it("rejects unknown kinds and non-objects", () => {
    expect(parseTask({ kind: "nope" })).toBeNull();
    expect(parseTask(null)).toBeNull();
    expect(parseTask("string")).toBeNull();
    expect(parseTask(42)).toBeNull();
  });

  it("preserves vaultId on an ingest task when present", () => {
    expect(
      parseTask({ kind: "ingest", url: "https://example.com", vaultId: "tenant--my-vault" }),
    ).toMatchObject({ kind: "ingest", url: "https://example.com", vaultId: "tenant--my-vault" });
  });

  it("strips vaultId when empty or non-string", () => {
    expect(
      parseTask({ kind: "ingest", url: "https://example.com", vaultId: "" }),
    ).not.toHaveProperty("vaultId");
    expect(
      parseTask({ kind: "ingest", url: "https://example.com", vaultId: "   " }),
    ).not.toHaveProperty("vaultId");
    expect(
      parseTask({ kind: "ingest", url: "https://example.com", vaultId: 42 }),
    ).not.toHaveProperty("vaultId");
  });

  it("omits vaultId from the parsed task when not provided", () => {
    expect(parseTask({ kind: "ingest", url: "https://x.com" })).not.toHaveProperty("vaultId");
  });
});

// ---------------------------------------------------------------------------
// The guidance handle must not cross the queue (DW-396)
// ---------------------------------------------------------------------------

import { createGuidanceCache } from "../guidance-cache";
import type { IngestOptions } from "../ingest";
import type { Task } from "../tasks";

/**
 * `IngestOptions.guidanceCache` is a live pair of `Map`s, so a queue message
 * carrying one dies in `structuredClone` at `send()` time. Before DW-396 the
 * only thing keeping it off the wire was that every route hand-writes its
 * payload literal separately from its `ingestOptions` object — a convention,
 * not a rule, because TypeScript does not excess-property-check a SPREAD.
 *
 * `guidanceCache?: never` on the `kind: "ingest"` variant turns that convention
 * into a compile error. These two tests pin it in BOTH directions: the spread
 * that used to compile now must not, and the shapes routes actually write must
 * still compile untouched. The runtime half lives in `ingest-routes.test.ts`
 * ("keeps the handle out of the queued task payload").
 *
 * `sourceType` is `Omit`ted because it is independently incompatible — the
 * options union is wider than the queue's (image/youtube are set internally and
 * never travel) — and leaving it in would make the assignment fail for a reason
 * that has nothing to do with the guard under test.
 */
describe("ingest Task payload (DW-396)", () => {
  it("makes spreading a live guidance handle onto the payload a compile error", async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    mockGetCfContext.mockReturnValue({ env: { TASK_QUEUE: { send } } });

    const ingestOptions: Omit<IngestOptions, "sourceType"> = {
      author: "alice",
      owner: "alice",
      triggeredBy: "alice",
      guidanceCache: createGuidanceCache(),
    };

    const ok = await enqueueTask(
      // @ts-expect-error DW-396: `guidanceCache?: never` on the ingest Task
      // variant rejects a spread that carries the live handle. This is the
      // exact call shape that used to compile and then die in
      // `structuredClone` at `send()` time. Removing the field from the
      // variant turns this line into an unused-directive error.
      { kind: "ingest", url: "https://example.com/a", ...ingestOptions },
    );

    // The call still goes THROUGH to the binding — the guard is compile-time
    // only and strips nothing, which is why the runtime assertion in
    // `ingest-routes.test.ts` is kept alongside it rather than replaced by it.
    //
    // Deliberately NOT asserted: that the payload still carries the handle.
    // Pinning today's leak as expected behaviour would make a future runtime
    // strip — an improvement — fail here as though it were a regression.
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("still accepts the same options spread once the handle is gone", () => {
    const { guidanceCache: _handle, ...serializable } = {
      author: "alice",
      owner: "alice",
      triggeredBy: "alice",
      guidanceCache: createGuidanceCache(),
    } satisfies Omit<IngestOptions, "sourceType">;

    const task: Task = {
      kind: "ingest",
      url: "https://example.com/a",
      ...serializable,
    };

    expect(task).toMatchObject({ kind: "ingest", owner: "alice" });
    expect(task).not.toHaveProperty("guidanceCache");
  });

  it("leaves the hand-written route literals compiling unchanged", () => {
    // The exact shape `POST /api/ingest/batch` enqueues.
    const task: Task = {
      kind: "ingest",
      url: "https://example.com/a",
      owner: "alice",
      author: "alice",
      tags: ["research"],
      vaultId: "tenant--my-vault",
    };
    expect(task).not.toHaveProperty("guidanceCache");
  });
});
