import { describe, expect, it } from "vitest";
import {
  browsePageExcerpt,
  browsePageHref,
  browsePageKind,
  humanizeBrowseTag,
} from "../browse-explorer-view";
import type { IndexEntry } from "../types";

function page(overrides: Partial<IndexEntry> = {}): IndexEntry {
  return {
    slug: "measurement-plan",
    title: "Measurement plan",
    summary: "A practical measurement framework.",
    owner: "ChristianLee",
    ...overrides,
  };
}

describe("browse explorer presentation", () => {
  it("keeps every link owner-scoped — the commons URL is retired", () => {
    expect(browsePageHref(page())).toBe("/u/christianlee/measurement-plan");
    expect(browsePageHref(page({ visibility: "private" }))).toBe(
      "/u/christianlee/measurement-plan",
    );
    expect(browsePageHref(page({ type: "agent-knowledge" }))).toBe(
      "/u/christianlee/measurement-plan",
    );
  });

  it("derives compact file kinds without inventing source formats", () => {
    expect(browsePageKind(page())).toEqual({ label: "Wiki document" });
    expect(browsePageKind(page({ type: "agent-knowledge" })).label).toBe(
      "Agent knowledge",
    );
  });

  it("cleans placeholder summaries and humanizes topic folders", () => {
    expect(browsePageExcerpt(page({ summary: "## Summary" }))).toBe(
      "No summary has been generated yet.",
    );
    expect(humanizeBrowseTag("communications-measurement")).toBe(
      "communications measurement",
    );
  });
});
