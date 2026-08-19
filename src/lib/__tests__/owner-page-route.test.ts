import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";

/**
 * `/u/<handle>/<slug>` is the only page-view surface now that the commons is
 * retired, and its "handle doesn't match the page's real tenant → 308" branch
 * became load-bearing in the same cut: `slugPath()` addresses every slug-only
 * link through `DEFAULT_TENANT` and relies on this redirect to land on the real
 * owner, as do the two Cloudflare workers, which hand-inline the same URL shape
 * because they cannot import `src/lib`. Every other test in the suite asserts
 * the *string* those callers build; this one asserts the route that makes the
 * string resolve.
 */

vi.mock("@/lib/auth", () => ({
  getPrincipal: vi.fn(async () => ({ id: "owner", handle: "owner" })),
  getServicePrincipal: vi.fn(() => null),
}));

// Next's real `permanentRedirect` throws a framework signal; surface it as a
// plain error carrying the target so the assertion reads the URL directly.
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
  serializeFrontmatter,
  writeWikiPageWithSideEffects,
} from "../wiki";
import { resetAliasIndex } from "../alias-index";
import type { Frontmatter } from "../frontmatter";
import { getPrincipal } from "@/lib/auth";
import { notFound, permanentRedirect } from "next/navigation";
import WikiPageView from "@/app/u/[handle]/[slug]/page";

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "owner-page-route-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  // The alias index is a module singleton; drop it so each test's miss-path
  // forwarding resolves against THIS test's pages only. (clearAllMocks keeps
  // mock implementations — it only clears recorded calls.)
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

describe("/u/<handle>/<slug> canonical-handle redirect", () => {
  it("308s a slug-only link addressed through DEFAULT_TENANT to the real owner", async () => {
    await seedPage("agent-note", { owner: "alice" });
    // This is exactly what `slugPath("agent-note")` emits.
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "agent-note" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/alice/agent-note");
  });

  it("308s an agent-owned page to its agent tenant", async () => {
    await seedPage("agent-learning", { owner: "alice--yoyo" });
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "agent-learning" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/alice--yoyo/agent-learning");
  });

  it("does not redirect when the handle already matches the page's tenant", async () => {
    await seedPage("owned-note", { owner: "owner" });
    // The suite runs in the `node` environment with no JSX runtime, so the
    // render itself cannot be exercised here — what matters is that control
    // reached the render at all instead of being diverted by the 308.
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "owner", slug: "owned-note" }),
      }),
    ).rejects.not.toThrow(/^REDIRECT:/);
  });
});

describe("/u/<handle>/<slug> alias forwarding for missing slugs", () => {
  it("308s a merged-away slug once, directly to the survivor's canonical URL", async () => {
    // A merge records the absorbed slug as an alias of the survivor; visiting
    // the old slug under ANY handle (here a non-default one, pinning that the
    // handle segment is immaterial on the miss path) must land on the
    // survivor's real tenant in a single hop (never via DEFAULT_TENANT).
    await seedPage("survivor", { owner: "alice", aliases: ["old-slug"] });
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "someone-else", slug: "old-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/alice/survivor");
  });

  it("404s a missing slug with no alias", async () => {
    await seedPage("unrelated", { owner: "alice" });
    // `notFound()`, asserted by name (DW-85). This used to be the weaker
    // "did not throw a REDIRECT", which the OLD behavior — returning a
    // rendered "Page not found" body at HTTP 200 — also satisfied, since the
    // node project has no JSX runtime and the render threw for its own
    // reasons. A dead slug must be a real 404, or it stays indexable and no
    // client can tell a miss from a hit.
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "ghost" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(vi.mocked(notFound)).toHaveBeenCalled();
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });

  it("forwards the owner to their private survivor but 404s anonymous viewers", async () => {
    await seedPage("secret-survivor", {
      owner: "owner",
      visibility: "private",
      aliases: ["gone-slug"],
    });
    // The mocked principal IS the owner → forwarded to the canonical URL.
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    ).rejects.toThrow("REDIRECT:/u/owner/secret-survivor");
    // Anonymous → a real 404, indistinguishable from missing.
    // Clear the owner half's recorded redirect call so the mock assertion
    // below is as strong as the neighboring tests'.
    vi.mocked(permanentRedirect).mockClear();
    vi.mocked(getPrincipal).mockResolvedValueOnce(null);
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "gone-slug" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });

  it("404s an existing-but-unreadable page instead of self-redirecting", async () => {
    // An existing private page the viewer can't read takes the miss branch,
    // and the alias index maps every live slug to itself — without the
    // `canonical !== slug` guard this would 308 to its own URL forever.
    await seedPage("locked", { owner: "alice", visibility: "private" });
    await expect(
      WikiPageView({
        params: Promise.resolve({ handle: "yopedia", slug: "locked" }),
      }),
    ).rejects.toThrow("NOT_FOUND");
    expect(vi.mocked(permanentRedirect)).not.toHaveBeenCalled();
  });
});
