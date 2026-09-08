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
  pruneStaleIndexEntry: vi.fn(async () => ({ removed: true })),
}));

vi.mock("../alias-index", () => ({
  resolveAlias: vi.fn(),
}));

import { resolveAlias } from "../alias-index";
import { writeWikiPageWithSideEffects } from "../lifecycle";
import { FixValidationError } from "../lint-fix";
import { listWikiPages, readWikiPage } from "../wiki";
import { WORKBENCH_MECHANICAL_FIX } from "../workbench-lint-types";
import { fixWorkbenchLintIssue } from "../workbench-lint-fix";

const mockedRead = vi.mocked(readWikiPage);
const mockedList = vi.mocked(listWikiPages);
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
    mockedRead.mockImplementation(async (slug) =>
      slug === "current-name"
        ? {
            slug,
            title: "Current Name",
            content: "# Current Name",
            path: "/wiki/current-name.md",
          }
        : {
            slug: "linker",
            title: "Linker",
            content:
              "# Linker\n\nSee [[old-name]], [Old](old-name.md), and " +
              "[external](https://example.com/old-name.md).",
            path: "/wiki/linker.md",
          },
    );
    const result = await fixWorkbenchLintIssue("renamed-slug", "linker", "old-name");
    expect(result.success).toBe(true);
    expect(mockedWrite).toHaveBeenCalledOnce();
    const written = mockedWrite.mock.calls[0][0];
    expect(written.content).toContain("[[current-name]]");
    expect(written.content).toContain("[Old](current-name.md)");
    expect(written.content).toContain("[external](https://example.com/old-name.md)");
    expect(written.content).not.toContain("[Old](old-name.md)");
    expect(written.logOp).toBe("edit");
    expect(written.expectedContent).toContain("[[old-name]]");
  });

  it("preserves fragments and leaves code examples untouched", async () => {
    mockedResolve.mockResolvedValue("current-name");
    const source =
      "\uFEFF---\naliases: [old-name]\n---\n\n# Linker\n\n" +
      "See [[Old Name#section|Old]], [[wiki/old-name.md#more|More]], and ``[[old-name]]``.\n\n" +
      "~~~md\n[[old-name]]\n~~~\n\n    [[old-name]]\n\nLiteral sentinel: \0CODE9\0.\n";
    mockedRead.mockImplementation(async (slug) =>
      slug === "current-name"
        ? {
            slug,
            title: "Current Name",
            content: "# Current Name",
            path: "/wiki/current-name.md",
          }
        : {
            slug: "linker",
            title: "Linker",
            content: source,
            path: "/wiki/linker.md",
          },
    );
    const result = await fixWorkbenchLintIssue("renamed-slug", "linker", "old-name");
    expect(result.success).toBe(true);
    const written = mockedWrite.mock.calls[0][0];
    expect(written.content).toContain("[[current-name#section|Old]]");
    expect(written.content).toContain("[[current-name#more|More]]");
    expect(written.content).toContain("``[[old-name]]``");
    expect(written.content).toContain("~~~md\n[[old-name]]\n~~~");
    expect(written.content).toContain("    [[old-name]]");
    expect(written.content).toContain("aliases: [old-name]");
    expect(written.content).toContain("\0CODE9\0");
  });

  it("refuses a stale report that is no longer a live issue", async () => {
    mockedRead.mockResolvedValue({
      slug: "gone",
      title: "Gone",
      content: "# Gone",
      path: "/wiki/gone.md",
    });
    await expect(fixWorkbenchLintIssue("broken-link", "src", "gone")).rejects.toBeInstanceOf(
      FixValidationError,
    );
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  it("drops a dangling [[slug]] through the Workbench wrapper", async () => {
    mockedRead.mockImplementation(async (slug) =>
      slug === "gone"
        ? null
        : {
            slug: "src",
            title: "Src",
            content:
              "# Src\n\nSee [[Gone]], [[wiki/gone.md#part|missing]], and [Gone](gone.md); keep [[stay]].\n\n" +
              "```md\n[[gone]]\n```\n\n    [[gone]]\n",
            path: "/wiki/src.md",
          },
    );
    const result = await fixWorkbenchLintIssue("broken-link", "src", "gone");
    expect(result.success).toBe(true);
    expect(mockedWrite).toHaveBeenCalledOnce();
    const written = mockedWrite.mock.calls[0][0];
    expect(written.content).not.toContain("[[Gone]]");
    expect(written.content).not.toContain("[[wiki/gone.md#part|missing]]");
    expect(written.content).toContain("[Gone](gone.md)");
    expect(written.content).toContain("```md\n[[gone]]\n```");
    expect(written.content).toContain("    [[gone]]");
    expect(written.content).toContain("[[stay]]");
    expect(written.logOp).toBe("edit");
  });

  it("reports a markdown-only broken link but refuses to rewrite it", async () => {
    mockedRead.mockImplementation(async (slug) =>
      slug === "gone"
        ? null
        : {
            slug: "src",
            title: "Src",
            content: "# Src\n\nSee [Gone](gone.md).",
            path: "/wiki/src.md",
          },
    );
    await expect(fixWorkbenchLintIssue("broken-link", "src", "gone")).rejects.toBeInstanceOf(
      FixValidationError,
    );
    expect(mockedWrite).not.toHaveBeenCalled();
  });

  /**
   * The trigger is recorded, the author is not touched — ON ALL THREE BRANCHES
   * (DW-447).
   *
   * `POST /api/lint/workbench-fix` resolves an owner and used to hand that
   * handle down as `author`, which is how a human ends up credited with a
   * machine-generated edit in the revision sidecar, the page's `contributors`
   * and their trust score.
   *
   * ONE ROW PER BRANCH, because this wrapper forks three ways and the argument
   * lists differ: `fixRenamedSlug` and `fixDanglingWikilink` take
   * `(slug, target, author, triggeredBy)`, while the fall-through calls
   * `fixLintIssue(type, slug, target, message, author, triggeredBy)` — a
   * six-argument call where dropping the `undefined` message puts the handle
   * back in the AUTHOR slot, type-checks cleanly, and reinstates the exact
   * defect this change removed. A single `broken-link` row left that mutation
   * green across the whole suite.
   *
   * Each row asserts BOTH halves, since the defect is a swap: `"lint-fix"` in
   * the author slot AND the handle on the log line.
   */
  const seeGone = () =>
    mockedRead.mockImplementation(async (slug) =>
      slug === "gone"
        ? null
        : {
            slug: "src",
            title: "Src",
            content: "# Src\n\nSee [[Gone]].",
            path: "/wiki/src.md",
          },
    );

  const seeRenamed = () => {
    mockedResolve.mockResolvedValue("current-name");
    mockedRead.mockImplementation(async (slug) =>
      slug === "current-name"
        ? {
            slug,
            title: "Current Name",
            content: "# Current Name",
            path: "/wiki/current-name.md",
          }
        : {
            slug: "linker",
            title: "Linker",
            content: "# Linker\n\nSee [[old-name]].",
            path: "/wiki/linker.md",
          },
    );
  };

  /** `orphan-page`: on disk, absent from the index — the fall-through branch. */
  const seeOrphan = () => {
    mockedRead.mockResolvedValue({
      slug: "orphan",
      title: "Orphan Page",
      content: "# Orphan Page\n\nSome content about orphans.",
      path: "/wiki/orphan.md",
    });
    mockedList.mockResolvedValue([]);
  };

  const writtenDetail = () =>
    mockedWrite.mock.calls[0][0].logDetails?.({ updatedSlugs: [] });

  it("records the trigger on the fixDanglingWikilink branch", async () => {
    seeGone();

    await fixWorkbenchLintIssue("broken-link", "src", "gone", undefined, "bob");

    expect(mockedWrite.mock.calls[0][0].author).toBe("lint-fix");
    expect(writtenDetail()).toBe(
      'auto-fix: removed dangling wikilink(s) to "gone" (triggered by bob)',
    );
  });

  it("records the trigger on the fixRenamedSlug branch", async () => {
    seeRenamed();

    await fixWorkbenchLintIssue("renamed-slug", "linker", "old-name", undefined, "bob");

    expect(mockedWrite.mock.calls[0][0].author).toBe("lint-fix");
    expect(writtenDetail()).toBe(
      'auto-fix: rewrote renamed slug "old-name" → "current-name" (triggered by bob)',
    );
  });

  it("records the trigger on the fixLintIssue fall-through", async () => {
    // `orphan-page` takes the dispatcher path, where the trigger has to survive
    // an extra hop through `FIX_HANDLERS` as well as this wrapper's own call.
    seeOrphan();

    await fixWorkbenchLintIssue("orphan-page", "orphan", undefined, undefined, "bob");

    expect(mockedWrite.mock.calls[0][0].author).toBe("lint-fix");
    expect(writtenDetail()).toBe("auto-fix: added orphan page to index (triggered by bob)");
  });

  it.each([
    ["the fixDanglingWikilink branch", seeGone, ["broken-link", "src", "gone"] as const,
      'auto-fix: removed dangling wikilink(s) to "gone"'],
    ["the fixRenamedSlug branch", seeRenamed, ["renamed-slug", "linker", "old-name"] as const,
      'auto-fix: rewrote renamed slug "old-name" → "current-name"'],
    ["the fixLintIssue fall-through", seeOrphan, ["orphan-page", "orphan", undefined] as const,
      "auto-fix: added orphan page to index"],
  ])(
    "leaves the log line untouched on %s when no principal was resolved",
    async (_label, seed, [type, slug, target], expected) => {
      // The in-process shape (no door, no owner): byte-identical to the line
      // each fix wrote before a trigger could be recorded at all.
      seed();

      await fixWorkbenchLintIssue(type, slug, target);

      expect(writtenDetail()).toBe(expected);
    },
  );

  it("allows the two index.md-drift classes and no others", async () => {
    expect(WORKBENCH_MECHANICAL_FIX.has("orphan-page")).toBe(true);
    expect(WORKBENCH_MECHANICAL_FIX.has("stale-index")).toBe(true);
    expect(WORKBENCH_MECHANICAL_FIX.has("disputed-page")).toBe(false);
  });
});
