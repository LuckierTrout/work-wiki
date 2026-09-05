import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// GET /api/raw/[slug] — the first GET coverage this door has ever had.
//
// DW-742. The route gated only on `canReadSlug`, which is frontmatter-only, so
// the raw SOURCE TEXT of a page the Knowledge tab hides was served to anyone:
// an AGENT-SCOPED page needs no `visibility: private` to be hidden — the
// knowledge tree drops it — and the Workbench Files tab withheld
// `raw/sources/<slug>` while a plain unauthenticated GET returned the document.
// The fix adds the SAME second gate `/api/assets/[...path]` grew for the same
// hole (DW-536), derived the same way.
//
// `workbench-tree` / `workbench-files` are deliberately NOT mocked: the point
// is that this door derives the same gate the Workbench doors do, so the
// derivation itself (`buildKnowledgeTree` → `workbenchSlugGate` →
// `rawPathAllowed`) has to run for real here. `assets-route.test.ts` is the
// template.
// ---------------------------------------------------------------------------

vi.mock("@/lib/wiki", () => ({
  listReadableWikiPages: vi.fn(),
  readRawSource: vi.fn(),
  readRawSourceById: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/authz", () => ({ canReadSlug: vi.fn() }));
vi.mock("@/lib/page-redirect", () => ({
  canonicalSlugHintForMissing: vi.fn(async () => ({})),
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  listReadableWikiPages,
  readRawSource,
  readRawSourceById,
} from "@/lib/wiki";
import { getPrincipal } from "@/lib/auth";
import { canReadSlug } from "@/lib/authz";
import { canonicalSlugHintForMissing } from "@/lib/page-redirect";
import { logger } from "@/lib/logger";
import { GET } from "@/app/api/raw/[slug]/route";

const mockedList = vi.mocked(listReadableWikiPages);
const mockedReadRaw = vi.mocked(readRawSource);
const mockedReadRawById = vi.mocked(readRawSourceById);
const mockedGetPrincipal = vi.mocked(getPrincipal);
const mockedCanReadSlug = vi.mocked(canReadSlug);
const mockedHint = vi.mocked(canonicalSlugHintForMissing);

const SOURCE_TEXT = "the verbatim arriving document";

/** An index entry, in the shape `workbenchSlugGate` reads. */
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

function call(slug: string, source?: string) {
  const url = source
    ? `http://localhost/api/raw/${slug}?source=${source}`
    : `http://localhost/api/raw/${slug}`;
  return GET(new Request(url), { params: Promise.resolve({ slug }) });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedGetPrincipal.mockResolvedValue(null);
  mockedCanReadSlug.mockResolvedValue(true);
  mockedHint.mockResolvedValue({});
  // Default: an empty index, so the slug gate refuses nothing.
  mockedList.mockResolvedValue([]);
  mockedReadRaw.mockResolvedValue({
    slug: "concept-a",
    filename: "concept-a.md",
    content: SOURCE_TEXT,
  } as never);
  mockedReadRawById.mockResolvedValue({
    slug: "concept-a",
    filename: "concept-a/abc123.md",
    content: SOURCE_TEXT,
  } as never);
});

describe("GET /api/raw/[slug]", () => {
  it("serves an admitted public page's source as text/plain with NO session", async () => {
    mockedList.mockResolvedValue([entry("concept-a")]);

    const res = await call("concept-a");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SOURCE_TEXT);
    expect(res.headers.get("Content-Type")).toBe("text/plain; charset=utf-8");
    expect(res.headers.get("Content-Disposition")).toContain("concept-a.md");
    // The door stays NO-AUTH. What it no longer does is skip principal
    // resolution — the gate is derived per-caller, so the principal has to be
    // resolved to derive it at all.
    expect(mockedGetPrincipal).toHaveBeenCalled();
    expect(mockedList).toHaveBeenCalledWith(null);
  });

  it("serves the per-source snapshot of an ADMITTED page (`?source=<rawId>`)", async () => {
    // The success direction of the `?source` shape. Without it,
    // `readRawSourceById` never runs to completion anywhere in this file, and a
    // gate that admitted the flat shape while refusing (or mis-routing) the
    // per-source one would pass on the 404 rows alone.
    mockedList.mockResolvedValue([entry("concept-a")]);

    const res = await call("concept-a", "abc123");

    expect(res.status).toBe(200);
    expect(await res.text()).toBe(SOURCE_TEXT);
    expect(mockedReadRawById).toHaveBeenCalledWith("concept-a", "abc123");
    expect(mockedReadRaw).not.toHaveBeenCalled();
    expect(res.headers.get("Content-Disposition")).toContain("abc123.md");
  });

  it("404s an AGENT-SCOPED page's source unauthenticated, before reading any bytes", async () => {
    // The DW-742 ablation. `canReadSlug` answers TRUE here — the page is
    // `visibility: public` — so only the slug gate refuses it, exactly as the
    // Files tab already does.
    mockedList.mockResolvedValue([entry("agent-notes", "agent-knowledge")]);

    const res = await call("agent-notes");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(mockedReadRaw).not.toHaveBeenCalled();
  });

  it("404s the per-source snapshot of that same hidden page (`?source=<rawId>`)", async () => {
    // Both raw shapes derive the SAME slug through `rawPathSlug`, so gating on
    // `raw/sources/<slug>.md` decides `raw/sources/<slug>/<rawId>.<ext>` too —
    // without interpolating an unvalidated `?source` value into a gate path.
    mockedList.mockResolvedValue([entry("agent-notes", "agent-knowledge")]);

    const res = await call("agent-notes", "abc123");

    expect(res.status).toBe(404);
    expect(mockedReadRawById).not.toHaveBeenCalled();
  });

  it("still refuses a private page through the canReadSlug arm, before the gate", async () => {
    // Unchanged from today. `hiddenSlugs` is derived from entries the principal
    // can READ, so a private page an anonymous caller cannot read is absent
    // from that set entirely — only the visibility arm refuses it. The two
    // gates cover disjoint holes; neither subsumes the other.
    mockedCanReadSlug.mockResolvedValue(false);

    const res = await call("secret");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not found" });
    expect(mockedList).not.toHaveBeenCalled();
    expect(mockedReadRaw).not.toHaveBeenCalled();
  });

  it("carries the DW-233 canonicalSlug hint on a gate refusal, like every other refusal here", async () => {
    mockedList.mockResolvedValue([entry("agent-notes", "agent-knowledge")]);
    mockedHint.mockResolvedValue({ canonicalSlug: "survivor" });

    const res = await call("agent-notes");

    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: "not found",
      canonicalSlug: "survivor",
    });
  });

  it("500s (logged) when the gate cannot be DERIVED — never 404, never the bytes", async () => {
    // Fail closed. The page-index read behind the gate can fail (storage
    // outage, binding failure); falling through to the bytes would reopen the
    // disclosure exactly when the system is least able to notice, and letting
    // the outer catch collapse it to 404 would disguise an incident as a miss.
    mockedList.mockRejectedValue(new Error("R2 service unavailable"));

    const res = await call("concept-a");

    expect(res.status).toBe(500);
    expect(mockedReadRaw).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      "raw",
      "slug gate derivation failed",
      expect.any(Error),
    );
  });

  it("still 404s a missing source through the outer catch", async () => {
    mockedList.mockResolvedValue([entry("concept-a")]);
    mockedReadRaw.mockRejectedValue(new Error("raw source not found: gone"));

    const res = await call("concept-a");

    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain("not found");
  });
});
