import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { loadSlugTenants } from "@/hooks/useSlugTenants";
import { ArticleView } from "@/components/ArticleView";
import { VaultExplorer } from "@/components/VaultExplorer";
import { ChatWorkspace } from "@/components/ChatWorkspace";
import { KnowledgeStudio } from "@/components/KnowledgeStudio";
import type { Vault } from "@/lib/vault";
import type { VaultExplorerEntry } from "@/lib/vault-explorer";
import type { ChatConversation } from "@/lib/chat";
import type { ResearchProject } from "@/lib/research-projects";
import type { SourceContribution } from "@/lib/knowledge-compilation";
import type { Frontmatter } from "@/lib/frontmatter";

/**
 * Owner-scoped anchors, per COMPONENT (DW-86).
 *
 * `renderer-slug-tenant-adoption.test.tsx` is the sibling of this file: it
 * covers the five RENDERER call sites. The four components below were converted
 * in the same sweep and got only per-hook coverage — `useSlugTenants` and
 * `resolveSlugPath` each have their own suite — so reverting any one call site
 * to `slugPath(...)`, or dropping a `slugTenants` prop, left the entire run
 * green while every internal link in that surface went back to a wrong-handle
 * `/u/yopedia/…` hop.
 *
 * Every assertion is therefore on the RENDERED `href`. A component that obtains
 * the map and forgets to forward it passes an import check and fails here.
 *
 * THE MAP IS BUILT SO THAT EVERY WRONG ANSWER IS A DISTINGUISHABLE ONE:
 *
 *   - `target` belongs to `alice`, and no surface here is alice's own — so the
 *     canonical `/u/alice/target` differs both from the `DEFAULT_TENANT`
 *     fallback a reverted `slugPath()` emits (`/u/yopedia/target`) and from the
 *     linking page's own tenant, which is what a dropped `slugTenants` prop
 *     falls back to;
 *   - `other` belongs to `bob` and `sibling` to `dana` — THIRD and FOURTH
 *     owners, which is what keeps the map load-bearing on the call sites that
 *     also receive a `tenant` fallback: without the map those resolve to the
 *     linking page's own tenant, not to bob or dana.
 */

const SLUG_TENANTS = { target: "alice", other: "bob", sibling: "dana" } as const;

/** The map's canonical answers — the only hrefs this file ever accepts. */
const ALICE_TARGET = "/u/alice/target";
const BOB_OTHER = "/u/bob/other";
const DANA_SIBLING = "/u/dana/sibling";

/** In-content links to both mapped slugs, for anything rendering markdown. */
const BODY = "Cites [T](target.md) and [O](other.md).";

// ---------------------------------------------------------------------------
// Module boundaries
// ---------------------------------------------------------------------------

const nav = vi.hoisted(() => ({
  pathname: "/vault",
  router: { push: vi.fn(), replace: vi.fn(), refresh: vi.fn(), prefetch: vi.fn() },
}));

vi.mock("next/navigation", () => ({
  usePathname: () => nav.pathname,
  useRouter: () => nav.router,
  useSearchParams: () => new URLSearchParams(),
}));

/**
 * `ArticleView` renders the self-gating `ArticleActions` island, which reads the
 * Clerk session. A signed-out viewer is the smallest state that renders the
 * article at all, and none of the actions carry a slug→tenant link.
 */
vi.mock("@clerk/nextjs", () => ({
  useUser: () => ({ isLoaded: true, isSignedIn: false, user: null }),
  SignInButton: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));

/**
 * `ArticleView` is an async SERVER component: its map comes from the ungated
 * `buildSlugTenantMap()` rather than from `/api/wiki/routes`, and its backlinks
 * come from a filesystem/KV read. The mock is PARTIAL — a full one breaks
 * `isVaultEligible`, whose `isAgentScopedType` comes from this same module.
 */
vi.mock("@/lib/wiki", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/wiki")>();
  return {
    ...actual,
    buildSlugTenantMap: async () => ({ ...SLUG_TENANTS }),
    // A backlink from a slug owned by a THIRD party: the point of resolving
    // backlinks through the map rather than through the page's own tenant.
    findBacklinks: async () => [{ slug: "other", title: "Other page" }],
    // "Related pages" is a SEPARATE call site from backlinks, resolved by its
    // own `resolveSlugPath(...)` a few lines below it — stubbing this to `[]`
    // would delete the `related.length > 0` branch from the render and let that
    // call site be reverted with the whole suite still green. A fourth owner, so
    // the map is the only thing that can produce the right answer here either.
    findSimilarPages: async () => [{ slug: "sibling", title: "Sibling page", score: 0.9 }],
  };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function ok(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as unknown as Response;
}

/** Per-test route table, consulted by the one `fetch` stub below. */
let routes: Record<string, unknown>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  routes = {
    // The readability-gated map every CLIENT component here reads.
    "/api/wiki/routes": { ...SLUG_TENANTS },
  };
  fetchMock = vi.fn(async (url: string) => {
    const key = Object.keys(routes).find((route) => route === url);
    if (key === undefined) throw new Error(`unexpected fetch: ${url}`);
    return ok(routes[key]);
  });
  vi.stubGlobal("fetch", fetchMock);
  // `useSlugTenants` initializes from a module-level session cache, so warming
  // it here makes the map available on the FIRST paint. Without it every
  // assertion would race the hook's effect, and a component that never adopted
  // the map would look exactly like one still loading.
  await loadSlugTenants();
});

afterEach(() => {
  // FIRST: vitest runs afterEach hooks in reverse registration order, so the
  // setup file's `cleanup()` lands after this one. Unmount while `fetch` is
  // still stubbed — several of these trees abort in-flight reads on unmount.
  cleanup();
  vi.unstubAllGlobals();
  nav.pathname = "/vault";
});

/** The href of the one rendered link whose text is `name`. */
async function hrefOf(name: string): Promise<string | null> {
  const link = await screen.findByRole("link", { name });
  return link.getAttribute("href");
}

// ---------------------------------------------------------------------------
// ArticleView
// ---------------------------------------------------------------------------

/**
 * The article is CAROL's, deliberately — neither alice's nor bob's.
 *
 * `MarkdownRenderer` falls back to the linking page's tenant for a slug the map
 * does not know, so an article owned by alice would emit `/u/alice/target` with
 * the map removed and this suite could not tell the two apart.
 */
const PAGE_TENANT = "carol";

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

async function renderArticle() {
  // A sync render of an async server component: await the element, then mount
  // what it returned. There is no test-only seam in the component itself.
  const element = await ArticleView({
    page: articlePage(`# Carol's page\n\n${BODY}\n`),
    slug: "carol-page",
    pageTenant: PAGE_TENANT,
    principal: { id: "user_1", handle: "carol" },
  });
  return render(element);
}

describe("ArticleView", () => {
  it("resolves an in-content wikilink to the TARGET's owner, not the article's", async () => {
    await renderArticle();
    expect(await hrefOf("T")).toBe(ALICE_TARGET);
  });

  it("resolves a backlink through the map rather than through this page's tenant", async () => {
    await renderArticle();
    // `other` is bob's. Resolved against `pageTenant` alone this would read
    // `/u/carol/other` — a dead link, not merely a redirect hop.
    expect(await hrefOf("Other page")).toBe(BOB_OTHER);
  });

  it("resolves a related page through the map too", async () => {
    await renderArticle();
    // "related pages" is its own `resolveSlugPath(...)` call, adjacent to the
    // backlink one and easy to miss when only one of the two is asserted.
    // `sibling` is dana's: `/u/carol/sibling` (the page-tenant fallback) and
    // `/u/yopedia/sibling` (a reverted call site) are both distinguishable.
    expect(await hrefOf("Sibling page")).toBe(DANA_SIBLING);
  });

  it("keeps every anchor in one render on the same map", async () => {
    await renderArticle();
    // Three call sites, one render: wiring the map into some of them and not
    // the rest is the failure a single-link assertion would miss.
    expect(await hrefOf("O")).toBe(BOB_OTHER);
    expect(await hrefOf("T")).toBe(ALICE_TARGET);
    expect(await hrefOf("Other page")).toBe(BOB_OTHER);
    expect(await hrefOf("Sibling page")).toBe(DANA_SIBLING);
  });
});

// ---------------------------------------------------------------------------
// VaultExplorer
// ---------------------------------------------------------------------------

const VAULT: Vault = {
  id: "carol--research",
  owner: "Carol",
  name: "Research",
  visibility: "private",
  slugs: ["borrowed"],
  created: "2026-01-01T00:00:00.000Z",
};

/**
 * A curated entry whose page belongs to ALICE while the vault belongs to carol
 * — the whole reason "Open full page" builds the URL from the entry's own owner
 * instead of the viewer's or the vault's.
 */
const ENTRY: VaultExplorerEntry = {
  slug: "target",
  title: "Target",
  tags: [],
  owner: "Alice",
  sources: [],
};

const PREVIEW_ROUTE = "/api/vaults/carol--research/pages/target";

function renderVault() {
  routes[PREVIEW_ROUTE] = {
    page: {
      slug: "target",
      title: "Target",
      body: `# Target\n\n${BODY}\n`,
      rawHref: "/u/alice/raw/target",
    },
  };
  return render(
    <VaultExplorer
      vault={VAULT}
      vaults={[{ id: VAULT.id, name: VAULT.name, count: 1 }]}
      initialEntries={[ENTRY]}
    />,
  );
}

describe("VaultExplorer", () => {
  it('addresses "Open full page" by the entry OWNER, not the default tenant', async () => {
    renderVault();
    // The entry already carries its owner, so this needs no map at all — and
    // reverting it to `slugPath(entry.slug)` would emit `/u/yopedia/target`,
    // a wrong-handle hop on every curated document in every vault.
    expect(await hrefOf("Open full page")).toBe(ALICE_TARGET);
  });

  it("resolves the preview's in-content links through the map", async () => {
    renderVault();
    // The preview arrives from a fetch, so the renderer mounts late; `findBy`
    // waits it out. `other` is bob's, so the map is what distinguishes this
    // from the `tenant={ownerToTenant(entry.owner)}` fallback.
    expect(await hrefOf("O")).toBe(BOB_OTHER);
    expect(await hrefOf("T")).toBe(ALICE_TARGET);
  });
});

// ---------------------------------------------------------------------------
// ChatWorkspace
// ---------------------------------------------------------------------------

const THREAD: ChatConversation = {
  id: "conv-1",
  title: "What does target say?",
  scope: "",
  retrievalMode: "wiki",
  contextBudget: "standard",
  messages: [
    {
      id: "m1",
      role: "user",
      content: "What does target say?",
      sources: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "m2",
      role: "assistant",
      content: BODY,
      // The source chips, which are `hrefForSlug` and nothing else.
      sources: ["target", "other"],
      createdAt: "2026-01-01T00:00:01.000Z",
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:01.000Z",
};

/** Mount the workspace and open the one thread, which is what renders answers. */
async function openThread() {
  routes["/api/chat/conversations"] = { conversations: [{ ...THREAD, messages: [] }] };
  routes["/api/vaults"] = { vaults: [] };
  routes["/api/agents?mine=1"] = { agents: [] };
  routes["/api/chat/hermes"] = { configured: false, available: false, safe: false };
  routes["/api/chat/conversations/conv-1"] = { conversation: THREAD };

  render(<ChatWorkspace />);
  // `fireEvent`, not `element.click()`: a raw DOM click fires outside React's
  // event system, so the state update it causes is unbatched and warns.
  fireEvent.click(await screen.findByRole("button", { name: /What does target say\?/ }));
  await screen.findByRole("link", { name: "T" });
}

describe("ChatWorkspace", () => {
  it("resolves an answer's source chips through the map", async () => {
    await openThread();
    expect(await hrefOf("target")).toBe(ALICE_TARGET);
    // The second chip belongs to a different owner: one map lookup per chip,
    // not one tenant for the whole answer.
    expect(await hrefOf("other")).toBe(BOB_OTHER);
  });

  it("resolves the answer's in-content wikilinks through the map", async () => {
    await openThread();
    expect(await hrefOf("T")).toBe(ALICE_TARGET);
    expect(await hrefOf("O")).toBe(BOB_OTHER);
  });

  it("links a saved answer by the URL the save returned", async () => {
    await openThread();
    // A slug created just now CANNOT be in the session-cached map, so the
    // server's canonical url is the only thing that addresses it without a 308.
    routes["/api/query/save"] = { slug: "fresh-answer", url: "/u/carol/fresh-answer" };

    fireEvent.click(screen.getByRole("button", { name: "Save to wiki" }));

    expect(await hrefOf("fresh-answer")).toBe("/u/carol/fresh-answer");
  });

  it("falls back to the map when the save response carries no url", async () => {
    await openThread();
    // An older route (or a degraded one) answers with the slug alone; the
    // banner must still link somewhere real rather than rendering a bare slug.
    routes["/api/query/save"] = { slug: "target" };

    fireEvent.click(screen.getByRole("button", { name: "Save to wiki" }));

    await waitFor(() => {
      const banner = screen.getAllByRole("link", { name: "target" });
      // The chip and the banner both point at the same canonical page.
      expect(banner.length).toBe(2);
      for (const link of banner) expect(link.getAttribute("href")).toBe(ALICE_TARGET);
    });
  });
});

// ---------------------------------------------------------------------------
// KnowledgeStudio
// ---------------------------------------------------------------------------

const CONTRIBUTION: SourceContribution = {
  id: "contrib-1",
  sourceUrl: "https://example.com/report",
  sourceType: "url",
  pageSlug: "target",
  pageContentHash: "hash",
  structuredRecordIds: [],
  structuredRelationIds: [],
  observedAt: "2026-01-01T00:00:00.000Z",
};

const PROJECT: ResearchProject = {
  id: "proj-1",
  title: "Target research",
  question: "What does target say?",
  queries: [],
  sourceUrls: [],
  pageSlugs: [],
  // Deliberately terminal: the panel polls `/api/research/<id>/run` every three
  // seconds for a project still queued/collecting/ready.
  status: "complete",
  synthesis: BODY,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

function renderStudio() {
  routes["/api/vaults"] = { vaults: [] };
  routes["/api/agents?mine=1"] = { agents: [] };
  routes["/api/ingest/jobs?limit=16"] = { jobs: [] };
  routes["/api/review/proposals?status=pending"] = { proposals: [] };
  routes["/api/knowledge/insights?scope=mine"] = { insights: [] };
  routes["/api/research"] = { projects: [PROJECT], availableProviders: [] };
  routes["/api/agent-skills"] = { skills: [] };
  routes["/api/knowledge/compilation"] = { contributions: [CONTRIBUTION] };
  return render(<KnowledgeStudio />);
}

describe("KnowledgeStudio", () => {
  it("points the evidence drawer at the compiled page's real owner", async () => {
    renderStudio();
    // "Compile" is the landing section; a contribution row opens the drawer.
    fireEvent.click(await screen.findByRole("button", { name: /example\.com\/report/ }));

    const link = await screen.findByRole("link", { name: /Open compiled page/ });
    expect(link.getAttribute("href")).toBe(ALICE_TARGET);
  });

  it("resolves a research synthesis's in-content wikilinks through the map", async () => {
    renderStudio();
    fireEvent.click(await screen.findByRole("button", { name: /Research desk/ }));

    expect(await hrefOf("T")).toBe(ALICE_TARGET);
    expect(await hrefOf("O")).toBe(BOB_OTHER);
  });
});
