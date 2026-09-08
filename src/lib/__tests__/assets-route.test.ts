import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/storage", () => ({
  getStorage: vi.fn(() => ({ readAsset: vi.fn() })),
}));
// rawRelPath maps a markdown ref to the physical storage key (raw/ prefix).
// `workbench-tree` and `workbench-files` are deliberately NOT mocked: the point
// of DW-536 is that this door derives the SAME gate the Workbench doors do, so
// the derivation itself (`buildKnowledgeTree` → `workbenchSlugGate` →
// `rawPathAllowed`) has to run for real here.
vi.mock("@/lib/wiki", () => ({
  rawRelPath: (f: string) => `raw/${f}`,
  readWikiPageWithFrontmatter: vi.fn(),
  listReadableWikiPages: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(),
}));
vi.mock("@/lib/authz", () => ({
  canReadFrontmatter: vi.fn(),
}));

import { getStorage } from "@/lib/storage";
import { listReadableWikiPages, readWikiPageWithFrontmatter } from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { canReadFrontmatter } from "@/lib/authz";
import { GET } from "@/app/api/assets/[...path]/route";

const mockedGetStorage = vi.mocked(getStorage);
const mockedReadPage = vi.mocked(readWikiPageWithFrontmatter);
const mockedListReadable = vi.mocked(listReadableWikiPages);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedCanRead = vi.mocked(canReadFrontmatter);

function readAssetReturning(buf: ArrayBuffer | Error) {
  const readAsset = vi.fn(() =>
    buf instanceof Error ? Promise.reject(buf) : Promise.resolve(buf),
  );
  mockedGetStorage.mockReturnValue({ readAsset } as never);
  return readAsset;
}

function req() {
  return new Request("http://localhost/api/assets/x");
}

/** An index entry, in the shape `workbenchSlugGate` reads. */
function entry(slug: string, type?: string) {
  return {
    slug,
    title: slug,
    type,
    owner: "alice",
    visibility: "public",
    updated: "2026-01-01T00:00:00.000Z",
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Default: page does not exist (public / no auth needed)
  mockedReadPage.mockResolvedValue(null);
  mockedGetPrincipal.mockResolvedValue(null);
  mockedCanRead.mockReturnValue(true);
  // Default: an empty index, so the slug gate refuses nothing.
  mockedListReadable.mockResolvedValue([]);
});

describe("GET /api/assets/[...path]", () => {
  it("serves an asset, mapping assets/<...> → raw/assets/<...> with the right Content-Type", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    const readAsset = readAssetReturning(bytes);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "diagram.png"] }),
    });

    expect(res.status).toBe(200);
    expect(readAsset).toHaveBeenCalledWith("raw/assets/alice/diagram.png");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("404s on a genuinely missing asset (ENOENT)", async () => {
    const enoent = Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    readAssetReturning(enoent);
    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "missing.png"] }),
    });
    expect(res.status).toBe(404);
  });

  it("500s on a real storage failure (not ENOENT) so an outage isn't masked as 404", async () => {
    readAssetReturning(new Error("R2 service unavailable"));
    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "x.png"] }),
    });
    expect(res.status).toBe(500);
  });

  it.each([["..", "x.png"], ["alice", ".."], ["alice", "a/b.png"], ["", "x.png"]])(
    "404s and never reads storage on a traversal/unsafe segment: %j",
    async (...path) => {
      const readAsset = readAssetReturning(new Uint8Array().buffer);
      const res = await GET(req(), { params: Promise.resolve({ path }) });
      expect(res.status).toBe(404);
      expect(readAsset).not.toHaveBeenCalled();
    },
  );

  it("adds a sandbox CSP for SVGs (same-origin script neutralization)", async () => {
    readAssetReturning(new Uint8Array([60]).buffer);
    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "logo.svg"] }),
    });
    expect(res.headers.get("Content-Type")).toBe("image/svg+xml");
    expect(res.headers.get("Content-Security-Policy")).toContain("sandbox");
  });

  it("falls back to application/octet-stream for an unknown extension", async () => {
    readAssetReturning(new Uint8Array([0]).buffer);
    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "file.bin"] }),
    });
    expect(res.headers.get("Content-Type")).toBe("application/octet-stream");
  });

  it("serves an ordinary public page's asset with no session, resolving the principal to derive the gate", async () => {
    const bytes = new Uint8Array([1]).buffer;
    const readAsset = readAssetReturning(bytes);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "public" },
      body: "",
    } as never);
    // `alice` is in the index and survives `buildKnowledgeTree`, so the gate's
    // refusal set does not hold it.
    mockedListReadable.mockResolvedValue([entry("alice")]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "img.png"] }),
    });

    expect(res.status).toBe(200);
    expect(readAsset).toHaveBeenCalledWith("raw/assets/alice/img.png");
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Cache-Control")).toContain("immutable");
    // The route stays NO-AUTH — an anonymous caller still gets the bytes. What
    // it no longer does is SKIP principal resolution: the Workbench slug gate
    // is derived per-caller, so the principal has to be resolved to derive it
    // at all (DW-536, replacing the old "never resolves the principal" claim).
    expect(mockedGetPrincipal).toHaveBeenCalled();
    expect(mockedListReadable).toHaveBeenCalledWith(null);
  });

  it("404s an agent-scoped page's asset unauthenticated, before touching storage", async () => {
    // DW-536. An agent-scoped page needs no `visibility: private` to be hidden:
    // `buildKnowledgeTree` drops it, so `workbenchSlugGate` puts its slug in
    // `hiddenSlugs` and every Workbench door refuses its `raw/assets/` bytes.
    // This door read the same bytes behind the visibility check alone, so the
    // Files tab withheld the asset while a plain GET still served it.
    const readAsset = readAssetReturning(new Uint8Array([1]).buffer);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "public" },
      body: "",
    } as never);
    mockedListReadable.mockResolvedValue([
      entry("agentpage", "agent-knowledge"),
    ]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["agentpage", "pic.png"] }),
    });

    // Bodyless 404, identical to an absent file — no existence oracle.
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("");
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("refuses an agent-scoped page's asset to its OWN OWNER, signed in", async () => {
    // The gate is the Workbench doors' gate for EVERY principal, not a
    // shortcut applied to anonymous callers: `buildKnowledgeTree` drops an
    // agent-scoped page for whoever asks, so its slug is in `hiddenSlugs` even
    // for the owner — which is exactly why the owner's Files tab withholds
    // `raw/assets/agentpage/` too. This is the visible half of that choice, and
    // the reading it pins: door parity beats per-viewer convenience.
    const readAsset = readAssetReturning(new Uint8Array([1]).buffer);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "public" },
      body: "",
    } as never);
    mockedGetPrincipal.mockResolvedValue({ id: "user_alice", handle: "alice" });
    mockedListReadable.mockResolvedValue([
      entry("agentpage", "agent-knowledge"),
    ]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["agentpage", "pic.png"] }),
    });

    expect(res.status).toBe(404);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("still serves the SHARED `illustrations/` prefix while the gate is refusing", async () => {
    // `illustration.ts` stores baked yoyo illustrations at
    // `raw/assets/illustrations/<key>.jpg` and bakes that public URL into saved
    // answers and slides. That prefix is a fixed directory, not a page slug —
    // but `rawPathSlug` reads its first segment as one anyway (the conservative
    // direction `RAW_ASSETS_DIR` documents). So a non-empty `hiddenSlugs` must
    // not take the whole illustration namespace down with it: only a page
    // actually slugged `illustrations` could do that.
    const readAsset = readAssetReturning(new Uint8Array([1]).buffer);
    mockedListReadable.mockResolvedValue([
      entry("agentpage", "agent-knowledge"),
    ]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["illustrations", "abc123.jpg"] }),
    });

    expect(res.status).toBe(200);
    expect(readAsset).toHaveBeenCalledWith("raw/assets/illustrations/abc123.jpg");
  });

  it("404s the asset of a hidden page slugged plain `queries` — both items at one door", async () => {
    // Where DW-492 and DW-536 meet, and the reason they were bundled. The
    // display path `raw/assets/queries/pic.png` derives the slug
    // `queries/pic` — the two-segment shape swallows the filename — so the
    // slug gate alone asks about a page nobody hid. Only DW-492's second
    // candidate (the bare head `queries`) refuses it.
    const readAsset = readAssetReturning(new Uint8Array([1]).buffer);
    mockedListReadable.mockResolvedValue([entry("queries", "agent-knowledge")]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["queries", "pic.png"] }),
    });

    expect(res.status).toBe(404);
    expect(readAsset).not.toHaveBeenCalled();
  });

  it("serves an ORPHAN asset whose slug names no index entry", async () => {
    // The refusal set is derived from the ENTRIES, so a slug the index never
    // names is not hidden — the same rule `workbenchSlugGate` states.
    const readAsset = readAssetReturning(new Uint8Array([1]).buffer);
    mockedListReadable.mockResolvedValue([
      entry("agentpage", "agent-knowledge"),
    ]);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["orphan", "x.png"] }),
    });

    expect(res.status).toBe(200);
    expect(readAsset).toHaveBeenCalledWith("raw/assets/orphan/x.png");
  });

  it("returns 404 for a private-page asset when unauthenticated", async () => {
    readAssetReturning(new Uint8Array([1]).buffer);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "private" },
      body: "",
    } as never);
    mockedGetPrincipal.mockResolvedValue(null);
    mockedCanRead.mockReturnValue(false);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "secret.png"] }),
    });

    expect(res.status).toBe(404);
    expect(mockedGetPrincipal).toHaveBeenCalled();
  });

  it("serves a private-page asset to its owner", async () => {
    const bytes = new Uint8Array([1, 2]).buffer;
    readAssetReturning(bytes);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "private" },
      body: "",
    } as never);
    mockedGetPrincipal.mockResolvedValue({ id: "user_alice", handle: "alice" });
    mockedCanRead.mockReturnValue(true);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "secret.png"] }),
    });

    expect(res.status).toBe(200);
    expect(mockedGetPrincipal).toHaveBeenCalled();
    expect(mockedCanRead).toHaveBeenCalledWith(
      { owner: "alice", visibility: "private" },
      { id: "user_alice", handle: "alice" },
    );
  });

  it("returns 404 for a private-page asset when the wrong user is authenticated", async () => {
    readAssetReturning(new Uint8Array([1]).buffer);
    mockedReadPage.mockResolvedValue({
      frontmatter: { owner: "alice", visibility: "private" },
      body: "",
    } as never);
    mockedGetPrincipal.mockResolvedValue({ id: "user_bob", handle: "bob" });
    mockedCanRead.mockReturnValue(false);

    const res = await GET(req(), {
      params: Promise.resolve({ path: ["alice", "secret.png"] }),
    });

    expect(res.status).toBe(404);
  });
});
