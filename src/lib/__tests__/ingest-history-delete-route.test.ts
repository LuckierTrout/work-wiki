import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/ingest", () => ({ readLedger: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/wiki", () => ({
  deleteWikiPage: vi.fn(),
  listReadableWikiPages: vi.fn(),
  readWikiPageWithFrontmatter: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({ canWriteFrontmatter: vi.fn() }));
vi.mock("@/lib/ingest-jobs", () => ({
  deleteIngestJob: vi.fn(),
  getIngestJob: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { readLedger } from "@/lib/ingest";
import { getPrincipal } from "@/lib/auth";
import {
  deleteWikiPage,
  listReadableWikiPages,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import { canWriteFrontmatter } from "@/lib/authz";
import { deleteIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import { DELETE } from "@/app/api/ingest/history/route";

const mockedReadLedger = vi.mocked(readLedger);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedListReadable = vi.mocked(listReadableWikiPages);
const mockedReadPage = vi.mocked(readWikiPageWithFrontmatter);
const mockedCanWrite = vi.mocked(canWriteFrontmatter);
const mockedDeletePage = vi.mocked(deleteWikiPage);
const mockedGetJob = vi.mocked(getIngestJob);
const mockedDeleteJob = vi.mocked(deleteIngestJob);

const ledgerEntry = (id: string, slug: string) => ({
  ingest_id: id,
  source_type: "url",
  source_url: `https://example.com/${slug}`,
  primary_slug: slug,
  related_slugs: [],
  started_at: "2026-08-06T10:00:00.000Z",
  finished_at: "2026-08-06T10:01:00.000Z",
  status: "completed",
});

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/ingest/history", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetPrincipal.mockResolvedValue({ id: "owner-id", handle: "owner" });
  mockedReadLedger.mockResolvedValue([ledgerEntry("ing-a", "page-a")]);
  mockedListReadable.mockResolvedValue([
    { slug: "page-a", title: "Page A", summary: "" },
  ]);
  mockedReadPage.mockResolvedValue({
    slug: "page-a",
    title: "Page A",
    content: "---\nowner: owner\nvisibility: private\n---\n# Page A",
    path: "/test/wiki/page-a.md",
    body: "# Page A",
    frontmatter: { owner: "owner", visibility: "private" },
  });
  mockedCanWrite.mockReturnValue(true);
  mockedDeletePage.mockResolvedValue({
    slug: "page-a",
    removedFromIndex: true,
    strippedBacklinksFrom: [],
  });
  mockedGetJob.mockResolvedValue(null);
  mockedDeleteJob.mockResolvedValue(true);
});

describe("DELETE /api/ingest/history", () => {
  it("requires an authenticated principal", async () => {
    mockedGetPrincipal.mockResolvedValue(null);

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(401);
  });

  it("requires at least one selected id", async () => {
    const response = await DELETE(request({ ingestIds: [], jobIds: [] }));
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/select at least one/i);
  });

  it("cloaks ledger entries the caller cannot read", async () => {
    mockedListReadable.mockResolvedValue([]);

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(404);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("rejects active jobs because clearing status would not cancel their work", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "job-active",
      owner: "owner",
      status: "processing",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });

    const response = await DELETE(request({ jobIds: ["job-active"] }));
    expect(response.status).toBe(409);
    expect(mockedDeleteJob).not.toHaveBeenCalled();
  });

  it("preflights page delete permission before mutating the batch", async () => {
    mockedCanWrite.mockReturnValue(false);

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(403);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("deletes unique generated pages, clears terminal jobs, and retains raw provenance", async () => {
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-a", "page-a"),
      ledgerEntry("ing-b", "page-a"),
      ledgerEntry("ing-c", "page-c"),
    ]);
    mockedListReadable.mockResolvedValue([
      { slug: "page-a", title: "Page A", summary: "" },
      { slug: "page-b", title: "Page B", summary: "" },
      { slug: "page-c", title: "Page C", summary: "" },
    ]);
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedGetJob.mockImplementation(async (jobId) =>
      jobId === "job-done"
        ? {
            jobId,
            owner: "owner",
            status: "done",
            slug: "page-b",
            createdAt: "2026-08-06T10:00:00.000Z",
            updatedAt: "2026-08-06T10:01:00.000Z",
          }
        : {
            jobId,
            owner: "owner",
            status: "failed",
            error: "bad input",
            createdAt: "2026-08-06T10:00:00.000Z",
            updatedAt: "2026-08-06T10:01:00.000Z",
          },
    );

    const response = await DELETE(
      request({
        ingestIds: ["ing-a"],
        jobIds: ["job-done", "job-failed"],
      }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(mockedDeletePage).toHaveBeenCalledTimes(2);
    expect(mockedDeletePage).toHaveBeenNthCalledWith(1, "page-a", "owner");
    expect(mockedDeletePage).toHaveBeenNthCalledWith(2, "page-b", "owner");
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-done", "owner");
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-failed", "owner");
    expect(data.deletedIngestIds).toEqual(["ing-a", "ing-b"]);
    expect(data.deletedJobIds).toEqual(["job-done", "job-failed"]);
    expect(data.deletedPageSlugs).toEqual(["page-a", "page-b"]);
    expect(data.failed).toEqual([]);
    expect(data.rawSourcesRetained).toBe(true);
  });
});
