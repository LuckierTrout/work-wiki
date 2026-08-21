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
 * whether this route's 403 may name the page's realm — must stay REAL.
 *
 * DW-270 gave this route a read cloak (`readable.has(slug)` in the ACL loop),
 * so it is no longer the one deny site without one — but the reason to keep the
 * predicate real did not go away, it moved. The read gate and the realm
 * sentence are now two independent guards on the same leak, and this suite
 * drives cases on both sides of the gate: a stubbed realm predicate would let
 * the 403 branch describe a page's realm without ever evaluating it, and the
 * only case that would catch it is the one where the gate has already passed.
 * Stubbing both would leave nothing checking either.
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
    // An empty readable INDEX is no longer enough on its own (DW-393): an index
    // miss now falls back to the page itself, because a readable page missing
    // from the index is the orphan state `checkOrphanPages` exists to detect,
    // and reading that miss as a denial 404'd every record selected with it.
    // So the page has to be genuinely unreadable — BOB's, and private — for the
    // cloak to be what this case observes.
    mockedListReadable.mockResolvedValue([]);
    mockedReadPage.mockResolvedValue({
      slug: "page-a",
      title: "Page A",
      content: "---\nowner: bob\nvisibility: private\n---\n# Page A",
      path: "/test/wiki/page-a.md",
      body: "# Page A",
      frontmatter: { owner: "bob", visibility: "private" },
    });

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(
      "One or more selected ingests were not found.",
    );
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  /**
   * DW-393 — index/disk drift is a real state, and it must not eat the batch.
   *
   * The DW-270 read gate keys on `listReadableWikiPages`, which filters the page
   * INDEX. `checkOrphanPages` (`@/lib/lint-checks`) exists precisely because a page
   * be on disk and absent from that index, and from this route such a page was
   * indistinguishable from one the caller may not read: the whole DELETE 404'd
   * and cleared nothing else selected alongside it. The fallback re-asks
   * `canReadFrontmatter` — the same `canReadPage` decision `canReadEntry` makes
   * — so a page the index would have denied is denied identically.
   *
   * Both cases run the REAL `canReadFrontmatter` (only `canWriteFrontmatter` is
   * stubbed in this file), so the fallback is the actual ACL, not a fixture.
   */
  it("deletes an ORPHAN page selected by ingestIds, and the rest of the batch with it", async () => {
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-a", "page-a"),
      ledgerEntry("ing-orphan", "orphan-page"),
    ]);
    // `page-a` is indexed; `orphan-page` is on disk only.
    mockedListReadable.mockResolvedValue([
      { slug: "page-a", title: "Page A", summary: "" },
    ]);
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedDeletePage.mockImplementation(async (slug) => ({
      slug,
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    }));

    const response = await DELETE(
      request({ ingestIds: ["ing-a", "ing-orphan"] }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();
    // The indexed record is the one the old behaviour took down with the
    // orphan — a 404 on the whole batch cleared neither.
    expect(data.deletedPageSlugs).toEqual(
      expect.arrayContaining(["page-a", "orphan-page"]),
    );
    expect(data.deletedIngestIds).toEqual(
      expect.arrayContaining(["ing-a", "ing-orphan"]),
    );

    // ONE read per slug across the whole request. The orphan is the slug that
    // takes the fallback path, so without the per-request cache it is opened
    // twice — once by the preflight's readability check and again by the ACL
    // loop — and nothing else in the suite would notice.
    const orphanReads = mockedReadPage.mock.calls.filter(
      ([slug]) => slug === "orphan-page",
    );
    expect(orphanReads).toHaveLength(1);
    const indexedReads = mockedReadPage.mock.calls.filter(
      ([slug]) => slug === "page-a",
    );
    // …and an INDEXED slug is never opened by the preflight at all: the index
    // hit short-circuits, so its single read is the ACL loop's.
    expect(indexedReads).toHaveLength(1);
  });

  it("deletes an ORPHAN page selected by jobIds", async () => {
    // The other selection path, gated at its own site inside the ACL loop —
    // both had to move together or the drift would just relocate. Here the
    // fallback consumes the page the loop ALREADY read, so it costs no extra
    // read at all.
    mockedListReadable.mockResolvedValue([]);
    mockedGetJob.mockResolvedValue({
      jobId: "job-orphan",
      owner: "owner",
      status: "done",
      slug: "orphan-page",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });
    mockedReadPage.mockResolvedValue({
      slug: "orphan-page",
      title: "Orphan Page",
      content: "---\nowner: owner\nvisibility: private\n---\n# Orphan Page",
      path: "/test/wiki/orphan-page.md",
      body: "# Orphan Page",
      frontmatter: { owner: "owner", visibility: "private" },
    });
    mockedDeletePage.mockResolvedValue({
      slug: "orphan-page",
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    });

    const response = await DELETE(request({ jobIds: ["job-orphan"] }));
    expect(response.status).toBe(200);
    expect(mockedDeletePage).toHaveBeenCalledWith("orphan-page", "owner");
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-orphan", "owner");
  });

  it("lets an ORPHANED PUBLIC page reach the realm 403 instead of the old 404 cloak", async () => {
    // THE BOUNDARY DW-393 ACTUALLY MOVED, pinned deliberately.
    //
    // Before the fallback, an orphaned page 404'd on the index miss no matter
    // what it was. Now readability is decided by the page, and a PUBLIC page is
    // readable by everyone — so an orphaned public knowledge page passes the
    // read gate and lands on the delete ACL, where the realm branch refuses it
    // and the route answers 403 with the realm sentence. The observable answer
    // for this page therefore changed from 404 to 403.
    //
    // That is correct, not a leak, and the read cloak's own rule says why: the
    // realm sentence may be spoken only about a page the caller could read, and
    // this caller CAN read it — it is public. The 404 cloak exists to keep an
    // UNREADABLE page from being described; it was never meant to hide a public
    // page's realm, and on an indexed public page the route has always answered
    // exactly this 403.
    //
    // The REAL `canWriteFrontmatter` is restored the way the DW-270 cases do it,
    // so the refusal comes from the predicate rather than from the shared stub.
    const actualAuthz =
      await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
    mockedCanWrite.mockImplementation(actualAuthz.canWriteFrontmatter);
    mockedListReadable.mockResolvedValue([]);
    mockedReadPage.mockResolvedValue({
      slug: "page-a",
      title: "Page A",
      content: "---\nowner: alice\nvisibility: public\n---\n# Page A",
      path: "/test/wiki/page-a.md",
      body: "# Page A",
      // Public, non-agent-scoped, non-artifact — `belongsInCommons` exactly.
      frontmatter: { owner: "alice", visibility: "public" },
    });

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(403);
    expect((await response.json()).error).toBe(WRITE_DENIAL_REALM.bulkDelete);
    expect(mockedDeletePage).not.toHaveBeenCalled();
    expect(mockedDeleteJob).not.toHaveBeenCalled();
  });

  it("still 404s an ingestIds selection whose page is gone entirely", async () => {
    // The fallback's other answer, and the control on the two cases above: an
    // index miss is not a denial, but a page that does not exist is still not a
    // selection the caller can make. Unchanged from before DW-393 — the point
    // is that widening the miss did not widen this.
    mockedListReadable.mockResolvedValue([]);
    mockedReadPage.mockResolvedValue(null);

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe(
      "One or more selected ingests were not found.",
    );
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
   * DW-122/DW-270 — the sentence this door answers, and the page it may never
   * describe at all.
   *
   * Every realm deny read-cloaks the page before the ACL runs, which is what
   * makes "this page is public knowledge" provable. This door was the last one
   * cloaked on only ONE of its two selection paths:
   *
   *   - `ingestIds` are preflighted against `listReadableWikiPages` and 404 for
   *     a page the caller cannot read, so they arrive readable.
   *   - `jobIds` pass only `job.owner !== principal.handle` — a check on the
   *     JOB record — and the job's `slug` page was never read-gated. A caller
   *     who owned a job whose page they may not read reached the delete ACL
   *     holding an unreadable page.
   *
   * DW-270 closed that with a `readable.has(slug)` check inside the ACL loop,
   * so the second case below is now a 404 rather than a 403 whose silence had
   * to be argued from the resolver. The realm explanation is still earned per
   * page from the predicate rather than assumed from the fact of a refusal.
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

  it("404s a jobIds selection whose page the caller cannot read (DW-270)", async () => {
    // THE FORMER LEAK PATH, driven end to end.
    //
    // `owner` owns job-a, so it clears the only gate the `jobIds` path has —
    // but the job's page belongs to BOB and is private, so it is absent from
    // `listReadableWikiPages`. Before DW-270 nothing read-gated it and the
    // route answered a 403 whose silence depended entirely on the resolver
    // picking the generic sentence. Now the page never reaches the ACL: the
    // answer is the same 404 selection sentence the two preflights use, so an
    // unreadable page looks like an unselectable one.
    //
    // The real `canWriteFrontmatter` is restored for this case (the shared stub
    // is what makes the other cases synthetic), so a regression that dropped
    // the read gate would fall through to the predicate's own 403 and fail
    // here on the status rather than passing by accident.
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
    expect(response.status).toBe(404);
    const { error } = await response.json();
    expect(error).toBe("One or more selected ingests were not found.");
    // Not a permission sentence, and not a description of the page: no realm,
    // no slug, nothing that says the page exists.
    expect(error).not.toBe(WRITE_DENIAL.bulkDelete);
    expect(error).not.toMatch(/public knowledge/i);
    expect(error).not.toMatch(/agent-maintained/i);
    expect(error).not.toMatch(/permission/i);
    expect(error).not.toMatch(/bob-secret/);
    expect(mockedDeletePage).not.toHaveBeenCalled();
    expect(mockedDeleteJob).not.toHaveBeenCalled();
  });

  it("still deletes a jobIds selection whose page the caller CAN read", async () => {
    // The bound on the case above: the read gate must 404 the unreadable page
    // and nothing else. Same shape, same real predicate — only the page's
    // readability and ownership differ, and the batch goes through.
    const actualAuthz =
      await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
    mockedCanWrite.mockImplementation(actualAuthz.canWriteFrontmatter);
    mockedListReadable.mockResolvedValue([
      { slug: "owner-note", title: "Owner Note", summary: "" },
    ]);
    mockedGetJob.mockResolvedValue({
      jobId: "job-ok",
      owner: "owner",
      status: "done",
      slug: "owner-note",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });
    mockedReadPage.mockResolvedValue({
      slug: "owner-note",
      title: "Owner Note",
      content: "---\nowner: owner\nvisibility: private\n---\n# Owner Note",
      path: "/test/wiki/owner-note.md",
      body: "# Owner Note",
      frontmatter: { owner: "owner", visibility: "private" },
    });
    mockedDeletePage.mockResolvedValue({
      slug: "owner-note",
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    });

    const response = await DELETE(request({ jobIds: ["job-ok"] }));
    expect(response.status).toBe(200);
    expect(mockedDeletePage).toHaveBeenCalledWith("owner-note", "owner");
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-ok", "owner");
  });

  it("still clears a done job whose page is already gone (the cleanup DW-270 must not break)", async () => {
    // The reason the read gate lives INSIDE the ACL loop, after
    // `if (!page) continue`, rather than in the `jobIds` preflight. A done job
    // whose page has since been deleted is not in `listReadableWikiPages` —
    // there is no page to read — so a flat gate up front would 404 exactly the
    // records this route exists to clean up.
    mockedListReadable.mockResolvedValue([]);
    mockedGetJob.mockResolvedValue({
      jobId: "job-gone",
      owner: "owner",
      status: "done",
      slug: "already-deleted",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });
    mockedReadPage.mockResolvedValue(null);

    const response = await DELETE(request({ jobIds: ["job-gone"] }));
    expect(response.status).toBe(200);
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-gone", "owner");
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
