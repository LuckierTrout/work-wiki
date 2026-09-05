import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * Alias forwarding on the EDIT and RAW surfaces (DW-84).
 *
 * `aliasRedirectForMissing` was wired into the page view only, so a merged-away
 * slug's `/u/<handle>/<slug>` bookmark forwarded to the survivor while the very
 * same slug's `/edit` and `/raw/` bookmarks hard-missed. Both routes now share
 * the gate through `aliasTargetForMissing`, and each rebuilds its OWN URL shape
 * — an editor forwarded to the read view would be a cross-surface redirect, not
 * a fix.
 *
 * Modeled on `owner-page-route.test.ts`: same `next/navigation` + `@/lib/auth`
 * mocks, same tmpdir seeding, `resetAliasIndex()` per test. The assertions are
 * on the route functions themselves, because the string builders (`editPath`,
 * `rawPath`) are already pinned in `links.test.ts` — what is unpinned is
 * whether the routes CALL them on a miss.
 */

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "owner", handle: "owner" })),
  getServicePrincipal: vi.fn(() => null),
}));

// Next's real navigation helpers throw framework signals; surface them as plain
// errors carrying the target so the assertions read the URL directly.
vi.mock("next/navigation", () => ({
  permanentRedirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
  notFound: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

import {
  ensureDirectories,
  saveRawSource,
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
} from "../wiki";
import { resetAliasIndex } from "../alias-index";
import type { Frontmatter } from "../frontmatter";
import { getPrincipal } from "@/lib/auth";
import { notFound, permanentRedirect } from "next/navigation";
import EditWikiPage from "@/app/u/[handle]/[slug]/edit/page";
import RawSourcePage from "@/app/u/[handle]/raw/[slug]/page";
import { GET as rawApiGet } from "@/app/api/raw/[slug]/route";
import {
  DELETE as wikiApiDelete,
  PATCH as wikiApiPatch,
  PUT as wikiApiPut,
} from "@/app/api/wiki/[slug]/route";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "edit-raw-alias-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // The alias index is a module singleton; drop it so each test's miss-path
  // forwarding resolves against THIS test's pages only.
  resetAliasIndex();
  vi.clearAllMocks();
  await ensureDirectories();
});

afterEach(async () => {
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  await fs.rm(tmpDir, { recursive: true, force: true });
});

async function seedPage(slug: string, fm: Frontmatter = {}) {
  const today = new Date().toISOString().slice(0, 10);
  const defaults: Frontmatter = {
    created: today,
    confidence: 0.5,
    authors: ["original-author"],
    owner: "owner",
    visibility: "public",
    contributors: [],
    expiry: "2099-01-01",
    sources: [],
    ...fm,
  };
  await writeWikiPageWithSideEffects({
    slug,
    title: slug,
    content: serializeFrontmatter(defaults, `# ${slug}\n\nBody.`),
    summary: "A test page",
    logOp: "ingest",
    crossRefSource: null,
  });
}

/**
 * Run a route and hand back whatever it threw (or null).
 *
 * The edit route's miss path RETURNS JSX, and the node project has no JSX
 * runtime — so "took the miss branch" surfaces as a thrown error that is not
 * one of the framework signals. Catching lets the mock assertions below say
 * which signal was (and wasn't) raised, rather than leaning on the render's
 * incidental failure.
 */
async function thrownBy(run: () => Promise<unknown>): Promise<Error | null> {
  try {
    await run();
    return null;
  } catch (err) {
    return err as Error;
  }
}

describe("/u/<handle>/<slug>/edit alias forwarding for missing slugs", () => {
  it("308s a merged-away slug's edit bookmark to the survivor's EDIT url", async () => {
    await seedPage("survivor", { owner: "alice", aliases: ["old-slug"] });
    await expect(
      EditWikiPage({
        params: Promise.resolve({ handle: "old", slug: "old-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/alice/survivor/edit");
    // Never the read view: an editor sent to `/u/alice/survivor` has silently
    // lost the surface they asked for.
    expect(vi.mocked(permanentRedirect)).toHaveBeenCalledWith(
      "/u/alice/survivor/edit",
    );
  });

  it("forwards the owner to their private survivor's editor, never an anonymous viewer", async () => {
    await seedPage("secret-survivor", {
      owner: "owner",
      visibility: "private",
      aliases: ["gone-slug"],
    });
    await expect(
      EditWikiPage({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/owner/secret-survivor/edit");

    vi.mocked(permanentRedirect).mockClear();
    vi.mocked(getPrincipal).mockResolvedValueOnce(null);
    const err = await thrownBy(() =>
      EditWikiPage({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    );
    // Forwarding an anonymous viewer would make the editor an existence
    // oracle for a private page.
    expect(err?.message ?? "").not.toMatch(/^REDIRECT:/);
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });

  it("keeps the unchanged 'nothing to edit' miss for a slug with no alias", async () => {
    await seedPage("unrelated", { owner: "alice" });
    const err = await thrownBy(() =>
      EditWikiPage({
        params: Promise.resolve({ handle: "yopedia", slug: "ghost" }),
      }),
    );
    expect(err?.message ?? "").not.toMatch(/^REDIRECT:/);
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
    // DW-85's 200→404 change is scoped to the PAGE route. The editor's copy is
    // surface-specific ("nothing to edit"), so this branch must keep rendering
    // it rather than adopting `notFound()`.
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it("does not forward an existing-but-unreadable slug to its own edit url", async () => {
    // The alias index maps every live slug to itself; without the
    // `canonical !== slug` guard this would 308 forever.
    await seedPage("locked", { owner: "alice", visibility: "private" });
    const err = await thrownBy(() =>
      EditWikiPage({
        params: Promise.resolve({ handle: "yopedia", slug: "locked" }),
      }),
    );
    expect(err?.message ?? "").not.toMatch(/^REDIRECT:/);
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });
});

describe("/u/<handle>/raw/<slug> alias forwarding for missing slugs", () => {
  it("308s a merged-away slug's raw bookmark to the survivor's RAW url", async () => {
    await seedPage("survivor", { owner: "alice", aliases: ["old-slug"] });
    await expect(
      RawSourcePage({
        params: Promise.resolve({ handle: "old", slug: "old-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/alice/raw/survivor");
    // Exactly ONE hop. Forwarding after the handle-canonicalization 308 would
    // first bounce this non-default handle through `/u/yopedia/raw/old-slug`
    // (a missing slug resolves `pageTenant` to DEFAULT_TENANT), a URL that
    // also misses.
    expect(vi.mocked(permanentRedirect)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(permanentRedirect)).toHaveBeenCalledWith(
      "/u/alice/raw/survivor",
    );
  });

  it("forwards the owner to their private survivor's raw view, never an anonymous viewer", async () => {
    await seedPage("secret-survivor", {
      owner: "owner",
      visibility: "private",
      aliases: ["gone-slug"],
    });
    await expect(
      RawSourcePage({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/owner/raw/secret-survivor");

    vi.mocked(permanentRedirect).mockClear();
    vi.mocked(getPrincipal).mockResolvedValueOnce(null);
    const err = await thrownBy(() =>
      RawSourcePage({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    );
    expect(err?.message ?? "").not.toMatch(/^REDIRECT:/);
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });

  it("keeps the pre-existing 404 miss for a slug with no alias", async () => {
    await seedPage("unrelated", { owner: "alice" });
    // Under the default handle the route falls straight through to its own
    // miss: no page, no sources, no raw blob → `notFound()`, exactly as before
    // forwarding was added.
    await expect(
      RawSourcePage({
        params: Promise.resolve({ handle: "yopedia", slug: "ghost" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });

  it("serves an orphaned raw archive at the aliased slug instead of forwarding past it", async () => {
    // `mergePages` hard-deletes the absorbed page, but `deleteWikiPage`
    // deliberately leaves its `raw/` blob alone ("the raw layer is immutable").
    // So after a merge the absorbed slug has NO page and an alias to the
    // survivor — yet its archive, which this route served before the merge, is
    // still on disk. Forwarding on `!ownerPage` alone would hide it behind a
    // 308 forever, which is the one thing the raw surface exists to prevent.
    await seedPage("survivor", { owner: "alice", aliases: ["old-slug"] });
    await saveRawSource("old-slug", "# Archived\n\nThe original capture.");

    const err = await thrownBy(() =>
      RawSourcePage({
        params: Promise.resolve({ handle: "yopedia", slug: "old-slug" }),
      }),
    );
    expect(err?.message ?? "").not.toMatch(/^REDIRECT:/);
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
    expect(vi.mocked(notFound)).not.toHaveBeenCalled();
  });

  it("does not forward an existing-but-unreadable slug (it 404s at the read gate)", async () => {
    await seedPage("locked", { owner: "alice", visibility: "private" });
    vi.mocked(getPrincipal).mockResolvedValueOnce(null);
    await expect(
      RawSourcePage({
        params: Promise.resolve({ handle: "yopedia", slug: "locked" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });
});

/**
 * DW-233 — the MACHINE doors' half of the same parity claim.
 *
 * The page components above 308 a merged-away slug to the survivor's
 * equivalent URL. `GET /api/raw/<slug>` and the write verbs on
 * `/api/wiki/<slug>` used to hard-404 it, so an MCP client holding an old
 * bookmark had nowhere to go. Per the recorded 2026-08-28 decision they keep
 * the 404 STATUS — an API caller is not a browser — and name the survivor in
 * the body instead, projected from the very same `aliasTargetForMissing` gate
 * through `canonicalSlugHintForMissing`.
 *
 * These cases live BESIDE the UI ones deliberately: the parity claim is only
 * real if both halves are asserted against the same seeded alias, in the same
 * harness. A separate file could drift into seeding a different survivor and
 * still pass.
 */
describe("machine doors name the survivor on a miss (DW-233)", () => {
  let originalAdmin: string | undefined;
  let originalOwnerHandle: string | undefined;
  let originalReadOnly: string | undefined;

  beforeEach(() => {
    // The ACL-cloak cases below need the test principal to be an ORDINARY user:
    // either of these exported in a developer's shell would make `owner` an
    // admin, turn the cloak into a readable page, and hide the very assertion
    // the case exists for — on that machine only. The read-only flag would
    // turn every write door's 404 into a 403 the same way.
    originalAdmin = process.env.ADMIN_HANDLES;
    originalOwnerHandle = process.env.NEXT_PUBLIC_OWNER_HANDLE;
    originalReadOnly = process.env.YOPEDIA_READONLY;
    delete process.env.ADMIN_HANDLES;
    delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    delete process.env.YOPEDIA_READONLY;
  });

  afterEach(() => {
    if (originalAdmin === undefined) delete process.env.ADMIN_HANDLES;
    else process.env.ADMIN_HANDLES = originalAdmin;
    if (originalOwnerHandle === undefined)
      delete process.env.NEXT_PUBLIC_OWNER_HANDLE;
    else process.env.NEXT_PUBLIC_OWNER_HANDLE = originalOwnerHandle;
    if (originalReadOnly === undefined) delete process.env.YOPEDIA_READONLY;
    else process.env.YOPEDIA_READONLY = originalReadOnly;
  });

  const params = (slug: string) => ({ params: Promise.resolve({ slug }) });

  const rawGet = (slug: string) =>
    rawApiGet(new Request(`http://localhost/api/raw/${slug}`), params(slug));

  const wikiDelete = (slug: string) =>
    wikiApiDelete(
      new Request(`http://localhost/api/wiki/${slug}`, { method: "DELETE" }),
      params(slug),
    );

  const wikiPut = (slug: string) =>
    wikiApiPut(
      new Request(`http://localhost/api/wiki/${slug}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: "# Replacement\n\nBody." }),
      }),
      params(slug),
    );

  const wikiPatch = (slug: string) =>
    wikiApiPatch(
      new Request(`http://localhost/api/wiki/${slug}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ metadata: { tags: ["x"] } }),
      }),
      params(slug),
    );

  const body = async (response: Response) =>
    (await response.json()) as { error: string; canonicalSlug?: string };

  describe("GET /api/raw/<slug>", () => {
    it("names the survivor on a merged-away slug, still as a 404", async () => {
      // The raw blob is deliberately NOT seeded at `old-slug`: with no page and
      // no archive there, `canReadSlug` passes (a missing page lets the
      // caller's own not-found speak) and `readRawSource` throws — so this
      // lands in the CATCH, which is the exit a merged-away slug really takes
      // and the one that needed `slug` hoisted to answer at all.
      await seedPage("survivor", { owner: "alice", aliases: ["old-slug"] });

      const response = await rawGet("old-slug");

      expect(response.status).toBe(404);
      expect(await body(response)).toMatchObject({ canonicalSlug: "survivor" });
      // The status is NOT a redirect: the decision was to keep the 404 and add
      // a field, never to 308 a machine caller.
      expect(response.status).not.toBe(308);
    });

    it("carries no hint for a slug nothing aliases", async () => {
      await seedPage("unrelated", { owner: "alice" });

      const response = await rawGet("ghost");

      expect(response.status).toBe(404);
      expect(await body(response)).not.toHaveProperty("canonicalSlug");
    });

    it("carries no hint for an anonymous caller whose survivor is private", async () => {
      // The gate is principal-aware, so the field can never become a
      // private-page existence oracle: the owner is told, a stranger is not.
      await seedPage("secret-survivor", {
        owner: "owner",
        visibility: "private",
        aliases: ["gone-slug"],
      });

      const owned = await body(await rawGet("gone-slug"));
      expect(owned).toMatchObject({ canonicalSlug: "secret-survivor" });

      vi.mocked(getPrincipal).mockResolvedValueOnce(null);
      const anonymous = await rawGet("gone-slug");

      expect(anonymous.status).toBe(404);
      expect(await body(anonymous)).not.toHaveProperty("canonicalSlug");
    });

    it("carries no hint on the ACL cloak, which resolves to itself", async () => {
      // `locked` EXISTS; the caller may not read it. The alias index maps every
      // live slug to itself, so the gate's `canonical !== slug` guard declines
      // and the cloak stays exactly as silent as it is today.
      await seedPage("locked", { owner: "alice", visibility: "private" });

      const response = await rawGet("locked");

      expect(response.status).toBe(404);
      expect(await body(response)).not.toHaveProperty("canonicalSlug");
    });
  });

  describe("the write verbs on /api/wiki/<slug>", () => {
    // There is no `GET` on that route to cover — DW-233's entry named one, and
    // it has never existed.
    it.each([
      ["DELETE", wikiDelete],
      ["PUT", wikiPut],
      ["PATCH", wikiPatch],
    ])(
      "%s names the survivor on a merged-away slug, still as a 404",
      async (_verb, call) => {
        await seedPage("survivor", { owner: "owner", aliases: ["old-slug"] });

        const response = await call("old-slug");

        expect(response.status).toBe(404);
        expect(await body(response)).toEqual({
          // The sentence is verbatim what it was before the field existed.
          error: "page not found: old-slug",
          canonicalSlug: "survivor",
        });
      },
    );

    it.each([
      ["DELETE", wikiDelete],
      ["PUT", wikiPut],
      ["PATCH", wikiPatch],
    ])("%s carries no hint for a slug nothing aliases", async (_verb, call) => {
      await seedPage("unrelated", { owner: "owner" });

      const response = await call("ghost");

      expect(response.status).toBe(404);
      expect(await body(response)).not.toHaveProperty("canonicalSlug");
    });

    it.each([
      ["DELETE", wikiDelete],
      ["PUT", wikiPut],
      ["PATCH", wikiPatch],
    ])(
      "%s carries no hint when it cloaks a page the caller may not read",
      async (_verb, call) => {
        // The page EXISTS and belongs to alice; `owner` may neither read nor
        // write it, so the verb 404s to avoid an existence oracle — and the
        // hint must not reintroduce one. It cannot: an existing slug resolves
        // to ITSELF.
        await seedPage("locked", { owner: "alice", visibility: "private" });

        const response = await call("locked");

        expect(response.status).toBe(404);
        expect(await body(response)).not.toHaveProperty("canonicalSlug");
      },
    );
  });
});
