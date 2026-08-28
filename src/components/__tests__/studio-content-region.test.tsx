import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { KnowledgeStudio } from "@/components/KnowledgeStudio";

/**
 * The studio's content column is a NAMED REGION (DW-152).
 *
 * `KnowledgeStudio` puts the substance of the surface between two labelled
 * rails — "Knowledge Studio sections" on the left, "Evidence and actions" on
 * the right. Both are `<aside>`s, so a screen-reader user enumerating landmarks
 * could jump to either edge and not to the thing they came for: the column
 * itself was a plain `<div className="studio-main">` with no role and no name.
 *
 * `single-main-landmark-scan.test.ts` pins the SOURCE — that the wrapper is a
 * `<section>` still carrying `studio-main`. This suite is the other half: the
 * rendered accessibility tree, where the region either has a name or does not.
 * A `<section>` with no accessible name is not a `region` at all, so the two
 * checks fail in different ways and neither implies the other.
 *
 * The name comes from the `<h2>` the header already renders, via
 * `aria-labelledby`, so it FOLLOWS the section the owner opened rather than
 * being a second constant that can drift from the heading beside it. The second
 * case below is the whole reason that matters.
 */

vi.mock("next/navigation", () => ({
  usePathname: () => "/studio",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/**
 * Every read the studio makes on mount, answered empty.
 *
 * Nothing here is the subject — the region and its name exist whatever the
 * panels contain — so the table is the minimum that lets the tree render
 * without an error banner standing in for the content.
 */
const ROUTES: Record<string, unknown> = {
  "/api/wiki/routes": {},
  "/api/vaults": { vaults: [] },
  "/api/agents?mine=1": { agents: [] },
  "/api/ingest/jobs?limit=16": { jobs: [] },
  "/api/review/proposals?status=pending": { proposals: [] },
  "/api/knowledge/insights?scope=mine": { insights: [] },
  // No project is in a polling status, so the Research desk mounts no interval.
  "/api/research": { projects: [], availableProviders: [] },
  "/api/agent-skills": { skills: [] },
  "/api/knowledge/compilation": { contributions: [] },
};

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (!(url in ROUTES)) throw new Error(`unexpected fetch: ${url}`);
      return ok(ROUTES[url]);
    }),
  );
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's own `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed, since the tree reads on mount.
  cleanup();
  vi.unstubAllGlobals();
});

describe("KnowledgeStudio content region", () => {
  it("names the content column after the section on screen", async () => {
    render(<KnowledgeStudio />);

    // "Compile" is the landing section.
    const region = await screen.findByRole("region", { name: "Compile" });
    expect(region.className).toBe("studio-main");
  });

  it("keeps the region between the two labelled rails", async () => {
    const { container } = render(<KnowledgeStudio />);
    await screen.findByRole("region", { name: "Compile" });

    // The landmark ORDER is the point: a reader tabbing through landmarks
    // reaches the section list, then the substance, then the evidence rail.
    const shell = container.querySelector(".knowledge-studio");
    const order = Array.from(shell?.children ?? []).map((child) => child.tagName);
    expect(order).toEqual(["ASIDE", "SECTION", "ASIDE"]);
  });

  it("follows the heading when the owner opens another section", async () => {
    render(<KnowledgeStudio />);
    await screen.findByRole("region", { name: "Compile" });

    fireEvent.click(screen.getByRole("button", { name: /Research desk/ }));

    // `aria-labelledby` points at the `<h2>` the header already renders, so
    // there is no second copy of the label to fall out of step with it.
    await waitFor(() => {
      expect(screen.getByRole("region", { name: "Research desk" })).toBeTruthy();
    });
    expect(screen.queryByRole("region", { name: "Compile" })).toBeNull();
  });
});
