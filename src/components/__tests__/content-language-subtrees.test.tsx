import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { ArticleView } from "@/components/ArticleView";
import { PreviewColumn } from "@/components/workbench/PreviewColumn";
import type { Frontmatter } from "@/lib/frontmatter";

/**
 * The `lang` declaration, MOUNTED on both subtrees that render a page body
 * (DW-116).
 *
 * `content-language.test.ts` proves the classification is right. It cannot
 * prove anything about the page: a helper with no call site passes its own
 * suite in full while both subtrees stay unannounced and every CJK page keeps
 * inheriting `lang="en"` from `<html>` — the exact bug, with a green run.
 * So both call sites are asserted on the RENDERED attribute of the rendered
 * node, and the Han body is chosen so that a deleted `lang={...}` (attribute
 * absent, `en` inherited) is distinguishable from a wired one.
 *
 * The chrome's language is deliberately NOT asserted here: `<html lang="en">`
 * is `layout.tsx`'s, and `english-only.test.ts` owns it.
 */

// A body that is unambiguously Chinese: Han only, no kana, no hangul, and far
// more Han than Latin so the strict-majority rule is satisfied with room.
const HAN_BODY = "这是一个中文页面，讲的是知识库的设计与检索。";
const ENGLISH_BODY = "An ordinary English page about ingestion and retrieval.";

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

vi.mock("next/navigation", () => ({
  usePathname: () => "/",
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `ArticleView` renders the self-gating `ArticleActions` island, which reads
 * the Clerk session. A signed-out viewer is the smallest state that still
 * renders the article, which is the only thing this file looks at.
 */
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
  SignInButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

/**
 * PARTIAL, per the idiom `owner-scoped-anchors.test.tsx` established: a full
 * mock of this module breaks `isVaultEligible`, whose `isAgentScopedType`
 * comes from here too. Only the three server reads are stubbed.
 */
vi.mock("@/lib/wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki")>();
  return {
    ...actual,
    buildSlugTenantMap: async () => ({}),
    findBacklinks: async () => [],
    findSimilarPages: async () => [],
  };
});

// ---------------------------------------------------------------------------
// ArticleView
// ---------------------------------------------------------------------------

function articlePage(body: string) {
  const frontmatter: Frontmatter = {
    title: "Carol's page",
    owner: "carol",
    updated: "2026-01-01",
  };
  return {
    slug: "carol-page",
    title: "Carol's page",
    path: "wiki/carol-page.md",
    content: `---\ntitle: Carol's page\n---\n${body}`,
    frontmatter,
    body,
  };
}

/**
 * `ArticleView` is an async SERVER component: await the element, then mount
 * what it returned. There is no test-only seam in the component itself.
 */
async function renderArticle(body: string) {
  const element = await ArticleView({
    page: articlePage(body),
    slug: "carol-page",
    pageTenant: "carol",
    principal: { id: "user_1", handle: "carol" },
  });
  return render(element);
}

describe("ArticleView declares the body's language on the article", () => {
  afterEach(() => {
    cleanup();
  });

  it("announces a Han page as Chinese rather than letting it inherit English", async () => {
    await renderArticle(HAN_BODY);
    const article = document.querySelector("article");
    expect(article).not.toBeNull();
    // Pinned on the ATTRIBUTE, not on `article.lang`: the property reads the
    // inherited-nothing empty string when the attribute is absent, and the
    // distinction this case exists for is exactly "declared" vs "not there".
    expect(article!.getAttribute("lang")).toBe("zh");
  });

  it("still emits the attribute for an English body, rather than omitting it", async () => {
    // Unconditional on purpose: an omitted attribute is indistinguishable from
    // deleted wiring, so the English case is the one that keeps a reverted
    // call site observable at all.
    await renderArticle(ENGLISH_BODY);
    expect(document.querySelector("article")!.getAttribute("lang")).toBe("en");
  });
});

// ---------------------------------------------------------------------------
// Workbench Preview
// ---------------------------------------------------------------------------

function previewPayload(body: string) {
  return {
    name: "Alpha",
    path: "wiki/alpha.md",
    slug: "alpha",
    format: "markdown" as const,
    body,
    truncated: false,
    editable: true,
  };
}

/** The five props the standalone mount needs, per `uncovered-scroll-surfaces`. */
const PREVIEW_PROPS = {
  selection: { kind: "page", slug: "alpha" } as const,
  knowledge: [],
  files: [],
  onOpenPage: () => {},
  onDirtyChange: () => {},
  id: "wb-preview",
  dataVersion: 0,
};

let fetchMock: ReturnType<typeof vi.fn>;

function stubPreview(body: string) {
  fetchMock = vi.fn(async (url: unknown) =>
    String(url).includes("/api/workbench/preview")
      ? ({ ok: true, status: 200, json: async () => previewPayload(body) } as unknown as Response)
      : ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
  );
  vi.stubGlobal("fetch", fetchMock);
}

describe("the Workbench Preview declares the body's language on its body box", () => {
  beforeEach(() => {
    window.history.replaceState(null, "", "/");
  });

  afterEach(() => {
    // FIRST: vitest runs afterEach hooks in reverse registration order, so the
    // setup file's own `cleanup()` lands after this block. Unmounting here
    // tears the tree down while `fetch` is still stubbed.
    cleanup();
    vi.unstubAllGlobals();
  });

  it("announces a Han payload as Chinese", async () => {
    stubPreview(HAN_BODY);
    render(<PreviewColumn {...PREVIEW_PROPS} />);
    await act(async () => {});

    const body = document.querySelector<HTMLElement>(".wb-preview-body");
    expect(body).not.toBeNull();
    expect(body!.getAttribute("lang")).toBe("zh");
  });

  it("announces an English payload as English on the same box", async () => {
    // The second half of the pair: the attribute has to TRACK the payload, not
    // merely be present. A hard-coded `lang="zh"` would pass the case above.
    stubPreview(ENGLISH_BODY);
    render(<PreviewColumn {...PREVIEW_PROPS} />);
    await act(async () => {});

    const body = document.querySelector<HTMLElement>(".wb-preview-body");
    expect(body).not.toBeNull();
    expect(body!.getAttribute("lang")).toBe("en");
  });
});
