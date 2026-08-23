import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/owner-route", () => ({ requireOwnerPrincipal: vi.fn() }));
vi.mock("@/lib/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/config")>()),
  isReadOnly: vi.fn(() => false),
}));
vi.mock("@/lib/graph-build", () => ({
  buildWikiGraph: vi.fn(async () => ({ nodes: [], edges: [] })),
}));
vi.mock("@/lib/graph-insight-dismissals", () => ({
  insightDismissalMap: vi.fn(async () => new Map()),
  dismissInsight: vi.fn(),
  listInsightDismissals: vi.fn(async () => []),
}));
vi.mock("@/lib/research-prefill", () => ({
  buildResearchPrefill: vi.fn(async (_slugs: string[], topic: string) => ({
    topic,
    queries: [`Research ${topic}`],
  })),
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

const mockedOwner = vi.mocked(requireOwnerPrincipal);
const mockedReadOnly = vi.mocked(isReadOnly);
const mockedBuildGraph = vi.mocked(buildWikiGraph);

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
      getWorkbenchGraph(),
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
      getReviewQueue(),
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
    const response = await getWorkbenchGraph();
    expect(response.status).toBe(200);
    const body = (await response.json()) as { insights?: Array<{ kind: string; id: string }> };
    expect(body.insights?.some((insight) => insight.id === "isolated:alone")).toBe(true);
  });
});
