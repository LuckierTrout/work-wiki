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
import type { Frontmatter } from "../frontmatter";
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
