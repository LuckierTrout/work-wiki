import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-route", () => {
  const requireOwnerPrincipal = vi.fn();
  return {
    requireOwnerPrincipal,
    // `/api/graph/workbench` now also accepts the owner-automation token, because
    // the Chat Agent's graph tool runs in the sidecar and has no session (Story
    // 8.5). These tests pin the OWNER GATE, not which credential opened it, so
    // the two resolve the same principal here.
    requireOwnerOrServicePrincipal: vi.fn(() => requireOwnerPrincipal()),
  };
});
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  isReadOnly: vi.fn(() => false),
}));
vi.mock("@/lib/graph-build", () => ({
  buildWikiGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
}));
vi.mock("@/lib/graph-insight-dismissals", () => ({
  insightDismissalMap: vi.fn(async () => new Map()),
  reconcileLegacyInsightDismissals: vi.fn(async () => new Map()),
  dismissInsight: vi.fn(),
  listInsightDismissals: vi.fn(async () => []),
  MAX_INSIGHT_ID_LENGTH: 200,
  MAX_INSIGHT_FINGERPRINT_LENGTH: 80,
}));
vi.mock("@/lib/research-prefill", () => ({
  RESEARCH_PREFILL_LIMIT: 12,
  allocateResearchPrefillSlugs: vi.fn((groups: string[][]) => groups.flat()),
  loadResearchPrefillContext: vi.fn(async () => ({ purposeQueries: [], overviewQuery: null })),
  loadResearchPrefillPages: vi.fn(async () => new Map()),
  buildResearchPrefill: vi.fn(async (_slugs: string[], topic: string) => ({
    topic,
    queries: [`Research ${topic}`],
  })),
}));
vi.mock("@/lib/review-queue", () => ({
  reviewSnapshot: vi.fn(async () => ({ items: [], pendingCount: 0 })),
  listReviewItems: vi.fn(async () => []),
  pendingReviewCount: vi.fn(async () => 0),
  skipReviewItem: vi.fn(),
  createPageFromReview: vi.fn(),
}));
vi.mock("@/lib/workbench-lint-fix", () => ({
  fixWorkbenchLintIssue: vi.fn(),
}));

import { isReadOnly } from "@/lib/config";
import { buildWikiGraph } from "@/lib/graph-build";
import { requireOwnerPrincipal } from "@/lib/owner-route";
import { GET as getWorkbenchGraph } from "@/app/api/graph/workbench/route";
import { GET as getInsights, POST as postInsights } from "@/app/api/graph/insights/route";
import { POST as postWorkbenchLint } from "@/app/api/lint/workbench/route";
import { POST as postWorkbenchLintFix } from "@/app/api/lint/workbench-fix/route";
import { GET as getReviewQueue } from "@/app/api/review-queue/route";
import { POST as postReviewItem } from "@/app/api/review-queue/[id]/route";
import { FixValidationError } from "@/lib/lint-fix";
import { dismissInsight } from "@/lib/graph-insight-dismissals";
import { pendingReviewCount, reviewSnapshot, skipReviewItem } from "@/lib/review-queue";
import { fixWorkbenchLintIssue } from "@/lib/workbench-lint-fix";
import { buildResearchPrefill, loadResearchPrefillContext } from "@/lib/research-prefill";

const mockedReviewSnapshot = vi.mocked(reviewSnapshot);
const mockedPendingReview = vi.mocked(pendingReviewCount);
const mockedSkipReview = vi.mocked(skipReviewItem);
const mockedFix = vi.mocked(fixWorkbenchLintIssue);
const mockedDismissInsight = vi.mocked(dismissInsight);

const mockedOwner = vi.mocked(requireOwnerPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedBuildGraph = vi.mocked(buildWikiGraph);
const mockedBuildPrefill = vi.mocked(buildResearchPrefill);
const mockedLoadPrefillContext = vi.mocked(loadResearchPrefillContext);

function request(url: string, method = "GET", body?: Record<string, unknown>) {
  return new Request(url, {
    method,
    headers: { "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedOwner.mockResolvedValue(null);
  mockedReadOnly.mockReturnValue(false);
  mockedBuildGraph.mockResolvedValue({ nodes: [], edges: [] });
});

describe("Epic 5 owner APIs require a signed-in owner", () => {
  it("returns 401 Sign in required. when signed out", async () => {
    const responses = await Promise.all([
      getWorkbenchGraph(request("http://localhost/api/graph/workbench")),
      getInsights(),
      postInsights(request("http://localhost/api/graph/insights", "POST", {
        id: "x",
        fingerprint: "y",
      })),
      postWorkbenchLint(request("http://localhost/api/lint/workbench", "POST", {})),
      postWorkbenchLintFix(request("http://localhost/api/lint/workbench-fix", "POST", {
        type: "broken-link",
        slug: "a",
      })),
      getReviewQueue(request("http://localhost/api/review-queue")),
      postReviewItem(
        request("http://localhost/api/review-queue/r1", "POST", { action: "skip" }),
        { params: Promise.resolve({ id: "r1" }) },
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: "Sign in required." });
    }
  });

  it("returns 403 on write doors when the deployment is read-only", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedReadOnly.mockReturnValue(true);
    const responses = await Promise.all([
      postInsights(request("http://localhost/api/graph/insights", "POST", {
        id: "x",
        fingerprint: "y",
      })),
      postWorkbenchLintFix(request("http://localhost/api/lint/workbench-fix", "POST", {
        type: "broken-link",
        slug: "a",
      })),
      postReviewItem(
        request("http://localhost/api/review-queue/r1", "POST", { action: "skip" }),
        { params: Promise.resolve({ id: "r1" }) },
      ),
    ]);
    for (const response of responses) {
      expect(response.status).toBe(403);
    }
  });

  it("returns automatic Insights without an analyze click", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedBuildGraph.mockResolvedValue({
      nodes: [
        { id: "alone", label: "Alone", tenant: "yopedia", linkCount: 0, tags: [] },
      ],
      edges: [],
    });
    const response = await getWorkbenchGraph(request("http://localhost/api/graph/workbench"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as { insights?: Array<{ kind: string; id: string }> };
    expect(body.insights?.some((insight) => insight.id === "isolated:alone")).toBe(true);
    expect((body as { prefill?: { limit: number; remaining: number } }).prefill).toEqual({
      limit: 12,
      attempted: 1,
      applied: 1,
      failed: 0,
      remaining: 0,
    });
    expect(mockedLoadPrefillContext).toHaveBeenCalledOnce();
    expect(mockedLoadPrefillContext).toHaveBeenCalledWith("alice");
    expect(mockedBuildPrefill).toHaveBeenCalledWith(
      ["alone"],
      "Alone",
      "alice",
      { purposeQueries: [], overviewQuery: null, pages: new Map() },
    );
  });

  it("filters Review list and count by wikiId", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedReviewSnapshot.mockResolvedValue({ items: [{ id: "r1" }], pendingCount: 1 } as never);
    const response = await getReviewQueue(request("http://localhost/api/review-queue?wikiId=wiki-a"));
    expect(response.status).toBe(200);
    expect(mockedReviewSnapshot).toHaveBeenCalledWith("alice", "wiki-a");
    expect(await response.json()).toEqual({
      items: [{ id: "r1" }],
      pendingCount: 1,
      wikiId: "wiki-a",
    });
  });

  it("refuses Review HTTP requests without an explicit Wiki scope", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    const list = await getReviewQueue(request("http://localhost/api/review-queue"));
    const action = await postReviewItem(
      request("http://localhost/api/review-queue/r1", "POST", { action: "skip" }),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(list.status).toBe(400);
    expect(action.status).toBe(400);
    expect(mockedReviewSnapshot).not.toHaveBeenCalled();
    expect(mockedSkipReview).not.toHaveBeenCalled();
  });

  it("normalizes a malformed pendingCount to the listed length", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedReviewSnapshot.mockResolvedValue({
      items: [{ id: "r1" }, { id: "r2" }],
      pendingCount: -3,
    } as never);
    const response = await getReviewQueue(request("http://localhost/api/review-queue?wikiId=wiki-a"));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      items: [{ id: "r1" }, { id: "r2" }],
      pendingCount: 2,
      wikiId: "wiki-a",
    });
  });

  it("scopes Review actions and keeps a successful action successful if count refresh fails", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedSkipReview.mockResolvedValue({ id: "r1", status: "skipped" } as never);
    mockedPendingReview.mockRejectedValue(new Error("count unavailable"));
    const response = await postReviewItem(
      request("http://localhost/api/review-queue/r1", "POST", {
        action: "skip",
        wikiId: "  wiki-a  ",
      }),
      { params: Promise.resolve({ id: "r1" }) },
    );
    expect(response.status).toBe(200);
    expect(mockedSkipReview).toHaveBeenCalledWith("alice", "r1", "wiki-a");
    expect(await response.json()).toEqual({ item: { id: "r1", status: "skipped" } });
  });

  it("reports remaining Insights when prefill hits the explicit limit", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedBuildGraph.mockResolvedValue({
      nodes: Array.from({ length: 13 }, (_, index) => ({
        id: `p${index}`,
        label: `Page ${index}`,
        tenant: "yopedia",
        linkCount: 0,
        tags: [],
      })),
      edges: [],
    });
    const response = await getWorkbenchGraph(request("http://localhost/api/graph/workbench"));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      prefill?: { limit: number; attempted: number; applied: number; failed: number; remaining: number };
      insights?: Array<{ queries?: string[] }>;
    };
    expect(body.prefill).toEqual({
      limit: 12,
      attempted: 12,
      applied: 12,
      failed: 0,
      remaining: 1,
    });
    expect(mockedLoadPrefillContext).toHaveBeenCalledOnce();
    expect(body.insights?.filter((insight) => insight.queries?.[0]?.startsWith("Research "))).toHaveLength(12);
  });

  it("rejects oversized Insight dismissal identities before persistence", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    const oversizedId = await postInsights(request(
      "http://localhost/api/graph/insights",
      "POST",
      { id: "x".repeat(201), fingerprint: "fp" },
    ));
    const oversizedFingerprint = await postInsights(request(
      "http://localhost/api/graph/insights",
      "POST",
      { id: "isolated:page", fingerprint: "x".repeat(81) },
    ));
    expect(oversizedId.status).toBe(400);
    expect(oversizedFingerprint.status).toBe(400);
    expect(mockedDismissInsight).not.toHaveBeenCalled();
  });

  it("returns 400 without writing when a Lint fix report is no longer live", async () => {
    mockedOwner.mockResolvedValue({ handle: "alice" } as never);
    mockedFix.mockRejectedValueOnce(new FixValidationError("Issue is no longer live."));
    const response = await postWorkbenchLintFix(
      request("http://localhost/api/lint/workbench-fix", "POST", {
        type: "broken-link",
        slug: "src",
        target: "gone",
      }),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "Issue is no longer live." });
    // DW-447: the owner is the TRIGGER (fifth), and the `undefined` fourth is
    // what leaves `fixWorkbenchLintIssue`'s `"lint-fix"` author default alone.
    // Before the swap this door passed "alice" as the AUTHOR of a machine edit.
    expect(mockedFix).toHaveBeenCalledWith("broken-link", "src", "gone", undefined, "alice");
  });
});
