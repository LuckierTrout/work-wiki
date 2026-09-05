import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, within } from "@testing-library/react";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { ArticleView } from "@/components/ArticleView";
import type { Frontmatter } from "@/lib/frontmatter";

/**
 * The RENDER door of the vector-search switch (DW-686).
 *
 * `findSimilarPages` reads `getVectorSearchSettings().enabled` for itself and
 * answers `[]` when it is off, which is what removes the "related pages"
 * section from an article. `search.test.ts` pins the function; this file pins
 * the composition root — `ArticleView` is where the `[]` has to become an
 * absent section, and AGENTS.md asks every feature packet to drive its
 * composition root end-to-end at least once.
 *
 * `owner-scoped-anchors.test.tsx` mounts the same component, but it STUBS
 * `findSimilarPages` outright (it is asserting on the href that call site
 * emits), so it cannot see this gate at all — with the switch reverted its
 * related-pages assertions stay green. Hence a separate suite, with the harness
 * copied from it and `findSimilarPages` deliberately left REAL.
 */

const ANCHOR = "anchor-page";
const SIBLING = "sibling-page";
const SIBLING_TITLE = "Sibling page";

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => `/u/carol/${ANCHOR}`,
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
    refresh: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `ArticleView` renders the self-gating `ArticleActions` island, which reads the
 * Clerk session. A signed-out viewer is the smallest state that renders the
 * article at all.
 */
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
  SignInButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

/**
 * PARTIAL, and `findSimilarPages` is NOT among the overrides — it is the
 * function under test, re-exported through this module from `search.ts`, which
 * is how the component imports it.
 *
 * Only the two reads that are BESIDE the door are stubbed. The readable page
 * list `findSimilarPages` scope-matches its hits against is NOT among them, and
 * cannot be: `search.ts` imports `listReadableWikiPages` from this same module,
 * and because `wiki.ts` re-exports `findSimilarPages` FROM `search.ts`, the copy
 * `search.ts` holds is the original one this factory unwrapped, not the mock it
 * returns. Stubbing it here would look right and do nothing. The pages are
 * therefore real, in a temp wiki dir, the way `search.test.ts` seeds them.
 */
vi.mock("@/lib/wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki")>();
  return {
    ...actual,
    buildSlugTenantMap: async () => ({ [ANCHOR]: "carol", [SIBLING]: "carol" }),
    findBacklinks: async () => [],
  };
});

/**
 * PARTIAL: `ArticleView` imports `contentHash` from this module, and
 * `config.ts` imports `getEmbeddingResolution`/`hasEmbeddingSupport` from it.
 * Only the primitive the door is supposed to stop calling is replaced.
 */
const relatedByVector = vi.hoisted(() =>
  vi.fn(async () => [{ slug: SIBLING, score: 0.95 }]),
);
vi.mock("@/lib/embeddings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/embeddings")>();
  return { ...actual, relatedByVector };
});

const vectorSwitch = vi.hoisted(() => ({ enabled: true }));
vi.mock("@/lib/config", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/config")>();
  return {
    ...actual,
    // ONLY `enabled` FLIPS — see the note in `search.test.ts`. Every predicate
    // leg stays satisfied in both states, so the OFF case below is an article
    // rendered by a deployment that HAS a provider, a model and a key and
    // switched vector search off anyway. A door reading `.hasKey` or
    // `.provider` instead of `.enabled` fails here; with these legs co-varying
    // it would not.
    getVectorSearchSettings: vi.fn(() => ({
      enabled: vectorSwitch.enabled,
      provider: "openai",
      baseUrl: null,
      model: "text-embedding-3-small",
      hasKey: true,
    })),
  };
});

import { ensureDirectories, updateIndex, writeWikiPage } from "@/lib/wiki";
import { _resetStorage } from "@/lib/storage";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

let tmpDir: string;
let originalWikiDir: string | undefined;
let originalRawDir: string | undefined;
let originalDataDir: string | undefined;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "related-switch-test-"));
  originalWikiDir = process.env.WIKI_DIR;
  originalRawDir = process.env.RAW_DIR;
  originalDataDir = process.env.DATA_DIR;
  process.env.WIKI_DIR = path.join(tmpDir, "wiki");
  process.env.RAW_DIR = path.join(tmpDir, "raw");
  process.env.DATA_DIR = tmpDir;
  _resetStorage();

  await ensureDirectories();
  await writeWikiPage(ANCHOR, "# Anchor page\n\nBody of the anchor page.");
  await writeWikiPage(SIBLING, `# ${SIBLING_TITLE}\n\nBody of the sibling.`);
  await updateIndex([
    { slug: ANCHOR, title: "Anchor page", summary: "the anchor" },
    { slug: SIBLING, title: SIBLING_TITLE, summary: "the sibling" },
  ]);

  vectorSwitch.enabled = true;
  relatedByVector.mockClear();
  // The client islands under the article fetch their own state; none of it is
  // under test here, so every route answers an empty object rather than
  // throwing an unhandled rejection into the render.
  vi.stubGlobal(
    "fetch",
    vi.fn(
      async () =>
        ({ ok: true, status: 200, json: async () => ({}) }) as unknown as Response,
    ),
  );
});

afterEach(async () => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed — these trees abort in-flight reads on unmount.
  cleanup();
  vi.unstubAllGlobals();
  if (originalWikiDir === undefined) delete process.env.WIKI_DIR;
  else process.env.WIKI_DIR = originalWikiDir;
  if (originalRawDir === undefined) delete process.env.RAW_DIR;
  else process.env.RAW_DIR = originalRawDir;
  if (originalDataDir === undefined) delete process.env.DATA_DIR;
  else process.env.DATA_DIR = originalDataDir;
  _resetStorage();
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function articlePage() {
  const frontmatter: Frontmatter = {
    title: "Anchor page",
    owner: "carol",
    updated: "2026-01-01",
  };
  const body = "Body of the anchor page.";
  return {
    slug: ANCHOR,
    title: "Anchor page",
    path: `wiki/${ANCHOR}.md`,
    content: `---\ntitle: Anchor page\n---\n${body}`,
    frontmatter,
    body,
  };
}

/**
 * Mount the article and hand back the render result.
 *
 * A sync render of an async server component: await the element, then mount
 * what it returned. There is no test-only seam in the component itself.
 *
 * The RESULT, not `screen`, is what both cases query through. The OFF case
 * asserts an ABSENCE, and the global `screen` searches `document.body` — so any
 * tree left behind by an earlier render (a `cleanup()` that did not run, a
 * mount from another file sharing the jsdom document) would satisfy the
 * "related pages" query and read as a gate failure. Scoped to this render's
 * `container`, nothing outside it can defeat or satisfy an assertion.
 */
async function renderArticle() {
  const element = await ArticleView({
    page: articlePage(),
    slug: ANCHOR,
    pageTenant: "carol",
    principal: { id: "user_1", handle: "carol" },
  });
  return render(element);
}

// ---------------------------------------------------------------------------
// The gate, at the composition root
// ---------------------------------------------------------------------------

describe("ArticleView — related pages under the vector-search switch", () => {
  it("renders the related-pages section with the switch ON", async () => {
    const { container } = await renderArticle();
    const article = within(container);

    expect(article.getByText("related pages")).toBeTruthy();
    expect(
      article.getByRole("link", { name: SIBLING_TITLE }).getAttribute("href"),
    ).toBe(`/u/carol/${SIBLING}`);
    expect(relatedByVector).toHaveBeenCalled();
  });

  it("renders no related-pages section, and calls no vector primitive, with it OFF", async () => {
    vectorSwitch.enabled = false;

    const { container } = await renderArticle();
    const article = within(container);

    // Same fixture, same hit available — only the switch moved.
    expect(article.queryByText("related pages")).toBeNull();
    expect(article.queryByRole("link", { name: SIBLING_TITLE })).toBeNull();
    // Not called-and-discarded: the drift breadcrumb `relatedByVector` writes
    // must not tell an off deployment to rebuild embeddings.
    expect(relatedByVector).not.toHaveBeenCalled();
  });
});
