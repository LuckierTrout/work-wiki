import { describe, expect, it } from "vitest";
import {
  folderFromRelativePath,
  type VaultExplorerEntry,
} from "@/lib/vault-explorer";
import {
  buildExplorerFacets,
  filterAndSortEntries,
} from "@/lib/vault-explorer-view";

const entries: VaultExplorerEntry[] = [
  {
    slug: "board-pack",
    title: "Board Pack",
    summary: "Quarterly operating review",
    tags: ["finance", "planning"],
    updated: "2026-06-01",
    folderPath: "Company/Board",
    sources: [
      {
        sha256: "a",
        filename: "FY26 Board Pack.pptx",
        contentType: "application/pptx",
        format: "pptx",
        size: 10,
        storedAt: "2026-06-01T00:00:00.000Z",
        relativePath: "Company/Board/FY26 Board Pack.pptx",
      },
    ],
  },
  {
    slug: "budget",
    title: "Annual Budget",
    tags: ["finance"],
    updated: "2026-07-01",
    folderPath: "Company/Finance",
    sources: [
      {
        sha256: "b",
        filename: "Budget.xlsx",
        contentType: "application/xlsx",
        format: "xlsx",
        size: 20,
        storedAt: "2026-07-01T00:00:00.000Z",
      },
    ],
  },
  {
    slug: "field-notes",
    title: "Field Notes",
    tags: ["operations"],
    sources: [],
  },
];

describe("vault explorer view model", () => {
  it("normalizes directory-upload paths without allowing dot segments", () => {
    expect(folderFromRelativePath("  Company\\Q1\\plan.docx ")).toBe("Company/Q1");
    expect(folderFromRelativePath("../Company/./plan.docx")).toBe("Company");
    expect(folderFromRelativePath("plan.docx")).toBeUndefined();
  });

  it("builds ancestor folder counts plus format and tag facets", () => {
    const facets = buildExplorerFacets(entries);
    expect(facets.folders).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "Company", count: 2 }),
        expect.objectContaining({ value: "Company/Board", count: 1, depth: 1 }),
        expect.objectContaining({ value: "__unfiled", count: 1 }),
      ]),
    );
    expect(facets.formats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ value: "pptx", count: 1 }),
        expect.objectContaining({ value: "xlsx", count: 1 }),
        expect.objectContaining({ value: "page", count: 1 }),
      ]),
    );
    expect(facets.tags[0]).toMatchObject({ value: "finance", count: 2 });
  });

  it("searches source filenames and includes descendants of a selected folder", () => {
    expect(
      filterAndSortEntries(entries, "FY26", { kind: "all" }, "title").map(
        (entry) => entry.slug,
      ),
    ).toEqual(["board-pack"]);
    expect(
      filterAndSortEntries(
        entries,
        "",
        { kind: "folder", value: "Company" },
        "title",
      ).map((entry) => entry.slug),
    ).toEqual(["budget", "board-pack"]);
  });

  it("sorts recent documents deterministically", () => {
    expect(
      filterAndSortEntries(entries, "", { kind: "all" }, "recent").map(
        (entry) => entry.slug,
      ),
    ).toEqual(["budget", "board-pack", "field-notes"]);
  });
});
