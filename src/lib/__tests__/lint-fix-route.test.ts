import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

vi.mock("@/lib/auth", () => ({ getPrincipal: vi.fn() }));
vi.mock("@/lib/owner", () => ({ isOwnerHandle: vi.fn() }));

/**
 * `fixLintIssue` is SPIED, not stubbed: the factory spreads `importOriginal`,
 * so every row below still drives the genuine dispatcher (which is the whole
 * premise of this file — see the block comment under it). The spy exists for
 * one claim the response body cannot make on its own: since DW-348 the door
 * refuses a bad `type` ITSELF, and its refusal is word-for-word the sentence
 * the dispatcher would have thrown. Identical bodies, so `toHaveBeenCalled` is
 * the only way to tell "gated at the door" from "gated one layer in".
 */
vi.mock("@/lib/lint-fix", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/lint-fix")>();
  return { ...actual, fixLintIssue: vi.fn(actual.fixLintIssue) };
});

import { getPrincipal } from "@/lib/auth";
import { isOwnerHandle } from "@/lib/owner";
import { fixLintIssue } from "@/lib/lint-fix";

const mockedPrincipal = vi.mocked(getPrincipal);
const mockedIsOwner = vi.mocked(isOwnerHandle);
const spiedFixLintIssue = vi.mocked(fixLintIssue);

/**
 * `POST /api/lint/fix` — the HTTP answer for a non-fixable issue type.
 *
 * `lint-fix.test.ts` pins that `fixLintIssue("disputed-page", …)` throws a
 * `FixValidationError` carrying the owner action. What only this file can
 * observe is that the ROUTE answers 400 with that message on the wire — since
 * DW-348 the door's own `type` gate produces it (`autoFixRefusal`, the same
 * owner of the sentence the dispatcher throws), and the `FixValidationError`
 * catch below it still translates a handler's own rejection. Either way a
 * regression turns the 400 into a 500 with `getErrorMessage(error)`: the
 * button-less UI would keep working, and the one surface that tells an owner
 * how to clear the flag would be gone from the wire.
 *
 * `fixLintIssue` is deliberately NOT STUBBED — the mock factory above wraps the
 * real implementation. A stub would leave the real dispatcher's branches
 * untested from here, and the pairing of a specific error CLASS with a specific
 * status is exactly what would break.
 */
async function postFix(body: unknown) {
  return postRawFix(JSON.stringify(body));
}

/** The same door, driven with a body that is not necessarily a JSON object. */
async function postRawFix(body: string) {
  const { POST } = await import("@/app/api/lint/fix/route");
  return POST(
    new Request("http://localhost/api/lint/fix", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
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
 * The body gate (DW-348).
 *
 * `type` used to be destructured off an unvalidated `await req.json()` and
 * handed to `fixLintIssue`, so the door's declared contract and what it would
 * actually forward were two different things: `ownEntry`'s own-property lookup
 * inside `lint-fix.ts` was the last line of defense, in a module this route
 * does not own. The rows below pin the door's own refusal — the response AND
 * that the dispatcher was never reached, which the bodies alone cannot
 * distinguish because both layers answer with the same sentence.
 */
describe("POST /api/lint/fix — body validation", () => {
  beforeEach(() => {
    spiedFixLintIssue.mockClear();
  });

  it.each([
    ["an unrecognized type", { type: "made-up-type", slug: "p" }],
    // Not a string at all. `hasOwnProperty.call` runs its key through
    // `ToPropertyKey`, so `["orphan-page"]` stringifies to a REAL handler key —
    // the coercion `ownEntry`'s `typeof` guard exists to stop, now stopped a
    // layer earlier and without a lookup.
    ["a non-string type", { type: ["orphan-page"], slug: "p" }],
    // Inherited `Object.prototype` members, the other half of that guard.
    ["a prototype-chain type", { type: "constructor", slug: "p" }],
    ["a missing type", { slug: "p" }],
  ] as const)("answers 400 for %s, without dispatching", async (_label, body) => {
    const res = await postFix(body);

    expect(res.status).toBe(400);
    expect(spiedFixLintIssue).not.toHaveBeenCalled();
  });

  it("still says the type is not auto-fixable, in those words", async () => {
    // The sentence, not just the status: an agent reading this answer has to be
    // able to tell a rejected TYPE from a rejected slug.
    const res = await postFix({ type: "made-up-type", slug: "p" });

    expect(((await res.json()) as { error?: string }).error).toBe(
      "Auto-fix not supported for this issue type",
    );
  });

  it("keeps the recognized-but-not-fixable explanation at the door", async () => {
    // `disputed-page` is refused by the SCHEMA now — it is not in
    // `AUTO_FIXABLE_CHECK_TYPES` — so the clear path has to survive that move.
    // A generic schema message here would silently delete the one surface that
    // tells an owner how to clear the flag.
    const res = await postFix({ type: "disputed-page", slug: "contested-page" });

    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain(
      "PATCH /api/wiki/contested-page with metadata { disputed: false }",
    );
    expect(spiedFixLintIssue).not.toHaveBeenCalled();
  });

  it.each([
    ["null", "null"],
    ["a bare string", '"hi"'],
    ["an array", '["orphan-page"]'],
    ["a number", "7"],
    // Not JSON at all: `req.json()` throws, which used to reach the generic
    // catch and answer 500.
    ["unparseable text", "{not json"],
  ] as const)("answers 400, not 500, for a body that is %s", async (_label, raw) => {
    const res = await postRawFix(raw);

    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "Invalid request body",
    );
    expect(spiedFixLintIssue).not.toHaveBeenCalled();
  });

  it("names the offending field when the TYPE is fine and something else is not", async () => {
    // The schema message earns its place exactly here: `orphan-page` is
    // fixable, so "not auto-fixable" would be a lie, and `slug: 7` is what the
    // caller has to fix.
    const res = await postFix({ type: "orphan-page", slug: 7 });

    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "slug",
    );
    // Without the gate this reached `fixOrphanPage(7)` and came back a 404
    // about a page named "7".
    expect(spiedFixLintIssue).not.toHaveBeenCalled();
  });

  it("accepts a slug-less body for the type that reads `message` alone", async () => {
    // `slug` is optional in the schema for exactly one reason, stated in its
    // comment: `missing-concept-page` reads `message` and nothing else (the
    // route docstring's own bullet says so). A required `slug` would 400 the
    // only type whose fix does not take one.
    //
    // The message is deliberately UNPARSEABLE, so `fixMissingConceptPage`
    // refuses at its own regex before it can create a stub page — this suite
    // has no temp `DATA_DIR`, and the claim under test is that the request
    // REACHED the dispatcher, which the spy establishes on its own.
    const res = await postFix({
      type: "missing-concept-page",
      message: "no concept sentence here",
    });

    expect(spiedFixLintIssue).toHaveBeenCalledWith(
      "missing-concept-page",
      "",
      undefined,
      "no concept sentence here",
    );
    expect(res.status).toBe(400);
    expect(String(((await res.json()) as { error?: string }).error)).toContain(
      "Could not parse concept name",
    );
  });

  it("lets a slug-requiring type answer for its own missing slug", async () => {
    // The other half of that trade. An optional `slug` means an `orphan-page`
    // with none reaches the handler as `""` (the `slug ?? ""` conversion), and
    // the handler's "Missing required field: slug" is a far more useful 400
    // than a schema's "expected string, received undefined" — it names the
    // field AND the fact that this type needs it.
    const res = await postFix({ type: "orphan-page" });

    expect(spiedFixLintIssue).toHaveBeenCalledWith(
      "orphan-page",
      "",
      undefined,
      undefined,
    );
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe(
      "Missing required field: slug",
    );
  });

  it("passes a well-formed request straight through", async () => {
    // The control: the gate refuses what it should and nothing else. The page
    // does not exist in this suite's (absent) storage, so the dispatcher's own
    // 404 is the proof it ran.
    const res = await postFix({ type: "orphan-page", slug: "some-page" });

    expect(spiedFixLintIssue).toHaveBeenCalledWith(
      "orphan-page",
      "some-page",
      undefined,
      undefined,
    );
    expect(res.status).toBe(404);
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
    // `disputed-page` is the branch the file already pins: the 400 that names
    // the human action, which proves the read-only gate did not swallow the
    // request when the flag is unset.
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
