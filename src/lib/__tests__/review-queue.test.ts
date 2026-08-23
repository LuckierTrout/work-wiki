import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { emptyIngestAnalysis, parseIngestAnalysis, saveIngestAnalysis, loadIngestAnalysis } from "../ingest-analysis";
import { _resetLocks } from "../lock";
import {
  createPageFromReview,
  enqueueReviewFromAnalysis,
  listReviewItems,
  mapModelAction,
  reviewItemsFromAnalysis,
  skipReviewItem,
} from "../review-queue";
import { _resetStorage } from "../storage";
import { ensureDirectories, readWikiPage } from "../wiki";

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

  it("is wired after a successful compile, not on skip", async () => {
    const source = await fs.readFile(
      path.resolve(__dirname, "../../app/api/tasks/run/route.ts"),
      "utf8",
    );
    const skipped = source.indexOf("if (result.skipped)");
    const enqueue = source.indexOf("await enqueueReviewFromAnalysis");
    expect(skipped).toBeGreaterThan(-1);
    expect(enqueue).toBeGreaterThan(skipped);
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
    expect(await listReviewItems("alice")).toEqual([]);
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
});
