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
