import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);

/**
 * `POST /api/lint/fix` — the HTTP answer for a non-fixable issue type.
 *
 * `lint-fix.test.ts` pins that `fixLintIssue("disputed-page", …)` throws a
 * `FixValidationError` carrying the owner action. What only this file can
 * observe is that the route TRANSLATES that throw into a 400 whose body still
 * carries the message: the route catches `FixValidationError` before its
 * generic handler, and a reordered or removed catch would turn the same throw
 * into a 500 with `getErrorMessage(error)` — the button-less UI would keep
 * working, and the one surface that tells an owner how to clear the flag would
 * be gone from the wire.
 *
 * `fixLintIssue` is deliberately NOT mocked. Mocking it would leave the real
 * dispatcher's `disputed-page` branch untested from here, and the pairing of a
 * specific error CLASS with a specific status is exactly what would break.
 */
async function postFix(body: Record<string, unknown>) {
  const { POST } = await import("@/app/api/lint/fix/route");
  return POST(
    new Request("http://localhost/api/lint/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }) as unknown as Parameters<typeof POST>[0],
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockedPrincipal.mockResolvedValue({ id: "user_1", handle: "LuckierTrout" });
  mockedIsOwner.mockReturnValue(true);
});

describe("POST /api/lint/fix — disputed-page", () => {
  it("answers 400 with the owner clear path", async () => {
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("cannot be auto-fixed");
    expect(body.error).toContain(
      "PATCH /api/wiki/contested-page with metadata { disputed: false }",
    );
  });

  it("does not fall through to the generic unsupported-type message", async () => {
    // The `disputed-page` branch is explicit precisely so the response names
    // the human action. Falling through to `default:` would also produce a 400,
    // so the status alone cannot tell the two apart.
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });
    const body = (await res.json()) as { error?: string };

    expect(body.error).not.toContain("Auto-fix not supported for this issue type");
  });

  it("still gates on ownership before reaching the dispatcher", async () => {
    mockedIsOwner.mockReturnValue(false);

    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(403);
  });
});

/**
 * A read-only deployment refuses a lint fix (DW-187).
 *
 * This door keeps a route-level gate for the rule's SECOND half only:
 * `fixContradiction` and `fixMissingConceptPage` each run a `callLLM` rewrite
 * before touching the page, so a kernel-only refusal would pay for a model call
 * whose output is thrown away — and an LLM failure would answer 500 in place of
 * the refusal.
 *
 * `fixLintIssue` stays unmocked here, as it is above: what is being pinned is
 * that the route never reaches the real dispatcher at all, which a mock would
 * make unfalsifiable.
 */
describe("POST /api/lint/fix — read-only deployment", () => {
  let originalReadOnly: string | undefined;

  beforeEach(() => {
    originalReadOnly = process.env.YOPEDIA_READONLY;
    delete process.env.YOPEDIA_READONLY;
  });

  afterEach(() => {
    if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = originalReadOnly;
  });

  it("answers 403 before the fix dispatcher runs", async () => {
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({ type: "orphan-page", slug: "some-page" });

    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "read-only",
    );
  });

  it("refuses an LLM-backed fix with the SAME answer, not a model failure", async () => {
    // The door's whole reason for keeping a route gate. Un-gated, this case
    // reaches `callLLM` with no key configured and answers 400/500 about the
    // model — a refusal the owner would read as a broken integration.
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({
      type: "contradiction",
      slug: "page-a",
      targetSlug: "page-b",
      message: "they disagree",
    });

    expect(res.status).toBe(403);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "read-only",
    );
  });

  it("still answers 403-Forbidden to a non-owner, before the read-only gate", async () => {
    // Ordering: the owner gate stays first, so a signed-out caller is not told
    // about the deployment's write posture.
    mockedIsOwner.mockReturnValue(false);
    process.env.YOPEDIA_READONLY = "1";

    const res = await postFix({ type: "orphan-page", slug: "some-page" });

    expect(res.status).toBe(403);
    expect(((await res.json()) as { error?: string }).error).toBe("Forbidden");
  });

  it("reaches the dispatcher as before with the flag unset — the control case", async () => {
    // `disputed-page` is the branch the file already pins: a real dispatcher
    // answer, which proves the new gate did not swallow the request.
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain(
      "cannot be auto-fixed",
    );
  });
});

/**
 * The fix path against REAL storage (DW-379) — the two claims that only a real
 * cache and a real filesystem can establish.
 *
 * FIRST, THE MERGE BASE. Every read in `lint-fix.ts` feeds the write that
 * follows it, so all thirteen are `{ fresh: true }`. The unit rows for that
 * live in `lint-fix.test.ts`, but that file `vi.mock`s `../wiki` wholesale — so
 * what they can pin is that the CALL SITE passed the option, not that a real
 * `pageCache` entry cannot become a merge base. This file mocks neither the
 * wiki nor `fixLintIssue`, so the row below runs a genuine `beginPageCache`,
 * lets the file move underneath it, and drives the fix through the HTTP door.
 *
 * SECOND, THE REFUSAL. A fresh read REFUSES a non-ENOENT storage failure
 * (DW-378/DW-380) instead of answering `null`. Un-classified that refusal falls
 * past `FixValidationError`/`FixNotFoundError` into the generic handler and
 * answers 500. This door answers what the wiki doors already answer for the
 * same condition: 503 with the one sentence, imported rather than re-worded.
 *
 * These rows need a temp `DATA_DIR` of their own — the rest of the file drives
 * branches that never reach storage, so it has no directory setup and a write
 * here would land in the repo.
 */
describe("POST /api/lint/fix — real storage: stale cache and unreadable page", () => {
  let tmpDir: string;
  const savedEnv: Record<string, string | undefined> = {};

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "lint-fix-route-test-"));
    for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) savedEnv[k] = process.env[k];
    process.env.DATA_DIR = tmpDir;
    process.env.WIKI_DIR = path.join(tmpDir, "wiki");
    process.env.RAW_DIR = path.join(tmpDir, "raw");
    const { _resetStorage } = await import("@/lib/storage");
    _resetStorage();
    const { ensureDirectories } = await import("@/lib/wiki");
    await ensureDirectories();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const k of ["DATA_DIR", "WIKI_DIR", "RAW_DIR"]) {
      if (savedEnv[k] === undefined) delete process.env[k];
      else process.env[k] = savedEnv[k];
    }
    const { _resetStorage } = await import("@/lib/storage");
    _resetStorage();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  /** Write a flat page directly — no index entry, which is what makes it an orphan. */
  async function seedPage(slug: string, content: string) {
    const { writeWikiPage } = await import("@/lib/wiki");
    await writeWikiPage(slug, content);
  }

  /**
   * Fail the storage reads of THIS page with a NON-ENOENT error, on the silo
   * path and the flat path alike, so the fix meets the same refusal whichever
   * one it would have taken. The paths are computed through the same helpers
   * the code under test uses rather than matched by suffix, so a pass
   * establishes WHICH read failed. Everything else still reads for real.
   */
  async function failReadsOfPage(slug: string) {
    const { getStorage } = await import("@/lib/storage");
    const { tenantForOwner, tenantWikiRelPath, wikiRelPath } = await import(
      "@/lib/wiki"
    );
    // No owner parameter: a lint fix is dispatched by slug alone, and the pages
    // this suite drives are ownerless, so the silo path is the default tenant's.
    const targets = new Set([
      wikiRelPath(`${slug}.md`),
      tenantWikiRelPath(tenantForOwner(undefined), `${slug}.md`),
    ]);
    const storage = getStorage();
    const real = storage.readFile.bind(storage);
    vi.spyOn(storage, "readFile").mockImplementation(async (p: string) => {
      if (targets.has(p)) {
        const err = new Error(`EIO: i/o error, read '${p}'`) as NodeJS.ErrnoException;
        err.code = "EIO";
        throw err;
      }
      return real(p);
    });
  }

  it("fixes the STORED bytes while a real stale page cache is open", async () => {
    // `fixOrphanPage` writes back the bytes it read, verbatim, to create the
    // index entry. `pageCache` is module-global and ref-counted around bulk
    // scans — and an auto-fix is triggered BY a scan, so `lint.ts`'s own
    // `withPageCache` is exactly the cache that can be holding a superseded
    // entry when the fix runs. Written from that entry, the "repair" reverts
    // the page to a version that is no longer stored.
    const { beginPageCache, readWikiPage } = await import("@/lib/wiki");
    await seedPage("orphan-stale-real", "# Orphan\n\nCached body.\n");

    const cleanup = beginPageCache();
    try {
      // A concurrent scan populates the cache…
      const cached = (await readWikiPage("orphan-stale-real"))!;
      expect(cached.content).toContain("Cached body.");

      // …and the file moves underneath it. Written DIRECTLY, past
      // `writeWikiPage` — which invalidates — because a STALE entry is exactly
      // what this row is about.
      await fs.writeFile(cached.path, "# Orphan\n\nStored body, LATER.\n", "utf-8");
      // The cache is genuinely stale: a cached read still serves the old bytes.
      expect((await readWikiPage("orphan-stale-real"))!.content).toContain(
        "Cached body.",
      );

      const res = await postFix({ type: "orphan-page", slug: "orphan-stale-real" });
      expect(res.status).toBe(200);

      // The fix wrote back what was STORED. Without the fresh read at
      // `lint-fix.ts:76` the cached copy is written over the later file and the
      // intervening save is gone — an index repair that silently undoes an edit.
      const after = (await readWikiPage("orphan-stale-real", { fresh: true }))!;
      expect(after.content).toContain("Stored body, LATER.");
      expect(after.content).not.toContain("Cached body.");
    } finally {
      cleanup();
    }
  });

  it("answers 503 with the one sentence, and writes nothing", async () => {
    const { PAGE_UNREADABLE_COPY, PAGE_UNREADABLE_STATUS } = await import(
      "@/lib/page-read-failure"
    );
    const { readWikiPageWithFrontmatter, readLog } = await import("@/lib/wiki");
    await seedPage("unreadable-fix-page", "# Unreadable\n\nStored body.\n");
    const before = (await readWikiPageWithFrontmatter("unreadable-fix-page", {
      fresh: true,
    }))!.content;
    const logBefore = (await readLog()) ?? "";

    await failReadsOfPage("unreadable-fix-page");
    const res = await postFix({ type: "orphan-page", slug: "unreadable-fix-page" });

    expect(res.status).toBe(PAGE_UNREADABLE_STATUS);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: PAGE_UNREADABLE_COPY });

    // "So nothing was changed" is a claim, and this is where it is checked: the
    // refusal happened at the read, before `fixOrphanPage` reached its writer,
    // so the file is byte-for-byte what it was and no activity line was
    // appended. The other two doors assert the same pair.
    vi.restoreAllMocks();
    expect(
      (await readWikiPageWithFrontmatter("unreadable-fix-page", { fresh: true }))!
        .content,
    ).toBe(before);
    expect((await readLog()) ?? "").toBe(logBefore);
  });

  it("still answers 404 for a page that genuinely is not there", async () => {
    // The other half of the pair: ENOENT is untouched by `fresh`, so an absent
    // page is still `FixNotFoundError` and still a 404.
    const res = await postFix({ type: "orphan-page", slug: "genuinely-absent-page" });

    expect(res.status).toBe(404);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "Page not found: genuinely-absent-page",
    );
  });
});
