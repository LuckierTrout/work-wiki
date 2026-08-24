import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyIngestAnalysis, parseIngestAnalysis, saveIngestAnalysis, loadIngestAnalysis } from "../ingest-analysis";
import { _resetLocks } from "../lock";
import {
  CorruptReviewStoreError,
  ReviewQueueFullError,
  ReviewDeliveryUnretainedError,
  createPageFromReview,
  enqueueReviewAfterIngest,
  enqueueReviewFromAnalysis,
  listReviewItems,
  mapModelAction,
  pendingReviewCount,
  rememberReviewOutbox,
  reviewItemsFromAnalysis,
  skipReviewItem,
} from "../review-queue";
import { getStorage, _resetStorage } from "../storage";
import { ensureDirectories, listWikiPages, readWikiPage, tenantForOwner } from "../wiki";
import * as lifecycle from "../lifecycle";
import { createWiki } from "../wikis";

let tmpDir: string;
let originalDataDir: string | undefined;
let originalReadOnly: string | undefined;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-queue-"));
  originalDataDir = process.env.DATA_DIR;
  originalReadOnly = process.env.YOPEDIA_READONLY;
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.DATA_DIR = tmpDir;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  delete process.env.YOPEDIA_READONLY;
  _resetLocks();
  _resetStorage();
  await ensureDirectories();
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe("mapModelAction", () => {
  it("maps Accept, Reject, and Revise to skip", () => {
    expect(mapModelAction("Accept")).toBe("skip");
    expect(mapModelAction("reject")).toBe("skip");
    expect(mapModelAction("Revise")).toBe("skip");
    expect(mapModelAction("create page")).toBe("keep");
    expect(mapModelAction("deep research")).toBe("keep");
  });
});

describe("reviewItemsFromAnalysis", () => {
  it("drops extra model actions instead of enqueueing Accept/Reject/Revise", () => {
    const items = reviewItemsFromAnalysis(
      {
        ...emptyIngestAnalysis(),
        reviewItems: [
          { title: "Accept this", action: "Accept" },
          { title: "Need a page", action: "create page", kind: "lightbulb" },
        ],
      },
      "topic",
    );
    expect(items.map((item) => item.title)).toEqual(["Need a page"]);
    expect(items[0]?.path).toBe("wiki/topic.md");
  });
});

describe("review queue persistence", () => {
  it("keeps pending items across a storage reset and hides skipped ones", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: {
        ...emptyIngestAnalysis(),
        tensions: ["Sources disagree about the deadline."],
      },
    });
    expect(created).toHaveLength(1);
    expect(await listReviewItems("alice")).toHaveLength(1);

    _resetStorage();
    const afterRestart = await listReviewItems("alice");
    expect(afterRestart).toHaveLength(1);
    expect(afterRestart[0]?.title).toContain("deadline");

    await skipReviewItem("alice", afterRestart[0]!.id);
    expect(await listReviewItems("alice")).toEqual([]);

    _resetStorage();
    expect(await listReviewItems("alice")).toEqual([]);
  });

  it("keeps a legacy unscoped row visible under every explicit Wiki scope", async () => {
    const [created] = await enqueueReviewFromAnalysis("alice", {
      pageSlug: "legacy",
      analysis: {
        ...emptyIngestAnalysis(),
        tensions: ["Legacy unscoped decision."],
      },
    });
    expect((await listReviewItems("alice", "wiki-a")).map((item) => item.id)).toEqual([
      created.id,
    ]);
    expect((await listReviewItems("alice", "wiki-b")).map((item) => item.id)).toEqual([
      created.id,
    ]);
  });

  it("falls through to tensions when every model draft maps to Skip", () => {
    const items = reviewItemsFromAnalysis(
      {
        ...emptyIngestAnalysis(),
        reviewItems: [{ title: "Accept this", action: "Accept" }],
        tensions: ["Sources still disagree."],
      },
      "topic",
    );
    expect(items.map((item) => item.title)).toEqual(["Sources still disagree."]);
  });

  it("keeps a Review path inside wiki/ even when the draft walks parent dirs", () => {
    const items = reviewItemsFromAnalysis(
      {
        ...emptyIngestAnalysis(),
        reviewItems: [{ title: "Need a page", path: "wiki/../../etc/passwd" }],
      },
      "topic",
    );
    expect(items[0]?.path).toBe("wiki/passwd.md");
  });

  it("round-trips searchQueries and enqueues a lightbulb when that is all analysis has", async () => {
    await saveIngestAnalysis("job-q", {
      ...emptyIngestAnalysis(),
      searchQueries: ["What is the deadline?"],
    });
    const loaded = await loadIngestAnalysis("job-q");
    expect(loaded?.searchQueries).toEqual(["What is the deadline?"]);
    expect(parseIngestAnalysis(JSON.parse(JSON.stringify(loaded)))?.searchQueries).toEqual([
      "What is the deadline?",
    ]);
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: loaded!,
    });
    expect(created).toHaveLength(1);
    expect(created[0]?.kind).toBe("lightbulb");
    expect(created[0]?.queries).toEqual(["What is the deadline?"]);
  });

  it("Create Page writes through lifecycle and leaves the queue", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: {
        ...emptyIngestAnalysis(),
        tensions: ["Need a judgment page."],
      },
    });
    const result = await createPageFromReview("alice", created[0]!.id, "alice");
    expect(result?.slug).toBeTruthy();
    const page = await readWikiPage(result!.slug);
    expect(page?.content).toContain("# Need a judgment page.");
    expect(page?.content).toContain("owner: alice");
    expect(page?.content).toContain("sources: [\"wiki/topic.md\"]");
    expect(page?.content).toContain("Created from Review of wiki/topic.md");
    expect(await listReviewItems("alice")).toEqual([]);
  });

  it("lists only the current Wiki's pending cards", async () => {
    await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["A card."] },
    });
    await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-b",
      pageSlug: "other",
      analysis: { ...emptyIngestAnalysis(), tensions: ["B card."] },
    });
    const a = await listReviewItems("alice", "wiki-a");
    const b = await listReviewItems("alice", "wiki-b");
    expect(a.map((item) => item.title)).toEqual(["A card."]);
    expect(b.map((item) => item.title)).toEqual(["B card."]);
  });

  it("does not claim a new item was created when the pending cap is full", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: `cap-${index}`,
      kind: "warning" as const,
      title: `Card ${index}`,
      summary: "cap",
      path: `wiki/page-${index}.md`,
      queries: [],
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      pageSlug: `page-${index}`,
      wikiId: "current",
    }));
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items }, null, 2),
    );
    await expect(enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "overflow",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Overflow card."] },
    })).rejects.toBeInstanceOf(ReviewQueueFullError);
    expect(await listReviewItems("alice")).toHaveLength(500);
  });

  it("counts creating claims as active capacity and keeps them out of terminal retention", async () => {
    const base = Date.parse("2026-08-23T00:00:00.000Z");
    const pending = Array.from({ length: 499 }, (_, index) => ({
      id: `pending-${index}`,
      kind: "warning" as const,
      title: `Pending ${index}`,
      summary: "pending",
      path: `wiki/pending-${index}.md`,
      queries: [],
      status: "pending" as const,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
    }));
    const creating = {
      id: "creating-live",
      kind: "warning" as const,
      title: "Creating",
      summary: "creating",
      path: "wiki/creating.md",
      queries: [],
      status: "creating" as const,
      createdAt: new Date(base).toISOString(),
      updatedAt: new Date(base).toISOString(),
      pageSlug: "creating",
      operationId: "creating-op",
      claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    };
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items: [creating, ...pending] }),
    );
    await expect(enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "overflow-active",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Overflow active."] },
    })).rejects.toBeInstanceOf(ReviewQueueFullError);
    const stored = JSON.parse(await getStorage().readFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
    )) as { items: Array<{ id: string; status: string }> };
    expect(stored.items.find((item) => item.id === "creating-live")?.status).toBe("creating");
  });

  it("retains the newest terminal rows while preserving a live creating claim", async () => {
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const terminals = Array.from({ length: 201 }, (_, index) => ({
      id: `done-${index}`,
      kind: "warning" as const,
      title: `Done ${index}`,
      summary: "done",
      path: `wiki/done-${index}.md`,
      queries: [],
      status: "skipped" as const,
      createdAt: new Date(base + index * 1_000).toISOString(),
      updatedAt: new Date(base + index * 1_000).toISOString(),
    }));
    const now = new Date().toISOString();
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items: [
        ...terminals,
        {
          id: "retained-create",
          kind: "warning",
          title: "Creating",
          summary: "creating",
          path: "wiki/creating.md",
          queries: [],
          status: "creating",
          createdAt: now,
          updatedAt: now,
          pageSlug: "creating",
          operationId: "retained-op",
          claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
        {
          id: "finish-me",
          kind: "warning",
          title: "Finish",
          summary: "finish",
          path: "wiki/finish.md",
          queries: [],
          status: "pending",
          createdAt: now,
          updatedAt: now,
        },
      ] }),
    );
    await skipReviewItem("alice", "finish-me");
    const stored = JSON.parse(await getStorage().readFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
    )) as { items: Array<{ id: string; status: string }> };
    expect(stored.items.filter((item) => item.status === "creating")).toHaveLength(1);
    expect(stored.items.filter((item) => item.status === "skipped")).toHaveLength(200);
    expect(stored.items.some((item) => item.id === "done-0")).toBe(false);
    expect(stored.items.some((item) => item.id === "finish-me")).toBe(true);
  });

  it("fails closed on corrupt queue JSON instead of treating it as empty", async () => {
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      "{not-json",
    );
    await expect(listReviewItems("alice")).rejects.toBeInstanceOf(CorruptReviewStoreError);
  });

  it("treats one malformed row as store corruption and quarantines the exact bytes", async () => {
    const queue = `tenants/${tenantForOwner("alice")}/review-queue.json`;
    const raw = JSON.stringify({ items: [{ nope: true }] });
    await getStorage().writeFile(queue, raw);
    await expect(listReviewItems("alice")).rejects.toBeInstanceOf(CorruptReviewStoreError);
    const tenantDir = path.join(tmpDir, "tenants", tenantForOwner("alice"));
    const names = await fs.readdir(tenantDir);
    const quarantine = names.find((name) => name.startsWith("review-queue.json.corrupt-"));
    expect(quarantine).toBeTruthy();
    expect(await fs.readFile(path.join(tenantDir, quarantine!), "utf8")).toBe(raw);
  });

  it("does not mutate recovery, outbox, or quarantine state on a read-only list", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({
        items: [{
          id: "leased",
          kind: "warning",
          title: "Leased",
          summary: "Leased",
          path: "wiki/leased.md",
          queries: [],
          status: "creating",
          createdAt: now,
          updatedAt: now,
          pageSlug: "leased",
          operationId: "op-leased",
          claimExpiresAt: now,
        }],
      }),
    );
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-outbox.json`,
      JSON.stringify({ items: [{ wikiId: "current", pageSlug: "x", jobId: "j", createdAt: now }] }),
    );
    const storage = getStorage();
    const writes = [
      vi.spyOn(storage, "writeFile"),
      vi.spyOn(storage, "writeFileIfAbsent"),
      vi.spyOn(storage, "writeFileIfMatch"),
    ];
    process.env.YOPEDIA_READONLY = "1";
    const listed = await listReviewItems("alice");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.id).toBe("leased");
    expect(listed[0]?.status).toBe("creating");
    for (const write of writes) expect(write).not.toHaveBeenCalled();
  });

  it("rolls Create Page back to pending and clears the claimed slug", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Need a judgment page."] },
    });
    const spy = vi
      .spyOn(lifecycle, "writeWikiPageWithSideEffects")
      .mockRejectedValueOnce(new Error("disk full"));
    await expect(createPageFromReview("alice", created[0]!.id, "alice")).rejects.toThrow("disk full");
    spy.mockRestore();
    const items = await listReviewItems("alice");
    expect(items).toHaveLength(1);
    expect(items[0]?.status).toBe("pending");
    expect(items[0]?.pageSlug).toBeUndefined();
    expect(items[0]?.path).toBe("wiki/topic.md");
  });

  it("does not reuse a reserved or already-written slug", async () => {
    const first = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic-a",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Overview"] },
    });
    const second = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic-b",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Overview"] },
    });
    const a = await createPageFromReview("alice", first[0]!.id, "alice");
    const b = await createPageFromReview("alice", second[0]!.id, "alice");
    expect(a?.slug).toBeTruthy();
    expect(b?.slug).toBeTruthy();
    expect(a!.slug).not.toBe("overview");
    expect(b!.slug).not.toBe(a!.slug);
    expect(await readWikiPage(a!.slug)).toBeTruthy();
    expect(await readWikiPage(b!.slug)).toBeTruthy();
  });

  it("writes no items when analysis has no tensions, queries, or review drafts", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "quiet",
      analysis: emptyIngestAnalysis(),
    });
    expect(created).toEqual([]);
    expect(await listReviewItems("alice")).toEqual([]);
  });

  it("keeps same-title cards on different Wikis and filters counts independently", async () => {
    await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Shared title."] },
    });
    await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-b",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Shared title."] },
    });
    expect(await pendingReviewCount("alice", "wiki-a")).toBe(1);
    expect(await pendingReviewCount("alice", "wiki-b")).toBe(1);
    const a = await listReviewItems("alice", "wiki-a");
    expect(await skipReviewItem("alice", a[0]!.id, "wiki-b")).toBeNull();
    expect(await createPageFromReview("alice", a[0]!.id, "alice", "wiki-b")).toBeNull();
    await skipReviewItem("alice", a[0]!.id);
    expect(await listReviewItems("alice", "wiki-a")).toEqual([]);
    expect(await listReviewItems("alice", "wiki-b")).toHaveLength(1);
  });

  it("does not lose concurrent first-creates", async () => {
    const [first, second] = await Promise.all([
      enqueueReviewFromAnalysis("alice", {
        wikiId: "current",
        pageSlug: "one",
        analysis: { ...emptyIngestAnalysis(), tensions: ["First card."] },
      }),
      enqueueReviewFromAnalysis("alice", {
        wikiId: "current",
        pageSlug: "two",
        analysis: { ...emptyIngestAnalysis(), tensions: ["Second card."] },
      }),
    ]);
    expect([...first, ...second]).toHaveLength(2);
    expect(await listReviewItems("alice")).toHaveLength(2);
  });

  it("recovers a creating card without a Page so Create Page can retry", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({
        items: [
          {
            id: "stuck-create",
            kind: "warning",
            title: "Need a judgment page.",
            summary: "Need a judgment page.",
            path: "wiki/claimed.md",
            queries: [],
            status: "creating",
            createdAt: now,
            updatedAt: now,
            pageSlug: "claimed",
            wikiId: "current",
            sourcePath: "wiki/topic.md",
          },
        ],
      }),
    );
    const listed = await listReviewItems("alice");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("pending");
    expect(listed[0]?.pageSlug).toBeUndefined();
    expect(listed[0]?.path).toBe("wiki/topic.md");
    const result = await createPageFromReview("alice", "stuck-create", "alice");
    expect(result?.slug).toBeTruthy();
    expect(await readWikiPage(result!.slug)).toBeTruthy();
    expect(await listReviewItems("alice")).toEqual([]);
  });

  it("leaves a live Create Page lease claimed and refuses competing actions", async () => {
    const now = new Date().toISOString();
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items: [{
        id: "live-claim",
        kind: "warning",
        title: "Live claim",
        summary: "Live claim",
        path: "wiki/live-claim.md",
        queries: [],
        status: "creating",
        createdAt: now,
        updatedAt: now,
        pageSlug: "live-claim",
        operationId: "live-operation",
        claimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        wikiId: "wiki-a",
      }] }),
    );
    const listed = await listReviewItems("alice", "wiki-a");
    expect(listed).toHaveLength(1);
    expect(listed[0]?.status).toBe("creating");
    expect(await skipReviewItem("alice", "live-claim", "wiki-a")).toBeNull();
    expect(await createPageFromReview("alice", "live-claim", "alice", "wiki-a")).toBeNull();
    expect((await getReviewItemForTest("alice", "live-claim"))?.status).toBe("creating");
  });

  it("marks a creating card created when the Page write already landed", async () => {
    const operationId = "review-op-landed";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/wiki/already-written.md`,
      `---\nowner: alice\nreview_operation_id: ${operationId}\n---\n\n# Already written\n\nbody`,
    );
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({
        items: [
          {
            id: "landed-create",
            kind: "warning",
            title: "Already written",
            summary: "Already written",
            path: "wiki/already-written.md",
            queries: [],
            status: "creating",
            createdAt: now,
            updatedAt: now,
            pageSlug: "already-written",
            wikiId: "current",
            sourcePath: "wiki/topic.md",
            operationId,
            claimExpiresAt: "2026-08-23T00:00:01.000Z",
          },
        ],
      }),
    );
    expect(await listReviewItems("alice")).toEqual([]);
    const result = await createPageFromReview("alice", "landed-create", "alice");
    expect(result?.slug).toBe("already-written");
    expect(result?.item.status).toBe("created");
  });

  it("does not mistake an unrelated Page for a completed Review operation", async () => {
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/wiki/claimed.md`,
      "---\nowner: alice\nreview_operation_id: other-op\n---\n\n# Unrelated\n",
    );
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items: [{
        id: "mismatched-claim",
        kind: "warning",
        title: "Claimed",
        summary: "Claimed",
        path: "wiki/claimed.md",
        queries: [],
        status: "creating",
        createdAt: now,
        updatedAt: now,
        pageSlug: "claimed",
        operationId: "our-op",
        claimExpiresAt: now,
        sourcePath: "wiki/topic.md",
      }] }),
    );
    const listed = await listReviewItems("alice");
    expect(listed[0]?.status).toBe("pending");
    expect(await getStorage().readFile(`tenants/${tenantForOwner("alice")}/wiki/claimed.md`))
      .toContain("# Unrelated");
  });

  it("keeps recovering other creating cards when one claim read throws", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({
        items: [
          {
            id: "boom",
            kind: "warning",
            title: "Boom",
            summary: "Boom",
            path: "wiki/boom.md",
            queries: [],
            status: "creating",
            createdAt: now,
            updatedAt: now,
            pageSlug: "boom",
            operationId: "op-boom",
            claimExpiresAt: now,
            sourcePath: "wiki/topic-a.md",
          },
          {
            id: "ok",
            kind: "warning",
            title: "Ok",
            summary: "Ok",
            path: "wiki/ok.md",
            queries: [],
            status: "creating",
            createdAt: now,
            updatedAt: now,
            pageSlug: "ok",
            operationId: "op-ok",
            claimExpiresAt: now,
            sourcePath: "wiki/topic-b.md",
          },
        ],
      }),
    );
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (filePath) => {
      if (String(filePath).includes("/wiki/boom.md")) throw new Error("R2 read flaked");
      return originalRead(filePath);
    });
    const listed = await listReviewItems("alice");
    expect(listed.find((item) => item.id === "ok")?.status).toBe("pending");
    expect((await getReviewItemForTest("alice", "boom"))?.status).toBe("creating");
  });

  it("marks created when the Page landed after recovery reset the claim", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Landed after reset."] },
    });
    const spy = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects").mockImplementationOnce(
      async (opts) => {
        await getStorage().writeFile(
          `tenants/${tenantForOwner("alice")}/wiki/${opts.slug}.md`,
          opts.content,
        );
        const queuePath = `tenants/${tenantForOwner("alice")}/review-queue.json`;
        const store = JSON.parse(await getStorage().readFile(queuePath)) as {
          items: Array<Record<string, unknown>>;
        };
        const row = store.items.find((item) => item.id === created[0]!.id);
        if (row) {
          row.status = "pending";
          delete row.pageSlug;
          delete row.operationId;
          delete row.claimExpiresAt;
        }
        await getStorage().writeFile(queuePath, JSON.stringify(store));
        return { slug: opts.slug, updatedSlugs: [] };
      },
    );
    const result = await createPageFromReview("alice", created[0]!.id, "alice");
    spy.mockRestore();
    expect(result?.item.status).toBe("created");
    expect(result?.slug).toBeTruthy();
    expect(await readWikiPage(result!.slug)).toBeTruthy();
  });

  it("converges to created when the Page landed before a later lifecycle failure", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Postwrite"] },
    });
    const spy = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects").mockImplementationOnce(
      async (opts) => {
        await getStorage().writeFile(
          `tenants/${tenantForOwner("alice")}/wiki/${opts.slug}.md`,
          opts.content,
        );
        throw new Error("index failed after Page write");
      },
    );
    const result = await createPageFromReview("alice", created[0]!.id, "alice");
    spy.mockRestore();
    expect(result?.item.status).toBe("created");
    expect(result?.item.operationId).toBeTruthy();
    expect((await listWikiPages()).map((entry) => entry.slug)).toContain(result?.slug);
  });

  it("renews a live Create Page claim while lifecycle publication is running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    let runRenewal!: () => Promise<void>;
    const intervalSpy = vi.spyOn(globalThis, "setInterval").mockImplementation((handler) => {
      runRenewal = async () => {
        if (typeof handler === "function") await handler();
      };
      return 1 as unknown as ReturnType<typeof setInterval>;
    });
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Long publication"] },
    });
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const spy = vi.spyOn(lifecycle, "writeWikiPageWithSideEffects").mockImplementationOnce(
      async (opts) => {
        entered();
        await gate;
        return { slug: opts.slug, updatedSlugs: [] };
      },
    );
    const publishing = createPageFromReview("alice", created[0]!.id, "alice", "wiki-a");
    await started;
    const queuePath = `tenants/${tenantForOwner("alice")}/review-queue.json`;
    const before = JSON.parse(await getStorage().readFile(queuePath)) as {
      items: Array<{ id: string; claimExpiresAt?: string }>;
    };
    const firstExpiry = before.items.find((item) => item.id === created[0]!.id)?.claimExpiresAt;

    vi.setSystemTime(new Date("2026-08-24T00:01:41.000Z"));
    await runRenewal();

    let renewedExpiry = Date.parse(firstExpiry!);
    for (let attempt = 0; attempt < 10 && renewedExpiry === Date.parse(firstExpiry!); attempt += 1) {
      await Promise.resolve();
      const after = JSON.parse(await getStorage().readFile(queuePath)) as {
        items: Array<{ id: string; claimExpiresAt?: string }>;
      };
      renewedExpiry = Date.parse(
        after.items.find((item) => item.id === created[0]!.id)!.claimExpiresAt!,
      );
    }
    expect(renewedExpiry).toBeGreaterThan(Date.parse(firstExpiry!));
    release();
    await publishing;
    spy.mockRestore();
    intervalSpy.mockRestore();
    vi.useRealTimers();
  });

  it("cannot overwrite a concurrent same-title Create Page", async () => {
    const first = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic-a",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Alpha Page"] },
    });
    const second = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic-b",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Alpha Page"] },
    });
    const [a, b] = await Promise.all([
      createPageFromReview("alice", first[0]!.id, "alice"),
      createPageFromReview("alice", second[0]!.id, "alice"),
    ]);
    expect(a?.slug).toBeTruthy();
    expect(b?.slug).toBeTruthy();
    expect(a!.slug).not.toBe(b!.slug);
    expect(await readWikiPage(a!.slug)).toBeTruthy();
    expect(await readWikiPage(b!.slug)).toBeTruthy();
  });

  it("atomically refuses to overwrite an unrelated tenant-primary Page", async () => {
    const created = await enqueueReviewFromAnalysis("alice", {
      wikiId: "current",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Collision"] },
    });
    const primaryPath = `tenants/${tenantForOwner("alice")}/wiki/collision.md`;
    const unrelated = "---\nowner: alice\n---\n\n# Existing unrelated Page\n";
    await getStorage().writeFile(primaryPath, unrelated);
    await expect(createPageFromReview("alice", created[0]!.id, "alice"))
      .rejects.toThrow('Page "collision" already exists');
    expect(await getStorage().readFile(primaryPath)).toBe(unrelated);
    const pending = await listReviewItems("alice");
    expect(pending[0]?.status).toBe("pending");
    expect(pending[0]?.pageSlug).toBeUndefined();
  });

  it("drains a transient enqueue failure from the outbox without duplicating", async () => {
    await saveIngestAnalysis("job-outbox", {
      ...emptyIngestAnalysis(),
      tensions: ["Need a human decision."],
    });
    await rememberReviewOutbox("alice", {
      wikiId: "current",
      pageSlug: "topic",
      jobId: "job-outbox",
    });
    const first = await listReviewItems("alice");
    expect(first).toHaveLength(1);
    expect(first[0]?.title).toBe("Need a human decision.");
    const second = await listReviewItems("alice");
    expect(second).toHaveLength(1);
    expect(second[0]?.id).toBe(first[0]?.id);
  });

  it("does not recreate a resolved delivery when an outbox replay arrives", async () => {
    await saveIngestAnalysis("job-resolved", {
      ...emptyIngestAnalysis(),
      tensions: ["Resolve once."],
    });
    const delivery = { wikiId: "wiki-a", pageSlug: "topic", jobId: "job-resolved" };
    await rememberReviewOutbox("alice", delivery);
    const [created] = await listReviewItems("alice", "wiki-a");
    await skipReviewItem("alice", created.id, "wiki-a");

    await rememberReviewOutbox("alice", delivery);

    expect(await listReviewItems("alice", "wiki-a")).toEqual([]);
  });

  it("bounds automatic outbox retries and retains a dead-letter record", async () => {
    await rememberReviewOutbox("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic",
      jobId: "job-dead-letter",
    });
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    const read = vi.spyOn(storage, "readFile").mockImplementation(async (target) => {
      if (String(target) === "ingest-analysis/job-dead-letter.json") {
        throw new Error("analysis unavailable");
      }
      return originalRead(target);
    });
    const clock = vi.spyOn(Date, "now");
    const base = Date.parse("2026-08-24T00:00:00.000Z");
    for (let attempt = 0; attempt < 5; attempt += 1) {
      clock.mockReturnValue(base + attempt * 61_000);
      await listReviewItems("alice", "wiki-a");
    }
    clock.mockReturnValue(base + 10 * 61_000);
    await listReviewItems("alice", "wiki-a");

    const raw = JSON.parse(await originalRead(
      `tenants/${tenantForOwner("alice")}/review-outbox.json`,
    )) as { items: Array<{ attempts: number; deadLetteredAt?: string }> };
    expect(raw.items[0]?.attempts).toBe(5);
    expect(raw.items[0]?.deadLetteredAt).toBeTruthy();
    expect(read.mock.calls.filter(([target]) =>
      String(target) === "ingest-analysis/job-dead-letter.json")).toHaveLength(5);
    clock.mockRestore();
    read.mockRestore();
  });

  it("treats sustained queue capacity as backpressure without spending poison attempts", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items: Array.from({ length: 500 }, (_, index) => ({
        id: `full-${index}`,
        kind: "warning",
        title: `Full ${index}`,
        summary: "full",
        path: `wiki/full-${index}.md`,
        queries: [],
        status: "pending",
        createdAt: now,
        updatedAt: now,
        pageSlug: `full-${index}`,
        wikiId: "wiki-a",
      })) }),
    );
    await saveIngestAnalysis("job-backpressure", {
      ...emptyIngestAnalysis(),
      tensions: ["Retry after capacity clears."],
    });
    await rememberReviewOutbox("alice", {
      wikiId: "wiki-a",
      pageSlug: "overflow",
      jobId: "job-backpressure",
    });
    const clock = vi.spyOn(Date, "now");
    const base = Date.parse("2026-08-24T00:00:00.000Z");
    for (let attempt = 0; attempt < 8; attempt += 1) {
      clock.mockReturnValue(base + attempt * 2_000);
      await listReviewItems("alice", "wiki-a");
    }
    const outbox = JSON.parse(await getStorage().readFile(
      `tenants/${tenantForOwner("alice")}/review-outbox.json`,
    )) as { items: Array<{ attempts: number; deadLetteredAt?: string; nextAttemptAt?: string }> };
    expect(outbox.items[0]?.attempts).toBe(0);
    expect(outbox.items[0]?.deadLetteredAt).toBeUndefined();
    expect(outbox.items[0]?.nextAttemptAt).toBeTruthy();
  });

  it("bounds retained dead letters while preserving every active delivery", async () => {
    const outboxPath = `tenants/${tenantForOwner("alice")}/review-outbox.json`;
    const base = Date.parse("2026-08-01T00:00:00.000Z");
    const dead = Array.from({ length: 205 }, (_, index) => ({
      wikiId: "wiki-a",
      pageSlug: `dead-${index}`,
      jobId: `dead-job-${index}`,
      deliveryId: `dead-delivery-${index}`,
      createdAt: new Date(base + index * 1_000).toISOString(),
      attempts: 5,
      deadLetteredAt: new Date(base + index * 1_000).toISOString(),
    }));
    const active = Array.from({ length: 3 }, (_, index) => ({
      wikiId: "wiki-a",
      pageSlug: `active-${index}`,
      jobId: `active-job-${index}`,
      deliveryId: `active-delivery-${index}`,
      createdAt: new Date(base).toISOString(),
      attempts: 0,
    }));
    await getStorage().writeFile(outboxPath, JSON.stringify({ items: [...dead, ...active] }));
    await rememberReviewOutbox("alice", {
      wikiId: "wiki-a",
      pageSlug: "new-active",
      jobId: "new-active-job",
    });
    const stored = JSON.parse(await getStorage().readFile(outboxPath)) as {
      items: Array<{ deliveryId: string; deadLetteredAt?: string }>;
    };
    expect(stored.items.filter((item) => item.deadLetteredAt)).toHaveLength(200);
    expect(stored.items.filter((item) => !item.deadLetteredAt)).toHaveLength(4);
    expect(active.every((row) => stored.items.some((item) => item.deliveryId === row.deliveryId)))
      .toBe(true);
    expect(stored.items.some((item) => item.deliveryId === "dead-delivery-0")).toBe(false);
  });

  it("quarantines corrupt outbox bytes deterministically before failing closed", async () => {
    const outboxPath = `tenants/${tenantForOwner("alice")}/review-outbox.json`;
    await getStorage().writeFile(outboxPath, "first-corrupt");
    await expect(listReviewItems("alice")).rejects.toBeInstanceOf(CorruptReviewStoreError);
    expect(await getStorage().readFile(`${outboxPath}.corrupt`)).toBe("first-corrupt");
    await getStorage().writeFile(outboxPath, "second-corrupt");
    await expect(listReviewItems("alice")).rejects.toBeInstanceOf(CorruptReviewStoreError);
    expect(await getStorage().readFile(`${outboxPath}.corrupt`)).toBe("first-corrupt");
  });

  it.each([
    ["noncanonical queue timestamp", "queue", {
      id: "bad-time", kind: "warning", title: "Bad", summary: "Bad",
      path: "wiki/bad.md", queries: [], status: "pending",
      createdAt: "2026-08-24", updatedAt: "2026-08-24T00:00:00.000Z",
    }],
    ["empty queue wikiId", "queue", {
      id: "bad-wiki", kind: "warning", title: "Bad", summary: "Bad",
      path: "wiki/bad.md", queries: [], status: "pending", wikiId: "",
      createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
    }],
    ["invalid queue pageSlug", "queue", {
      id: "bad-slug", kind: "warning", title: "Bad", summary: "Bad",
      path: "wiki/bad.md", queries: [], status: "pending", pageSlug: "../bad",
      createdAt: "2026-08-24T00:00:00.000Z", updatedAt: "2026-08-24T00:00:00.000Z",
    }],
    ["invalid outbox row", "outbox", {
      wikiId: "", pageSlug: "../bad", jobId: "", createdAt: "2026-08-24",
    }],
  ])("rejects a persisted %s", async (_name, store, row) => {
    const target = `tenants/${tenantForOwner("alice")}/review-${store}.json`;
    await getStorage().writeFile(target, JSON.stringify({ items: [row] }));
    await expect(listReviewItems("alice")).rejects.toBeInstanceOf(CorruptReviewStoreError);
  });

  it("bounds multibyte Review Page slugs before collision suffixes", async () => {
    const title = "判".repeat(160);
    const first = await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic-a",
      analysis: { ...emptyIngestAnalysis(), tensions: [title] },
    });
    const createdFirst = await createPageFromReview("alice", first[0]!.id, "alice", "wiki-a");
    const second = await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic-b",
      analysis: { ...emptyIngestAnalysis(), tensions: [title] },
    });
    const createdSecond = await createPageFromReview("alice", second[0]!.id, "alice", "wiki-a");
    expect(new TextEncoder().encode(createdFirst!.slug).byteLength).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(createdSecond!.slug).byteLength).toBeLessThanOrEqual(200);
    expect(createdSecond!.slug).toMatch(/-2$/);
    expect(await readWikiPage(createdSecond!.slug)).toBeTruthy();
  });

  it("writes the failed enqueue to the outbox and recovers on the next list", async () => {
    await saveIngestAnalysis("job-fail", {
      ...emptyIngestAnalysis(),
      tensions: ["Recover this card."],
    });
    const storage = getStorage();
    const originalCreate = storage.writeFileIfAbsent.bind(storage);
    vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (path, contents) => {
      if (String(path).includes("review-queue.json")) {
        throw new Error("store busy");
      }
      return originalCreate(path, contents);
    });
    await expect(
      enqueueReviewAfterIngest({
        owner: "alice",
        pageSlug: "topic",
        jobId: "job-fail",
      }),
    ).rejects.toThrow("store busy");
    vi.restoreAllMocks();
    _resetStorage();
    const items = await listReviewItems("alice");
    expect(items.map((item) => item.title)).toEqual(["Recover this card."]);
  });

  it("serializes concurrent outbox appends and includes wikiId in identity", async () => {
    await Promise.all([
      rememberReviewOutbox("alice", { wikiId: "wiki-a", pageSlug: "topic", jobId: "same-job" }),
      rememberReviewOutbox("alice", { wikiId: "wiki-b", pageSlug: "topic", jobId: "same-job" }),
      rememberReviewOutbox("alice", { wikiId: "wiki-a", pageSlug: "other", jobId: "other-job" }),
    ]);
    const raw = JSON.parse(await getStorage().readFile(
      `tenants/${tenantForOwner("alice")}/review-outbox.json`,
    )) as { items: unknown[] };
    expect(raw.items).toHaveLength(3);
  });

  it("reapplies a queue mutation after CAS loss without dropping the competing value", async () => {
    const [created] = await enqueueReviewFromAnalysis("alice", {
      wikiId: "wiki-a",
      pageSlug: "topic",
      analysis: { ...emptyIngestAnalysis(), tensions: ["Original card"] },
    });
    const storage = getStorage();
    const queuePath = `tenants/${tenantForOwner("alice")}/review-queue.json`;
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let injected = false;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(async (target, content, etag) => {
      if (target === queuePath && !injected) {
        injected = true;
        const competing = JSON.parse(await storage.readFile(queuePath)) as { items: unknown[] };
        competing.items.push({
          id: "competing-card",
          kind: "warning",
          title: "Competing card",
          summary: "Competing card",
          path: "wiki/competing.md",
          queries: [],
          status: "pending",
          createdAt: "2026-08-24T00:00:00.000Z",
          updatedAt: "2026-08-24T00:00:00.000Z",
          pageSlug: "competing",
          wikiId: "wiki-a",
        });
        await storage.writeFile(queuePath, JSON.stringify(competing));
        return false;
      }
      return originalMatch(target, content, etag);
    });
    await skipReviewItem("alice", created.id, "wiki-a");
    const stored = JSON.parse(await storage.readFile(queuePath)) as {
      items: Array<{ id: string; status: string }>;
    };
    expect(stored.items.find((item) => item.id === created.id)?.status).toBe("skipped");
    expect(stored.items.find((item) => item.id === "competing-card")?.status).toBe("pending");
  });

  it("reapplies an outbox append after CAS loss without dropping the competing delivery", async () => {
    await rememberReviewOutbox("alice", {
      wikiId: "wiki-a",
      pageSlug: "first",
      jobId: "first-job",
    });
    const storage = getStorage();
    const outboxPath = `tenants/${tenantForOwner("alice")}/review-outbox.json`;
    const originalMatch = storage.writeFileIfMatch.bind(storage);
    let injected = false;
    vi.spyOn(storage, "writeFileIfMatch").mockImplementation(async (target, content, etag) => {
      if (target === outboxPath && !injected) {
        injected = true;
        const competing = JSON.parse(await storage.readFile(outboxPath)) as { items: unknown[] };
        competing.items.push({
          wikiId: "wiki-a",
          pageSlug: "competing",
          jobId: "competing-job",
          deliveryId: "competing-delivery",
          attempts: 0,
          createdAt: "2026-08-24T00:00:00.000Z",
        });
        await storage.writeFile(outboxPath, JSON.stringify(competing));
        return false;
      }
      return originalMatch(target, content, etag);
    });
    await rememberReviewOutbox("alice", {
      wikiId: "wiki-a",
      pageSlug: "second",
      jobId: "second-job",
    });
    const stored = JSON.parse(await storage.readFile(outboxPath)) as {
      items: Array<{ jobId: string }>;
    };
    expect(stored.items.map((item) => item.jobId).sort()).toEqual([
      "competing-job",
      "first-job",
      "second-job",
    ]);
  });

  it("retains a full-queue delivery in the durable outbox", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: `full-${index}`,
      kind: "warning" as const,
      title: `Full ${index}`,
      summary: "full",
      path: `wiki/full-${index}.md`,
      queries: [],
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      pageSlug: `full-${index}`,
      wikiId: "current",
    }));
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items }),
    );
    await saveIngestAnalysis("job-full", {
      ...emptyIngestAnalysis(),
      tensions: ["Keep this for later."],
    });
    await expect(enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "overflow",
      jobId: "job-full",
      wikiId: "current",
    })).rejects.toBeInstanceOf(ReviewQueueFullError);
    const outbox = await getStorage().readFile(
      `tenants/${tenantForOwner("alice")}/review-outbox.json`,
    );
    expect(outbox).toContain("job-full");
  });

  it("retains Analysis read failures in the durable outbox", async () => {
    const storage = getStorage();
    const originalRead = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (target) => {
      if (String(target) === "ingest-analysis/job-read-fail.json") {
        throw new Error("analysis store unavailable");
      }
      return originalRead(target);
    });
    await expect(enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "topic",
      jobId: "job-read-fail",
      wikiId: "wiki-a",
    })).rejects.toThrow("analysis store unavailable");
    const outbox = await originalRead(`tenants/${tenantForOwner("alice")}/review-outbox.json`);
    expect(outbox).toContain("job-read-fail");
  });

  it("honors an explicit wikiId and otherwise uses the actual current Wiki", async () => {
    const current = await createWiki("alice", { name: "Current", scenario: "research" });
    await saveIngestAnalysis("job-explicit", {
      ...emptyIngestAnalysis(),
      tensions: ["Explicit Wiki"],
    });
    await enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "explicit",
      jobId: "job-explicit",
      wikiId: "wiki-explicit",
    });
    await saveIngestAnalysis("job-current", {
      ...emptyIngestAnalysis(),
      tensions: ["Current Wiki"],
    });
    await enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "current",
      jobId: "job-current",
    });
    expect((await listReviewItems("alice", "wiki-explicit")).map((item) => item.title))
      .toEqual(["Explicit Wiki"]);
    expect((await listReviewItems("alice", current.id)).map((item) => item.title))
      .toEqual(["Current Wiki"]);
  });

  it("throws unretained when enqueue and outbox both fail", async () => {
    const now = "2026-08-23T00:00:00.000Z";
    const items = Array.from({ length: 500 }, (_, index) => ({
      id: `full-${index}`,
      kind: "warning" as const,
      title: `Full ${index}`,
      summary: "full",
      path: `wiki/full-${index}.md`,
      queries: [],
      status: "pending" as const,
      createdAt: now,
      updatedAt: now,
      pageSlug: `full-${index}`,
      wikiId: "current",
    }));
    await getStorage().writeFile(
      `tenants/${tenantForOwner("alice")}/review-queue.json`,
      JSON.stringify({ items }),
    );
    await saveIngestAnalysis("job-both-fail", {
      ...emptyIngestAnalysis(),
      tensions: ["Keep this for later."],
    });
    const storage = getStorage();
    const originalAbsent = storage.writeFileIfAbsent.bind(storage);
    vi.spyOn(storage, "writeFileIfAbsent").mockImplementation(async (filePath, content) => {
      if (String(filePath).includes("review-outbox.json")) throw new Error("outbox down");
      return originalAbsent(filePath, content);
    });
    await expect(enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "overflow",
      jobId: "job-both-fail",
      wikiId: "current",
    })).rejects.toBeInstanceOf(ReviewDeliveryUnretainedError);
  });

  it("refuses to enqueue Review without an ingest job id", async () => {
    await expect(enqueueReviewAfterIngest({
      owner: "alice",
      pageSlug: "topic",
    })).rejects.toBeInstanceOf(ReviewDeliveryUnretainedError);
  });
});

async function getReviewItemForTest(owner: string, id: string) {
  const raw = JSON.parse(await getStorage().readFile(
    `tenants/${tenantForOwner(owner)}/review-queue.json`,
  )) as { items: Array<{ id: string; status: string }> };
  return raw.items.find((item) => item.id === id);
}
