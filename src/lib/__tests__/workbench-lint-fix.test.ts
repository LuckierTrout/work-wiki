import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../wiki", () => ({
  readWikiPage: vi.fn(),
  readWikiPageWithFrontmatter: vi.fn(),
  writeWikiPage: vi.fn(),
  listWikiPages: vi.fn(),
  updateIndex: vi.fn(),
  appendToLog: vi.fn(),
  isArtifactType: (t: string | undefined) => t === "html",
}));

vi.mock("../lifecycle", () => ({
  writeWikiPageWithSideEffects: vi.fn(async () => ({
    slug: "test",
    updatedSlugs: [],
  })),
  deleteWikiPage: vi.fn(async () => ({
    slug: "test",
    removedFromIndex: true,
    strippedBacklinksFrom: [],
  })),
}));

vi.mock("../alias-index", () => ({
  resolveAlias: vi.fn(),
}));

import { resolveAlias } from "../alias-index";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { FixValidationError } from "../lint-fix";
import { readWikiPage } from "../wiki";
import { WORKBENCH_MECHANICAL_FIX } from "../workbench-lint";
import { fixWorkbenchLintIssue } from "../workbench-lint-fix";

const mockedRead = vi.mocked(readWikiPage);
const mockedWrite = vi.mocked(writeWikiPageWithSideEffects);
const mockedResolve = vi.mocked(resolveAlias);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("Workbench mechanical auto-fix", () => {
  it("refuses non-mechanical classes", async () => {
    await expect(fixWorkbenchLintIssue("disputed-page", "contested")).rejects.toBeInstanceOf(
      FixValidationError,
    );
    await expect(fixWorkbenchLintIssue("contradiction", "a", "b")).rejects.toBeInstanceOf(
      FixValidationError,
    );
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("rewrites a renamed-slug wikilink through the alias", async () => {
    mockedResolve.mockResolvedValue("current-name");
    mockedRead.mockResolvedValue({
      slug: "linker",
      title: "Linker",
      content: "# Linker\n\nSee [[old-name]] and [Old](old-name.md).",
      path: "/wiki/linker.md",
    });
    const result = await fixWorkbenchLintIssue("renamed-slug", "linker", "old-name");
    expect(result.success).toBe(true);
    expect(mockedWrite).toHaveBeenCalledOnce();
    const written = mockedWrite.mock.calls[0][0];
    expect(written.content).toContain("[[current-name]]");
    expect(written.content).toContain("[Old](current-name.md)");
    expect(written.content).not.toContain("old-name.md");
    expect(written.logOp).toBe("edit");
  });

  it("drops a dangling [[slug]] through the Workbench wrapper", async () => {
    mockedRead.mockResolvedValue({
      slug: "src",
      title: "Src",
      content: "# Src\n\nSee [[gone]] and keep [[stay]].",
      path: "/wiki/src.md",
    });
    const result = await fixWorkbenchLintIssue("broken-link", "src", "gone");
    expect(result.success).toBe(true);
    expect(mockedWrite).toHaveBeenCalledOnce();
    const written = mockedWrite.mock.calls[0][0];
    expect(written.content).not.toContain("[[gone]]");
    expect(written.content).toContain("[[stay]]");
    expect(written.logOp).toBe("edit");
  });

  it("allows the two index.md-drift classes and no others", async () => {
    expect(WORKBENCH_MECHANICAL_FIX.has("orphan-page")).toBe(true);
    expect(WORKBENCH_MECHANICAL_FIX.has("stale-index")).toBe(true);
    expect(WORKBENCH_MECHANICAL_FIX.has("disputed-page")).toBe(false);
  });
});
