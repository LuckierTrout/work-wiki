/**
 * Epic 8, the cloud `/api/v1` façade: the FR-76 routes, their refusals, and the
 * one asymmetry between the two hosts.
 *
 * MOCKED AT THE LIBRARY SEAM, like `epic5-routes.test.ts`, because what is under
 * test is the FAÇADE — status codes, field names, clamps and gates — not storage.
 * A suite that stood up real storage for these would be slow and would still not
 * observe the thing that matters: that a route refuses before it reads.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-route", () => {
  const requireOwnerOrServicePrincipal = vi.fn();
  return {
    requireOwnerPrincipal: vi.fn(() => requireOwnerOrServicePrincipal()),
    requireOwnerOrServicePrincipal,
  };
});
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  isReadOnly: vi.fn(() => false),
  getLoopbackApiSettings: vi.fn(() => ({
    enabled: true,
    allowUnauthenticated: false,
    token: "stored-token",
    tokenSource: "store" as const,
  })),
}));
vi.mock("@/lib/wiki-access", () => ({
  requireAccessibleWikiId: vi.fn(),
}));
vi.mock("@/lib/wikis", () => ({
  getWikiRegistry: vi.fn(),
}));
vi.mock("@/lib/wiki", async (orig) => ({
  // PARTIAL, because `wiki-paths.ts` reaches back into this module for
  // `tenantForOwner` — the tenant key and the readable-page listing live in the
  // same file. A total mock here would make every storage key in the façade
  // undefined, and the route would 500 for a reason that has nothing to do with
  // what the test is asking.
  ...(await orig<typeof import("@/lib/wiki")>()),
  listReadableWikiPages: vi.fn(async () => []),
}));
vi.mock("@/lib/workbench-files", () => ({
  listWorkbenchFilePaths: vi.fn(async () => ({ paths: [], truncated: false })),
  readWorkbenchFile: vi.fn(async () => null),
}));
vi.mock("@/lib/graph-build", () => ({
  buildWikiGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
}));
vi.mock("@/lib/source-rescan", async (orig) => ({
  ...(await orig<typeof import("@/lib/source-rescan")>()),
  rescanSources: vi.fn(async () => ({ requested: 0, results: [], remaining: 0 })),
}));
vi.mock("@/lib/wiki-retrieve", () => ({
  retrieveHits: vi.fn(async () => ({
    hits: [],
    vectorPhase: { status: "off" },
  })),
}));
vi.mock("@/lib/review-queue", () => ({
  reviewSnapshot: vi.fn(async () => ({ items: [], pendingCount: 0 })),
  reviewSnapshotIncludingResolved: vi.fn(async () => ({
    items: [],
    pendingCount: 0,
  })),
  isPendingReview: vi.fn(() => true),
  pendingReviewCount: vi.fn(async () => 0),
  skipReviewItem: vi.fn(async () => null),
  reopenReviewItem: vi.fn(async () => null),
  getReviewItem: vi.fn(async () => null),
  createPageFromReview: vi.fn(async () => null),
}));
// PARTIAL, spreading `importOriginal`, like the three sibling suites
// (`research-route.test.ts`, `research-run-route.test.ts`,
// `research-repair-route.test.ts`). A TOTAL mock left every other binding
// `undefined` — including `ResearchProjectBusyError` — and the review route's
// catch does `error instanceof ResearchProjectBusyError`, which THROWS against
// `undefined` rather than returning false. So the mock shape was itself the
// thing that made the 503 rung untestable. The module imports only `config`,
// `errors`, `lock`, `logger`, `read-only`, `storage`, `wiki`,
// `research-concurrency` and `research-contract`; `@/lib/wiki` and
// `@/lib/config` are PARTIAL mocks in this suite, so loading the original is
// safe. Only `createResearchProject` is stubbed.
vi.mock("@/lib/research-projects", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/research-projects")>()),
  createResearchProject: vi.fn(),
}));

import { GET as getHealth } from "@/app/api/v1/health/route";
import { GET as getProjects } from "@/app/api/v1/projects/route";
import { GET as getFiles } from "@/app/api/v1/projects/[wikiId]/files/route";
import { GET as getContent } from "@/app/api/v1/projects/[wikiId]/files/content/route";
import { GET as getGraph } from "@/app/api/v1/projects/[wikiId]/graph/route";
import {
  GET as getReviews,
  PATCH as patchReviews,
} from "@/app/api/v1/projects/[wikiId]/reviews/route";
import { PATCH as patchReview } from "@/app/api/v1/projects/[wikiId]/reviews/[reviewId]/route";
import { POST as postResolve } from "@/app/api/v1/projects/[wikiId]/reviews/resolve/route";
import { POST as postRescan } from "@/app/api/v1/projects/[wikiId]/sources/rescan/route";
import { POST as postSearch } from "@/app/api/v1/projects/[wikiId]/search/route";

import { isReadOnly } from "@/lib/config";
import { ClientInputError } from "@/lib/errors";
import { ReadOnlyError } from "@/lib/read-only";
import { requireOwnerOrServicePrincipal } from "@/lib/owner-route";
import { buildWikiGraph } from "@/lib/graph-build";
import { rescanSources } from "@/lib/source-rescan";
import { getReviewItem, reopenReviewItem, skipReviewItem } from "@/lib/review-queue";
import {
  ResearchProjectBusyError,
  createResearchProject,
} from "@/lib/research-projects";
import { retrieveHits } from "@/lib/wiki-retrieve";
import { requireAccessibleWikiId } from "@/lib/wiki-access";
import { listReadableWikiPages } from "@/lib/wiki";
import { getWikiRegistry } from "@/lib/wikis";
import { listWorkbenchFilePaths, readWorkbenchFile } from "@/lib/workbench-files";
import {
  V1_APP_VERSION,
  V1_FILE_BINARY_ERROR,
  V1_FILE_OUT_OF_SCOPE_ERROR,
  V1_FILE_TOO_LARGE_ERROR,
  V1_INVALID_INPUT_ERROR,
  V1_MAX_FILE_BYTES,
  V1_MAX_GRAPH_LIMIT,
  V1_MAX_TREE_NODES,
  V1_TREE_TOO_LARGE_ERROR,
  V1_UNKNOWN_ACTION_ERROR,
} from "@/lib/v1-contract";

const owner = vi.mocked(requireOwnerOrServicePrincipal);
const access = vi.mocked(requireAccessibleWikiId);
const registry = vi.mocked(getWikiRegistry);
const listPaths = vi.mocked(listWorkbenchFilePaths);
const readFileMock = vi.mocked(readWorkbenchFile);
const graph = vi.mocked(buildWikiGraph);
const rescan = vi.mocked(rescanSources);
const listReadable = vi.mocked(listReadableWikiPages);
const readOnly = vi.mocked(isReadOnly);
const skip = vi.mocked(skipReviewItem);
const reopen = vi.mocked(reopenReviewItem);
const getItem = vi.mocked(getReviewItem);
const research = vi.mocked(createResearchProject);
const retrieve = vi.mocked(retrieveHits);

const params = (wikiId: string) => ({ params: Promise.resolve({ wikiId }) });

function get(url: string) {
  return new Request(url);
}

function send(url: string, method: string, body?: unknown) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/**
 * An index entry in the shape `buildKnowledgeTree` and `workbenchSlugGate`
 * read — the seed `assets-route.test.ts` uses for the same derivation.
 *
 * Module scope, not per-describe: THREE doors forward the pair `v1SlugGate`
 * derives (files, files/content, sources/rescan) and every one of them has to
 * be witnessed against the same listing, or a route that quietly stopped
 * applying the caller's gate would still be reading a green report (DW-752).
 */
function entry(slug: string, type?: string) {
  return {
    slug,
    title: slug,
    summary: "",
    type,
    owner: "alice",
    visibility: "public",
    updated: "2026-01-01T00:00:00.000Z",
  } as never;
}

/**
 * The one listing every gate assertion in this file is derived from.
 *
 * An `agent-` type is the seed because it needs no `visibility: private` to be
 * withheld: `buildKnowledgeTree` skips agent-scoped entries outright, so the
 * slug lands in `hiddenSlugs` and the plain page is the whole of
 * `readableSlugs`. NON-EMPTY on both halves deliberately — a route that
 * hardcoded `{ readableSlugs: new Set(), hiddenSlugs: new Set() }` would satisfy
 * an assertion derived from an empty index and fails against this one.
 */
const GATED_ENTRIES = [entry("agentpage", "agent-knowledge"), entry("alpha")] as never;

/**
 * What `listReadableWikiPages` → `buildKnowledgeTree` → `workbenchSlugGate`
 * makes of {@link GATED_ENTRIES}. `@/lib/workbench-tree` is NOT mocked here, so
 * the real derivation runs and this is the shape the doors must forward.
 *
 * BOTH HALVES are asserted, because a route that picked up one and dropped the
 * other is exactly the drift `v1SlugGate` returns a PAIR to prevent (DW-32).
 *
 * ASSERTED BY EXACT ARGUMENT, never through `expect.objectContaining` (DW-752).
 * That matcher compares each sampled property WITHOUT `iterableEquality`, and a
 * `Set` carries no own enumerable properties — so
 * `objectContaining({ readableSlugs: new Set(["alpha"]) })` matches an EMPTY
 * set and the assertion is vacuous. Verified on this vitest by replacing
 * `...slugGate` with `{ readableSlugs: new Set(), hiddenSlugs: new Set() }` in
 * both `/api/v1` file routes: every `objectContaining` gate assertion in this
 * file still passed. `toHaveBeenCalledWith` on the whole argument does carry
 * `iterableEquality`, so it compares set MEMBERS — which is the only form of
 * this claim that can fail.
 */
const DERIVED_GATE = {
  hiddenSlugs: new Set(["agentpage"]),
  readableSlugs: new Set(["alpha"]),
};

beforeEach(() => {
  vi.clearAllMocks();
  owner.mockResolvedValue({ id: "alice", handle: "alice" } as never);
  access.mockResolvedValue({ ok: true } as never);
  registry.mockResolvedValue({ currentId: "wiki-1", wikis: [] } as never);
  listPaths.mockResolvedValue({ paths: [], truncated: false } as never);
  readFileMock.mockResolvedValue(null as never);
  graph.mockResolvedValue({ nodes: [], edges: [] } as never);
  rescan.mockResolvedValue({ requested: 0, results: [], remaining: 0 } as never);
  // The seam `v1SlugGate` reads. Reset per test to the EMPTY listing the module
  // factory declares, so a case that seeds an index cannot leak its pages into
  // the next one's gate — `vi.clearAllMocks()` clears calls, not the
  // implementation a `mockResolvedValue` installed.
  listReadable.mockResolvedValue([] as never);
  readOnly.mockReturnValue(false);
  retrieve.mockResolvedValue({
    hits: [],
    vectorPhase: { status: "off" },
  } as never);
});

describe("the façade needs a principal", () => {
  it("401s every data route with neither a session nor a service token", async () => {
    owner.mockResolvedValue(null as never);
    const responses = await Promise.all([
      getProjects(get("http://local/api/v1/projects")),
      getFiles(get("http://local/api/v1/projects/current/files"), params("current")),
      getContent(
        get("http://local/api/v1/projects/current/files/content?path=wiki/a.md"),
        params("current"),
      ),
      getReviews(get("http://local/api/v1/projects/current/reviews"), params("current")),
      getGraph(get("http://local/api/v1/projects/current/graph"), params("current")),
      postRescan(
        send("http://local/api/v1/projects/current/sources/rescan", "POST", {}),
        params("current"),
      ),
    ]);
    for (const response of responses) expect(response.status).toBe(401);
  });

  it("answers health without one, because health is how you learn you need one", async () => {
    owner.mockResolvedValue(null as never);
    const response = await getHealth();
    expect(response.status).toBe(200);
    const body = (await response.json()) as Record<string, unknown>;
    // The CLOUD façade cannot observe a loopback port conflict — it is a
    // different machine — so it reports the Worker's own state and says `running`.
    expect(body.status).toBe("running");
    expect(body.version).toBe(V1_APP_VERSION);
    expect(body.authConfigured).toBe(true);
    expect(body.enabled).toBe(true);
    expect(JSON.stringify(body)).not.toContain("stored-token");
  });
});

describe("{id} resolution", () => {
  // NON-EMPTY, so the third argument these cases assert on is a real gate
  // rather than the empty pair the root `beforeEach` leaves behind. Each of
  // them used to accept `expect.anything()` there, which a route that had
  // stopped calling `v1SlugGate` altogether would also satisfy (DW-752).
  beforeEach(() => {
    listReadable.mockResolvedValue(GATED_ENTRIES);
  });

  it("resolves current to the registry's current Wiki", async () => {
    await getFiles(get("http://local/api/v1/projects/current/files"), params("current"));
    // THE CALLER'S OWN GATE, and PROVENANCE is half of that claim: the stub
    // ignores its argument, so the pair below comes back whichever principal
    // `v1SlugGate` was handed. Without this line a door that derived the gate
    // for a hardcoded stranger would still forward `DERIVED_GATE` and pass
    // (DW-752) — the sibling assertion the rescan case already carries.
    expect(listReadable).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "alice" }),
    );
    expect(listPaths).toHaveBeenCalledWith("alice", "wiki-1", {
      ...DERIVED_GATE,
      limit: V1_MAX_TREE_NODES,
    });
  });

  it("passes a UUID straight through without consulting the registry", async () => {
    const id = "8f4e2c1a-0000-4000-8000-000000000000";
    await getFiles(get(`http://local/api/v1/projects/${id}/files`), params(id));
    expect(registry).not.toHaveBeenCalled();
    expect(listPaths).toHaveBeenCalledWith("alice", id, {
      ...DERIVED_GATE,
      limit: V1_MAX_TREE_NODES,
    });
  });

  it("refuses a filesystem path and a spoken name with the access helper's status", async () => {
    // The refusal lives in `requireAccessibleWikiId` so all nine routes inherit
    // it — this asserts the façade honours it rather than resolving anyway.
    access.mockResolvedValue({
      ok: false,
      status: 400,
      error: "invalid_wiki_id",
    } as never);
    const response = await getFiles(
      get("http://local/api/v1/projects/%2FUsers%2Fme%2Fwiki/files"),
      params("/Users/me/wiki"),
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ error: "invalid_wiki_id" });
    expect(listPaths).not.toHaveBeenCalled();
  });

  it("treats a workspace with no Wiki as the unscoped tree, not an error", async () => {
    registry.mockResolvedValue({ currentId: null, wikis: [] } as never);
    const response = await getFiles(
      get("http://local/api/v1/projects/current/files"),
      params("current"),
    );
    expect(response.status).toBe(200);
    expect(listPaths).toHaveBeenCalledWith("alice", null, {
      ...DERIVED_GATE,
      limit: V1_MAX_TREE_NODES,
    });
  });
});

describe("projects", () => {
  it("marks exactly one project current and echoes a display path", async () => {
    // REAL UUIDs, because `wikiDirPath` validates the id before it composes a
    // key — the registry only ever holds minted ones, and a mapper that accepted
    // an arbitrary string would be composing storage keys out of user input.
    const alpha = "11111111-0000-4000-8000-000000000000";
    const beta = "22222222-0000-4000-8000-000000000000";
    registry.mockResolvedValue({
      currentId: beta,
      wikis: [
        { id: alpha, name: "Alpha", createdAt: "2026-01-01T00:00:00.000Z" },
        { id: beta, name: "Beta", createdAt: "2026-01-02T00:00:00.000Z" },
      ],
    } as never);
    const response = await getProjects(get("http://local/api/v1/projects"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      currentId: string;
      projects: {
        id: string;
        name: string;
        isCurrent: boolean;
        path: string;
        hostPath?: string;
      }[];
    };
    // `currentId` AND a per-record flag, so a client rendering a checkmark does
    // not have to correlate two fields to do it.
    expect(body.currentId).toBe(beta);
    expect(body.projects.map((row) => row.isCurrent)).toEqual([false, true]);
    // The `path` is the kernel-relative artifact dir, NOT a host filesystem
    // project root — inventing one would be DW-17 partitioning by the back door.
    expect(body.projects[1].path).toBe(`tenants/alice/wikis/${beta}`);
    expect(body.projects[1].path).not.toMatch(/^\//);
    // The kernel does not mint a hostPath from DATA_DIR + path. Owner project
    // folders come from WORKWIKI_WIKI_ROOTS, not this invented absolute.
    expect(body.projects[1].hostPath).toBeUndefined();
  });
});

describe("files", () => {
  it("filters by root and keeps the paths content takes back", async () => {
    listPaths.mockResolvedValue({
      paths: ["purpose.md", "wiki/alpha.md", "raw/sources/note.txt", "raw/"],
      truncated: false,
    } as never);
    const wiki = await getFiles(
      get("http://local/api/v1/projects/current/files?root=wiki"),
      params("current"),
    );
    await expect(wiki.json()).resolves.toMatchObject({
      root: "wiki",
      files: ["wiki/alpha.md"],
    });

    // `sources` is the product's word for `raw/` and must not be a 400.
    const sources = await getFiles(
      get("http://local/api/v1/projects/current/files?root=sources"),
      params("current"),
    );
    const body = (await sources.json()) as { root: string; files: string[] };
    expect(body.root).toBe("raw");
    // Directory markers are dropped: `files/content` cannot read one.
    expect(body.files).toEqual(["raw/sources/note.txt"]);

    const all = await getFiles(
      get("http://local/api/v1/projects/current/files"),
      params("current"),
    );
    await expect(all.json()).resolves.toMatchObject({ root: "all" });
  });

  it("413s a tree above the cap rather than answering a partial one", async () => {
    listPaths.mockResolvedValue({ paths: ["wiki/a.md"], truncated: true } as never);
    const response = await getFiles(
      get("http://local/api/v1/projects/current/files"),
      params("current"),
    );
    expect(response.status).toBe(413);
    // An agent handed a silent partial tree concludes the missing pages do not
    // exist, and then writes a duplicate.
    await expect(response.json()).resolves.toEqual({
      error: V1_TREE_TOO_LARGE_ERROR,
      limit: V1_MAX_TREE_NODES,
    });
  });
});

describe("files/content refuses in order", () => {
  it("403s an out-of-scope path before it reads anything", async () => {
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", "notes.md"]) {
      const response = await getContent(
        get(
          `http://local/api/v1/projects/current/files/content?path=${encodeURIComponent(path)}`,
        ),
        params("current"),
      );
      expect(response.status).toBe(403);
      await expect(response.json()).resolves.toEqual({
        error: V1_FILE_OUT_OF_SCOPE_ERROR,
      });
    }
    // The point of checking the string first: a traversal attempt never becomes
    // a storage read.
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("415s a binary path by extension, without buffering it", async () => {
    const response = await getContent(
      get(
        "http://local/api/v1/projects/current/files/content?path=raw/sources/deck.pdf",
      ),
      params("current"),
    );
    expect(response.status).toBe(415);
    await expect(response.json()).resolves.toEqual({ error: V1_FILE_BINARY_ERROR });
    expect(readFileMock).not.toHaveBeenCalled();
  });

  it("413s an oversize text file and reports the cap", async () => {
    readFileMock.mockResolvedValue({
      content: "x".repeat(V1_MAX_FILE_BYTES + 1),
    } as never);
    const response = await getContent(
      get("http://local/api/v1/projects/current/files/content?path=wiki/big.md"),
      params("current"),
    );
    expect(response.status).toBe(413);
    await expect(response.json()).resolves.toMatchObject({
      error: V1_FILE_TOO_LARGE_ERROR,
      limit: V1_MAX_FILE_BYTES,
    });
  });

  it("404s a path the gate allowed and storage does not have", async () => {
    readFileMock.mockResolvedValue(null as never);
    const response = await getContent(
      get("http://local/api/v1/projects/current/files/content?path=wiki/gone.md"),
      params("current"),
    );
    // "You may not read this" and "this does not exist" lead an agent to
    // different next actions, so they are different statuses.
    expect(response.status).toBe(404);
  });

  it("serves text with its byte count", async () => {
    readFileMock.mockResolvedValue({ content: "# Alpha\n" } as never);
    const response = await getContent(
      get("http://local/api/v1/projects/current/files/content?path=wiki/alpha.md"),
      params("current"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      wikiId: "current",
      path: "wiki/alpha.md",
      content: "# Alpha\n",
      bytes: 8,
    });
  });

  it("hands the read the gate it derived from the caller's own listing", async () => {
    // DW-752. The door forwards `await v1SlugGate(caller.principal)` as
    // `readWorkbenchFile`'s FOURTH argument, and nothing in this file ever
    // looked at it — not even `expect.anything()` — so a route that dropped the
    // gate, or narrowed the pair to `readableSlugs` alone, would have opened
    // every withheld page through the external door with the suite still green.
    listReadable.mockResolvedValue(GATED_ENTRIES);
    readFileMock.mockResolvedValue({ content: "# Alpha\n" } as never);

    const response = await getContent(
      get("http://local/api/v1/projects/current/files/content?path=wiki/alpha.md"),
      params("current"),
    );

    expect(response.status).toBe(200);
    // Derived FOR THIS CALLER, not merely derived: the listing stub ignores its
    // argument, so the pair alone cannot tell `v1SlugGate(caller.principal)`
    // from `v1SlugGate(someoneElse)`.
    expect(listReadable).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "alice" }),
    );
    expect(readFileMock).toHaveBeenCalledWith(
      "alice",
      "wiki-1",
      "wiki/alpha.md",
      DERIVED_GATE,
    );
  });
});

describe("graph", () => {
  it("is the owner's wikilink graph, clamped, with no dangling edges", async () => {
    graph.mockResolvedValue({
      nodes: [
        { id: "a", label: "Alpha", type: "concept", linkCount: 5 },
        { id: "b", label: "Beta", linkCount: 3 },
        { id: "c", label: "Gamma", linkCount: 1 },
      ],
      edges: [
        { source: "a", target: "b", signals: ["direct link"] },
        { source: "a", target: "c", signals: ["direct link"] },
        { source: "b", target: "c", signals: ["shared source"] },
      ],
    } as never);
    const response = await getGraph(
      get("http://local/api/v1/projects/current/graph?limit=2"),
      params("current"),
    );
    const body = (await response.json()) as {
      truncated: boolean;
      nodeCount: number;
      nodes: { id: string; path: string; nodeType: string | null }[];
      edges: { source: string; target: string; weight: number }[];
    };
    expect(body.nodes.map((node) => node.id)).toEqual(["a", "b"]);
    expect(body.nodes[0]).toMatchObject({
      id: "a",
      label: "Alpha",
      nodeType: "concept",
      path: "wiki/a.md",
    });
    expect(body.truncated).toBe(true);
    expect(body.nodeCount).toBe(2);
    expect(body.edges).toEqual([{ source: "a", target: "b", weight: 1 }]);
    expect(graph).toHaveBeenCalledWith("mine", expect.objectContaining({ handle: "alice" }));
  });

  it("clamps an absurd limit instead of refusing it", async () => {
    graph.mockResolvedValue({ nodes: [], edges: [] } as never);
    const response = await getGraph(
      get("http://local/api/v1/projects/current/graph?limit=99999"),
      params("current"),
    );
    expect(response.status).toBe(200);
    expect(V1_MAX_GRAPH_LIMIT).toBe(1_000);
  });
});

describe("reviews", () => {
  it("is open by default and can be asked for history", async () => {
    const { reviewSnapshot, reviewSnapshotIncludingResolved } = await import(
      "@/lib/review-queue"
    );
    await getReviews(
      get("http://local/api/v1/projects/current/reviews"),
      params("current"),
    );
    expect(reviewSnapshot).toHaveBeenCalled();
    expect(reviewSnapshotIncludingResolved).not.toHaveBeenCalled();

    await getReviews(
      get("http://local/api/v1/projects/current/reviews?status=all"),
      params("current"),
    );
    expect(reviewSnapshotIncludingResolved).toHaveBeenCalled();
  });

  it("bulk-skips and bulk-reopens by explicit id list", async () => {
    skip.mockResolvedValue({ id: "r1", status: "skipped" } as never);
    const skipped = await patchReviews(
      send("http://local/api/v1/projects/current/reviews", "PATCH", {
        ids: ["r1"],
        resolved: true,
      }),
      params("current"),
    );
    expect(skipped.status).toBe(200);
    await expect(skipped.json()).resolves.toMatchObject({
      action: "skip",
      requested: 1,
      changed: 1,
    });
    expect(skip).toHaveBeenCalledWith("alice", "r1", "wiki-1");

    reopen.mockResolvedValue({ id: "r1", status: "pending" } as never);
    const reopened = await patchReviews(
      send("http://local/api/v1/projects/current/reviews", "PATCH", {
        ids: ["r1"],
        resolved: false,
      }),
      params("current"),
    );
    await expect(reopened.json()).resolves.toMatchObject({ action: "reopen" });
  });

  it("400s an unknown verb, an empty list, and a per-review action", async () => {
    const cases: [Record<string, unknown>, RegExp][] = [
      [{ ids: ["r1"], action: "delete_everything" }, /action must be skip/],
      [{ ids: [] }, /ids is required/],
      // `create_page` and `deep_research` are per review and NOT bulk: "I asked
      // it to create a page and it dismissed the card" is the worst possible
      // reading of a typo, so the route says where the verb lives instead.
      [{ ids: ["r1"], action: "create_page" }, /per review/],
      [{ ids: ["r1"], action: "deep_research" }, /per review/],
    ];
    for (const [body, reason] of cases) {
      const response = await patchReviews(
        send("http://local/api/v1/projects/current/reviews", "PATCH", body),
        params("current"),
      );
      expect(response.status).toBe(400);
      const json = (await response.json()) as { error: string; detail?: string };
      expect(json.error).toBe(V1_UNKNOWN_ACTION_ERROR);
      expect(json.detail).toMatch(reason);
    }
    expect(skip).not.toHaveBeenCalled();
    expect(reopen).not.toHaveBeenCalled();
  });

  it("404s deep_research for a review that belongs to another Wiki", async () => {
    const other = {
      id: "r-other",
      kind: "gap",
      title: "Other wiki",
      summary: "Need a page",
      path: "wiki/x.md",
      queries: ["q"],
      status: "pending",
      updatedAt: "2026-08-26T00:00:00.000Z",
      wikiId: "wiki-b",
    };
    getItem.mockImplementation(async (_owner: string, id: string, wikiId?: string) => {
      if (id !== other.id) return null;
      if (wikiId && other.wikiId !== wikiId) return null;
      return other as never;
    });
    research.mockResolvedValue({
      id: "proj-1",
      status: "draft",
      title: "Other wiki",
    } as never);

    const cross = await patchReview(
      send("http://local/api/v1/projects/wiki-a/reviews/r-other", "PATCH", {
        action: "deep_research",
      }),
      { params: Promise.resolve({ wikiId: "wiki-a", reviewId: "r-other" }) },
    );
    expect(cross.status).toBe(404);
    expect(research).not.toHaveBeenCalled();

    const own = await patchReview(
      send("http://local/api/v1/projects/wiki-b/reviews/r-other", "PATCH", {
        action: "deep_research",
      }),
      { params: Promise.resolve({ wikiId: "wiki-b", reviewId: "r-other" }) },
    );
    expect(own.status).toBe(200);
    expect(research).toHaveBeenCalled();
  });

  /**
   * DW-478. `deep_research` calls `createResearchProject`, so the store's typed
   * refusals — the `MAX_PROJECTS` cap and `cleanInput`'s verdict on
   * `item.title` — reach this catch. It answered 500 for all of them, and an
   * agent told "500" retries a request that can never succeed.
   *
   * DW-732 adds the third rung and the row that pins it. This describe had a
   * row for the caller fault, the server fault and the read-only refusal, and
   * none for `ResearchProjectBusyError` — so the one class whose verdict
   * differed from the five `/api/research` doors was the one class nothing
   * asked about.
   */
  describe("deep_research classifies what the store throws", () => {
    const pending = {
      id: "r-deep",
      kind: "gap",
      title: "Gap",
      summary: "Need a page",
      path: "wiki/x.md",
      queries: ["q"],
      status: "pending",
      updatedAt: "2026-08-26T00:00:00.000Z",
    };
    const deepResearch = () =>
      patchReview(
        send("http://local/api/v1/projects/current/reviews/r-deep", "PATCH", {
          action: "deep_research",
        }),
        { params: Promise.resolve({ wikiId: "current", reviewId: "r-deep" }) },
      );

    beforeEach(() => {
      getItem.mockResolvedValue(pending as never);
    });

    // The file-global `beforeEach` calls `vi.clearAllMocks()`, which clears
    // CALLS but not IMPLEMENTATIONS — so a rejection left standing here would
    // surface as a failure in whatever row is added below this block, for a
    // reason nowhere near itself. Reset both seams back to their module-factory
    // state on the way out.
    afterEach(() => {
      research.mockReset();
      getItem.mockReset();
    });

    // The two branches now answer DIFFERENT SHAPES, so they are two rows rather
    // than one `it.each` over a shared body assertion: a caller fault is the
    // façade's machine token plus the sentence in `detail`, a server fault is
    // still the bare message with no token vocabulary to offer.
    it("400s a caller-fault store refusal, as a token plus a detail", async () => {
      const fault = new ClientInputError(
        "This workspace already has the maximum of 100 research projects.",
      );
      research.mockRejectedValue(fault);

      const response = await deepResearch();

      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        error: V1_INVALID_INPUT_ERROR,
        detail: fault.message,
      });
    });

    it("503s a contended registry write, as the store's own retry sentence", async () => {
      // The SAME class `POST /api/research` answers 503 for, reached through
      // the same `createResearchProject`. As a 500 it told an agent that a
      // compare-and-swap which provably never landed was permanent — while the
      // error's own sentence was asking to be retried.
      const fault = new ResearchProjectBusyError(
        "The research project store is busy. Please retry the request.",
      );
      research.mockRejectedValue(fault);

      const response = await deepResearch();

      expect(response.status).toBe(503);
      // The BARE-MESSAGE shape, not the token-plus-detail one: contention is
      // not the caller's bad input and offers an agent nothing to switch-case.
      expect(await response.json()).toEqual({ error: fault.message });
    });

    it("500s a server-fault store failure, body unchanged", async () => {
      const fault = new Error(
        "EINVAL: invalid argument, open '/data/research-projects.json'",
      );
      research.mockRejectedValue(fault);

      const response = await deepResearch();

      expect(response.status).toBe(500);
      expect(await response.json()).toEqual({ error: fault.message });
    });

    it("still 403s a read-only refusal ahead of the input branch", async () => {
      // The read-only branch is checked FIRST in the catch: a `ReadOnlyError`
      // reaching here from a direct library gate must not be reclassified.
      research.mockRejectedValue(new ReadOnlyError("This deployment is read-only."));

      const response = await deepResearch();

      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ error: "This deployment is read-only." });
    });
  });

  it("POST .../reviews/resolve skips by id and names the misses", async () => {
    skip.mockImplementation(async (_owner: string, id: string) =>
      id === "r1" ? ({ id, status: "skipped" } as never) : null,
    );
    const response = await postResolve(
      send("http://local/api/v1/projects/current/reviews/resolve", "POST", {
        ids: ["r1", "missing"],
        action: "skip",
      }),
      params("current"),
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      resolved: ["r1"],
      notFound: ["missing"],
      count: 1,
    });
    expect(skip).toHaveBeenCalledWith("alice", "r1", "wiki-1");
    expect(skip).toHaveBeenCalledWith("alice", "missing", "wiki-1");
  });

  it("403s a bulk patch on a read-only deployment", async () => {
    readOnly.mockReturnValue(true);
    const response = await patchReviews(
      send("http://local/api/v1/projects/current/reviews", "PATCH", {
        ids: ["r1"],
        resolved: true,
      }),
      params("current"),
    );
    expect(response.status).toBe(403);
    expect(skip).not.toHaveBeenCalled();
  });
});

describe("search answers FR-76 and Epic 3 from one retrieval", () => {
  const rows = [
    {
      path: "wiki/alpha.md",
      title: "Alpha",
      snippet: "",
      body: "Alpha is the first letter.",
      score: 9,
    },
    {
      path: "wiki/beta.md",
      title: "Beta",
      snippet: "beta snippet",
      body: "Beta is the second.",
      score: 4,
    },
  ];

  it("emits hits and results side by side, with the same rows under both names", async () => {
    retrieve.mockResolvedValue({
      hits: rows,
      vectorPhase: { status: "off" },
    } as never);
    const response = await postSearch(
      send("http://local/api/v1/projects/current/search", "POST", {
        query: "alpha",
      }),
      params("current"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      query: string;
      topK: number;
      hits: { path: string; snippet: string }[];
      vectorPhase: { status: string };
      mode: string;
      tokenHits: number;
      vectorHits: number;
      results: { path: string; titleMatch: boolean; content?: string }[];
    };
    // `SearchCanvas` has read these two since Epic 3 and must not regress…
    expect(body.hits.map((hit) => hit.path)).toEqual(["wiki/alpha.md", "wiki/beta.md"]);
    expect(body.vectorPhase).toEqual({ status: "off" });
    // …and FR-76's vocabulary is the same rows under `results`.
    expect(body.results.map((row) => row.path)).toEqual(body.hits.map((h) => h.path));
    expect(body.mode).toBe("wiki");
    // With vector search off — the default — every row is a token hit, and
    // `vectorHits: 0` is the honest form of that rather than an omission.
    expect(body.tokenHits).toBe(2);
    expect(body.vectorHits).toBe(0);
    // A title match is the one relevance signal a caller can reason about
    // without the index.
    expect(body.results[0].titleMatch).toBe(true);
    expect(body.results[1].titleMatch).toBe(false);
    // A row with no snippet falls back to the head of the body, exactly as
    // `searchWiki` did, so the `hits` array is byte-identical to before.
    expect(body.hits[0].snippet).toBe("Alpha is the first letter.");
    // `includeContent` is opt-in: a fifty-hit search with page bodies attached
    // is megabytes.
    expect(body.results[0].content).toBeUndefined();
  });

  it("still reports hit counts when the vector leg ran", async () => {
    retrieve.mockResolvedValue({
      hits: rows,
      vectorPhase: { status: "ok" },
    } as never);
    const response = await postSearch(
      send("http://local/api/v1/projects/current/search", "POST", {
        query: "alpha",
        queryEmbedding: [0.1, 0.2],
      }),
      params("current"),
    );
    await expect(response.json()).resolves.toMatchObject({
      tokenHits: 2,
      vectorHits: 2,
    });
  });

  it("attaches page bodies only when asked", async () => {
    retrieve.mockResolvedValue({
      hits: rows,
      vectorPhase: { status: "off" },
    } as never);
    const response = await postSearch(
      send("http://local/api/v1/projects/current/search", "POST", {
        query: "alpha",
        includeContent: true,
      }),
      params("current"),
    );
    const body = (await response.json()) as { results: { content?: string }[] };
    expect(body.results[0].content).toBe("Alpha is the first letter.");
  });

  it("400s an empty query and clamps topK to fifty", async () => {
    const empty = await postSearch(
      send("http://local/api/v1/projects/current/search", "POST", { query: "  " }),
      params("current"),
    );
    // "No hits" is a fact about the wiki, and answering it for a request that
    // asked nothing would let an agent conclude the wiki is empty.
    expect(empty.status).toBe(400);

    await postSearch(
      send("http://local/api/v1/projects/current/search", "POST", {
        query: "alpha",
        topK: 99,
      }),
      params("current"),
    );
    expect(retrieve).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ topK: 50 }),
    );
  });
});

describe("sources/rescan", () => {
  it("answers the queue outcome immediately and leaves ingest async", async () => {
    rescan.mockResolvedValue({
      requested: 2,
      results: [
        { path: "raw/sources/a.txt", queued: true, jobId: "job-1" },
        { path: "raw/sources/b.txt", queued: false, reason: "empty" },
      ],
      remaining: 0,
    } as never);
    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {}),
      params("current"),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      requested: number;
      queued: number;
      results: unknown[];
    };
    // The call returns as soon as the work is SCHEDULED. Waiting for two LLM
    // calls per Source would time out on any real tree.
    expect(body.requested).toBe(2);
    expect(body.queued).toBe(1);
    expect(body.results).toHaveLength(2);
  });

  it("403s a path outside raw/ and never enqueues the batch", async () => {
    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {
        paths: ["raw/sources/a.txt", "wiki/alpha.md"],
      }),
      params("current"),
    );
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: V1_FILE_OUT_OF_SCOPE_ERROR,
      path: "wiki/alpha.md",
    });
    // ONE BAD ENTRY FAILS THE CALL. Dropping it would tell the caller its rescan
    // succeeded for a Source that was never touched.
    expect(rescan).not.toHaveBeenCalled();
  });

  it("hands the rescan the gate it derived from the caller's own listing", async () => {
    // DW-537. The route spreads `await v1SlugGate(caller.principal)` into the
    // call, and the suite used to mock `rescanSources` and assert nothing about
    // its arguments — so `listReadableWikiPages` → `buildKnowledgeTree` →
    // `workbenchSlugGate` never ran through the POST door a real caller hits.
    // `@/lib/workbench-tree` is NOT mocked here, so this drives the real
    // derivation and only the storage read is stubbed. See {@link GATED_ENTRIES}
    // for why that listing is the seed and why both halves are asserted.
    listReadable.mockResolvedValue(GATED_ENTRIES);

    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {}),
      params("current"),
    );

    expect(response.status).toBe(200);
    expect(listReadable).toHaveBeenCalledWith(
      expect.objectContaining({ handle: "alice" }),
    );
    expect(rescan).toHaveBeenCalledWith({
      owner: "alice",
      wikiId: "wiki-1",
      ...DERIVED_GATE,
    });
  });

  it("clears the scope check and still forwards the derived gate", async () => {
    // BOTH GATES LIVE on one 200 (DW-537). The case above sends no `paths`, so
    // the `raw/sources/` scope check is skipped entirely; the case below is a
    // 403, so nothing is forwarded at all. Neither shows the composition a real
    // caller naming a Source actually walks: the path clears `isV1FileInScope`
    // AND `raw/sources/`, and the slug gate derived after it still reaches
    // `rescanSources` alongside the `paths` it was called with.
    listReadable.mockResolvedValue(GATED_ENTRIES);

    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {
        paths: ["raw/sources/a.txt"],
      }),
      params("current"),
    );

    expect(response.status).toBe(200);
    expect(rescan).toHaveBeenCalledWith({
      owner: "alice",
      wikiId: "wiki-1",
      paths: ["raw/sources/a.txt"],
      ...DERIVED_GATE,
    });
  });

  it("runs the raw/sources scope check BEFORE deriving the gate", async () => {
    // The ORDERING, not just the refusal. The sibling case above pins that a bad
    // path never enqueues; this pins that it never even reads the caller's index
    // — the route returns at `isV1FileInScope` several statements above
    // `v1SlugGate`. Seeded identically to the passing case, so the only thing
    // that differs is the `paths` value: a route that derived the gate first
    // would still 403, and only this call count can tell the two apart.
    listReadable.mockResolvedValue(GATED_ENTRIES);

    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {
        paths: ["wiki/alpha.md"],
      }),
      params("current"),
    );

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: V1_FILE_OUT_OF_SCOPE_ERROR,
      path: "wiki/alpha.md",
    });
    expect(rescan).not.toHaveBeenCalled();
    expect(listReadable).not.toHaveBeenCalled();
  });

  it("400s a malformed paths value and 403s under read-only", async () => {
    const malformed = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {
        paths: "raw/sources/a.txt",
      }),
      params("current"),
    );
    expect(malformed.status).toBe(400);
    // The token is the machine half an agent switch-cases on; the sentence
    // naming the offending input rides in `detail` — the `{ error, detail }`
    // shape `reviews/route.ts` and `/api/v1/web-search` already answer with.
    // The sibling refusal further down this same `if` block, `too_many_paths`,
    // is a token too, though it carries `limit` rather than a `detail`.
    expect(await malformed.json()).toEqual({
      error: V1_INVALID_INPUT_ERROR,
      detail: "paths must be an array of strings.",
    });
    // The same ORDERING the scope-check case pins, on the sibling branch of the
    // same `if`: this refusal returns above `v1SlugGate`, so a malformed body
    // costs the caller's index no read at all (DW-537).
    expect(listReadable).not.toHaveBeenCalled();

    readOnly.mockReturnValue(true);
    const refused = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {}),
      params("current"),
    );
    // A rescan's whole purpose is to cause writes downstream, so a deployment
    // that refuses writes refuses the thing that schedules them rather than
    // filling a queue nothing will drain.
    expect(refused.status).toBe(403);
    expect(rescan).not.toHaveBeenCalled();
    // And read-only refuses EARLIEST of all — above the body read, so above the
    // gate too.
    expect(listReadable).not.toHaveBeenCalled();
  });

  it("503s a failed listing so a drain cannot stick on nextCursor", async () => {
    rescan.mockResolvedValue({
      requested: 0,
      results: [],
      remaining: 0,
      nextCursor: null,
      reason: "listing_unavailable",
    } as never);
    const response = await postRescan(
      send("http://local/api/v1/projects/current/sources/rescan", "POST", {}),
      params("current"),
    );
    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      reason: "listing_unavailable",
      nextCursor: null,
    });
  });
});
