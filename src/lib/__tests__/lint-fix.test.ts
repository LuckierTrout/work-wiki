import { describe, it, expect, beforeEach, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock wiki.ts and lifecycle.ts — the modules lint-fix.ts depends on
// ---------------------------------------------------------------------------

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
  // Mirrors the real `pruneStaleIndexEntry` closely enough for the log line to
  // be observable: it writes the SAME detail string through the SAME
  // `withTriggeredBy` formatter, so the DW-447 rows below are reading the
  // production suffix rather than one this stub invented.
  //
  // NOT end-to-end coverage, though — this stub REBUILDS the wrapped string, so
  // it would keep answering correctly if the real `pruneStaleIndexEntry` lost
  // its `withTriggeredBy` call. What these rows pin is that `fixStaleIndex`
  // FORWARDS the trigger. The load-bearing guard for the line the real function
  // writes lives in `stale-index-lifecycle.test.ts`, against real storage.
  pruneStaleIndexEntry: vi.fn(async (slug: string, triggeredBy?: string) => {
    const { listWikiPages, updateIndex, appendToLog } = await import("../wiki");
    const { withTriggeredBy } = await import("../wiki-log");
    const index = await listWikiPages();
    if (!index.some((entry) => entry.slug === slug)) {
      return { removed: false };
    }
    await updateIndex(index.filter((entry) => entry.slug !== slug));
    await appendToLog(
      "edit",
      slug,
      withTriggeredBy(`auto-fix: removed stale index entry for ${slug}`, triggeredBy),
    );
    return { removed: true };
  }),
}));

vi.mock("../llm", () => ({
  callLLM: vi.fn(async () => "# Rewritten Page\n\nResolved content."),
  hasLLMKey: vi.fn(() => false),
}));

vi.mock("../frontmatter", () => ({
  serializeFrontmatter: vi.fn(
    (data: Record<string, unknown>, body: string) => {
      const lines = ["---"];
      for (const [k, v] of Object.entries(data)) {
        lines.push(`${k}: ${String(v)}`);
      }
      lines.push("---");
      return `${lines.join("\n")}\n\n${body}`;
    },
  ),
}));

import { readWikiPage, readWikiPageWithFrontmatter, listWikiPages, updateIndex, appendToLog } from "../wiki";
import {
  writeWikiPageWithSideEffects,
  deleteWikiPage,
} from "../lifecycle";
import { callLLM, hasLLMKey } from "../llm";

import {
  fixOrphanPage,
  fixStaleIndex,
  fixEmptyPage,
  fixMissingCrossRef,
  fixContradiction,
  fixMissingConceptPage,
  fixStalePage,
  fixUnmigratedPage,
  fixBrokenLink,
  fixSupersededDangling,
  fixLintIssue,
  autoFixRefusal,
  FixValidationError,
  FixNotFoundError,
} from "../lint-fix";
import {
  ALL_CHECK_TYPES,
  AUTO_FIXABLE_CHECK_TYPES,
  disputedClearGuidance,
  type AutoFixableCheckType,
} from "../lint-types";
import { MAINTAIN_FIX_TYPES } from "../tasks";
import { readFile } from "fs/promises";
import path from "path";

const mockedReadWikiPage = vi.mocked(readWikiPage);
const mockedReadWikiPageWithFrontmatter = vi.mocked(readWikiPageWithFrontmatter);
const mockedListWikiPages = vi.mocked(listWikiPages);
const mockedUpdateIndex = vi.mocked(updateIndex);
const mockedAppendToLog = vi.mocked(appendToLog);
const mockedWriteWikiPageWithSideEffects = vi.mocked(
  writeWikiPageWithSideEffects,
);
const mockedDeleteWikiPage = vi.mocked(deleteWikiPage);
const mockedCallLLM = vi.mocked(callLLM);
const mockedHasLLMKey = vi.mocked(hasLLMKey);

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// fixOrphanPage
// ---------------------------------------------------------------------------

describe("fixOrphanPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixOrphanPage("")).rejects.toThrow(FixValidationError);
    await expect(fixOrphanPage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(fixOrphanPage("no-such-page")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixOrphanPage("no-such-page")).rejects.toThrow(
      "Page not found: no-such-page",
    );
  });

  it("adds orphan page to index via writeWikiPageWithSideEffects", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "orphan",
      title: "Orphan Page",
      content: "# Orphan Page\n\nSome content about orphans.",
      path: "/wiki/orphan.md",
    });

    const result = await fixOrphanPage("orphan");

    expect(result).toEqual({
      success: true,
      slug: "orphan",
      message: "Added orphan to index",
    });

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("orphan");
    expect(call.title).toBe("Orphan Page");
    expect(call.content).toBe("# Orphan Page\n\nSome content about orphans.");
    expect(call.summary).toBe("Some content about orphans.");
    expect(call.logOp).toBe("edit");
    expect(call.crossRefSource).toBeNull();
  });

  it("falls back to slug as summary when no first paragraph", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "bare",
      title: "bare",
      content: "No heading here",
      path: "/wiki/bare.md",
    });

    await fixOrphanPage("bare");

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.summary).toBe("bare");
  });
});

// ---------------------------------------------------------------------------
// fixStaleIndex
// ---------------------------------------------------------------------------

describe("fixStaleIndex", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixStaleIndex("")).rejects.toThrow(FixValidationError);
  });

  it("returns no-op when slug is not in the index", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "other", title: "Other", summary: "..." },
    ]);

    const result = await fixStaleIndex("ghost");

    expect(result).toEqual({
      success: true,
      slug: "ghost",
      message: "Entry for ghost not found in index — no changes needed",
    });

    // Should not have called updateIndex or appendToLog
    expect(mockedUpdateIndex).not.toHaveBeenCalled();
    expect(mockedAppendToLog).not.toHaveBeenCalled();
  });

  it("removes stale entry from index", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "good", title: "Good", summary: "keep" },
      { slug: "ghost", title: "Ghost", summary: "remove" },
    ]);

    const result = await fixStaleIndex("ghost");

    expect(result).toEqual({
      success: true,
      slug: "ghost",
      message: "Removed stale entry for ghost from index",
    });

    expect(mockedUpdateIndex).toHaveBeenCalledOnce();
    const updatedEntries = mockedUpdateIndex.mock.calls[0][0];
    expect(updatedEntries).toHaveLength(1);
    expect(updatedEntries[0].slug).toBe("good");

    expect(mockedAppendToLog).toHaveBeenCalledOnce();
    expect(mockedAppendToLog).toHaveBeenCalledWith(
      "edit",
      "ghost",
      "auto-fix: removed stale index entry for ghost",
    );
  });
});

// ---------------------------------------------------------------------------
// fixEmptyPage
// ---------------------------------------------------------------------------

describe("fixEmptyPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixEmptyPage("")).rejects.toThrow(FixValidationError);
  });

  it("delegates to deleteWikiPage", async () => {
    const result = await fixEmptyPage("empty");

    expect(result).toEqual({
      success: true,
      slug: "empty",
      message: "Deleted empty page empty",
    });

    expect(mockedDeleteWikiPage).toHaveBeenCalledOnce();
    // Four arguments since DW-447: `expectedContent` is still unused (this fix
    // never reads the page first), and the trailing trigger is absent because
    // no door resolved a principal for this call.
    expect(mockedDeleteWikiPage).toHaveBeenCalledWith(
      "empty",
      "lint-fix",
      undefined,
      undefined,
    );
  });
});

// ---------------------------------------------------------------------------
// triggeredBy — WHO ASKED, recorded apart from WHO AUTHORED (DW-447)
// ---------------------------------------------------------------------------

/**
 * The trigger lands on the log detail line and NOWHERE else.
 *
 * A lint auto-fix is a machine edit: its `author` is `"lint-fix"`, an
 * `AUTOMATION_ACTORS` member `normalizeActor` folds into the agent, so no human
 * is credited in the revision sidecar, a page's `contributors` or a trust score
 * for text they did not write. Three doors nonetheless know WHO pressed the
 * button, and that fact is worth keeping — as free prose under the log entry's
 * heading, which `contributors.ts`, `normalizeActor` and `pushRecentEvent` all
 * ignore.
 *
 * Rows below cover the three shapes the matrix names — a handle, no handle, a
 * BLANK handle — across the two recording points: a page-writing fix (whose
 * `logDetails` closure the lifecycle pipeline calls) and the two fixes that
 * write no page at all, `stale-index` and `empty-page`. They are driven through
 * `fixLintIssue` rather than the leaf functions so the dispatch table's
 * threading is under test too: a `FIX_HANDLERS` entry that forgot to forward
 * `triggeredBy` would drop it silently.
 */
describe("triggeredBy", () => {
  /** The detail line the lifecycle pipeline would have written. */
  const writtenDetail = () =>
    mockedWriteWikiPageWithSideEffects.mock.calls[0][0].logDetails?.({ updatedSlugs: [] });

  beforeEach(() => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "orphan",
      title: "Orphan Page",
      content: "# Orphan Page\n\nSome content about orphans.",
      path: "/wiki/orphan.md",
    });
  });

  describe("on a page-writing fix", () => {
    it("suffixes the log detail line with the trigger", async () => {
      await fixLintIssue("orphan-page", "orphan", undefined, undefined, undefined, "alice");

      expect(writtenDetail()).toBe("auto-fix: added orphan page to index (triggered by alice)");
    });

    it("still writes `lint-fix` as the author — the trigger is not an author", async () => {
      // The whole point of the split. If this ever reads "alice", the fix is
      // back in the contributor contract and `contributors.test.ts` is next.
      await fixLintIssue("orphan-page", "orphan", undefined, undefined, undefined, "alice");

      expect(mockedWriteWikiPageWithSideEffects.mock.calls[0][0].author).toBe("lint-fix");
    });

    it("leaves the line untouched when no door resolved a principal", async () => {
      // The stdio-MCP / CLI / task-runner shape: byte-identical to what this
      // fix logged before a trigger could be recorded at all.
      await fixLintIssue("orphan-page", "orphan");

      expect(writtenDetail()).toBe("auto-fix: added orphan page to index");
    });

    it("treats a blank handle as absent — no empty parenthetical", async () => {
      // Whitespace is not an actor. Without the trim this would append
      // "(triggered by    )" and make every such line differ from its peers.
      await fixLintIssue("orphan-page", "orphan", undefined, undefined, undefined, "   ");

      expect(writtenDetail()).toBe("auto-fix: added orphan page to index");
    });
  });

  /**
   * EVERY fixable type, not a representative one.
   *
   * The handlers do not share a call shape — `(slug, author, triggeredBy)`,
   * `(slug, target, author, triggeredBy)`, `(message, author, triggeredBy)` —
   * so `FIX_HANDLERS` forwards the two trailing arguments ten separate times,
   * and each is its own chance to swap them. A mutation that rewrote the
   * `unmigrated-page` entry as `fixUnmigratedPage(slug, triggeredBy)` — the
   * owner's handle back in the AUTHOR slot, the exact DW-447 defect — was
   * type-clean and left every other test in this file green.
   *
   * Both halves per row, because the defect is a swap and each half alone is
   * satisfiable: the trigger on the log line AND `"lint-fix"` still in the
   * author slot. The `AUTO_FIXABLE_CHECK_TYPES` assertion underneath is what
   * keeps the table from silently falling behind a newly fixable type.
   */
  describe("every fixable type, one row each", () => {
    /** Seeds the mocks each type's handler needs to reach its write. */
    const SEEDS: Record<AutoFixableCheckType, () => void> = {
      "orphan-page": () => {
        mockedReadWikiPage.mockResolvedValue({
          slug: "orphan",
          title: "Orphan",
          content: "# Orphan\n\nContent.",
          path: "/wiki/orphan.md",
        });
      },
      "stale-index": () => {
        mockedReadWikiPage.mockResolvedValue(null);
        mockedListWikiPages.mockResolvedValue([
          { slug: "stale", title: "Stale", summary: "..." },
        ]);
      },
      "empty-page": () => {},
      "missing-crossref": () => {
        mockedReadWikiPage.mockImplementation(async (slug: string) => ({
          slug,
          title: slug,
          content: `# ${slug}\n\nContent.`,
          path: `/wiki/${slug}.md`,
        }));
      },
      "contradiction": () => {
        mockedHasLLMKey.mockResolvedValue(true);
        mockedCallLLM.mockResolvedValue("# Alpha\n\nResolved claim.");
        mockedReadWikiPage.mockImplementation(async (slug: string) => ({
          slug,
          title: slug,
          content: `# ${slug}\n\nClaim.`,
          path: `/wiki/${slug}.md`,
        }));
      },
      "missing-concept-page": () => {
        mockedReadWikiPage.mockResolvedValue(null);
        mockedHasLLMKey.mockResolvedValue(false);
      },
      "broken-link": () => {
        mockedReadWikiPage.mockResolvedValue({
          slug: "src",
          title: "Src",
          content: "# Src\n\nSee [the target](gone.md).",
          path: "/wiki/src.md",
        });
      },
      "stale-page": () => {
        mockedReadWikiPageWithFrontmatter.mockResolvedValue({
          slug: "stale",
          title: "Stale",
          content: "---\nexpiry: 2020-01-01\n---\n\n# Stale\n\nBody.",
          path: "/wiki/stale.md",
          frontmatter: { expiry: "2020-01-01" },
          body: "# Stale\n\nBody.",
        });
      },
      "unmigrated-page": () => {
        mockedReadWikiPageWithFrontmatter.mockResolvedValue({
          slug: "bare",
          title: "Bare",
          content: "---\ncreated: 2025-01-01\n---\n\n# Bare\n\nBody.",
          path: "/wiki/bare.md",
          frontmatter: { created: "2025-01-01" },
          body: "# Bare\n\nBody.",
        });
      },
      "supersedes-dangling": () => {
        mockedReadWikiPageWithFrontmatter.mockImplementation(async (slug: string) =>
          slug === "some-slug"
            ? ({
                title: "Some",
                body: "# Some\n\nBody.",
                frontmatter: { supersedes: "ghost" },
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
              } as any)
            : null,
        );
      },
    };

    /** `[slug, targetSlug, message]` for each type's dispatcher call. */
    const ARGS: Record<AutoFixableCheckType, [string, string | undefined, string | undefined]> = {
      "orphan-page": ["orphan", undefined, undefined],
      "stale-index": ["stale", undefined, undefined],
      "empty-page": ["empty", undefined, undefined],
      "missing-crossref": ["src", "tgt", undefined],
      "contradiction": ["alpha", "beta", "conflicting claims"],
      "missing-concept-page": [
        "",
        undefined,
        'Concept "Widgets" is mentioned in a, b but has no dedicated page.',
      ],
      "broken-link": ["src", "gone", undefined],
      "stale-page": ["stale", undefined, undefined],
      "unmigrated-page": ["bare", undefined, undefined],
      "supersedes-dangling": ["some-slug", undefined, undefined],
    };

    /** The two types that write no page record their trigger elsewhere. */
    const PAGELESS = new Set<AutoFixableCheckType>(["stale-index", "empty-page"]);

    it("covers every member of AUTO_FIXABLE_CHECK_TYPES", () => {
      // Both maps are `Record<AutoFixableCheckType, …>`, so `tsc` already
      // refuses a missing key. This is the runtime half: it fails loudly if the
      // const grows and someone widens the type instead of adding a row.
      expect(Object.keys(SEEDS).sort()).toEqual([...AUTO_FIXABLE_CHECK_TYPES].sort());
      expect(Object.keys(ARGS).sort()).toEqual([...AUTO_FIXABLE_CHECK_TYPES].sort());
    });

    it.each([...AUTO_FIXABLE_CHECK_TYPES])(
      "%s records the trigger and keeps `lint-fix` as the author",
      async (type) => {
        SEEDS[type]();
        const [slug, targetSlug, message] = ARGS[type];

        await fixLintIssue(type, slug, targetSlug, message, undefined, "alice");

        if (type === "stale-index") {
          // No page, no revision: the trigger lands on this op's own log line.
          expect(mockedAppendToLog.mock.lastCall?.[2]).toMatch(/ \(triggered by alice\)$/);
          return;
        }
        if (type === "empty-page") {
          // Its log line is built inside the lifecycle pipeline, so what this
          // suite can see is the forwarded argument — `author` second, trigger
          // fourth. `stale-index-lifecycle.test.ts` owns the line itself.
          expect(mockedDeleteWikiPage).toHaveBeenCalledWith(
            "empty",
            "lint-fix",
            undefined,
            "alice",
          );
          return;
        }

        expect(PAGELESS.has(type)).toBe(false);
        expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
        const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
        expect(written.author).toBe("lint-fix");
        expect(written.logDetails?.({ updatedSlugs: [] })).toMatch(
          / \(triggered by alice\)$/,
        );
      },
    );

    it.each([...AUTO_FIXABLE_CHECK_TYPES])(
      "%s leaves its line untouched with no trigger",
      async (type) => {
        // The principal-less half of every row above: no parenthetical anywhere.
        SEEDS[type]();
        const [slug, targetSlug, message] = ARGS[type];

        await fixLintIssue(type, slug, targetSlug, message);

        if (type === "stale-index") {
          expect(mockedAppendToLog.mock.lastCall?.[2]).not.toContain("(triggered by");
          return;
        }
        if (type === "empty-page") {
          expect(mockedDeleteWikiPage).toHaveBeenCalledWith(
            "empty",
            "lint-fix",
            undefined,
            undefined,
          );
          return;
        }

        const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
        expect(written.author).toBe("lint-fix");
        expect(written.logDetails?.({ updatedSlugs: [] })).not.toContain("(triggered by");
      },
    );
  });

  describe("on `stale-index`, which writes no page", () => {
    beforeEach(() => {
      mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
      mockedListWikiPages.mockResolvedValue([
        { slug: "ghost", title: "Ghost", summary: "remove" },
      ]);
    });

    it("suffixes its own appendToLog detail with the trigger", async () => {
      await fixLintIssue("stale-index", "ghost", undefined, undefined, undefined, "alice");

      expect(mockedAppendToLog).toHaveBeenCalledWith(
        "edit",
        "ghost",
        "auto-fix: removed stale index entry for ghost (triggered by alice)",
      );
    });

    it("leaves the line untouched for a blank or absent handle", async () => {
      await fixLintIssue("stale-index", "ghost", undefined, undefined, undefined, "   ");

      expect(mockedAppendToLog).toHaveBeenCalledWith(
        "edit",
        "ghost",
        "auto-fix: removed stale index entry for ghost",
      );
    });
  });

  describe("on `empty-page`, which deletes", () => {
    it("hands the trigger to deleteWikiPage without disturbing the author", async () => {
      // `deleteWikiPage` builds its own log-details closure inside the
      // lifecycle pipeline, so the forwarded argument is what this suite can
      // observe; `lifecycle.test.ts` owns the line itself.
      await fixLintIssue("empty-page", "empty", undefined, undefined, undefined, "alice");

      expect(mockedDeleteWikiPage).toHaveBeenCalledWith(
        "empty",
        "lint-fix",
        undefined,
        "alice",
      );
    });
  });
});

// ---------------------------------------------------------------------------
// fixMissingCrossRef
// ---------------------------------------------------------------------------

describe("fixMissingCrossRef", () => {
  it("throws FixValidationError when slug is missing", async () => {
    await expect(fixMissingCrossRef("", "target")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixMissingCrossRef("", "target")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixValidationError when targetSlug is missing", async () => {
    await expect(fixMissingCrossRef("source", "")).rejects.toThrow(
      FixValidationError,
    );
  });

  it("throws FixNotFoundError when source page not found", async () => {
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      "Source page not found: source",
    );
  });

  it("throws FixNotFoundError when target page not found", async () => {
    // Mock returns source page first, then null for target — twice for the
    // two expect() calls that each invoke fixMissingCrossRef.
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null);

    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixMissingCrossRef("source", "target")).rejects.toThrow(
      "Target page not found: target",
    );
  });

  it("returns no-op when link already exists", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nSee [Target](target.md).",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target",
        content: "# Target\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result).toEqual({
      success: true,
      slug: "source",
      message: "Page already links to target.md — no changes needed",
    });

    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("skips an HTML artifact source (never appends markdown to its body)", async () => {
    mockedReadWikiPage.mockResolvedValueOnce({
      slug: "art",
      title: "Art",
      content: "<!doctype html><html><body>x</body></html>",
      path: "/wiki/art.md",
    });
    mockedReadWikiPageWithFrontmatter.mockResolvedValueOnce({
      slug: "art",
      title: "Art",
      frontmatter: { type: "html" },
      body: "<!doctype html><html><body>x</body></html>",
      path: "/wiki/art.md",
    } as unknown as Awaited<ReturnType<typeof readWikiPageWithFrontmatter>>);

    const result = await fixMissingCrossRef("art", "target");

    expect(result.success).toBe(true);
    expect(result.message).toContain("HTML artifacts");
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("inserts link into existing Related section", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content:
          "# Source\n\nSome content.\n\n## Related\n\n- [Other](other.md)\n",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target Page",
        content: "# Target Page\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result.success).toBe(true);
    expect(result.message).toBe(
      "Added cross-reference from source.md to target.md",
    );

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("- [Target Page](target.md)");
    expect(call.content).toContain("- [Other](other.md)");
    expect(call.crossRefSource).toBeNull();
  });

  it("creates new Related section when none exists", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nSome content here.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce({
        slug: "target",
        title: "Target Page",
        content: "# Target Page\n\nTarget content.",
        path: "/wiki/target.md",
      });

    const result = await fixMissingCrossRef("source", "target");

    expect(result.success).toBe(true);

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("## Related\n\n- [Target Page](target.md)");
  });
});

// ---------------------------------------------------------------------------
// fixContradiction
// ---------------------------------------------------------------------------

describe("fixContradiction", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixContradiction("", "target", "msg")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixContradiction("", "target", "msg")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixValidationError when targetSlug is empty", async () => {
    await expect(fixContradiction("source", "", "msg")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixContradiction("source", "", "msg")).rejects.toThrow(
      "Missing required fields: slug and targetSlug",
    );
  });

  it("throws FixNotFoundError when source page does not exist", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage.mockResolvedValue(null);

    await expect(
      fixContradiction("no-such", "other", "msg"),
    ).rejects.toThrow(FixNotFoundError);
    await expect(
      fixContradiction("no-such", "other", "msg"),
    ).rejects.toThrow("Source page not found: no-such");
  });

  it("throws FixNotFoundError when target page does not exist", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "source",
        title: "Source",
        content: "# Source\n\nContent.",
        path: "/wiki/source.md",
      })
      .mockResolvedValueOnce(null);

    await expect(
      fixContradiction("source", "missing-target", "msg"),
    ).rejects.toThrow(FixNotFoundError);
  });

  it("throws FixValidationError when no LLM key is configured", async () => {
    mockedHasLLMKey.mockResolvedValue(false);

    await expect(
      fixContradiction("source", "target", "msg"),
    ).rejects.toThrow(FixValidationError);
    await expect(
      fixContradiction("source", "target", "msg"),
    ).rejects.toThrow(
      "Cannot fix contradictions without an LLM provider configured",
    );
  });

  it("calls LLM with both pages' content and the contradiction description", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "page-a",
        title: "Page A",
        content: "# Page A\n\nClaims X is true.",
        path: "/wiki/page-a.md",
      })
      .mockResolvedValueOnce({
        slug: "page-b",
        title: "Page B",
        content: "# Page B\n\nClaims X is false.",
        path: "/wiki/page-b.md",
      });

    mockedCallLLM.mockResolvedValue("# Page A\n\nRevised: X is false.");

    const msg = "Contradiction between page-a, page-b: X is debated";
    await fixContradiction("page-a", "page-b", msg);

    expect(mockedCallLLM).toHaveBeenCalledOnce();

    const [systemPrompt, userMessage] = mockedCallLLM.mock.calls[0];
    expect(systemPrompt).toContain("resolving contradictions");
    expect(userMessage).toContain("# Page A");
    expect(userMessage).toContain("# Page B");
    expect(userMessage).toContain(msg);
  });

  it("writes the rewritten page via lifecycle pipeline", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "page-a",
        title: "Page A",
        content: "# Page A\n\nClaims X is true.",
        path: "/wiki/page-a.md",
      })
      .mockResolvedValueOnce({
        slug: "page-b",
        title: "Page B",
        content: "# Page B\n\nClaims X is false.",
        path: "/wiki/page-b.md",
      });

    mockedCallLLM.mockResolvedValue("# Page A\n\nRevised: X is false.");

    const result = await fixContradiction(
      "page-a",
      "page-b",
      "Contradiction between page-a, page-b: conflict",
    );

    expect(result).toEqual({
      success: true,
      slug: "page-a",
      message: "Rewrote page-a.md to resolve contradiction with page-b.md",
    });

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("page-a");
    expect(call.content).toBe("# Page A\n\nRevised: X is false.");
    expect(call.logOp).toBe("edit");
  });
});

// ---------------------------------------------------------------------------
// fixMissingConceptPage
// ---------------------------------------------------------------------------

describe("fixMissingConceptPage", () => {
  const validMessage =
    'Concept "Backpropagation" is mentioned in neural-networks, gradient-descent but has no dedicated page. Core concept in deep learning.';

  it("throws FixValidationError when concept cannot be parsed from message", async () => {
    await expect(fixMissingConceptPage("bad message format")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixMissingConceptPage("bad message format")).rejects.toThrow(
      "Could not parse concept name from lint message",
    );
  });

  it("returns no-op when the page already exists", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "backpropagation",
      title: "Backpropagation",
      content: "# Backpropagation\n\nExisting content.",
      path: "/wiki/backpropagation.md",
    });

    const result = await fixMissingConceptPage(validMessage);

    expect(result).toEqual({
      success: true,
      slug: "backpropagation",
      message: "Page backpropagation.md already exists — no changes needed",
    });
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("generates a stub page when no LLM key is available", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockResolvedValue(false);

    const result = await fixMissingConceptPage(validMessage);

    expect(result.success).toBe(true);
    expect(result.slug).toBe("backpropagation");
    expect(result.message).toContain("Created stub page");
    expect(result.message).toContain("Backpropagation");

    expect(mockedCallLLM).not.toHaveBeenCalled();
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("backpropagation");
    expect(call.title).toBe("Backpropagation");
    expect(call.content).toContain("# Backpropagation");
    expect(call.content).toContain("auto-generated by lint");
    expect(call.logOp).toBe("ingest");
    expect(call.crossRefSource).toBe(call.content);
  });

  it("calls callLLM when a key is available", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockResolvedValue(true);
    mockedCallLLM.mockResolvedValue(
      "# Backpropagation\n\nBackpropagation is an algorithm for training neural networks.",
    );

    const result = await fixMissingConceptPage(validMessage);

    expect(result.success).toBe(true);
    expect(result.slug).toBe("backpropagation");

    expect(mockedCallLLM).toHaveBeenCalledOnce();
    expect(mockedCallLLM.mock.calls[0][1]).toContain("Backpropagation");

    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.content).toContain("algorithm for training neural networks");
    expect(call.logOp).toBe("ingest");
  });

  it("returns a proper FixResult shape", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockResolvedValue(false);

    const result = await fixMissingConceptPage(validMessage);

    expect(result).toHaveProperty("success");
    expect(result).toHaveProperty("slug");
    expect(result).toHaveProperty("message");
    expect(typeof result.success).toBe("boolean");
    expect(typeof result.slug).toBe("string");
    expect(typeof result.message).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// fixStalePage
// ---------------------------------------------------------------------------

describe("fixStalePage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixStalePage("")).rejects.toThrow(FixValidationError);
    await expect(fixStalePage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixStalePage("no-such-page")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixStalePage("no-such-page")).rejects.toThrow(
      "Page not found: no-such-page",
    );
  });

  it("bumps expiry to ~90 days from now and writes page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "stale",
      title: "Stale Page",
      content: "---\nexpiry: 2025-01-01\n---\n\n# Stale Page\n\nOld content.",
      path: "/wiki/stale.md",
      frontmatter: { expiry: "2025-01-01" },
      body: "# Stale Page\n\nOld content.",
    });

    const result = await fixStalePage("stale");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("stale");
    expect(result.message).toMatch(/^Expiry extended to \d{4}-\d{2}-\d{2}, verified as of \d{4}-\d{2}-\d{2}$/);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    // Verify the written content includes both new expiry and valid_from
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("stale");
    expect(call.content).toContain("expiry:");
    expect(call.content).toContain("valid_from:");
    expect(call.content).toContain("# Stale Page");
    expect(call.logOp).toBe("edit");
    expect(call.author).toBe("lint-fix");
  });
});

// ---------------------------------------------------------------------------
// fixUnmigratedPage
// ---------------------------------------------------------------------------

describe("fixUnmigratedPage", () => {
  it("throws FixValidationError when slug is empty", async () => {
    await expect(fixUnmigratedPage("")).rejects.toThrow(FixValidationError);
    await expect(fixUnmigratedPage("")).rejects.toThrow(
      "Missing required field: slug",
    );
  });

  it("throws FixNotFoundError when page does not exist", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixUnmigratedPage("no-such")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixUnmigratedPage("no-such")).rejects.toThrow(
      "Page not found: no-such",
    );
  });

  it("adds all missing yopedia defaults to a bare page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "bare-page",
      title: "Bare Page",
      content: "---\ncreated: 2025-01-01\n---\n\n# Bare Page\n\nContent.",
      path: "/wiki/bare-page.md",
      frontmatter: { created: "2025-01-01" },
      body: "# Bare Page\n\nContent.",
    });

    const result = await fixUnmigratedPage("bare-page");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("bare-page");
    expect(result.message).toContain("confidence");
    expect(result.message).toContain("expiry");
    expect(result.message).toContain("authors");
    expect(result.message).toContain("contributors");
    expect(result.message).toContain("disputed");
    expect(result.message).toContain("valid_from");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();

    // Verify the frontmatter passed through the lifecycle pipeline
    const call = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(call.slug).toBe("bare-page");
    expect(call.logOp).toBe("edit");
    expect(call.author).toBe("lint-fix");
    // The serialized output will contain the defaults
    const written = call.content;
    expect(written).toContain("confidence");
    expect(written).toContain("0.5");
    expect(written).toContain("authors");
    expect(written).toContain("system");
    expect(written).toContain("disputed");
    expect(written).toContain("false");
    // valid_from should be derived from the page's created date
    expect(written).toContain("valid_from: 2025-01-01");
  });

  it("does NOT overwrite existing fields", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "partial",
      title: "Partial",
      content: "---\nconfidence: 0.9\nauthors: [yoyo]\n---\n\n# Partial\n\nContent.",
      path: "/wiki/partial.md",
      frontmatter: { confidence: 0.9, authors: ["yoyo"] },
      body: "# Partial\n\nContent.",
    });

    const result = await fixUnmigratedPage("partial");

    expect(result.success).toBe(true);
    // Should only add the missing fields
    expect(result.message).toContain("expiry");
    expect(result.message).toContain("contributors");
    expect(result.message).toContain("disputed");
    expect(result.message).toContain("valid_from");
    // Should NOT mention fields that already existed
    expect(result.message).not.toContain("confidence");
    expect(result.message).not.toContain("authors");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("reports no changes when all fields already present", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "complete",
      title: "Complete",
      content: "---\nconfidence: 0.8\nauthors: [human]\nexpiry: 2026-12-01\ncontributors: []\ndisputed: false\n---\n\n# Complete\n\nContent.",
      path: "/wiki/complete.md",
      frontmatter: {
        confidence: 0.8,
        authors: ["human"],
        expiry: "2026-12-01",
        contributors: [],
        disputed: false,
        valid_from: "2026-06-01",
      },
      body: "# Complete\n\nContent.",
    });

    const result = await fixUnmigratedPage("complete");

    expect(result.success).toBe(true);
    expect(result.message).toContain("no changes needed");
  });
});

// ---------------------------------------------------------------------------
// fixLintIssue — dispatcher
// ---------------------------------------------------------------------------

describe("fixLintIssue", () => {
  it("dispatches orphan-page to fixOrphanPage", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "orphan",
      title: "Orphan",
      content: "# Orphan\n\nContent.",
      path: "/wiki/orphan.md",
    });

    const result = await fixLintIssue("orphan-page", "orphan");
    expect(result.slug).toBe("orphan");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches stale-index to fixStaleIndex", async () => {
    mockedReadWikiPage.mockResolvedValue(null); // page file genuinely missing
    mockedListWikiPages.mockResolvedValue([
      { slug: "stale", title: "Stale", summary: "..." },
    ]);

    const result = await fixLintIssue("stale-index", "stale");
    expect(result.slug).toBe("stale");
    expect(mockedUpdateIndex).toHaveBeenCalledOnce();
  });

  it("dispatches empty-page to fixEmptyPage", async () => {
    const result = await fixLintIssue("empty-page", "empty");
    expect(result.slug).toBe("empty");
    expect(mockedDeleteWikiPage).toHaveBeenCalledOnce();
  });

  it("dispatches missing-crossref to fixMissingCrossRef", async () => {
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "src",
        title: "Src",
        content: "# Src\n\nContent.",
        path: "/wiki/src.md",
      })
      .mockResolvedValueOnce({
        slug: "tgt",
        title: "Tgt",
        content: "# Tgt\n\nContent.",
        path: "/wiki/tgt.md",
      });

    const result = await fixLintIssue("missing-crossref", "src", "tgt");
    expect(result.slug).toBe("src");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches broken-link to fixBrokenLink, REMOVING the dead link", async () => {
    // The one entry with no dispatcher case before this. `fixBrokenLink` and
    // `fixMissingCrossRef` share the `(slug, targetSlug, author)` signature, so
    // wiring `"broken-link"` to the wrong one keeps `tsc` clean while inverting
    // the fix — appending a link where it should strip one. Asserting the
    // written CONTENT is what tells the two apart; a returned `FixResult` does
    // not.
    mockedReadWikiPage.mockResolvedValue({
      slug: "src",
      title: "Src",
      content: "# Src\n\nSee [the target](gone.md) and [a live one](tgt.md).",
      path: "/wiki/src.md",
    });

    const result = await fixLintIssue("broken-link", "src", "gone");

    expect(result.success).toBe(true);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    // The dead link is gone, its text kept…
    expect(written.content).toContain("See the target and");
    expect(written.content).not.toContain("gone.md");
    // …and nothing was appended: a "## Related" section here would mean the
    // cross-ref handler ran instead.
    expect(written.content).not.toContain("## Related");
    expect(written.content).toContain("[a live one](tgt.md)");
    expect(mockedReadWikiPage).toHaveBeenCalledWith("src", { fresh: true, strict: true });
    expect(written.expectedContent).toBe(
      "# Src\n\nSee [the target](gone.md) and [a live one](tgt.md).",
    );
  });

  it("fails closed when fixBrokenLink cannot read fresh source bytes", async () => {
    mockedReadWikiPage.mockRejectedValue(new Error("source read unavailable"));
    await expect(fixBrokenLink("src", "gone")).rejects.toThrow("source read unavailable");
    expect(mockedReadWikiPage).toHaveBeenCalledWith("src", { fresh: true, strict: true });
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("drops a dangling [[slug]] when fixing a broken-link", async () => {
    mockedReadWikiPage.mockResolvedValue({
      slug: "src",
      title: "Src",
      content: "# Src\n\nSee [[gone]] and [a live one](tgt.md).",
      path: "/wiki/src.md",
    });

    const result = await fixLintIssue("broken-link", "src", "gone");
    expect(result.success).toBe(true);
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(written.content).not.toContain("[[gone]]");
    expect(written.content).toContain("[a live one](tgt.md)");
  });

  it("dispatches contradiction to fixContradiction", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce({
        slug: "alpha",
        title: "Alpha",
        content: "# Alpha\n\nClaim A.",
        path: "/wiki/alpha.md",
      })
      .mockResolvedValueOnce({
        slug: "beta",
        title: "Beta",
        content: "# Beta\n\nClaim B.",
        path: "/wiki/beta.md",
      });

    mockedCallLLM.mockResolvedValue("# Alpha\n\nResolved claim.");

    const msg = "Contradiction between alpha, beta: conflicting claims";
    const result = await fixLintIssue("contradiction", "alpha", "beta", msg);
    expect(result.slug).toBe("alpha");
    expect(mockedCallLLM).toHaveBeenCalledOnce();
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("dispatches missing-concept-page to fixMissingConceptPage", async () => {
    mockedReadWikiPage.mockResolvedValue(null);
    mockedHasLLMKey.mockResolvedValue(false);

    const msg =
      'Concept "Attention Mechanism" is mentioned in transformers, bert but has no dedicated page. Important concept.';
    const result = await fixLintIssue(
      "missing-concept-page",
      "transformers",
      undefined,
      msg,
    );
    expect(result.slug).toBe("attention-mechanism");
    expect(result.success).toBe(true);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });

  it("throws FixValidationError for unknown issue type", async () => {
    await expect(fixLintIssue("banana", "slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("banana", "slug")).rejects.toThrow(
      "Auto-fix not supported for this issue type",
    );
  });

  it("dispatches stale-page to fixStalePage and bumps expiry by 90 days", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "old-topic",
      title: "Old Topic",
      content: "---\nexpiry: 2025-01-01\n---\n\n# Old Topic\n\nStale content.",
      path: "/wiki/old-topic.md",
      frontmatter: { expiry: "2025-01-01" },
      body: "# Old Topic\n\nStale content.",
    });

    const result = await fixLintIssue("stale-page", "old-topic");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("old-topic");
    expect(result.message).toMatch(/^Expiry extended to \d{4}-\d{2}-\d{2}, verified as of \d{4}-\d{2}-\d{2}$/);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    const dateMatch = result.message.match(/Expiry extended to (\d{4}-\d{2}-\d{2}), verified as of (\d{4}-\d{2}-\d{2})$/);
    expect(dateMatch).not.toBeNull();
    const newExpiry = new Date(dateMatch![1]);
    const validFrom = new Date(dateMatch![2]);
    const now = new Date();
    const diffDays = (newExpiry.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(diffDays).toBeGreaterThan(88);
    expect(diffDays).toBeLessThan(92);
    // valid_from should be today
    const validDiff = Math.abs(validFrom.getTime() - now.getTime()) / (1000 * 60 * 60 * 24);
    expect(validDiff).toBeLessThan(1);
  });

  it("throws FixNotFoundError for stale-page with missing page", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue(null);

    await expect(fixLintIssue("stale-page", "no-such")).rejects.toThrow(
      FixNotFoundError,
    );
    await expect(fixLintIssue("stale-page", "no-such")).rejects.toThrow(
      "Page not found: no-such",
    );
  });

  it("throws helpful FixValidationError for low-confidence type", async () => {
    await expect(fixLintIssue("low-confidence", "weak-page")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("low-confidence", "weak-page")).rejects.toThrow(
      "Low-confidence pages cannot be auto-fixed",
    );
  });

  it("throws helpful FixValidationError for duplicate-entity type", async () => {
    await expect(fixLintIssue("duplicate-entity", "some-slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("duplicate-entity", "some-slug")).rejects.toThrow(
      "Duplicate entities require human judgment to merge",
    );
  });

  it("dispatches supersedes-dangling to fixSupersededDangling (clears the dead ref)", async () => {
    // Page declares supersedes: "ghost"; "ghost" has no page → dangling.
    mockedReadWikiPageWithFrontmatter.mockImplementation(async (slug: string) =>
      slug === "some-slug"
        ? // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ({ title: "Some", body: "# Some\n\nBody.", frontmatter: { supersedes: "ghost" } } as any)
        : null,
    );

    const result = await fixLintIssue("supersedes-dangling", "some-slug");
    expect(result.success).toBe(true);
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
    // The dangling supersedes was removed from the written frontmatter.
    const written = mockedWriteWikiPageWithSideEffects.mock.calls[0][0];
    expect(written.content).not.toContain("supersedes");
  });

  it("throws helpful FixValidationError for incomplete-coverage type", async () => {
    await expect(fixLintIssue("incomplete-coverage", "some-slug")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("incomplete-coverage", "some-slug")).rejects.toThrow(
      "Incomplete coverage cannot be auto-fixed. Re-ingest the source URL to refresh the page content.",
    );
  });

  it("throws helpful FixValidationError for disputed-page type", async () => {
    // Explicit branch, not the generic default: clearing `disputed` asserts a
    // human reviewed the conflicting claims, so the error has to name that
    // action rather than say "not supported".
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      FixValidationError,
    );
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      "Disputed pages cannot be auto-fixed.",
    );
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      "clear the Disputed toggle in the page editor",
    );
    // The slug is interpolated, not a literal `<slug>` placeholder, so the
    // PATCH the message names can be copy-pasted as-is.
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      "PATCH /api/wiki/contested-page with metadata { disputed: false }",
    );
    // …and names WHO can actually complete it (DW-389). Since DW-121 the realm
    // gate covers metadata writes, so on a public knowledge page that PATCH is
    // admin- or service-only; a refusal that sends a non-admin owner off to run
    // a request the server also refuses has moved the dead end, not removed it.
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      "admin- or service-only",
    );
  });

  it("carries the SAME clause the disputed-page issue suggestion does (DW-389)", async () => {
    // The two sites were hand-copied and drifted apart the moment DW-121 landed
    // — one of them corrected is still half an instruction. Both now render
    // `disputedClearGuidance`, so this asserts the refusal really is built from
    // it rather than restating it a third time; the check side is pinned in
    // `lint-checks.test.ts` against the same helper call.
    await expect(fixLintIssue("disputed-page", "contested-page")).rejects.toThrow(
      disputedClearGuidance("contested-page"),
    );
    // Interpolation is per-call, not a captured constant.
    await expect(fixLintIssue("disputed-page", "other-page")).rejects.toThrow(
      disputedClearGuidance("other-page"),
    );
  });

  /**
   * The slug-less refusal (DW-458).
   *
   * `""` is what the doors pass by contract when no usable slug arrived —
   * `POST /api/lint/fix` falls to `autoFixRefusal(record.type, "")` once the
   * schema rejects `disputed-page`, `mcp-http` passes `slug ?? ""`, and the
   * stdio server's `handleFixLintIssue` passes `args.slug ?? ""` into
   * `fixLintIssue`. So this is what an owner really reads, and it used to be
   * `Reconcile the conflicting claims in ""` over a `PATCH /api/wiki/` whose
   * path segment was empty: a request that 404s the moment it is pasted, which
   * is the opposite of the copy-pasteability the interpolation exists for.
   *
   * DRIVEN THROUGH `autoFixRefusal` RATHER THAN `fixLintIssue`, because that is
   * how the empty slug arrives today. `fixLintIssue` is not immune to `""` in
   * general — `src/cli.ts`'s `--fix` loop hands it `issue.slug` for every issue
   * the scan emitted, and `lint-checks.ts` emits `slug: ""` on its three
   * no-LLM-key rows (`contradiction`, `missing-concept-page` and the
   * non-fixable `incomplete-coverage`) — but NONE of those rows carries type
   * `disputed-page`: that check only emits an issue once it has read a real
   * page, so its slug is always the page's. The empty-slug disputed sentence is
   * therefore a DOOR sentence, and this asserts it where the doors compose it.
   */
  it("names no page and no PATCH path when the slug is empty (DW-458)", () => {
    const refusal = autoFixRefusal("disputed-page", "");

    expect(refusal).toContain("Disputed pages cannot be auto-fixed.");
    // No un-pasteable path, and no empty quoted page name.
    expect(refusal).not.toContain("/api/wiki/");
    expect(refusal).not.toContain('""');

    // What survives is everything the sentence is FOR: the action that clears
    // the flag, where it is performed, and who can actually complete it — the
    // DW-389 qualifier, which is the half that would be worth losing least.
    expect(refusal).toContain("Reconcile the conflicting claims");
    expect(refusal).toContain("clear the Disputed toggle in the page editor");
    expect(refusal).toContain("on a public knowledge page");
    expect(refusal).toContain("admin- or service-only");

    // Still BUILT from the helper rather than restated a third time — the same
    // claim the slugged case above pins, which is what keeps the two variants
    // from drifting when the qualifier is next corrected.
    expect(refusal).toContain(disputedClearGuidance(""));
  });

  it("leaves an unrecognized type alone when the slug is empty too (DW-458)", () => {
    // The branch belongs to the `disputed-page` explanation, not to the lookup
    // in front of it: a type no check emits is still unexplainable, and `""`
    // gives the generic fall-through nothing new to say.
    expect(autoFixRefusal("made-up-type", "")).toBe(
      "Auto-fix not supported for this issue type",
    );
    expect(autoFixRefusal("constructor", "")).toBe(
      "Auto-fix not supported for this issue type",
    );
  });

  it("leaves the slugged sentence byte-identical (DW-458)", () => {
    // The empty-slug branch is a branch, not a rewrite. A real slug renders
    // exactly what it rendered before, dash and braces included.
    expect(autoFixRefusal("disputed-page", "contested-page")).toBe(
      'Disputed pages cannot be auto-fixed. Reconcile the conflicting claims in ' +
        '"contested-page", then clear the Disputed toggle in the page editor ' +
        "(PATCH /api/wiki/contested-page with metadata { disputed: false }) — on " +
        "a public knowledge page that PATCH is admin- or service-only, so an " +
        "owner who is not an admin has to ask one to clear the flag.",
    );
  });

  it("dispatches unmigrated-page to fixUnmigratedPage", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "old-page",
      title: "Old Page",
      content: "---\ncreated: 2025-01-01\n---\n\n# Old Page\n\nLegacy content.",
      path: "/wiki/old-page.md",
      frontmatter: { created: "2025-01-01" },
      body: "# Old Page\n\nLegacy content.",
    });

    const result = await fixLintIssue("unmigrated-page", "old-page");

    expect(result.success).toBe(true);
    expect(result.slug).toBe("old-page");
    expect(result.message).toContain("work-wiki defaults");
    expect(mockedWriteWikiPageWithSideEffects).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// Every read that feeds a write is FRESH + STRICT (DW-379)
// ---------------------------------------------------------------------------

/**
 * `pageCache` is module-global and ref-counted around bulk scans, so a scan can
 * hold a superseded entry open while a fix runs. A cached read there makes the
 * merge base a file that is no longer stored and the write lands it back;
 * `strict` additionally stops a transient provider error from reading back as
 * `null` and being mistaken for "absent" — which, in `fixSupersededDangling`,
 * would authorize a destructive clear.
 *
 * These assertions pin the option literal at each converted call site. They are
 * deliberately per-fix: dropping the literal from ONE site leaves `tsc` clean
 * and every behavioural test above still green.
 */
describe("fresh + strict merge-base reads", () => {
  const FRESH_STRICT = { fresh: true, strict: true };

  function page(slug: string, content: string) {
    return { slug, title: slug, content, path: `/wiki/${slug}.md` };
  }

  it("fixMissingCrossRef reads source, source frontmatter, and target fresh+strict", async () => {
    // Two distinct reads of the same slug, kept as two calls: only the first is
    // the merge base, the second exists solely for the HTML-artifact guard.
    mockedReadWikiPage
      .mockResolvedValueOnce(page("src", "# Src\n\nBody."))
      .mockResolvedValueOnce(page("tgt", "# Tgt\n\nBody."));
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "src",
      title: "Src",
      content: "# Src\n\nBody.",
      path: "/wiki/src.md",
      frontmatter: { type: "note" },
      body: "# Src\n\nBody.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await fixMissingCrossRef("src", "tgt");

    expect(mockedReadWikiPage).toHaveBeenNthCalledWith(1, "src", FRESH_STRICT);
    expect(mockedReadWikiPageWithFrontmatter).toHaveBeenCalledWith("src", FRESH_STRICT);
    expect(mockedReadWikiPage).toHaveBeenNthCalledWith(2, "tgt", FRESH_STRICT);
  });

  it("fixContradiction reads both pages fresh+strict", async () => {
    mockedHasLLMKey.mockResolvedValue(true);
    mockedReadWikiPage
      .mockResolvedValueOnce(page("alpha", "# Alpha\n\nA."))
      .mockResolvedValueOnce(page("beta", "# Beta\n\nB."));

    await fixContradiction("alpha", "beta", "they disagree");

    expect(mockedReadWikiPage).toHaveBeenNthCalledWith(1, "alpha", FRESH_STRICT);
    expect(mockedReadWikiPage).toHaveBeenNthCalledWith(2, "beta", FRESH_STRICT);
  });

  it("fixMissingConceptPage checks existence fresh+strict before creating", async () => {
    mockedReadWikiPage.mockResolvedValue(null);

    await fixMissingConceptPage(
      'Concept "Widgets" is mentioned in a, b but has no dedicated page. Reason.',
    );

    expect(mockedReadWikiPage).toHaveBeenCalledWith("widgets", FRESH_STRICT);
  });

  it("fixStalePage reads its merge base fresh+strict", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "stale",
      title: "Stale",
      content: "# Stale\n\nBody.",
      path: "/wiki/stale.md",
      frontmatter: { expires: "2020-01-01" },
      body: "# Stale\n\nBody.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await fixStalePage("stale");

    expect(mockedReadWikiPageWithFrontmatter).toHaveBeenCalledWith("stale", FRESH_STRICT);
    expect(mockedWriteWikiPageWithSideEffects.mock.calls[0][0].expectedContent).toBe(
      "# Stale\n\nBody.",
    );
  });

  it("fixUnmigratedPage reads its merge base fresh+strict", async () => {
    mockedReadWikiPageWithFrontmatter.mockResolvedValue({
      slug: "bare",
      title: "Bare",
      content: "# Bare\n\nBody.",
      path: "/wiki/bare.md",
      frontmatter: {},
      body: "# Bare\n\nBody.",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);

    await fixUnmigratedPage("bare");

    expect(mockedReadWikiPageWithFrontmatter).toHaveBeenCalledWith("bare", FRESH_STRICT);
    expect(mockedWriteWikiPageWithSideEffects.mock.calls[0][0].expectedContent).toBe(
      "# Bare\n\nBody.",
    );
  });

  it("fixSupersededDangling reads the page AND re-verifies the target fresh+strict", async () => {
    mockedReadWikiPageWithFrontmatter.mockImplementation(async (slug: string) =>
      slug === "some-slug"
        ? ({
            slug,
            title: "Some",
            content: "# Some\n\nBody.",
            path: "/wiki/some-slug.md",
            body: "# Some\n\nBody.",
            frontmatter: { supersedes: "ghost" },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any)
        : null,
    );

    const result = await fixSupersededDangling("some-slug");

    expect(result.success).toBe(true);
    expect(mockedReadWikiPageWithFrontmatter).toHaveBeenCalledWith("some-slug", FRESH_STRICT);
    expect(mockedReadWikiPageWithFrontmatter).toHaveBeenCalledWith("ghost", FRESH_STRICT);
  });

  it("fixSupersededDangling fails closed when the re-verification read blips", async () => {
    // THE ROW THIS FILE EXISTS FOR: without `strict` the rejected read is a
    // swallowed `null`, read as "the target is still gone", and the transient
    // failure authorizes the destructive clear.
    mockedReadWikiPageWithFrontmatter.mockImplementation(async (slug: string) => {
      if (slug === "some-slug") {
        return {
          slug,
          title: "Some",
          content: "# Some\n\nBody.",
          path: "/wiki/some-slug.md",
          body: "# Some\n\nBody.",
          frontmatter: { supersedes: "ghost" },
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any;
      }
      throw new Error("target read unavailable");
    });

    await expect(fixSupersededDangling("some-slug")).rejects.toThrow(
      "target read unavailable",
    );
    // `supersedes` survives: nothing was written at all.
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Human-only check types — every entry `AUTO_FIXABLE_CHECK_TYPES` does NOT name
// must reject with its own explanation, never the generic fall-through.
// ---------------------------------------------------------------------------

/**
 * This describe used to hold a hand-copy of `LintIssueCard`'s `fixableTypes` and
 * `fixLabel` and assert them against each other — a literal compared to itself,
 * which passed no matter how far either drifted from the dispatcher below. It is
 * exactly how `supersedes-dangling` stayed button-less for so long (DW-229).
 *
 * The card's side is now asserted MOUNTED in
 * `src/components/__tests__/lint-check-parity.test.tsx`, against
 * `AUTO_FIXABLE_CHECK_TYPES`. What is left for this file is the other half: that
 * the complement of that const — the types with no auto-fix — each reject for a
 * stated reason. Without this, a check type could be dropped from both the
 * handler table and the message map and land in the `default` arm, which reads
 * "Auto-fix not supported for this issue type" and tells a user nothing about
 * what to do instead. `tsc` closes `NOT_AUTO_FIXABLE`; this pins that the
 * closure is reached at runtime rather than shadowed by the fall-through.
 */
describe("check types with no auto-fix", () => {
  const HUMAN_ONLY_CHECK_TYPES = ALL_CHECK_TYPES.filter(
    (type) => !(AUTO_FIXABLE_CHECK_TYPES as readonly string[]).includes(type),
  );

  async function rejection(type: string): Promise<unknown> {
    return fixLintIssue(type, "contested-page").then(
      () => null,
      (error: unknown) => error,
    );
  }

  it("has some — the complement is not accidentally empty", () => {
    expect(HUMAN_ONLY_CHECK_TYPES.length).toBeGreaterThan(0);
    expect(HUMAN_ONLY_CHECK_TYPES.length).toBe(
      ALL_CHECK_TYPES.length - AUTO_FIXABLE_CHECK_TYPES.length,
    );
  });

  it.each(HUMAN_ONLY_CHECK_TYPES)(
    "rejects with its own explanation, not the generic fall-through: %s",
    async (type) => {
      const error = await rejection(type);

      expect(error).toBeInstanceOf(FixValidationError);
      expect((error as Error).message).not.toContain(
        "Auto-fix not supported for this issue type",
      );
      expect((error as Error).message).toMatch(/cannot be auto-fixed|human judgment/i);
    },
  );

  it("gives each one a distinct message, so none is a copy-paste of another", async () => {
    const messages = await Promise.all(
      HUMAN_ONLY_CHECK_TYPES.map(async (type) =>
        ((await rejection(type)) as Error).message,
      ),
    );

    expect(new Set(messages).size).toBe(HUMAN_ONLY_CHECK_TYPES.length);
  });

  it("still interpolates the slug for disputed-page", async () => {
    const error = await rejection("disputed-page");

    expect((error as Error).message).toContain('"contested-page"');
    expect((error as Error).message).toContain("/api/wiki/contested-page");
  });

  it("does not dispatch a type that merely COERCES to a real one", async () => {
    // `src/app/api/lint/fix/route.ts` destructures `type` off an unvalidated
    // `await req.json()`, and `hasOwnProperty.call` runs its key through
    // `ToPropertyKey` — so `["orphan-page"]` stringifies to `"orphan-page"`.
    // The `switch (type)` this table replaced compared with `===` and rejected
    // it; a bare table lookup would have MUTATED THE PAGE.
    for (const coercible of [
      ["orphan-page"] as unknown as string,
      ["disputed-page"] as unknown as string,
      { toString: () => "orphan-page" } as unknown as string,
    ]) {
      const error = await rejection(coercible);

      expect(error).toBeInstanceOf(FixValidationError);
      expect((error as Error).message).toBe(
        "Auto-fix not supported for this issue type",
      );
    }
    expect(mockedWriteWikiPageWithSideEffects).not.toHaveBeenCalled();
  });

  it("does not answer an inherited Object.prototype key as a fix", async () => {
    // `type` arrives unvalidated from the API route; a bare table index would
    // return `Object.prototype.constructor` here and then call it.
    for (const key of ["constructor", "toString", "hasOwnProperty"]) {
      const error = await rejection(key);
      expect(error).toBeInstanceOf(FixValidationError);
      expect((error as Error).message).toBe(
        "Auto-fix not supported for this issue type",
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The maintenance vocabulary — every `MAINTAIN_FIX_TYPES` member is dispatchable,
// and the compile-time pin that guarantees it is still in the source.
// ---------------------------------------------------------------------------

/**
 * `src/lib/tasks.ts` pins this at compile time: `_MaintainFixTypesAreAutoFixable`,
 * an `Exclude<MaintainFixType, AutoFixableCheckType>` that must be `never`.
 *
 * WHAT THIS DESCRIBE IS ACTUALLY FOR — read it before adding to it, because two
 * of the three tests below are worth less than they look:
 *
 *   - `autoFixRefusal` and `fixLintIssue` resolve through the SAME table,
 *     `FIX_HANDLERS` (`../lint-fix`, declared `Record<AutoFixableCheckType,
 *     FixHandler>` at src/lib/lint-fix.ts:791). So while `tsc` is green the
 *     per-type `toBeNull()` assertions below CANNOT fail: the table is exhaustive
 *     over `AutoFixableCheckType` by construction, and the type pin already says
 *     every `MAINTAIN_FIX_TYPES` member is one. They document the runtime
 *     proposition — a `maintain:fix` task `parseTask` admits cannot die on
 *     arrival with `FixValidationError` at `src/app/api/tasks/run/route.ts:255` —
 *     they do not independently discover it.
 *   - The independent value is in the other two: the source read-back, which
 *     fails if the type alias is deleted (it is referenced by no runtime code, so
 *     deleting it leaves `tsc` perfectly green — the gap it closed would come back
 *     silently), and the complement pin, which fails if a member is dropped from
 *     `MAINTAIN_FIX_TYPES` or an LLM-backed type is added to it.
 *
 * `autoFixRefusal` is the gate the DOORS share — `POST /api/lint/fix` and
 * `src/lib/mcp-http.ts` call it before dispatching; `fixLintIssue` reaches it
 * only on its throw path (src/lib/lint-fix.ts:946). `null` means dispatchable.
 *
 * Types are iterated from `MAINTAIN_FIX_TYPES` itself — a literal restated here
 * would be a second copy of the very list under test.
 */
describe("maintenance fix vocabulary", () => {
  const repoFile = (relative: string) =>
    path.resolve(__dirname, "../../..", relative);

  /**
   * The fixable types the unattended scan deliberately does NOT take. Both call
   * the LLM (`fixContradiction`, `fixMissingConceptPage` reach `hasLLMKey` /
   * `callLLM`), which is the whole reason `MaintainFixType` is a strict subset
   * rather than an alias: the maintenance scan runs with no human and no prompt
   * budget. All three type pins in `tasks.ts` would happily accept
   * `"contradiction"` added to both the union and the tuple — this is the
   * assertion that would not.
   */
  const LLM_BACKED_FIXABLE_TYPES = AUTO_FIXABLE_CHECK_TYPES.filter(
    (type) => !(MAINTAIN_FIX_TYPES as readonly string[]).includes(type),
  );

  it("omits exactly the fixable types that call the LLM", () => {
    expect(LLM_BACKED_FIXABLE_TYPES).toEqual([
      "contradiction",
      "missing-concept-page",
    ]);
    // Mirrors the arity check in "check types with no auto-fix" above: the
    // lengths reconcile only while every maintain type is also a fixable one and
    // neither list repeats itself — so `it.each` below cannot pass vacuously.
    expect(MAINTAIN_FIX_TYPES.length).toBe(
      AUTO_FIXABLE_CHECK_TYPES.length - LLM_BACKED_FIXABLE_TYPES.length,
    );
  });

  it("still declares the compile-time subset pin in src/lib/tasks.ts", async () => {
    // The one assertion here that a green `tsc` does not already imply. Read back
    // from disk, in the manner of `prose-inventory-parity.test.ts`, because the
    // subject is the SOURCE TEXT: nothing imports the alias, so its deletion is
    // invisible to every other check in the repository.
    const source = await readFile(repoFile("src/lib/tasks.ts"), "utf8");

    // Matched against the extracted declaration rather than the whole file, so a
    // failure reads as the one line that is wrong (or the absence sentence)
    // instead of a thousand-line source dump.
    const declaration =
      /type _MaintainFixTypesAreAutoFixable\s*=[^;]*;/.exec(source)?.[0] ??
      "no `_MaintainFixTypesAreAutoFixable` declaration in src/lib/tasks.ts";

    expect(declaration).toMatch(
      /=\s*AssertNever<\s*Exclude<\s*MaintainFixType\s*,\s*AutoFixableCheckType\s*>\s*>\s*;/,
    );
  });

  it.each(MAINTAIN_FIX_TYPES)(
    "is dispatchable at the doors' gate: %s",
    (type) => {
      expect(autoFixRefusal(type, "some-page")).toBeNull();
    },
  );
});
