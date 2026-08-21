import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/ingest", () => ({ readLedger: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
/**
 * `@/lib/wiki` is stubbed down to the three functions this route calls — plus
 * the two pure `type` predicates `belongsInCommons` re-exports from it. Those
 * are needed because the route's 403 sentence is now resolved through the REAL
 * realm predicate (below): with them missing, `belongsInCommons` would call
 * `undefined` and this route would answer 500 where it means 403. They are
 * taken from `@/lib/page-types`, the client-safe module `wiki.ts` itself
 * re-exports them from, so no logic is restated here.
 */
vi.mock("@/lib/wiki", async () => {
  const { isAgentScopedType, isArtifactType } = await import("@/lib/page-types");
  return {
    deleteWikiPage: vi.fn(),
    listReadableWikiPages: vi.fn(),
    readWikiPageWithFrontmatter: vi.fn(),
    isAgentScopedType,
    isArtifactType,
  };
});
/**
 * PARTIAL, not total: `canWriteFrontmatter` is the gate each case below drives,
 * but `isRealmRestrictedWrite` — which `resolveWriteDenial` consults to decide
 * whether this route's 403 may name the page's realm — must stay REAL. This is
 * the one deny site with no read cloak, so a stubbed realm predicate could let
 * the route describe a private page the caller may not read, and the suite
 * would never notice.
 */
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/authz")>()),
  canWriteFrontmatter: vi.fn(),
}));
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
import { DELETE, GET } from "@/app/api/ingest/history/route";
import { WRITE_DENIAL, WRITE_DENIAL_REALM } from "@/lib/write-denial";

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

function historyRequest(): NextRequest {
  return new NextRequest("http://localhost/api/ingest/history?limit=20");
}

function request(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/ingest/history", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

let originalReadOnly: string | undefined;
// The leak case below runs the REAL `canWriteFrontmatter`, and `isAdmin` reads
// both of these at call time. Either exported on a developer's machine would
// make the test principal an admin, turn its 403 into a delete, and hide the
// leak this suite exists to guard — on that machine only.
let originalAdmin: string | undefined;
let originalOwnerHandle: string | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  originalAdmin = process.env.ADMIN_HANDLES;
  originalOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
  delete process.env.ADMIN_HANDLES;
  delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  // Cleared rather than inherited: every case but the read-only one asserts
  // what an ordinary deployment does, so a value exported in a developer's
  // shell would turn this file red there and nowhere else.
  originalReadOnly = process.env.YOPEDIA_READONLY;
  delete process.env.YOPEDIA_READONLY;
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

afterEach(() => {
  if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
  else process.env.YOPEDIA_READONLY = originalReadOnly;
  if (originalAdmin === undefined) delete process.env.ADMIN_HANDLES;
  else process.env.ADMIN_HANDLES = originalAdmin;
  if (originalOwnerHandle === undefined) delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
  else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwnerHandle;
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

  /**
   * DW-122 — the sentence this door answers, and the one it must not.
   *
   * Every other realm deny read-cloaks the page before the ACL runs, which is
   * what makes "this page is public knowledge" provable there. This door is
   * cloaked on only ONE of its two selection paths:
   *
   *   - `ingestIds` are preflighted against `listReadableWikiPages` and 404 for
   *     a page the caller cannot read, so they arrive readable.
   *   - `jobIds` pass only `job.owner !== principal.handle` — a check on the
   *     JOB record — and the job's `slug` page is never read-gated. A caller
   *     who owns a job whose page they may not read reaches the delete ACL
   *     holding an unreadable page.
   *
   * So the realm explanation has to be earned per page, from the realm
   * predicate, rather than assumed from the fact that a delete was refused —
   * and the second case below drives the `jobIds` path specifically, because it
   * is the only one where the leak is actually reachable.
   */
  it("explains the realm when a selected page really is public knowledge", async () => {
    mockedCanWrite.mockReturnValue(false);
    mockedReadPage.mockResolvedValue({
      slug: "page-a",
      title: "Page A",
      content: "---\nowner: alice\n---\n# Page A",
      path: "/test/wiki/page-a.md",
      body: "# Page A",
      frontmatter: { owner: "alice", visibility: "public" },
    });

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(WRITE_DENIAL_REALM.bulkDelete);
  });

  it("says nothing about the realm of a private page the caller cannot read", async () => {
    // THE ACTUAL LEAK PATH, driven end to end.
    //
    // `owner` owns job-a, so it clears the only gate the `jobIds` path has —
    // but the job's page belongs to BOB and is private, and nothing read-gates
    // it before the delete ACL. The real `canWriteFrontmatter` is restored for
    // this case (the shared stub is what makes the other cases synthetic), so
    // the 403 here is the predicate's own answer for `(bob's private page,
    // owner)` rather than a forced one. What must not come back is any word
    // about what kind of page it is — or that it exists.
    const actualAuthz =
      await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
    mockedCanWrite.mockImplementation(actualAuthz.canWriteFrontmatter);
    mockedGetJob.mockResolvedValue({
      jobId: "job-a",
      owner: "owner",
      status: "done",
      slug: "bob-secret",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });
    mockedReadPage.mockResolvedValue({
      slug: "bob-secret",
      title: "Bob Secret",
      content: "---\nowner: bob\nvisibility: private\n---\n# Bob Secret",
      path: "/test/wiki/bob-secret.md",
      body: "# Bob Secret",
      frontmatter: { owner: "bob", visibility: "private" },
    });

    const response = await DELETE(request({ jobIds: ["job-a"] }));
    expect(response.status).toBe(403);
    const { error } = await response.json();
    expect(error).toBe(WRITE_DENIAL.bulkDelete);
    expect(error).not.toMatch(/public knowledge/i);
    expect(error).not.toMatch(/agent-maintained/i);
    expect(error).not.toMatch(/bob-secret/);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("refuses the whole batch on a read-only deployment (DW-187)", async () => {
    // This door KEEPS a route-level check after the kernel writers were gated
    // (DW-188), and atomicity is the reason. `deleteWikiPage` failures are
    // swallowed per-slug into `failed` and the handler still returns 200, and
    // `deleteIngestJob` is not a kernel writer at all — so a kernel-only refusal
    // would clear every selected ingest JOB, answer 200, and leave the owner
    // with a half-applied batch.
    process.env.YOPEDIA_READONLY = "1";
    mockedGetJob.mockResolvedValue({
      jobId: "job-done",
      owner: "owner",
      status: "done",
      slug: "page-b",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });

    const response = await DELETE(
      request({ ingestIds: ["ing-a"], jobIds: ["job-done"] }),
    );

    expect(response.status).toBe(403);
    expect(String((await response.json()).error)).toContain("read-only");
    // Both halves of the batch survive — the page AND the ingest job.
    expect(mockedDeletePage).not.toHaveBeenCalled();
    expect(mockedDeleteJob).not.toHaveBeenCalled();
    // Answered before any preflight read, so nothing about the ledger leaks
    // either.
    expect(mockedReadLedger).not.toHaveBeenCalled();
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

/**
 * `GET` carries the deployment's read-only state (DW-265).
 *
 * The PRODUCING side of the seam `RecentIngests` reads. `/ingest` is
 * `"use client"` from the page down, so the fact cannot arrive as a prop and
 * rides on this answer instead — and the mounted suite hand-stubs the payload,
 * which means deleting `readOnly: isReadOnly()` from the handler would leave
 * every assertion over there green while the DW-265 fix silently reverted. This
 * is the case that fails instead.
 */
describe("GET /api/ingest/history serves the read-only fact", () => {
  it("reports true on a read-only deployment, alongside the entries", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const response = await GET(historyRequest());

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      entries: unknown[];
      readOnly: boolean;
    };
    expect(body.readOnly).toBe(true);
    // The READ is not refused — the flag rides along with the list rather than
    // replacing it, which is the whole point of putting it here.
    expect(body.entries).toHaveLength(1);
  });

  it("reports false when the flag is unset", async () => {
    // The discriminator. Without it a handler hard-coding `readOnly: true`
    // would satisfy the case above, and every surface would refuse forever.
    const response = await GET(historyRequest());

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ readOnly: false });
  });

  it("still 401s an unauthenticated caller rather than answering the flag", async () => {
    mockedGetPrincipal.mockResolvedValue(null);
    process.env.YOPEDIA_READONLY = "1";

    const response = await GET(historyRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
  });
});
