import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/ingest", () => ({ readLedger: vi.fn() }));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
/**
 * `@/lib/wiki` is stubbed down to the four functions this route calls — plus
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
    listWikiPages: vi.fn(),
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
  listWikiPages,
  readWikiPageWithFrontmatter,
} from "@/lib/wiki";
import { canWriteFrontmatter } from "@/lib/authz";
import { deleteIngestJob, getIngestJob } from "@/lib/ingest-jobs";
import { logger } from "@/lib/logger";
import { DELETE, GET } from "@/app/api/ingest/history/route";
import { WRITE_DENIAL, WRITE_DENIAL_REALM } from "@/lib/write-denial";

const mockedReadLedger = vi.mocked(readLedger);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedListReadable = vi.mocked(listReadableWikiPages);
const mockedListWikiPages = vi.mocked(listWikiPages);
const mockedReadPage = vi.mocked(readWikiPageWithFrontmatter);
const mockedCanWrite = vi.mocked(canWriteFrontmatter);
const mockedDeletePage = vi.mocked(deleteWikiPage);
const mockedGetJob = vi.mocked(getIngestJob);
const mockedDeleteJob = vi.mocked(deleteIngestJob);
const mockedWarn = vi.mocked(logger.warn);

/**
 * The route's one not-found sentence, restated here as a LITERAL rather than
 * imported: the route does not export it, and pinning a copy is what makes a
 * reworded refusal fail this suite instead of silently agreeing with itself.
 * Every not-found reason — missing ledger entry, unreadable page, job that is
 * not yours, job whose page you may not read — must answer exactly this.
 */
const SELECTION_NOT_FOUND = "One or more selected ingests were not found.";

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
  // GET derives BOTH its `indexed` and `readable` sets from this one listing
  // (DELETE keeps using `listReadableWikiPages` above). Defaulted to the same
  // `page-a` fixture — public, so the real `canReadEntry` admits it — so every
  // pre-existing case that only stubbed the readable list keeps its meaning.
  mockedListWikiPages.mockResolvedValue([
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

  it("cloaks ledger entries the caller cannot read, per entry", async () => {
    // DW-393 turned this refusal from a whole-batch 404 into a row in
    // `failed[]`. The cloak is unchanged — same sentence, no mutation — but the
    // batch evaluation succeeded, so the transport says 200.
    mockedListReadable.mockResolvedValue([]);

    const response = await DELETE(request({ ingestIds: ["ing-a"] }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.failed).toEqual([
      { id: "ing-a", kind: "ingest", error: SELECTION_NOT_FOUND },
    ]);
    expect(data.deletedIngestIds).toEqual([]);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("refuses an unknown ingest id per entry rather than vetoing the batch", async () => {
    const response = await DELETE(request({ ingestIds: ["ing-nope"] }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.failed).toEqual([
      { id: "ing-nope", kind: "ingest", error: SELECTION_NOT_FOUND },
    ]);
    expect(data.deletedIngestIds).toEqual([]);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("deletes the readable half of a batch that also names an orphan page (DW-393)", async () => {
    // THE BUG DW-393 FIXED, driven end to end. `page-orphan` is on disk but
    // absent from the page index — the drift `checkOrphanPages` exists for — so
    // it can never be readable, and under the old all-or-nothing 404 its ledger
    // row was permanently undeletable AND vetoed everything selected with it.
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-ok", "page-ok"),
      ledgerEntry("ing-orphan", "page-orphan"),
    ]);
    mockedListReadable.mockResolvedValue([
      { slug: "page-ok", title: "Page OK", summary: "" },
    ]);
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedDeletePage.mockResolvedValue({
      slug: "page-ok",
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    });

    const response = await DELETE(
      request({ ingestIds: ["ing-ok", "ing-orphan"] }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(mockedDeletePage).toHaveBeenCalledTimes(1);
    expect(mockedDeletePage).toHaveBeenCalledWith("page-ok", "owner");
    expect(data.deletedIngestIds).toEqual(["ing-ok"]);
    expect(data.deletedPageSlugs).toEqual(["page-ok"]);
    expect(data.failed).toEqual([
      { id: "ing-orphan", kind: "ingest", error: SELECTION_NOT_FOUND },
    ]);
    // The refused entry mutated NOTHING: its page was never even read.
    expect(mockedReadPage).not.toHaveBeenCalledWith("page-orphan");
  });

  it("refuses a ledger entry with no primary_slug, per entry", async () => {
    // The third not-found reason enumerated in the route's doc comment and in
    // the spec's Always clause. A slugless entry names no page, so there is
    // nothing to read or delete for it — and it must answer the SAME sentence
    // as a missing entry and an unreadable one, or the refusal becomes an
    // oracle for which of the three went wrong.
    mockedReadLedger.mockResolvedValue([
      { ...ledgerEntry("ing-slugless", "unused"), primary_slug: "" },
    ]);
    mockedListReadable.mockResolvedValue([]);

    const response = await DELETE(request({ ingestIds: ["ing-slugless"] }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.failed).toEqual([
      { id: "ing-slugless", kind: "ingest", error: SELECTION_NOT_FOUND },
    ]);
    expect(data.deletedIngestIds).toEqual([]);
    expect(mockedReadPage).not.toHaveBeenCalled();
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("never reports a refused ingest id as deleted, even when a job clears its slug", async () => {
    // THE DOUBLE-REPORT. `deletedIngestIds` is derived from the slugs that did
    // NOT fail, and an already-gone page never fails — it is skipped by
    // `if (!page) continue`. So when a JOB contributes the very slug a refused
    // `ingestIds` entry also names, that refused id reached `removedSlugs`
    // through the job's back door and the answer claimed it was both deleted
    // and refused. Only reachable since DW-393 made the refusal per-entry;
    // before, this batch was a flat 404.
    mockedReadLedger.mockResolvedValue([ledgerEntry("ing-x", "shared-slug")]);
    mockedListReadable.mockResolvedValue([]);
    mockedGetJob.mockResolvedValue({
      jobId: "job-j",
      owner: "owner",
      status: "done",
      slug: "shared-slug",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });
    mockedReadPage.mockResolvedValue(null);

    const response = await DELETE(
      request({ ingestIds: ["ing-x"], jobIds: ["job-j"] }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.failed).toEqual([
      { id: "ing-x", kind: "ingest", error: SELECTION_NOT_FOUND },
    ]);
    // The refused id appears in the answer EXACTLY once, as a failure.
    expect(data.deletedIngestIds).not.toContain("ing-x");
    // The job's own already-gone cleanup still runs — that is the behaviour the
    // fix must not trade away to close the double-report.
    expect(data.deletedJobIds).toEqual(["job-j"]);
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("attributes a deleteWikiPage failure to its own entry and keeps the rest", async () => {
    // The per-slug failure path, which nothing else in this suite drives: every
    // other case resolves `deleteWikiPage`. Without this, the two attribution
    // lines that map `failedSlugs` back onto the submitted ids could be deleted
    // outright and the suite would stay green — while the shipped route told an
    // owner "2 ingest records cleared" with the page still on disk.
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-ok", "page-ok"),
      ledgerEntry("ing-bad", "page-bad"),
    ]);
    mockedListReadable.mockResolvedValue([
      { slug: "page-ok", title: "Page OK", summary: "" },
      { slug: "page-bad", title: "Page Bad", summary: "" },
    ]);
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedDeletePage.mockImplementation(async (slug) => {
      if (slug === "page-bad") throw new Error("disk write failed");
      return { slug, removedFromIndex: true, strippedBacklinksFrom: [] };
    });

    const response = await DELETE(
      request({ ingestIds: ["ing-ok", "ing-bad"] }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    expect(data.deletedPageSlugs).toEqual(["page-ok"]);
    expect(data.deletedIngestIds).toEqual(["ing-ok"]);
    expect(data.deletedIngestIds).not.toContain("ing-bad");
    expect(data.failed).toEqual([
      { id: "ing-bad", kind: "ingest", error: "disk write failed" },
    ]);
  });

  it("deletes the deletable half of a mixed jobIds batch (DW-393)", async () => {
    // The path DW-393 was actually filed about. `ingestIds` are already
    // readability-filtered by the history GET, so the UI rarely offers one that
    // the preflight would refuse — but job records are NOT filtered, so a
    // selection mixing a deletable job with one the caller does not own is the
    // shape an owner really hits.
    const actualAuthz =
      await vi.importActual<typeof import("@/lib/authz")>("@/lib/authz");
    mockedCanWrite.mockImplementation(actualAuthz.canWriteFrontmatter);
    mockedListReadable.mockResolvedValue([
      { slug: "owner-note", title: "Owner Note", summary: "" },
    ]);
    mockedGetJob.mockImplementation(async (jobId) =>
      jobId === "job-mine"
        ? {
            jobId,
            owner: "owner",
            status: "done",
            slug: "owner-note",
            createdAt: "2026-08-06T10:00:00.000Z",
            updatedAt: "2026-08-06T10:01:00.000Z",
          }
        : {
            jobId,
            owner: "bob",
            status: "done",
            slug: "bob-secret",
            createdAt: "2026-08-06T10:00:00.000Z",
            updatedAt: "2026-08-06T10:01:00.000Z",
          },
    );
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedDeletePage.mockResolvedValue({
      slug: "owner-note",
      removedFromIndex: true,
      strippedBacklinksFrom: [],
    });

    const response = await DELETE(
      request({ jobIds: ["job-bob", "job-mine"] }),
    );
    expect(response.status).toBe(200);
    const data = await response.json();

    // The deletable job went all the way through, page and record.
    expect(mockedDeletePage).toHaveBeenCalledTimes(1);
    expect(mockedDeletePage).toHaveBeenCalledWith("owner-note", "owner");
    expect(mockedDeleteJob).toHaveBeenCalledTimes(1);
    expect(mockedDeleteJob).toHaveBeenCalledWith("job-mine", "owner");
    expect(data.deletedJobIds).toEqual(["job-mine"]);
    // Bob's job is only ever a failure row, in SUBMISSION order.
    expect(data.failed).toEqual([
      { id: "job-bob", kind: "job", error: SELECTION_NOT_FOUND },
    ]);
    expect(mockedReadPage).not.toHaveBeenCalledWith("bob-secret");
  });

  it("refuses a job that is not the caller's per entry, without deleting it", async () => {
    mockedGetJob.mockResolvedValue({
      jobId: "job-bob",
      owner: "bob",
      status: "done",
      slug: "bob-note",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });

    const response = await DELETE(request({ jobIds: ["job-bob"] }));
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.failed).toEqual([
      { id: "job-bob", kind: "job", error: SELECTION_NOT_FOUND },
    ]);
    expect(data.deletedJobIds).toEqual([]);
    expect(mockedDeleteJob).not.toHaveBeenCalled();
    // Bob's page was never read, let alone deleted — the job record is the
    // only thing this refusal ever touched.
    expect(mockedReadPage).not.toHaveBeenCalledWith("bob-note");
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("rejects active jobs and refuses the WHOLE batch with them", async () => {
    // Same pinning as the 403 above, on the other refusal DW-393 left alone:
    // `ing-a` is deletable and is submitted alongside the processing job, and
    // it must survive untouched. Clearing an active job's record would not
    // cancel its work, so the batch is refused outright.
    mockedGetJob.mockResolvedValue({
      jobId: "job-active",
      owner: "owner",
      status: "processing",
      createdAt: "2026-08-06T10:00:00.000Z",
      updatedAt: "2026-08-06T10:01:00.000Z",
    });

    const response = await DELETE(
      request({ ingestIds: ["ing-a"], jobIds: ["job-active"] }),
    );
    expect(response.status).toBe(409);
    expect(mockedDeleteJob).not.toHaveBeenCalled();
    expect(mockedDeletePage).not.toHaveBeenCalled();
  });

  it("preflights page delete permission and refuses the WHOLE batch", async () => {
    // TWO items, one of them perfectly deletable. A singleton could not tell a
    // whole-batch 403 apart from a per-entry one, so this is what pins the half
    // of DW-393 that did NOT change: the delete-ACL denial is about an item the
    // caller can see and deselect, so it still vetoes everything beside it.
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-a", "page-a"),
      ledgerEntry("ing-denied", "page-denied"),
    ]);
    mockedListReadable.mockResolvedValue([
      { slug: "page-a", title: "Page A", summary: "" },
      { slug: "page-denied", title: "Page Denied", summary: "" },
    ]);
    mockedReadPage.mockImplementation(async (slug) => ({
      slug,
      title: slug,
      content: `---\nowner: owner\nvisibility: private\n---\n# ${slug}`,
      path: `/test/wiki/${slug}.md`,
      body: `# ${slug}`,
      frontmatter: { owner: "owner", visibility: "private" },
    }));
    mockedCanWrite.mockReturnValue(false);

    const response = await DELETE(
      request({ ingestIds: ["ing-a", "ing-denied"] }),
    );
    expect(response.status).toBe(403);
    // Not even the item that would have succeeded — the ACL loop runs to
    // completion before the delete loop starts, which is what makes the refusal
    // atomic rather than half-applied.
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
   *   - `ingestIds` are preflighted against `listReadableWikiPages` and are
   *     refused per entry for a page the caller cannot read, so the ones that
   *     reach the ACL arrive readable.
   *   - `jobIds` pass only `job.owner !== principal.handle` — a check on the
   *     JOB record — and the job's `slug` page was never read-gated. A caller
   *     who owned a job whose page they may not read reached the delete ACL
   *     holding an unreadable page.
   *
   * DW-270 closed that with a `readable.has(slug)` check inside the ACL loop,
   * so the second case below answers the selection sentence rather than a 403
   * whose silence had to be argued from the resolver. DW-393 then made that
   * refusal PER-ENTRY — a row in `failed[]` on a 200 instead of a whole-batch
   * 404 — which changes the transport and nothing about the cloak: same
   * sentence, same silence, still no mutation. The realm explanation is still
   * earned per page from the predicate rather than assumed from the fact of a
   * refusal.
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

  it("cloaks a jobIds selection whose page the caller cannot read (DW-270)", async () => {
    // THE FORMER LEAK PATH, driven end to end.
    //
    // `owner` owns job-a, so it clears the only gate the `jobIds` path has —
    // but the job's page belongs to BOB and is private, so it is absent from
    // `listReadableWikiPages`. Before DW-270 nothing read-gated it and the
    // route answered a 403 whose silence depended entirely on the resolver
    // picking the generic sentence. Now the page never reaches the ACL: the
    // answer is the same selection sentence the two preflights use, so an
    // unreadable page looks like an unselectable one. Since DW-393 it arrives
    // as this job's own row in `failed[]` on a 200 — the sentence and the
    // silence are what this case pins, not the status.
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
    expect(response.status).toBe(200);
    const data = await response.json();
    expect(data.failed).toHaveLength(1);
    const [failure] = data.failed as { id: string; kind: string; error: string }[];
    expect(failure.id).toBe("job-a");
    expect(failure.kind).toBe("job");
    const error = failure.error;
    expect(error).toBe(SELECTION_NOT_FOUND);
    // Not a permission sentence, and not a description of the page: no realm,
    // no slug, nothing that says the page exists.
    expect(error).not.toBe(WRITE_DENIAL.bulkDelete);
    expect(error).not.toMatch(/public knowledge/i);
    expect(error).not.toMatch(/agent-maintained/i);
    expect(error).not.toMatch(/permission/i);
    expect(error).not.toMatch(/bob-secret/);
    // The id echoed back is the caller's OWN submitted job id, and it is the
    // only id in the answer — nothing about Bob's page rides along.
    expect(JSON.stringify(data)).not.toMatch(/bob-secret/);
    expect(data.deletedJobIds).toEqual([]);
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
    // there is no page to read — so a flat gate up front would refuse exactly
    // the records this route exists to clean up, dropping each of them into
    // `failed[]` forever instead of clearing them.
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

/**
 * DW-432 — the listing's orphan fallback.
 *
 * The page INDEX is not the set of pages that exist. A page on disk but absent
 * from the index (the drift `checkOrphanPages` exists for; a crash-left ingest
 * silo is the common case) had its ledger row dropped here, so its owner could
 * never see it. GET now falls back to ONE per-page read for a slug the index
 * does not know AT ALL, and admits the row only if the page exists and the
 * caller may read its frontmatter.
 *
 * Every assertion below is about a boundary a reviewer showed a mutant can slip
 * through: WHICH slugs get probed (index-missing only, never merely
 * unreadable), HOW they are read (the index's own `{fresh,strict,owner}`
 * options — a cached read can succeed where the index's hardening failed and
 * would expose a row the index hid on purpose), how much the probing may COST,
 * and that the walk keeps going once that cost is spent.
 */
describe("GET /api/ingest/history falls back to disk for orphan slugs", () => {
  /**
   * The route's per-request probe budget, restated here rather than imported —
   * for exactly the reason `SELECTION_NOT_FOUND` above is restated, and one the
   * route cannot escape: a Next.js route module may export only its HTTP
   * handlers, so `MAX_ORPHAN_PROBES` cannot leave that file. The copy is
   * self-policing: move the budget in the route without touching this line and
   * every read-count assertion below turns red.
   */
  const MAX_ORPHAN_PROBES = 50;
  /** Comfortably more index-missing rows than one request may probe. */
  const OVER_BUDGET = MAX_ORPHAN_PROBES + 10;

  const listRequest = (query = "") =>
    new NextRequest(`http://localhost/api/ingest/history${query}`);

  const diskPage = (slug: string, frontmatter: Record<string, string>) => ({
    slug,
    title: slug,
    content: "",
    path: `/test/wiki/${slug}.md`,
    body: `# ${slug}`,
    frontmatter,
  });

  /** Readable by the default `owner` principal; unreadable by anyone else. */
  const ownedByCaller = (slug: string) =>
    diskPage(slug, { owner: "owner", visibility: "private" });

  const listedIds = async (response: Response) => {
    const body = (await response.json()) as { entries: { ingest_id: string }[] };
    return body.entries.map((e) => e.ingest_id);
  };

  const slugsRead = () =>
    mockedReadPage.mock.calls.map(([slug]) => slug as string);

  it("takes the index's answer with zero page reads when every slug is indexed", async () => {
    // The common request. If this ever reads a page, the fallback has leaked
    // onto the hot multi-user path it was explicitly kept off.
    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual(["ing-a"]);
    expect(mockedReadPage).not.toHaveBeenCalled();
  });

  it("derives both of its sets from ONE index listing", async () => {
    // `indexed` and `readable` come from a single `listWikiPages()` call. A
    // regression that listed twice — or that reached for
    // `listReadableWikiPages` again for the readable half — doubles the cost of
    // the hot path while every other assertion in this file stays green.
    await GET(listRequest());

    expect(mockedListWikiPages).toHaveBeenCalledTimes(1);
    expect(mockedListReadable).not.toHaveBeenCalled();
  });

  it("hides an INDEXED but unreadable row without reading the page", async () => {
    // The mutant this kills: gating the probe on `readable.has(slug)` instead
    // of `indexed.has(slug)`. That fires a disk read for every indexed page the
    // caller may not read — the exact population this route's scoping hides —
    // and starves the budget with rows that end up hidden anyway.
    mockedListWikiPages.mockResolvedValue([
      {
        slug: "page-bob",
        title: "Page Bob",
        summary: "",
        owner: "bob",
        visibility: "private",
      },
    ]);
    mockedReadLedger.mockResolvedValue([ledgerEntry("ing-bob", "page-bob")]);

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual([]);
    expect(mockedReadPage).not.toHaveBeenCalled();
  });

  it("lists a readable orphan the page index does not know", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-orphan", "page-orphan"),
    ]);
    mockedReadPage.mockResolvedValue(ownedByCaller("page-orphan"));

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual(["ing-orphan"]);
    expect(slugsRead()).toEqual(["page-orphan"]);
  });

  it("probes with the index's own authoritative read options", async () => {
    // `{fresh, strict}` is how `listWikiPages` re-reads a slug it cannot trust,
    // and it forces `visibility: private` when that read fails. A plain cached
    // read can SUCCEED where that hardening failed and list a row the index
    // deliberately hid. `owner` is what finds a crash-left ingest silo at all.
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-orphan", "page-orphan"),
    ]);
    mockedReadPage.mockResolvedValue(ownedByCaller("page-orphan"));

    await GET(listRequest());

    expect(mockedReadPage).toHaveBeenCalledWith("page-orphan", {
      fresh: true,
      strict: true,
      owner: "owner",
    });
  });

  it("hides an orphan the caller may not read", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([ledgerEntry("ing-bob", "page-bob")]);
    mockedReadPage.mockResolvedValue(
      diskPage("page-bob", { owner: "bob", visibility: "private" }),
    );

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual([]);
  });

  it("hides a row whose page is gone from the index AND from disk", async () => {
    // "Once a page is gone, GET no longer returns its ledger entries."
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([ledgerEntry("ing-gone", "page-gone")]);
    mockedReadPage.mockResolvedValue(null);

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual([]);
  });

  it("hides a row whose probe throws, and still lists its siblings", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-bad", "page-bad"),
      ledgerEntry("ing-good", "page-good"),
    ]);
    mockedReadPage.mockImplementation(async (slug: string) => {
      if (slug === "page-bad") throw new Error("disk exploded");
      return ownedByCaller(slug);
    });

    const response = await GET(listRequest());

    // A throwing read is fail-closed, not a 500: the one row disappears and
    // the rest of the page is served.
    expect(response.status).toBe(200);
    expect(await listedIds(response)).toEqual(["ing-good"]);
  });

  it("logs ONE probe failure per request, however many probes throw", async () => {
    // A systemic storage fault fails every probe. Logging per slug would write
    // up to `MAX_ORPHAN_PROBES` identical lines per GET and bury the first.
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-bad-1", "page-bad-1"),
      ledgerEntry("ing-bad-2", "page-bad-2"),
      ledgerEntry("ing-good", "page-good"),
    ]);
    mockedReadPage.mockImplementation(async (slug: string) => {
      if (slug.startsWith("page-bad")) throw new Error("storage is down");
      return ownedByCaller(slug);
    });

    const response = await GET(listRequest());

    expect(await listedIds(response)).toEqual(["ing-good"]);
    // Both bad slugs were still PROBED — the cap is on the logging, not on the
    // work — and only the first was reported.
    expect(slugsRead()).toEqual(["page-bad-1", "page-bad-2", "page-good"]);
    expect(mockedWarn).toHaveBeenCalledTimes(1);
    expect(mockedWarn.mock.calls[0][1]).toContain("page-bad-1");
  });

  it("spends at most MAX_ORPHAN_PROBES reads and lists exactly the resolved rows", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue(
      Array.from({ length: OVER_BUDGET }, (_, i) =>
        ledgerEntry(`ing-${i}`, `orphan-${i}`),
      ),
    );
    mockedReadPage.mockImplementation(async (slug: string) =>
      ownedByCaller(slug),
    );

    const response = await GET(listRequest(`?limit=${OVER_BUDGET}`));

    expect(response.status).toBe(200);
    expect(mockedReadPage).toHaveBeenCalledTimes(MAX_ORPHAN_PROBES);
    // Ids, not just a length: the cap must take the FIRST `MAX_ORPHAN_PROBES`
    // in ledger order (most-recent-first), which a length assertion alone
    // would not pin.
    expect(await listedIds(response)).toEqual(
      Array.from({ length: MAX_ORPHAN_PROBES }, (_, i) => `ing-${i}`),
    );
  });

  it("reports the exhausted budget once, so persistent drift is not silent", async () => {
    // Hiding the leftover rows is correct — it is what this route did before
    // the fallback existed — but doing it SILENTLY makes a deployment whose
    // budget is spent on every request look exactly like one with no orphans,
    // which is the drift this whole feature exists to surface.
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue(
      Array.from({ length: OVER_BUDGET }, (_, i) =>
        ledgerEntry(`ing-${i}`, `orphan-${i}`),
      ),
    );
    mockedReadPage.mockImplementation(async (slug: string) =>
      ownedByCaller(slug),
    );

    await GET(listRequest(`?limit=${OVER_BUDGET}`));

    expect(mockedWarn).toHaveBeenCalledTimes(1);
    const [scope, message] = mockedWarn.mock.calls[0];
    expect(scope).toBe("ingest");
    expect(message).toContain(String(MAX_ORPHAN_PROBES));
    expect(message).toContain(String(OVER_BUDGET - MAX_ORPHAN_PROBES));
  });

  it("stays quiet when the budget covers every index-missing slug", async () => {
    // The discriminator: a handler that warned unconditionally would satisfy
    // the case above and make the signal meaningless.
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue(
      Array.from({ length: MAX_ORPHAN_PROBES }, (_, i) =>
        ledgerEntry(`ing-${i}`, `orphan-${i}`),
      ),
    );
    mockedReadPage.mockImplementation(async (slug: string) =>
      ownedByCaller(slug),
    );

    await GET(listRequest(`?limit=${OVER_BUDGET}`));

    expect(mockedReadPage).toHaveBeenCalledTimes(MAX_ORPHAN_PROBES);
    expect(mockedWarn).not.toHaveBeenCalled();
  });

  it("keeps walking past the budget wall so a readable indexed row still lists", async () => {
    // The mutant this kills: `break` instead of `continue` when the budget is
    // spent. That would drop `ing-indexed`, which costs no read at all.
    mockedListWikiPages.mockResolvedValue([
      { slug: "page-a", title: "Page A", summary: "" },
    ]);
    mockedReadLedger.mockResolvedValue([
      ...Array.from({ length: OVER_BUDGET }, (_, i) =>
        ledgerEntry(`ing-${i}`, `orphan-${i}`),
      ),
      ledgerEntry("ing-indexed", "page-a"),
    ]);
    mockedReadPage.mockResolvedValue(null);

    const response = await GET(listRequest());

    expect(response.status).toBe(200);
    expect(mockedReadPage).toHaveBeenCalledTimes(MAX_ORPHAN_PROBES);
    expect(await listedIds(response)).toEqual(["ing-indexed"]);
  });

  it("reads a slug shared by two rows exactly once and lists both", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-one", "page-shared"),
      ledgerEntry("ing-two", "page-shared"),
    ]);
    mockedReadPage.mockResolvedValue(ownedByCaller("page-shared"));

    const response = await GET(listRequest());

    expect(await listedIds(response)).toEqual(["ing-one", "ing-two"]);
    expect(mockedReadPage).toHaveBeenCalledTimes(1);
  });

  it("memoizes a NEGATIVE verdict too, so a repeated unreadable slug costs one probe", async () => {
    // The mutant this kills: caching only `true`. The two `page-bad` rows would
    // then burn two of the fifty probes, and the last readable orphan below
    // would fall off the end of the budget instead of listing.
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-bad-1", "page-bad"),
      ledgerEntry("ing-bad-2", "page-bad"),
      ...Array.from({ length: MAX_ORPHAN_PROBES - 1 }, (_, i) =>
        ledgerEntry(`ing-${i}`, `orphan-${i}`),
      ),
    ]);
    mockedReadPage.mockImplementation(async (slug: string) =>
      slug === "page-bad"
        ? diskPage("page-bad", { owner: "bob", visibility: "private" })
        : ownedByCaller(slug),
    );

    const response = await GET(listRequest(`?limit=${OVER_BUDGET}`));

    expect(slugsRead().filter((s) => s === "page-bad")).toHaveLength(1);
    expect(mockedReadPage).toHaveBeenCalledTimes(MAX_ORPHAN_PROBES);
    expect(await listedIds(response)).toEqual(
      Array.from({ length: MAX_ORPHAN_PROBES - 1 }, (_, i) => `ing-${i}`),
    );
  });

  it("skips a row with no primary_slug without spending a probe", async () => {
    mockedListWikiPages.mockResolvedValue([]);
    mockedReadLedger.mockResolvedValue([
      { ...ledgerEntry("ing-empty", "unused"), primary_slug: "" },
      ledgerEntry("ing-orphan", "page-orphan"),
    ]);
    mockedReadPage.mockResolvedValue(ownedByCaller("page-orphan"));

    const response = await GET(listRequest());

    expect(await listedIds(response)).toEqual(["ing-orphan"]);
    expect(slugsRead()).toEqual(["page-orphan"]);
  });

  it("stops at `limit` without probing rows it will never return", async () => {
    mockedListWikiPages.mockResolvedValue([
      { slug: "page-a", title: "Page A", summary: "" },
    ]);
    mockedReadLedger.mockResolvedValue([
      ledgerEntry("ing-a", "page-a"),
      ledgerEntry("ing-orphan", "page-orphan"),
    ]);

    const response = await GET(listRequest("?limit=1"));

    expect(await listedIds(response)).toEqual(["ing-a"]);
    expect(mockedReadPage).not.toHaveBeenCalled();
  });

  it("401s an unauthenticated caller before any ledger or page read", async () => {
    mockedGetPrincipal.mockResolvedValue(null);

    const response = await GET(listRequest());

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "Unauthorized" });
    expect(mockedReadLedger).not.toHaveBeenCalled();
    expect(mockedListWikiPages).not.toHaveBeenCalled();
    expect(mockedReadPage).not.toHaveBeenCalled();
  });

  it.each(["?limit=0", "?limit=abc"])(
    "400s %s before any ledger or page read",
    async (query) => {
      const response = await GET(listRequest(query));

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: "limit must be a positive integer",
      });
      expect(mockedReadLedger).not.toHaveBeenCalled();
      expect(mockedListWikiPages).not.toHaveBeenCalled();
      expect(mockedReadPage).not.toHaveBeenCalled();
    },
  );
});
